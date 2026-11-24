import { runInThisContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import html from '../../../index.html?raw';
import { STORAGE_KEY } from './preferences.service.ts';

// The inline script in index.html applies the stored theme before React (and
// the stylesheet) load, so the page never paints in the wrong theme first.
const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
const boot = (): void => {
  runInThisContext(script);
};

describe('index.html theme boot script', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('reads the preferences key the service writes', () => {
    expect(script).toContain(`'${STORAGE_KEY}'`);
  });

  it('applies the stored theme', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'matrix' }));
    boot();
    expect(document.documentElement.dataset.theme).toBe('matrix');
  });

  it.each([
    ['nothing stored', null],
    ['no theme stored', JSON.stringify({ fontSize: 20 })],
    ['malformed JSON', '{'],
  ])('falls back to brand with %s', (_label, raw) => {
    if (raw !== null) localStorage.setItem(STORAGE_KEY, raw);
    boot();
    expect(document.documentElement.dataset.theme).toBe('brand');
  });
});
