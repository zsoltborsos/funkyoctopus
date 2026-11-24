import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import {
  HELMRAISER_DROP_CLASSES,
  type HelmraiserDropClass,
  type HelmraiserReportWindow,
  type HelmraiserScoutLens,
  type HelmraiserStatsWindow,
} from '../../../src/shared/transport/protocol.ts';
import type { MethodRegistry } from '../transport/registry.ts';
import type { HelmraiserFactory, HelmraiserRunTarget } from '../helmraiser/factory.ts';
import type { HelmraiserCli } from '../helmraiser/cli.ts';
import { readHelmraiserPlan } from '../helmraiser/plan.ts';
import { readHelmraiserRunReview } from '../helmraiser/run-review.ts';
import { config } from '../config.ts';
import { knownProjects } from '../projects/registry.ts';
import { defaultLbRunner, type LbCliRunner } from '../leeboard/cli.ts';
import { BAD_PROJECT, BAD_TASK_PATH, WireCallError } from '../../../src/shared/transport/errors.ts';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function record(params: unknown): Record<string, unknown> | undefined {
  return typeof params === 'object' && params !== null
    ? params as Record<string, unknown>
    : undefined;
}

function parseRunTarget(params: unknown): HelmraiserRunTarget {
  const p = record(params);
  const projectPath = str(p?.projectPath);
  const runId = str(p?.runId);
  if (!projectPath || !runId) throw new Error('method requires projectPath and runId');
  return { projectPath, runId };
}

function requireRunId(params: unknown): string {
  const runId = str(record(params)?.runId);
  if (!runId) throw new Error('method requires runId');
  return runId;
}

/** An omitted or blank note is no note; any defined note must be a string. */
function parseNotedAction(
  method: 'helmraiser.approve' | 'helmraiser.reject',
  params: unknown,
): { runId: string; note?: string } {
  const note = record(params)?.note;
  if (note !== undefined && typeof note !== 'string') {
    throw new Error(`${method} requires a string note`);
  }
  const runId = requireRunId(params);
  return { runId, ...(note?.trim() ? { note } : {}) };
}

/** Non-empty strings; the title is trimmed, the goal text is preserved verbatim. */
function parseDraft(params: unknown): { project: string; title: string; text: string } {
  const p = record(params);
  const project = str(p?.project);
  const title = str(p?.title);
  const text = str(p?.text);
  if (!project || !title || !text) {
    throw new Error('helmraiser.draft requires project, title and text');
  }
  const trimmed = title.trim();
  if (trimmed.length > 120) throw new Error('helmraiser.draft title is longer than 120 characters');
  if (text.length > 20_000) throw new Error('helmraiser.draft text is longer than 20,000 characters');
  return { project, title: trimmed, text };
}

/** Just a non-empty string; canonicalization is the path guard's job. */
function parseTaskPath(params: unknown): string {
  const path = record(params)?.path;
  if (typeof path !== 'string' || path === '') {
    throw new WireCallError('method requires a task path', BAD_TASK_PATH);
  }
  return path;
}

function parseQueueTask(params: unknown): { path: string; origin?: string } {
  const path = parseTaskPath(params);
  const origin = record(params)?.origin;
  if (origin !== undefined && (typeof origin !== 'string' || origin.trim() === '')) {
    throw new Error('helmraiser.queue requires a non-empty string origin when supplied');
  }
  return { path, ...(typeof origin === 'string' ? { origin } : {}) };
}

function parseDropDraft(params: unknown): { taskId: string; reason: string; dropClass?: HelmraiserDropClass } {
  const p = record(params);
  const taskId = str(p?.taskId);
  const reason = str(p?.reason);
  if (!taskId || !reason) {
    throw new Error('helmraiser.dropDraft requires a task id and reason');
  }
  const dropClass = p?.class;
  if (dropClass === undefined) return { taskId: taskId.trim(), reason: reason.trim() };
  if (!HELMRAISER_DROP_CLASSES.some((known) => known === dropClass)) {
    throw new Error(`helmraiser.dropDraft class must be one of: ${HELMRAISER_DROP_CLASSES.join(', ')}`);
  }
  return { taskId: taskId.trim(), reason: reason.trim(), dropClass: dropClass as HelmraiserDropClass };
}

function parseQueueRemove(params: unknown): string {
  const taskId = str(record(params)?.taskId);
  if (!taskId) throw new Error('helmraiser.queueRemove requires a task id');
  return taskId.trim();
}

/** Run ids are uuid4s and the CLI takes any unique prefix; nothing else may reach its argv. */
const RUN_ID_PREFIX = /^[0-9a-f][0-9a-f-]{0,35}$/i;

function parseLog(params: unknown): { runId: string; sinceId?: number } {
  const p = record(params);
  const runId = str(p?.runId)?.trim();
  if (!runId || !RUN_ID_PREFIX.test(runId)) throw new Error('helmraiser.log requires a run id');
  const sinceId = p?.sinceId;
  if (sinceId === undefined) return { runId };
  if (typeof sinceId !== 'number' || !Number.isSafeInteger(sinceId) || sinceId < 0) {
    throw new Error('helmraiser.log requires sinceId to be a non-negative integer');
  }
  return { runId, sinceId };
}

function parseRetry(params: unknown): { runId: string; implement: boolean } {
  const p = record(params);
  const runId = str(p?.runId)?.trim();
  if (!runId || !RUN_ID_PREFIX.test(runId)) throw new Error('helmraiser.retry requires a run id');
  const implement = p?.implement;
  if (implement !== undefined && typeof implement !== 'boolean') {
    throw new Error('helmraiser.retry requires implement to be a boolean');
  }
  return { runId, implement: implement === true };
}

/** Helmraiser accepts a rebase without a note, but a note itself must say something. */
function parseRework(params: unknown): { runId: string; note?: string; rebase: boolean } {
  const p = record(params);
  const runId = str(p?.runId)?.trim();
  if (!runId || !RUN_ID_PREFIX.test(runId)) throw new Error('helmraiser.rework requires a run id');
  const note = p?.note;
  if (note !== undefined && typeof note !== 'string') throw new Error('helmraiser.rework requires note to be a string');
  const rebase = p?.rebase;
  if (rebase !== undefined && typeof rebase !== 'boolean') throw new Error('helmraiser.rework requires rebase to be a boolean');
  const trimmed = note?.trim() || undefined;
  if (trimmed !== undefined && trimmed.length > 20_000) throw new Error('helmraiser.rework note is longer than 20,000 characters');
  if (trimmed === undefined && rebase !== true) throw new Error('helmraiser.rework requires a note, or a rebase');
  return { runId, ...(trimmed !== undefined ? { note: trimmed } : {}), rebase: rebase === true };
}

function parseScoutLens(method: string, params: unknown): HelmraiserScoutLens | undefined {
  const lens = record(params)?.lens;
  if (lens === undefined || lens === 'state' || lens === 'docs' || lens === 'tests' || lens === 'guardrails') return lens;
  throw new Error(`${method} lens must be one of: state, docs, tests, guardrails`);
}

function requiredScoutLens(method: string, params: unknown): HelmraiserScoutLens {
  const lens = parseScoutLens(method, params);
  if (lens === undefined) throw new Error(`${method} requires a lens`);
  return lens;
}

function parseScoutProjects(method: string, params: unknown): string[] {
  const projects = record(params)?.projects;
  if (!Array.isArray(projects) || projects.length === 0 || !projects.every(
    (project: unknown) => typeof project === 'string' && project.trim() !== ''
      && isAbsolute(project) && !project.includes('\0'),
  )) {
    throw new Error(`${method} requires a non-empty array of absolute project paths`);
  }
  return projects as string[];
}

/** Exactly one of the windows `helmraiser report --since` takes; the value reaches its argv. */
function parseReportWindow(params: unknown): HelmraiserReportWindow {
  const since = record(params)?.since;
  if (since === '24h' || since === '7d' || since === '30d') return since;
  throw new Error('helmraiser.report requires since: 24h, 7d or 30d');
}

/** Exactly one of the windows `helmraiser stats --since` takes; the value reaches its argv. */
function parseStatsParams(params: unknown): { since: HelmraiserStatsWindow; project?: string } {
  const p = record(params);
  const since = p?.since;
  if (since !== '24h' && since !== '7d' && since !== '30d' && since !== '90d' && since !== 'all') {
    throw new Error('helmraiser.stats requires since: 24h, 7d, 30d, 90d or all');
  }
  const project = p?.project;
  if (project === undefined) return { since };
  if (typeof project !== 'string' || project.trim() === '') {
    throw new Error('helmraiser.stats requires a non-empty string project when supplied');
  }
  return { since, project };
}

function requireNoParams(method: string, params: unknown): void {
  const p = record(params);
  if (params !== undefined && (!p || Array.isArray(params) || Object.keys(p).length > 0)) {
    throw new Error(`${method} takes no parameters`);
  }
}

/**
 * A task path is only usable when it is an absolute, canonical, regular `.md`
 * file whose direct parent is `<canonical-project>/.helmraiser/tasks`, where the
 * project is one known now or one this seam successfully drafted against.
 *
 * The submitted path is resolved with `realpath()` first, so `..` segments and
 * symlinks (file or parent directory) cannot smuggle the file somewhere else.
 * The expected `.helmraiser/tasks` directory itself is never canonicalized: a
 * symlinked task directory pointing outside the project must be rejected.
 */
async function guardedTaskPath(
  submitted: string,
  rememberedProjects: Set<string>,
  run: LbCliRunner,
): Promise<string> {
  if (!isAbsolute(submitted)) {
    throw new WireCallError('task path must be absolute', BAD_TASK_PATH);
  }
  let canonical: string;
  try {
    canonical = await realpath(submitted);
  } catch {
    throw new WireCallError(`task path does not exist: ${submitted}`, BAD_TASK_PATH);
  }
  const file = await stat(canonical).catch(() => null);
  if (!file?.isFile()) {
    throw new WireCallError(`task path is not a file: ${submitted}`, BAD_TASK_PATH);
  }
  if (extname(canonical) !== '.md') {
    throw new WireCallError(`task path is not a .md file: ${submitted}`, BAD_TASK_PATH);
  }

  const registry = await knownProjects(run).catch(() => []);
  const roots = new Set(rememberedProjects);
  for (const project of registry) {
    try {
      roots.add(await realpath(project.path));
    } catch {
      // A vanished registry project authorizes nothing.
    }
  }
  const parent = dirname(canonical);
  for (const root of roots) {
    if (parent === join(root, '.helmraiser', 'tasks')) return canonical;
  }
  throw new WireCallError(`task path is not inside a known project's tasks: ${submitted}`, BAD_TASK_PATH);
}

/** Helmraiser is observed and driven through the CLI; the factory is the abort path. */
export function registerWorkflowSeam(
  registry: MethodRegistry,
  factory: HelmraiserFactory,
  cli: HelmraiserCli,
  run: LbCliRunner = defaultLbRunner,
  helmraiserDataDir: string = config.helmraiserDataDir,
): void {
  // Canonical project roots this registration has successfully drafted into;
  // propose/queue stay authorized for them even if the registry read fails later.
  const draftedProjects = new Set<string>();

  registry
    .call('helmraiser.status', () => cli.status())
    .call('helmraiser.report', (params) => cli.report(parseReportWindow(params)))
    .call('helmraiser.stats', (params) => {
      const { since, project } = parseStatsParams(params);
      return project === undefined ? cli.stats(since) : cli.stats(since, project);
    })
    .call('helmraiser.drafts', (params) => {
      requireNoParams('helmraiser.drafts', params);
      return cli.drafts();
    })
    .call('helmraiser.allDrafts', (params) => {
      requireNoParams('helmraiser.allDrafts', params);
      return cli.allDrafts();
    })
    .call('helmraiser.scoutSettings', (params) => {
      requireNoParams('helmraiser.scoutSettings', params);
      return cli.scoutSettings();
    })
    .call('helmraiser.setScoutSettings', (params) => {
      const lens = requiredScoutLens('helmraiser.setScoutSettings', params);
      const p = record(params)!;
      const auto = p.auto;
      const cooldownHours = p.cooldownHours;
      if (auto !== undefined && typeof auto !== 'boolean') throw new Error('auto must be boolean');
      if (cooldownHours !== undefined && (typeof cooldownHours !== 'number' || !Number.isFinite(cooldownHours) || cooldownHours <= 0)) {
        throw new Error('cooldownHours must be finite and greater than zero');
      }
      if (auto === undefined && cooldownHours === undefined) throw new Error('requires a setting');
      return cli.setScoutSettings({ lens, ...(auto !== undefined ? { auto } : {}), ...(cooldownHours !== undefined ? { cooldownHours } : {}) });
    })
    .call('helmraiser.resetScoutSettings', (params) => cli.resetScoutSettings(requiredScoutLens('helmraiser.resetScoutSettings', params)))
    .call('helmraiser.requestScouts', (params) => {
      const projects = parseScoutProjects('helmraiser.requestScouts', params);
      const lens = parseScoutLens('helmraiser.requestScouts', params);
      return lens === undefined ? cli.requestScouts(projects) : cli.requestScouts(projects, lens);
    })
    .call('helmraiser.cancelScouts', (params) => {
      const projects = parseScoutProjects('helmraiser.cancelScouts', params);
      const lens = parseScoutLens('helmraiser.cancelScouts', params);
      return lens === undefined ? cli.cancelScouts(projects) : cli.cancelScouts(projects, lens);
    })
    .call('helmraiser.abort', (params) => factory.abort(parseRunTarget(params)))
    .call('helmraiser.plan', (params) => readHelmraiserPlan(requireRunId(params), helmraiserDataDir))
    .call('helmraiser.runReview', (params) => readHelmraiserRunReview(requireRunId(params), helmraiserDataDir))
    .call('helmraiser.log', (params) => {
      const { runId, sinceId } = parseLog(params);
      return sinceId === undefined ? cli.log(runId) : cli.log(runId, sinceId);
    })
    .call('helmraiser.approve', (params) => {
      const { runId, note } = parseNotedAction('helmraiser.approve', params);
      return cli.approve(runId, note);
    })
    .call('helmraiser.reject', (params) => {
      const { runId, note } = parseNotedAction('helmraiser.reject', params);
      return cli.reject(runId, note);
    })
    .call('helmraiser.workerStart', () => cli.startWorker())
    .call('helmraiser.workerStop', () => cli.stopWorker())
    .call('helmraiser.pause', () => cli.pause())
    .call('helmraiser.resume', () => cli.resume())
    .call('helmraiser.draft', async (params) => {
      const { project, title, text } = parseDraft(params);
      const known = await knownProjects(run).catch(() => []);
      if (!known.some((entry) => entry.path === project)) {
        throw new WireCallError(`unknown project: ${project}`, BAD_PROJECT);
      }
      const result = await cli.draft(project, title, text);
      // Only a real CLI success authorizes the project for later propose/queue.
      draftedProjects.add(await realpath(project));
      return result;
    })
    .call('helmraiser.propose', async (params) => {
      const canonical = await guardedTaskPath(parseTaskPath(params), draftedProjects, run);
      return cli.propose(canonical);
    })
    .call('helmraiser.queue', async (params) => {
      const { path, origin } = parseQueueTask(params);
      const canonical = await guardedTaskPath(path, draftedProjects, run);
      return cli.queue(canonical, origin);
    })
    .call('helmraiser.dropDraft', (params) => {
      const { taskId, reason, dropClass } = parseDropDraft(params);
      return dropClass ? cli.dropDraft(taskId, reason, dropClass) : cli.dropDraft(taskId, reason);
    })
    .call('helmraiser.queueRemove', (params) => cli.queueRemove(parseQueueRemove(params)))
    .call('helmraiser.retry', (params) => {
      const { runId, implement } = parseRetry(params);
      return cli.retry(runId, implement);
    })
    .call('helmraiser.rework', (params) => {
      const { runId, note, rebase } = parseRework(params);
      return cli.rework(runId, note, rebase);
    });
}
