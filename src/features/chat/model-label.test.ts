import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@shared/transport/protocol.ts';
import { modelLabel } from './model-label.ts';

const option = (over: Partial<ModelOption>): ModelOption => ({
  provider: 'claude-code',
  id: 'haiku',
  name: 'Haiku 5.5',
  thinkingLevels: [],
  input: ['text', 'image'],
  ...over,
});

const models = [
  // Claude Code lists its own default as a model too; it resolves to whichever model is current.
  option({ id: 'default', name: 'Default (recommended)', resolvedId: 'claude-sonnet-5-5' }),
  option({ resolvedId: 'claude-haiku-5-5' }),
  option({ id: 'sonnet', name: 'Sonnet 5.5', resolvedId: 'claude-sonnet-5-5' }),
  option({ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' }),
  option({ provider: 'openai', id: 'gpt-5', name: 'GPT 5' }),
];

describe('modelLabel', () => {
  it('names the full model id a stored turn ran on by the picker\'s name for it', () => {
    expect(modelLabel(models, 'claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelLabel(models, 'claude-sonnet-5-5')).toBe('Sonnet 5.5');
  });

  it('names the model a turn ran on, not the default alias that happens to resolve to it', () => {
    expect(modelLabel(models, 'claude-sonnet-5-5')).toBe('Sonnet 5.5');
  });

  it('keeps the id of a model only the default alias covers, and leaves the default itself as it is', () => {
    const onlyDefault = [option({ id: 'default', name: 'Default (recommended)', resolvedId: 'claude-opus-5-5' })];

    expect(modelLabel(onlyDefault, 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelLabel(onlyDefault, 'default')).toBe('default');
  });

  it('names the alias a live turn was asked for the same way, so both read alike', () => {
    expect(modelLabel(models, 'haiku')).toBe('Haiku 5.5');
  });

  it('names a model that is listed by its own id', () => {
    expect(modelLabel(models, 'claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('keeps the id when no Claude model in the list matches it', () => {
    expect(modelLabel(models, 'claude-opus-9')).toBe('claude-opus-9');
    expect(modelLabel(models, 'default')).toBe('default');
    expect(modelLabel([], 'claude-haiku-5-5')).toBe('claude-haiku-5-5');
  });

  it('leaves another provider\'s ids as they are', () => {
    expect(modelLabel(models, 'gpt-5')).toBe('gpt-5');
  });
});
