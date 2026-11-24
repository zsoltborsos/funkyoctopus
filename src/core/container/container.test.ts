import { describe, expect, it, vi } from 'vitest';
import { Container, token } from './container.ts';

describe('Container', () => {
  it('builds a singleton once and caches it', () => {
    const c = new Container();
    const factory = vi.fn(() => ({ id: Math.random() }));
    const T = token<{ id: number }>('Thing');
    c.register(T, factory);

    const first = c.resolve(T);
    const second = c.resolve(T);
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('lets a factory resolve its own dependencies from the container', () => {
    const c = new Container();
    const DEP = token<number>('Dep');
    const SUM = token<number>('Sum');
    c.registerInstance(DEP, 40);
    c.register(SUM, (self) => self.resolve(DEP) + 2);

    expect(c.resolve(SUM)).toBe(42);
  });

  it('a scope answers its own tokens and leaves the rest to its parent', () => {
    const root = new Container();
    const SHARED = token<{ name: string }>('Shared');
    const PER_TAB = token<string>('PerTab');
    root.register(SHARED, () => ({ name: 'shared' }));
    const tab = new Container(root);
    tab.registerInstance(PER_TAB, 'tab-1');

    expect(tab.resolve(PER_TAB)).toBe('tab-1');
    expect(tab.resolve(SHARED)).toBe(root.resolve(SHARED));
    expect(() => root.resolve(PER_TAB)).toThrow(/No registration/);
  });

  it('throws on an unregistered token', () => {
    const c = new Container();
    expect(() => c.resolve(token('Missing'))).toThrow(/No registration/);
  });

  it('detects a circular dependency instead of overflowing', () => {
    const c = new Container();
    const A = token<number>('A');
    const B = token<number>('B');
    c.register(A, (self) => self.resolve(B));
    c.register(B, (self) => self.resolve(A));

    expect(() => c.resolve(A)).toThrow(/Circular dependency/);
  });
});
