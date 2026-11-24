import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MethodRegistry } from '../transport/registry.ts';
import { registerWorkflowSeam } from './workflow.ts';
import type { HelmraiserFactory } from '../helmraiser/factory.ts';
import { HelmraiserCli } from '../helmraiser/cli.ts';
import { vaultBeforeSpawn } from '../helmraiser/factory.ts';
import { VaultGuard } from '../security/vault.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';
import type { LbCliRunner } from '../leeboard/cli.ts';

function handler(registry: MethodRegistry, name: string) {
  const entry = registry.get(name);
  if (!entry || entry.kind !== 'call') throw new Error(`missing call ${name}`);
  return (params: unknown) => entry.handler(params, { signal: new AbortController().signal });
}

/** Code of a thrown value, for asserting the typed wire codes. */

function setup(run: LbCliRunner = fakeRegistry().run, helmraiserDataDir?: string) {
  const abort = vi.fn().mockResolvedValue(undefined);
  const status = vi.fn().mockResolvedValue({ queued_count: 1 });
  const report = vi.fn().mockResolvedValue({ since: '7d', landed_count: 3 });
  const stats = vi.fn().mockResolvedValue({ window: { since: 'all' }, scouts: [] });
  const drafts = vi.fn().mockResolvedValue([{ id: 'scouted-1' }]);
  const requestScouts = vi.fn().mockResolvedValue({ requested: ['/a'], already_pending: ['/b'] });
  const cancelScouts = vi.fn().mockResolvedValue({ cancelled: ['/a'], not_pending: ['/b'] });
  const approve = vi.fn().mockResolvedValue({ approved: true });
  const reject = vi.fn().mockResolvedValue({ rejected: true });
  const startWorker = vi.fn().mockResolvedValue({ state: 'running' });
  const stopWorker = vi.fn().mockResolvedValue({ state: 'stopped' });
  const pause = vi.fn().mockResolvedValue({ paused: true });
  const resume = vi.fn().mockResolvedValue({ paused: false });
  const draft = vi.fn().mockImplementation((project: string) => Promise.resolve({
    task_id: `t:${project}`,
    id: 'x',
    status: 'draft',
    path: join(project, '.helmraiser', 'tasks', 'x.md'),
  }));
  const propose = vi.fn().mockResolvedValue({ status: 'draft', proposal: {} });
  const queue = vi.fn().mockResolvedValue({ status: 'queued' });
  const dropDraft = vi.fn().mockResolvedValue({ status: 'dropped' });
  const queueRemove = vi.fn().mockResolvedValue({ task_id: 'repo:x', status: 'draft' });
  const log = vi.fn().mockResolvedValue({ events: [], truncated: false });
  const retry = vi.fn().mockResolvedValue({ retried: 'blocked: x', run_id: 'r', status: 'resuming', stage: 'verify', worker_serves_project: true });
  const rework = vi.fn().mockResolvedValue({ reworked: 'merge', run_id: 'r', status: 'resuming', stage: 'implement', worker_serves_project: true });
  const factory = { abort } as unknown as HelmraiserFactory;
  const cli = { status, report, stats, drafts, requestScouts, cancelScouts, approve, reject, startWorker, stopWorker, pause, resume, draft, propose, queue, dropDraft, queueRemove, log, retry, rework } as unknown as HelmraiserCli;
  const registry = new MethodRegistry();
  registerWorkflowSeam(registry, factory, cli, run, helmraiserDataDir);
  return {
    registry,
    spies: { abort, status, report, stats, drafts, requestScouts, cancelScouts, approve, reject, startWorker, stopWorker, pause, resume, draft, propose, queue, dropDraft, queueRemove, log, retry, rework },
  };
}

/** A fake `lb project list --json` runner whose answer tests can change between calls. */
function fakeRegistry(initial: { name: string; path: string }[] = []): {
  run: LbCliRunner;
  setProjects: (projects: { name: string; path: string }[]) => void;
} {
  let projects = initial;
  const run: LbCliRunner = vi.fn((args) => {
    expect(args).toEqual(['project', 'list', '--json']);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify(projects.map((p) => ({
        name: p.name, aliases: [], paths: [p.path + '-former', p.path], remotes: [],
      }))),
      stderr: '',
    });
  });
  return { run, setProjects: (next) => { projects = next; } };
}

describe('Scout settings seams', () => {
  function settingsSeam() {
    const runner = vi.fn().mockResolvedValue({ lenses: {} });
    const guard = vi.fn().mockResolvedValue(undefined);
    const cli = new HelmraiserCli(runner, guard);
    const registry = new MethodRegistry();
    registerWorkflowSeam(registry, {} as HelmraiserFactory, cli, fakeRegistry().run);
    return { runner, guard, call: (name: string, params?: unknown) => handler(registry, `helmraiser.${name}`)(params) };
  }
  it('reads without guard and writes exact guarded args', async () => {
    const { call, guard, runner } = settingsSeam();
    await call('scoutSettings'); await call('allDrafts');
    expect(guard).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledWith(['drafts', 'settings', '--json']);
    expect(runner).toHaveBeenCalledWith(['drafts', '--all', '--json']);
    for (const lens of ['state', 'docs', 'tests', 'guardrails']) {
      await call('setScoutSettings', { lens, auto: false, cooldownHours: 0.5 });
      expect(guard).toHaveBeenLastCalledWith(['drafts', 'settings', 'set', lens, '--auto', 'off', '--cooldown-hours', '0.5', '--json']);
      await call('resetScoutSettings', { lens });
      expect(guard).toHaveBeenLastCalledWith(['drafts', 'settings', 'reset', lens, '--json']);
    }
    guard.mockRejectedValue(new Error('vault refused'));
    runner.mockClear();
    await expect(call('setScoutSettings', { lens: 'state', auto: true })).rejects.toThrow('vault refused');
    expect(runner).not.toHaveBeenCalled();
  });
  it.each([undefined, null, [], 'state', {}, { lens: null }, { lens: 'other' }, { lens: 'Guardrails' },
    { lens: 'state', auto: 1 }, ...[0, -1, NaN, Infinity, -Infinity, '2', null].map((cooldownHours) => ({ lens: 'state', cooldownHours }))])('rejects invalid update %j before spawning', async (params) => {
    const { call, runner, guard } = settingsSeam();
    await expect(async () => { await call('setScoutSettings', params); }).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled();
  });
});

describe('Scout seams', () => {
  const methods = ['requestScouts', 'cancelScouts'] as const;
  it.each(methods)('%s preserves exact paths and results', async (method) => {
    const { registry, spies } = setup();
    const projects = ['/workspace/repo one', '/workspace/repo-two/'];
    const result = await handler(registry, `helmraiser.${method}`)({ projects });
    expect(result).toBe(await spies[method].mock.results[0]?.value);
    expect(spies[method]).toHaveBeenCalledExactlyOnceWith(projects);
  });

  it.each(methods)('%s validates and forwards lenses', async (method) => {
    const { registry, spies } = setup();
    for (const lens of ['state', 'docs', 'tests', 'guardrails']) {
      await handler(registry, `helmraiser.${method}`)({ projects: ['/a'], lens });
      expect(spies[method]).toHaveBeenLastCalledWith(['/a'], lens);
    }
    spies.requestScouts.mockClear();
    spies.cancelScouts.mockClear();
    for (const lens of [null, '', ' docs ', 'unknown', 1, true, [], {}]) {
      expect(() => handler(registry, `helmraiser.${method}`)({ projects: ['/a'], lens })).toThrow('lens must be one of: state, docs, tests, guardrails');
    }
    expect(spies.requestScouts).not.toHaveBeenCalled();
    expect(spies.cancelScouts).not.toHaveBeenCalled();
  });

  it.each(methods)('%s validates before either CLI action', (method) => {
    const { registry, spies } = setup();
    for (const params of [undefined, {}, { projects: 'x' }, { projects: [] },
      { projects: [3] }, { projects: [''] }, { projects: ['  '] },
      { projects: ['relative'] }, { projects: ['/a\0b'] }]) {
      expect(() => handler(registry, `helmraiser.${method}`)(params)).toThrow(`helmraiser.${method}`);
    }
    expect(spies.requestScouts).not.toHaveBeenCalled();
    expect(spies.cancelScouts).not.toHaveBeenCalled();
  });

  it.each(methods)('%s uses actual Vault approval/denial before its runner', async (method) => {
    for (const action of ['block', 'escalate'] as const) {
      const runner = vi.fn().mockResolvedValue({});
      let approve = false;
      const escalation = vi.fn(() => Promise.resolve(approve));
      const guard = new VaultGuard([{ target: '/fixture/protected', action }], escalation);
      const registry = new MethodRegistry();
      const cli = new HelmraiserCli(runner, vaultBeforeSpawn(guard));
      registerWorkflowSeam(registry, {} as HelmraiserFactory, cli);
      await expect(handler(registry, `helmraiser.${method}`)({ projects: ['/fixture/protected'], lens: 'docs' }))
        .rejects.toThrow(action === 'block' ? 'Vault blocked' : 'Vault denied');
      expect(runner).not.toHaveBeenCalled();
      if (action === 'escalate') {
        approve = true;
        await handler(registry, `helmraiser.${method}`)({ projects: ['/fixture/protected'], lens: 'docs' });
        expect(escalation).toHaveBeenCalledTimes(2);
        expect(runner).toHaveBeenCalledOnce();
      }
    }
  });

  it.each(methods)('%s preserves coded exit-2 refusals through registration', async (method) => {
    const refusal = new WireCallError('project is paused: /fixture/paused', 'helmraiser_cli_error');
    const registry = new MethodRegistry();
    registerWorkflowSeam(registry, {} as HelmraiserFactory,
      new HelmraiserCli(vi.fn().mockRejectedValue(refusal), vaultBeforeSpawn(new VaultGuard([], () => Promise.resolve(false)))));
    await expect(handler(registry, `helmraiser.${method}`)({ projects: ['/fixture/paused'], lens: 'tests' })).rejects.toBe(refusal);
  });
});

describe('workflow seam', () => {
  it('routes helmraiser.status to the CLI client', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.status')(undefined)).resolves.toEqual({ queued_count: 1 });
    expect(spies.status).toHaveBeenCalledOnce();
  });

  it.each(['24h', '7d', '30d'])('routes helmraiser.report for %s to the CLI client and returns its report', async (since) => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.report')({ since })).resolves.toEqual({ since: '7d', landed_count: 3 });
    expect(spies.report).toHaveBeenCalledExactlyOnceWith(since);
  });

  it.each([undefined, null, {}, [], '7d', { since: undefined }, { since: null }, { since: '1d' },
    { since: ' 7d' }, { since: '7D' }, { since: '' }, { since: 7 }, { since: ['7d'] }, { since: '7d; rm -rf' }])(
    'rejects helmraiser.report params %j before it reaches the CLI', (params) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.report')(params)).toThrow('helmraiser.report requires since: 24h, 7d or 30d');
      expect(spies.report).not.toHaveBeenCalled();
    });

  it('reads the report without the action guard, with the report argv', async () => {
    const runner = vi.fn().mockResolvedValue({
      generated_at: 'now', landed: [], awaiting: [], failed: [], cost: { total_usd: 0, by_model: {} }, models: [],
    });
    const guard = vi.fn().mockResolvedValue(undefined);
    const registry = new MethodRegistry();
    registerWorkflowSeam(registry, {} as HelmraiserFactory, new HelmraiserCli(runner, guard), fakeRegistry().run);
    await expect(handler(registry, 'helmraiser.report')({ since: '30d' })).resolves.toMatchObject({ since: '30d', landed_count: 0 });
    expect(runner).toHaveBeenCalledExactlyOnceWith(['report', '--since', '30d', '--json', '--models'], { timeoutMs: 300_000 });
    expect(guard).not.toHaveBeenCalled();
  });

  it.each(['24h', '7d', '30d', '90d', 'all'])('routes helmraiser.stats for %s to the CLI client and returns its stats', async (since) => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.stats')({ since })).resolves.toEqual({ window: { since: 'all' }, scouts: [] });
    expect(spies.stats).toHaveBeenCalledExactlyOnceWith(since);
  });

  it('passes a project filter through, a path with spaces untouched', async () => {
    const { registry, spies } = setup();
    await handler(registry, 'helmraiser.stats')({ since: '30d', project: '/work/repo one' });
    expect(spies.stats).toHaveBeenCalledExactlyOnceWith('30d', '/work/repo one');
  });

  it.each([undefined, null, {}, [], 'all', { since: undefined }, { since: null }, { since: '1d' }, { since: '12h' },
    { since: ' all' }, { since: 'ALL' }, { since: '' }, { since: 7 }, { since: ['all'] }, { since: '7d; rm -rf' }])(
    'rejects helmraiser.stats params %j before it reaches the CLI', (params) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.stats')(params)).toThrow('helmraiser.stats requires since: 24h, 7d, 30d, 90d or all');
      expect(spies.stats).not.toHaveBeenCalled();
    });

  it.each([null, '', '   ', 7, ['/a'], {}, true])('rejects a helmraiser.stats project of %j before it reaches the CLI', (project) => {
    const { registry, spies } = setup();
    expect(() => handler(registry, 'helmraiser.stats')({ since: 'all', project })).toThrow('helmraiser.stats requires a non-empty string project when supplied');
    expect(spies.stats).not.toHaveBeenCalled();
  });

  it('reads the stats without the action guard or a custom timeout, with the stats argv', async () => {
    const stats = { window: { since: '90d', project: '/work/repo one' }, scouts: [] };
    const runner = vi.fn().mockResolvedValue(stats);
    const guard = vi.fn().mockResolvedValue(undefined);
    const registry = new MethodRegistry();
    registerWorkflowSeam(registry, {} as HelmraiserFactory, new HelmraiserCli(runner, guard), fakeRegistry().run);
    await expect(handler(registry, 'helmraiser.stats')({ since: '90d', project: '/work/repo one' })).resolves.toBe(stats);
    expect(runner).toHaveBeenCalledExactlyOnceWith(['stats', '--since', '90d', '--json', '--project', '/work/repo one']);
    expect(guard).not.toHaveBeenCalled();
  });

  it('routes parameter-free helmraiser.drafts to the CLI client', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.drafts')(undefined)).resolves.toEqual([{ id: 'scouted-1' }]);
    await expect(handler(registry, 'helmraiser.drafts')({})).resolves.toEqual([{ id: 'scouted-1' }]);
    expect(() => handler(registry, 'helmraiser.drafts')({ unexpected: true })).toThrow('takes no parameters');
    expect(() => handler(registry, 'helmraiser.drafts')([])).toThrow('takes no parameters');
    expect(spies.drafts).toHaveBeenCalledTimes(2);
  });

  it('validates and routes draft drops by ledger task id', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.dropDraft')({ taskId: ' repo:draft ', reason: ' no longer relevant ' }))
      .resolves.toEqual({ status: 'dropped' });
    expect(spies.dropDraft).toHaveBeenCalledWith('repo:draft', 'no longer relevant');
    for (const params of [undefined, { taskId: '', reason: 'why' }, { taskId: 'x', reason: 3 }, { taskId: 'x', reason: '   ' }]) {
      expect(() => handler(registry, 'helmraiser.dropDraft')(params)).toThrow('task id and reason');
    }
    expect(spies.dropDraft).toHaveBeenCalledOnce();
  });

  it('calls the CLI with exactly the task id and reason when no class is given', async () => {
    const { registry, spies } = setup();
    await handler(registry, 'helmraiser.dropDraft')({ taskId: 'repo:draft', reason: 'obsolete' });
    await handler(registry, 'helmraiser.dropDraft')({ taskId: 'repo:draft', reason: 'obsolete', class: undefined });
    expect(spies.dropDraft.mock.calls).toEqual([['repo:draft', 'obsolete'], ['repo:draft', 'obsolete']]);
    expect(spies.dropDraft.mock.calls.map((call) => call.length)).toEqual([2, 2]);
  });

  it.each(['wrong', 'unwanted', 'duplicate', 'unusable'])('passes the %s drop class through to the CLI', async (dropClass) => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.dropDraft')({ taskId: ' repo:draft ', reason: ' not real ', class: dropClass }))
      .resolves.toEqual({ status: 'dropped' });
    expect(spies.dropDraft).toHaveBeenCalledExactlyOnceWith('repo:draft', 'not real', dropClass);
  });

  it.each([['bogus'], [''], ['WRONG'], [3], [null], [['wrong']]])('refuses the drop class %j and never calls the CLI', (dropClass) => {
    const { registry, spies } = setup();
    expect(() => handler(registry, 'helmraiser.dropDraft')({ taskId: 'repo:draft', reason: 'why', class: dropClass }))
      .toThrow('helmraiser.dropDraft class must be one of: wrong, unwanted, duplicate, unusable');
    expect(spies.dropDraft).not.toHaveBeenCalled();
  });

  it('validates and routes queue removals by full ledger task id', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.queueRemove')({ taskId: ' -home-example-projects-demo-api:board-sync ' }))
      .resolves.toEqual({ task_id: 'repo:x', status: 'draft' });
    expect(spies.queueRemove).toHaveBeenCalledExactlyOnceWith('-home-example-projects-demo-api:board-sync');
    for (const params of [undefined, {}, { taskId: '' }, { taskId: '   ' }, { taskId: 3 }]) {
      expect(() => handler(registry, 'helmraiser.queueRemove')(params)).toThrow('helmraiser.queueRemove requires a task id');
    }
    expect(spies.queueRemove).toHaveBeenCalledOnce();
  });

  it('routes the run log read, trimming the run id and passing an optional cursor', async () => {
    const { registry, spies } = setup();
    const result = { events: [{ id: 1, ts: 1, source: 'helmraiser', stage: null, type: 'run_start', payload: {} }], truncated: false };
    spies.log.mockResolvedValue(result);
    await expect(handler(registry, 'helmraiser.log')({ runId: ' 142d660e ' })).resolves.toBe(result);
    expect(spies.log).toHaveBeenLastCalledWith('142d660e');
    await handler(registry, 'helmraiser.log')({ runId: '142d660e-8ed6-4338-9413-5ad16510baaa', sinceId: 338270 });
    expect(spies.log).toHaveBeenLastCalledWith('142d660e-8ed6-4338-9413-5ad16510baaa', 338270);
    await handler(registry, 'helmraiser.log')({ runId: 'a', sinceId: 0 });
    expect(spies.log).toHaveBeenLastCalledWith('a', 0);
    expect(spies.log).toHaveBeenCalledTimes(3);
  });

  it.each([
    undefined, {}, { runId: '' }, { runId: '   ' }, { runId: 3 },
    // Anything helmraiser's parser could read as an option, a path or a second argument.
    { runId: '-h' }, { runId: '--follow' }, { runId: '-142d660e' }, { runId: '../142d660e' }, { runId: '142d660e --json' },
    { runId: '142d660e\n--follow' }, { runId: 'not-hex' }, { runId: `${'a'.repeat(36)}b` },
  ])('rejects run log params %j without running helmraiser', (params) => {
    const { registry, spies } = setup();
    expect(() => handler(registry, 'helmraiser.log')(params)).toThrow('helmraiser.log requires a run id');
    expect(spies.log).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, '5', null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])('rejects the run log cursor %j', (sinceId) => {
    const { registry, spies } = setup();
    expect(() => handler(registry, 'helmraiser.log')({ runId: '142d660e', sinceId })).toThrow('helmraiser.log requires sinceId to be a non-negative integer');
    expect(spies.log).not.toHaveBeenCalled();
  });

  describe('helmraiser.retry', () => {
    const RUN = '142d660e-8ed6-4338-9413-5ad16510baaa';

    it('routes the trimmed run id to the CLI, resuming at verify unless implement is true', async () => {
      const { registry, spies } = setup();
      const result = { retried: 'blocked: x', run_id: RUN, status: 'resuming', stage: 'verify', worker_serves_project: false };
      spies.retry.mockResolvedValue(result);
      await expect(handler(registry, 'helmraiser.retry')({ runId: ` ${RUN} ` })).resolves.toBe(result);
      expect(spies.retry).toHaveBeenLastCalledWith(RUN, false);
      await handler(registry, 'helmraiser.retry')({ runId: '142d660e', implement: false });
      expect(spies.retry).toHaveBeenLastCalledWith('142d660e', false);
      await handler(registry, 'helmraiser.retry')({ runId: '142d660e', implement: true });
      expect(spies.retry).toHaveBeenLastCalledWith('142d660e', true);
      expect(spies.retry).toHaveBeenCalledTimes(3);
    });

    it.each([
      undefined, {}, { runId: '' }, { runId: '   ' }, { runId: 3 },
      // Anything helmraiser's parser could read as an option, a path or a second argument.
      { runId: '-h' }, { runId: '--implement' }, { runId: '-142d660e' }, { runId: '../142d660e' }, { runId: '142d660e --implement' },
      { runId: '142d660e\n--implement' }, { runId: 'not-hex' }, { runId: `${'a'.repeat(36)}b` },
    ])('rejects retry params %j without running helmraiser', (params) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.retry')(params)).toThrow('helmraiser.retry requires a run id');
      expect(spies.retry).not.toHaveBeenCalled();
    });

    it.each(['true', 1, 0, null, {}, []])('rejects implement %j, which is not a boolean', (implement) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.retry')({ runId: RUN, implement })).toThrow('helmraiser.retry requires implement to be a boolean');
      expect(spies.retry).not.toHaveBeenCalled();
    });

    it('uses actual Vault approval/denial before its runner', async () => {
      for (const action of ['block', 'escalate'] as const) {
        const runner = vi.fn().mockResolvedValue({});
        let approve = false;
        const escalation = vi.fn(() => Promise.resolve(approve));
        const guard = new VaultGuard([{ target: RUN, action }], escalation);
        const registry = new MethodRegistry();
        registerWorkflowSeam(registry, {} as HelmraiserFactory, new HelmraiserCli(runner, vaultBeforeSpawn(guard)));
        await expect(handler(registry, 'helmraiser.retry')({ runId: RUN, implement: true }))
          .rejects.toThrow(action === 'block' ? 'Vault blocked' : 'Vault denied');
        expect(runner).not.toHaveBeenCalled();
        if (action === 'escalate') {
          approve = true;
          await handler(registry, 'helmraiser.retry')({ runId: RUN, implement: true });
          expect(escalation).toHaveBeenCalledTimes(2);
          expect(runner).toHaveBeenCalledExactlyOnceWith(['retry', RUN, '--implement', '--json'], undefined);
        }
      }
    });

    it('preserves the CLI refusal through registration', async () => {
      const refusal = new WireCallError(`helmraiser retry failed: run ${RUN} failed with rejected; retry is only for a run that was blocked or failed verify`, 'helmraiser_cli_error');
      const registry = new MethodRegistry();
      registerWorkflowSeam(registry, {} as HelmraiserFactory,
        new HelmraiserCli(vi.fn().mockRejectedValue(refusal), vaultBeforeSpawn(new VaultGuard([], () => Promise.resolve(false)))));
      await expect(handler(registry, 'helmraiser.retry')({ runId: RUN })).rejects.toBe(refusal);
    });
  });

  describe('helmraiser.rework', () => {
    const RUN = '865c36b8-a39d-433a-bc6c-87b1715d14e2';

    it('routes the trimmed run id and note to the CLI, rebasing only when asked', async () => {
      const { registry, spies } = setup();
      const result = { reworked: 'merge', run_id: RUN, status: 'resuming', stage: 'implement', worker: 'none', worker_serves_project: false };
      spies.rework.mockResolvedValue(result);
      await expect(handler(registry, 'helmraiser.rework')({ runId: ` ${RUN} `, note: '  clarify the widget \n' })).resolves.toBe(result);
      expect(spies.rework).toHaveBeenLastCalledWith(RUN, 'clarify the widget', false);
      await handler(registry, 'helmraiser.rework')({ runId: '865c36b8', note: 'keep the 30 s limit', rebase: false });
      expect(spies.rework).toHaveBeenLastCalledWith('865c36b8', 'keep the 30 s limit', false);
      await handler(registry, 'helmraiser.rework')({ runId: '865c36b8', note: 'keep the 30 s limit', rebase: true });
      expect(spies.rework).toHaveBeenLastCalledWith('865c36b8', 'keep the 30 s limit', true);
      expect(spies.rework).toHaveBeenCalledTimes(3);
    });

    it('lets a rebase stand without a note, since helmraiser supplies its own, and ignores a blank one', async () => {
      const { registry, spies } = setup();
      await handler(registry, 'helmraiser.rework')({ runId: RUN, rebase: true });
      expect(spies.rework).toHaveBeenLastCalledWith(RUN, undefined, true);
      await handler(registry, 'helmraiser.rework')({ runId: RUN, note: ' \n\t', rebase: true });
      expect(spies.rework).toHaveBeenLastCalledWith(RUN, undefined, true);
    });

    it.each([
      undefined, {}, { note: 'fix', rebase: true }, { runId: '', note: 'fix' }, { runId: '   ', note: 'fix' }, { runId: 3, note: 'fix' },
      // Anything helmraiser's parser could read as an option, a path or a second argument.
      { runId: '-h', note: 'fix' }, { runId: '--rebase', note: 'fix' }, { runId: '-865c36b8', note: 'fix' }, { runId: '../865c36b8', note: 'fix' },
      { runId: '865c36b8 --rebase', note: 'fix' }, { runId: '865c36b8\n--rebase', note: 'fix' }, { runId: 'not-hex', note: 'fix' }, { runId: `${'a'.repeat(36)}b`, note: 'fix' },
    ])('rejects rework params %j without running helmraiser', (params) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.rework')(params)).toThrow('helmraiser.rework requires a run id');
      expect(spies.rework).not.toHaveBeenCalled();
    });

    it.each([
      [{ runId: RUN }],
      [{ runId: RUN, note: '' }],
      [{ runId: RUN, note: '  \n\t ' }],
      [{ runId: RUN, note: '   ', rebase: false }],
    ])('rejects %j: with no rebase there must be a note', (params) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.rework')(params)).toThrow('helmraiser.rework requires a note, or a rebase');
      expect(spies.rework).not.toHaveBeenCalled();
    });

    it.each([3, true, null, {}, ['fix'], []])('rejects note %j, which is not a string', (note) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.rework')({ runId: RUN, note })).toThrow('helmraiser.rework requires note to be a string');
      expect(spies.rework).not.toHaveBeenCalled();
    });

    it.each(['true', 1, 0, null, {}, []])('rejects rebase %j, which is not a boolean', (rebase) => {
      const { registry, spies } = setup();
      expect(() => handler(registry, 'helmraiser.rework')({ runId: RUN, note: 'fix', rebase })).toThrow('helmraiser.rework requires rebase to be a boolean');
      expect(spies.rework).not.toHaveBeenCalled();
    });

    it('bounds the note: 20,000 characters pass, one more does not', async () => {
      const { registry, spies } = setup();
      await handler(registry, 'helmraiser.rework')({ runId: RUN, note: 'n'.repeat(20_000) });
      expect(spies.rework).toHaveBeenCalledOnce();
      expect(() => handler(registry, 'helmraiser.rework')({ runId: RUN, note: 'n'.repeat(20_001) })).toThrow('helmraiser.rework note is longer than 20,000 characters');
      expect(spies.rework).toHaveBeenCalledOnce();
    });

    it('uses actual Vault approval/denial before its runner', async () => {
      for (const action of ['block', 'escalate'] as const) {
        const runner = vi.fn().mockResolvedValue({});
        let approve = false;
        const escalation = vi.fn(() => Promise.resolve(approve));
        const guard = new VaultGuard([{ target: RUN, action }], escalation);
        const registry = new MethodRegistry();
        registerWorkflowSeam(registry, {} as HelmraiserFactory, new HelmraiserCli(runner, vaultBeforeSpawn(guard)));
        await expect(handler(registry, 'helmraiser.rework')({ runId: RUN, note: 'fix', rebase: true }))
          .rejects.toThrow(action === 'block' ? 'Vault blocked' : 'Vault denied');
        expect(runner).not.toHaveBeenCalled();
        if (action === 'escalate') {
          approve = true;
          await handler(registry, 'helmraiser.rework')({ runId: RUN, note: 'fix', rebase: true });
          expect(escalation).toHaveBeenCalledTimes(2);
          expect(runner).toHaveBeenCalledExactlyOnceWith(['rework', RUN, '--note', 'fix', '--rebase', '--json'], undefined);
        }
      }
    });

    it('preserves the CLI refusal through registration', async () => {
      const refusal = new WireCallError(`helmraiser rework failed: run ${RUN} requires a pending merge approval for rework (not a plan approval)`, 'helmraiser_cli_error');
      const registry = new MethodRegistry();
      registerWorkflowSeam(registry, {} as HelmraiserFactory,
        new HelmraiserCli(vi.fn().mockRejectedValue(refusal), vaultBeforeSpawn(new VaultGuard([], () => Promise.resolve(false)))));
      await expect(handler(registry, 'helmraiser.rework')({ runId: RUN, note: 'fix' })).rejects.toBe(refusal);
    });
  });

  it('routes the guarded run-review reader through the configured data directory', async () => {
    const data = await mkdtemp(join(tmpdir(), 'wf-review-test-'));
    const runId = '865c36b8-a39d-433a-bc6c-87b1715d14e2';
    try {
      const runDir = join(data, 'runs', runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'summary.md'), 'verify: pass');
      const { registry } = setup(undefined, data);
      await expect(handler(registry, 'helmraiser.runReview')({ runId })).resolves.toMatchObject({
        summary: 'verify: pass',
        review: null,
        taskPath: join(runDir, 'task.md'),
      });
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  });

  it('routes exact-run abort to the factory', async () => {
    const { registry, spies } = setup();
    const target = { projectPath: '/workspace/project', runId: 'run-1' };
    await handler(registry, 'helmraiser.abort')(target);
    expect(spies.abort).toHaveBeenCalledWith(target);
  });

  it('rejects malformed abort before the factory', () => {
    const { registry, spies } = setup();
    expect(() => handler(registry, 'helmraiser.abort')({ projectPath: '/workspace/project' })).toThrow('requires');
    expect(spies.abort).not.toHaveBeenCalled();
  });

  it('routes approve with its runId and optional nonblank note to the CLI', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.approve')({ runId: 'run-1' })).resolves.toEqual({ approved: true });
    await handler(registry, 'helmraiser.approve')({ runId: 'run-2', note: 'ship this plan' });
    await handler(registry, 'helmraiser.approve')({ runId: 'run-3', note: '   ' });
    expect(spies.approve).toHaveBeenNthCalledWith(1, 'run-1', undefined);
    expect(spies.approve).toHaveBeenNthCalledWith(2, 'run-2', 'ship this plan');
    expect(spies.approve).toHaveBeenNthCalledWith(3, 'run-3', undefined);
  });

  it('routes reject with its runId and optional note to the CLI', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.reject')({ runId: 'run-1', note: 'not ready' })).resolves.toEqual({ rejected: true });
    expect(spies.reject).toHaveBeenCalledWith('run-1', 'not ready');
    await handler(registry, 'helmraiser.reject')({ runId: 'run-2' });
    expect(spies.reject).toHaveBeenCalledWith('run-2', undefined);
  });

  it('rejects approve/reject before the CLI when runId is missing or blank', () => {
    const { registry, spies } = setup();
    expect(() => handler(registry, 'helmraiser.approve')(undefined)).toThrow('runId');
    expect(() => handler(registry, 'helmraiser.approve')({ runId: '  ' })).toThrow('runId');
    expect(() => handler(registry, 'helmraiser.reject')({ note: 'no' })).toThrow('runId');
    expect(spies.approve).not.toHaveBeenCalled();
    expect(spies.reject).not.toHaveBeenCalled();
  });

  it.each(['helmraiser.approve', 'helmraiser.reject'])('rejects a non-string note for %s before the CLI', (method) => {
    const { registry, spies } = setup();
    expect(() => handler(registry, method)({ runId: 'run-1', note: 3 })).toThrow('string note');
    expect(spies.approve).not.toHaveBeenCalled();
    expect(spies.reject).not.toHaveBeenCalled();
  });

  it('routes the worker and queue controls to the CLI with no params', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.workerStart')(undefined)).resolves.toEqual({ state: 'running' });
    await expect(handler(registry, 'helmraiser.workerStop')(undefined)).resolves.toEqual({ state: 'stopped' });
    await expect(handler(registry, 'helmraiser.pause')(undefined)).resolves.toEqual({ paused: true });
    await expect(handler(registry, 'helmraiser.resume')(undefined)).resolves.toEqual({ paused: false });
    expect(spies.startWorker).toHaveBeenCalledOnce();
    expect(spies.stopWorker).toHaveBeenCalledOnce();
    expect(spies.pause).toHaveBeenCalledOnce();
    expect(spies.resume).toHaveBeenCalledOnce();
  });
});

describe('helmraiser.draft', () => {
  /** Temp roots created by this suite; rm()'s `recursive` does not glob. */
  const tempRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
    );
  });

  /** A real temp project dir so the draft guard's realpath works. */
  async function tempProject(name: string): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'wf-guard-test-'));
    tempRoots.push(base);
    const project = join(base, name);
    await mkdir(project, { recursive: true });
    return project;
  }

  it('accepts a Leeboard project and routes the trimmed title and verbatim goal text', async () => {
    const project = await tempProject('alpha');
    const { run } = fakeRegistry([{ name: 'alpha', path: project }]);
    const { registry, spies } = setup(run);

    const result = await handler(registry, 'helmraiser.draft')({
      project,
      title: '  Count runs  ',
      text: 'Keep   internal\nspacing',
    });
    expect(result).toMatchObject({ id: 'x', status: 'draft', path: join(project, '.helmraiser', 'tasks', 'x.md') });
    expect(spies.draft).toHaveBeenCalledWith(project, 'Count runs', 'Keep   internal\nspacing');
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing everything', { title: 't', text: 'g' }],
    ['blank project', { project: '  ', title: 't', text: 'g' }],
    ['non-string title', { project: '/p', title: 3, text: 'g' }],
    ['blank title', { project: '/p', title: '   ', text: 'g' }],
    ['missing text', { project: '/p', title: 't' }],
    ['121-char title', { project: '/p', title: 'x'.repeat(121), text: 'g' }],
    ['20001-char text', { project: '/p', title: 't', text: 'x'.repeat(20_001) }],
  ])('rejects %s before the CLI', async (_name, params) => {
    const { run } = fakeRegistry([{ name: 'alpha', path: '/p' }]);
    const { registry, spies } = setup(run);
    await expect(handler(registry, 'helmraiser.draft')(params)).rejects.toThrow();
    expect(spies.draft).not.toHaveBeenCalled();
  });

  it('rejects a project outside the registry with bad_project and keeps it unauthorized', async () => {
    const project = await tempProject('rogue');
    const { run } = fakeRegistry([{ name: 'alpha', path: '/real/alpha' }]);
    const { registry, spies } = setup(run);
    try {
      await expect(handler(registry, 'helmraiser.draft')({ project, title: 't', text: 'g' }))
        .rejects.toMatchObject({ code: 'bad_project' });
      expect(spies.draft).not.toHaveBeenCalled();
      // The rogue project must not be remembered: propose there stays rejected.
      const task = join(project, '.helmraiser', 'tasks', 'x.md');
      await mkdir(join(project, '.helmraiser', 'tasks'), { recursive: true });
      await writeFile(task, 'goal', 'utf8');
      await expect(handler(registry, 'helmraiser.propose')({ path: task }))
        .rejects.toMatchObject({ code: 'bad_task_path' });
      expect(spies.propose).not.toHaveBeenCalled();
    } finally {
      await rm(project, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('keeps a successfully drafted project authorized after the registry goes empty', async () => {
    const project = await tempProject('alpha');
    const { run, setProjects } = fakeRegistry([{ name: 'alpha', path: project }]);
    const { registry, spies } = setup(run);
    try {
      await mkdir(join(project, '.helmraiser', 'tasks'), { recursive: true });
      const task = join(project, '.helmraiser', 'tasks', 'x.md');
      await writeFile(task, 'goal', 'utf8');
      await handler(registry, 'helmraiser.draft')({ project, title: 't', text: 'g' });
      expect(spies.draft).toHaveBeenCalledOnce();

      setProjects([]); // the registry read now finds nothing
      await expect(handler(registry, 'helmraiser.propose')({ path: task })).resolves.toMatchObject({ status: 'draft' });
      expect(spies.propose).toHaveBeenCalledWith(task);
    } finally {
      await rm(project, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('helmraiser.propose / helmraiser.queue path guard', () => {
  /** Guard tests share one fake project root; every test builds its own tree. */
  let base = '';
  const project = (): string => join(base, 'alpha');

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined);
    base = '';
  });

  async function openBase(): Promise<void> {
    base = await mkdtemp(join(tmpdir(), 'wf-guard-test-'));
  }

  /** A real task file under the known project's tasks dir, plus the dirs. */
  async function taskFile(name = 'x.md'): Promise<string> {
    await mkdir(join(project(), '.helmraiser', 'tasks'), { recursive: true });
    const path = join(project(), '.helmraiser', 'tasks', name);
    await writeFile(path, 'goal', 'utf8');
    return path;
  }

  function seamWith(alphaPath: string) {
    const { run } = fakeRegistry([{ name: 'alpha', path: alphaPath }]);
    return setup(run);
  }

  it('allows a Leeboard project task without drafting and passes its canonical path to the CLI', async () => {
    await openBase();
    const path = await taskFile();
    const { run } = fakeRegistry([{ name: 'alpha', path: project() }]);
    const { registry, spies } = setup(run);
    await expect(handler(registry, 'helmraiser.propose')({ path })).resolves.toMatchObject({ status: 'draft' });
    await expect(handler(registry, 'helmraiser.queue')({ path })).resolves.toMatchObject({ status: 'queued' });
    expect(spies.propose).toHaveBeenCalledWith(path);
    expect(spies.queue).toHaveBeenCalledWith(path, undefined);
    expect(run).toHaveBeenCalledTimes(2);
    expect(spies.draft).not.toHaveBeenCalled();
  });

  it('passes an exact optional origin after guarding the task path', async () => {
    await openBase();
    const path = await taskFile();
    const { registry, spies } = seamWith(project());
    await expect(handler(registry, 'helmraiser.queue')({
      path,
      origin: 'fo:/home/me/.pi/agent/sessions/a.jsonl',
    })).resolves.toMatchObject({ status: 'queued' });
    expect(spies.queue).toHaveBeenCalledWith(path, 'fo:/home/me/.pi/agent/sessions/a.jsonl');
  });

  it.each([3, '', '   '])('rejects invalid queue origin %j before the CLI', async (origin) => {
    await openBase();
    const path = await taskFile();
    const { registry, spies } = seamWith(project());
    await expect(handler(registry, 'helmraiser.queue')({ path, origin })).rejects.toThrow('origin');
    expect(spies.queue).not.toHaveBeenCalled();
  });

  it.each(['helmraiser.propose', 'helmraiser.queue'])(
    '%s rejects outside and nested tasks before the CLI', async (method) => {
      await openBase();
      const paths = [
        join(project(), 'elsewhere.md'),
        join(project(), '.helmraiser', 'tasks', 'sub', 'nested.md'),
      ];
      const { registry, spies } = seamWith(project());
      for (const path of paths) {
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, 'goal', 'utf8');
        await expect(handler(registry, method)({ path })).rejects.toMatchObject({ code: 'bad_task_path' });
      }
      expect(spies.propose).not.toHaveBeenCalled();
      expect(spies.queue).not.toHaveBeenCalled();
    },
  );

  it('rejects a task under an unregistered project', async () => {
    await openBase();
    const rogue = join(base, 'rogue');
    await mkdir(join(rogue, '.helmraiser', 'tasks'), { recursive: true });
    const path = join(rogue, '.helmraiser', 'tasks', 'x.md');
    await writeFile(path, 'goal', 'utf8');
    const { registry, spies } = seamWith(project());
    await expect(handler(registry, 'helmraiser.queue')({ path })).rejects.toMatchObject({ code: 'bad_task_path' });
    expect(spies.queue).not.toHaveBeenCalled();
  });

  it('rejects a submitted `..` escape before the realpath check matters', async () => {
    await openBase();
    const path = join(project(), '.helmraiser', 'tasks', '..', 'sibling.md');
    await mkdir(join(project(), '.helmraiser'), { recursive: true });
    await writeFile(join(project(), '.helmraiser', 'sibling.md'), 'goal', 'utf8');
    const { registry, spies } = seamWith(project());
    // `..` canonicalizes to the sibling file inside .helmraiser — not tasks/.
    await expect(handler(registry, 'helmraiser.queue')({ path })).rejects.toMatchObject({ code: 'bad_task_path' });
    expect(spies.queue).not.toHaveBeenCalled();
  });

  it('rejects a symlinked task directory pointing outside the project', async () => {
    await openBase();
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'x.md'), 'goal', 'utf8');
    // …/outside/.helmraiser/x.md, reachable only through the symlinked dir.
    const outsidePath = join(outside, '.helmraiser', 'x.md');
    await mkdir(join(outside, '.helmraiser'), { recursive: true });
    await writeFile(outsidePath, 'goal', 'utf8');

    // The known project's tasks dir is a symlink to that outside directory.
    await mkdir(join(project(), '.helmraiser'), { recursive: true });
    await symlink(outside, join(project(), '.helmraiser', 'tasks'), 'dir');

    const { registry, spies } = seamWith(project());
    // Via the project-side (symlinked) path, realpath finds the outside file.
    await expect(
      handler(registry, 'helmraiser.propose')({ path: join(project(), '.helmraiser', 'tasks', 'x.md') }),
    ).rejects.toMatchObject({ code: 'bad_task_path' });
    // And even via the canonical outside path itself, the parent is not a
    // canonical project's `.helmraiser/tasks`.
    await expect(handler(registry, 'helmraiser.propose')({ path: outsidePath }))
      .rejects.toMatchObject({ code: 'bad_task_path' });
    expect(spies.propose).not.toHaveBeenCalled();
  });

  it('rejects a symlinked file inside tasks that points outside the parent', async () => {
    await openBase();
    const path = await taskFile('y.md');
    await symlink('/etc/hostname', join(project(), '.helmraiser', 'tasks', 'z.md'));
    const { registry, spies } = seamWith(project());
    await expect(handler(registry, 'helmraiser.propose')({ path })).resolves.toMatchObject({ status: 'draft' });
    expect(spies.propose).toHaveBeenCalledWith(path);
    // The symlink's real target is not a task file; it must be refused.
    await expect(handler(registry, 'helmraiser.propose')({ path: join(project(), '.helmraiser', 'tasks', 'z.md') }))
      .rejects.toMatchObject({ code: 'bad_task_path' });
    expect(spies.propose).toHaveBeenCalledOnce();
  });

  it('rejects non-.md files, nested paths, and a directory named with .md', async () => {
    await openBase();
    const registryTasks = join(project(), '.helmraiser', 'tasks');
    await mkdir(registryTasks, { recursive: true });
    await writeFile(join(registryTasks, 'x.txt'), 'goal', 'utf8');
    await mkdir(join(registryTasks, 'sub'), { recursive: true });
    await writeFile(join(registryTasks, 'sub', 'x.md'), 'goal', 'utf8');
    await mkdir(join(registryTasks, 'dir.md'), { recursive: true });
    const { registry, spies } = seamWith(project());
    const cases = [
      join(registryTasks, 'x.txt'),
      join(registryTasks, 'sub', 'x.md'),
      join(registryTasks, 'dir.md'),
    ];
    for (const path of cases) {
      await expect(handler(registry, 'helmraiser.propose')({ path })).rejects.toMatchObject({ code: 'bad_task_path' });
    }
    await expect(handler(registry, 'helmraiser.queue')({ path: cases[0]! }))
      .rejects.toMatchObject({ code: 'bad_task_path' });
    expect(spies.propose).not.toHaveBeenCalled();
    expect(spies.queue).not.toHaveBeenCalled();
  });

  it('rejects missing, blank, and non-absolute paths with bad_task_path before any CLI work', async () => {
    const { registry, spies } = setup();
    await expect(handler(registry, 'helmraiser.propose')(undefined)).rejects.toMatchObject({ code: 'bad_task_path' });
    await expect(handler(registry, 'helmraiser.propose')({ path: '' })).rejects.toMatchObject({ code: 'bad_task_path' });
    await expect(handler(registry, 'helmraiser.queue')(undefined)).rejects.toMatchObject({ code: 'bad_task_path' });
    await expect(handler(registry, 'helmraiser.queue')({ path: 'relative/x.md' }))
      .rejects.toMatchObject({ code: 'bad_task_path' });
    expect(spies.propose).not.toHaveBeenCalled();
    expect(spies.queue).not.toHaveBeenCalled();
  });
});
