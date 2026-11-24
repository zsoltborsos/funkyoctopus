/**
 * Container — the swap point for funkyoctopus's seams.
 *
 * A deep module: the whole interface is `register`, `registerInstance`,
 * `resolve` and `reset`. Everything a caller must know lives here —
 * singletons are lazily built once and cached, factories receive the
 * container so they can pull their own dependencies, and a resolve cycle
 * throws instead of overflowing the stack.
 *
 * This is deliberately the *opposite* of the original 18-method container:
 * no transient/auto-register/stats/validate surface until something actually
 * needs it (one adapter is a hypothetical seam; two make it real). A scope —
 * a container with a parent — is the one extension: each chat tab (T2.2)
 * answers its own chat services and leaves everything else to the app's.
 */

/** Opaque, type-carrying key for a registered value of type `T`. */
export type Token<T> = symbol & { readonly __type?: T };

/** Mint a typed token. The phantom `T` flows through `resolve` for free. */
export function token<T>(description: string): Token<T> {
  return Symbol(description);
}

/** Builds a value on first resolve; gets the container to pull dependencies. */
export type Factory<T> = (c: Container) => T;

export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving = new Set<symbol>();

  /** A scope's parent answers every token the scope has no registration for. */
  constructor(private readonly parent?: Container) {}

  /** Register a lazily-constructed singleton for `token`. */
  register<T>(t: Token<T>, factory: Factory<T>): void {
    this.factories.set(t, factory);
  }

  /** Register an already-built value (e.g. a config object or a test fake). */
  registerInstance<T>(t: Token<T>, instance: T): void {
    this.instances.set(t, instance);
  }

  /** Resolve `token`, building and caching its singleton on first use. */
  resolve<T>(t: Token<T>): T {
    if (this.instances.has(t)) {
      return this.instances.get(t) as T;
    }

    const factory = this.factories.get(t);
    if (!factory) {
      if (this.parent) return this.parent.resolve(t);
      throw new Error(`No registration for token: ${t.description ?? '(anonymous)'}`);
    }

    if (this.resolving.has(t)) {
      throw new Error(`Circular dependency while resolving: ${t.description ?? '(anonymous)'}`);
    }

    this.resolving.add(t);
    try {
      const instance = factory(this) as T;
      this.instances.set(t, instance);
      return instance;
    } finally {
      this.resolving.delete(t);
    }
  }

  /** Drop all cached instances and registrations. Primarily for tests. */
  reset(): void {
    this.factories.clear();
    this.instances.clear();
    this.resolving.clear();
  }
}

/** The application-wide container. Tests build their own instead. */
export const container = new Container();
