import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@shared/transport/protocol.ts';
import { chatAgent } from './agent.ts';

const option = (provider: string, id: string): ModelOption => ({
  provider,
  id,
  name: id,
  thinkingLevels: [],
  input: ['text'],
});

const PI_MODELS = [option('alpha', 'glm-5.2'), option('anthropic', 'opus')];
/** The same pi models, with the sidecar's `isDefault` mark on one. */
const PI_MODELS_DEFAULT_GLM: ModelOption[] = [{ ...PI_MODELS[0]!, isDefault: true }, PI_MODELS[1]!];
const CLAUDE_MODELS = [option('claude-code', 'sonnet'), option('claude-code', 'haiku')];

describe('chatAgent', () => {
  it('is pi on pi\'s default route, named by the model the sidecar marked as its default', () => {
    expect(chatAgent(PI_MODELS_DEFAULT_GLM, null)).toEqual({ name: 'pi', model: 'glm-5.2' });
  });

  it('is pi with no model to name when the sidecar marked no default', () => {
    expect(chatAgent(PI_MODELS, null)).toEqual({ name: 'pi', model: null });
  });

  it('is pi on a pi model the owner picked, even one called Claude by its provider', () => {
    expect(chatAgent(PI_MODELS_DEFAULT_GLM, { provider: 'anthropic', id: 'opus' })).toEqual({ name: 'pi', model: 'opus' });
  });

  it('is Claude when the engine serves Claude Code\'s models, on the model picked', () => {
    expect(chatAgent(CLAUDE_MODELS, { provider: 'claude-code', id: 'haiku' })).toEqual({
      name: 'Claude',
      model: 'haiku',
    });
  });

  it('is Claude on its own default when nothing is picked, not on pi\'s default model', () => {
    expect(chatAgent(CLAUDE_MODELS, null)).toEqual({ name: 'Claude', model: 'default' });
  });

  it('is Claude on its default when the remembered pick is a pi model the engine does not serve', () => {
    expect(chatAgent(CLAUDE_MODELS, { provider: 'alpha', id: 'glm-5.2' })).toEqual({
      name: 'Claude',
      model: 'default',
    });
  });

  it('is pi again after switching back: a remembered Claude Code pick does not outvote pi\'s own list', () => {
    expect(chatAgent(PI_MODELS_DEFAULT_GLM, { provider: 'claude-code', id: 'haiku' })).toEqual({
      name: 'pi',
      model: 'glm-5.2',
    });
  });

  it('knows a Claude Code pick before the model list has loaded', () => {
    expect(chatAgent([], { provider: 'claude-code', id: 'opus' })).toEqual({ name: 'Claude', model: 'opus' });
    expect(chatAgent([], { provider: 'alpha', id: 'glm-5.2' })).toEqual({ name: 'pi', model: 'glm-5.2' });
    expect(chatAgent([], null)).toEqual({ name: 'pi', model: null });
  });
});
