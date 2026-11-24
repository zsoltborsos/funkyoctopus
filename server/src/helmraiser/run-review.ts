import { join } from 'node:path';
import { config } from '../config.ts';
import type { HelmraiserDiffStat, HelmraiserRunReview } from '../../../src/shared/transport/protocol.ts';
import { readHelmraiserRunFile, resolveHelmraiserRun } from './run-files.ts';

/** Keep an expanded row compact even for generated or vendor-heavy changes. */
export const MAX_DIFF_STAT_FILES = 100;

const C_ESCAPES: Record<string, string> = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\',
};

const unquote = (path: string): string => {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path;
  // Git quotes bytes, not Unicode code points; decode consecutive octal bytes
  // together. Matching escaped backslashes here also protects literal `\\303`.
  return path.slice(1, -1).replace(/(?:\\[0-7]{3})+|\\([abfnrtv"\\])/g, (escape: string, letter: string | undefined) =>
    letter === undefined
      ? Buffer.from(escape.split('\\').slice(1).map((octal) => parseInt(octal, 8))).toString('utf8')
      : C_ESCAPES[letter] ?? escape,
  );
};

const headerPaths = (line: string): [string, string] | null => {
  // Identical unquoted names can themselves contain ` b/`, even in binary
  // changes that have no file markers. Renames are resolved by their metadata.
  const sameName = /^diff --git a\/(.*) b\/\1$/.exec(line)?.[1];
  if (sameName !== undefined) return [sameName, sameName];
  const header = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(line);
  if (header?.[1] === undefined || header[2] === undefined) return null;
  return [unquote(header[1]).replace(/^a\//, ''), unquote(header[2]).replace(/^b\//, '')];
};

const displayPath = (oldName: string, newName: string): string =>
  oldName === newName ? newName : `${oldName} → ${newName}`;

/** Parse the bounded `git diff` text without invoking git. */
export function parseDiffStat(patch: string, cap = MAX_DIFF_STAT_FILES): {
  diffStat: HelmraiserDiffStat;
  diffTruncated: boolean;
} {
  const all: HelmraiserDiffStat['files'] = [];
  let current: HelmraiserDiffStat['files'][number] | null = null;
  let oldName = '';
  let newName = '';
  // `+`/`-` count only inside hunks: before a file's first `@@`, `--- a/…` and
  // `+++ b/…` are markers; inside one, a line such as `+++ x` is an added `++ x`.
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // Always end the preceding hunk, even if a bounded patch cuts a header.
      inHunk = false;
      current = null;
      const paths = headerPaths(line);
      if (!paths) continue;
      [oldName, newName] = paths;
      current = {
        path: displayPath(oldName, newName),
        additions: 0,
        deletions: 0,
        binary: false,
      };
      all.push(current);
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      // Rename paths have no a/b prefix. File markers do, and unquoted space
      // names have a trailing tab. /dev/null must not replace an add/delete name.
      if (line.startsWith('rename from ')) oldName = unquote(line.slice(12));
      else if (line.startsWith('rename to ')) newName = unquote(line.slice(10));
      else if (line.startsWith('--- ') && line !== '--- /dev/null') {
        oldName = unquote(line.slice(4).split('\t')[0] ?? '').replace(/^a\//, '');
      } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
        newName = unquote(line.slice(4).split('\t')[0] ?? '').replace(/^b\//, '');
      }
      current.path = displayPath(oldName, newName);
    }
    if (line.startsWith('@@')) {
      inHunk = true;
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
    } else if (inHunk && line.startsWith('+')) {
      current.additions += 1;
    } else if (inHunk && line.startsWith('-')) {
      current.deletions += 1;
    }
  }
  return {
    diffStat: {
      files: all.slice(0, cap),
      filesChanged: all.length,
      additions: all.reduce((sum, file) => sum + file.additions, 0),
      deletions: all.reduce((sum, file) => sum + file.deletions, 0),
    },
    diffTruncated: all.length > cap,
  };
}

/** Read the optional review artefacts and a bounded diff stat for one run. */
export async function readHelmraiserRunReview(
  runId: string,
  dataDir = config.helmraiserDataDir,
): Promise<HelmraiserRunReview> {
  const run = await resolveHelmraiserRun(runId, dataDir);
  const [summary, review, patch] = await Promise.all([
    readHelmraiserRunFile(run, runId, 'summary.md', true),
    readHelmraiserRunFile(run, runId, 'review.md', true),
    readHelmraiserRunFile(run, runId, 'diff.patch', true),
  ]);
  const parsed = parseDiffStat(patch?.text ?? '');
  return {
    summary: summary?.text ?? null,
    review: review?.text ?? null,
    diffStat: parsed.diffStat,
    diffTruncated: parsed.diffTruncated || (patch?.truncated ?? false),
    taskPath: join(run.runPath, 'task.md'),
  };
}
