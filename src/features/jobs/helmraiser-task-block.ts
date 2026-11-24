/** Maximum Markdown body accepted from a chat-authored Helmraiser task. */
export const MAX_HELMRAISER_TASK_BODY_CHARS = 20_000;

export type HelmraiserTaskBlockFailure =
  | 'missing-block'
  | 'duplicate-block'
  | 'unclosed-block'
  | 'missing-title'
  | 'missing-goal'
  | 'missing-change'
  | 'body-too-large';

export type HelmraiserTaskBlockResult =
  | { ok: true; title: string; body: string }
  | { ok: false; reason: HelmraiserTaskBlockFailure };

const OPENING = /^(`{3,})helmraiser-task[\t ]*$/gm;

/**
 * The line index that closes the block opened with `fence`. A longer outer
 * fence closes only on a bare fence at least as long (CommonMark). A plain
 * three-backtick outer fence also skips inner code blocks: a fence with an
 * info string (```ts) opens one, and the next bare fence closes it.
 */
function closingLine(lines: string[], fence: string): number {
  let inner = false;
  for (const [index, line] of lines.entries()) {
    const bare = /^(`{3,})[\t ]*$/.exec(line);
    if (fence.length > 3) {
      if (bare?.[1] && bare[1].length >= fence.length) return index;
      continue;
    }
    if (bare) {
      if (!inner) return index;
      inner = false;
    } else if (/^`{3,}\S/.test(line)) {
      inner = true;
    }
  }
  return -1;
}

/** Parse the one deliberately narrow task block produced by the chat drafting turn. */
export function parseHelmraiserTaskBlock(reply: string): HelmraiserTaskBlockResult {
  const openings = [...reply.matchAll(OPENING)];
  if (openings.length === 0) return { ok: false, reason: 'missing-block' };
  if (openings.length > 1) return { ok: false, reason: 'duplicate-block' };

  const opening = openings[0];
  if (!opening?.[1] || opening.index === undefined) return { ok: false, reason: 'missing-block' };
  const contentStart = opening.index + opening[0].length;
  const lines = reply.slice(contentStart).replace(/\r\n/g, '\n').replace(/^\n/, '').split('\n');
  const close = closingLine(lines, opening[1]);
  if (close < 0) return { ok: false, reason: 'unclosed-block' };

  const content = lines.slice(0, close).join('\n');
  const newline = content.indexOf('\n');
  const titleLine = newline < 0 ? content : content.slice(0, newline);
  const titleMatch = /^title:[\t ]*(.+?)[\t ]*$/.exec(titleLine);
  if (!titleMatch?.[1]?.trim()) return { ok: false, reason: 'missing-title' };

  const body = newline < 0 ? '' : content.slice(newline + 1);
  if (body.length > MAX_HELMRAISER_TASK_BODY_CHARS) return { ok: false, reason: 'body-too-large' };
  if (!/^## Goal[\t ]*$/m.test(body)) return { ok: false, reason: 'missing-goal' };
  if (!/^## Change[\t ]*$/m.test(body)) return { ok: false, reason: 'missing-change' };

  return { ok: true, title: titleMatch[1].trim(), body };
}
