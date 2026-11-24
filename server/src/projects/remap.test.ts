import { describe, expect, it } from 'vitest';
import { remapCwd } from './remap.ts';
import type { ProjectPaths } from './registry.ts';

/** Non-async convenience: always returns a resolved promise. */
const dirs = (...paths: string[]) => {
  const set = new Set(paths);
  return (path: string) => Promise.resolve(set.has(path));
};

const project = (name: string, path: string, oldPaths: string[]): ProjectPaths => ({
  name,
  path,
  oldPaths,
});

describe('remapCwd', () => {
  it('returns an existing cwd unchanged, with no movedFrom', async () => {
    const index = [project('helmraiser', '/home/example/projects/helmraiser', ['/old/helmraiser'])];
    expect(await remapCwd('/home/example/projects/helmraiser', index, dirs('/home/example/projects/helmraiser'))).toEqual({
      cwd: '/home/example/projects/helmraiser',
    });
  });

  it('maps an exact old path onto the project root', async () => {
    const index = [project('helmraiser', '/home/example/projects/helmraiser', ['/home/example/Desktop/dev/helmraiser'])];
    expect(
      await remapCwd(
        '/home/example/Desktop/dev/helmraiser',
        index,
        dirs('/home/example/projects/helmraiser'),
      ),
    ).toEqual({
      cwd: '/home/example/projects/helmraiser',
      movedFrom: '/home/example/Desktop/dev/helmraiser',
    });
  });

  it('keeps a subfolder suffix that exists under the current path', async () => {
    const index = [project('alpha', '/home/example/projects/alpha', ['/home/example/work/alpha'])];
    expect(
      await remapCwd(
        '/home/example/work/alpha/packages/core',
        index,
        dirs('/home/example/projects/alpha/packages/core'),
      ),
    ).toEqual({
      cwd: '/home/example/projects/alpha/packages/core',
      movedFrom: '/home/example/work/alpha/packages/core',
    });
  });

  it('falls back to the project root when the mapped subfolder is gone', async () => {
    const index = [project('acme-app', '/home/example/work/acme-app', ['/home/example/old-work/acme-app'])];
    expect(
      await remapCwd(
        '/home/example/old-work/acme-app/apps/server',
        index,
        dirs('/home/example/work/acme-app'),
      ),
    ).toEqual({
      cwd: '/home/example/work/acme-app',
      movedFrom: '/home/example/old-work/acme-app/apps/server',
    });
  });

  it('gives the longest matching old path precedence over a shorter parent', async () => {
    const index = [
      project('alpha', '/home/example/projects/alpha', ['/home/example/Desktop/dev/alpha']),
      project(
        'alpha-suite',
        '/home/example/projects/alpha-suite',
        ['/home/example/Desktop/dev/alpha/alpha-suite'],
      ),
    ];
    const dirsNow = dirs(
      '/home/example/projects/alpha-suite/packages/core',
      '/home/example/projects/alpha-suite/packages/app',
      '/home/example/projects/alpha',
    );
    expect(
      await remapCwd('/home/example/Desktop/dev/alpha/alpha-suite/packages/core', index, dirsNow),
    ).toEqual({
      cwd: '/home/example/projects/alpha-suite/packages/core',
      movedFrom: '/home/example/Desktop/dev/alpha/alpha-suite/packages/core',
    });
    // A sibling prefix that is not the longest does not steal the match; its
    // movedFrom is the vanished subfolder, faithfully reported.
    expect(await remapCwd('/home/example/Desktop/dev/alpha/src', index, dirsNow)).toEqual({
      cwd: '/home/example/projects/alpha',
      movedFrom: '/home/example/Desktop/dev/alpha/src',
    });
    // A dead exact-old-path match has no subfolder suffix to keep, so it is
    // unmappable — per the spec, only subfolder matches fall back to the root.
    expect(await remapCwd('/home/example/Downloads/dev/alpha/alpha-suite/erased', index, dirsNow)).toBeNull();
  });

  it('returns null when nothing in the index matches', async () => {
    const index = [project('helmraiser', '/home/example/projects/helmraiser', ['/old/helmraiser'])];
    expect(await remapCwd('/home/example/work/elsewhere', index, dirs())).toBeNull();
  });

  it('does not treat a subfolder of a dead exact-old-path as a subfolder match', async () => {
    // `/old/root` is a dead registered root; `/old/root/sub` is a subfolder of
    // it. The candidate under the current path is gone, and because the cwd
    // itself is not the old path it counts as a subfolder match and falls back
    // to the project root — which exists — and reports it.
    const index = [project('old', '/new/root', ['/old/root'])];
    expect(await remapCwd('/old/root/sub', index, dirs('/new/root'))).toEqual({
      cwd: '/new/root',
      movedFrom: '/old/root/sub',
    });
  });
});
