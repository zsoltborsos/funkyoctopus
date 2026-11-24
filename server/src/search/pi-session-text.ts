/**
 * One pi session file read for search: the header, the session's name and the
 * text of its conversation.
 *
 * pi exports no per-file reader (its `buildSessionInfo` is private) and
 * `SessionManager.listAll()` takes seconds over a real store, so this reads one
 * file as a stream and applies **pi's own text rule** from that function: of the
 * `message` entries only the `user` and `assistant` ones count, their text is a
 * string `content` or the `text` parts joined by a space, and the messages are
 * joined by a space. Tool calls, thinking and tool results are never text. A
 * hermetic contract test (`pi-session-text.test.ts`) holds this equal to pi's
 * `allMessagesText`, so a pi bump that changes the rule fails there.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { recordOf } from '../util/records.ts';

export interface PiSessionText {
  id: string;
  /** The header's recorded folder; empty when it names none. */
  cwd: string;
  /** The header's ISO timestamp, as written; null when it has none. */
  created: string | null;
  /** The latest `session_info` name; undefined when there is none or it was cleared. */
  name: string | undefined;
  /** The first user message with text; empty when there is none. */
  firstMessage: string;
  /** Every user and assistant message's text, joined by a space. */
  text: string;
}

/** pi's `extractTextContent`: a bare string, or the `text` parts joined by a space. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => recordOf(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part?.text as string)
    .join(' ');
}

/** The session file's text, or null when it cannot be read or does not open with a `session` header. */
export async function readPiSessionText(path: string): Promise<PiSessionText | null> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    let header: Record<string, unknown> | null = null;
    let name: string | undefined;
    let firstMessage = '';
    const messages: string[] = [];
    for await (const line of lines) {
      let entry: Record<string, unknown> | null;
      try {
        entry = recordOf(JSON.parse(line));
      } catch {
        continue;
      }
      if (!entry) continue;
      if (!header) {
        if (entry.type !== 'session' || typeof entry.id !== 'string') return null;
        header = entry;
        continue;
      }
      // The latest name stands, and an empty one clears it.
      if (entry.type === 'session_info') {
        name = (typeof entry.name === 'string' ? entry.name.trim() : '') || undefined;
        continue;
      }
      if (entry.type !== 'message') continue;
      const message = recordOf(entry.message);
      if (message?.role !== 'user' && message?.role !== 'assistant') continue;
      const text = textOf(message.content);
      if (!text) continue;
      messages.push(text);
      if (!firstMessage && message.role === 'user') firstMessage = text;
    }
    if (!header) return null;
    return {
      id: header.id as string,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      created: typeof header.timestamp === 'string' ? header.timestamp : null,
      name,
      firstMessage,
      text: messages.join(' '),
    };
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}
