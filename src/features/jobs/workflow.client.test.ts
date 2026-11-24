import { describe, expect, it } from 'vitest';
import { TransportClient, type SocketLike } from '@core/transport/transport-client.ts';
import { WorkflowClient } from './workflow.client.ts';

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

describe('WorkflowClient settings', () => {
  it('preserves exact settings envelopes, full results and refusals', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect(); socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const actions = [
        { method: 'helmraiser.allDrafts', run: () => client.allDrafts(), params: undefined },
        { method: 'helmraiser.scoutSettings', run: () => client.scoutSettings(), params: undefined },
        { method: 'helmraiser.setScoutSettings', run: () => client.setScoutSettings({ lens: 'docs', auto: false }), params: { lens: 'docs', auto: false } },
        { method: 'helmraiser.setScoutSettings', run: () => client.setScoutSettings({ lens: 'tests', cooldownHours: 1.5 }), params: { lens: 'tests', cooldownHours: 1.5 } },
        { method: 'helmraiser.resetScoutSettings', run: () => client.resetScoutSettings('state'), params: { lens: 'state' } },
      ];
      for (const [index, action] of actions.entries()) {
        const pending = action.run();
        const sent = JSON.parse(socket.sent[index]!);
        expect(sent.method).toBe(action.method); expect(sent.params).toEqual(action.params);
        const result = { lenses: { state: { auto: false } } };
        socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: sent.id, ok: true, result }) });
        await expect(pending).resolves.toEqual(result);
      }
      const refused = client.setScoutSettings({ lens: 'state', auto: true });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '6', ok: false, error: { code: 'helmraiser_cli_error', message: 'refused' } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: 'refused' });
    } finally { transport.disconnect(); }
  });
});

describe('WorkflowClient Scout actions', () => {
  it.each((['requestScouts', 'cancelScouts'] as const).flatMap((method) =>
    ([undefined, 'state', 'docs', 'tests', 'guardrails'] as const).map((lens) => ({ method, lens }))))('$method sends $lens and preserves results/refusals', async ({ method, lens }) => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const projects = ['/work/repo one', '/work/beta'];
      const result = method === 'requestScouts'
        ? { requested: [projects[0]], already_pending: [projects[1]] }
        : { cancelled: [projects[0]], not_pending: [projects[1]] };
      const pending = client[method](projects, lens);
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
        kind: 'request', id: '1', method: `helmraiser.${method}`, params: { projects, ...(lens !== undefined ? { lens } : {}) },
      });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '1', ok: true, result }) });
      await expect(pending).resolves.toEqual(result);
      const refused = client[method](projects, lens);
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '2', ok: false,
        error: { code: 'helmraiser_cli_error', message: 'project is paused' } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: 'project is paused' });
    } finally {
      transport.disconnect();
    }
  });
});

describe('WorkflowClient draft drop', () => {
  it('dropDraft sends the reason alone, and adds the class only when one is given', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const plain = client.dropDraft('alpha:cache', 'not real');
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
        kind: 'request', id: '1', method: 'helmraiser.dropDraft', params: { taskId: 'alpha:cache', reason: 'not real' },
      });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '1', ok: true, result: { status: 'dropped', class: null } }) });
      await expect(plain).resolves.toEqual({ status: 'dropped', class: null });
      const classified = client.dropDraft('alpha:cache', 'not real', 'wrong');
      expect(JSON.parse(socket.sent[1] ?? '')).toEqual({
        kind: 'request', id: '2', method: 'helmraiser.dropDraft', params: { taskId: 'alpha:cache', reason: 'not real', class: 'wrong' },
      });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '2', ok: true, result: { status: 'dropped', class: 'wrong' } }) });
      await expect(classified).resolves.toEqual({ status: 'dropped', class: 'wrong' });
    } finally {
      transport.disconnect();
    }
  });
});

describe('WorkflowClient queue removal', () => {
  it('queueRemove sends the full task id and surfaces the CLI refusal', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const taskId = '-home-example-projects-demo-api:board-sync';
      const pending = client.queueRemove(taskId);
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
        kind: 'request', id: '1', method: 'helmraiser.queueRemove', params: { taskId },
      });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '1', ok: true, result: { task_id: taskId, status: 'draft' } }) });
      await expect(pending).resolves.toEqual({ task_id: taskId, status: 'draft' });
      const refused = client.queueRemove(taskId);
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '2', ok: false,
        error: { code: 'helmraiser_cli_error', message: 'helmraiser queue failed: cannot remove task in status running; only queued tasks can be removed' } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: expect.stringContaining('only queued tasks can be removed') });
    } finally {
      transport.disconnect();
    }
  });
});

describe('WorkflowClient retry', () => {
  it('retry sends the run id, adds implement only when asked, and surfaces the CLI refusal', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const runId = '142d660e-8ed6-4338-9413-5ad16510baaa';
      const result = {
        retried: 'blocked: needs a corrected task', run_id: runId, task_id: 'repo:x', project: '/repo',
        status: 'resuming', stage: 'implement', worker: 'running', worker_serves_project: true,
      };
      const plain = client.retry(runId);
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
        kind: 'request', id: '1', method: 'helmraiser.retry', params: { runId },
      });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '1', ok: true, result }) });
      await expect(plain).resolves.toEqual(result);
      const implement = client.retry(runId, true);
      expect(JSON.parse(socket.sent[1] ?? '')).toEqual({
        kind: 'request', id: '2', method: 'helmraiser.retry', params: { runId, implement: true },
      });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '2', ok: true, result }) });
      await expect(implement).resolves.toEqual(result);
      const refused = client.retry(runId);
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '3', ok: false,
        error: { code: 'helmraiser_cli_error', message: `helmraiser retry failed: run ${runId} is running, not failed` } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: expect.stringContaining('not failed') });
    } finally {
      transport.disconnect();
    }
  });
});

describe('WorkflowClient rework', () => {
  it('rework sends the run id, adds the note and rebase only when given, and surfaces the CLI refusal', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const runId = '865c36b8-a39d-433a-bc6c-87b1715d14e2';
      const result = {
        reworked: 'merge', rebase: true, run_id: runId, task_id: 'repo:x', project: '/repo',
        status: 'resuming', stage: 'implement', worker: 'running', worker_serves_project: true,
      };
      const reply = (id: string) => socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id, ok: true, result }) });
      const noted = client.rework(runId, 'clarify the widget');
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
        kind: 'request', id: '1', method: 'helmraiser.rework', params: { runId, note: 'clarify the widget' },
      });
      reply('1');
      await expect(noted).resolves.toEqual(result);
      const both = client.rework(runId, 'keep the 30 s limit', true);
      expect(JSON.parse(socket.sent[1] ?? '')).toEqual({
        kind: 'request', id: '2', method: 'helmraiser.rework', params: { runId, note: 'keep the 30 s limit', rebase: true },
      });
      reply('2');
      await expect(both).resolves.toEqual(result);
      // A blank note is no note: helmraiser takes a rebase on its own.
      const rebaseOnly = client.rework(runId, '', true);
      expect(JSON.parse(socket.sent[2] ?? '')).toEqual({
        kind: 'request', id: '3', method: 'helmraiser.rework', params: { runId, rebase: true },
      });
      reply('3');
      await expect(rebaseOnly).resolves.toEqual(result);
      const refused = client.rework(runId, 'fix');
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '4', ok: false,
        error: { code: 'helmraiser_cli_error', message: `helmraiser rework failed: run ${runId} is running, not awaiting approval` } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: expect.stringContaining('not awaiting approval') });
    } finally {
      transport.disconnect();
    }
  });
});

describe('WorkflowClient report', () => {
  it('report sends the window, returns the report as is, and surfaces the CLI refusal', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const report = {
        since: '30d', generated_at: '2026-11-22T16:00:00+00:00', landed_count: 40, awaiting_count: 1,
        failed: [], cost: { total_usd: 36.4, by_model: { 'opencode-go/glm-5.2': 36.4 } }, models: [],
      };
      const pending = client.report('30d');
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({ kind: 'request', id: '1', method: 'helmraiser.report', params: { since: '30d' } });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '1', ok: true, result: report }) });
      await expect(pending).resolves.toEqual(report);

      const refused = client.report('24h');
      expect(JSON.parse(socket.sent[1] ?? '')).toMatchObject({ method: 'helmraiser.report', params: { since: '24h' } });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '2', ok: false,
        error: { code: 'helmraiser_cli_error', message: 'helmraiser report timed out after 300 s' } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: 'helmraiser report timed out after 300 s' });
    } finally {
      transport.disconnect();
    }
  });
});

describe('WorkflowClient stats', () => {
  it('stats sends the window, adds the project only when given, returns the stats as is, and surfaces the CLI refusal', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const stats = {
        window: { since: 'all', since_seconds: null, generated_at: '2026-11-22T17:58:24.417553+00:00', project: null },
        scouts: [{ project: '/work/alpha', lens: 'guardrails', in_focus: true, last_scout_ended_at: null }],
        weekly: [],
      };
      const all = client.stats('all');
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({ kind: 'request', id: '1', method: 'helmraiser.stats', params: { since: 'all' } });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '1', ok: true, result: stats }) });
      await expect(all).resolves.toEqual(stats);

      const scoped = client.stats('90d', '/work/repo one');
      expect(JSON.parse(socket.sent[1] ?? '')).toEqual({
        kind: 'request', id: '2', method: 'helmraiser.stats', params: { since: '90d', project: '/work/repo one' },
      });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '2', ok: true, result: stats }) });
      await expect(scoped).resolves.toEqual(stats);

      const refused = client.stats('7d');
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '3', ok: false,
        error: { code: 'helmraiser_cli_error', message: 'helmraiser stats failed: ledger requires migration' } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: 'helmraiser stats failed: ledger requires migration' });
    } finally {
      transport.disconnect();
    }
  });
});

describe('WorkflowClient run log', () => {
  it('log sends the run id, adds sinceId only when given, and surfaces the CLI refusal', async () => {
    const socket = new FakeSocket();
    const transport = new TransportClient('ws://fixture', () => socket);
    transport.connect();
    socket.onopen?.();
    try {
      const client = new WorkflowClient(transport);
      const runId = '142d660e-8ed6-4338-9413-5ad16510baaa';
      const result = {
        events: [{ id: 338277, ts: 1792428388.89, source: 'helmraiser', stage: null, type: 'run_end', payload: { status: 'failed' } }],
        truncated: true,
      };
      const first = client.log(runId);
      expect(JSON.parse(socket.sent[0] ?? '')).toEqual({ kind: 'request', id: '1', method: 'helmraiser.log', params: { runId } });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '1', ok: true, result }) });
      await expect(first).resolves.toEqual(result);

      const next = client.log(runId, 338277);
      expect(JSON.parse(socket.sent[1] ?? '')).toMatchObject({ method: 'helmraiser.log', params: { runId, sinceId: 338277 } });
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '2', ok: true, result: { events: [], truncated: false } }) });
      await expect(next).resolves.toEqual({ events: [], truncated: false });

      const refused = client.log('beef');
      socket.onmessage?.({ data: JSON.stringify({ kind: 'response', id: '3', ok: false,
        error: { code: 'helmraiser_cli_error', message: 'helmraiser log failed: unknown run: beef' } }) });
      await expect(refused).rejects.toMatchObject({ code: 'helmraiser_cli_error', message: 'helmraiser log failed: unknown run: beef' });
    } finally {
      transport.disconnect();
    }
  });
});
