import { describe, expect, it } from 'vitest';
import {
  MAX_HELMRAISER_TASK_BODY_CHARS,
  parseHelmraiserTaskBlock,
} from './helmraiser-task-block.ts';

const block = (title: string, body: string, close = true) =>
  `before\n\`\`\`helmraiser-task\ntitle: ${title}\n${body}${close ? '\n```' : ''}\nafter`;

const validBody = '## Goal\n\nShip it.\n\n## Change\n\nMake the change.';

const bodyAtSize = (size: number): string => {
  const required = '## Goal\n\n## Change\n';
  return required + 'x'.repeat(size - required.length);
};

describe('parseHelmraiserTaskBlock', () => {
  it('extracts one valid task block and ignores prose around it', () => {
    expect(parseHelmraiserTaskBlock(block('Chat-authored task', validBody))).toEqual({
      ok: true,
      title: 'Chat-authored task',
      body: validBody,
    });
  });

  it.each([
    ['absent', 'ordinary reply', 'missing-block'],
    ['duplicate', `${block('One', validBody)}\n${block('Two', validBody)}`, 'duplicate-block'],
    ['unclosed', block('Task', validBody, false), 'unclosed-block'],
    ['missing title', block('', validBody), 'missing-title'],
    ['malformed title', block('Task', validBody).replace('title: Task', 'Task'), 'missing-title'],
    ['missing Goal', block('Task', '## Change\n\nDo it.'), 'missing-goal'],
    ['missing Change', block('Task', '## Goal\n\nDo it.'), 'missing-change'],
  ])('returns a typed failure for %s', (_name, reply, reason) => {
    expect(parseHelmraiserTaskBlock(reply)).toEqual({ ok: false, reason });
  });

  it('accepts the named body-size limit and rejects one character more', () => {
    const atLimit = bodyAtSize(MAX_HELMRAISER_TASK_BODY_CHARS);
    expect(parseHelmraiserTaskBlock(block('Boundary', atLimit))).toEqual({
      ok: true,
      title: 'Boundary',
      body: atLimit,
    });
    expect(parseHelmraiserTaskBlock(block('Too large', bodyAtSize(MAX_HELMRAISER_TASK_BODY_CHARS + 1))))
      .toEqual({ ok: false, reason: 'body-too-large' });
  });

  it('keeps inner code blocks in the body instead of closing at their fence', () => {
    const body = '## Goal\n\nFix it.\n\n## Change\n\n```ts\nconst id = `a:${b}`;\n```\n\nThen test it.';
    expect(parseHelmraiserTaskBlock(block('Code', body))).toEqual({ ok: true, title: 'Code', body });
  });

  it('closes a longer outer fence only on a bare fence at least as long', () => {
    const body = '## Goal\n\nFix it.\n\n## Change\n\n```\nplain block\n```';
    const reply = `\`\`\`\`helmraiser-task\ntitle: Four\n${body}\n\`\`\`\`\nafter`;
    expect(parseHelmraiserTaskBlock(reply)).toEqual({ ok: true, title: 'Four', body });
  });

  it('reports an unclosed block when only an inner code block closes', () => {
    const reply = '```helmraiser-task\ntitle: T\n## Goal\n\n## Change\n\n```ts\nx\n```\n';
    expect(parseHelmraiserTaskBlock(reply)).toEqual({ ok: false, reason: 'unclosed-block' });
  });
});
