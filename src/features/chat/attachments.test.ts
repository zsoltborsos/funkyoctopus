import { describe, expect, it } from 'vitest';
import { composeMessage, imageAttachments, pathAttachments, pathsFromText } from './attachments.ts';

describe('pathsFromText', () => {
  it('accepts absolute, ~/ and file:// lines, one path per line', () => {
    expect(pathsFromText('/home/z/a.ts')).toEqual(['/home/z/a.ts']);
    expect(pathsFromText(' ~/notes/x.md \n/tmp/shot.png\n')).toEqual(['~/notes/x.md', '/tmp/shot.png']);
    expect(pathsFromText('file:///home/z/My%20Pictures/s.png')).toEqual(['/home/z/My Pictures/s.png']);
  });

  it('refuses prose that merely contains a path, relative paths and empty text', () => {
    expect(pathsFromText('look at /home/z/a.ts please')).toBeNull();
    expect(pathsFromText('src/a.ts')).toBeNull();
    expect(pathsFromText('/home/z/a.ts\nand then')).toBeNull();
    expect(pathsFromText('   ')).toBeNull();
  });
});

describe('imageAttachments', () => {
  it('reads image files to base64 and skips anything else', async () => {
    const png = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const read = await imageAttachments([txt, png]);
    expect(read).toHaveLength(1);
    const [only] = read;
    expect(only).toMatchObject({ kind: 'image', name: 'shot.png', mimeType: 'image/png' });
    expect(only?.kind === 'image' ? only.data : null).toBe(btoa(String.fromCharCode(137, 80, 78, 71)));
  });
});

describe('composeMessage', () => {
  it('appends path lines after the text and separates the images', () => {
    const attachments = [
      ...pathAttachments(['/home/z/a.ts', '~/b.md']),
      { id: 'i', kind: 'image' as const, name: 'x', mimeType: 'image/png', data: 'AAAA' },
    ];
    expect(composeMessage('  what do these do?  ', attachments)).toEqual({
      text: 'what do these do?\n\n/home/z/a.ts\n~/b.md',
      images: [{ mimeType: 'image/png', data: 'AAAA' }],
    });
  });

  it('sends paths alone when there is no prose, and nothing extra when there are no attachments', () => {
    expect(composeMessage('', pathAttachments(['/x']))).toEqual({ text: '/x', images: [] });
    expect(composeMessage('hi', [])).toEqual({ text: 'hi', images: [] });
  });
});
