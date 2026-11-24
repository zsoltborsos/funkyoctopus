import { describe, expect, it } from 'vitest';
import type { ChatSlotInfo } from '../chat-registry.ts';
import { piUpdateDeferral, updatableExtensionPackages, type PackageFs } from './update-defer.ts';

const AGENT = '/home/x/.pi/agent';

/** Settings and installed packages, in memory: path → file text; a directory is a key ending in '/'. */
function fs(files: Record<string, string>): PackageFs {
  return {
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return text;
    },
    exists: (path) => path in files || `${path}/` in files,
  };
}

const settings = (packages: unknown[]): string => JSON.stringify({ packages });
const installed = (name: string, manifest: Record<string, unknown>) => ({
  [`${AGENT}/npm/node_modules/${name}/package.json`]: JSON.stringify({ name, ...manifest }),
});

describe('updatableExtensionPackages', () => {
  it('skips what pi update skips: exact-pinned npm packages and local paths', () => {
    const files = fs({
      [`${AGENT}/settings.json`]: settings(['npm:@melihmucuk/pi-crew@1.0.34', '../../projects/pi-web-tools', '/abs/ext']),
      ...installed('@melihmucuk/pi-crew', { pi: { extensions: ['./extension/index.ts'] } }),
    });
    expect(updatableExtensionPackages(AGENT, files)).toEqual([]);
  });

  it('lists an unpinned npm package that ships extensions, by manifest or by an extensions folder', () => {
    const files = fs({
      [`${AGENT}/settings.json`]: settings(['npm:@melihmucuk/pi-crew', 'npm:folder-ext@^2.0.0', 'npm:skills-only']),
      ...installed('@melihmucuk/pi-crew', { pi: { extensions: ['./extension/index.ts'] } }),
      ...installed('folder-ext', {}),
      [`${AGENT}/npm/node_modules/folder-ext/extensions/`]: '',
      ...installed('skills-only', { pi: { skills: ['./skills'] } }),
    });
    expect(updatableExtensionPackages(AGENT, files)).toEqual(['@melihmucuk/pi-crew', 'folder-ext']);
  });

  it('skips a package whose extensions the settings filter out, and one that is not installed', () => {
    const files = fs({
      [`${AGENT}/settings.json`]: settings([{ source: 'npm:filtered', extensions: [] }, 'npm:missing']),
      ...installed('filtered', { pi: { extensions: ['./index.ts'] } }),
    });
    expect(updatableExtensionPackages(AGENT, files)).toEqual([]);
  });

  it('counts an unpinned git package, and skips one pinned to a ref', () => {
    const files = fs({
      [`${AGENT}/settings.json`]: settings(['git:github.com/someone/ext', 'git:github.com/someone/pinned@v1.2.0']),
    });
    expect(updatableExtensionPackages(AGENT, files)).toEqual(['git:github.com/someone/ext']);
  });

  it('is empty when the settings cannot be read or parsed', () => {
    expect(updatableExtensionPackages(AGENT, fs({}))).toEqual([]);
    expect(updatableExtensionPackages(AGENT, fs({ [`${AGENT}/settings.json`]: '{nope' }))).toEqual([]);
  });
});

function crewSlot(overrides: Partial<ChatSlotInfo> = {}): ChatSlotInfo {
  return {
    chatId: 'main',
    kind: 'pi',
    createdAt: 0,
    lastUsedAt: 0,
    crew: true,
    crewPending: false,
    attention: false,
    busy: false,
    session: { engine: 'pi', id: 's1', path: '/s/s1', cwd: '/w', title: 't', created: '', modified: '' },
    root: null,
    subagentsLeftRunning: 0,
    ...overrides,
  };
}

describe('piUpdateDeferral', () => {
  const packages = () => ['@melihmucuk/pi-crew'];
  const none = () => [];

  it('never defers when no slot has crew, or the crew slot is doing nothing', () => {
    expect(piUpdateDeferral([crewSlot({ crew: false })], () => 0, packages)).toBeNull();
    expect(piUpdateDeferral([crewSlot()], () => 0, packages)).toBeNull();
  });

  it.each([
    ['a turn is live', crewSlot({ busy: true }), 0],
    ['it left subagents running', crewSlot({ subagentsLeftRunning: 1 }), 0],
    ['its own session has subagents running', crewSlot(), 2],
  ])('defers while %s and an updatable extension package is installed', (_why, slot, running) => {
    expect(piUpdateDeferral([slot], () => running, packages)).toMatch(/@melihmucuk\/pi-crew/);
  });

  it('never defers when nothing pi update would touch provides extensions, and reads settings only when crew is working', () => {
    let reads = 0;
    const counted = () => {
      reads += 1;
      return [];
    };
    expect(piUpdateDeferral([crewSlot({ busy: true })], () => 0, none)).toBeNull();
    expect(piUpdateDeferral([crewSlot()], () => 0, counted)).toBeNull();
    expect(reads).toBe(0);
  });
});
