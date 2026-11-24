import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, sep } from 'node:path';

/** Read-only authorization for review origins; never opens or reads a transcript. */
export async function guardedSessionPath(submitted: string, sessionRoot: string): Promise<string> {
  if (!submitted || !isAbsolute(submitted) || submitted.includes('\0')) {
    throw new Error('invalid session path');
  }
  const [root, canonical] = await Promise.all([realpath(sessionRoot), realpath(submitted)]);
  const child = relative(root, canonical);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('session path outside store');
  }
  if (extname(submitted) !== '.jsonl' || extname(canonical) !== '.jsonl' || !(await stat(canonical)).isFile()) {
    throw new Error('session path must be a regular .jsonl file');
  }
  return canonical;
}
