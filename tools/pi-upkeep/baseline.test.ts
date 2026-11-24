import { describe, expect, it } from 'vitest';
import type { BaselineInput } from './baseline.ts';
import { validateBaseline } from './baseline.ts';

const SDK = '@earendil-works/pi-coding-agent';

function defaultPackageJson(): unknown {
  return { name: 'funkyoctopus', version: '0.1.0', dependencies: { [SDK]: '0.84.1' } };
}

function defaultPackageLock(): unknown {
  return {
    name: 'funkyoctopus',
    version: '0.1.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'funkyoctopus', dependencies: { [SDK]: '0.84.1' } },
      [`node_modules/${SDK}`]: { version: '0.84.1' },
    },
  };
}

function defaultNpmLs(): unknown {
  return {
    name: 'funkyoctopus',
    version: '0.1.0',
    problems: [],
    dependencies: { [SDK]: { version: '0.84.1', resolved: 'https://registry.npmjs.org/x' } },
  };
}

function makeInput(overrides: Partial<BaselineInput> = {}): BaselineInput {
  return {
    sdk: SDK,
    packageJson: overrides.packageJson ?? defaultPackageJson(),
    packageLock: overrides.packageLock ?? defaultPackageLock(),
    npmLs: overrides.npmLs ?? defaultNpmLs(),
  };
}

describe('validateBaseline — clean agreement', () => {
  it('accepts one exact stable version across package.json, lockfile, installed resolution, and npm ls', () => {
    expect(validateBaseline(makeInput())).toEqual({ kind: 'ok', version: '0.84.1' });
  });

  it('accepts when npm ls problems is absent entirely', () => {
    const npmLs = { name: 'funkyoctopus', dependencies: { [SDK]: { version: '0.84.1' } } };
    expect(validateBaseline(makeInput({ npmLs }))).toEqual({ kind: 'ok', version: '0.84.1' });
  });
});

describe('validateBaseline — package.json declaration', () => {
  it('flags a missing SDK dependency', () => {
    const result = validateBaseline(makeInput({ packageJson: { name: 'funkyoctopus' } }));
    expect(result).toEqual({
      kind: 'needs_attention',
      issues: [{ code: 'package_json_missing_dependency', dependency: SDK }],
    });
  });

  it('flags a caret range instead of an exact pin', () => {
    const result = validateBaseline(makeInput({ packageJson: { dependencies: { [SDK]: '^0.84.1' } } }));
    expect(result).toEqual({
      kind: 'needs_attention',
      issues: [{ code: 'package_json_not_exact', dependency: SDK, raw: '^0.84.1' }],
    });
  });

  it('flags prerelease, build metadata, v-prefix, and malformed declarations', () => {
    for (const raw of ['0.84.1-beta.1', '0.84.1+linux', 'v0.84.1', '0.84']) {
      const result = validateBaseline(makeInput({ packageJson: { dependencies: { [SDK]: raw } } }));
      expect(result).toEqual({
        kind: 'needs_attention',
        issues: [{ code: 'package_json_not_exact', dependency: SDK, raw }],
      });
    }
  });

  it('flags a non-string dependency value', () => {
    const result = validateBaseline(makeInput({ packageJson: { dependencies: { [SDK]: 42 } } }));
    expect(result).toEqual({
      kind: 'needs_attention',
      issues: [{ code: 'package_json_not_exact', dependency: SDK, raw: '42' }],
    });
  });
});

describe('validateBaseline — package-lock agreement', () => {
  it('flags a missing lockfile dependency entry', () => {
    const packageLock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'funkyoctopus' },
        [`node_modules/${SDK}`]: { version: '0.84.1' },
      },
    };
    const result = validateBaseline(makeInput({ packageLock }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({ code: 'package_lock_missing_dependency', dependency: SDK });
    }
  });

  it('flags a range in the lockfile dependency entry', () => {
    const packageLock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'funkyoctopus', dependencies: { [SDK]: '~0.84.1' } },
        [`node_modules/${SDK}`]: { version: '0.84.1' },
      },
    };
    const result = validateBaseline(makeInput({ packageLock }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({ code: 'package_lock_not_exact', dependency: SDK, raw: '~0.84.1' });
    }
  });

  it('flags a missing installed-resolution entry', () => {
    const packageLock = {
      lockfileVersion: 3,
      packages: { '': { name: 'funkyoctopus', dependencies: { [SDK]: '0.84.1' } } },
    };
    const result = validateBaseline(makeInput({ packageLock }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({ code: 'lockfile_installed_missing', dependency: SDK });
    }
  });

  it('flags a non-exact installed resolution', () => {
    const packageLock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'funkyoctopus', dependencies: { [SDK]: '0.84.1' } },
        [`node_modules/${SDK}`]: { version: '0.84.2-rc.0' },
      },
    };
    const result = validateBaseline(makeInput({ packageLock }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({
        code: 'lockfile_installed_not_exact',
        dependency: SDK,
        raw: '0.84.2-rc.0',
      });
    }
  });

  it('flags disagreement between declared and resolved versions', () => {
    const packageLock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'funkyoctopus', dependencies: { [SDK]: '0.84.2' } },
        [`node_modules/${SDK}`]: { version: '0.84.1' },
      },
    };
    const result = validateBaseline(makeInput({ packageLock }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({
        code: 'version_agreement',
        declared: '0.84.1',
        lockfile: '0.84.2',
        installed: '0.84.1',
        npmLs: '0.84.1',
      });
    }
  });
});

describe('validateBaseline — npm ls result', () => {
  it('flags an unparseable npm ls result', () => {
    const result = validateBaseline(makeInput({ npmLs: 'garbage' }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues.some((issue) => issue.code === 'npm_ls_unparseable')).toBe(true);
    }
  });

  it('flags npm ls problems (a broken tree)', () => {
    const npmLs = {
      name: 'funkyoctopus',
      problems: ['unmet peer dependency x@1.0.0'],
      dependencies: { [SDK]: { version: '0.84.1' } },
    };
    const result = validateBaseline(makeInput({ npmLs }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({
        code: 'npm_ls_problems',
        problems: ['unmet peer dependency x@1.0.0'],
      });
    }
  });

  it('flags npm ls resolving a different SDK version', () => {
    const npmLs = {
      name: 'funkyoctopus',
      problems: [],
      dependencies: { [SDK]: { version: '0.84.2' } },
    };
    const result = validateBaseline(makeInput({ npmLs }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({
        code: 'npm_ls_version_mismatch',
        dependency: SDK,
        expected: '0.84.1',
        actual: '0.84.2',
      });
    }
  });

  it('flags npm ls resolving a non-exact version', () => {
    const npmLs = {
      name: 'funkyoctopus',
      problems: [],
      dependencies: { [SDK]: { version: '^0.84.1' } },
    };
    const result = validateBaseline(makeInput({ npmLs }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({
        code: 'npm_ls_version_mismatch',
        dependency: SDK,
        expected: '0.84.1',
        actual: '^0.84.1',
      });
    }
  });

  it('flags a missing SDK node in npm ls', () => {
    const npmLs = { name: 'funkyoctopus', problems: [], dependencies: {} };
    const result = validateBaseline(makeInput({ npmLs }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({ code: 'npm_ls_sdk_missing', dependency: SDK });
    }
  });

  it('flags problems recorded on the SDK node itself', () => {
    const npmLs = {
      name: 'funkyoctopus',
      problems: [],
      dependencies: { [SDK]: { version: '0.84.1', problems: ['invalid'] } },
    };
    const result = validateBaseline(makeInput({ npmLs }));
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      expect(result.issues).toContainEqual({ code: 'npm_ls_problems', problems: ['invalid'] });
    }
  });
});

describe('validateBaseline — exact version numeric form', () => {
  it('flags leading-zero and unsafe-precision declarations', () => {
    for (const raw of ['0.84.01', '0.9007199254740992.0', '999999999999999999999999999999.0.0']) {
      const result = validateBaseline(makeInput({ packageJson: { dependencies: { [SDK]: raw } } }));
      expect(result).toEqual({
        kind: 'needs_attention',
        issues: [{ code: 'package_json_not_exact', dependency: SDK, raw }],
      });
    }
  });

  it('flags a leading-zero installed resolution', () => {
    const packageLock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'funkyoctopus', dependencies: { [SDK]: '0.84.1' } },
        [`node_modules/${SDK}`]: { version: '0.84.01' },
      },
    };
    const result = validateBaseline(makeInput({ packageLock }));
    expect(result).toEqual({
      kind: 'needs_attention',
      issues: [{ code: 'lockfile_installed_not_exact', dependency: SDK, raw: '0.84.01' }],
    });
  });

  it('flags npm ls reporting a leading-zero version', () => {
    const npmLs = {
      name: 'funkyoctopus',
      problems: [],
      dependencies: { [SDK]: { version: '0.84.01' } },
    };
    const result = validateBaseline(makeInput({ npmLs }));
    expect(result).toEqual({
      kind: 'needs_attention',
      issues: [
        {
          code: 'npm_ls_version_mismatch',
          dependency: SDK,
          expected: '0.84.1',
          actual: '0.84.01',
        },
      ],
    });
  });
});

describe('validateBaseline — combined mismatches', () => {
  it('collects every issue instead of stopping at the first', () => {
    const result = validateBaseline(
      makeInput({
        packageJson: { dependencies: { [SDK]: '^0.84.1' } },
        npmLs: { name: 'funkyoctopus', problems: ['broken'], dependencies: {} },
      }),
    );
    expect(result.kind).toBe('needs_attention');
    if (result.kind === 'needs_attention') {
      const codes = result.issues.map((issue) => issue.code);
      expect(codes).toContain('package_json_not_exact');
      expect(codes).toContain('npm_ls_problems');
      expect(codes).toContain('npm_ls_sdk_missing');
    }
  });
});
