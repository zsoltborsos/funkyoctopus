import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChatChunk, ChatSessionInfo, ProjectCatalog } from '@shared/transport/protocol.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { TRANSPORT } from '@core/transport/transport-client.ts';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { CHAT_ORCHESTRATOR, ChatOrchestrator } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION, ChatSession } from '@features/chat/chat-session.service.ts';
import { CHAT_SESSIONS, ReviewNavigation } from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDER, TAB_FOLDERS, TabFolders } from '@features/chat/tab-folders.ts';
import { TAB_MODEL, TabModels } from '@features/chat/tab-models.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import { scoutSettingsFixture } from './scout-settings.fixture.ts';
import { WORKFLOW } from './workflow.client.ts';
import { HELMRAISER_MONITOR } from './helmraiser-monitor.service.ts';
import { CHAT_TO_HELMRAISER_INSTRUCTION, JobsPanel } from './JobsPanel.tsx';
import { makeHelmraiserStatus } from './__fixtures__/helmraiser-status.ts';
import { makeHelmraiserReport } from './__fixtures__/helmraiser-report.ts';
import { makeHelmraiserStats } from './__fixtures__/helmraiser-stats.ts';

const PROJECT_A = { id: '/work/a', name: 'alpha', path: '/work/a', envTier: 'normal' as const };
const PROJECT_B = { id: '/work/b', name: 'beta', path: '/work/b', envTier: 'normal' as const };
const BODY = '## Goal\n\nBuild it.\n\n## Change\n\nAdd the path.';
const REPLY = `\`\`\`helmraiser-task\ntitle: Generated task\n${BODY}\n\`\`\``;

type Stream = {
  method: string;
  params: Record<string, unknown>;
  handlers: { onChunk: (chunk: unknown) => void; onEnd: (error?: { message: string; code?: string }) => void };
  cancelled: boolean;
};

class FakeTransport {
  readonly streams: Stream[] = [];

  constructor(
    private readonly sessionInfo: ChatSessionInfo,
    private readonly catalog: ProjectCatalog,
  ) {}

  getState = () => 'open';
  subscribe = () => () => undefined;

  call(method: string): Promise<unknown> {
    const results: Record<string, unknown> = {
      'projects.discover': this.catalog,
      'chat.list': [this.sessionInfo],
      'chat.current': this.sessionInfo,
      'chat.transcript': [],
      'vault.resolve': true,
    };
    return Promise.resolve(results[method] ?? null);
  }

  stream(method: string, params: unknown, handlers: Stream['handlers']): () => void {
    const row: Stream = { method, params: params as Record<string, unknown>, handlers, cancelled: false };
    this.streams.push(row);
    return () => { row.cancelled = true; };
  }

  sendStream(): Stream {
    const stream = this.streams.findLast((row) => row.method === 'chat.send');
    if (!stream) throw new Error('chat.send stream not found');
    return stream;
  }
}

async function setup(
  cwd = PROJECT_B.path,
  known = [PROJECT_A, PROJECT_B],
  session: Pick<ChatSessionInfo, 'path' | 'engine' | 'id'> = { path: '/tmp/chat.jsonl', engine: 'pi', id: 'chat-1' },
) {
  const sessionInfo: ChatSessionInfo = {
    ...session, cwd, title: 'Shared conversation',
    created: new Date(0).toISOString(), modified: new Date(0).toISOString(),
  };
  const transport = new FakeTransport(sessionInfo, { globalRoot: '/work', known, folders: [] });
  const orchestrator = new ChatOrchestrator(transport as never);
  const chatSession = new ChatSession(orchestrator, transport, 'test-tab');
  await chatSession.refresh();

  const preferences = new PreferencesService(new MemoryStorageAdapter());
  const status = makeHelmraiserStatus();
  const monitorSnapshot = { status, loading: false, error: null, unavailable: false };
  const monitor = {
    getSnapshot: () => monitorSnapshot,
    subscribe: () => () => undefined,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  const workflow = {
    status: vi.fn(), drafts: vi.fn().mockResolvedValue([]), abort: vi.fn(), approve: vi.fn(), reject: vi.fn(),
    allDrafts: vi.fn().mockResolvedValue([]), scoutSettings: vi.fn().mockResolvedValue(scoutSettingsFixture()),
    startWorker: vi.fn(), stopWorker: vi.fn(), pause: vi.fn(), resume: vi.fn(), observe: vi.fn(),
    draft: vi.fn().mockResolvedValue({ path: '/work/b/.helmraiser/tasks/generated.md' }),
    dropDraft: vi.fn(), propose: vi.fn(), queue: vi.fn(),
    report: vi.fn().mockResolvedValue(makeHelmraiserReport()),
    stats: vi.fn().mockResolvedValue(makeHelmraiserStats()),
  };
  const container = new Container();
  container.registerInstance(TRANSPORT, transport as never);
  container.registerInstance(CHAT_ORCHESTRATOR, orchestrator);
  container.registerInstance(CHAT_SESSION, chatSession);
  container.registerInstance(CHAT_SESSIONS, { reviewNavigation: new ReviewNavigation(), reviewInOrigin: vi.fn(), create: vi.fn() } as never);
  container.registerInstance(TAB_FOLDER, new TabFolders(new MemoryStorageAdapter()).forTab('main'));
  container.registerInstance(TAB_FOLDERS, new TabFolders(new MemoryStorageAdapter()));
  container.registerInstance(PREFERENCES, preferences);
  const tabModel = new TabModels(new MemoryStorageAdapter()).forTab('main', () => 'pi');
  tabModel.selectModel({ provider: 'selected-provider', id: 'selected-model' });
  tabModel.selectEffort('high');
  container.registerInstance(TAB_MODEL, tabModel);
  container.registerInstance(HELMRAISER_MONITOR, monitor as never);
  container.registerInstance(WORKFLOW, workflow as never);
  render(
    <ContainerProvider container={container}>
      <ShellProvider><JobsPanel /></ShellProvider>
    </ContainerProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'NEW TASK' })).toBeEnabled());
  return { transport, chatSession, workflow };
}

async function openAndDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
  await user.click(screen.getByRole('button', { name: 'FROM CHAT' }));
}

function finish(stream: Stream, text = REPLY) {
  stream.handlers.onChunk({ kind: 'text', delta: text } satisfies ChatChunk);
  stream.handlers.onEnd();
}

describe('FROM CHAT Helmraiser task drafting', () => {
  it('uses the shared chat send path, selected route, and only the matching completed text reply', async () => {
    const user = userEvent.setup();
    const { transport, chatSession, workflow } = await setup();
    await openAndDraft(user);
    const stream = transport.sendStream();

    expect(stream.params).toMatchObject({
      text: CHAT_TO_HELMRAISER_INSTRUCTION,
      provider: 'selected-provider', model: 'selected-model', clientId: 'test-tab',
    });
    expect(stream.params).not.toHaveProperty('effort');
    expect(screen.getByRole('button', { name: 'DRAFTING…' })).toBeDisabled();
    expect(screen.getByLabelText('Title')).toHaveValue('');

    act(() => {
      stream.handlers.onChunk({
        kind: 'tool-call', callId: 'tool-1', tool: 'read', summary: 'read context', args: {},
      } satisfies ChatChunk);
      stream.handlers.onChunk({ kind: 'tool-result', callId: 'tool-1', ok: true, output: REPLY } satisfies ChatChunk);
      stream.handlers.onChunk({ kind: 'text', delta: REPLY } satisfies ChatChunk);
    });
    expect(screen.getByLabelText('Title')).toHaveValue('');
    act(() => stream.handlers.onEnd());

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Generated task'));
    expect(screen.getByLabelText('Goal')).toHaveValue(BODY);
    expect(chatSession.getSnapshot().messages.at(-2)).toMatchObject({
      role: 'user', steps: [{ kind: 'text', text: CHAT_TO_HELMRAISER_INSTRUCTION }],
    });
    expect(chatSession.getSnapshot().messages.at(-1)).toMatchObject({ role: 'assistant', streaming: false });
    expect(workflow.draft).not.toHaveBeenCalled();
    expect(workflow.propose).not.toHaveBeenCalled();
    expect(workflow.queue).not.toHaveBeenCalled();
  });

  it('queues a FROM CHAT draft with the current FO conversation origin', async () => {
    const user = userEvent.setup();
    const { transport, workflow } = await setup();
    workflow.propose.mockResolvedValue({
      task_id: 'beta:generated', id: 'generated', status: 'draft',
      path: '/work/b/.helmraiser/tasks/generated.md', proposal: {}, task: BODY, notes: [],
    });
    workflow.queue.mockResolvedValue({ status: 'queued' });
    await openAndDraft(user);
    act(() => finish(transport.sendStream()));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Generated task'));
    await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
    await user.click(await screen.findByRole('button', { name: 'QUEUE' }));
    await waitFor(() => expect(workflow.queue).toHaveBeenCalledWith(
      '/work/b/.helmraiser/tasks/generated.md',
      'fo:/tmp/chat.jsonl',
    ));
  });

  it('records a Claude Code chat as an FO origin whose session names its engine', async () => {
    const user = userEvent.setup();
    const id = '11111111-1111-4111-8111-111111111111';
    const { transport, workflow } = await setup(PROJECT_B.path, [PROJECT_A, PROJECT_B], {
      path: `claude-code:${id}`,
      engine: 'claude-code',
      id,
    });
    workflow.propose.mockResolvedValue({
      task_id: 'beta:generated', id: 'generated', status: 'draft',
      path: '/work/b/.helmraiser/tasks/generated.md', proposal: {}, task: BODY, notes: [],
    });
    workflow.queue.mockResolvedValue({ status: 'queued' });
    await openAndDraft(user);
    act(() => finish(transport.sendStream()));
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Generated task'));
    await user.click(screen.getByRole('button', { name: 'PROPOSE' }));
    await user.click(await screen.findByRole('button', { name: 'QUEUE' }));
    // Helmraiser splits `fo:<session>` at the first colon: kind fo, session `claude-code:<id>`,
    // which `sessionRefOf` reads back as {engine: claude-code, id}. Helmraiser's own
    // `claude-code` kind stays a terminal session.
    await waitFor(() => expect(workflow.queue).toHaveBeenCalledWith(
      '/work/b/.helmraiser/tasks/generated.md',
      `fo:claude-code:${id}`,
    ));
  });

  it('rejects a task block emitted before a tool call when the final reply has no block', async () => {
    const user = userEvent.setup();
    const { transport } = await setup();
    await openAndDraft(user);
    const stream = transport.sendStream();

    act(() => {
      stream.handlers.onChunk({ kind: 'text', delta: REPLY } satisfies ChatChunk);
      stream.handlers.onChunk({
        kind: 'tool-call', callId: 'tool-1', tool: 'read', summary: 'read context', args: {},
      } satisfies ChatChunk);
      stream.handlers.onChunk({ kind: 'tool-result', callId: 'tool-1', ok: true, output: 'context' } satisfies ChatChunk);
      stream.handlers.onChunk({ kind: 'text', delta: 'I could not draft the task.' } satisfies ChatChunk);
      stream.handlers.onEnd();
    });

    await screen.findByText('⚠ the agent did not return a task block');
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Goal')).toHaveValue('');
  });

  it('preserves existing fields and the transcript when the completed reply is invalid', async () => {
    const user = userEvent.setup();
    const { transport, chatSession } = await setup();
    await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
    await user.type(screen.getByLabelText('Title'), 'Owner title');
    await user.type(screen.getByLabelText('Goal'), 'Owner goal');
    await user.click(screen.getByRole('button', { name: 'FROM CHAT' }));
    act(() => finish(transport.sendStream(), 'No task block here.'));

    await screen.findByText('⚠ the agent did not return a task block');
    expect(screen.getByLabelText('Title')).toHaveValue('Owner title');
    expect(screen.getByLabelText('Goal')).toHaveValue('Owner goal');
    expect(chatSession.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant', steps: [{ kind: 'text', text: 'No task block here.' }],
    });
  });

  it('prevents duplicate drafting and releases the pending state after cancellation', async () => {
    const user = userEvent.setup();
    const { transport, chatSession } = await setup();
    await openAndDraft(user);
    expect(screen.getByRole('button', { name: 'DRAFTING…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'DRAFTING…' }));
    expect(transport.streams.filter((row) => row.method === 'chat.send')).toHaveLength(1);

    act(() => { chatSession.cancel(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'FROM CHAT' })).toBeEnabled());
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Goal')).toHaveValue('');
  });

  it('disables FROM CHAT with a reason while the shared chat is already mid-turn', async () => {
    const user = userEvent.setup();
    const { chatSession } = await setup();
    act(() => chatSession.send('ordinary composer turn', { provider: 'p', model: 'm' }));
    await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
    expect(screen.getByRole('button', { name: 'FROM CHAT' })).toBeDisabled();
    expect(screen.getByText('chat turn in progress')).toHaveClass('text-muted');
  });

  it('defaults to the known chat folder, stays editable, and falls back for an unknown folder', async () => {
    const user = userEvent.setup();
    await setup(PROJECT_B.path);
    await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(PROJECT_B.path);
    await user.selectOptions(screen.getByLabelText('Project'), PROJECT_A.path);
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(PROJECT_A.path);
  });

  it('keeps the existing first-project fallback when the chat folder is unknown', async () => {
    const user = userEvent.setup();
    await setup('/unknown');
    await user.click(screen.getByRole('button', { name: 'NEW TASK' }));
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(PROJECT_A.path);
  });
});
