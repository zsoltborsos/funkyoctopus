import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConfigFile, configFilePath } from './config-file.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fo-config-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: string): Promise<string> {
  const path = join(dir, 'config.env');
  await writeFile(path, content);
  return path;
}

describe('applyConfigFile', () => {
  it('sets every key the environment does not have and returns the keys it applied', async () => {
    const path = await writeConfig('SIDECAR_PORT=14999\nFUNKYOCTOPUS_PROVIDER=example-provider\n');
    const env: NodeJS.ProcessEnv = {};

    const applied = await applyConfigFile(path, env);

    expect(env).toEqual({ SIDECAR_PORT: '14999', FUNKYOCTOPUS_PROVIDER: 'example-provider' });
    expect([...applied].sort()).toEqual(['FUNKYOCTOPUS_PROVIDER', 'SIDECAR_PORT']);
  });

  it('lets the real environment win, even over a blank value', async () => {
    const path = await writeConfig('SIDECAR_PORT=14999\nSIDECAR_HOST=0.0.0.0\nFUNKYOCTOPUS_MODEL=from-file\n');
    const env: NodeJS.ProcessEnv = { SIDECAR_PORT: '15000', SIDECAR_HOST: '' };

    const applied = await applyConfigFile(path, env);

    expect(env).toEqual({ SIDECAR_PORT: '15000', SIDECAR_HOST: '', FUNKYOCTOPUS_MODEL: 'from-file' });
    expect(applied).toEqual(['FUNKYOCTOPUS_MODEL']);
  });

  it('reads the .env.example format: comments, quotes and blank lines', async () => {
    const path = await writeConfig(
      [
        '# a comment',
        '',
        'FUNKYOCTOPUS_PROJECT_ROOTS="/home/example/projects, /home/example/work"',
        "HELMRAISER_BIN='helmraiser'",
        'FUNKYOCTOPUS_UPKEEP_DISABLED=1 # trailing comment',
        '',
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = {};

    await applyConfigFile(path, env);

    expect(env).toEqual({
      FUNKYOCTOPUS_PROJECT_ROOTS: '/home/example/projects, /home/example/work',
      HELMRAISER_BIN: 'helmraiser',
      FUNKYOCTOPUS_UPKEEP_DISABLED: '1',
    });
  });

  it('is a silent no-op when the file does not exist', async () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'me' };

    await expect(applyConfigFile(join(dir, 'missing.env'), env)).resolves.toEqual([]);

    expect(env).toEqual({ KEEP: 'me' });
  });

  it('throws with the path in the message when the file cannot be read', async () => {
    const unreadable = join(dir, 'a-directory');
    await mkdir(unreadable);

    await expect(applyConfigFile(unreadable, {})).rejects.toThrow(unreadable);
  });
});

describe('configFilePath', () => {
  it('is FUNKYOCTOPUS_CONFIG when set', () => {
    expect(configFilePath({ FUNKYOCTOPUS_CONFIG: '/home/example/fo.env' }, '/home/example')).toBe(
      '/home/example/fo.env',
    );
  });

  it('is <home>/.funkyoctopus/config.env when FUNKYOCTOPUS_CONFIG is unset or blank', () => {
    expect(configFilePath({}, '/home/example')).toBe('/home/example/.funkyoctopus/config.env');
    expect(configFilePath({ FUNKYOCTOPUS_CONFIG: '  ' }, '/home/example')).toBe(
      '/home/example/.funkyoctopus/config.env',
    );
  });
});
