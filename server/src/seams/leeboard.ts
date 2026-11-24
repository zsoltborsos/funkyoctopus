import type { MethodRegistry } from '../transport/registry.ts';
import type { ChatSlots } from '../chat-registry.ts';
import { config } from '../config.ts';
import { expandHome } from '../projects/project-discovery.ts';
import { defaultLbRunner, type LbCliRunner } from '../leeboard/cli.ts';
import { isEntryId, readActiveHolds, readActiveInbox, readAsked, readBrief, readEntry, readReview } from '../leeboard/reads.ts';
import { knownProjects } from '../projects/registry.ts';
import { CHAT_NOT_FOUND, WireCallError } from '../../../src/shared/transport/errors.ts';
import type {
  ChatSlotInfo,
  LeeboardEntry,
  LeeboardOpenResult,
  LeeboardRouted,
  ProjectOption,
} from '../../../src/shared/transport/protocol.ts';
import { parseChatId } from './chat.ts';

/**
 * The Leeboard panel's reads (T3 L3): the brief for a chat slot's folder, one
 * entry's body, and the owner digest; and (L5) the open requests and handoffs
 * routed to the tabs they belong in, the requests a tab's session asked,
 * and active holds across every scope.
 * Read-only, asked by the browser, never polled here.
 */
export function registerLeeboardSeam(
  registry: MethodRegistry,
  chats: Pick<ChatSlots, 'list'>,
  run: LbCliRunner = defaultLbRunner,
  globalRoot: string = expandHome(config.primaryWorkspaceRoot),
  projects: () => Promise<ProjectOption[]> = () => knownProjects(run),
): void {
  // **The folder is the slot's, never the browser's**: the panel shows what the
  // tab's agent works in. Read from the slot list so a display read does not
  // mark the slot used.
  registry.call('leeboard.brief', (params) => {
    const chatId = parseChatId('leeboard.brief', params);
    const slot = chats.list().find((s) => s.chatId === chatId);
    if (!slot) throw new WireCallError(`no chat ${chatId}`, CHAT_NOT_FOUND);
    return readBrief(run, slot.root ?? globalRoot);
  });

  registry.call('leeboard.show', (params) => {
    const id = typeof params === 'object' && params !== null ? (params as Record<string, unknown>).id : undefined;
    if (!isEntryId(id)) throw new Error('leeboard.show requires { id } naming a Leeboard entry');
    return readEntry(run, id);
  });

  registry.call('leeboard.review', () => readReview(run));

  registry.call('leeboard.holds', () => readActiveHolds(run));

  registry.call('leeboard.open', async (): Promise<LeeboardOpenResult> => {
    const [inbox, listed] = await Promise.all([readActiveInbox(run), projects().catch(() => [])]);
    if ('error' in inbox) return { open: null, error: inbox.error };
    const slots = chats.list();
    return {
      open: inbox.entries
        .map((entry) => route(entry, slots, listed, globalRoot))
        .filter((row): row is LeeboardRouted => row !== null),
    };
  });

  // The session is the slot's, never the browser's: what this tab's agent wrote as itself.
  registry.call('leeboard.asked', (params) => {
    const chatId = parseChatId('leeboard.asked', params);
    const slot = chats.list().find((s) => s.chatId === chatId);
    if (!slot) throw new WireCallError(`no chat ${chatId}`, CHAT_NOT_FOUND);
    return slot.session ? readAsked(run, slot.session.id) : { asked: [] };
  });
}

/**
 * Where an entry goes: a `project:<name>` target to that project's most
 * recently used open tab (and its folder, for a new one), a `session:<id>`
 * target to the tab holding the session. `any` and `harness:` targets have no
 * one tab, so they are not routed (each tab's brief inbox lists them).
 */
function route(entry: LeeboardEntry, slots: ChatSlotInfo[], projects: ProjectOption[], globalRoot: string): LeeboardRouted | null {
  const to = entry.to ?? '';
  if (to.startsWith('session:')) {
    const id = to.slice('session:'.length);
    const holder = slots.find((slot) => slot.session?.id === id);
    return { ...entry, chatId: holder?.chatId ?? null, folder: null };
  }
  if (!to.startsWith('project:')) return null;
  const name = to.slice('project:'.length);
  const folder = projects.find((project) => project.name === name)?.path ?? null;
  const tab = slots
    .filter((slot) => folder !== null && projectOf(slot.root ?? globalRoot, projects) === name)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
  return { ...entry, chatId: tab?.chatId ?? null, folder };
}

/** The project a folder belongs to: the one whose folder holds it most closely (nested projects pick the inner one). */
function projectOf(root: string, projects: ProjectOption[]): string | null {
  let best: ProjectOption | null = null;
  for (const project of projects) {
    const inside = root === project.path || root.startsWith(project.path.endsWith('/') ? project.path : `${project.path}/`);
    if (inside && (!best || project.path.length > best.path.length)) best = project;
  }
  return best?.name ?? null;
}
