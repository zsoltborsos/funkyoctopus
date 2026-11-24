import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverProjects } from './project-discovery.ts';

describe('discoverProjects', () => {
  it('offers a workspace root and immediate folders but excludes nested non-repo folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-projects-'));
    await mkdir(join(root, 'plain-folder', 'nested'), { recursive: true });
    await mkdir(join(root, 'repo', '.git'), { recursive: true });

    const projects = await discoverProjects([root]);

    expect(projects.map((project) => project.path)).toEqual([
      root,
      join(root, 'plain-folder'),
      join(root, 'repo'),
    ]);
    expect(projects[1]).toMatchObject({ name: 'plain-folder', envTier: 'normal' });
  });

  it('includes a repository beneath a non-repo child and keeps its parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-projects-'));
    const repository = join(root, 'group', 'repository');
    await mkdir(join(repository, '.git'), { recursive: true });

    const projects = await discoverProjects([root]);

    expect(projects.map((project) => project.path)).toEqual([root, join(root, 'group'), repository]);
    expect(projects[2]).toEqual({
      id: repository, path: repository, name: 'repository', envTier: 'normal',
    });
  });

  it('excludes non-repository grandchildren', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-projects-'));
    await mkdir(join(root, 'group', 'plain'), { recursive: true });

    expect((await discoverProjects([root])).map((project) => project.path)).toEqual([
      root, join(root, 'group'),
    ]);
  });

  it('does not descend into repository children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-projects-'));
    const repository = join(root, 'repository');
    await mkdir(join(repository, '.git'), { recursive: true });
    await mkdir(join(repository, 'nested', '.git'), { recursive: true });
    await mkdir(join(repository, 'plain'));

    expect((await discoverProjects([root])).map((project) => project.path)).toEqual([
      root, repository,
    ]);
  });

  it('treats .git files as repositories for inclusion and stopping descent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-projects-'));
    const worktree = join(root, 'group', 'worktree');
    const repository = join(root, 'repository');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: /unused/worktree\n');
    await mkdir(join(repository, 'nested', '.git'), { recursive: true });
    await writeFile(join(repository, '.git'), 'gitdir: /unused/repository\n');

    expect((await discoverProjects([root])).map((project) => project.path)).toEqual([
      root, join(root, 'group'), worktree, repository,
    ]);
  });

  it('does not discover repositories deeper than grandchildren', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-projects-'));
    await mkdir(join(root, 'group', 'plain', 'deep-repository', '.git'), { recursive: true });

    expect((await discoverProjects([root])).map((project) => project.path)).toEqual([
      root, join(root, 'group'),
    ]);
  });

  it('sorts and deduplicates nested repositories also configured as roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funkyoctopus-projects-'));
    const repository = join(root, 'group', 'repository');
    await mkdir(join(repository, '.git'), { recursive: true });

    const projects = await discoverProjects([repository, root, root]);

    expect(projects.map((project) => project.path)).toEqual([
      root, join(root, 'group'), repository, join(repository, '.git'),
    ].sort((a, b) => a.localeCompare(b)));
  });
});
