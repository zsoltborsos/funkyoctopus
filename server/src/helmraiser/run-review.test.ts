import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_HELMRAISER_RUN_FILE_BYTES } from './run-files.ts';
import { parseDiffStat, readHelmraiserRunReview } from './run-review.ts';

const RUN_ID = '865c36b8-a39d-433a-bc6c-87b1715d14e2';

describe('readHelmraiserRunReview', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function runDir(): Promise<{ data: string; run: string }> {
    root = await mkdtemp(join(tmpdir(), 'helmraiser-review-'));
    const run = join(root, 'runs', RUN_ID);
    await mkdir(run, { recursive: true });
    return { data: root, run };
  }

  it('rejects a non-UUID before any filesystem access', async () => {
    await expect(readHelmraiserRunReview('../../etc', '/does/not/exist'))
      .rejects.toThrow('requires a UUID runId');
  });

  it('rejects a run-directory symlink that escapes runs', async () => {
    root = await mkdtemp(join(tmpdir(), 'helmraiser-review-'));
    const outside = join(root, 'outside');
    await mkdir(join(root, 'runs'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(root, 'runs', RUN_ID), 'dir');
    await expect(readHelmraiserRunReview(RUN_ID, root)).rejects.toThrow('escapes the runs directory');
  });

  it('rejects an optional file symlink that escapes runs', async () => {
    const { data, run } = await runDir();
    const outside = join(data, 'outside.md');
    await writeFile(outside, 'outside');
    await symlink(outside, join(run, 'summary.md'));
    await expect(readHelmraiserRunReview(RUN_ID, data)).rejects.toThrow('escapes the runs directory');
  });

  it('returns null optional prose and an empty stat when files are missing', async () => {
    const { data, run } = await runDir();
    await expect(readHelmraiserRunReview(RUN_ID, data)).resolves.toEqual({
      summary: null,
      review: null,
      diffStat: { files: [], filesChanged: 0, additions: 0, deletions: 0 },
      diffTruncated: false,
      taskPath: join(run, 'task.md'),
    });
  });

  it('bounds oversized files and marks an oversized patch as truncated', async () => {
    const { data, run } = await runDir();
    await writeFile(join(run, 'summary.md'), 's'.repeat(MAX_HELMRAISER_RUN_FILE_BYTES + 50));
    await writeFile(join(run, 'review.md'), 'r'.repeat(MAX_HELMRAISER_RUN_FILE_BYTES + 50));
    await writeFile(join(run, 'diff.patch'), `diff --git a/a b/a\n${'+x\n'.repeat(MAX_HELMRAISER_RUN_FILE_BYTES)}`);
    const result = await readHelmraiserRunReview(RUN_ID, data);
    expect(Buffer.byteLength(result.summary ?? '')).toBe(MAX_HELMRAISER_RUN_FILE_BYTES);
    expect(Buffer.byteLength(result.review ?? '')).toBe(MAX_HELMRAISER_RUN_FILE_BYTES);
    expect(result.diffTruncated).toBe(true);
  });
});

describe('parseDiffStat', () => {
  it('counts additions/deletions and represents renames and binary files', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      '-old',
      '+new',
      '+added',
      ' unchanged',
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    expect(parseDiffStat(patch)).toEqual({
      diffStat: {
        files: [
          { path: 'src/a.ts', additions: 2, deletions: 1, binary: false },
          { path: 'old.ts → new.ts', additions: 0, deletions: 0, binary: false },
          { path: 'logo.png', additions: 0, deletions: 0, binary: true },
        ],
        filesChanged: 3,
        additions: 2,
        deletions: 1,
      },
      diffTruncated: false,
    });
  });

  // Git leaves spaces unquoted and appends a tab to unquoted spaced file markers.
  const spacedChanges = [
    'diff --git a/space name.txt b/space name.txt',
    'index 3367afd..3e75765 100644',
    '--- a/space name.txt\t',
    '+++ b/space name.txt\t',
    '@@ -1 +1,2 @@',
    '-old',
    '+new',
    '+added',
    'diff --git a/new file.txt b/new file.txt',
    'new file mode 100644',
    'index 0000000..3e75765',
    '--- /dev/null',
    '+++ b/new file.txt\t',
    '@@ -0,0 +1 @@',
    '+new',
    'diff --git a/deleted file.txt b/deleted file.txt',
    'deleted file mode 100644',
    'index 3367afd..0000000',
    '--- a/deleted file.txt\t',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-old',
  ].join('\n');
  const spacedFiles = [
    { path: 'space name.txt', additions: 2, deletions: 1, binary: false },
    { path: 'new file.txt', additions: 1, deletions: 0, binary: false },
    { path: 'deleted file.txt', additions: 0, deletions: 1, binary: false },
  ];

  it.each([false, true])('counts spaced changes, additions and deletions (preceding file: %s)', (preceding) => {
    const prefix = preceding
      ? 'diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-old\n+new\n'
      : '';
    expect(parseDiffStat(prefix + spacedChanges)).toEqual({
      diffStat: {
        files: preceding
          ? [{ path: 'first.txt', additions: 1, deletions: 1, binary: false }, ...spacedFiles]
          : spacedFiles,
        filesChanged: preceding ? 4 : 3,
        additions: preceding ? 4 : 3,
        deletions: preceding ? 3 : 2,
      },
      diffTruncated: false,
    });
  });

  it.each([false, true])('displays spaced renames with exact old and new names (hunks: %s)', (hunks) => {
    // Both names contain a possible header separator: metadata disambiguates it.
    const patch = [
      'diff --git a/old b/name.txt b/new b/name.txt',
      `similarity index ${hunks ? 80 : 100}%`,
      'rename from old b/name.txt',
      'rename to new b/name.txt',
      ...(hunks ? [
        'index 3367afd..3e75765 100644',
        '--- a/old b/name.txt\t',
        '+++ b/new b/name.txt\t',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ] : []),
    ].join('\n');
    expect(parseDiffStat(patch)).toEqual({
      diffStat: {
        files: [{ path: 'old b/name.txt → new b/name.txt', additions: hunks ? 1 : 0, deletions: hunks ? 1 : 0, binary: false }],
        filesChanged: 1,
        additions: hunks ? 1 : 0,
        deletions: hunks ? 1 : 0,
      },
      diffTruncated: false,
    });
  });

  it.each([
    [String.raw`tab\tname.txt`, 'tab\tname.txt'],
    [String.raw`quote\"slash\\.txt`, 'quote"slash\\.txt'],
    [String.raw`caf\303\251-\360\237\220\231.txt`, 'café-🐙.txt'],
    [String.raw`literal\\303.txt`, String.raw`literal\303.txt`],
  ])('decodes Git C-style path %s', (encoded, decoded) => {
    const patch = [
      `diff --git "a/${encoded}" "b/${encoded}"`,
      `--- "a/${encoded}"`,
      `+++ "b/${encoded}"`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDiffStat(patch)).toEqual({
      diffStat: {
        files: [{ path: decoded, additions: 1, deletions: 1, binary: false }],
        filesChanged: 1,
        additions: 1,
        deletions: 1,
      },
      diffTruncated: false,
    });
  });

  it('handles mixed quoted/unquoted rename headers and prefix-like names in rename metadata', () => {
    const patch = [
      String.raw`diff --git a/a/old name.txt "b/b/new\tname.txt"`,
      'similarity index 100%',
      'rename from a/old name.txt',
      String.raw`rename to "b/new\tname.txt"`,
      String.raw`diff --git "a/old\tname.txt" b/new name.txt`,
      'similarity index 100%',
      String.raw`rename from "old\tname.txt"`,
      'rename to new name.txt',
    ].join('\n');
    expect(parseDiffStat(patch)).toEqual({
      diffStat: {
        files: [
          { path: 'a/old name.txt → b/new\tname.txt', additions: 0, deletions: 0, binary: false },
          { path: 'old\tname.txt → new name.txt', additions: 0, deletions: 0, binary: false },
        ],
        filesChanged: 2,
        additions: 0,
        deletions: 0,
      },
      diffTruncated: false,
    });
  });

  it('preserves capped mixed-path totals, including spaced binary paths with separator-like text', () => {
    const patch = [
      spacedChanges,
      String.raw`diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"`,
      String.raw`--- "a/caf\303\251.txt"`,
      String.raw`+++ "b/caf\303\251.txt"`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/image b/icon.png b/image b/icon.png',
      'index 1a5a9d7..2d5f1c8 100644',
      'Binary files a/image b/icon.png and b/image b/icon.png differ',
    ].join('\n');
    expect(parseDiffStat(patch, 2)).toEqual({
      diffStat: { files: spacedFiles.slice(0, 2), filesChanged: 5, additions: 4, deletions: 3 },
      diffTruncated: true,
    });
    expect(parseDiffStat(patch).diffStat.files.slice(3)).toEqual([
      { path: 'café.txt', additions: 1, deletions: 1, binary: false },
      { path: 'image b/icon.png', additions: 0, deletions: 0, binary: true },
    ]);
  });

  it('counts changed source lines beginning with ++ or -- without confusing them for file markers', () => {
    const patch = [
      'diff --git a/counter.ts b/counter.ts',
      '--- a/counter.ts',
      '+++ b/counter.ts',
      '@@ -1 +1 @@',
      '---oldValue',
      '+++counter',
    ].join('\n');
    expect(parseDiffStat(patch).diffStat).toEqual({
      files: [{ path: 'counter.ts', additions: 1, deletions: 1, binary: false }],
      filesChanged: 1,
      additions: 1,
      deletions: 1,
    });
  });

  it('counts hunk lines that look like file markers ("+++ x", "--- x") as changes', () => {
    const patch = [
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,2 +1,2 @@',
      '--- old heading',
      '+++ new heading',
      ' unchanged',
    ].join('\n');
    expect(parseDiffStat(patch).diffStat).toEqual({
      files: [{ path: 'notes.md', additions: 1, deletions: 1, binary: false }],
      filesChanged: 1,
      additions: 1,
      deletions: 1,
    });
  });

  it('caps listed files while preserving totals and signals the cut', () => {
    const patch = Array.from({ length: 4 }, (_, index) =>
      `diff --git a/f${index}.ts b/f${index}.ts\n--- a/f${index}.ts\n+++ b/f${index}.ts\n@@ -1 +1 @@\n+line\n-old`,
    ).join('\n');
    const result = parseDiffStat(patch, 2);
    expect(result.diffStat.files).toHaveLength(2);
    expect(result.diffStat).toMatchObject({ filesChanged: 4, additions: 4, deletions: 4 });
    expect(result.diffTruncated).toBe(true);
  });
});
