import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Extension, LoadExtensionsResult } from '@earendil-works/pi-coding-agent';
import { CREW_RUNTIME_KEY, crewAbortOwned, crewActiveFor, crewless } from './crew.ts';

function extension(path: string, tools: string[]): Extension {
  return {
    path,
    resolvedPath: path,
    tools: new Map(tools.map((name) => [name, {}])),
  } as unknown as Extension;
}

describe('crewless', () => {
  let base = '';
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  /** A package on disk: its package.json, so its root can be found from a file inside it. */
  function pkg(name: string): string {
    const root = join(base, name);
    mkdirSync(join(root, 'extension'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
    return root;
  }

  it('drops the extension that registers the crew tools, wherever it is installed, and keeps the rest', () => {
    base = mkdtempSync(join(tmpdir(), 'fo-crewless-'));
    const crewRoot = pkg('pi-crew-patched');
    const crew = extension(join(crewRoot, 'extension', 'index.ts'), ['crew_spawn', 'crew_list']);
    const web = extension('/home/example/projects/pi-web-tools/index.ts', ['web_search']);
    const quiet = extension('/x/hooks-only.ts', []);
    const result: LoadExtensionsResult = {
      extensions: [crew, web, quiet],
      errors: [{ path: '/broken.ts', error: 'boom' }],
      runtime: {} as LoadExtensionsResult['runtime'],
    };

    const filtered = crewless().extensionsOverride(result);

    expect(filtered.extensions).toEqual([web, quiet]);
    expect(filtered.errors).toBe(result.errors);
    expect(filtered.runtime).toBe(result.runtime);
  });

  it('drops the skills and prompts that ship in pi-crew’s package, by path, and keeps a look-alike’s', () => {
    base = mkdtempSync(join(tmpdir(), 'fo-crewless-'));
    const crewRoot = pkg('pi-crew');
    const lookalike = pkg('pi-crew-extras');
    const filter = crewless();
    filter.extensionsOverride({
      extensions: [extension(join(crewRoot, 'extension', 'index.ts'), ['crew_spawn'])],
      errors: [],
      runtime: {} as LoadExtensionsResult['runtime'],
    });
    const skill = (filePath: string) => ({ name: 'n', filePath }) as never;

    const skills = filter.skillsOverride({
      skills: [skill(join(crewRoot, 'skills', 'pi-crew', 'SKILL.md')), skill(join(lookalike, 'skills', 'x', 'SKILL.md'))],
      diagnostics: [],
    });
    const prompts = filter.promptsOverride({
      prompts: [skill(join(crewRoot, 'prompts', 'pi-crew-plan.md')), skill('/home/x/.pi/agent/prompts/mine.md')],
      diagnostics: [],
    });

    expect(skills.skills.map((one: { filePath: string }) => one.filePath)).toEqual([join(lookalike, 'skills', 'x', 'SKILL.md')]);
    expect(prompts.prompts.map((one: { filePath: string }) => one.filePath)).toEqual(['/home/x/.pi/agent/prompts/mine.md']);
  });

  it('keeps every skill and prompt when no crew extension was loaded', () => {
    const filter = crewless();
    filter.extensionsOverride({ extensions: [], errors: [], runtime: {} as LoadExtensionsResult['runtime'] });
    const skills = [{ filePath: '/a/SKILL.md' } as never];
    expect(filter.skillsOverride({ skills, diagnostics: [] }).skills).toEqual(skills);
  });
});

describe('crewActiveFor', () => {
  const globals = globalThis as Record<symbol, unknown>;
  afterEach(() => {
    delete globals[CREW_RUNTIME_KEY];
  });

  it('is 0 when pi-crew is not loaded in the process', () => {
    expect(crewActiveFor('s1')).toBe(0);
  });

  it('counts the session’s running subagents through the runtime’s public read, not those awaiting their owner', () => {
    const asked: string[] = [];
    globals[CREW_RUNTIME_KEY] = {
      getActiveSummariesForOwner: (owner: string) => {
        asked.push(owner);
        return owner === 's1'
          ? [
              { id: 'a', status: 'running' },
              { id: 'b', status: 'running' },
              { id: 'c', status: 'completed' },
              { id: 'd', status: 'needs_input' },
            ]
          : [];
      },
    };
    expect(crewActiveFor('s1')).toBe(2);
    expect(crewActiveFor('s2')).toBe(0);
    expect(asked).toEqual(['s1', 's2']);
  });

  it('aborts a session’s subagents through the runtime’s own owner-scoped abort', () => {
    const calls: unknown[] = [];
    globals[CREW_RUNTIME_KEY] = {
      abortAllOwned: (owner: string, opts: unknown) => {
        calls.push([owner, opts]);
        return ['a'];
      },
    };
    crewAbortOwned('s1');
    expect(calls).toEqual([['s1', { reason: expect.any(String) as unknown }]]);
  });

  it('does nothing to abort when pi-crew is not loaded', () => {
    expect(() => crewAbortOwned('s1')).not.toThrow();
  });

  it('is 0 for a runtime without that read (a pi-crew that changed shape)', () => {
    globals[CREW_RUNTIME_KEY] = { activeBinding: {} };
    expect(crewActiveFor('s1')).toBe(0);
  });
});
