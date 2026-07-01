/**
 * SQLite credential store errors.
 *
 * These distinguish "key doesn't exist" (a legitimate "not logged in yet"
 * signal) from "key exists but JSON is garbage" (a real data-corruption
 * emergency). Without this distinction, `readAuthKvJson` would collapse both
 * into `undefined`, making it impossible for the caller to tell whether to
 * exit 1 (corrupted store) or prompt for bootstrap login (empty store).
 */

/**
 * Thrown when a known SQLite credential key exists but its value is not
 * valid JSON. This is a structural corruption — retrying won't help; the
 * caller should log fatal and exit so the operator can investigate.
 */
export class SqliteCredentialCorruptedError extends Error {
  readonly key: string;
  readonly parseError: unknown;

  constructor(key: string, parseError: unknown) {
    super(
      `SQLite credential corrupted: key "${key}" exists but its value is not valid JSON (${parseError instanceof Error ? parseError.message : String(parseError)})`,
    );
    this.name = 'SqliteCredentialCorruptedError';
    this.key = key;
    this.parseError = parseError;
  }
}
