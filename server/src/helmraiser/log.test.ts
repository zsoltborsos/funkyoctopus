import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseHelmraiserLog } from './log.ts';

/** Historical run 142d660e log fixture, adapted to Helmraiser: 39 of 422 events. */
const fixtureLines = readFileSync(new URL('./fixtures/log-failed-run.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line !== '');

const event = (id: number, extra: Record<string, unknown> = {}) => JSON.stringify({
  id, run_id: 'r1', ts: 1792427756.3, source: 'helmraiser', stage: null, session_id: null, type: 'stage_start', payload: {}, ...extra,
});

describe('parseHelmraiserLog', () => {
  it('parses the adapted fixture into events in order, ending on run_end', () => {
    const { events, truncated } = parseHelmraiserLog(fixtureLines, fixtureLines.length);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(39);
    expect(events[0]).toMatchObject({ id: 337482, type: 'run_start', stage: null, source: 'helmraiser' });
    expect(events.at(-1)).toMatchObject({ id: 338277, type: 'run_end', payload: { status: 'failed' } });
    const verify = events.find((e) => e.type === 'verify_result');
    expect(verify?.payload.passed).toBe(false);
    expect((verify?.payload.results as Array<{ name: string; passed: boolean }>).map((r) => `${r.name}:${r.passed}`))
      .toEqual(['lint:true', 'typecheck:true', 'release-tests:true', 'diff-check:false']);
  });

  it('preserves Helmraiser, pi and unknown ledger sources without filtering', () => {
    const sources = ['helmraiser', 'pi', 'unknown-producer'];
    const lines = sources.map((source, i) => event(i + 1, { source }));
    expect(parseHelmraiserLog(lines, lines.length).events.map((entry) => entry.source)).toEqual(sources);
  });

  it('is truncated when the ledger had more lines than were kept', () => {
    expect(parseHelmraiserLog([event(5), event(6)], 422).truncated).toBe(true);
    expect(parseHelmraiserLog([event(5), event(6)], 2).truncated).toBe(false);
  });

  it('skips lines that are not JSON, not an object, or not an event', () => {
    const lines = [
      event(1),
      'Traceback (most recent call last):',
      '{"id": 2, "type": "run_end", "ts": 1.5, "payload": {',
      '[]',
      '3',
      'null',
      '{"id": "7", "type": "x", "ts": 1}',
      '{"id": 8, "ts": 1}',
      '{"id": 9, "type": "x"}',
      event(3, { type: 'run_end', payload: { status: 'failed' } }),
    ];
    const { events } = parseHelmraiserLog(lines, lines.length);
    expect(events.map((e) => e.id)).toEqual([1, 3]);
  });

  it('gives an event without a usable payload an empty one', () => {
    const { events } = parseHelmraiserLog([event(1, { payload: 'oops' }), event(2, { payload: null })], 2);
    expect(events.map((e) => e.payload)).toEqual([{}, {}]);
  });

  it('keeps both ends of a very long string, however deep, so one event cannot flood the wire', () => {
    const huge = `START-${'x'.repeat(100_000)}-END`;
    const { events } = parseHelmraiserLog([event(1, { payload: { message: { content: [{ text: huge }] }, small: 'ok' } })], 1);
    const text = ((events[0]?.payload.message as { content: Array<{ text: string }> }).content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(8_000);
    expect(text.startsWith('START-')).toBe(true);
    expect(text.endsWith('-END')).toBe(true);
    expect(text).toContain('characters omitted');
    expect(events[0]?.payload.small).toBe('ok');
  });
});
