import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { MethodRegistry } from '../transport/registry.ts';
import { oneSlot, onMain } from '../test/one-slot.ts';
import { registerChatSeam } from './chat.ts';
import type { PiChat } from '../pi/pi-chat.ts';
import { CHAT_IMAGE_LIMITS, type ProjectOption } from '../../../src/shared/transport/protocol.ts';
import type { LbCliRunner } from '../leeboard/cli.ts';

/** Params reach `PiChat.send` only once they have been validated at the seam. */
function setup(sessionRoot?: string) {
  const send = vi.fn(
    (_text: string, _signal: AbortSignal, _opts: object, _origin?: unknown): AsyncIterable<unknown> =>
      (async function* () {})(),
  );
  const piChat = {
    send,
    newChat: vi.fn(() => Promise.resolve(null)),
    openChat: vi.fn(() => Promise.resolve([])),
    setRoot: vi.fn(() => Promise.resolve([])),
    observe: vi.fn(() => (async function* () {})()),
    transcript: vi.fn(() => Promise.resolve([{ id: 'm', role: 'user', steps: [], createdAt: 0 }])),
  } as unknown as PiChat;
  const registry = new MethodRegistry();
  registerChatSeam(registry, oneSlot(piChat), undefined, sessionRoot);
  const entry = registry.get('chat.send');
  if (!entry || entry.kind !== 'stream') throw new Error('missing stream chat.send');
  const stream = (params: unknown): AsyncIterable<unknown> =>
    entry.handler(onMain(params), { signal: new AbortController().signal });
  const call = (method: string, params: unknown = {}): Promise<unknown> => {
    const callEntry = registry.get(method);
    if (!callEntry || callEntry.kind !== 'call') throw new Error(`missing call ${method}`);
    return Promise.resolve(callEntry.handler(onMain(params), { signal: new AbortController().signal }));
  };
  const streamMethod = (method: string, params: unknown): AsyncIterator<unknown> => {
    const streamEntry = registry.get(method);
    if (!streamEntry || streamEntry.kind !== 'stream') throw new Error(`missing stream ${method}`);
    return streamEntry.handler(onMain(params), { signal: new AbortController().signal })[
      Symbol.asyncIterator
    ]();
  };
  return {
    stream,
    streamMethod,
    call,
    piChat: piChat as unknown as {
      send: ReturnType<typeof vi.fn>;
      newChat: ReturnType<typeof vi.fn>;
      openChat: ReturnType<typeof vi.fn>;
      setRoot: ReturnType<typeof vi.fn>;
      observe: ReturnType<typeof vi.fn>;
      transcript: ReturnType<typeof vi.fn>;
    },
  };
}

type PiChatLike = {
  send: ReturnType<typeof vi.fn>;
  newChat: ReturnType<typeof vi.fn>;
  openChat: ReturnType<typeof vi.fn>;
  setRoot: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  transcript: ReturnType<typeof vi.fn>;
};

describe('chat.exists guarded readback', () => {
  let scratch = '';
  let root = '';
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fo-session-seam-'));
    root = join(scratch, 'sessions');
    await mkdir(root);
    await mkdir(join(scratch, 'sessions-other'));
    await mkdir(join(root, 'directory.jsonl'));
    await writeFile(join(root, 'valid.jsonl'), '{}');
    await writeFile(join(root, 'wrong.txt'), '{}');
    await writeFile(join(scratch, 'outside.jsonl'), '{}');
    await writeFile(join(scratch, 'sessions-other', 'sibling.jsonl'), '{}');
    await symlink(join(scratch, 'outside.jsonl'), join(root, 'escape.jsonl'));
    await symlink(join(scratch, 'sessions-other'), join(root, 'parent'));
    await symlink(join(root, 'valid.jsonl'), join(root, 'inside.jsonl'));
  });
  afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

  it('confirms regular session files, including contained symlinks, without changing chat', async () => {
    const { call, piChat } = setup(root);
    for (const name of ['valid.jsonl', 'inside.jsonl']) {
      expect(await call('chat.exists', { path: join(root, name) })).toEqual({ exists: true });
    }
    for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
  });

  it('rejects missing, unsafe, wrong-extension and non-file paths without changing chat', async () => {
    const { call, piChat } = setup(root);
    for (const path of [
      join(root, 'missing.jsonl'), 'relative.jsonl', '/bad\0.jsonl',
      join(root, 'wrong.txt'), join(root, 'directory.jsonl'),
      join(scratch, 'outside.jsonl'), join(scratch, 'sessions-other', 'sibling.jsonl'),
      `${root}/../outside.jsonl`, join(root, 'escape.jsonl'),
      join(root, 'parent', 'sibling.jsonl'),
    ]) {
      expect(await call('chat.exists', { path })).toEqual({ exists: false });
    }
    for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
  });

  it('rejects malformed parameter shapes synchronously', () => {
    const { call, piChat } = setup(root);
    for (const params of [null, {}, { path: 4 }, { path: '' }]) {
      expect(() => call('chat.exists', params)).toThrow('chat.exists requires { path: string }');
    }
    for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('chat.open is contained to pi session store', () => {
  let scratch = '';
  let store = '';
  const named = (id: string): string => `2026-10-19T00-00-00-000Z_${id}.jsonl`;
  const header = (id: string): string =>
    `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-19T00:00:00.000Z', cwd: '/w' })}\n`;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'fo-open-guard-'));
    store = join(scratch, 'sessions');
    await mkdir(join(store, '--w--'), { recursive: true });
    await mkdir(join(scratch, 'elsewhere'));
    await writeFile(join(store, '--w--', named('in-1')), header('in-1'));
    await writeFile(join(scratch, 'elsewhere', named('out-1')), header('out-1'));
    await symlink(join(scratch, 'elsewhere', named('out-1')), join(store, '--w--', named('link-1')));
    await symlink(join(scratch, 'elsewhere'), join(store, 'linked-dir'));
    await symlink(store, join(scratch, 'store-alias'));
  });
  afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

  it('refuses a pi session file outside the store, naming the path, without touching the chat', async () => {
    const { call, piChat } = setup(store);
    const outside = join(scratch, 'elsewhere', named('out-1'));
    await expect(call('chat.open', { path: outside, clientId: 'owner' })).rejects.toMatchObject({
      name: 'WireCallError',
      code: 'bad_session_path',
      message: expect.stringContaining(outside) as string,
    });
    await expect(call('chat.open', { path: outside })).rejects.toThrow("pi's session store");
    for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a ".." traversal out of the store', async () => {
    const { call, piChat } = setup(store);
    const traversal = `${store}/--w--/../../elsewhere/${named('out-1')}`;
    await expect(call('chat.open', { path: traversal })).rejects.toMatchObject({ code: 'bad_session_path' });
    for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a symlink inside the store that points outside it, to a file or through a directory', async () => {
    const { call, piChat } = setup(store);
    for (const path of [
      join(store, '--w--', named('link-1')),
      join(store, 'linked-dir', named('out-1')),
    ]) {
      await expect(call('chat.open', { path })).rejects.toMatchObject({ code: 'bad_session_path' });
    }
    for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a path that does not exist and a relative one', async () => {
    const { call, piChat } = setup(store);
    for (const path of [join(store, '--w--', named('gone-1')), `--w--/${named('in-1')}`]) {
      await expect(call('chat.open', { path })).rejects.toMatchObject({ code: 'bad_session_path' });
    }
    for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
  });

  it('opens a session file inside the store, handing the engine its canonical path', async () => {
    const { call, piChat } = setup(store);
    const canonical = join(await realpath(store), '--w--', named('in-1'));
    // Submitted through a symlink to the store; what is opened is the real file.
    const submitted = join(scratch, 'store-alias', '--w--', named('in-1'));
    expect(await call('chat.open', { path: submitted, clientId: 'owner' })).toEqual({ items: [] });
    expect(piChat.openChat).toHaveBeenCalledExactlyOnceWith(canonical, 'owner');
  });

  it('still works when the store root itself is a symlink', async () => {
    const { call, piChat } = setup(join(scratch, 'store-alias'));
    const canonical = join(await realpath(store), '--w--', named('in-1'));
    expect(await call('chat.open', { path: join(scratch, 'store-alias', '--w--', named('in-1')) })).toEqual({ items: [] });
    expect(piChat.openChat).toHaveBeenCalledExactlyOnceWith(canonical, null);
  });
});

describe('chat clientId parsing', () => {
  // chat.open takes only a file inside the store, so this one is a real (empty) file in a temp store.
  const store = mkdtempSync(join(tmpdir(), 'fo-clientid-'));
  const stored = join(store, '2026-10-19T00-00-00-000Z_cid-1.jsonl');
  writeFileSync(stored, '{}');
  afterAll(() => rmSync(store, { recursive: true, force: true }));

  const cases: Array<{ method: string; fn: keyof PiChatLike; base: unknown; valid: unknown; kind: 'call' | 'stream' }> = [
    { method: 'chat.send', fn: 'send', base: { text: 'hi' }, valid: { text: 'hi', clientId: 'browser-1' }, kind: 'stream' },
    { method: 'chat.new', fn: 'newChat', base: {}, valid: { clientId: 'cli-1' }, kind: 'call' },
    { method: 'chat.open', fn: 'openChat', base: { path: stored }, valid: { path: stored, clientId: 'cli-1' }, kind: 'call' },
    { method: 'chat.setRoot', fn: 'setRoot', base: { path: '/p' }, valid: { path: '/p', clientId: 'cli-1' }, kind: 'call' },
    { method: 'chat.observe', fn: 'observe', base: {}, valid: { clientId: 'browser-1' }, kind: 'stream' },
  ];
  const run = (
    kind: 'call' | 'stream',
    streamMethod: (m: string, p: unknown) => AsyncIterator<unknown>,
    call: (m: string, p?: unknown) => Promise<unknown>,
    method: string,
    params: unknown,
  ): unknown => (kind === 'stream' ? streamMethod(method, params).next() : call(method, params));

  it('passes a string clientId through to PiChat', async () => {
    for (const caseEntry of cases) {
      const { streamMethod, call, piChat } = setup(store);
      await run(caseEntry.kind, streamMethod, call, caseEntry.method, caseEntry.valid);
      const fn = piChat[caseEntry.fn];
      expect(fn).toHaveBeenCalledTimes(1);
      const args = fn.mock.calls[0] as unknown[];
      expect(args.at(-1)).toBe(
        (caseEntry.valid as { clientId: string }).clientId,
      );
    }
  });

  it('passes null when clientId is absent', async () => {
    for (const caseEntry of cases) {
      const { streamMethod, call, piChat } = setup(store);
      await run(caseEntry.kind, streamMethod, call, caseEntry.method, caseEntry.base);
      const fn = piChat[caseEntry.fn];
      expect((fn.mock.calls[0] as unknown[]).at(-1)).toBeNull();
    }
  });

  it('rejects a wrong-typed clientId before PiChat is called', () => {
    for (const caseEntry of cases) {
      for (const bad of [5, true, { a: 1 }]) {
        const { streamMethod, call, piChat } = setup(store);
        const params = { ...(caseEntry.base as object), clientId: bad };
        // The parser throws synchronously, before any handler work.
        expect(() =>
          run(caseEntry.kind, streamMethod, call, caseEntry.method, params),
        ).toThrow(`${caseEntry.method}: clientId must be a string`);
        for (const fn of Object.values(piChat)) expect(fn).not.toHaveBeenCalled();
      }
    }
  });
});

/**
 * `config.ts` snapshots its env at import, so project tests must point the seam
 * at temporary directories: stub the env, reset the module registry, reload the
 * seam module, then register against a fresh registry.
 */
function setConfigEnv(workspaceRoot: string, projectRoots: string[]): void {
  vi.stubEnv('FUNKYOCTOPUS_WORKSPACE_ROOT', workspaceRoot);
  vi.stubEnv('FUNKYOCTOPUS_PROJECT_ROOTS', projectRoots.join(','));
  vi.resetModules();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Registers the seam against the reloaded config and returns call handlers. */
async function setupForProjectTests(runner: LbCliRunner) {
  const piChat = { send: vi.fn() } as unknown as PiChat;
  const registry = new MethodRegistry();
  const { registerChatSeam: registerFresh } = await import('./chat.ts');
  registerFresh(registry, oneSlot(piChat), runner);
  const call = (method: string, params: unknown = {}): Promise<unknown> => {
    const entry = registry.get(method);
    if (!entry || entry.kind !== 'call') throw new Error(`missing call ${method}`);
    return Promise.resolve(entry.handler(params, { signal: new AbortController().signal }));
  };
  return { call };
}

const image = (data = 'AAA', mimeType = 'image/png') => ({ mimeType, data });

describe('chat.send params', () => {
  it('passes validated images through to the chat orchestrator', () => {
    const { stream, piChat } = setup(); const send = piChat.send;
    stream({ text: 'what is this?', images: [image(), image('BBB', 'image/jpeg')] });
    expect(send).toHaveBeenCalledWith(
      'what is this?',
      expect.anything(),
      expect.objectContaining({
        text: 'what is this?',
        images: [
          { mimeType: 'image/png', data: 'AAA' },
          { mimeType: 'image/jpeg', data: 'BBB' },
        ],
      }),
      null,
    );
  });

  it('omits the key entirely for an absent or empty image list', () => {
    const { stream, piChat } = setup(); const send = piChat.send;
    stream({ text: 'plain' });
    stream({ text: 'plain', images: [] });
    for (const call of send.mock.calls) {
      expect(Object.keys(call[2] as object)).not.toContain('images');
    }
  });

  it('still requires text — an image-only message is rejected at the seam', () => {
    const { stream, piChat } = setup(); const send = piChat.send;
    expect(() => stream({ images: [image()] })).toThrow('chat.send requires { text: string }');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an images value that is not an array', () => {
    const { stream, piChat } = setup(); const send = piChat.send;
    expect(() => stream({ text: 'hi', images: 'AAA' })).toThrow('chat.send images: must be an array');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects more images than one message may carry', () => {
    const { stream, piChat } = setup(); const send = piChat.send;
    const tooMany = Array.from({ length: CHAT_IMAGE_LIMITS.count + 1 }, () => image());
    expect(() => stream({ text: 'hi', images: tooMany })).toThrow(
      `chat.send images: at most ${CHAT_IMAGE_LIMITS.count} images`,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('names the offending index for a non-object entry', () => {
    const { stream } = setup();
    expect(() => stream({ text: 'hi', images: [image(), 'AAA'] })).toThrow(
      'chat.send images[1]: must be an object',
    );
  });

  it('names the offending index for a mimeType that is not an image type', () => {
    const { stream } = setup();
    expect(() =>
      stream({ text: 'hi', images: [image(), image(), image('AAA', 'application/pdf')] }),
    ).toThrow('chat.send images[2]: mimeType must be image/*');
  });

  it('rejects empty or non-string data', () => {
    const { stream } = setup();
    expect(() => stream({ text: 'hi', images: [{ mimeType: 'image/png', data: '' }] })).toThrow(
      'chat.send images[0]: data must be a non-empty base64 string',
    );
    expect(() => stream({ text: 'hi', images: [{ mimeType: 'image/png', data: 7 }] })).toThrow(
      'chat.send images[0]: data must be a non-empty base64 string',
    );
  });

  it('rejects a payload over the per-image base64 ceiling', () => {
    const { stream } = setup();
    const oversized = 'A'.repeat(CHAT_IMAGE_LIMITS.base64Length + 1);
    expect(() => stream({ text: 'hi', images: [{ mimeType: 'image/png', data: oversized }] })).toThrow(
      `chat.send images[0]: data exceeds ${CHAT_IMAGE_LIMITS.base64Length} base64 characters`,
    );
  });
});

describe('chat.transcript wiring', () => {
  it('delegates to the non-constructing readback and returns its timeline', async () => {
    const { call, piChat } = setup();
    const items = await call('chat.transcript', {});
    expect(items).toEqual([{ id: 'm', role: 'user', steps: [], createdAt: 0 }]);
    expect(piChat.transcript).toHaveBeenCalledOnce();
  });
});

describe('projects.discover / projects.resolve', () => {
  let scratch = '';
  let personal = '';
  let work = '';

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'funkyoctopus-seam-'));
    personal = join(scratch, 'personal');
    work = join(scratch, 'work');
    await mkdir(join(personal, 'helmraiser'), { recursive: true });
    await mkdir(join(work, 'acme-app'), { recursive: true });
    await writeFile(join(scratch, 'plain.txt'), 'x');
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function fakeLb(): LbCliRunner {
    return vi.fn((args) => {
      expect(args).toEqual(['project', 'list', '--json']);
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([
          { name: 'helmraiser', aliases: [], paths: [join(scratch, 'former-helmraiser'), join(personal, 'helmraiser')], remotes: [] },
        ]),
        stderr: '',
      });
    });
  }

  it('projects.discover returns the catalog from sidecar config, not browser params', async () => {
    setConfigEnv(join(scratch, 'global'), [personal, work]);
    const run = fakeLb();
    const { call } = await setupForProjectTests(run);
    const catalog = (await call('projects.discover', { nonsense: true })) as {
      globalRoot: string;
      known: ProjectOption[];
      folders: ProjectOption[];
    };
    expect(catalog.globalRoot).toBe(join(scratch, 'global'));
    expect(catalog.known).toEqual([
      {
        id: join(personal, 'helmraiser'),
        name: 'helmraiser',
        path: join(personal, 'helmraiser'),
        envTier: 'normal',
      },
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(catalog.folders.map((folder) => folder.path)).toEqual([
      personal,
      join(personal, 'helmraiser'),
      work,
      join(work, 'acme-app'),
    ]);
  });

  it('projects.resolve returns a canonical option with the Leeboard name', async () => {
    setConfigEnv(join(scratch, 'global'), [personal]);
    const run = fakeLb();
    const { call } = await setupForProjectTests(run);
    const option = (await call('projects.resolve', { path: join(personal, 'helmraiser') })) as ProjectOption;
    expect(option).toEqual({
      id: join(personal, 'helmraiser'),
      name: 'helmraiser',
      path: join(personal, 'helmraiser'),
      envTier: 'normal',
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('projects.resolve names an unknown directory by basename', async () => {
    setConfigEnv(join(scratch, 'global'), [personal]);
    const { call } = await setupForProjectTests(fakeLb());
    const target = join(work, 'acme-app');
    const option = (await call('projects.resolve', { path: target })) as ProjectOption;
    expect(option).toEqual({ id: target, name: 'acme-app', path: target, envTier: 'normal' });
  });

  it('projects.resolve rejects a regular file', async () => {
    setConfigEnv(join(scratch, 'global'), []);
    const { call } = await setupForProjectTests(fakeLb());
    await expect(call('projects.resolve', { path: join(scratch, 'plain.txt') })).rejects.toMatchObject({
      message: `not a folder: ${join(scratch, 'plain.txt')}`,
      code: 'folder_not_found',
    });
  });

  it('projects.resolve rejects a missing path', async () => {
    setConfigEnv(join(scratch, 'global'), []);
    const { call } = await setupForProjectTests(fakeLb());
    await expect(call('projects.resolve', { path: join(scratch, 'nope') })).rejects.toMatchObject({
      message: `no such folder: ${join(scratch, 'nope')}`,
      code: 'folder_not_found',
    });
  });

  it('projects.resolve requires the { path } params shape', async () => {
    setConfigEnv(join(scratch, 'global'), []);
    const { call } = await setupForProjectTests(fakeLb());
    await expect(call('projects.resolve', {})).rejects.toThrow(
      'projects.resolve requires { path: string }',
    );
  });

  it('projects.resolve expands a leading ~ to a temporary home directory', async () => {
    const expected = join(scratch, 'home');
    await mkdir(expected);
    vi.stubEnv('HOME', expected);
    setConfigEnv(join(scratch, 'global'), []);
    const { call } = await setupForProjectTests(fakeLb());
    const home = await call('projects.resolve', { path: '~' });
    expect(home).toEqual({
      id: expected,
      name: basename(expected),
      path: expected,
      envTier: 'normal',
    });
  });
});
