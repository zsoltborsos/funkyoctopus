import { describe, expectTypeOf, it } from 'vitest';
import type { ChatEngine } from './chat-engine.ts';
import type { ChatSlots } from './chat-registry.ts';
import type { PiChat } from './pi/pi-chat.ts';
import type { ClaudeCodeChat } from './claude-code/chat.ts';
import type { ModelCatalog } from './pi/model-catalog.ts';
import { registerChatSeam } from './seams/chat.ts';
import { registerModelsSeam, type ModelLister } from './seams/models.ts';

// These are compile-time checks: `tsc -b` (npm run type-check) is what fails.
describe('ChatEngine', () => {
  it('is satisfied by PiChat as it stands', () => {
    expectTypeOf<PiChat>().toExtend<ChatEngine>();
  });

  it('is satisfied by ClaudeCodeChat', () => {
    expectTypeOf<ClaudeCodeChat>().toExtend<ChatEngine>();
  });

  it('is what the chat seam reaches through the slots, instead of a PiChat', () => {
    expectTypeOf(registerChatSeam).parameter(1).toEqualTypeOf<ChatSlots>();
    expectTypeOf<ReturnType<ChatSlots['engine']>>().toEqualTypeOf<ChatEngine>();
  });

  it('lets the models seam take any model list, pi catalog included', () => {
    expectTypeOf<ModelCatalog>().toExtend<ModelLister>();
    expectTypeOf(registerModelsSeam).parameter(1).toEqualTypeOf<ModelLister>();
  });
});
