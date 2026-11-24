import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  cleanupRuntimeEnvironment,
  createRuntimeGitRepository,
  createRuntimeSessionDirectory,
  createRuntimeTempDirectory,
  createRuntimeVaultFile,
} from './runtime-env.ts';

const execFileAsync = promisify(execFile);

describe('runtime environment helpers', () => {
  it('creates isolated runtime fixtures and cleans them up idempotently', async () => {
    const tempDirectory = await createRuntimeTempDirectory();
    const repository = await createRuntimeGitRepository();
    const sessionDirectory = await createRuntimeSessionDirectory();
    const vaultPath = await createRuntimeVaultFile([
      { target: join(tempDirectory, 'guarded'), action: 'escalate' },
    ]);

    await expect(access(tempDirectory)).resolves.toBeUndefined();
    await expect(access(sessionDirectory)).resolves.toBeUndefined();
    await expect(readFile(vaultPath, 'utf8')).resolves.toContain('"escalate"');
    await expect(
      execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repository }),
    ).resolves.toMatchObject({ stdout: expect.stringMatching(/\S/) });

    await cleanupRuntimeEnvironment();
    await cleanupRuntimeEnvironment();

    await expect(access(tempDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(repository)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(sessionDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(vaultPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
