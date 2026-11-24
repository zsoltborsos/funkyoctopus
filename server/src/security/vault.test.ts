import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadVaultRules, VaultGuard } from './vault.ts';

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), 'funkyoctopus-vault-'));

describe('VaultGuard', () => {
  it('blocks a guarded structured path and passes an unguarded path', async () => {
    const root = await temp();
    const guarded = join(root, 'guarded');
    await mkdir(guarded);
    const guard = new VaultGuard([{ target: guarded, action: 'block' }], vi.fn());

    await expect(guard.guard('1', 'read', { path: join(guarded, 'secret') })).resolves.toEqual({
      block: true,
      reason: `Vault blocked access to ${guarded}`,
    });
    await expect(guard.guard('2', 'read', { path: join(root, 'ordinary') })).resolves.toBeUndefined();
  });

  it('suspends escalation until approval and respects denial', async () => {
    const root = await temp();
    let decide: ((approved: boolean) => void) | undefined;
    const onEscalate = vi.fn(
      () => new Promise<boolean>((resolve) => {
        decide = resolve;
      }),
    );
    const guard = new VaultGuard([{ target: root, action: 'escalate' }], onEscalate);

    const pending = guard.guard('call-1', 'edit', { path: join(root, 'prod.txt') });
    await vi.waitFor(() => expect(onEscalate).toHaveBeenCalledOnce());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    decide?.(false);
    await expect(pending).resolves.toEqual({
      block: true,
      reason: `Vault denied access to ${root}`,
    });
  });

  it('resolves relative paths from the active project root', async () => {
    const root = await temp();
    const guarded = join(root, 'guarded');
    const project = join(root, 'project');
    await mkdir(guarded);
    await mkdir(project);
    const guard = new VaultGuard([{ target: guarded, action: 'block' }], vi.fn(), project);

    await expect(guard.guard('1', 'read', { path: '../guarded/secret' })).resolves.toMatchObject({
      block: true,
    });
  });

  it('resolves symlinks before checking containment', async () => {
    const root = await temp();
    const guarded = join(root, 'guarded');
    const open = join(root, 'open');
    await mkdir(guarded);
    await mkdir(open);
    await writeFile(join(guarded, 'secret'), 'secret');
    await symlink(join(guarded, 'secret'), join(open, 'innocent'));
    const guard = new VaultGuard([{ target: guarded, action: 'block' }], vi.fn());

    await expect(guard.guard('1', 'read', { path: join(open, 'innocent') })).resolves.toMatchObject({
      block: true,
    });
  });

  it('trips on a guarded path written literally in a shell command, for pi\'s bash and Claude\'s Bash', async () => {
    const root = await temp();
    const guarded = join(root, 'guarded');
    await mkdir(guarded);
    const guard = new VaultGuard([{ target: guarded, action: 'block' }], vi.fn());
    const blocked = { block: true, reason: `Vault blocked access to ${guarded}` };

    await expect(guard.guard('1', 'bash', { command: `cat ${guarded}/key` })).resolves.toEqual(blocked);
    await expect(guard.guard('2', 'Bash', { command: `cat ${guarded}/key` })).resolves.toEqual(blocked);
    await expect(guard.guard('3', 'Bash', { command: `cat ${root}/ordinary` })).resolves.toBeUndefined();
  });

  it('trips on a guarded path in the command of any tool that takes one, not only bash', async () => {
    const root = await temp();
    const guarded = join(root, 'guarded');
    await mkdir(guarded);
    const guard = new VaultGuard([{ target: guarded, action: 'block' }], vi.fn());
    const blocked = { block: true, reason: `Vault blocked access to ${guarded}` };

    // Claude Code's PowerShell and Monitor tools run a `command` just as Bash does.
    await expect(guard.guard('1', 'PowerShell', { command: `Get-Content ${guarded}/key` })).resolves.toEqual(blocked);
    await expect(guard.guard('2', 'Monitor', { command: `tail -f ${guarded}/log` })).resolves.toEqual(blocked);
    await expect(guard.guard('3', 'Monitor', { command: `tail -f ${root}/log` })).resolves.toBeUndefined();
    await expect(guard.guard('4', 'Monitor', { command: 42 })).resolves.toBeUndefined();
  });

  it('checks the notebook path of a notebook edit like any other path', async () => {
    const root = await temp();
    const guarded = join(root, 'guarded');
    await mkdir(guarded);
    const guard = new VaultGuard([{ target: guarded, action: 'block' }], vi.fn());

    await expect(guard.guard('1', 'NotebookEdit', { notebook_path: join(guarded, 'a.ipynb') })).resolves.toMatchObject({
      block: true,
    });
    await expect(guard.guard('2', 'NotebookEdit', { notebook_path: join(root, 'b.ipynb') })).resolves.toBeUndefined();
  });

  it('loads an exact flat seed list when config is absent', async () => {
    const path = join(await temp(), 'nested', 'vault.json');
    await expect(loadVaultRules(path)).resolves.toEqual([{ target: '~/.ssh', action: 'block' }]);
    await expect(loadVaultRules(path)).resolves.toEqual([{ target: '~/.ssh', action: 'block' }]);
  });

  it('inherits SSH_AUTH_SOCK into child tool processes', () => {
    const value = process.env.SSH_AUTH_SOCK ?? '/tmp/test-agent.sock';
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.SSH_AUTH_SOCK ?? "")'], {
      encoding: 'utf8',
      env: { ...process.env, SSH_AUTH_SOCK: value },
    });
    expect(child.stdout).toBe(value);
  });
});
