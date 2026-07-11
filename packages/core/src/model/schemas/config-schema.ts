/**
 * Zod schema for environment-variable configuration.
 *
 * This schema is the declarative counterpart to the hand-written validators
 * in `src/model/config.ts`: it parses a `process.env`-shaped object with
 * `envSchema.safeParse` and maps the result through `envToConfig()`.
 *
 * ## Why split the schema from the config shape
 *
 * The schema describes the **input contract** (`process.env`, all strings,
 * all prefixed `KIRO2CLAUDE_*`). The `Config` interface describes the **consumer
 * contract** (camelCase business fields). Keeping them separate means the
 * env var naming can evolve independently of the business code, and the
 * test coverage here focuses on parsing/validation rather than shape
 * translation.
 *
 * ## Error message compatibility
 *
 * The schema must emit the exact error strings that the unit tests assert on
 * (e.g. `/KIRO2CLAUDE_API_KEY is required/`). All `ctx.addIssue` calls below
 * use the same phrasing as the hand-written `Error`s in `config.ts`, so a
 * thin `zodIssueToMessage()` adapter can emit the same messages by reading
 * `issue.message` unchanged.
 */

import { z } from 'zod';
import type { Config } from '../config.js';

// ============================================================================
// Field-level parsers
// ============================================================================

/**
 * Required non-empty string: trims, then rejects empty. Matches the behavior
 * of the hand-written `requiredString(name, value)` in config.ts.
 *
 * Note: the error message is identical across `required_error`,
 * `invalid_type_error`, and the refine message so the test suite —
 * which asserts `/${name} is required/` via regex — matches regardless of
 * which branch triggered the failure (missing, wrong type, or empty).
 */
function requiredString(name: string) {
  const msg = `${name} is required (non-empty)`;
  return z
    .string({
      required_error: msg,
      invalid_type_error: msg,
    })
    .refine((v) => v.trim().length > 0, { message: msg });
}

/**
 * Optional string: treats empty string the same as `undefined`. Matches
 * `optionalString(value)` in config.ts — the project convention is "unset
 * env var" and "empty string env var" should be equivalent.
 */
function optionalString(): z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown> {
  return z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? undefined : v));
}

/**
 * Integer field with optional range check. Matches `parseIntOrDefault(name,
 * value, default)` in config.ts, including the "stringify round-trip" that
 * rejects `"3.0"` or `"3abc"`.
 */
function intField(
  name: string,
  defaultValue: number,
  range?: { min: number; max: number },
): z.ZodEffects<z.ZodOptional<z.ZodString>, number, unknown> {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number => {
      if (raw == null || raw === '') return defaultValue;
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n) || String(n) !== raw.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be an integer, got: ${raw}`,
        });
        return z.NEVER;
      }
      if (range && (n < range.min || n > range.max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} out of range (${range.min}-${range.max}): ${n}`,
        });
        return z.NEVER;
      }
      return n;
    });
}

// There is no numberField helper: core has no floating-point env var. Plugin
// flags that need one are read directly by the plugin via ctx.env. If a future
// core env addition needs floating-point parsing, reintroduce the helper.

/**
 * Boolean field accepting `1/true/yes/on` and `0/false/no/off` (case-
 * insensitive). Matches `parseBool(value, default)` in config.ts — this is
 * intentionally wider than `z.coerce.boolean()` because the existing
 * config.ts convention accepts these casual aliases and operators rely on them.
 */
function boolField(
  defaultValue: boolean,
): z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, unknown> {
  return z
    .string()
    .optional()
    .transform((raw, ctx): boolean => {
      if (raw == null || raw === '') return defaultValue;
      const lower = raw.toLowerCase();
      if (lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on') return true;
      if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid boolean value: ${raw}`,
      });
      return z.NEVER;
    });
}

/**
 * Enum field. Matches the hand-written
 * `KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE must be 'x-api-key' or 'bearer', got: ...`
 * style error message.
 */
function enumField<const T extends readonly [string, ...string[]]>(
  name: string,
  values: T,
  defaultValue: T[number],
): z.ZodEffects<z.ZodOptional<z.ZodString>, T[number], unknown> {
  const allowedList = values.map((v) => `'${v}'`).join(' or ');
  return z
    .string()
    .optional()
    .transform((raw, ctx): T[number] => {
      const actual = raw ?? defaultValue;
      if (!(values as readonly string[]).includes(actual)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be ${allowedList}, got: ${actual}`,
        });
        return z.NEVER;
      }
      return actual as T[number];
    });
}

/** String with a literal default when unset. */
function stringWithDefault(
  defaultValue: string,
): z.ZodEffects<z.ZodOptional<z.ZodString>, string, unknown> {
  return z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? defaultValue : v));
}

// ============================================================================
// Environment schema (input shape: process.env)
// ============================================================================

/**
 * Zod schema that parses a `process.env`-shaped object into a strongly-typed
 * intermediate form. Unknown keys are ignored (zod default); unrecognized
 * `KIRO2CLAUDE_*` vars don't break the parse, they just get dropped.
 */
export const envSchema = z.object({
  KIRO2CLAUDE_HOST: stringWithDefault('127.0.0.1'),
  KIRO2CLAUDE_PORT: intField('KIRO2CLAUDE_PORT', 8080, { min: 1, max: 65535 }),
  KIRO2CLAUDE_REGION: stringWithDefault('us-east-1'),
  KIRO2CLAUDE_AUTH_REGION: optionalString(),
  KIRO2CLAUDE_API_REGION: optionalString(),
  KIRO2CLAUDE_API_KEY: requiredString('KIRO2CLAUDE_API_KEY'),
  KIRO2CLAUDE_COUNT_TOKENS_API_URL: optionalString(),
  KIRO2CLAUDE_COUNT_TOKENS_API_KEY: optionalString(),
  KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE: enumField(
    'KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE',
    ['x-api-key', 'bearer'] as const,
    'x-api-key',
  ),
  KIRO2CLAUDE_SQLITE_DB_PATH: optionalString(),
  // 上游偶发返回「200 OK + 零内容帧」的空流(silent failure)。pre-commit 阶段
  // 检测到后,网关对**同一请求**最多重发这么多次来透明吸收瞬时空流(实测多数
  // 重试即恢复)。默认 2;0 = 关闭重试,退回纯转发(立即回 503 overloaded_error)。
  KIRO2CLAUDE_EMPTY_STREAM_RETRIES: intField('KIRO2CLAUDE_EMPTY_STREAM_RETRIES', 2, {
    min: 0,
    max: 5,
  }),
  // 诊断用:设为一个目录路径后,每次检测到空流就把**原始 Claude 请求体**追加
  // 写到该目录下的 JSONL,用于事后定位「确定性空流」的根因。留空(默认)= 不抓包。
  KIRO2CLAUDE_CAPTURE_EMPTY_DIR: optionalString(),
  KIRO2CLAUDE_EXTRACT_THINKING: boolField(true),
  KIRO2CLAUDE_IDENTITY_OVERRIDE: boolField(true),
  KIRO2CLAUDE_REJECT_UNSUPPORTED_DOCUMENTS: boolField(true),
  // 泄漏工具调用文本救援:上游偶发把模型的工具调用当纯文本发下来。开启后
  // 响应侧把泄漏块解析回真 tool_use、请求侧剥掉历史里的泄漏块(去污染)。
  // 详见 Config.toolCallTextRescue 与 claude/tool-call-text.ts。
  KIRO2CLAUDE_TOOL_CALL_TEXT_RESCUE: boolField(true),
  KIRO2CLAUDE_AUTO_CAPTURE_PROFILE: boolField(false),
  KIRO2CLAUDE_CLI_BIN: optionalString(),
  KIRO2CLAUDE_REQUIRE_CLI_VERSION: boolField(false),
  KIRO2CLAUDE_LOGIN_START_URL: optionalString(),
  KIRO2CLAUDE_LOGIN_REGION: optionalString(),
  KIRO2CLAUDE_LOGIN_LICENSE: stringWithDefault('pro'),
  KIRO2CLAUDE_LOGIN_TIMEOUT_MS: intField('KIRO2CLAUDE_LOGIN_TIMEOUT_MS', 600_000),
  // Plugin-specific env vars are intentionally NOT validated here. Plugins
  // read `ctx.env` directly via the @kiro2claude/plugin-api contract, so the
  // schema only covers core gateway flags. See docs/PLUGIN-DEVELOPMENT.md.
});

/** Inferred type: the post-parse env shape. */
export type ParsedEnv = z.infer<typeof envSchema>;

// ============================================================================
// Env → Config shape mapping
// ============================================================================

/**
 * Translate the parsed env object into the consumer-facing `Config` shape.
 *
 * Kept as a pure function so callers can read it, test it, and reason about
 * it without pulling in zod machinery.
 */
export function envToConfig(env: ParsedEnv): Config {
  return {
    host: env.KIRO2CLAUDE_HOST,
    port: env.KIRO2CLAUDE_PORT,
    region: env.KIRO2CLAUDE_REGION,
    authRegion: env.KIRO2CLAUDE_AUTH_REGION,
    apiRegion: env.KIRO2CLAUDE_API_REGION,
    apiKey: env.KIRO2CLAUDE_API_KEY,
    countTokensApiUrl: env.KIRO2CLAUDE_COUNT_TOKENS_API_URL,
    countTokensApiKey: env.KIRO2CLAUDE_COUNT_TOKENS_API_KEY,
    countTokensAuthType: env.KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE,
    sqliteDbPath: env.KIRO2CLAUDE_SQLITE_DB_PATH,
    emptyStreamRetries: env.KIRO2CLAUDE_EMPTY_STREAM_RETRIES,
    captureEmptyDir: env.KIRO2CLAUDE_CAPTURE_EMPTY_DIR,
    extractThinking: env.KIRO2CLAUDE_EXTRACT_THINKING,
    identityOverride: env.KIRO2CLAUDE_IDENTITY_OVERRIDE,
    rejectUnsupportedDocuments: env.KIRO2CLAUDE_REJECT_UNSUPPORTED_DOCUMENTS,
    toolCallTextRescue: env.KIRO2CLAUDE_TOOL_CALL_TEXT_RESCUE,
    autoCaptureProfile: env.KIRO2CLAUDE_AUTO_CAPTURE_PROFILE,
    kiroCliBin: env.KIRO2CLAUDE_CLI_BIN,
    requireCliVersion: env.KIRO2CLAUDE_REQUIRE_CLI_VERSION,
    loginStartUrl: env.KIRO2CLAUDE_LOGIN_START_URL,
    loginRegion: env.KIRO2CLAUDE_LOGIN_REGION,
    loginLicense: env.KIRO2CLAUDE_LOGIN_LICENSE,
    loginTimeoutMs: env.KIRO2CLAUDE_LOGIN_TIMEOUT_MS,
  };
}

// ============================================================================
// Issue formatting
// ============================================================================

/**
 * Convert a zod validation error into a single human-readable string that
 * matches the error format the config.ts test suite asserts on.
 *
 * The hand-written validators emit one error at a time via `throw new
 * Error(...)`. zod can report multiple issues in one pass, so we
 * concatenate them with `; ` — but for the vast majority of single-field
 * failures the output is identical to the hand-written config.ts format.
 */
export function formatEnvError(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}
