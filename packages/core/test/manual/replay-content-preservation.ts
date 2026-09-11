/**
 * Replay recorded real-client Claude Messages requests through the *current*
 * `convertRequest` (no model is called) and check, per request:
 *
 *   1. Content preservation: every client-authored text (request `system`,
 *      user / `role:"system"` text blocks, tool_result text, assistant text and
 *      thinking) is a substring of some string on the produced Kiro wire.
 *      Claude Code's mid-session insertions arrive as `role:"system"` messages
 *      right after a user turn (permission-mode directives, "file changed on
 *      disk" notes, budget reminders); a trailing one must land in
 *      `currentMessage`, a mid-history one in a history user entry.
 *   2. History shape: kinds strictly alternate, first entry is a user turn,
 *      last entry is an assistant turn, currentMessage is non-empty.
 *
 * Mirrors the handler pipeline (schema parse, rescue registry, convert).
 * A text lost only when the rescue registry is on is reported separately: that
 * is the leaked-tool-call stripper doing its job, not a conversion loss.
 *
 * Sources: every `*.json` under `K2C_REPLAY_ROOT` (default `test-results/`)
 * whose `requests[].request` is a Claude Messages body. Evidence is read-only.
 * Full report goes to `K2C_REPLAY_REPORT`
 * (default /tmp/k2c-replay-content-preservation.json).
 *
 *   LOG_LEVEL=silent pnpm --filter @kiro2claude/core exec tsx test/manual/replay-content-preservation.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertRequest } from '../../src/claude/converter.js';
import { messagesRequestSchema } from '../../src/claude/schemas/messages-request-schema.js';
import { buildToolTextRegistry } from '../../src/claude/tool-call-text.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.K2C_REPLAY_ROOT ?? join(here, '../../../../test-results'));
const reportPath = resolve(
  process.env.K2C_REPLAY_REPORT ?? '/tmp/k2c-replay-content-preservation.json',
);
const maxExamples = Number(process.env.K2C_REPLAY_EXAMPLES ?? 6);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

interface ClientText {
  role: string;
  index: number;
  where: 'system' | 'text' | 'tool_result' | 'thinking';
  text: string;
  trailingSystem: boolean;
}

type Raw = any;

function pushText(out: ClientText[], t: Omit<ClientText, 'text'> & { text: unknown }): void {
  if (typeof t.text === 'string' && t.text.trim().length > 0) out.push(t as ClientText);
}

function collectClientTexts(req: Raw): ClientText[] {
  const out: ClientText[] = [];
  const sys = req.system;
  const sysBase = { role: 'system', index: -1, where: 'system' as const, trailingSystem: false };
  if (typeof sys === 'string') pushText(out, { ...sysBase, text: sys });
  else if (Array.isArray(sys)) for (const s of sys) pushText(out, { ...sysBase, text: s?.text });
  const msgs: Raw[] = req.messages ?? [];
  msgs.forEach((m, i) => {
    const trailingSystem = m.role === 'system' && i === msgs.length - 1;
    const base = { role: m.role, index: i, trailingSystem };
    if (typeof m.content === 'string') {
      pushText(out, { ...base, where: 'text', text: m.content });
      return;
    }
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') pushText(out, { ...base, where: 'text', text: b.text });
      else if (b.type === 'thinking')
        pushText(out, { ...base, where: 'thinking', text: b.thinking });
      else if (b.type === 'tool_result') {
        if (typeof b.content === 'string') {
          pushText(out, { ...base, where: 'tool_result', text: b.content });
        } else if (Array.isArray(b.content)) {
          for (const c of b.content) {
            if (c?.type === 'text') pushText(out, { ...base, where: 'tool_result', text: c.text });
          }
        }
      }
    }
  });
  return out;
}

function wireStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) wireStrings(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) wireStrings(v, out);
  return out;
}

const kindOf = (h: Raw): string =>
  h.kind ?? (h.userInputMessage ? 'user' : h.assistantResponseMessage ? 'assistant' : 'unknown');

function convert(payload: Raw, rescue: boolean) {
  const registry =
    rescue && payload.tools?.length ? buildToolTextRegistry(payload.tools) : undefined;
  return convertRequest(payload, {
    identityOverride: false,
    rejectUnsupportedDocuments: true,
    toolTextRegistry: registry,
  });
}

const totals = {
  files: 0,
  requests: 0,
  schemaRejected: 0,
  conversionErrors: 0,
  clientTexts: 0,
  lost: 0,
  lostOnlyWithRescue: 0,
  trailingSystem: 0,
  trailingSystemNotInCurrent: 0,
  midSystem: 0,
  midSystemNotInHistoryUser: 0,
  historyNonAlternating: 0,
  historyAssistantFirst: 0,
  historyNotEndingAssistant: 0,
  emptyCurrent: 0,
  oldWireAvailable: 0,
  oldWireLost: 0,
  oldWireAssistantFirst: 0,
};
const examples: Record<string, unknown[]> = {};
const example = (k: string, v: unknown): void => {
  if (!examples[k]) examples[k] = [];
  const list = examples[k];
  if (list.length < maxExamples) list.push(v);
};
const errorKinds = new Map<string, number>();

for (const file of walk(root)) {
  let doc: Raw;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const records: Raw[] = Array.isArray(doc?.requests) ? doc.requests : [];
  let used = false;
  for (const r of records) {
    const raw = r?.request;
    if (!raw || !Array.isArray(raw.messages) || !/claude/i.test(String(raw.model))) continue;
    used = true;
    totals.requests++;
    const where = `${relative(root, file)}#${r.id}`;
    const parsed = messagesRequestSchema.safeParse(raw);
    if (!parsed.success) {
      totals.schemaRejected++;
      example('schemaRejected', { where, error: parsed.error.issues[0]?.message });
      continue;
    }
    const payload = parsed.data;
    let result: ReturnType<typeof convert>;
    try {
      result = convert(payload, true);
    } catch (err) {
      totals.conversionErrors++;
      const key = err instanceof Error ? `${err.name}: ${err.message.slice(0, 80)}` : String(err);
      errorKinds.set(key, (errorKinds.get(key) ?? 0) + 1);
      example('conversionErrors', { where, error: key });
      continue;
    }
    const cs: Raw = result.conversationState;
    const wire = wireStrings(cs).join(' ');
    const current: string = cs.currentMessage?.userInputMessage?.content ?? '';
    const historyUserContents: string[] = (cs.history ?? [])
      .filter((h: Raw) => kindOf(h) === 'user')
      .map((h: Raw) => h.userInputMessage?.content ?? '');

    const texts = collectClientTexts(raw);
    totals.clientTexts += texts.length;
    let lossyRescueOff: string | undefined;
    for (const t of texts) {
      if (!wire.includes(t.text)) {
        lossyRescueOff ??= wireStrings(convert(payload, false).conversationState).join(' ');
        if (lossyRescueOff.includes(t.text)) {
          totals.lostOnlyWithRescue++;
          example('lostOnlyWithRescue', {
            where,
            role: t.role,
            index: t.index,
            head: t.text.slice(0, 100),
          });
        } else {
          totals.lost++;
          example('lost', {
            where,
            role: t.role,
            index: t.index,
            whereInMsg: t.where,
            head: t.text.slice(0, 160),
          });
        }
      }
      if (t.role === 'system' && t.index >= 0) {
        if (t.trailingSystem) {
          totals.trailingSystem++;
          if (!current.includes(t.text)) {
            totals.trailingSystemNotInCurrent++;
            example('trailingSystemNotInCurrent', { where, head: t.text.slice(0, 100) });
          }
        } else {
          totals.midSystem++;
          if (!historyUserContents.some((c) => c.includes(t.text))) {
            totals.midSystemNotInHistoryUser++;
            example('midSystemNotInHistoryUser', {
              where,
              index: t.index,
              head: t.text.slice(0, 100),
            });
          }
        }
      }
    }

    const kinds: string[] = (cs.history ?? []).map(kindOf);
    if (kinds.some((k, i) => i > 0 && k === kinds[i - 1])) {
      totals.historyNonAlternating++;
      example('historyNonAlternating', { where, kinds: kinds.join(',') });
    }
    if (kinds[0] === 'assistant') {
      totals.historyAssistantFirst++;
      example('historyAssistantFirst', {
        where,
        roles: raw.messages
          .slice(0, 3)
          .map((m: Raw) => m.role)
          .join(','),
      });
    }
    if (kinds.length > 0 && kinds[kinds.length - 1] !== 'assistant') {
      totals.historyNotEndingAssistant++;
      example('historyNotEndingAssistant', { where, kinds: kinds.join(',') });
    }
    const toolResults =
      cs.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults ?? [];
    if (current.trim().length === 0 && toolResults.length === 0) {
      totals.emptyCurrent++;
      example('emptyCurrent', { where });
    }

    const old = r.upstreamRequests?.[0]?.request?.conversationState;
    if (old) {
      totals.oldWireAvailable++;
      const oldWire = wireStrings(old).join(' ');
      for (const t of texts) {
        if (!oldWire.includes(t.text)) {
          totals.oldWireLost++;
          example('oldWireLost', {
            where,
            role: t.role,
            index: t.index,
            head: t.text.slice(0, 100),
          });
        }
      }
      if (kindOf((old.history ?? [])[0] ?? {}) === 'assistant') totals.oldWireAssistantFirst++;
    }
  }
  if (used) totals.files++;
}

const report = { root, totals, conversionErrorKinds: Object.fromEntries(errorKinds), examples };
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(
  `REPORT ${JSON.stringify(totals)}\nREPORT errorKinds ${JSON.stringify(Object.fromEntries(errorKinds))}\nREPORT full report: ${reportPath}\n`,
);
