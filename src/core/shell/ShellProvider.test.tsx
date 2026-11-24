import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { ComposerKeyContext } from './composer-key.ts';
import { ShellProvider } from './ShellProvider.tsx';
import { useShell } from './useShell.ts';
import type { ShellState } from './shell.types.ts';

let shell: ShellState | null = null;
let show: (key: string) => void = () => undefined;

function Probe() {
  const current = useShell();
  useEffect(() => {
    shell = current;
  });
  return <div aria-label="draft">{current.chatDraft}</div>;
}

function Tabs() {
  const [key, setKey] = useState('main');
  useEffect(() => {
    show = setKey;
  }, []);
  return (
    <ComposerKeyContext.Provider value={key}>
      <ShellProvider>
        <Probe />
      </ShellProvider>
    </ComposerKeyContext.Provider>
  );
}

const draft = () => screen.getByLabelText('draft').textContent;

describe('ShellProvider composer per tab', () => {
  it('keeps a draft and attachments per tab', () => {
    render(<Tabs />);
    act(() => {
      shell?.setChatDraft('for main');
      shell?.setChatAttachments([{ id: 'a1', kind: 'path', path: '/x' }]);
    });
    act(() => show('b'));
    expect(draft()).toBe('');
    expect(shell?.chatAttachments).toEqual([]);

    act(() => show('main'));
    expect(draft()).toBe('for main');
    expect(shell?.chatAttachments).toHaveLength(1);
  });

  it('composes into the tab named, else into the tab shown when it is called', () => {
    render(<Tabs />);
    act(() => shell?.composeInChat('review this', 'b'));
    expect(draft()).toBe('');
    expect(shell?.view).toBe('chat');
    act(() => show('b'));
    expect(draft()).toBe('review this');

    act(() => shell?.composeInChat('a template'));
    expect(draft()).toBe('a template');
    act(() => show('main'));
    expect(draft()).toBe('');
  });

  it("asks the named tab's composer for focus only when told to, until it is taken", () => {
    render(<Tabs />);
    act(() => shell?.composeInChat('no focus', 'b'));
    act(() => show('b'));
    expect(shell?.composerFocusRequested).toBe(false);

    act(() => shell?.composeInChat('take this', 'c', { focus: true }));
    expect(shell?.composerFocusRequested).toBe(false);
    act(() => show('c'));
    expect(shell?.composerFocusRequested).toBe(true);
    act(() => shell?.composerFocusTaken());
    expect(shell?.composerFocusRequested).toBe(false);
  });

  it('with append, keeps what the tab already holds and adds the text after it', () => {
    render(<Tabs />);
    act(() => show('b'));
    act(() => shell?.setChatDraft('my half-written note'));
    act(() => shell?.composeInChat('take this', 'b', { append: true }));
    expect(draft()).toBe('my half-written note\n\ntake this');
    act(() => shell?.composeInChat('again', 'c', { append: true }));
    act(() => show('c'));
    expect(draft()).toBe('again');
  });

  it('says what a tab holds unsent, attachments alone included, and moves or drops it (the draft guard)', () => {
    render(<Tabs />);
    expect(shell?.hasUnsent('b')).toBe(false);
    act(() => show('b'));
    act(() => shell?.setChatDraft('   '));
    expect(shell?.hasUnsent('b')).toBe(false);
    act(() => shell?.setChatAttachments([{ id: 'a1', kind: 'path', path: '/x' }]));
    expect(shell?.hasUnsent('b')).toBe(true);
    act(() => shell?.setChatDraft('from b'));
    act(() => show('main'));
    act(() => shell?.setChatDraft('main first'));

    act(() => shell?.moveComposer('b', 'main'));
    expect(draft()).toBe('main first\n\nfrom b');
    expect(shell?.chatAttachments).toHaveLength(1);
    expect(shell?.hasUnsent('b')).toBe(false);

    act(() => shell?.discardComposer('main'));
    expect(draft()).toBe('');
    expect(shell?.hasUnsent('main')).toBe(false);
  });
});
