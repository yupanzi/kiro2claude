/**
 * Environment-variable helpers shared across plugins.
 *
 * Zero runtime deps; pure functions only.
 */

/**
 * Parse an env var as a boolean. Accepts `1/true/yes/on` and `0/false/no/off`
 * case-insensitively to stay consistent with the host's config schema. Returns
 * `defaultValue` when the var is unset / empty / unrecognized.
 */
export function parseEnvBool(raw: string | undefined, defaultValue = false): boolean {
  if (raw == null || raw === '') return defaultValue;
  const lower = raw.toLowerCase();
  if (lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on') return true;
  if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') return false;
  return defaultValue;
}
