import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Sidecar boot routing and the quarantine boundary.
 *
 * The embedded-pi promotion engine lives in `tools/pi-upkeep/` with its own
 * tsconfig and vitest project; the sidecar starts directly through
 * `server/src/entrypoint.ts` (no repository lock, no transaction sentinel) and
 * nothing in the sidecar or the browser may import from `tools/`. Imports are
 * read with TypeScript's own pre-processor (static imports, re-exports,
 * `import()` and `require()`), so comments and strings never count. Paths
 * resolve from the vitest working directory (the repository root) via
 * `process.cwd()`, so the test works in either vitest project.
 */

const repoRoot = process.cwd();
const execFileAsync = promisify(execFile);

async function discoveredTestFiles(config?: string): Promise<string[]> {
  // filesOnly obtains file specifications without loading or executing test modules.
  const args = [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json'];
  if (config) args.push('--config', config);
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const files = JSON.parse(stdout) as { file: string }[];
  return files.map(({ file }) => relative(repoRoot, file).split(sep).join('/'));
}

async function sourceOf(relative: string): Promise<string> {
  return readFile(join(repoRoot, relative), 'utf8');
}

/** Every module specifier a file imports, as TypeScript sees them. */
function importsOf(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((entry) => entry.fileName);
}

async function sourceFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), { recursive: true });
  return entries
    .filter((entry) => /\.(?:ts|tsx)$/.test(entry))
    .map((entry) => join(dir, entry))
    .sort();
}

describe('startup routing', () => {
  it('package.json server scripts route through the entrypoint, never the server core', async () => {
    const pkg = JSON.parse(await sourceOf('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['server:start']).toContain('server/src/entrypoint.ts');
    expect(pkg.scripts['dev:server']).toContain('server/src/entrypoint.ts');
    expect(pkg.scripts['server:start']).not.toContain('server/src/index.ts');
    expect(pkg.scripts['dev:server']).not.toContain('server/src/index.ts');
    // dev:all composes dev:server, so it inherits the entrypoint.
    expect(pkg.scripts['dev:all']).toContain('npm run dev:server');
  });

  it('the entrypoint only loads the settings file and the server core: no lock, no sentinel, no upkeep import', async () => {
    const source = await sourceOf('server/src/entrypoint.ts');
    expect([...importsOf(source)].sort()).toEqual(['./config-file.ts', './index.ts']);
  });

  it('the entrypoint applies the settings file before the server core is loaded', async () => {
    // config.ts snapshots process.env when it is first imported, and ./index.ts
    // pulls it in, so the file has to be applied first.
    const source = await sourceOf('server/src/entrypoint.ts');
    const applied = source.indexOf('applyConfigFile(');
    const core = source.indexOf("import('./index.ts')");
    expect(applied).toBeGreaterThan(-1);
    expect(core).toBeGreaterThan(applied);
  });
});

describe('quarantine boundary', () => {
  it('nothing under server/src or src imports from tools/', async () => {
    const files = [...(await sourceFilesUnder('server/src')), ...(await sourceFilesUnder('src'))];
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(await sourceOf(file))) {
        if (/(?:^|\/)tools\//.test(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the promotion tooling is not part of the default vitest run', async () => {
    const defaultFiles = await discoveredTestFiles();
    expect(defaultFiles.some((file) => file.startsWith('src/'))).toBe(true);
    expect(defaultFiles.some((file) => file.startsWith('server/'))).toBe(true);
    expect(defaultFiles.some((file) => file.startsWith('scripts/'))).toBe(true);
    expect(defaultFiles.filter((file) => file.startsWith('tools/pi-upkeep/'))).toEqual([]);

    const toolsFiles = await discoveredTestFiles('tools/pi-upkeep/vitest.config.ts');
    expect(toolsFiles.length).toBeGreaterThan(0);
    expect(toolsFiles.every((file) => file.startsWith('tools/pi-upkeep/'))).toBe(true);
    const pkg = JSON.parse(await sourceOf('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['upkeep:embedded']).toContain('tools/pi-upkeep/upkeep-cli.ts');
    expect(pkg.scripts['verify:tools']).toContain('test:tools');
    expect(pkg.scripts['verify']).not.toContain('tools');
  }, 45_000);
});
