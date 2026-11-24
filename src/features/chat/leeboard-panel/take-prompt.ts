import type { LeeboardEntry } from '@shared/transport/protocol.ts';

/**
 * The unsent prompt "Take it" puts in a tab's composer (T3 L5): the entry, who
 * sent it, and the Leeboard commands that close the loop for its kind. The
 * owner reads it and presses Enter; nothing here sends it.
 *
 * Leeboard's lifecycle differs by kind: a handoff is acknowledged (`lb ack`
 * marks it done), a request is answered (`lb reply` appends the answer the
 * asking tab reads) and then closed. `lb ack` refuses a request and `lb reply`
 * a handoff, so each prompt names only its own commands.
 */
export function takePrompt(entry: LeeboardEntry, body: string | null): string {
  const from = [entry.harness ?? 'unknown', entry.session].filter(Boolean).join('/');
  const text = body === null ? `(body not read here: \`lb show ${entry.id}\`)` : body.trim();
  const close =
    entry.kind === 'handoff'
      ? `Run \`lb ack ${entry.id}\` as you take it on.`
      : `When done, answer with \`lb reply ${entry.id} --body "…"\`, then \`lb close ${entry.id}\`.`;
  return [
    `Leeboard ${entry.kind} ${entry.id} from ${from}${entry.to ? ` to ${entry.to}` : ''}: ${entry.title}`,
    ...(text ? ['', text] : []),
    '',
    close,
  ].join('\n');
}

export function reviewPrompt(counts: { new: number; changed: number; closed: number }): string {
  return [
    'Review the Leeboard owner digest with me, step by step:',
    `1. Run \`lb review --peek --json\` to read the owner digest (${counts.new} new, ${counts.changed} changed, ${counts.closed} closed when the panel opened it). Keep the first read's entry IDs and group changes by project and kind.`,
    '2. Point out decisions for the owner: stale or duplicated rules and references, holds whose release condition looks met or that have lapsed, unanswered requests and handoffs, and superseded chains. Use `lb show <id>` for bodies. List routine changes in one line without detail.',
    '3. Propose each change as the exact `lb revoke`, `lb supersede`, `lb close`, `lb release`, or `lb revise` command. Run none until the owner agrees to it. Follow the `memory` skill before changing an entry.',
    "4. Finish by asking whether to mark the digest seen. Only on a yes, run `lb review` without `--peek` to move the owner's review cursor. Name any entries in its output absent from the first read: they arrived during the review.",
  ].join('\n');
}
