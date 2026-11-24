import type { CoordinationFsOps, CoordinationStat } from '../../../server/src/upkeep/state-path.ts';
import type { PromoteFsOps } from '../promote.ts';

function fsError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: '${path}'`), { code });
}

/** General in-memory fake for tests that consume CoordinationFsOps. */
export class CoordinationFakeFs implements CoordinationFsOps {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly events: string[] = [];
  readonly readErrors = new Map<string, Error>();
  readonly writeErrors = new Map<string, Error>();
  readonly mkdirErrors = new Map<string, Error>();
  readonly renameErrors = new Map<string, Error>();
  readonly unlinkErrors = new Map<string, Error>();
  readonly writeModes = new Map<string, number | undefined>();
  readonly writeFlags = new Map<string, string | undefined>();
  /**
   * When true, a rename into a directory the fake never created fails with ENOENT,
   * as on disk. Suites whose fixtures seed files without their directories keep it off.
   */
  protected readonly renameNeedsDestinationDir: boolean = false;

  seed(path: string, content: string): void {
    this.files.set(path, content);
  }

  mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<unknown> {
    this.events.push(`mkdir ${path}`);
    const forced = this.mkdirErrors.get(path);
    if (forced) return Promise.reject(forced);
    if (options.recursive) {
      const parts = path.split('/');
      for (let index = 1; index <= parts.length; index += 1) {
        const ancestor = parts.slice(0, index).join('/');
        if (ancestor) this.dirs.add(ancestor);
      }
    } else {
      this.dirs.add(path);
    }
    return Promise.resolve();
  }

  readFile(path: string): Promise<string> {
    this.events.push(`read ${path}`);
    const forced = this.readErrors.get(path);
    if (forced) return Promise.reject(forced);
    const content = this.files.get(path);
    return content === undefined ? Promise.reject(fsError('ENOENT', path)) : Promise.resolve(content);
  }

  writeFile(path: string, data: string, options: { mode?: number; flag?: string }): Promise<void> {
    this.events.push(`write ${path}`);
    this.writeModes.set(path, options.mode);
    this.writeFlags.set(path, options.flag);
    const forced = this.writeErrors.get(path);
    if (forced) return Promise.reject(forced);
    if (options.flag === 'wx' && this.files.has(path)) return Promise.reject(fsError('EEXIST', path));
    this.files.set(path, data);
    return Promise.resolve();
  }

  realpath(path: string): Promise<string> {
    return Promise.resolve(path);
  }

  readdir(path: string): Promise<string[]> {
    this.events.push(`readdir ${path}`);
    if (!this.dirs.has(path)) return Promise.reject(fsError('ENOENT', path));
    const entries = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.dirs]) {
      if (!candidate.startsWith(`${path}/`)) continue;
      const name = candidate.slice(path.length + 1);
      if (name && !name.includes('/')) entries.add(name);
    }
    return Promise.resolve([...entries].sort());
  }

  chmod(path: string, _mode: number): Promise<void> {
    this.events.push(`chmod ${path}`);
    return Promise.resolve();
  }

  stat(path: string): Promise<CoordinationStat> {
    this.events.push(`stat ${path}`);
    if (!this.dirs.has(path) && !this.files.has(path)) return Promise.reject(fsError('ENOENT', path));
    return Promise.resolve({ mtimeMs: 1_000 });
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    this.events.push(`rename ${oldPath} -> ${newPath}`);
    const forced = this.renameErrors.get(oldPath) ?? this.renameErrors.get(newPath);
    if (forced) return Promise.reject(forced);
    const content = this.files.get(oldPath);
    if (content === undefined) return Promise.reject(fsError('ENOENT', oldPath));
    if (this.renameNeedsDestinationDir && !this.dirs.has(newPath.slice(0, newPath.lastIndexOf('/')))) {
      return Promise.reject(fsError('ENOENT', newPath));
    }
    this.files.delete(oldPath);
    this.files.set(newPath, content);
    return Promise.resolve();
  }

  unlink(path: string): Promise<void> {
    this.events.push(`unlink ${path}`);
    const forced = this.unlinkErrors.get(path);
    if (forced) return Promise.reject(forced);
    if (!this.files.delete(path)) return Promise.reject(fsError('ENOENT', path));
    return Promise.resolve();
  }

  rmdir(path: string): Promise<void> {
    this.events.push(`rmdir ${path}`);
    if (!this.dirs.has(path)) return Promise.reject(fsError('ENOENT', path));
    if ([...this.files.keys(), ...this.dirs].some((candidate) => candidate.startsWith(`${path}/`))) {
      return Promise.reject(fsError('ENOTEMPTY', path));
    }
    this.dirs.delete(path);
    return Promise.resolve();
  }
}

/** General in-memory fake for tests that consume the larger PromoteFsOps interface. */
export class PromoteFakeFs extends CoordinationFakeFs implements PromoteFsOps {
  readonly renamePairErrors = new Map<string, Error>();
  readonly rmErrors = new Map<string, Error>();
  private readonly rmGates = new Map<string, () => void>();

  has(path: string): boolean {
    return this.files.has(path);
  }

  override mkdir(_path: string, _options: { recursive: boolean; mode?: number }): Promise<unknown> {
    this.events.push('mkdir');
    return Promise.resolve();
  }

  override realpath(path: string): Promise<string> {
    this.events.push(`realpath ${path}`);
    return Promise.resolve(path);
  }

  override readdir(_path: string): Promise<string[]> {
    this.events.push('readdir');
    return Promise.resolve([]);
  }

  override chmod(_path: string, _mode: number): Promise<void> {
    this.events.push('chmod');
    return Promise.resolve();
  }

  override stat(_path: string): Promise<CoordinationStat> {
    this.events.push('stat');
    return Promise.resolve({ mtimeMs: 0 });
  }

  override rmdir(_path: string): Promise<void> {
    this.events.push('rmdir');
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    this.events.push(`exists ${path}`);
    return Promise.resolve(this.files.has(path));
  }

  gateRm(path: string): void {
    this.rmGates.set(path, () => {});
  }

  releaseRm(path: string): void {
    const release = this.rmGates.get(path);
    if (release) {
      this.rmGates.delete(path);
      release();
    }
  }

  override rename(oldPath: string, newPath: string): Promise<void> {
    const forced = this.renamePairErrors.get(`${oldPath}|${newPath}`);
    if (forced) {
      this.events.push(`rename ${oldPath} -> ${newPath}`);
      return Promise.reject(forced);
    }
    return super.rename(oldPath, newPath);
  }

  rm(path: string, _options: { recursive: boolean }): Promise<void> {
    this.events.push(`rm ${path}`);
    if (this.rmGates.has(path)) {
      return new Promise<void>((resolve) => {
        this.rmGates.set(path, resolve);
      });
    }
    const forced = this.rmErrors.get(path);
    if (forced) return Promise.reject(forced);
    this.files.delete(path);
    return Promise.resolve();
  }
}
