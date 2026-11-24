/**
 * pi's health after a restart (T2.3 review): restore builds no pi session, so
 * pi is marked from its model catalog instead, which builds nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backends, setBackend, trackBackend } from '../health.ts';
import { markPiReady } from './pi-ready.ts';

afterEach(() => {
  setBackend('pi', 'unknown');
  vi.restoreAllMocks();
});

const pickModel = () => ({ provider: 'p', model: 'm' });

describe('markPiReady', () => {
  it('marks pi up when the configured model resolves, asking the catalog for exactly that model', async () => {
    setBackend('pi', 'unknown');
    const asked: string[] = [];
    await markPiReady({ resolve: (provider, id) => (asked.push(`${provider}/${id}`), Promise.resolve({} as never)) }, () => ({ provider: 'opencode-go', model: 'flash' }));
    expect(backends.pi).toBe('up');
    expect(asked).toEqual(['opencode-go/flash']);
  });

  it('marks pi down when the model is unknown or the catalog fails', async () => {
    setBackend('pi', 'unknown');
    await markPiReady({ resolve: () => Promise.resolve(undefined) }, pickModel);
    expect(backends.pi).toBe('down');
    setBackend('pi', 'unknown');
    await markPiReady({ resolve: () => Promise.reject(new Error('no store')) }, pickModel);
    expect(backends.pi).toBe('down');
  });

  it('marks pi down and says why, without asking the catalog, when no model can be picked', async () => {
    setBackend('pi', 'unknown');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asked: string[] = [];
    await markPiReady({ resolve: (provider, id) => (asked.push(`${provider}/${id}`), Promise.resolve({} as never)) }, () => {
      throw new Error('no pi model is configured: set FUNKYOCTOPUS_MODEL');
    });
    expect(backends.pi).toBe('down');
    expect(asked).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[pi] no pi model is configured: set FUNKYOCTOPUS_MODEL');
  });

  it('leaves a status a real session build already set, and a pi no slot runs', async () => {
    setBackend('pi', 'down');
    await markPiReady({ resolve: () => Promise.resolve({} as never) }, pickModel);
    expect(backends.pi).toBe('down');
    trackBackend('pi', false);
    await markPiReady({ resolve: () => Promise.resolve({} as never) }, pickModel);
    expect(Object.keys(backends)).not.toContain('pi');
  });
});
