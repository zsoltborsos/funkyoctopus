/**
 * Message rendering: one `ChatMessage` (user or assistant turn) as a gutter-
 * marked row, plus the generic tool-step panel the timeline reuses for
 * historical crew audits it cannot recognise. Extracted from `ChatPanel.tsx`
 * (T1.2) so rendering polish and session plumbing stop colliding there; the
 * reducer and protocol are untouched — this file only reads `ChatMessage`.
 *
 * Assistant prose is markdown (CURRENT_STATE.md decision 2): `react-markdown`
 * + `remark-gfm` + `rehype-highlight`, raw HTML skipped, fenced code with a
 * language label and a copy button. User text stays plain — it is what was
 * typed, not something to interpret. Thinking is a labelled fold that opens
 * while it is the live tail of the turn and folds once the first text step
 * arrives; a click overrides that for the message's lifetime.
 */

import { memo, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Element as HastElement, ElementContent as HastContent } from 'hast';
import { compactionLabel } from './compaction.ts';
import { formatTime } from './crew-card.ts';
import { CrewAuditCard } from './CrewAuditCard.tsx';
import type { CrewRenderState } from './crew-audit.ts';
import type { ModelOption } from '@shared/transport/protocol.ts';
import type { ChatMessage, ChatStep } from './chat.types.ts';
import { modelLabel } from './model-label.ts';

const TOOL_ICONS: Record<string, string> = {
  bash: '⌗',
  edit: '✎',
  read: '▤',
  write: '✎',
  'web-search': '🔎',
  web_search: '🔎',
};

type ToolCallStep = Extract<ChatStep, { kind: 'tool-call' }>;
type ToolResultStep = Extract<ChatStep, { kind: 'tool-result' }>;

function Diff({ value }: { value: string }) {
  return (
    <pre aria-label="File diff" className="overflow-x-auto whitespace-pre font-mono text-xs">
      {value.split('\n').map((line, index) => (
        <span
          key={index}
          className={`block ${
            line.startsWith('+')
              ? 'bg-ok/10 text-ok'
              : line.startsWith('-')
                ? 'bg-danger/10 text-danger'
                : 'text-muted'
          }`}
        >
          {line || ' '}
        </span>
      ))}
    </pre>
  );
}

export function ToolStep({
  call,
  result,
  defaultOpen,
}: {
  call: ToolCallStep;
  result: ToolResultStep | undefined;
  defaultOpen: boolean;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? defaultOpen;
  const icon = TOOL_ICONS[call.tool] ?? '◆';
  return (
    <div className="w-full min-w-0 rounded border border-border bg-bg/60 font-mono text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOverride(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted hover:text-text"
      >
        <span aria-hidden="true">{icon}</span>
        <span className="flex-1 truncate">{call.summary}</span>
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border px-3 py-2 text-text">
          {call.args !== undefined && (
            <pre className="overflow-x-auto whitespace-pre-wrap wrap-anywhere">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          )}
          {result?.diff && <Diff value={result.diff} />}
          {result?.output && (
            <pre className="overflow-x-auto whitespace-pre-wrap wrap-anywhere">{result.output}</pre>
          )}
          {result?.error && (
            <pre className="overflow-x-auto whitespace-pre-wrap wrap-anywhere text-danger">
              {result.error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Plain text of a hast subtree — the copy payload of a code block. */
function hastText(node: HastContent | HastElement): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(hastText).join('');
  return '';
}

/** `language-ts` (set by remark/rehype from the fence info string) → `ts`. */
function fenceLanguage(pre: HastElement | undefined): string | null {
  const code = pre?.children.find(
    (child): child is HastElement => child.type === 'element' && child.tagName === 'code',
  );
  const classes = code?.properties?.['className'];
  if (!Array.isArray(classes)) return null;
  const match = classes
    .map(String)
    .map((name) => /^language-(.+)$/.exec(name)?.[1])
    .find((name): name is string => name !== undefined);
  return match ?? null;
}

/** Fenced code: language label, copy button, highlighted body. */
function CodeBlock({ node, children }: { children?: ReactNode } & ExtraProps) {
  const [copied, setCopied] = useState(false);
  const language = fenceLanguage(node);
  const copy = (): void => {
    if (!node) return;
    const text = hastText(node).replace(/\n$/, '');
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className="md-code my-2 w-full min-w-0 overflow-hidden rounded border border-border bg-bg/60">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1 font-mono text-xs text-muted">
        <span>{language ?? 'code'}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="hover:text-text"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-sm leading-relaxed">{children}</pre>
    </div>
  );
}

/** Links leave the cockpit in a new tab; pi's answers routinely cite the web. */
function Anchor({ node: _node, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  return (
    <a {...rest} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS: Components = { pre: CodeBlock, a: Anchor };
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

/**
 * Markdown as FO renders it everywhere. `skipHtml` drops raw HTML nodes
 * outright (decision 2: raw HTML off); react-markdown's default `urlTransform`
 * already refuses `javascript:` and friends.
 */
export function Prose({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={MARKDOWN_COMPONENTS}
      skipHtml
    >
      {text}
    </Markdown>
  );
}

/**
 * Assistant prose. Memoised on the text so a streaming message re-parses only
 * the step that changed.
 */
const AssistantText = memo(function AssistantText({
  text,
  final,
}: {
  text: string;
  /**
   * The last text step of the turn is the answer and gets the panel; earlier
   * text steps between tool rows are narration and render bare, so a
   * tool-heavy turn reads as one answer rather than several (T1.4).
   */
  final: boolean;
}) {
  return (
    <div
      className={`md max-w-[90ch] min-w-0 wrap-anywhere font-mono text-base leading-relaxed text-text ${
        final ? 'rounded-md border border-accent/30 bg-surface px-4 py-2.5' : 'px-1 py-1'
      }`}
    >
      <Prose text={text} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

/**
 * A labelled fold over one thinking step. `live` — this thinking is still the
 * tail of a streaming turn (no text after it yet) — opens it by default; once
 * the next text step lands, or the turn ends, it folds. A click wins over the
 * default for as long as the message is mounted.
 */
/**
 * An image the user attached. A thumbnail by default so a row of screenshots
 * does not swallow the transcript; click toggles the full size.
 */
function UserImage({ mimeType, data }: { mimeType: string; data: string }) {
  const [full, setFull] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setFull((v) => !v)}
      title={full ? 'Shrink' : 'Show full size'}
      className="block w-fit max-w-full rounded-md border border-border bg-surface p-1"
    >
      <img
        src={`data:${mimeType};base64,${data}`}
        alt="attached image"
        className={full ? 'max-w-full' : 'max-h-48 max-w-full'}
      />
    </button>
  );
}

function ThinkingStep({ text, live }: { text: string; live: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? live;
  return (
    <div className="w-full min-w-0 max-w-[90ch] font-mono text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOverride(!expanded)}
        className="flex items-center gap-2 text-xs tracking-widest text-special hover:text-text"
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={live ? 'animate-pulse' : ''}>{live ? 'thinking…' : 'thinking'}</span>
      </button>
      {expanded && (
        <pre className="mt-1 whitespace-pre-wrap wrap-anywhere border-l-2 border-special/50 pl-2 italic text-muted">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Index of the last text step, or -1: thinking after it is live while the turn streams. */
function lastTextIndex(steps: readonly ChatStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'text') return index;
  }
  return -1;
}

function CompactionDivider({ step }: { step: Extract<ChatStep, { kind: 'compaction' }> }) {
  const label = compactionLabel(step);
  return (
    <div
      role="separator"
      aria-label={label}
      className="w-full min-w-0 max-w-[90ch] wrap-anywhere font-mono text-xs text-muted"
    >
      <span aria-hidden="true">⋯ </span>
      {label}
    </div>
  );
}

export function MessageView({
  message,
  showTimestamp,
  toolStepsDefaultOpen,
  agentName,
  currentModel,
  models = [],
  onResolveApproval,
  crewState,
}: {
  message: ChatMessage;
  showTimestamp: boolean;
  toolStepsDefaultOpen: boolean;
  /** The picker's models, so a stored turn's full model id can be shown by name. */
  models?: ModelOption[];
  /** Who answers, for the role label and the accessible name: `pi` or `Claude`. */
  agentName: string;
  /** Label for turns with no recorded model — the live session's model, null when it has none. */
  currentModel: string | null;
  onResolveApproval: (requestId: string, approved: boolean) => void;
  /** Crew audit state: recognized tool steps render as audit cards. */
  crewState: CrewRenderState;
}) {
  const isUser = message.role === 'user';
  const turnModel = message.model ?? currentModel;
  const textAt = lastTextIndex(message.steps);
  // A compaction on its own (a reopened transcript's marker, a finished /compact) is a
  // divider in the conversation, not something the assistant said: no header above it.
  const onlyCompaction =
    message.steps.length > 0 &&
    message.steps.every((step) => step.kind === 'compaction') &&
    message.streaming !== true &&
    !message.error &&
    !message.stopped;
  // Role is carried by the gutter — glyph plus border colour — not by which edge
  // the row hugs, so a message can use the full width of a column the rail has
  // already narrowed. `min-w-0` keeps a long unbroken token inside the row
  // rather than letting it stretch the scroll container.
  if (onlyCompaction) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-1">
        {message.steps.map((step, index) =>
          step.kind === 'compaction' ? <CompactionDivider key={index} step={step} /> : null,
        )}
      </div>
    );
  }
  return (
    <article
      aria-label={isUser ? 'Message from you' : `Message from ${agentName}`}
      className={`flex w-full min-w-0 gap-3 border-l-2 pl-3 ${
        isUser ? 'border-info' : 'border-accent'
      }`}
    >
      <span
        aria-hidden="true"
        className={`pt-0.5 font-mono text-sm ${isUser ? 'text-info' : 'text-accent'}`}
      >
        {isUser ? '›_' : '◆'}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-xs tracking-widest text-muted">
          {isUser
            ? 'YOU'
            : turnModel === null
              ? agentName.toUpperCase()
              : `${agentName.toUpperCase()} · ${modelLabel(models, turnModel).toUpperCase()}`}
          {showTimestamp && (
            <span className="ml-2 tracking-normal text-muted">
              {formatTime(message.createdAt)}
            </span>
          )}
        </span>
        {message.steps.map((step, index) => {
          if (step.kind === 'thinking') {
            const live = message.streaming === true && index > textAt;
            return <ThinkingStep key={index} text={step.text} live={live} />;
          }
          if (step.kind === 'tool-call') {
            const audit = crewState.audits.get(step.callId);
            if (audit) {
              // Recognized crew activity: the audit card replaces the generic
              // call+result representation at its original position.
              return <CrewAuditCard key={step.callId} audit={audit} />;
            }
            const result = message.steps.find(
              (candidate): candidate is ToolResultStep =>
                candidate.kind === 'tool-result' && candidate.callId === step.callId,
            );
            return (
              <ToolStep
                key={`${step.callId}-call`}
                call={step}
                result={result}
                defaultOpen={toolStepsDefaultOpen}
              />
            );
          }
          if (step.kind === 'approval-request') {
            return (
              <div
                key={step.requestId}
                className="w-full min-w-0 wrap-anywhere rounded border border-special/60 bg-special/10 p-3 font-mono text-sm"
              >
                <p className="text-text">
                  Vault escalation: <span className="text-special">{step.target}</span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  {step.tool} requires explicit approval
                </p>
                {step.status ? (
                  <p className="mt-2 text-xs uppercase text-muted">{step.status}</p>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onResolveApproval(step.requestId, true)}
                      className="rounded border border-accent px-3 py-1 text-accent"
                    >
                      APPROVE
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolveApproval(step.requestId, false)}
                      className="rounded border border-danger px-3 py-1 text-danger"
                    >
                      DENY
                    </button>
                  </div>
                )}
              </div>
            );
          }
          if (step.kind === 'tool-result') return null;
          if (step.kind === 'compaction') return <CompactionDivider key={index} step={step} />;
          if (step.kind === 'image') {
            return <UserImage key={index} mimeType={step.mimeType} data={step.data} />;
          }
          // The row is full width; its prose is not — a reading measure keeps
          // long answers legible while code and tool panels keep the whole column.
          if (isUser) {
            return (
              <div
                key={index}
                className="max-w-[90ch] whitespace-pre-wrap wrap-anywhere rounded-md border border-border bg-surface px-4 py-2.5 font-mono text-base leading-relaxed text-text"
              >
                {step.text}
              </div>
            );
          }
          // pi can open a text step that never receives content (a tool call
          // follows at once); an empty bordered panel reads as a broken row.
          if (step.text.trim() === '') return null;
          return <AssistantText key={index} text={step.text} final={index === textAt} />;
        })}
        {message.streaming && <span className="animate-pulse text-accent">▋</span>}
        {message.stopped && (
          <span className="font-mono text-xs text-muted" aria-label="Turn stopped">
            — stopped
          </span>
        )}
        {message.error && (
          <div
            role="alert"
            className="w-full min-w-0 wrap-anywhere rounded border border-danger/60 bg-danger/10 p-2 font-mono text-sm text-danger"
          >
            ⚠ {message.error}
          </div>
        )}
      </div>
    </article>
  );
}
