import { describe, expect, it } from 'vitest';
import { makeStatsScoutRow } from './__fixtures__/helmraiser-stats.ts';
import { scoutFunnel } from './stats-figures.ts';

describe('scoutFunnel', () => {
  it('adds running scouts and drops by class up per lens and in the total', () => {
    const { lenses, total } = scoutFunnel([
      makeStatsScoutRow('/work/alpha', 'docs', { scouts: 3, running: 1, dropped_by_class: { wrong: 1, unwanted: 0, duplicate: 2, unusable: 0, unclassified: 0 } }),
      makeStatsScoutRow('/work/beta', 'docs', { scouts: 2, running: 2, dropped_by_class: { wrong: 0, unwanted: 3, duplicate: 1, unusable: 0, unclassified: 4 } }),
      makeStatsScoutRow('/work/alpha', 'state', { scouts: 1, running: 0, dropped_by_class: { wrong: 5, unwanted: 0, duplicate: 0, unusable: 6, unclassified: 0 } }),
    ]);
    expect(lenses.map(({ lens }) => lens)).toEqual(['docs', 'state']);
    expect(lenses[0]!.counts.running).toBe(3);
    expect(lenses[0]!.counts.dropped_by_class).toEqual({ wrong: 1, unwanted: 3, duplicate: 3, unusable: 0, unclassified: 4 });
    expect(lenses[1]!.counts.running).toBe(0);
    expect(lenses[1]!.counts.dropped_by_class).toEqual({ wrong: 5, unwanted: 0, duplicate: 0, unusable: 6, unclassified: 0 });
    expect(total.running).toBe(3);
    expect(total.dropped_by_class).toEqual({ wrong: 6, unwanted: 3, duplicate: 3, unusable: 6, unclassified: 4 });
  });

  it('does not let one row\'s class counts leak into another through shared objects', () => {
    const first = makeStatsScoutRow('/work/alpha', 'docs', { dropped_by_class: { wrong: 1, unwanted: 0, duplicate: 0, unusable: 0, unclassified: 0 } });
    const second = makeStatsScoutRow('/work/beta', 'docs');
    const { lenses } = scoutFunnel([first, second]);
    lenses[0]!.counts.dropped_by_class.wrong += 10;
    expect(first.dropped_by_class.wrong).toBe(1);
    expect(second.dropped_by_class.wrong).toBe(0);
  });
});
