import { LB_NOT_FOUND, LB_TIMED_OUT, type LbCliRunner } from './cli.ts';
import { UNAVAILABLE_CODES } from '../../../src/shared/transport/errors.ts';
import type {
  LeeboardAsked,
  LeeboardAskedResult,
  LeeboardBrief,
  LeeboardBriefResult,
  LeeboardEntry,
  LeeboardHoldsResult,
  LeeboardKind,
  LeeboardRepoFile,
  LeeboardReview,
  LeeboardReviewResult,
  LeeboardReviewRow,
  LeeboardShowResult,
  WireError,
} from '../../../src/shared/transport/protocol.ts';

/**
 * FO's read-only view of Leeboard, over its CLI (T3 L3, L5). FO owns no memory
 * (non-goal 7): these reads are all it does with `lb`, and none of them writes
 * anything an agent session relies on.
 *
 * Every failure is a value: `lb` missing, a non-zero exit, a timeout or output
 * that does not parse comes back as `error`, so the panel can say so and the
 * chat carries on.
 */

/** `lb show` exits 4 for an id it does not know (or one that is ambiguous). */
const LB_UNKNOWN_ID = 4;

/**
 * A full Leeboard entry id: `<kind>-<slug>-<suffix>`, lowercase letters, digits
 * and single hyphens. Checked before it reaches the CLI, so a value from the
 * browser can never be read as an option (`-x`, `--help`).
 */
const ENTRY_ID = /^(?:rule|grant|hold|reference|handoff|request)(?:-[a-z0-9]+)+$/;
const MAX_ID_LENGTH = 128;

export function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ENTRY_ID.test(value);
}

/**
 * The brief for `folder`, as FunkyOctopus. The harness names FO's display
 * reads in Leeboard's usage log, and no session is given, so the read is never
 * counted as an agent session's brief and moves no session cursor.
 */
export async function readBrief(run: LbCliRunner, folder: string): Promise<LeeboardBriefResult> {
  const out = await runJson(run, ['brief', '--json', '--harness', 'funkyoctopus', `--cwd=${folder}`]);
  if ('error' in out) return { brief: null, error: out.error };
  const brief = parseBrief(out.value);
  return brief ? { brief } : { brief: null, error: badOutput('lb brief') };
}

/** One entry with its body. The id must already have passed `isEntryId`. */
export async function readEntry(run: LbCliRunner, id: string): Promise<LeeboardShowResult> {
  const out = await runJson(run, ['show', id, '--json']);
  if ('error' in out) return { entry: null, error: out.error };
  const raw = obj(out.value);
  const entry = parseEntry(out.value);
  if (!entry || !raw || typeof raw.body !== 'string') return { entry: null, error: badOutput('lb show') };
  return { entry: { ...entry, body: raw.body } };
}

/** The owner digest. **Always `--peek`**: without it `lb review` marks the digest seen. */
export async function readReview(run: LbCliRunner): Promise<LeeboardReviewResult> {
  const out = await runJson(run, ['review', '--peek', '--json']);
  if ('error' in out) return { review: null, error: out.error };
  const raw = obj(out.value);
  if (!raw) return { review: null, error: badOutput('lb review') };
  const rows = (value: unknown): LeeboardReviewRow[] | null =>
    Array.isArray(value) ? value.map(parseReviewRow).filter((row): row is LeeboardReviewRow => row !== null) : null;
  const review: Partial<LeeboardReview> = {};
  for (const group of ['new', 'changed', 'closed'] as const) {
    const parsed = rows(raw[group]);
    if (!parsed) return { review: null, error: badOutput('lb review') };
    review[group] = parsed;
  }
  return { review: review as LeeboardReview };
}

/**
 * Active requests and handoffs, every scope (T3 L5). `lb list` takes one
 * `--kind`, so two reads. It resolves no identity and records no usage; its
 * `--harness` and `--session` filter on the *author*, so FO passes neither.
 */
export async function readActiveInbox(run: LbCliRunner): Promise<{ entries: LeeboardEntry[] } | { error: WireError }> {
  const outs = await Promise.all(
    (['request', 'handoff'] as const).map((kind) => runJson(run, ['list', `--kind=${kind}`, '--status=active', '--json'])),
  );
  const entries: LeeboardEntry[] = [];
  for (const out of outs) {
    if ('error' in out) return out;
    if (!Array.isArray(out.value)) return { error: badOutput('lb list') };
    entries.push(...out.value.map(parseEntry).filter((entry): entry is LeeboardEntry => entry !== null));
  }
  // Newest first across both kinds, as `lb list` orders each.
  return { entries: entries.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0)) };
}

/** Active holds across every scope, without author or folder filters. */
export async function readActiveHolds(run: LbCliRunner): Promise<LeeboardHoldsResult> {
  const out = await runJson(run, ['list', '--kind=hold', '--status=active', '--json']);
  if ('error' in out) return { holds: null, error: out.error };
  if (!Array.isArray(out.value)) return { holds: null, error: badOutput('lb list') };
  const now = Date.now();
  const holds = out.value.map(parseEntry).filter((entry): entry is LeeboardEntry => {
    if (!entry || entry.kind !== 'hold' || entry.status !== 'active') return false;
    // Mirrors Leeboard's isActive: date-only expiry ends at UTC day's end;
    // unreadable expiry and equality with the expiry instant stay active.
    if (!entry.until) return true;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(entry.until) ? `${entry.until}T23:59:59.999Z` : entry.until;
    return !(now > Date.parse(end));
  });
  return { holds: holds.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0)) };
}

/**
 * A session id as an engine mints one (a UUID for both pi and Claude Code):
 * checked before it reaches the CLI, so it can never be read as an option.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** Where Leeboard appends an answer to a request (`lb reply`): `## Reply (<when>, <who>)`. */
const REPLY_SECTION = /^## Reply \(/m;

/**
 * The requests `session` authored, newest first, each marked replied when it
 * is done or its body carries a reply. `--session` here is `lb list`'s author
 * filter, not FO's identity. Only active requests need their body read.
 */
export async function readAsked(run: LbCliRunner, session: string): Promise<LeeboardAskedResult> {
  if (!isSessionId(session)) return { asked: [] };
  const out = await runJson(run, ['list', '--kind=request', `--session=${session}`, '--json']);
  if ('error' in out) return { asked: null, error: out.error };
  if (!Array.isArray(out.value)) return { asked: null, error: badOutput('lb list') };
  const requests = out.value.map(parseEntry).filter((entry): entry is LeeboardEntry => entry !== null);
  const asked = await Promise.all(
    requests.map(async (request): Promise<LeeboardAsked> => {
      if (request.status !== 'active') return { ...request, replied: request.status === 'done' };
      // One unreadable body leaves that request unanswered, never the list unread.
      const shown = await readEntry(run, request.id);
      return { ...request, replied: shown.entry !== null && REPLY_SECTION.test(shown.entry.body) };
    }),
  );
  return { asked };
}

async function runJson(run: LbCliRunner, args: string[]): Promise<{ value: unknown } | { error: WireError }> {
  const command = `lb ${args[0]}`;
  const result = await run(args).catch((e: unknown) => ({
    code: 1,
    stdout: '',
    stderr: e instanceof Error ? e.message : String(e),
  }));
  if (result.code === LB_NOT_FOUND) {
    return { error: { code: UNAVAILABLE_CODES.leeboard, message: 'lb was not found on PATH' } };
  }
  if (result.code === LB_TIMED_OUT) return { error: { code: 'leeboard_timeout', message: `${command} timed out` } };
  if (result.code === LB_UNKNOWN_ID && args[0] === 'show') {
    return { error: { code: 'leeboard_unknown_id', message: firstLine(result.stderr) || 'no such entry' } };
  }
  if (result.code !== 0) {
    const detail = firstLine(result.stderr);
    return { error: { code: 'leeboard_failed', message: `${command} exited ${result.code}${detail ? `: ${detail}` : ''}` } };
  }
  try {
    return { value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { error: badOutput(command) };
  }
}

const badOutput = (command: string): WireError => ({
  code: 'leeboard_bad_output',
  message: `${command} printed something FunkyOctopus cannot read`,
});

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const KINDS: readonly LeeboardKind[] = ['rule', 'grant', 'hold', 'reference', 'handoff', 'request'];
const str = (value: unknown): value is string => typeof value === 'string';

/** An entry line, or null when its required fields are missing: one bad row never hides the rest. */
function parseEntry(value: unknown): LeeboardEntry | null {
  const raw = obj(value);
  if (!raw || !isEntryId(raw.id) || !str(raw.title) || !str(raw.scope) || !str(raw.status)) return null;
  const kind = KINDS.find((k) => k === raw.kind);
  if (!kind) return null;
  const author = obj(raw.author);
  const entry: LeeboardEntry = {
    id: raw.id,
    kind,
    scope: raw.scope,
    status: raw.status,
    title: raw.title,
    harness: author && str(author.harness) ? author.harness : null,
    created: str(raw.created) ? raw.created : '',
    updated: str(raw.updated) ? raw.updated : '',
  };
  if (author && str(author.session)) entry.session = author.session;
  if (str(raw.release)) entry.release = raw.release;
  if (Array.isArray(raw.blocks)) entry.blocks = raw.blocks.filter(str);
  if (str(raw.until)) entry.until = raw.until;
  if (str(raw.holder)) entry.holder = raw.holder;
  if (str(raw.to)) entry.to = raw.to;
  return entry;
}

function parseReviewRow(value: unknown): LeeboardReviewRow | null {
  const raw = obj(value);
  if (!raw || !isEntryId(raw.id) || !str(raw.title)) return null;
  return {
    id: raw.id,
    kind: str(raw.kind) ? raw.kind : '',
    scope: str(raw.scope) ? raw.scope : '',
    title: raw.title,
    status: str(raw.status) ? raw.status : '',
  };
}

function parseRepoFile(value: unknown): LeeboardRepoFile | null {
  const raw = obj(value);
  if (!raw || !str(raw.path) || !(raw.lastCommit === null || str(raw.lastCommit))) return null;
  const file: LeeboardRepoFile = { path: raw.path, lastCommit: raw.lastCommit };
  if (typeof raw.daysAgo === 'number') file.daysAgo = raw.daysAgo;
  if (typeof raw.commitsSince === 'number') file.commitsSince = raw.commitsSince;
  return file;
}

/** The brief, or null when its shape is not Leeboard's: a list that is not a list is not "empty". */
function parseBrief(value: unknown): LeeboardBrief | null {
  const raw = obj(value);
  if (!raw) return null;
  if (!(raw.project === null || str(raw.project))) return null;
  const lists = ['holds', 'grants', 'rules', 'references', 'inbox'] as const;
  if (lists.some((key) => !Array.isArray(raw[key]))) return null;
  const entries = (key: (typeof lists)[number]): LeeboardEntry[] =>
    (raw[key] as unknown[]).map(parseEntry).filter((entry): entry is LeeboardEntry => entry !== null);
  return {
    project: raw.project,
    unregisteredRepo: str(raw.unregisteredRepo) ? raw.unregisteredRepo : null,
    holds: entries('holds'),
    grants: entries('grants'),
    rules: entries('rules'),
    references: entries('references'),
    inbox: entries('inbox'),
    repoState: Array.isArray(raw.repoState)
      ? raw.repoState.map(parseRepoFile).filter((file): file is LeeboardRepoFile => file !== null)
      : [],
  };
}
