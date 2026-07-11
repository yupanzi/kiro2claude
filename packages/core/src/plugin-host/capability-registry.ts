/**
 * CapabilityRegistry — host registers named capabilities; plugins look them
 * up by name via ctx.getCapability(name). Names are part of the public
 * contract surface (documented in @kiro2claude/plugin-api types).
 */
export class CapabilityRegistry {
  readonly #caps = new Map<string, unknown>();

  register<T>(name: string, value: T): void {
    if (this.#caps.has(name)) {
      throw new Error(`capability "${name}" is already registered`);
    }
    this.#caps.set(name, value);
  }

  get<T = unknown>(name: string): T | undefined {
    return this.#caps.get(name) as T | undefined;
  }
}
