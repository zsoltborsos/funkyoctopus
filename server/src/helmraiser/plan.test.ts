import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_HELMRAISER_PLAN_BYTES,
  readHelmraiserPlan,
  HELMRAISER_PLAN_TRUNCATION_NOTICE,
} from './plan.ts';

const RUN_ID = '865c36b8-a39d-433a-bc6c-87b1715d14e2';

describe('readHelmraiserPlan', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function dataDir(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'helmraiser-plan-'));
    await mkdir(join(root, 'runs'), { recursive: true });
    return root;
  }

  it('reads a plan from the configured Helmraiser data directory', async () => {
    const data = await dataDir();
    await mkdir(join(data, 'runs', RUN_ID));
    await writeFile(join(data, 'runs', RUN_ID, 'plan.md'), '# Plan\n\nDo the work.\n');
    await expect(readHelmraiserPlan(RUN_ID, data)).resolves.toEqual({ text: '# Plan\n\nDo the work.\n', path: join(data, 'runs', RUN_ID, 'plan.md') });
  });

  it('rejects a non-UUID before attempting to locate the data directory', async () => {
    await expect(readHelmraiserPlan('../../etc', '/definitely/not/a/data-dir'))
      .rejects.toThrow('requires a UUID runId');
  });

  it('rejects a plan symlink that escapes the runs directory', async () => {
    const data = await dataDir();
    const run = join(data, 'runs', RUN_ID);
    await mkdir(run);
    const outside = join(data, 'outside.md');
    await writeFile(outside, 'outside');
    await symlink(outside, join(run, 'plan.md'));
    await expect(readHelmraiserPlan(RUN_ID, data)).rejects.toThrow('escapes the runs directory');
  });

  it('rejects a symlinked runs directory that escapes the configured data directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'helmraiser-plan-'));
    const data = join(root, 'data');
    const outsideRuns = join(root, 'outside-runs');
    await mkdir(join(outsideRuns, RUN_ID), { recursive: true });
    await mkdir(data);
    await writeFile(join(outsideRuns, RUN_ID, 'plan.md'), 'outside');
    await symlink(outsideRuns, join(data, 'runs'), 'dir');
    await expect(readHelmraiserPlan(RUN_ID, data)).rejects.toThrow('escapes the configured data directory');
  });

  it('reports a missing plan clearly', async () => {
    const data = await dataDir();
    await expect(readHelmraiserPlan(RUN_ID, data)).rejects.toThrow(`plan does not exist for run ${RUN_ID}`);
  });

  it('bounds oversized plans at MAX_HELMRAISER_PLAN_BYTES and marks truncation', async () => {
    const data = await dataDir();
    await mkdir(join(data, 'runs', RUN_ID));
    await writeFile(join(data, 'runs', RUN_ID, 'plan.md'), 'x'.repeat(MAX_HELMRAISER_PLAN_BYTES + 100));
    const result = await readHelmraiserPlan(RUN_ID, data);
    expect(result.text).toBe(`${'x'.repeat(MAX_HELMRAISER_PLAN_BYTES)}${HELMRAISER_PLAN_TRUNCATION_NOTICE}`);
  });
});
