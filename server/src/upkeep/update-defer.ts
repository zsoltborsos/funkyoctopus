/**
 * When the automatic `pi update --all` waits (T2.1, owner direction
 * 2026-10-18): only when it could swap an extension under crew work in
 * progress. A newer pi-crew installed under a live crew slot replaces its
 * process runtime at the next session build, which aborts every subagent; any
 * updated extension changes code under the sessions that will load it.
 *
 * So it defers only when both hold:
 *   - the owner's pi settings list a package `pi update` would update (not an
 *     exact-pinned npm version, not a git ref, not a local path) that provides
 *     extensions, and
 *   - the crew slot is working: a turn is live, or subagents are running in
 *     its session or in sessions it switched away from.
 * Otherwise it never defers.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatSlotInfo } from '../chat-registry.ts';

/** The reads this needs, synchronous; the real filesystem by default. */
export interface PackageFs {
  readFile(path: string): string;
  exists(path: string): boolean;
}

const realFs: PackageFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  exists: existsSync,
};

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/;
const GIT_PREFIXES = ['git:', 'git+', 'https://', 'http://', 'ssh://', 'git@'];

/** `@scope/name@1.2.3` → name and version; the version is absent for a bare name. */
function npmSpec(spec: string): { name: string; version: string | undefined } {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at < 0 ? { name: spec, version: undefined } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function readJson(fs: PackageFs, path: string): unknown {
  try {
    return JSON.parse(fs.readFile(path)) as unknown;
  } catch {
    return null;
  }
}

/** An installed npm package ships extensions: its pi manifest lists some, or (no manifest list) it has an `extensions` folder. */
function providesExtensions(fs: PackageFs, dir: string): boolean {
  const manifest = readJson(fs, join(dir, 'package.json'));
  if (typeof manifest !== 'object' || manifest === null) return false;
  const pi = (manifest as { pi?: { extensions?: unknown } }).pi;
  if (Array.isArray(pi?.extensions)) return pi.extensions.length > 0;
  return fs.exists(join(dir, 'extensions'));
}

/**
 * The packages in the owner's pi settings that `pi update --all` would update
 * and that provide extensions: npm names, or git sources. Read into memory with
 * plain file reads (pi's own settings storage takes a lock in the agent dir).
 * Empty when the settings cannot be read.
 */
export function updatableExtensionPackages(agentDir: string, fs: PackageFs = realFs): string[] {
  const settings = readJson(fs, join(agentDir, 'settings.json'));
  const packages = (settings as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(packages)) return [];
  const found: string[] = [];
  for (const entry of packages) {
    const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source;
    if (typeof source !== 'string') continue;
    // A settings filter that loads none of its extensions.
    const filter = typeof entry === 'object' ? (entry as { extensions?: unknown }).extensions : undefined;
    if (Array.isArray(filter) && filter.length === 0) continue;
    if (source.startsWith('npm:')) {
      const { name, version } = npmSpec(source.slice('npm:'.length).trim());
      if (version !== undefined && EXACT_VERSION.test(version)) continue;
      const dir = join(agentDir, 'npm', 'node_modules', name);
      if (providesExtensions(fs, dir)) found.push(name);
    } else if (GIT_PREFIXES.some((prefix) => source.startsWith(prefix))) {
      // Pinned to a ref (`…@v1.2.0`) is skipped by pi update. Whether it ships
      // extensions is not checked: counted, which can only defer more.
      const path = source.replace(/^git@[^:]+:/, '').replace(/^[a-z+]+:\/\/[^/]+/, '');
      if (!/@[^@/]+$/.test(path)) found.push(source);
    }
    // Anything else is a local path: pi update never touches it.
  }
  return found;
}

/**
 * Why `pi update --all` should wait now, or null. `running` counts the pi-crew
 * subagents running in a session; `packages` is read only when crew is working.
 */
export function piUpdateDeferral(
  slots: ChatSlotInfo[],
  running: (sessionId: string) => number,
  packages: () => string[],
): string | null {
  // The slot whose live session has pi-crew loaded; one handed crew for its next session has none yet.
  const crew = slots.find((slot) => slot.crew && !slot.crewPending);
  if (!crew) return null;
  const subagents = crew.subagentsLeftRunning + (crew.session ? running(crew.session.id) : 0);
  if (!crew.busy && subagents === 0) return null;
  const updatable = packages();
  if (updatable.length === 0) return null;
  const work = crew.busy ? 'a crew chat turn is running' : `${subagents} crew ${subagents === 1 ? 'subagent is' : 'subagents are'} running`;
  return `deferred: ${work}, and pi update could replace ${updatable.join(', ')} under it`;
}
