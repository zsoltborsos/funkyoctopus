import { describe, expect, it, vi } from 'vitest';
import { VaultGuard } from '../security/vault.ts';
import { HelmraiserFactory, vaultBeforeSpawn, type HelmraiserRunner } from './factory.ts';

vi.mock('../config.ts', () => ({ config: { helmraiserBin: '/opt/helmraiser cli' } }));

const PROJECT = '/workspace/octopus';
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';

function factory(run = vi.fn<HelmraiserRunner>().mockResolvedValue(undefined)) {
  return { factory: new HelmraiserFactory(run), run };
}

describe('HelmraiserFactory', () => {
  it('guards the configured executable and separately shell-quotes every argument', async () => {
    const guard = new VaultGuard([], () => Promise.resolve(false));
    const inspect = vi.spyOn(guard, 'guard');
    await vaultBeforeSpawn(guard)(['approve', "owner's run"]);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'bash', {
      command: "'/opt/helmraiser cli' 'approve' 'owner'\\''s run'",
    });
  });

  it('aborts one exact run', async () => {
    const { factory: subject, run } = factory();
    await subject.abort({ projectPath: PROJECT, runId: RUN_ID });
    expect(run).toHaveBeenCalledWith(['abort', RUN_ID, '--project-dir', PROJECT], PROJECT);
  });

  it.each(['block', 'escalate'] as const)('refuses a Vault %s result without spawning', async (action) => {
    const run = vi.fn<HelmraiserRunner>().mockResolvedValue(undefined);
    const onEscalate = vi.fn(() => Promise.reject(new Error(
      'Vault escalation requires interactive approval; Helmraiser abort is non-interactive',
    )));
    const guard = new VaultGuard([{ target: PROJECT, action }], onEscalate);
    const subject = new HelmraiserFactory(run, vaultBeforeSpawn(guard));

    await expect(subject.abort({ projectPath: PROJECT, runId: RUN_ID }))
      .rejects.toThrow(action === 'block' ? 'Vault blocked access' : 'non-interactive');
    expect(run).not.toHaveBeenCalled();
  });
});
