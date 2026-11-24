/**
 * Purpose-built card for custom-message timeline events.
 *
 * Documented `crew-result` and `crew-list-warning` events render as distinct
 * cards at their arrival positions; unknown `display:true` types render a safe
 * generic card; `display:false` renders nothing. All content flows through
 * React text nodes (whitespace-preserving, React-escaped) — no HTML strings,
 * no dangerouslySetInnerHTML, no Markdown parser. Structured details render as
 * escaped pretty JSON only where useful.
 */

import { useState } from 'react';
import type { ChatEventItem } from './chat.types.ts';
import {
  CREW_STATUS_META,
  CREW_WAITING_HINT,
  crewPreview,
  customCardModel,
  formatTime,
  isPreviewTruncated,
  prettyJson,
  type CustomCardModel,
} from './crew-card.ts';
import { formatDuration, type CrewResultEnrichment } from './crew-audit.ts';

/** The current visual language: bordered card with a gutter glyph, like Bubble. */
function toneClass(model: CustomCardModel): { border: string; glyph: string } {
  if (model.kind === 'crew-result') {
    const tone = CREW_STATUS_META[model.details.status].tone;
    if (tone === 'success') return { border: 'border-ok/60', glyph: 'text-ok' };
    if (tone === 'error') return { border: 'border-danger/60', glyph: 'text-danger' };
    return { border: 'border-attention/60', glyph: 'text-attention' };
  }
  if (model.kind === 'crew-list-warning') {
    return { border: 'border-attention/60', glyph: 'text-attention' };
  }
  // The engine's own note is not an extension's message: nothing coloured about it.
  if (model.kind === 'note') return { border: 'border-border', glyph: 'text-muted' };
  return { border: 'border-border', glyph: 'text-special' };
}

/** Agent identity when present: `name (id)`, either alone, or nothing. */
function identity(details: { agentName?: string; agentId?: string }): string | null {
  if (details.agentName && details.agentId) return `${details.agentName} (${details.agentId})`;
  if (details.agentName) return details.agentName;
  if (details.agentId) return details.agentId;
  return null;
}

function ariaLabel(model: CustomCardModel): string {
  if (model.kind === 'crew-result') return `Crew result: ${model.details.status}`;
  if (model.kind === 'crew-list-warning') return 'Crew warning';
  if (model.kind === 'note') return 'FunkyOctopus note';
  return `Custom message: ${model.customType}`;
}

export function CrewCard({
  event,
  showTimestamp,
  enrichment,
}: {
  event: ChatEventItem;
  showTimestamp: boolean;
  /** Correlated spawn metadata (task/duration) — never overrides identity. */
  enrichment?: CrewResultEnrichment;
}) {
  const [expanded, setExpanded] = useState(false);
  // display:false events never render — they stay in the timeline data only.
  if (!event.display) return null;
  const model = customCardModel(event);
  const tone = toneClass(model);

  // Best available body, in documented order: the 1.0.34 report, the legacy
  // 1.0.28 body, the 1.0.34 error text, then the raw event content — never
  // both, never a fabricated field.
  const bodyText =
    model.kind === 'crew-result'
      ? (model.details.result?.report ?? model.details.body ?? model.details.error ?? model.content)
      : model.content;
  // 1.0.34 needs_input: the expected answer shown beneath the report.
  const needsText =
    model.kind === 'crew-result' && model.details.status === 'needs_input'
      ? model.details.result?.needs
      : undefined;
  // Generic cards render their structured details as escaped JSON; the same
  // safe preview bound applies to both text and details.
  const detailsText =
    model.kind === 'generic' && model.details !== null && model.details !== undefined
      ? prettyJson(model.details)
      : '';
  const expandable =
    isPreviewTruncated(bodyText) ||
    isPreviewTruncated(detailsText) ||
    (needsText !== undefined && isPreviewTruncated(needsText));
  const shownBody = !expanded && isPreviewTruncated(bodyText) ? crewPreview(bodyText) : bodyText;
  const shownDetails =
    !expanded && isPreviewTruncated(detailsText) ? crewPreview(detailsText) : detailsText;
  const shownNeeds =
    !expanded && needsText !== undefined && isPreviewTruncated(needsText)
      ? crewPreview(needsText)
      : needsText;
  const waiting =
    model.kind === 'crew-result' &&
    (model.details.status === 'waiting' || model.details.status === 'needs_input');
  const who = model.kind === 'crew-result' ? identity(model.details) : null;

  return (
    <article
      aria-label={ariaLabel(model)}
      className={`flex w-full min-w-0 gap-3 border-l-2 pl-3 wrap-anywhere ${tone.border}`}
    >
      <span aria-hidden="true" className={`pt-0.5 font-mono text-sm ${tone.glyph}`}>
        {model.kind === 'crew-result'
          ? CREW_STATUS_META[model.details.status].icon
          : model.kind === 'crew-list-warning'
            ? '⚠'
            : model.kind === 'note'
              ? '◦'
              : '◇'}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-xs tracking-widest text-muted">
          {model.kind === 'crew-result' ? (
            <>
              <span className={tone.glyph}>{CREW_STATUS_META[model.details.status].label}</span>
              {who ? ` · ${who}` : ''}
            </>
          ) : model.kind === 'crew-list-warning' ? (
            'CREW LIST WARNING'
          ) : model.kind === 'note' ? (
            'NOTE'
          ) : (
            `CUSTOM · ${model.customType}`
          )}
          {showTimestamp && (
            <span className="ml-2 tracking-normal text-muted">
              {formatTime(model.timestamp)}
            </span>
          )}
        </span>
        {waiting && <p className="font-mono text-xs text-muted">{CREW_WAITING_HINT}</p>}
        {enrichment?.task && (
          <p className="wrap-anywhere whitespace-pre-wrap font-mono text-xs text-muted">
            TASK · {enrichment.task}
          </p>
        )}
        {enrichment && enrichment.durationMs !== undefined && (
          <p className="font-mono text-xs text-muted">
            DURATION · {formatDuration(enrichment.durationMs)}
          </p>
        )}
        {bodyText !== '' && (
          <div className="max-w-[90ch] wrap-anywhere whitespace-pre-wrap font-mono text-sm text-text">
            {shownBody}
          </div>
        )}
        {shownNeeds !== undefined && (
          <div className="max-w-[90ch] wrap-anywhere whitespace-pre-wrap font-mono text-sm text-attention">
            Needs: {shownNeeds}
          </div>
        )}
        {expandable && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="self-start font-mono text-xs uppercase tracking-widest text-muted hover:text-text"
          >
            {expanded ? 'COLLAPSE' : 'EXPAND'}
          </button>
        )}
        {model.kind === 'generic' && detailsText !== '' && (
          <pre className="max-w-[90ch] wrap-anywhere whitespace-pre-wrap font-mono text-xs text-muted">
            {shownDetails}
          </pre>
        )}
      </div>
    </article>
  );
}
