import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SDK_PACKAGE = '@earendil-works/pi-coding-agent';
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function dependencyVersion(document: unknown, packageName: string = SDK_PACKAGE): string | undefined {
  if (typeof document !== 'object' || document === null || !('dependencies' in document)) {
    return undefined;
  }

  const dependencies = document.dependencies;
  if (typeof dependencies !== 'object' || dependencies === null) return undefined;
  const version = (dependencies as Record<string, unknown>)[packageName];
  return typeof version === 'string' ? version : undefined;
}

function lockDependencyVersion(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null || !('packages' in document)) {
    return undefined;
  }

  const packages = document.packages;
  if (typeof packages !== 'object' || packages === null || !('' in packages)) return undefined;
  return dependencyVersion(packages['']);
}

describe('embedded pi SDK pin', () => {
  it('keeps the package, lockfile, and installed SDK on one exact stable version', () => {
    const packageVersion = dependencyVersion(readJson(resolve(REPOSITORY_ROOT, 'package.json')));
    const lockVersion = lockDependencyVersion(
      readJson(resolve(REPOSITORY_ROOT, 'package-lock.json')),
    );
    const installed = readJson(
      resolve(REPOSITORY_ROOT, 'node_modules', SDK_PACKAGE, 'package.json'),
    );
    const installedVersion =
      typeof installed === 'object' && installed !== null && 'version' in installed
        ? installed.version
        : undefined;

    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockVersion).toBe(packageVersion);
    expect(installedVersion).toBe(packageVersion);
  });
});

describe('approved dependency exact pins', () => {
  it.each([
    'react-markdown',
    'remark-gfm',
    'rehype-highlight',
    '@anthropic-ai/claude-agent-sdk',
  ])('keeps %s on an exact stable version', (packageName) => {
    const manifest = readJson(resolve(REPOSITORY_ROOT, 'package.json'));
    const version = dependencyVersion(manifest, packageName);

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
