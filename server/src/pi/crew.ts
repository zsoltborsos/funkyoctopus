/**
 * FunkyOctopus's two touch points with pi-crew while several pi slots share one
 * process (T2.1, decision 13). pi-crew 1.0.34 keeps one runtime per process
 * with a single active session binding, which every session_start re-points,
 * so only one slot may load it; and the subagents a slot leaves behind when it
 * switches session are only visible in that runtime.
 */

import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type {
  Extension,
  LoadExtensionsResult,
  PromptTemplate,
  ResourceDiagnostic,
  Skill,
} from '@earendil-works/pi-coding-agent';
import { CREW_TOOLS } from '../../../src/shared/transport/protocol.ts';

/** pi-crew is recognised by what it is, an extension registering the crew tools, not by where it is installed. */
function isCrew(extension: Extension): boolean {
  const crewTools = new Set<string>(CREW_TOOLS);
  return [...extension.tools.keys()].some((name) => crewTools.has(name));
}

/** The nearest directory at or above `file`'s holding a package.json: the package the file ships in. */
function packageRoot(file: string): string {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return dirname(file);
}

/**
 * `DefaultResourceLoader` overrides that leave pi-crew out of a session:
 * its extension (so its handlers, session_start above all, and its tools never
 * reach the session's runner) and the skill and prompts its package ships
 * (which tell the model to use tools it does not have). The loader runs them
 * in this order within one reload, after loading and before the runner exists;
 * skills and prompts are matched by pi-crew's package path, found from its
 * extension, wherever that is installed (an npm package, a local path, a
 * patched copy).
 */
export function crewless(): {
  extensionsOverride: (result: LoadExtensionsResult) => LoadExtensionsResult;
  skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  };
  promptsOverride: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
    prompts: PromptTemplate[];
    diagnostics: ResourceDiagnostic[];
  };
} {
  const roots: string[] = [];
  const inCrew = (file: string): boolean => roots.some((root) => file.startsWith(root + sep));
  return {
    extensionsOverride: (result) => {
      for (const extension of result.extensions) if (isCrew(extension)) roots.push(packageRoot(extension.resolvedPath));
      return { ...result, extensions: result.extensions.filter((extension) => !isCrew(extension)) };
    },
    skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => !inCrew(skill.filePath)) }),
    promptsOverride: (base) => ({ ...base, prompts: base.prompts.filter((prompt) => !inCrew(prompt.filePath)) }),
  };
}

/**
 * The global key pi-crew keeps its process runtime under (`extension/crew.ts`).
 * FO uses two public methods of that runtime, a read and an owner-scoped abort;
 * the key and both signatures are pinned in `pi-contract.test.ts` against the
 * installed pi-crew.
 */
export const CREW_RUNTIME_KEY = Symbol.for('pi-crew.runtime');

interface CrewRuntimeView {
  getActiveSummariesForOwner(ownerSessionId: string): readonly { status?: unknown }[];
  abortAllOwned(callerSessionId: string, opts: { reason: string }): string[];
}

function crewRuntime(): Partial<CrewRuntimeView> | null {
  const runtime = (globalThis as Record<symbol, unknown>)[CREW_RUNTIME_KEY];
  return typeof runtime === 'object' && runtime !== null ? runtime : null;
}

/**
 * How many pi-crew subagents a session owns that are still running: status
 * `running`, pi-crew's one in-flight status. A subagent that reported and waits
 * on its owner (`completed`, `needs_input`) is still listed by pi-crew as
 * active, but is spending nothing, so it is not counted. 0 when pi-crew is not
 * loaded in this process.
 *
 * Read-only: the runtime's `getActiveSummariesForOwner`, which pi-crew's own
 * tools and widget call with the caller's session id. There is no tool or
 * event surface that answers for a session other than the caller's.
 */
export function crewActiveFor(sessionId: string): number {
  const runtime = crewRuntime();
  if (typeof runtime?.getActiveSummariesForOwner !== 'function') return 0;
  const summaries = runtime.getActiveSummariesForOwner(sessionId);
  return summaries.filter((summary) => summary.status === 'running').length;
}

/**
 * Abort every subagent a session owns, through the runtime's own owner-scoped
 * abort (what `crew_abort` with `all` does). For a crew slot closing with no
 * live session to quit: pi-crew's `quit` handler, which would abort them, then
 * never runs. A no-op when pi-crew is not loaded.
 */
export function crewAbortOwned(sessionId: string): void {
  const runtime = crewRuntime();
  if (typeof runtime?.abortAllOwned !== 'function') return;
  runtime.abortAllOwned(sessionId, { reason: 'Aborted: its FunkyOctopus chat was closed' });
}
