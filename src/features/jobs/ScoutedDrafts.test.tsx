import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { HelmraiserScoutedDraft } from '@shared/transport/protocol.ts';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { useShell } from '@core/shell/useShell.ts';
import { CHAT_ORCHESTRATOR } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION } from '@features/chat/chat-session.service.ts';
import { CHAT_SESSIONS, ReviewNavigation, type ChatSessions } from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDERS, TabFolders } from '@features/chat/tab-folders.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { WORKFLOW } from './workflow.client.ts';
import { ScoutedDrafts } from './ScoutedDrafts.tsx';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';

const PATH_A = '/work/alpha/.helmraiser/tasks/cache.md';
const DISCUSS_PROMPT = `Help me refine this Helmraiser draft.\n\nProject: /work/alpha\nTitle: Cache expensive status reads\nTask file: ${PATH_A}\n\nRead the task file, help refine it, and queue it only when I am happy with it.`;
const draftsFixture = (): HelmraiserScoutedDraft[] => [
  {
    project: '/work/alpha', id: 'cache', task_id: 'alpha:cache', title: 'Cache expensive status reads',
    size: 'M', source: 'scout', age: 75, intake_status: 'ready', intake_error: null,
    proposal: null,
    preflight: { summary: 'verify passes', error: null, steps: [] },
    path: PATH_A,
    origin: { kind: 'fo', session: '/old/session.jsonl' },
  },
  {
    project: '/work/beta', id: 'broken', title: 'Repair flaky probe', size: 'S', source: 'scout',
    age: 90_061, intake_status: 'blocked', intake_error: 'intake could not classify risk', proposal: null,
    preflight: { summary: 'one check failed', error: 'npm test exited 1', steps: [] },
    path: '/work/beta/.helmraiser/tasks/broken.md',
  },
];

function ShellProbe() {
  const shell = useShell();
  return <><div aria-label="shell view">{shell.view}</div><div aria-label="chat draft">{shell.chatDraft}</div></>;
}

function setup(options: {
  mode?: 'unqueued';
  allDrafts?: ReturnType<typeof vi.fn>;
  drafts?: ReturnType<typeof vi.fn>;
  queue?: ReturnType<typeof vi.fn>;
  dropDraft?: ReturnType<typeof vi.fn>;
  currentChat?: ReturnType<typeof vi.fn>;
  create?: Mock<ChatSessions['create']>;
  onQueueSuccess?: Mock<() => Promise<void>>;
} = {}) {
  const drafts = options.drafts ?? vi.fn().mockResolvedValue(draftsFixture());
  const queue = options.queue ?? vi.fn().mockResolvedValue({ status: 'queued' });
  const dropDraft = options.dropDraft ?? vi.fn().mockResolvedValue({ status: 'dropped' });
  const currentChat = options.currentChat ?? vi.fn().mockResolvedValue({ path: '/sessions/current.jsonl' });
  // A discussion opens a new tab; it resolves with the tab shown (the probe's own here).
  const create = options.create ?? vi.fn<ChatSessions['create']>().mockResolvedValue('main');
  const onQueueSuccess = options.onQueueSuccess ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const allDrafts = options.allDrafts ?? vi.fn().mockResolvedValue([]);
  const workflow = { drafts, allDrafts, queue, dropDraft };
  const container = new Container();
  container.registerInstance(WORKFLOW, workflow as never);
  container.registerInstance(CHAT_ORCHESTRATOR, { currentChat } as never);
  const session = { send: vi.fn() };
  const tabs = { reviewNavigation: new ReviewNavigation(), create };
  container.registerInstance(CHAT_SESSIONS, tabs as never);
  const tabFolders = new TabFolders(new MemoryStorageAdapter());
  container.registerInstance(TAB_FOLDERS, tabFolders);
  container.registerInstance(CHAT_SESSION, session as never);
  const status = makeHelmraiserStatus();
  const rendered = render(
    <ContainerProvider container={container}>
      <ShellProvider>
        <ScoutedDrafts {...(options.mode ? { mode: options.mode } : {})} refreshToken={status} onQueueSuccess={onQueueSuccess} />
        <ShellProbe />
      </ShellProvider>
    </ContainerProvider>,
  );
  const remount = () => render(
    <ContainerProvider container={container}>
      <ShellProvider>
        <ScoutedDrafts refreshToken={status} onQueueSuccess={onQueueSuccess} />
        <ShellProbe />
      </ShellProvider>
    </ContainerProvider>,
  );
  return { ...rendered, remount, session, container, status, drafts, queue, dropDraft, currentChat, create, tabs, tabFolders, onQueueSuccess };
}

const row = (title: string): HTMLElement => screen.getByRole('article', { name: `Scouted draft: ${title}` });

// What each class means, as Helmraiser defines them (docs/reference.md "drafts drop").
const DROP_CLASSES = [
  ['wrong', 'the finding is not real'],
  ['unwanted', 'real, but not worth doing'],
  ['duplicate', 'already tracked, fixed, or the same as another draft'],
  ['unusable', 'real and wanted, but needs too much rework to queue'],
] as const;
/** The radio for a class: its label starts with the class name. */
const classRadio = (within_: HTMLElement, name: string): HTMLElement =>
  within(within_).getByRole('radio', { name: new RegExp(`^${name}\\b`) });

describe('ScoutedDrafts', () => {
  it('reads all drafts only for collapsed Unqueued, filtering strictly by kind and seconds', async () => {
    const allDrafts = vi.fn().mockResolvedValue([
      ...[599, 600, 601].map((age) => ({ ...draftsFixture()[0], title: `Manual ${age}`, kind: 'manual', age })),
      { ...draftsFixture()[1], kind: 'scout' }, draftsFixture()[1],
    ]);
    const { drafts, queue, dropDraft } = setup({ mode: 'unqueued', allDrafts });
    await screen.findByText('UNQUEUED DRAFTS (1)');
    const section = screen.getByLabelText('Unqueued drafts');
    expect(section).not.toHaveAttribute('open');
    expect(drafts).not.toHaveBeenCalled();
    fireEvent.click(within(section).getByText('UNQUEUED DRAFTS (1)'));
    expect(within(section).getAllByRole('article')).toHaveLength(1);
    const manual = screen.getByRole('article', { name: 'Unqueued draft: Manual 601' });
    expect(within(manual).queryByText('state')).not.toBeInTheDocument();
    fireEvent.click(within(manual).getByText('QUEUE'));
    fireEvent.click(within(manual).getByText('CONFIRM QUEUE'));
    await waitFor(() => expect(queue).toHaveBeenCalledWith(PATH_A, 'fo:/sessions/current.jsonl'));
    expect(dropDraft).not.toHaveBeenCalled();
  });

  it('shows explicit lenses and legacy state alongside project metadata', async () => {
    const drafts = ([undefined, 'state', 'docs', 'tests'] as const).map((lens, index) => ({
      ...draftsFixture()[0]!, id: `lens-${index}`, task_id: `alpha:lens-${index}`,
      title: `Lens ${index}`, lens,
    }));
    setup({ drafts: vi.fn().mockResolvedValue(drafts) });
    await screen.findByText('SCOUTED (4)');
    for (const draft of drafts) {
      expect(within(row(draft.title)).getByText(draft.lens ?? 'state')).toBeInTheDocument();
      expect(within(row(draft.title)).getByText(draft.project)).toBeInTheDocument();
    }
  });

  it('shows loading, then populated metadata, age, preflight and intake states', async () => {
    let release: (rows: HelmraiserScoutedDraft[]) => void = () => undefined;
    setup({ drafts: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    expect(screen.getByText('loading scouted drafts…')).toBeInTheDocument();
    release(draftsFixture());
    expect(await screen.findByText('SCOUTED (2)')).toBeInTheDocument();
    expect(screen.getByText('/work/alpha')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('1m ago')).toBeInTheDocument();
    expect(screen.getByText('1d ago')).toBeInTheDocument();
    expect(screen.getByText('verify passes')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('npm test exited 1')).toHaveClass('text-danger');
    expect(screen.getByText('intake could not classify risk')).toHaveClass('text-danger');
  });

  it('renders the exact empty state', async () => {
    setup({ drafts: vi.fn().mockResolvedValue([]) });
    expect(await screen.findByText('No drafts — run a scout')).toBeInTheDocument();
  });

  it('renders a list failure as an alert rather than empty', async () => {
    setup({ drafts: vi.fn().mockRejectedValue(new Error('draft ledger unavailable')) });
    expect(await screen.findByRole('alert')).toHaveTextContent('draft ledger unavailable');
    expect(screen.queryByText('No drafts — run a scout')).not.toBeInTheDocument();
  });

  it('reloads when the status refresh token changes identity', async () => {
    const { rerender, container, drafts, onQueueSuccess } = setup();
    await screen.findByText('SCOUTED (2)');
    rerender(
      <ContainerProvider container={container}>
        <ShellProvider>
          <ScoutedDrafts refreshToken={makeHelmraiserStatus()} onQueueSuccess={onQueueSuccess} />
        </ShellProvider>
      </ContainerProvider>,
    );
    await waitFor(() => expect(drafts).toHaveBeenCalledTimes(2));
  });

  it('does not let an older draft response overwrite a newer refresh', async () => {
    let releaseOld: (rows: HelmraiserScoutedDraft[]) => void = () => undefined;
    const drafts = vi.fn()
      .mockImplementationOnce(() => new Promise<HelmraiserScoutedDraft[]>((resolve) => { releaseOld = resolve; }))
      .mockResolvedValueOnce([]);
    const { rerender, container, onQueueSuccess } = setup({ drafts });
    rerender(
      <ContainerProvider container={container}>
        <ShellProvider>
          <ScoutedDrafts refreshToken={makeHelmraiserStatus()} onQueueSuccess={onQueueSuccess} />
        </ShellProvider>
      </ContainerProvider>,
    );
    expect(await screen.findByText('No drafts — run a scout')).toBeInTheDocument();
    await act(async () => {
      releaseOld(draftsFixture());
      await Promise.resolve();
    });
    expect(screen.queryByText('Cache expensive status reads')).not.toBeInTheDocument();
  });

  it('keeps a pathless compatible row visible and disables path actions', async () => {
    const pathless = { ...draftsFixture()[0]!, path: undefined };
    setup({ drafts: vi.fn().mockResolvedValue([pathless]) });
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    expect(within(draftRow).getByText(/task path unavailable/)).toBeInTheDocument();
    expect(within(draftRow).getByRole('button', { name: 'QUEUE' })).toBeDisabled();
    expect(within(draftRow).getByRole('button', { name: 'DISCUSS' })).toBeDisabled();
    expect(within(draftRow).getByRole('button', { name: 'DROP' })).toBeEnabled();
  });

  it('requires Queue confirmation, supports cancellation, and sends current FO origin', async () => {
    const user = userEvent.setup();
    const { queue, currentChat } = setup();
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'QUEUE' }));
    expect(queue).not.toHaveBeenCalled();
    await user.click(within(draftRow).getByRole('button', { name: 'CANCEL' }));
    expect(queue).not.toHaveBeenCalled();
    await user.click(within(draftRow).getByRole('button', { name: 'QUEUE' }));
    await user.click(within(draftRow).getByRole('button', { name: 'CONFIRM QUEUE' }));
    await waitFor(() => expect(queue).toHaveBeenCalledWith(PATH_A, 'fo:/sessions/current.jsonl'));
    expect(currentChat).toHaveBeenCalledOnce();
  });

  it('omits queue origin when current chat is null', async () => {
    const user = userEvent.setup();
    const queue = vi.fn().mockRejectedValue(new Error('keep row'));
    setup({ queue, currentChat: vi.fn().mockResolvedValue(null) });
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'QUEUE' }));
    await user.click(within(draftRow).getByRole('button', { name: 'CONFIRM QUEUE' }));
    await waitFor(() => expect(queue).toHaveBeenCalledWith(PATH_A, undefined));
  });

  it.each([
    ['origin lookup', vi.fn().mockRejectedValue(new Error('chat lookup failed')), vi.fn()],
    ['queue', vi.fn().mockResolvedValue({ path: '/sessions/current.jsonl' }), vi.fn().mockRejectedValue(new Error('queue failed'))],
  ])('retains the row on %s failure', async (_name, currentChat, queue) => {
    const user = userEvent.setup();
    setup({ currentChat, queue });
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'QUEUE' }));
    await user.click(within(draftRow).getByRole('button', { name: 'CONFIRM QUEUE' }));
    expect(await within(draftRow).findByRole('alert')).toBeInTheDocument();
    expect(row('Cache expensive status reads')).toBeInTheDocument();
  });

  it('removes only a successfully queued row and refreshes status', async () => {
    const user = userEvent.setup();
    const { onQueueSuccess } = setup();
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'QUEUE' }));
    await user.click(within(draftRow).getByRole('button', { name: 'CONFIRM QUEUE' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /Cache expensive/ })).not.toBeInTheDocument());
    expect(row('Repair flaky probe')).toBeInTheDocument();
    expect(onQueueSuccess).toHaveBeenCalledOnce();
  });

  it('requires a nonblank Drop reason, trims it, and removes only success', async () => {
    const user = userEvent.setup();
    const { dropDraft } = setup();
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'DROP' }));
    await user.click(classRadio(draftRow, 'duplicate'));
    const confirm = within(draftRow).getByRole('button', { name: 'CONFIRM DROP' });
    expect(confirm).toBeDisabled();
    await user.type(within(draftRow).getByLabelText('Drop reason'), '   ');
    expect(confirm).toBeDisabled();
    await user.type(within(draftRow).getByLabelText('Drop reason'), 'duplicate idea  ');
    await user.click(confirm);
    await waitFor(() => expect(dropDraft).toHaveBeenCalledWith('alpha:cache', 'duplicate idea', 'duplicate'));
    expect(screen.queryByRole('article', { name: /Cache expensive/ })).not.toBeInTheDocument();
    expect(row('Repair flaky probe')).toBeInTheDocument();
  });

  it('cancels Drop without calling and retains a failed Drop row', async () => {
    const user = userEvent.setup();
    const dropDraft = vi.fn().mockRejectedValue(new Error('drop refused'));
    setup({ dropDraft });
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'DROP' }));
    await user.click(within(draftRow).getByRole('button', { name: 'CANCEL' }));
    expect(dropDraft).not.toHaveBeenCalled();
    await user.click(within(draftRow).getByRole('button', { name: 'DROP' }));
    await user.click(classRadio(draftRow, 'unwanted'));
    await user.type(within(draftRow).getByLabelText('Drop reason'), 'obsolete');
    await user.click(within(draftRow).getByRole('button', { name: 'CONFIRM DROP' }));
    expect(await within(draftRow).findByRole('alert')).toHaveTextContent('drop refused');
    expect(row('Cache expensive status reads')).toBeInTheDocument();
  });

  it('asks why in a radio group of the four classes, none chosen, each with a dim description', async () => {
    const user = userEvent.setup();
    setup();
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    expect(within(draftRow).queryByRole('radiogroup')).not.toBeInTheDocument();
    await user.click(within(draftRow).getByRole('button', { name: 'DROP' }));
    const group = within(draftRow).getByRole('radiogroup', { name: 'Why drop it?' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(DROP_CLASSES.map(([name]) => name));
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    for (const [name, description] of DROP_CLASSES) {
      const label = classRadio(draftRow, name).closest('label')!;
      expect(label).toHaveTextContent(`${name} ${description}`);
      expect(within(label).getByText(description)).toHaveClass('text-muted');
    }
  });

  it('keeps CONFIRM DROP disabled until a class is chosen and the reason is nonblank, and sends the class', async () => {
    const user = userEvent.setup();
    const { dropDraft } = setup();
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'DROP' }));
    const confirm = within(draftRow).getByRole('button', { name: 'CONFIRM DROP' });
    await user.type(within(draftRow).getByLabelText('Drop reason'), 'looks like noise');
    expect(confirm).toBeDisabled();
    await user.click(classRadio(draftRow, 'wrong'));
    expect(classRadio(draftRow, 'wrong')).toBeChecked();
    expect(confirm).toBeEnabled();
    await user.click(classRadio(draftRow, 'unusable'));
    expect(classRadio(draftRow, 'wrong')).not.toBeChecked();
    expect(classRadio(draftRow, 'unusable')).toBeChecked();
    await user.clear(within(draftRow).getByLabelText('Drop reason'));
    expect(confirm).toBeDisabled();
    await user.type(within(draftRow).getByLabelText('Drop reason'), 'needs a rewrite');
    await user.click(confirm);
    await waitFor(() => expect(dropDraft).toHaveBeenCalledExactlyOnceWith('alpha:cache', 'needs a rewrite', 'unusable'));
  });

  it('keeps each row’s class apart from the next row’s', async () => {
    const user = userEvent.setup();
    setup();
    const first = await screen.findByRole('article', { name: /Cache expensive/ });
    const second = row('Repair flaky probe');
    await user.click(within(first).getByRole('button', { name: 'DROP' }));
    await user.click(within(second).getByRole('button', { name: 'DROP' }));
    await user.click(classRadio(first, 'wrong'));
    await user.click(classRadio(second, 'duplicate'));
    expect(classRadio(first, 'wrong')).toBeChecked();
    expect(classRadio(first, 'duplicate')).not.toBeChecked();
    expect(classRadio(second, 'duplicate')).toBeChecked();
    expect(classRadio(second, 'wrong')).not.toBeChecked();
  });

  it('CANCEL resets the class with the reason, so a second Drop starts empty', async () => {
    const user = userEvent.setup();
    const { dropDraft } = setup();
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'DROP' }));
    await user.click(classRadio(draftRow, 'duplicate'));
    await user.type(within(draftRow).getByLabelText('Drop reason'), 'same as another');
    await user.click(within(draftRow).getByRole('button', { name: 'CANCEL' }));
    await user.click(within(draftRow).getByRole('button', { name: 'DROP' }));
    expect(within(draftRow).getByLabelText('Drop reason')).toHaveValue('');
    expect(within(draftRow).getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    await user.type(within(draftRow).getByLabelText('Drop reason'), 'a fresh reason');
    expect(within(draftRow).getByRole('button', { name: 'CONFIRM DROP' })).toBeDisabled();
    expect(dropDraft).not.toHaveBeenCalled();
  });

  it('asks the same question of an Unqueued draft and sends the class', async () => {
    const user = userEvent.setup();
    const allDrafts = vi.fn().mockResolvedValue([{ ...draftsFixture()[0], title: 'Old manual draft', kind: 'manual', age: 900 }]);
    const { dropDraft } = setup({ mode: 'unqueued', allDrafts });
    await screen.findByText('UNQUEUED DRAFTS (1)');
    await user.click(screen.getByText('UNQUEUED DRAFTS (1)'));
    const manual = screen.getByRole('article', { name: 'Unqueued draft: Old manual draft' });
    await user.click(within(manual).getByRole('button', { name: 'DROP' }));
    expect(within(manual).getByRole('radiogroup', { name: 'Why drop it?' })).toBeInTheDocument();
    expect(within(manual).getAllByRole('radio')).toHaveLength(4);
    await user.type(within(manual).getByLabelText('Drop reason'), 'already done');
    expect(within(manual).getByRole('button', { name: 'CONFIRM DROP' })).toBeDisabled();
    await user.click(classRadio(manual, 'duplicate'));
    await user.click(within(manual).getByRole('button', { name: 'CONFIRM DROP' }));
    await waitFor(() => expect(dropDraft).toHaveBeenCalledExactlyOnceWith('alpha:cache', 'already done', 'duplicate'));
  });

  it('Discuss opens a new pi tab in the draft’s project, never the shown tab, and fills the exact unsent prompt', async () => {
    const user = userEvent.setup();
    const { create, tabFolders } = setup();
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'DISCUSS' }));
    await waitFor(() => expect(screen.getByLabelText('shell view')).toHaveTextContent('chat'));
    expect(create).toHaveBeenCalledExactlyOnceWith('pi', '/work/alpha', expect.any(Function));
    // The new tab keeps the project as its own folder.
    (create.mock.calls[0]?.[2] as (chatId: string) => void)('n1');
    expect(tabFolders.forTab('n1').get()?.path).toBe('/work/alpha');
    expect(screen.getByLabelText('chat draft')).toHaveTextContent(DISCUSS_PROMPT, { normalizeWhitespace: false });
  });

  it('rejects same-batch and pending discussions while the new tab opens, without queueing navigation', async () => {
    const s = setup();
    await screen.findByText('SCOUTED (2)');
    let release = () => {};
    const method = s.create;
    method.mockImplementationOnce(() => new Promise<string>((resolve) => { release = () => resolve('main'); }));
    const first = within(row('Cache expensive status reads')).getByRole('button', { name: 'DISCUSS' });
    const second = within(row('Repair flaky probe')).getByRole('button', { name: 'DISCUSS' });
    act(() => { fireEvent.click(first); fireEvent.click(second); fireEvent.click(first); });
    await waitFor(() => expect(method).toHaveBeenCalledOnce());
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    expect(screen.getByLabelText('chat draft').textContent).toBe('');
    fireEvent.click(second);
    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByLabelText('chat draft').textContent).toBe(DISCUSS_PROMPT));
    expect(s.create).toHaveBeenCalledExactlyOnceWith('pi', '/work/alpha', expect.any(Function));
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    expect(s.session.send).not.toHaveBeenCalled();
    expect(s.queue).not.toHaveBeenCalled();
    expect(s.dropDraft).not.toHaveBeenCalled();
    // A rejected click never runs later; a new explicit click does.
    fireEvent.click(second);
    await waitFor(() => expect(s.create).toHaveBeenCalledTimes(2));
    expect(s.create).toHaveBeenLastCalledWith('pi', '/work/beta', expect.any(Function));
    expect(screen.getByLabelText('chat draft')).toHaveTextContent('Title: Repair flaky probe');
  });

  it.each(['success', 'failure'])('holds the discussion lock across unmount/remount while the tab opens, and releases after %s', async (outcome) => {
    const s = setup();
    await screen.findByText('SCOUTED (2)');
    let settle = () => {};
    const method = s.create;
    method.mockImplementationOnce(() => new Promise<string>((resolve, reject) => {
      settle = () => outcome === 'success' ? resolve('main') : reject(new Error('tab refused'));
    }));
    fireEvent.click(within(row('Cache expensive status reads')).getByRole('button', { name: 'DISCUSS' }));
    await waitFor(() => expect(method).toHaveBeenCalledOnce());
    s.unmount();
    s.remount();
    await screen.findByText('SCOUTED (2)');
    const second = within(row('Repair flaky probe')).getByRole('button', { name: 'DISCUSS' });
    expect(second).toBeDisabled();
    fireEvent.click(second);
    expect(s.create).toHaveBeenCalledOnce();
    await act(async () => { settle(); await Promise.resolve(); });
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    expect(second).toBeEnabled();
    expect(screen.getByLabelText('chat draft').textContent).toBe('');
    fireEvent.click(second);
    await waitFor(() => expect(screen.getByLabelText('chat draft')).toHaveTextContent('Title: Repair flaky probe'));
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(s.session.send).not.toHaveBeenCalled();
    expect(s.queue).not.toHaveBeenCalled();
  });

  it('keeps the composer draft intact and releases after the new tab is refused', async () => {
    const s = setup();
    await screen.findByText('SCOUTED (2)');
    fireEvent.click(within(row('Cache expensive status reads')).getByRole('button', { name: 'DISCUSS' }));
    await waitFor(() => expect(screen.getByLabelText('chat draft').textContent).toBe(DISCUSS_PROMPT));
    s.create.mockRejectedValueOnce(new Error('at most 8 chats can be open at once — close one first'));
    fireEvent.click(within(row('Repair flaky probe')).getByRole('button', { name: 'DISCUSS' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 8 chats can be open at once');
    expect(screen.getByLabelText('chat draft').textContent).toBe(DISCUSS_PROMPT);
    expect(s.tabs.reviewNavigation.isPending()).toBe(false);
    expect(within(row('Cache expensive status reads')).getByRole('button', { name: 'DISCUSS' })).toBeEnabled();
    expect(s.session.send).not.toHaveBeenCalled();
    expect(s.queue).not.toHaveBeenCalled();
  });

  it('retains a row-local error when Discuss cannot open its tab', async () => {
    const user = userEvent.setup();
    setup({ create: vi.fn().mockRejectedValue(new Error('root denied')) });
    const draftRow = await screen.findByRole('article', { name: /Cache expensive/ });
    await user.click(within(draftRow).getByRole('button', { name: 'DISCUSS' }));
    expect(await within(draftRow).findByRole('alert')).toHaveTextContent('root denied');
    expect(screen.getByLabelText('shell view')).toHaveTextContent('chat');
  });
});
