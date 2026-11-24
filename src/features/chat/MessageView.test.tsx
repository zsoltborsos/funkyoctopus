import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelOption } from '@shared/transport/protocol.ts';
import type { ChatMessage, ChatStep } from './chat.types.ts';
import { projectCrewAudits } from './crew-audit.ts';
import { MessageView } from './MessageView.tsx';

const NO_CREW = projectCrewAudits([]);

function message(role: 'user' | 'assistant', steps: ChatStep[], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role, steps, createdAt: Date.UTC(2026, 7, 19, 12, 0, 0), ...extra };
}

const CLAUDE_MODELS: ModelOption[] = [
  {
    provider: 'claude-code',
    id: 'haiku',
    name: 'Haiku 5.5',
    resolvedId: 'claude-haiku-5-5',
    thinkingLevels: [],
    input: ['text', 'image'],
  },
];

function renderMessage(
  msg: ChatMessage,
  agentName = 'pi',
  models: ModelOption[] = [],
  currentModel: string | null = 'deepseek-v4-flash',
) {
  const view = (
    <MessageView
      message={msg}
      showTimestamp={false}
      toolStepsDefaultOpen={false}
      models={models}
      agentName={agentName}
      currentModel={currentModel}
      onResolveApproval={vi.fn()}
      crewState={NO_CREW}
    />
  );
  const utils = render(view);
  return { ...utils, rerenderWith: (next: ChatMessage) => utils.rerender(
    <MessageView
      message={next}
      showTimestamp={false}
      toolStepsDefaultOpen={false}
      models={models}
      agentName={agentName}
      currentModel={currentModel}
      onResolveApproval={vi.fn()}
      crewState={NO_CREW}
    />,
  ) };
}

const pi = () => screen.getByRole('article', { name: 'Message from pi' });

describe('MessageView compaction', () => {
  it('shows a compaction as one dim divider with the sizes, between the text around it', () => {
    renderMessage(
      message('assistant', [
        { kind: 'text', text: 'Compacting now.' },
        { kind: 'compaction', trigger: 'manual', preTokens: 33213, postTokens: 3081 },
        { kind: 'text', text: 'All done.' },
      ], { model: 'haiku' }),
      'Claude',
    );

    const divider = screen.getByRole('separator', { name: 'context compacted · 33k → 3k tokens' });
    expect(divider).toHaveTextContent('⋯ context compacted · 33k → 3k tokens');
    const article = screen.getByRole('article', { name: 'Message from Claude' });
    expect(article.textContent).toMatch(/Compacting now\..*context compacted.*All done\./su);
  });

  it('shows a reopened transcript\'s compaction without sizes it does not have', () => {
    renderMessage(message('assistant', [{ kind: 'compaction' }]), 'Claude');

    expect(screen.getByRole('separator', { name: 'context compacted' })).toBeInTheDocument();
  });

  it('shows a message that holds nothing but a compaction as the divider alone, with no assistant header above it', () => {
    const { container } = renderMessage(
      message('assistant', [{ kind: 'compaction', trigger: 'manual', preTokens: 33213, postTokens: 3081 }], { model: 'haiku' }),
      'Claude',
    );

    expect(screen.getByRole('separator', { name: 'context compacted · 33k → 3k tokens' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    expect(container.textContent).not.toContain('CLAUDE CODE');
  });

  it('keeps the header while the turn that compacts is still streaming, since an answer may follow', () => {
    renderMessage(
      message('assistant', [{ kind: 'compaction', trigger: 'manual', preTokens: 33213 }], { streaming: true }),
      'Claude',
    );

    expect(screen.getByRole('article', { name: 'Message from Claude' })).toBeInTheDocument();
  });
});

describe('MessageView agent', () => {
  it('names pi as the speaker by default', () => {
    renderMessage(message('assistant', [{ kind: 'text', text: 'hi' }], { model: 'glm-5.2' }));

    expect(screen.getByRole('article', { name: 'Message from pi' })).toHaveTextContent('PI · GLM-5.2');
  });

  it('names no model for a turn that recorded none when the live session has none either', () => {
    renderMessage(message('assistant', [{ kind: 'text', text: 'hi' }]), 'pi', [], null);

    const header = screen.getByRole('article', { name: 'Message from pi' }).querySelector('span.tracking-widest');
    expect(header?.textContent).toBe('PI');
  });

  it('names Claude as the speaker when it is the engine', () => {
    renderMessage(message('assistant', [{ kind: 'text', text: 'hi' }], { model: 'haiku' }), 'Claude');

    expect(screen.getByRole('article', { name: 'Message from Claude' })).toHaveTextContent('CLAUDE · HAIKU');
    expect(screen.queryByRole('article', { name: 'Message from pi' })).toBeNull();
  });

  it('labels a reopened turn by the model\'s name, not the full id it was stored with', () => {
    renderMessage(
      message('assistant', [{ kind: 'text', text: 'hi' }], { model: 'claude-haiku-5-5' }),
      'Claude',
      CLAUDE_MODELS,
    );

    expect(screen.getByRole('article', { name: 'Message from Claude' })).toHaveTextContent('CLAUDE · HAIKU 5.5');
  });

  it('keeps the stored id when the model list does not know it, and pi\'s labels as they were', () => {
    renderMessage(message('assistant', [{ kind: 'text', text: 'hi' }], { model: 'claude-haiku-9' }), 'Claude', CLAUDE_MODELS);
    expect(screen.getByRole('article', { name: 'Message from Claude' })).toHaveTextContent('CLAUDE · CLAUDE-HAIKU-9');
  });

  it('leaves the owner\'s own messages as they were', () => {
    renderMessage(message('user', [{ kind: 'text', text: 'hello' }]), 'Claude');

    expect(screen.getByRole('article', { name: 'Message from you' })).toHaveTextContent('YOU');
  });
});

describe('MessageView markdown', () => {
  it('marks a stopped assistant turn and keeps the caret only while streaming', () => {
    const { rerenderWith } = renderMessage(
      message('assistant', [{ kind: 'text', text: 'partial' }], { streaming: true }),
    );
    expect(screen.getByText('▋')).toBeInTheDocument();
    expect(screen.queryByLabelText('Turn stopped')).toBeNull();

    rerenderWith(
      message('assistant', [{ kind: 'text', text: 'partial' }], { streaming: false, stopped: true }),
    );
    expect(screen.queryByText('▋')).toBeNull();
    expect(screen.getByLabelText('Turn stopped')).toHaveTextContent('— stopped');
  });

  it('panels only the final text step of a tool-heavy turn; earlier narration renders bare', () => {
    renderMessage(
      message('assistant', [
        { kind: 'text', text: 'looking' },
        { kind: 'tool-call', callId: 'c1', tool: 'read', summary: 'read a.ts' },
        { kind: 'text', text: 'the answer' },
      ]),
    );
    const narration = screen.getByText('looking').closest('.md');
    const answer = screen.getByText('the answer').closest('.md');
    expect(narration?.className).not.toContain('border');
    expect(answer?.className).toContain('border');
    expect(answer?.className).toContain('text-text');
  });

  it('renders assistant GFM: headings, lists, tables, links and inline code', () => {
    renderMessage(
      message('assistant', [
        {
          kind: 'text',
          text: [
            '## Plan',
            '',
            '- first `npm ci`',
            '- second',
            '',
            '| col | val |',
            '| --- | --- |',
            '| a | 1 |',
            '',
            'See [the docs](https://example.com/docs).',
          ].join('\n'),
        },
      ]),
    );
    const row = pi();
    expect(within(row).getByRole('heading', { level: 2, name: 'Plan' })).toBeInTheDocument();
    expect(within(row).getAllByRole('listitem')).toHaveLength(2);
    expect(within(row).getByRole('table')).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: 'a' })).toBeInTheDocument();
    expect(within(row).getByText('npm ci').tagName).toBe('CODE');
    const link = within(row).getByRole('link', { name: 'the docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('keeps user text plain: markdown syntax is shown, not interpreted', () => {
    renderMessage(message('user', [{ kind: 'text', text: '## not a heading\n- not a list' }]));
    const row = screen.getByRole('article', { name: 'Message from you' });
    expect(within(row).queryByRole('heading')).toBeNull();
    expect(within(row).queryByRole('listitem')).toBeNull();
    expect(within(row).getByText(/## not a heading/)).toBeInTheDocument();
  });

  it('drops raw HTML rather than rendering it, and refuses javascript: links', () => {
    renderMessage(
      message('assistant', [
        {
          kind: 'text',
          text: 'before <script>window.pwned = 1</script><b>bold</b> after [x](javascript:alert(1))',
        },
      ]),
    );
    const row = pi();
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(within(row).getByText(/before/)).toBeInTheDocument();
    // The href is dropped entirely, so the anchor loses its link role.
    expect(row.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(within(row).queryByRole('link', { name: 'x' })).toBeNull();
    expect(within(row).getByText('x')).toBeInTheDocument();
  });

  it('renders a fenced block with its language, highlight tokens and a working copy button', async () => {
    const user = userEvent.setup();
    renderMessage(
      message('assistant', [
        { kind: 'text', text: 'Run:\n\n```ts\nconst answer: number = 42;\n```\n' },
      ]),
    );
    const row = pi();
    expect(within(row).getByText('ts')).toBeInTheDocument();
    const code = row.querySelector('pre code');
    expect(code).not.toBeNull();
    expect(code!.className).toContain('language-ts');
    expect(code!.querySelector('.hljs-keyword')).not.toBeNull();

    await user.click(within(row).getByRole('button', { name: 'Copy code' }));
    await expect(navigator.clipboard.readText()).resolves.toBe('const answer: number = 42;');
    expect(within(row).getByRole('button', { name: 'Copy code' })).toHaveTextContent('copied');
  });

  it('labels an unfenced block "code" and never throws on an unknown language', () => {
    renderMessage(
      message('assistant', [
        { kind: 'text', text: '```nosuchlang\nwhatever\n```\n\n    indented\n' },
      ]),
    );
    const row = pi();
    expect(within(row).getByText('nosuchlang')).toBeInTheDocument();
    expect(within(row).getByText('code')).toBeInTheDocument();
    expect(within(row).getAllByRole('button', { name: 'Copy code' })).toHaveLength(2);
  });
});

describe('MessageView thinking fold', () => {
  it('is open while thinking is the live tail, then folds when the first text step arrives', () => {
    const { rerenderWith } = renderMessage(
      message('assistant', [{ kind: 'thinking', text: 'hmm' }], { streaming: true }),
    );
    const toggle = () => screen.getByRole('button', { name: /thinking/ });
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(toggle()).toHaveTextContent('thinking…');
    expect(screen.getByText('hmm')).toBeInTheDocument();

    rerenderWith(
      message('assistant', [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'answer' }], {
        streaming: true,
      }),
    );
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveTextContent('thinking');
    expect(toggle()).not.toHaveTextContent('thinking…');
    expect(screen.queryByText('hmm')).toBeNull();
    expect(screen.getByText('answer')).toBeInTheDocument();
  });

  it('starts folded for a finished or reopened message', () => {
    renderMessage(
      message('assistant', [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'answer' }], {
        historical: true,
      }),
    );
    expect(screen.getByRole('button', { name: /thinking/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('hmm')).toBeNull();
  });

  it('keeps an explicit click across re-renders of the same message', async () => {
    const user = userEvent.setup();
    const done = message('assistant', [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: 'answer' }]);
    const { rerenderWith } = renderMessage(done);
    await user.click(screen.getByRole('button', { name: /thinking/ }));
    expect(screen.getByText('hmm')).toBeInTheDocument();

    rerenderWith({ ...done, steps: [...done.steps, { kind: 'text', text: 'more' }] });
    expect(screen.getByRole('button', { name: /thinking/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('hmm')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /thinking/ }));
    expect(screen.queryByText('hmm')).toBeNull();
  });

  it('folds each thinking step once text follows it: only the live tail stays open', () => {
    renderMessage(
      message(
        'assistant',
        [
          { kind: 'thinking', text: 'first' },
          { kind: 'text', text: 'partial' },
          { kind: 'thinking', text: 'second' },
          { kind: 'text', text: 'more' },
          { kind: 'thinking', text: 'third' },
        ],
        { streaming: true },
      ),
    );
    const toggles = screen.getAllByRole('button', { name: /thinking/ });
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');
    expect(toggles[1]).toHaveAttribute('aria-expanded', 'false');
    expect(toggles[2]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText('first')).toBeNull();
    expect(screen.queryByText('second')).toBeNull();
    expect(screen.getByText('third')).toBeInTheDocument();
  });
});

describe('MessageView empty text', () => {
  it('renders no panel for a text step that has no content yet', () => {
    renderMessage(
      message('assistant', [{ kind: 'thinking', text: 'hmm' }, { kind: 'text', text: '' }], { streaming: true }),
    );
    expect(pi().querySelector('.md')).toBeNull();
    // …but the empty step still counts as "text arrived" for the fold.
    expect(screen.getByRole('button', { name: /thinking/ })).toHaveAttribute('aria-expanded', 'false');
  });
});
