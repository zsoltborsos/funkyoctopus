import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { ShellContext } from '@core/shell/shell-context.ts';
import type { ShellState } from '@core/shell/shell.types.ts';
import type {
  EngineKind,
  LeeboardAskedResult,
  LeeboardBrief,
  LeeboardBriefResult,
  LeeboardEntry,
  LeeboardHoldsResult,
  LeeboardOpenResult,
  LeeboardReviewResult,
  LeeboardShowResult,
} from '@shared/transport/protocol.ts';
import { TAB_FOLDER, TAB_FOLDERS, TabFolders } from '../tab-folders.ts';
import { CHAT_SESSION, type ChatLiveActivity, type ChatSession } from '../chat-session.service.ts';
import { CHAT_SESSIONS, type ChatSessions } from '../chat-sessions.service.ts';
import { LEEBOARD, type LeeboardClient } from './leeboard.client.ts';
import { LeeboardPanel } from './LeeboardPanel.tsx';
import { reviewPrompt } from './take-prompt.ts';

const entry = (id: string, title: string, extra: Partial<LeeboardEntry> = {}): LeeboardEntry => ({
  id,
  kind: id.split('-')[0] as LeeboardEntry['kind'],
  scope: 'project:funkyoctopus',
  status: 'active',
  title,
  harness: 'claude-code',
  created: '2026-10-18T11:00:00Z',
  updated: '2026-10-18T11:00:00Z',
  ...extra,
});

const brief = (overrides: Partial<LeeboardBrief> = {}): LeeboardBrief => ({
  project: 'funkyoctopus',
  unregisteredRepo: null,
  holds: [],
  grants: [],
  rules: [],
  references: [],
  inbox: [],
  repoState: [],
  ...overrides,
});

const FULL = brief({
  holds: [entry('hold-no-deploys-ab12', 'No deploys while the tunnel is open', { release: 'the tunnel closes', blocks: ['deploy', 'push'] })],
  grants: [entry('grant-fo-owns-the-panel-1a2b', 'FO session owns the panel', { holder: 'session:fo' })],
  rules: [
    entry('rule-stage-by-name-cd34', 'Stage files by name'),
    entry('rule-never-sudo-9f9f', 'Never run sudo yourself', { scope: 'global' }),
  ],
  references: [entry('reference-lb-docs-77aa', 'Leeboard design notes')],
  inbox: [entry('handoff-take-l3-ef56', 'Take the L3 panel', { to: 'project:funkyoctopus' })],
  repoState: [{ path: 'TASKS.md', lastCommit: '2026-10-17', daysAgo: 2, commitsSince: 3 }],
});

const NO_REVIEW: LeeboardReviewResult = { review: { new: [], changed: [], closed: [] } };
const DIGEST: LeeboardReviewResult = {
  review: {
    new: [
      entry('rule-new-1111', 'A new rule'),
      entry('reference-new-2222', 'A new reference'),
      entry('request-new-3333', 'An unanswered request'),
    ],
    changed: [entry('hold-changed-4444', 'A changed hold')],
    closed: [
      entry('hold-old-5555', 'An old hold', { status: 'released' }),
      entry('request-done-6666', 'A closed request', { status: 'done' }),
    ],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount(
  briefs: LeeboardBriefResult[] = [{ brief: FULL }],
  review: LeeboardReviewResult | Promise<LeeboardReviewResult> = NO_REVIEW,
  show: (id: string) => LeeboardShowResult = (id) => ({ entry: null, error: { code: 'leeboard_unknown_id', message: `no entry ${id}` } }),
  routed: LeeboardOpenResult = { open: [] },
  mine: LeeboardAskedResult = { asked: [] },
  holds?: LeeboardHoldsResult,
) {
  const container = new Container();
  const allFolders = new TabFolders(new MemoryStorageAdapter());
  const folders = allFolders.forTab('main');
  container.registerInstance(TAB_FOLDER, folders);
  container.registerInstance(TAB_FOLDERS, allFolders);
  // The window's tabs, as far as the panel uses them: turn endings, showing a tab, opening one.
  const activity = new Set<(activity: ChatLiveActivity) => void>();
  const tabs = {
    subscribeActivity: (listener: (activity: ChatLiveActivity) => void) => {
      activity.add(listener);
      return () => activity.delete(listener);
    },
    activate: vi.fn((chatId: string) => chatId !== 'gone'),
    create: vi.fn((_kind: EngineKind, _root: string | null, prepare?: (chatId: string) => void) => {
      prepare?.('n1');
      return Promise.resolve('n1');
    }),
  };
  container.registerInstance(CHAT_SESSIONS, tabs as unknown as ChatSessions);
  const emit = (event: ChatLiveActivity) => activity.forEach((listener) => listener(event));
  // The composer, as far as the panel writes to it: what it was handed, never a send.
  const composed: { text: string; chatId: string | undefined; options: { focus?: boolean; append?: boolean } | undefined }[] = [];
  const shell = {
    composeInChat: (text: string, chatId?: string, options?: { focus?: boolean; append?: boolean }) => composed.push({ text, chatId, options }),
  } as unknown as ShellState;
  // The tab's chat session, as far as the panel reads it: the folder its open session is in.
  const listeners = new Set<() => void>();
  let snapshot = { activeSession: null as { cwd: string; id: string | undefined } | null };
  const moveSession = (cwd: string, id?: string) => {
    snapshot = { activeSession: { cwd, id } };
    for (const listener of listeners) listener();
  };
  const send = vi.fn();
  container.registerInstance(CHAT_SESSION, {
    send,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  } as unknown as ChatSession);
  const asked = { brief: 0, review: 0, open: 0, asked: 0, holds: 0, shown: [] as string[] };
  const readReview = vi.fn((): Promise<LeeboardReviewResult> => {
    asked.review += 1;
    return Promise.resolve(review);
  });
  container.registerInstance(LEEBOARD, {
    chatId: 'main',
    holds: () => {
      asked.holds += 1;
      return Promise.resolve(holds ?? { holds: briefs[Math.min(asked.brief - 1, briefs.length - 1)]?.brief?.holds ?? [] });
    },
    open: () => {
      asked.open += 1;
      return Promise.resolve(routed);
    },
    asked: () => {
      asked.asked += 1;
      return Promise.resolve(mine);
    },
    brief: () => {
      asked.brief += 1;
      return Promise.resolve(briefs[Math.min(asked.brief - 1, briefs.length - 1)]!);
    },
    review: readReview,
    show: (id: string) => {
      asked.shown.push(id);
      return Promise.resolve(show(id));
    },
  } as unknown as LeeboardClient);
  render(
    <ContainerProvider container={container}>
      <ShellContext.Provider value={shell}>
        <div className="flex">
          <LeeboardPanel />
        </div>
      </ShellContext.Provider>
    </ContainerProvider>,
  );
  const spine = () => screen.getByRole('navigation', { name: 'Leeboard' });
  const pane = () => screen.getByRole('complementary', { name: 'Leeboard detail' });
  const open = (label: string) => userEvent.click(within(spine()).getByRole('button', { name: label }));
  return { asked, readReview, spine, pane, open, folders, allFolders, moveSession, tabs, emit, composed, send };
}

describe('LeeboardPanel: the spine', () => {
  it('reads glyph, count and label per tab; only an active hold is attention', async () => {
    const { spine } = mount([{ brief: FULL }], {
      review: { new: [{ id: 'rule-new-1111', kind: 'rule', scope: 'global', title: 'A new rule', status: 'active' }], changed: [], closed: [] },
    });
    const buttons = () => within(spine()).getAllByRole('button').slice(0, 3);
    await waitFor(() => expect(buttons()[0]?.textContent).toBe('↧1inbox'));
    expect(buttons().map((b) => b.textContent)).toEqual(['↧1inbox', '⊘1holds', 'Δ1digest']);
    const holdCount = within(buttons()[1]!).getByText('1');
    expect(holdCount).toHaveClass('text-attention');
    // A waiting inbox stands out from a zero, without borrowing the holds' attention.
    const inboxCount = within(buttons()[0]!).getByText('1');
    expect(inboxCount).not.toHaveClass('text-attention');
    expect(inboxCount).toHaveClass('text-text');
    // One glyph, one meaning: none borrows the shell's.
    const glyphs = buttons().map((b) => b.textContent?.charAt(0));
    expect(new Set(glyphs).size).toBe(3);
    expect(within(spine()).getAllByRole('button')).toHaveLength(4);
    expect(within(spine()).queryByRole('button', { name: 'Index' })).toBeNull();
    for (const shell of ['⧉', '❯', '⚙', '›']) expect(glyphs).not.toContain(shell);
  });

  it('shows no attention when nothing is held', async () => {
    const { spine } = mount([{ brief: brief() }]);
    await waitFor(() => expect(within(spine()).getByRole('button', { name: 'Holds' }).textContent).toBe('⊘0holds'));
    expect(spine().querySelector('.text-attention')).toBeNull();
  });
});

describe('LeeboardPanel: content', () => {
  it('inbox first: handoffs and requests with who they are to and from', async () => {
    const { open, pane } = mount();
    await open('Inbox');
    expect(within(pane()).getByRole('banner')).toHaveTextContent('INBOXproject funkyoctopus');
    expect(await within(pane()).findByText('Take the L3 panel')).toBeInTheDocument();
    expect(within(pane()).getByText('handoff → project:funkyoctopus · from claude-code')).toBeInTheDocument();
    expect(within(pane()).getByText('last commit: TASKS.md 2d ago, 3 commits since')).toBeInTheDocument();
  });

  it('holds show their release condition and what they block', async () => {
    const { open, pane } = mount();
    await open('Holds');
    expect(await within(pane()).findByText('No deploys while the tunnel is open')).toBeInTheDocument();
    expect(within(pane()).getByText('release: the tunnel closes')).toBeInTheDocument();
    expect(within(pane()).getByText('blocks deploy, push')).toBeInTheDocument();
  });

  it('the digest lists new, changed and closed titles, and offers no "mark seen"', async () => {
    const { open, pane } = mount([{ brief: FULL }], {
      review: {
        new: [{ id: 'rule-new-1111', kind: 'rule', scope: 'global', title: 'A new rule', status: 'active' }],
        changed: [],
        closed: [{ id: 'hold-old-2222', kind: 'hold', scope: 'machine', title: 'An old hold', status: 'released' }],
      },
    });
    await open('Digest');
    expect(await within(pane()).findByText(/Peek only/)).toBeInTheDocument();
    expect(within(pane()).getByText('A new rule')).toBeInTheDocument();
    expect(within(pane()).getByText('hold · machine · released')).toBeInTheDocument();
    expect(within(pane()).queryByRole('button', { name: /seen|mark/i })).toBeNull();
  });

  it.each(['pi', 'claude-code'] as const)('reviews with an agent in a global %s tab, focused and unsent, without any extra Leeboard reads', async (kind) => {
    const { open, pane, tabs, composed, asked, send, readReview, allFolders } = mount(undefined, DIGEST);
    await open('Digest');
    expect(await within(pane()).findByText(/The agent marks it seen only when you say so/)).toHaveTextContent(
      'Peek only: reading it here marks nothing seen. The agent marks it seen only when you say so.',
    );
    await userEvent.click(within(pane()).getByRole('button', { name: 'review with an agent ▾' }));
    const menu = within(pane()).getByRole('menu', { name: 'review with an agent' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['πpi tab', '✻Claude tab']);
    expect(tabs.create).not.toHaveBeenCalled();
    expect(composed).toEqual([]);
    await userEvent.click(within(menu).getByRole('menuitem', { name: kind === 'pi' ? /pi tab/ : /Claude tab/ }));
    await waitFor(() => expect(composed).toEqual([
      { text: reviewPrompt({ new: 3, changed: 1, closed: 2 }), chatId: 'n1', options: { focus: true, append: true } },
    ]));
    expect(tabs.create.mock.calls).toEqual([[kind, null]]);
    expect(allFolders.forTab('n1').get()).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(asked.shown).toEqual([]);
    expect(readReview).toHaveBeenCalledTimes(1);
    expect(asked).toMatchObject({ brief: 1, review: 1, open: 1, asked: 1, holds: 1 });
  });

  it('shows opening… until creation settles and excludes inbox actions while the review is pending', async () => {
    const { promise, resolve } = deferred<string>();
    const { open, pane, tabs, composed } = mount(undefined, DIGEST);
    tabs.create.mockReturnValueOnce(promise);
    await open('Digest');
    await userEvent.click(await within(pane()).findByRole('button', { name: 'review with an agent ▾' }));
    await userEvent.click(within(pane()).getByRole('menuitem', { name: /pi tab/ }));
    expect(within(pane()).getByRole('button', { name: 'opening…' })).toBeDisabled();
    expect(composed).toEqual([]);
    await open('Inbox');
    expect(within(pane()).getByRole('button', { name: 'take it' })).toBeDisabled();
    await open('Digest');
    expect(within(pane()).getByRole('button', { name: 'opening…' })).toBeDisabled();
    await act(() => { resolve('n1'); return promise; });
    expect(composed).toHaveLength(1);
    expect(tabs.create).toHaveBeenCalledTimes(1);
    expect(within(pane()).getByRole('button', { name: 'review with an agent ▾' })).toBeEnabled();
  });

  it('shows a failed review opening and clears the error on a successful retry', async () => {
    const { open, pane, tabs, composed, send } = mount(undefined, DIGEST);
    tabs.create.mockRejectedValueOnce(new Error('tab limit reached'));
    await open('Digest');
    await userEvent.click(await within(pane()).findByRole('button', { name: 'review with an agent ▾' }));
    await userEvent.click(within(pane()).getByRole('menuitem', { name: /Claude tab/ }));
    expect(await within(pane()).findByRole('alert')).toHaveTextContent('could not open review — tab limit reached');
    expect(composed).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    const { promise, resolve } = deferred<string>();
    tabs.create.mockReturnValueOnce(promise);
    await userEvent.click(within(pane()).getByRole('button', { name: 'review with an agent ▾' }));
    await userEvent.click(within(pane()).getByRole('menuitem', { name: /Claude tab/ }));
    expect(within(pane()).queryByRole('alert')).toBeNull();
    await act(() => { resolve('n1'); return promise; });
    expect(composed).toEqual([
      { text: reviewPrompt({ new: 3, changed: 1, closed: 2 }), chatId: 'n1', options: { focus: true, append: true } },
    ]);
    expect(within(pane()).getByRole('button', { name: 'review with an agent ▾' })).toBeEnabled();
    expect(send).not.toHaveBeenCalled();
  });

  it('offers no review action for an empty digest', async () => {
    const { open, pane } = mount();
    await open('Digest');
    expect(await within(pane()).findByText('Nothing new since the last review.')).toBeInTheDocument();
    expect(within(pane()).queryByRole('button', { name: /review with an agent/ })).toBeNull();
  });

  it('offers no review action while initially reading the digest', async () => {
    const { promise, resolve } = deferred<LeeboardReviewResult>();
    const { open, pane } = mount(undefined, promise);
    await open('Digest');
    expect(within(pane()).getByText('reading the digest…')).toBeInTheDocument();
    expect(within(pane()).queryByRole('button', { name: /review with an agent/ })).toBeNull();
    await act(() => { resolve(DIGEST); return promise; });
    expect(within(pane()).getByRole('button', { name: 'review with an agent ▾' })).toBeEnabled();
  });

  it('hides the review action during refresh even while old digest rows remain', async () => {
    const { open, pane, spine, readReview } = mount(undefined, DIGEST);
    await open('Digest');
    expect(await within(pane()).findByRole('button', { name: 'review with an agent ▾' })).toBeEnabled();
    const { promise, resolve } = deferred<LeeboardReviewResult>();
    readReview.mockReturnValueOnce(promise);
    await userEvent.click(within(spine()).getByRole('button', { name: 'Refresh Leeboard' }));
    expect(within(pane()).getByText('A new rule')).toBeInTheDocument();
    expect(within(pane()).queryByRole('button', { name: /review with an agent/ })).toBeNull();
    await act(() => { resolve(DIGEST); return promise; });
    expect(within(pane()).getByRole('button', { name: 'review with an agent ▾' })).toBeEnabled();
  });

  it('offers no review action when the digest cannot be read', async () => {
    const { open, pane } = mount(undefined, {
      review: null, error: { code: 'leeboard_failed', message: 'lb review exited 1: store is locked' },
    });
    await open('Digest');
    expect(await within(pane()).findByText(/could not read Leeboard — lb review exited 1: store is locked/)).toBeInTheDocument();
    expect(within(pane()).queryByRole('button', { name: /review with an agent/ })).toBeNull();
  });

  it('says plainly when each list is empty, and names a folder with no project', async () => {
    const { open, pane } = mount([{ brief: brief({ project: null, unregisteredRepo: '/work/scratch' }) }]);
    await open('Inbox');
    expect(await within(pane()).findByText('Inbox empty — no handoffs or requests addressed here.')).toBeInTheDocument();
    expect(within(pane()).getByRole('banner')).toHaveTextContent('Global — no project');
    expect(within(pane()).getByText(/unregistered repo \/work\/scratch/)).toBeInTheDocument();
    await open('Holds');
    expect(within(pane()).getByText('No active holds.')).toBeInTheDocument();
    await open('Digest');
    expect(within(pane()).getByText('Nothing new since the last review.')).toBeInTheDocument();
  });
});

describe('LeeboardPanel: owner-wide holds', () => {
  const elsewhere = [
    entry('hold-alpha-1', 'Alpha newest', { scope: 'project:alpha', release: 'owner approves', blocks: ['merge'], until: '2099-11-15' }),
    entry('hold-machine-1', 'Machine wait', { scope: 'machine' }),
    entry('hold-alpha-2', 'Alpha older', { scope: 'project:alpha' }),
    entry('hold-global-1', 'Global wait', { scope: 'global' }),
    entry('hold-beta-1', 'Beta wait', { scope: 'project:beta' }),
  ];

  it('counts every hold, lists applicable IDs first, groups exact scopes and keeps metadata and attention versus dim borders', async () => {
    const here = { ...FULL.holds[0]!, scope: 'project:unrelated' };
    // Scope names cannot decide applicability: this looks local but is not in the brief.
    const localLooking = entry('hold-not-applicable-1', 'Not applicable', { scope: 'project:funkyoctopus' });
    const { open, pane, spine } = mount([{ brief: brief({ holds: [here] }) }], NO_REVIEW, undefined, undefined, undefined,
      { holds: [...elsewhere, here, localLooking] });
    const button = within(spine()).getByRole('button', { name: 'Holds' });
    await waitFor(() => expect(button.textContent).toBe('⊘7holds'));
    expect(button).toHaveAttribute('title', 'Holds — 1 applies here · 6 elsewhere · project funkyoctopus');
    expect(within(button).getByText('7')).toHaveClass('text-attention');
    await open('Holds');
    expect(within(pane()).getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Applies here 1', 'alpha 2', 'machine 1', 'global 1', 'beta 1', 'funkyoctopus 1',
    ]);
    const titles = within(pane()).getAllByRole('button').slice(1).map((b) => b.textContent);
    expect(titles[0]).toContain(here.title);
    const alpha = within(pane()).getByRole('heading', { name: 'alpha 2' }).closest('section')!;
    expect(within(alpha).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'HOLDAlpha newestrelease: owner approvesblocks merge · until 2099-11-15', 'HOLDAlpha older',
    ]);
    expect(within(pane()).getByRole('button', { name: /HOLDNo deploys/ })).toHaveClass('border-attention/60', 'hover:border-attention');
    expect(within(pane()).getByRole('button', { name: /HOLDNot applicable/ })).toHaveClass('border-border', 'hover:border-muted');
  });

  it('elsewhere-only holds have a nonzero nonyellow spine count and open their entry, with Back returning to Holds', async () => {
    const { open, pane, spine, asked } = mount([{ brief: brief() }], NO_REVIEW,
      (id) => ({ entry: { ...elsewhere[0]!, id, body: 'Wait for owner approval.' } }), undefined, undefined, { holds: elsewhere });
    const button = within(spine()).getByRole('button', { name: 'Holds' });
    await waitFor(() => expect(button.textContent).toBe('⊘5holds'));
    expect(button).toHaveAttribute('title', 'Holds — 0 apply here · 5 elsewhere · project funkyoctopus');
    expect(within(button).getByText('5')).not.toHaveClass('text-attention');
    await open('Holds');
    expect(within(pane()).queryByRole('heading', { name: /Applies here/ })).toBeNull();
    await userEvent.click(within(pane()).getByText('Alpha newest'));
    expect(await within(pane()).findByRole('article')).toHaveTextContent('Wait for owner approval.');
    expect(asked.shown).toEqual(['hold-alpha-1']);
    await userEvent.click(within(pane()).getByRole('button', { name: '← back' }));
    expect(within(pane()).getByRole('banner')).toHaveTextContent('HOLDS');
    expect(within(pane()).getByRole('heading', { name: 'alpha 2' })).toBeInTheDocument();
  });

  it('shows all-scope holds when the brief fails, retaining the error without inferring applicability', async () => {
    const localLooking = entry('hold-local-unknown-1', 'Local-looking hold', { scope: 'project:funkyoctopus' });
    const { open, pane, spine, asked } = mount([
      { brief: null, error: { code: 'leeboard_failed', message: 'lb brief exited 1: usage log is locked' } },
    ], undefined, (id) => ({ entry: { ...localLooking, id, body: 'Wait for approval.' } }), undefined, undefined,
    { holds: [localLooking, ...elsewhere] });
    const button = within(spine()).getByRole('button', { name: 'Holds' });
    await waitFor(() => expect(button.textContent).toBe('⊘6holds'));
    expect(button).toHaveAttribute('title', 'Holds — 6 active · applicability unknown without the brief');
    expect(within(button).getByText('6')).not.toHaveClass('text-attention');
    await open('Holds');
    expect(within(pane()).getByText(/could not read Leeboard — lb brief exited 1: usage log is locked/)).toHaveClass('text-danger');
    expect(within(pane()).getByText('Applicability to this tab is unknown without its brief.')).toBeInTheDocument();
    expect(within(pane()).queryByRole('heading', { name: /Applies here/ })).toBeNull();
    expect(within(pane()).getByRole('heading', { name: 'funkyoctopus 1' })).toBeInTheDocument();
    expect(within(pane()).getByRole('heading', { name: 'alpha 2' })).toBeInTheDocument();
    const cards = within(pane()).getAllByRole('button').slice(1);
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      expect(card).toHaveClass('border-border');
      expect(card).not.toHaveClass('border-attention/60');
    }
    await userEvent.click(within(pane()).getByText('Local-looking hold'));
    expect(await within(pane()).findByRole('article')).toHaveTextContent('Wait for approval.');
    expect(asked.shown).toEqual([localLooking.id]);
    await userEvent.click(within(pane()).getByRole('button', { name: '← back' }));
    expect(within(pane()).getByText('Local-looking hold')).toBeInTheDocument();
    expect(within(pane()).getByText(/usage log is locked/)).toBeInTheDocument();
  });

  it('a successful empty all-scope list is authoritative even when the brief has a hold', async () => {
    const { open, pane, spine } = mount(undefined, undefined, undefined, undefined, undefined, { holds: [] });
    await open('Holds');
    expect(await within(pane()).findByText('No active holds.')).toBeInTheDocument();
    expect(within(pane()).queryByText(FULL.holds[0]!.title)).toBeNull();
    expect(within(spine()).getByRole('button', { name: 'Holds' }).textContent).toBe('⊘0holds');
    expect(spine().querySelector('.text-attention')).toBeNull();
  });

  it.each([true, false])('a failed holds read falls back to the brief (has holds: %s) with exactly one danger line', async (hasHolds) => {
    const { open, pane } = mount([{ brief: hasHolds ? FULL : brief() }], undefined, undefined, undefined, undefined,
      { holds: null, error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' } });
    await open('Holds');
    const lines = await within(pane()).findAllByText(/^could not list active holds —/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('could not list active holds — Leeboard is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net');
    expect(lines[0]).toHaveClass('text-danger');
    expect(within(pane()).getByText(hasHolds ? FULL.holds[0]!.title : 'No active holds.')).toBeInTheDocument();
  });
});

describe('LeeboardPanel: faults', () => {
  it('a missing lb is one dim not-installed line with a link, and the spine says so quietly with the panel closed', async () => {
    const { open, pane, spine } = mount([{ brief: null, error: { code: 'leeboard_unavailable', message: 'lb was not found on PATH' } }]);
    expect(await within(spine()).findByText('no lb')).toHaveClass('text-muted');
    await open('Inbox');
    const line = within(pane()).getByRole('status');
    expect(line).toHaveTextContent(/^Leeboard is not installed — FunkyOctopus works without it\. Install: https:\/\/zsoltborsos\.net$/);
    expect(line).toHaveClass('text-muted');
    expect(within(line).getByRole('link', { name: 'https://zsoltborsos.net' })).toHaveAttribute('href', 'https://zsoltborsos.net');
    expect(pane().querySelector('.text-attention, .text-danger')).toBeNull();
    expect(within(spine()).getByRole('button', { name: 'Inbox' }).textContent).toBe('↧—inbox');
  });

  it('any other failure is a danger fault naming what lb said', async () => {
    const { open, pane } = mount([{ brief: null, error: { code: 'leeboard_failed', message: 'lb brief exited 1: store is locked' } }]);
    await open('Holds');
    const line = await within(pane()).findByText(/could not read Leeboard/);
    expect(line).toHaveTextContent('could not read Leeboard — lb brief exited 1: store is locked. chat is unaffected.');
    expect(line).toHaveClass('text-danger');
  });
});

describe('LeeboardPanel: reading an entry', () => {
  it('opens the body read-only, as markdown with raw HTML off, and goes back to the tab', async () => {
    const { open, pane, asked } = mount([{ brief: FULL }], NO_REVIEW, (id) => ({
      entry: { ...FULL.holds[0]!, id, body: 'Release when the tunnel closes.\n\nRun `lb check` first. <b>not bold</b>' },
    }));
    await open('Holds');
    await userEvent.click(await within(pane()).findByText('No deploys while the tunnel is open'));
    const article = await within(pane()).findByRole('article', { name: 'Leeboard entry' });
    expect(asked.shown).toEqual(['hold-no-deploys-ab12']);
    expect(article).toHaveTextContent('Release when the tunnel closes.');
    // Markdown renders as in chat; raw HTML in a body is dropped, never rendered.
    expect(within(article).getByText('lb check').tagName).toBe('CODE');
    expect(article.querySelector('b')).toBeNull();

    await userEvent.click(within(pane()).getByRole('button', { name: '← back' }));
    expect(within(pane()).getByText('release: the tunnel closes')).toBeInTheDocument();
  });

  it('an entry lb no longer knows says so', async () => {
    const { open, pane } = mount();
    await open('Inbox');
    await userEvent.click(await within(pane()).findByText('Take the L3 panel'));
    expect(await within(pane()).findByText(/no entry handoff-take-l3-ef56/)).toBeInTheDocument();
  });
});

describe('LeeboardPanel: when it asks', () => {
  it('asks once on mount, again on refresh, and again when the tab’s folder changes — never on its own', async () => {
    const { asked, spine, open, pane, folders } = mount([{ brief: FULL }, { brief: brief({ project: 'alpha' }) }]);
    await waitFor(() => expect(asked).toMatchObject({ brief: 1, review: 1, open: 1, asked: 1, holds: 1 }));

    await userEvent.click(within(spine()).getByRole('button', { name: 'Refresh Leeboard' }));
    await waitFor(() => expect(asked).toMatchObject({ brief: 2, review: 2, open: 2, asked: 2, holds: 2 }));
    await open('Inbox');
    expect(within(pane()).getByRole('banner')).toHaveTextContent('project alpha');

    act(() => folders.set({ id: '/work/alpha', name: 'alpha', path: '/work/alpha', envTier: 'normal' }));
    await waitFor(() => expect(asked).toMatchObject({ brief: 3, review: 3, open: 3, asked: 3, holds: 3 }));
  });

  it('never polls the five reads', async () => {
    vi.useFakeTimers();
    try {
      let mounted!: ReturnType<typeof mount>;
      await act(async () => {
        mounted = mount();
        await Promise.resolve();
      });
      const { asked } = mounted;
      expect(asked).toMatchObject({ brief: 1, review: 1, open: 1, asked: 1, holds: 1 });

      await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
      expect(asked).toMatchObject({ brief: 1, review: 1, open: 1, asked: 1, holds: 1 });
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('asks again when the sidecar confirms the tab’s session moved folder (a Claude tab re-roots late)', async () => {
    const { asked, moveSession } = mount();
    await waitFor(() => expect(asked).toMatchObject({ brief: 1, review: 1, open: 1, asked: 1, holds: 1 }));
    act(() => moveSession('/work/alpha', 's1'));
    await waitFor(() => expect(asked).toMatchObject({ brief: 2, review: 2, open: 2, asked: 2, holds: 2 }));
    // A new session in the same folder is a change, too.
    act(() => moveSession('/work/alpha', 's2'));
    await waitFor(() => expect(asked).toMatchObject({ brief: 3, review: 3, open: 3, asked: 3, holds: 3 }));
    act(() => moveSession('/work/alpha', 's2'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toMatchObject({ brief: 3, review: 3, open: 3, asked: 3, holds: 3 });
  });
});

const routedRow = (id: string, title: string, to: string, chatId: string | null, folder: string | null = null) => ({
  ...entry(id, title, { scope: 'global', to, harness: 'pi', session: '0199-asker' }),
  chatId,
  folder,
});

describe('LeeboardPanel: take it (T3 L5)', () => {
  it("puts the entry's prompt, unsent and focused, into this tab's composer", async () => {
    const { open, pane, composed, asked, send } = mount([{ brief: FULL }], NO_REVIEW, (id) => ({
      entry: { ...FULL.inbox[0]!, id, body: 'Build the panel.' },
    }));
    await open('Inbox');
    await userEvent.click(await within(pane()).findByRole('button', { name: 'take it' }));
    await waitFor(() => expect(composed).toHaveLength(1));
    expect(asked.shown).toEqual(['handoff-take-l3-ef56']);
    expect(composed[0]).toMatchObject({ chatId: 'main', options: { focus: true, append: true } });
    expect(composed[0]!.text).toContain('Leeboard handoff handoff-take-l3-ef56 from claude-code to project:funkyoctopus: Take the L3 panel');
    expect(composed[0]!.text).toContain('Build the panel.');
    expect(composed[0]!.text).toContain('lb ack handoff-take-l3-ef56');
    expect(send).not.toHaveBeenCalled();
  });

  it("a request's prompt asks for reply then close", async () => {
    const request = entry('request-review-it-aa11', 'Review it', { to: 'any', session: 's9' });
    const { open, pane, composed } = mount([{ brief: brief({ inbox: [request] }) }]);
    await open('Inbox');
    await userEvent.click(await within(pane()).findByRole('button', { name: 'take it' }));
    await waitFor(() => expect(composed).toHaveLength(1));
    expect(composed[0]!.text).toContain('from claude-code/s9');
    expect(composed[0]!.text).toContain('lb reply request-review-it-aa11 --body');
    expect(composed[0]!.text).toContain('lb close request-review-it-aa11');
  });

  it('goes to the open tab of another project, then prefills there', async () => {
    const routed = { open: [routedRow('request-fix-login-bb22', 'Fix the login', 'project:alpha', 'b', '/work/alpha')] };
    const { open, pane, composed, tabs } = mount([{ brief: FULL }], NO_REVIEW, undefined, routed);
    await open('Inbox');
    expect(await within(pane()).findByRole('heading', { name: 'Elsewhere 1' })).toBeInTheDocument();
    await userEvent.click(within(pane()).getByRole('button', { name: 'go to alpha tab' }));
    await waitFor(() => expect(composed).toHaveLength(1));
    expect(tabs.activate).toHaveBeenCalledWith('b');
    expect(composed[0]).toMatchObject({ chatId: 'b', options: { focus: true, append: true } });
    expect(composed[0]!.text).toContain('request-fix-login-bb22 from pi/0199-asker to project:alpha');
  });

  it("opens a tab of the chosen engine in the project's folder, then prefills there", async () => {
    const routed = { open: [routedRow('request-fix-login-bb22', 'Fix the login', 'project:alpha', null, '/work/alpha')] };
    const { open, pane, composed, tabs, allFolders } = mount([{ brief: FULL }], NO_REVIEW, undefined, routed);
    await open('Inbox');
    await userEvent.click(await within(pane()).findByRole('button', { name: 'open a alpha tab ▾' }));
    await userEvent.click(within(pane()).getByRole('menuitem', { name: /Claude tab/ }));
    await waitFor(() => expect(composed).toHaveLength(1));
    expect(tabs.create).toHaveBeenCalledWith('claude-code', '/work/alpha', expect.any(Function));
    expect(allFolders.forTab('n1').get()).toMatchObject({ name: 'alpha', path: '/work/alpha' });
    expect(composed[0]).toMatchObject({ chatId: 'n1', options: { focus: true, append: true } });
  });

  it('routes session targets: this tab takes its own, another tab goes to it, an unheld one is not listed', async () => {
    const routed = {
      open: [
        routedRow('request-for-me-cc33', 'For this session', 'session:mine', 'main'),
        routedRow('request-for-them-dd44', 'For that session', 'session:theirs', 'c'),
        routedRow('request-for-nobody-ee55', 'For a terminal session', 'session:elsewhere', null),
        // This tab's own project is already in the brief's inbox.
        routedRow('handoff-take-l3-ef56', 'Take the L3 panel', 'project:funkyoctopus', 'main', '/work/fo'),
      ],
    };
    const { open, pane, spine, tabs, composed } = mount([{ brief: FULL }], NO_REVIEW, undefined, routed);
    await waitFor(() => expect(within(spine()).getByRole('button', { name: 'Inbox' }).textContent).toBe('↧2inbox'));
    await open('Inbox');
    const headings = within(pane()).getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['Addressed here 2', 'Elsewhere 1']);
    expect(within(pane()).getAllByRole('button', { name: 'take it' })).toHaveLength(2);
    expect(within(pane()).queryByText('For a terminal session')).toBeNull();
    await userEvent.click(within(pane()).getByRole('button', { name: 'go to its tab' }));
    await waitFor(() => expect(composed).toHaveLength(1));
    expect(tabs.activate).toHaveBeenCalledWith('c');
  });

  it('a tab that closed meanwhile says so and prefills nothing', async () => {
    const routed = { open: [routedRow('request-fix-login-bb22', 'Fix the login', 'project:alpha', 'gone', '/work/alpha')] };
    const { open, pane, composed } = mount([{ brief: FULL }], NO_REVIEW, undefined, routed);
    await open('Inbox');
    await userEvent.click(await within(pane()).findByRole('button', { name: 'go to alpha tab' }));
    expect(await within(pane()).findByRole('alert')).toHaveTextContent('could not take it — that tab is no longer open');
    expect(composed).toEqual([]);
  });
});

describe('LeeboardPanel: asked from this tab (T3 L5)', () => {
  it('lists this tab\'s requests; a reply reads as replied and marks the spine quietly', async () => {
    const mine = {
      asked: [
        { ...entry('request-fix-login-bb22', 'Fix the login', { to: 'project:alpha' }), replied: true },
        { ...entry('request-ship-gamma-cc33', 'Ship the gamma', { to: 'project:gamma' }), replied: false },
      ],
    };
    const { open, pane, spine } = mount([{ brief: brief() }], NO_REVIEW, undefined, { open: [] }, mine);
    const inbox = () => within(spine()).getByRole('button', { name: 'Inbox' });
    await waitFor(() => expect(inbox().textContent).toBe('↧0 ↩inbox'));
    // Bright, never the holds' attention.
    expect(within(inbox()).getByText('0')).toHaveClass('text-text');
    expect(spine().querySelector('.text-attention')).toBeNull();
    await open('Inbox');
    expect(within(pane()).getByRole('heading', { name: 'Asked from this tab 2' })).toBeInTheDocument();
    expect(within(pane()).getByText('→ project:alpha · open it to read the reply')).toBeInTheDocument();
    expect(within(pane()).getByText('→ project:gamma · waiting')).toBeInTheDocument();
    expect(within(pane()).getByText('replied')).toHaveClass('text-accent');
  });

  it('a request this tab asked is listed once, under Asked, with its routing there while it is open', async () => {
    const asking = routedRow('request-fix-login-bb22', 'Fix the login', 'project:alpha', null, '/work/alpha');
    const { open, pane } = mount([{ brief: brief() }], NO_REVIEW, undefined, { open: [asking] }, { asked: [{ ...asking, replied: false }] });
    await open('Inbox');
    expect(await within(pane()).findByRole('heading', { name: 'Asked from this tab 1' })).toBeInTheDocument();
    expect(within(pane()).queryByRole('heading', { name: /Elsewhere/ })).toBeNull();
    expect(within(pane()).getAllByText('Fix the login')).toHaveLength(1);
    expect(within(pane()).getByRole('button', { name: /open a alpha tab/ })).toBeInTheDocument();
  });

  it('a replied request offers no routing', async () => {
    const asking = routedRow('request-fix-login-bb22', 'Fix the login', 'project:alpha', null, '/work/alpha');
    const { open, pane } = mount([{ brief: brief() }], NO_REVIEW, undefined, { open: [asking] }, { asked: [{ ...asking, replied: true }] });
    await open('Inbox');
    expect(await within(pane()).findByText('replied')).toBeInTheDocument();
    expect(within(pane()).queryByRole('button', { name: /open a alpha tab/ })).toBeNull();
  });

  it('nothing asked, no section and no marker', async () => {
    const { open, pane, spine } = mount([{ brief: brief() }]);
    await waitFor(() => expect(within(spine()).getByRole('button', { name: 'Inbox' }).textContent).toBe('↧0inbox'));
    await open('Inbox');
    expect(within(pane()).queryByRole('heading', { name: /Asked/ })).toBeNull();
  });
});

describe('LeeboardPanel: re-reads when a turn ends (T3 L5)', () => {
  it('asks everything again when any tab finishes a turn, not on crew news', async () => {
    const { asked, emit } = mount();
    await waitFor(() => expect(asked).toMatchObject({ brief: 1, review: 1, open: 1, asked: 1, holds: 1 }));
    act(() => emit({ kind: 'turn-ended', at: 1 }));
    await waitFor(() => expect(asked).toMatchObject({ brief: 2, review: 2, open: 2, asked: 2, holds: 2 }));
    act(() => emit({ kind: 'crew', at: 2, status: 'completed', agentName: 'scout' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toMatchObject({ brief: 2, review: 2, open: 2, asked: 2, holds: 2 });
  });
});
