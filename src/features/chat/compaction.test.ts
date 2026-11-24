import { describe, expect, it } from 'vitest';
import { compactionLabel } from './compaction.ts';

describe('compactionLabel', () => {
  it('shows the sizes before and after, in thousands', () => {
    // 33,213 -> 3,081 tokens is the size of the manual /compact recorded on 2026-10-17.
    expect(compactionLabel({ kind: 'compaction', trigger: 'manual', preTokens: 33213, postTokens: 3081 })).toBe(
      'context compacted · 33k → 3k tokens',
    );
  });

  it('keeps small sizes exact', () => {
    expect(compactionLabel({ kind: 'compaction', trigger: 'manual', preTokens: 950, postTokens: 420 })).toBe(
      'context compacted · 950 → 420 tokens',
    );
  });

  it('says when the compaction was automatic', () => {
    expect(compactionLabel({ kind: 'compaction', trigger: 'auto', preTokens: 180000, postTokens: 12000 })).toBe(
      'context auto-compacted · 180k → 12k tokens',
    );
  });

  it('gives only the size it was told when the engine does not report the other', () => {
    expect(compactionLabel({ kind: 'compaction', trigger: 'manual', preTokens: 180000 })).toBe(
      'context compacted · from 180k tokens',
    );
  });

  it('says only that it happened for a reopened transcript, which knows nothing else', () => {
    expect(compactionLabel({ kind: 'compaction' })).toBe('context compacted');
  });
});
