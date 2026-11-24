import { describe, expect, it } from 'vitest';
import type { ChatEventItem } from './chat.types.ts';
import {
  CREW_STATUSES,
  crewPreview,
  crewResultDetails,
  customCardModel,
  isPreviewTruncated,
  prettyJson,
} from './crew-card.ts';

const event = (overrides: Partial<ChatEventItem> = {}): ChatEventItem => ({
  kind: 'custom-message',
  id: 'e1',
  customType: 'crew-result',
  display: true,
  content: 'content',
  details: { status: 'done', agentName: 'scout' },
  timestamp: 1000,
  ...overrides,
});

describe('crewResultDetails', () => {
  it('accepts every documented status', () => {
    for (const status of CREW_STATUSES) {
      expect(crewResultDetails({ status })?.status).toBe(status);
    }
  });

  it('rejects non-objects, missing and unknown statuses', () => {
    expect(crewResultDetails(null)).toBeNull();
    expect(crewResultDetails(undefined)).toBeNull();
    expect(crewResultDetails('done')).toBeNull();
    expect(crewResultDetails({})).toBeNull();
    expect(crewResultDetails({ status: 'unknown' })).toBeNull();
    expect(crewResultDetails({ status: 42 })).toBeNull();
  });

  it('narrows optional fields to strings only — numbers and junk are dropped', () => {
    expect(
      crewResultDetails({
        status: 'done',
        agentName: 'scout',
        agentId: 'scout-1',
        sessionFile: '/s/s.jsonl',
        body: 'result',
        weight: 12,
      }),
    ).toEqual({
      status: 'done',
      agentName: 'scout',
      agentId: 'scout-1',
      sessionFile: '/s/s.jsonl',
      body: 'result',
    });
  });

  it('narrows the pi-crew 1.0.34 completed payload', () => {
    expect(
      crewResultDetails({
        status: 'completed',
        agentId: 'scout-1',
        result: { outcome: 'completed', report: 'probe-a: x' },
      }),
    ).toEqual({
      status: 'completed',
      agentId: 'scout-1',
      result: { outcome: 'completed', report: 'probe-a: x' },
    });
  });

  it('narrows the pi-crew 1.0.34 needs_input payload with its needs', () => {
    expect(
      crewResultDetails({
        status: 'needs_input',
        agentId: 'scout-1',
        result: { outcome: 'needs_input', report: 'progress so far', needs: 'Which port?' },
      }),
    ).toEqual({
      status: 'needs_input',
      agentId: 'scout-1',
      result: { outcome: 'needs_input', report: 'progress so far', needs: 'Which port?' },
    });
  });

  it('narrows the pi-crew 1.0.34 error text', () => {
    expect(crewResultDetails({ status: 'error', agentId: 'scout-1', error: 'boom' })).toEqual({
      status: 'error',
      agentId: 'scout-1',
      error: 'boom',
    });
  });

  it('drops junk nested result fields without rejecting a valid status', () => {
    expect(
      crewResultDetails({
        status: 'completed',
        result: { outcome: 42, report: 7, junk: true },
      }),
    ).toEqual({ status: 'completed' });
    expect(crewResultDetails({ status: 'completed', result: 'not an object' })).toEqual({
      status: 'completed',
    });
    expect(
      crewResultDetails({ status: 'error', error: 42, result: [{ outcome: 'completed' }] }),
    ).toEqual({ status: 'error' });
  });
});

describe('crewPreview', () => {
  it('returns text within both bounds unchanged', () => {
    const text = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(crewPreview(text)).toBe(text);
  });

  it('bounds longer text to the first five lines', () => {
    const text = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\n');
    expect(crewPreview(text)).toBe('l1\nl2\nl3\nl4\nl5');
  });

  it('bounds a long single line to the character cap', () => {
    expect(crewPreview('x'.repeat(1200))).toBe('x'.repeat(800));
  });

  it('keeps text exactly at the character cap unchanged', () => {
    expect(crewPreview('x'.repeat(800))).toBe('x'.repeat(800));
  });

  it('handles empty text', () => {
    expect(crewPreview('')).toBe('');
  });
});

describe('isPreviewTruncated', () => {
  it('is false within both bounds and true beyond either', () => {
    expect(isPreviewTruncated('a\nb\nc\nd\ne')).toBe(false);
    expect(isPreviewTruncated('x'.repeat(800))).toBe(false);
    expect(isPreviewTruncated('a\nb\nc\nd\ne\nf')).toBe(true);
    expect(isPreviewTruncated('x'.repeat(801))).toBe(true);
  });
});

describe('customCardModel', () => {
  it('maps a valid crew-result to a narrowed card carrying the raw content', () => {
    expect(customCardModel(event({ content: 'the result' }))).toEqual({
      kind: 'crew-result',
      id: 'e1',
      timestamp: 1000,
      content: 'the result',
      details: { status: 'done', agentName: 'scout' },
    });
  });

  it('carries narrowed 1.0.34 result/error fields onto the card', () => {
    const completed = customCardModel(
      event({ details: { status: 'completed', agentId: 's', result: { outcome: 'completed', report: 'r' } } }),
    );
    expect(completed).toMatchObject({
      kind: 'crew-result',
      details: { status: 'completed', result: { outcome: 'completed', report: 'r' } },
    });
    const needs = customCardModel(
      event({
        details: {
          status: 'needs_input',
          result: { outcome: 'needs_input', report: 'r', needs: 'q' },
        },
      }),
    );
    expect(needs).toMatchObject({
      kind: 'crew-result',
      details: { status: 'needs_input', result: { outcome: 'needs_input', report: 'r', needs: 'q' } },
    });
  });

  it('degrades a malformed crew-result to the safe generic card — no fabrication', () => {
    const malformed = event({ details: { status: 'wat' } });
    expect(customCardModel(malformed)).toEqual({
      kind: 'generic',
      id: 'e1',
      customType: 'crew-result',
      timestamp: 1000,
      content: 'content',
      details: { status: 'wat' },
    });
  });

  it('maps crew-list-warning to the warning card', () => {
    expect(customCardModel(event({ customType: 'crew-list-warning', content: '⚠ active' }))).toEqual({
      kind: 'crew-list-warning',
      id: 'e1',
      timestamp: 1000,
      content: '⚠ active',
    });
  });

  it('degrades a malformed crew-result without exposing sessionFile but keeps other details', () => {
    const model = customCardModel(
      event({
        details: { status: 'wat', sessionFile: '/s/secret.jsonl', body: 'drifted body' },
      }),
    );
    expect(model).toEqual({
      kind: 'generic',
      id: 'e1',
      customType: 'crew-result',
      timestamp: 1000,
      content: 'content',
      // status/body stay for diagnostics; the internal sessionFile path is gone.
      details: { status: 'wat', body: 'drifted body' },
    });
  });

  it('leaves unrelated custom types untouched, including a sessionFile-shaped field', () => {
    const model = customCardModel(
      event({ customType: 'custom-thing', details: { sessionFile: '/s/other.jsonl', note: 'x' } }),
    );
    expect(model).toEqual({
      kind: 'generic',
      id: 'e1',
      customType: 'custom-thing',
      timestamp: 1000,
      content: 'content',
      // The generic transport stays generic — only drifted crew-result details
      // are sanitised.
      details: { sessionFile: '/s/other.jsonl', note: 'x' },
    });
  });

  it('maps unknown custom types to the generic card', () => {
    expect(customCardModel(event({ customType: 'custom-thing', details: { x: 1 } }))).toEqual({
      kind: 'generic',
      id: 'e1',
      customType: 'custom-thing',
      timestamp: 1000,
      content: 'content',
      details: { x: 1 },
    });
  });
});

describe('prettyJson', () => {
  it('renders nested JSON with two-space indentation', () => {
    expect(prettyJson({ a: 1, b: ['x'] })).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}');
  });

  it('never throws on hostile input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(prettyJson(cyclic)).toBe('');
  });
});
