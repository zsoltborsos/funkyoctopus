import type { ComposerAttachment } from '@core/shell/shell.types.ts';
import type { ChatImageAttachment } from '@shared/transport/protocol.ts';

let seq = 0;
const nextId = (): string => {
  seq += 1;
  return `a${seq}`;
};

/** Absolute path or `~/` path with no whitespace, or a `file://` URI. */
const PATH_LINE = /^(?:\/|~\/)\S+$/;
const FILE_URI = /^file:\/\/(?:localhost)?(\/\S*)$/;

/**
 * Pure: when pasted or dropped text is nothing but file paths — one per line,
 * absolute or `~/`, or `file://` URIs as a file manager drops them — return
 * those paths; otherwise null, and the text is ordinary prose to be typed in.
 * The rule is deliberately strict so a sentence that merely contains a path is
 * never hijacked into a chip.
 */
export function pathsFromText(text: string): string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const paths: string[] = [];
  for (const line of lines) {
    const uri = FILE_URI.exec(line);
    if (uri) {
      paths.push(decodeURIComponent(uri[1]!));
    } else if (PATH_LINE.test(line)) {
      paths.push(line);
    } else {
      return null;
    }
  }
  return paths;
}

export const pathAttachments = (paths: string[]): ComposerAttachment[] =>
  paths.map((path) => ({ id: nextId(), kind: 'path', path }));

/** Read an image File into a base64 attachment (null for non-images). */
export function imageAttachment(file: File): Promise<ComposerAttachment | null> {
  if (!file.type.startsWith('image/')) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'));
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      if (comma < 0) {
        resolve(null);
        return;
      }
      resolve({
        id: nextId(),
        kind: 'image',
        name: file.name || 'image',
        mimeType: file.type,
        data: url.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Every image among `files`, in order; non-images are skipped. */
export async function imageAttachments(files: Iterable<File>): Promise<ComposerAttachment[]> {
  const read = await Promise.all([...files].map(imageAttachment));
  return read.filter((a): a is ComposerAttachment => a !== null);
}

/** Images already sent (or queued) come back to the composer in this shape. */
export const attachmentsFromImages = (images: ChatImageAttachment[]): ComposerAttachment[] =>
  images.map((img, i) => ({
    id: nextId(),
    kind: 'image',
    name: `image ${i + 1}`,
    mimeType: img.mimeType,
    data: img.data,
  }));

/** What actually goes on the wire: the text with path lines appended, and the images. */
export function composeMessage(
  draft: string,
  attachments: ComposerAttachment[],
): { text: string; images: ChatImageAttachment[] } {
  const paths = attachments.flatMap((a) => (a.kind === 'path' ? [a.path] : []));
  const images = attachments.flatMap((a) =>
    a.kind === 'image' ? [{ mimeType: a.mimeType, data: a.data }] : [],
  );
  const body = draft.trim();
  const text = paths.length === 0 ? body : [body, paths.join('\n')].filter(Boolean).join('\n\n');
  return { text, images };
}
