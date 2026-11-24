import { describe, expect, it } from 'vitest';
import { compareStableVersions, exactStableString, parseExactStableVersion } from './versions.ts';

describe('exact stable version numeric form', () => {
  it('rejects leading zeros in any component instead of canonicalizing them', () => {
    for (const bad of ['01.2.3', '0.02.3', '0.2.03', '00.0.0', '1.02.3']) {
      expect(parseExactStableVersion(bad)).toBeNull();
      expect(exactStableString(bad)).toBeNull();
      expect(compareStableVersions(bad, '1.2.3')).toBeNull();
    }
  });

  it('accepts each component at the MAX_SAFE_INTEGER boundary', () => {
    const max = 9_007_199_254_740_991;
    expect(parseExactStableVersion(`${max}.${max}.${max}`)).toEqual({
      major: max,
      minor: max,
      patch: max,
    });
    expect(exactStableString(`${max}.0.0`)).toBe(`${max}.0.0`);
    expect(compareStableVersions(`${max}.0.1`, `${max}.0.0`)).toBe(1);
  });

  it('rejects components with unsafe precision just past MAX_SAFE_INTEGER', () => {
    for (const bad of ['9007199254740992.0.0', '0.9007199254740993.0', '0.0.9007199254740994']) {
      expect(parseExactStableVersion(bad)).toBeNull();
      expect(exactStableString(bad)).toBeNull();
      expect(compareStableVersions(bad, '0.0.0')).toBeNull();
    }
  });

  it('rejects enormous components that overflow to unsafe or infinite numbers', () => {
    for (const bad of [
      '999999999999999999999999999999.0.0',
      '0.0.999999999999999999999999999999',
      `${'9'.repeat(400)}.0.0`,
    ]) {
      expect(parseExactStableVersion(bad)).toBeNull();
      expect(exactStableString(bad)).toBeNull();
    }
  });
});
