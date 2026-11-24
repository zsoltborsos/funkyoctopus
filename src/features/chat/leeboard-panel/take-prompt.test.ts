import { describe, expect, it } from 'vitest';
import type { LeeboardEntry } from '@shared/transport/protocol.ts';
import { reviewPrompt, takePrompt } from './take-prompt.ts';

const request: LeeboardEntry = {
  id: 'request-fix-the-login-aa11',
  kind: 'request',
  scope: 'global',
  status: 'active',
  title: 'Fix the login',
  harness: 'claude-code',
  session: 'ca275fb5-bb35',
  created: '',
  updated: '',
  to: 'project:alpha',
};

describe('takePrompt', () => {
  it('names id, kind, author, target, title and body, and asks for reply then close on a request', () => {
    expect(takePrompt(request, 'The login form 500s.\n')).toBe(
      [
        'Leeboard request request-fix-the-login-aa11 from claude-code/ca275fb5-bb35 to project:alpha: Fix the login',
        '',
        'The login form 500s.',
        '',
        'When done, answer with `lb reply request-fix-the-login-aa11 --body "…"`, then `lb close request-fix-the-login-aa11`.',
      ].join('\n'),
    );
  });

  it('asks a handoff to be acknowledged, since lb reply and close take requests only', () => {
    const prompt = takePrompt({ ...request, id: 'handoff-ship-it-bb22', kind: 'handoff' }, '');
    expect(prompt).toContain('Run `lb ack handoff-ship-it-bb22` as you take it on.');
    expect(prompt).not.toContain('lb reply');
    expect(prompt).not.toContain('\n\n\n');
  });

  it('says where the body is when it could not be read, and copes with an unknown author', () => {
    const prompt = takePrompt({ ...request, harness: null, session: '' }, null);
    expect(prompt).toContain('from unknown to project:alpha');
    expect(prompt).toContain('`lb show request-fix-the-login-aa11`');
  });
});

describe('reviewPrompt', () => {
  it('starts with lb review --peek --json and the opened counts, requires consent for writes, and marks seen only last on a yes', () => {
    expect(reviewPrompt({ new: 148, changed: 3, closed: 2 })).toBe([
      'Review the Leeboard owner digest with me, step by step:',
      "1. Run `lb review --peek --json` to read the owner digest (148 new, 3 changed, 2 closed when the panel opened it). Keep the first read's entry IDs and group changes by project and kind.",
      '2. Point out decisions for the owner: stale or duplicated rules and references, holds whose release condition looks met or that have lapsed, unanswered requests and handoffs, and superseded chains. Use `lb show <id>` for bodies. List routine changes in one line without detail.',
      '3. Propose each change as the exact `lb revoke`, `lb supersede`, `lb close`, `lb release`, or `lb revise` command. Run none until the owner agrees to it. Follow the `memory` skill before changing an entry.',
      "4. Finish by asking whether to mark the digest seen. Only on a yes, run `lb review` without `--peek` to move the owner's review cursor. Name any entries in its output absent from the first read: they arrived during the review.",
    ].join('\n'));
  });

  it.each([
    { new: 0, changed: 0, closed: 0 },
    { new: 5, changed: 7, closed: 11 },
  ])('renders the supplied counts: %j', (counts) => {
    expect(reviewPrompt(counts)).toContain(`(${counts.new} new, ${counts.changed} changed, ${counts.closed} closed when the panel opened it)`);
  });
});
