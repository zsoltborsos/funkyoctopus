import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FALLBACK_MODELS, toModelOption } from './models.ts';

const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/supported-models.json', import.meta.url), 'utf8'),
) as Parameters<typeof toModelOption>[0][];
const recordedModel = (value: string) => {
  const model = recorded.find((m) => m.value === value);
  if (!model) throw new Error(`no recorded model ${value}`);
  return model;
};

describe('toModelOption', () => {
  it('offers a Claude model under the claude-code provider with its effort ladder', () => {
    expect(toModelOption(recordedModel('haiku'))).toEqual({
      provider: 'claude-code',
      id: 'haiku',
      name: 'Haiku 5.5',
      // What a stored turn says it ran on: the picker can label it by this.
      resolvedId: 'claude-haiku-5-5',
      thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      input: ['text', 'image'],
    });
  });

  it('gives a model without effort support no ladder', () => {
    expect(toModelOption(recordedModel('claude-haiku-4-5-20251001'))).toMatchObject({
      id: 'claude-haiku-4-5-20251001',
      name: 'Haiku 4.5',
      thinkingLevels: [],
    });
    // A model listed by its own id resolves to itself (as recorded).
    expect(toModelOption(recordedModel('claude-haiku-4-5-20251001'))).toMatchObject({
      resolvedId: 'claude-haiku-4-5-20251001',
    });
  });
});

describe('FALLBACK_MODELS', () => {
  it('names the three aliases Claude Code always accepts, before any session has listed the real ones', () => {
    expect(FALLBACK_MODELS.map((model) => model.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(FALLBACK_MODELS.every((model) => model.provider === 'claude-code')).toBe(true);
  });
});
