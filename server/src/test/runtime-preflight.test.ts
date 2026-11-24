import { afterEach, describe, expect, it } from 'vitest';
import { resolveRuntimePin } from './runtime-preflight.ts';

afterEach(() => {
  delete process.env.FUNKYOCTOPUS_RUNTIME_MODEL;
});

describe('resolveRuntimePin', () => {
  it('defaults to the accepted plan pin when unset', () => {
    expect(resolveRuntimePin()).toEqual({ provider: 'opencode-go', id: 'deepseek-v4.1-flash' });
  });

  it('parses a valid explicit provider/id override', () => {
    process.env.FUNKYOCTOPUS_RUNTIME_MODEL = 'some-provider/some-model';
    expect(resolveRuntimePin()).toEqual({ provider: 'some-provider', id: 'some-model' });
  });

  it('splits on the first slash so a slash-bearing model id survives', () => {
    process.env.FUNKYOCTOPUS_RUNTIME_MODEL = 'provider/path/model';
    expect(resolveRuntimePin()).toEqual({ provider: 'provider', id: 'path/model' });
  });

  it('treats an empty override as unset and defaults', () => {
    process.env.FUNKYOCTOPUS_RUNTIME_MODEL = '';
    expect(resolveRuntimePin()).toEqual({ provider: 'opencode-go', id: 'deepseek-v4.1-flash' });
  });

  it('rejects overrides that are not an explicit provider/id pair', () => {
    for (const malformed of ['opencode-go', '/model', 'provider/']) {
      process.env.FUNKYOCTOPUS_RUNTIME_MODEL = malformed;
      expect(() => resolveRuntimePin()).toThrow(/provider\/id/);
    }
  });
});
