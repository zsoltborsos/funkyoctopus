import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderUnit, serviceMain, type CommandResult, type ServiceDeps } from './service.ts';

interface Harness {
  deps: ServiceDeps;
  calls: string[];
  files: Map<string, string>;
  output: string[];
  errors: string[];
  answers: Map<string, CommandResult[]>;
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'failed'): CommandResult => ({ code: 1, stdout: '', stderr });

function harness(argv: readonly string[], initialFiles: Record<string, string> = {}): Harness {
  const calls: string[] = [];
  const files = new Map(Object.entries(initialFiles));
  const output: string[] = [];
  const errors: string[] = [];
  const answers = new Map<string, CommandResult[]>();
  const deps: ServiceDeps = {
    argv,
    cwd: '/repo',
    env: { HOME: '/home/test', PATH: '/tools:/usr/bin' },
    execPath: '/opt/node 22/bin/node',
    nodeVersion: '26.0.0',
    homeDir: '/home/test',
    run(command, args, cwd) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(`${cwd}> ${key}`);
      const queued = answers.get(key);
      if (queued?.length) return Promise.resolve(queued.shift() ?? ok());
      if (key === 'git rev-parse --show-toplevel') return Promise.resolve(ok('/repo\n'));
      if (key === 'git worktree list --porcelain') return Promise.resolve(ok('worktree /repo\nHEAD abc\n'));
      if (key === 'git rev-parse HEAD') return Promise.resolve(ok('2222222222222222222222222222222222222222\n'));
      // Desktop notifications stay off unless a test turns the probe on, so
      // the old unit expectations keep holding byte-for-byte.
      if (key === 'notify-send --version') return Promise.resolve(fail());
      return Promise.resolve(ok());
    },
    readFile(path) {
      const value = files.get(path);
      return value === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(value);
    },
    writeFile(path, content) { files.set(path, content); calls.push(`write ${path}`); return Promise.resolve(); },
    removeFile(path) { files.delete(path); calls.push(`remove ${path}`); return Promise.resolve(); },
    makeDir(path) { calls.push(`mkdir ${path}`); return Promise.resolve(); },
    waitForHealth() { calls.push('health'); return Promise.resolve(true); },
    portInUse() { return Promise.resolve(false); },
    out(line) { output.push(line); },
    err(line) { errors.push(line); },
  };
  return { deps, calls, files, output, errors, answers };
}

function answer(h: Harness, command: string, ...results: CommandResult[]): void {
  h.answers.set(command, results);
}

const unitPath = '/home/test/.config/systemd/user/funkyoctopus.service';
const deployDir = '/home/test/.local/share/funkyoctopus/app';

describe('renderUnit', () => {
  it('renders captured paths, PATH and production settings with systemd quoting', () => {
    expect(renderUnit('/home/example/app dir', '/usr/bin/node', '/usr/local/bin:/usr/bin')).toContain(
      'WorkingDirectory=/home/example/app dir\nExecStart="/usr/bin/node" --import tsx server/src/entrypoint.ts\nEnvironment="PATH=/usr/local/bin:/usr/bin"',
    );
    expect(renderUnit('/app', '/node', '/bin')).toContain('Environment=FUNKYOCTOPUS_SERVE_UI=1\nEnvironment=SIDECAR_HOST=127.0.0.1\nEnvironment=SIDECAR_PORT=14787');
  });

  it('prints the unit through render-unit', async () => {
    const h = harness(['render-unit', '--deploy-dir', '/app', '--node', '/node', '--path', '/bin']);
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.output.join('\n')).toContain('WorkingDirectory=/app\n');
  });

  it('escapes systemd % specifiers and refuses newlines', () => {
    expect(renderUnit('/a%b', '/n%o', '/x%y')).toContain(
      'WorkingDirectory=/a%%b\nExecStart="/n%%o" --import tsx server/src/entrypoint.ts\nEnvironment="PATH=/x%%y"',
    );
    expect(() => renderUnit('/a\nExecStart=/bin/evil', '/node', '/bin')).toThrow('newline');
  });

  it('normalizes versioned mise Node paths and every PATH entry', () => {
    const unit = renderUnit(
      '/home/test/mise/installs/node/26.8.1/app',
      '/home/test/mise/installs/node/26.8.1/bin/node',
      ':/home/test/mise/installs/node/26.8.1/bin:/usr/bin:/home/test/mise/installs/node/26.13.1/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/home/test/mise/installs/node/26.8.1/bin::',
    );
    expect(unit).toContain('WorkingDirectory=/home/test/mise/installs/node/26.8.1/app\n');
    expect(unit).toContain('ExecStart="/home/test/mise/installs/node/latest/bin/node"');
    expect(unit).toContain('Environment="PATH=:/home/test/mise/installs/node/latest/bin:/usr/bin:/home/test/mise/installs/node/latest/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/home/test/mise/installs/node/latest/bin::"');
  });

  it.each([
    '/home/test/mise/installs/node/latest/bin/node',
    '/usr/bin/node',
    '/home/test/mise/installs/python/3.14/bin',
    '/home/test/mise/installs/nodejs/26.8.1/bin',
    '/home/test/notmise/installs/node/26.8.1/bin',
    '/home/test/mise/installs/node/26.8.1',
  ])('leaves unrelated or already stable paths unchanged: %s', (path) => {
    const unit = renderUnit('/app', path, path);
    expect(unit).toContain(`ExecStart="${path}"`);
    expect(unit).toContain(`Environment="PATH=${path}"`);
  });

  it('normalizes explicit render-unit arguments without using npm overrides', async () => {
    const h = harness(['render-unit', '--deploy-dir', '/app', '--node', '/x/mise/installs/node/26.8.1/bin/node', '--path', '/x/mise/installs/node/26.8.1/bin:/usr/bin']);
    h.deps.env.npm_node_execpath = '/conflicting/node';
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.output.join('\n')).toContain('ExecStart="/x/mise/installs/node/latest/bin/node"');
    expect(h.output.join('\n')).toContain('Environment="PATH=/x/mise/installs/node/latest/bin:/usr/bin"');
  });

  it('preserves quoting after normalizing mise paths', () => {
    const unit = renderUnit('/app', '/x/mise/installs/node/26/bin/n"o\\d%e', '/x/mise/installs/node/26/bin/"\\%');
    expect(unit).toContain('ExecStart="/x/mise/installs/node/latest/bin/n\\"o\\\\d%%e"');
    expect(unit).toContain('Environment="PATH=/x/mise/installs/node/latest/bin/\\"\\\\%%"');
  });

  it.each(['\n', '\r'])('rejects newline %j in Node and PATH, including mise versions', (newline) => {
    for (const value of [`/node${newline}evil`, `/x/mise/installs/node/26${newline}evil/bin`]) {
      expect(() => renderUnit('/app', value, '/bin')).toThrow('newline');
      expect(() => renderUnit('/app', '/node', value)).toThrow('newline');
    }
  });

  it('adds the desktop-notify environment line only when asked', () => {
    expect(renderUnit('/app', '/node', '/bin')).not.toContain('FUNKYOCTOPUS_DESKTOP_NOTIFY');
    expect(renderUnit('/app', '/node', '/bin', true)).toContain('Environment=FUNKYOCTOPUS_DESKTOP_NOTIFY=1\n');
  });

  // The fakes above cannot tell whether systemd accepts the file; systemd can.
  const analyze = spawnSync('systemd-analyze', ['--version']).status === 0;
  it.skipIf(!analyze)('renders a unit systemd-analyze verify accepts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fo-unit-'));
    try {
      const file = join(dir, 'funkyoctopus.service');
      writeFileSync(file, renderUnit(dir, process.execPath, '/usr/local/bin:/usr/bin'));
      const result = spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8' });
      expect(result.stderr).not.toMatch(/bad unit file|not absolute|fatal/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install', () => {
  it.each([
    ['/npm/mise/installs/node/26.13.1/bin/node', '/usr/bin/node', '/npm/mise/installs/node/latest/bin/node'],
    [undefined, '/fallback/mise/installs/node/26.8.1/bin/node', '/fallback/mise/installs/node/latest/bin/node'],
    ['', '/fallback/mise/installs/node/26.8.1/bin/node', '/fallback/mise/installs/node/latest/bin/node'],
  ])('selects npm Node %j or falls back to %s', async (npmNode, execPath, expected) => {
    const h = harness(['install']);
    h.deps.env.npm_node_execpath = npmNode;
    h.deps.execPath = execPath;
    h.deps.env.PATH = '/x/mise/installs/node/26.8.1/bin:/usr/bin';
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.files.get(unitPath)).toContain(`ExecStart="${expected}"`);
    expect(h.files.get(unitPath)).toContain('Environment="PATH=/x/mise/installs/node/latest/bin:/usr/bin"');
  });

  it('probes helmraiser with its version command and warns only when it fails', async () => {
    const h = harness(['install']);
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.calls).toContain('/repo> helmraiser version');
    expect(h.errors.join('\n')).not.toContain('helmraiser is not on PATH');
    const missing = harness(['install']);
    answer(missing, 'helmraiser version', fail());
    expect(await serviceMain(missing.deps)).toBe(0);
    expect(missing.errors.join('\n')).toContain('helmraiser is not on PATH');
  });

  it('refuses to start when another sidecar already answers on 14787', async () => {
    const h = harness(['install']);
    answer(h, 'systemctl --user is-active --quiet funkyoctopus.service', fail());
    h.deps.portInUse = () => Promise.resolve(true);
    expect(await serviceMain(h.deps)).toBe(1);
    expect(h.errors.join('\n')).toContain('port 14787 is already answering');
    expect(h.calls.some((call) => call.includes('enable --now'))).toBe(false);
  });

  it('fails Node, git and systemd-user prerequisite checks', async () => {
    const node = harness(['install']);
    node.deps.nodeVersion = '25.9.0';
    node.deps.env.npm_node_execpath = '/x/mise/installs/node/26.13.1/bin/node';
    expect(await serviceMain(node.deps)).toBe(1);
    expect(node.errors[0]).toContain('Node 26');

    for (const [command, args, message] of [
      ['git', '--version', 'git is required'],
      ['systemctl', '--user show-environment', 'systemctl --user'],
    ] as const) {
      const h = harness(['install']);
      answer(h, `${command} ${args}`, fail());
      expect(await serviceMain(h.deps)).toBe(1);
      expect(h.errors.join('\n')).toContain(message);
    }
  });

  it('warns for optional tools, creates/builds/enables in order and waits for health', async () => {
    const h = harness(['install']);
    answer(h, 'helmraiser version', fail());
    answer(h, 'lb --help', fail());
    answer(h, 'pi --version', fail());
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.errors.join('\n')).toContain('warning: helmraiser');
    expect(h.errors.join('\n')).toContain('warning: lb');
    expect(h.errors.join('\n')).toContain('warning: pi');
    expect(h.calls).toEqual(expect.arrayContaining([
      `/repo> git worktree add --detach ${deployDir} main`,
      `${deployDir}> npm ci`,
      `${deployDir}> npm run build`,
      '/repo> systemctl --user daemon-reload',
      '/repo> systemctl --user enable --now funkyoctopus.service',
      'health',
    ]));
    expect(h.calls.indexOf(`${deployDir}> npm ci`)).toBeLessThan(h.calls.indexOf(`${deployDir}> npm run build`));
    expect(h.files.get(unitPath)).toContain('ExecStart="/opt/node 22/bin/node"');
    expect(h.files.get(unitPath)).toContain('Environment="PATH=/tools:/usr/bin"');
  });

  it('deploys a given ref instead of main, and takes at most one', async () => {
    const h = harness(['install', 'main']);
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.calls).toContain(`/repo> git worktree add --detach ${deployDir} main`);
    expect(await serviceMain(harness(['install', 'a', 'b']).deps)).toBe(2);
  });

  it('adds desktop notifications to the unit only when notify-send is on PATH', async () => {
    const off = harness(['install']);
    expect(await serviceMain(off.deps)).toBe(0);
    expect(off.calls).toContain('/repo> notify-send --version');
    expect(off.files.get(unitPath)).not.toContain('FUNKYOCTOPUS_DESKTOP_NOTIFY');

    const on = harness(['install']);
    answer(on, 'notify-send --version', ok());
    expect(await serviceMain(on.deps)).toBe(0);
    expect(on.files.get(unitPath)).toContain('Environment=FUNKYOCTOPUS_DESKTOP_NOTIFY=1');
    expect(on.errors.join('\n')).not.toContain('notify-send');
  });

  it('reuses an existing worktree and converges without rewriting the unit', async () => {
    const content = renderUnit(deployDir, '/opt/node 22/bin/node', '/tools:/usr/bin');
    const h = harness(['install'], { [unitPath]: content });
    answer(h, 'git worktree list --porcelain', ok(`worktree /repo\n\nworktree ${deployDir}\nHEAD abc\n`));
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.calls.some((call) => call.includes('worktree add'))).toBe(false);
    expect(h.calls.some((call) => call === `write ${unitPath}`)).toBe(false);
    expect(h.calls).not.toContain('/repo> systemctl --user restart funkyoctopus.service');
  });

  it('restarts an already-active service when reinstall changes its unit', async () => {
    const h = harness(['install'], { [unitPath]: 'old unit' });
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.calls).toContain('/repo> systemctl --user is-active --quiet funkyoctopus.service');
    expect(h.calls).toContain('/repo> systemctl --user restart funkyoctopus.service');
    expect(h.calls.indexOf('/repo> systemctl --user daemon-reload')).toBeLessThan(
      h.calls.indexOf('/repo> systemctl --user restart funkyoctopus.service'),
    );
  });
});

describe('deploy', () => {
  function deployHarness(unit = renderUnit(deployDir, '/opt/node 22/bin/node', '/tools:/usr/bin')): Harness {
    const h = harness(['deploy'], { [unitPath]: unit });
    answer(h, 'git rev-parse HEAD', ok('1111111111111111111111111111111111111111\n'), ok('2222222222222222222222222222222222222222\n'));
    return h;
  }

  it.each([
    ['/npm/mise/installs/node/26.13.1/bin/node', '/usr/bin/node', '/npm/mise/installs/node/latest/bin/node'],
    [undefined, '/fallback/mise/installs/node/26.8.1/bin/node', '/fallback/mise/installs/node/latest/bin/node'],
    ['', '/fallback/mise/installs/node/26.8.1/bin/node', '/fallback/mise/installs/node/latest/bin/node'],
  ])('selects npm Node %j or falls back to %s', async (npmNode, execPath, expected) => {
    const h = deployHarness();
    h.deps.env.npm_node_execpath = npmNode;
    h.deps.execPath = execPath;
    h.deps.env.PATH = '/x/mise/installs/node/26.8.1/bin:/usr/bin';
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.files.get(unitPath)).toContain(`ExecStart="${expected}"`);
    expect(h.files.get(unitPath)).toContain('Environment="PATH=/x/mise/installs/node/latest/bin:/usr/bin"');
  });

  it('recovers a custom install directory from the unit when none is supplied', async () => {
    const customDir = '/srv/funky octopus/app';
    const h = deployHarness(renderUnit(customDir, '/opt/node 22/bin/node', '/tools:/usr/bin'));
    expect(await serviceMain(h.deps)).toBe(0);
    expect(h.calls).toContain(`${customDir}> git status --porcelain`);
    expect(h.calls.some((call) => call.startsWith(`${deployDir}>`))).toBe(false);
  });

  it('refuses to restart into a port another sidecar holds', async () => {
    const h = deployHarness();
    answer(h, 'systemctl --user is-active --quiet funkyoctopus.service', fail());
    h.deps.portInUse = () => Promise.resolve(true);
    expect(await serviceMain(h.deps)).toBe(1);
    expect(h.errors.join('\n')).toContain('port 14787 is already answering');
    expect(h.errors.join('\n')).toContain('npm run deploy -- 1111111');
    expect(h.calls.some((call) => call.includes('restart'))).toBe(false);
  });

  it('refuses a dirty deployed copy', async () => {
    const h = deployHarness();
    answer(h, 'git status --porcelain', ok(' M dist/index.html\n'));
    expect(await serviceMain(h.deps)).toBe(1);
    expect(h.calls.some((call) => call.includes('checkout'))).toBe(false);
  });

  it('runs npm ci only when package-lock changed, then restarts and checks health', async () => {
    const unchanged = deployHarness();
    expect(await serviceMain(unchanged.deps)).toBe(0);
    expect(unchanged.calls.some((call) => call.endsWith('npm ci'))).toBe(false);
    expect(unchanged.calls).toContain('/repo> systemctl --user restart funkyoctopus.service');
    expect(unchanged.calls).toContain('health');

    const changed = deployHarness();
    answer(changed, 'git diff --quiet 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 -- package-lock.json', fail());
    expect(await serviceMain(changed.deps)).toBe(0);
    expect(changed.calls).toContain(`${deployDir}> npm ci`);
  });

  it('reloads systemd only when unit content changes', async () => {
    const same = deployHarness();
    expect(await serviceMain(same.deps)).toBe(0);
    expect(same.calls).not.toContain('/repo> systemctl --user daemon-reload');

    const changed = deployHarness('old unit');
    expect(await serviceMain(changed.deps)).toBe(0);
    expect(changed.calls).toContain('/repo> systemctl --user daemon-reload');
  });

  it('adds or drops the desktop-notify line as PATH availability changes', async () => {
    // A unit rendered without the line, but notify-send now on PATH: the unit
    // is rewritten and the line added.
    const add = deployHarness(renderUnit(deployDir, '/opt/node 22/bin/node', '/tools:/usr/bin'));
    answer(add, 'notify-send --version', ok());
    expect(await serviceMain(add.deps)).toBe(0);
    expect(add.files.get(unitPath)).toContain('Environment=FUNKYOCTOPUS_DESKTOP_NOTIFY=1');
    expect(add.calls).toContain('/repo> systemctl --user daemon-reload');

    // A unit rendered with the line, but notify-send gone: the line is
    // dropped, again rewriting the unit. Missing notify-send is not an error.
    const drop = deployHarness(renderUnit(deployDir, '/opt/node 22/bin/node', '/tools:/usr/bin', true));
    expect(await serviceMain(drop.deps)).toBe(0);
    expect(drop.files.get(unitPath)).not.toContain('FUNKYOCTOPUS_DESKTOP_NOTIFY');
    expect(drop.errors).toEqual([]);
  });

  it('prints the requested ref result and a rollback hint after build or health failure', async () => {
    const h = deployHarness();
    h.deps.argv = ['deploy', 'release'];
    answer(h, 'npm run build', fail());
    expect(await serviceMain(h.deps)).toBe(1);
    expect(h.calls).toContain(`${deployDir}> git checkout --detach release`);
    expect(h.errors.join('\n')).toContain('npm run deploy -- 1111111111111111111111111111111111111111');

    const health = deployHarness();
    health.deps.waitForHealth = () => Promise.resolve(false);
    expect(await serviceMain(health.deps)).toBe(1);
    expect(health.errors.join('\n')).toContain('Roll back with');
  });
});

describe('uninstall', () => {
  it('keeps the deployed copy unless --remove-copy is given', async () => {
    const keep = harness(['uninstall'], { [unitPath]: 'unit' });
    expect(await serviceMain(keep.deps)).toBe(0);
    expect(keep.calls).toContain('/repo> systemctl --user disable --now funkyoctopus.service');
    expect(keep.calls.some((call) => call.includes('worktree remove'))).toBe(false);

    const remove = harness(['uninstall', '--remove-copy'], {
      [unitPath]: renderUnit('/srv/custom-app', '/node', '/bin'),
    });
    expect(await serviceMain(remove.deps)).toBe(0);
    expect(remove.calls).toContain('/repo> git worktree remove /srv/custom-app');
  });

  it('fails without removing the unit when disable --now fails', async () => {
    const h = harness(['uninstall'], { [unitPath]: 'unit' });
    answer(h, 'systemctl --user disable --now funkyoctopus.service', fail());
    expect(await serviceMain(h.deps)).toBe(1);
    expect(h.files.get(unitPath)).toBe('unit');
    expect(h.output).toEqual([]);
    expect(h.calls).not.toContain('/repo> systemctl --user daemon-reload');
  });

  it('fails instead of reporting success when daemon-reload fails', async () => {
    const h = harness(['uninstall'], { [unitPath]: 'unit' });
    answer(h, 'systemctl --user daemon-reload', fail());
    expect(await serviceMain(h.deps)).toBe(1);
    expect(h.files.has(unitPath)).toBe(false);
    expect(h.output).toEqual([]);
    expect(h.errors.join('\n')).toContain('daemon-reload failed');
  });
});
