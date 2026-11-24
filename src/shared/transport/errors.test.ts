import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_CODES, WireCallError, wireErrorCode } from './errors.ts';

describe('wireErrorCode', () => {
  it('reads the code off a WireCallError', () => {
    expect(wireErrorCode(new WireCallError('nope', UNAVAILABLE_CODES.helmraiser)))
      .toBe('helmraiser_unavailable');
  });

  it('returns undefined for a WireCallError without a code', () => {
    expect(wireErrorCode(new WireCallError('nope'))).toBeUndefined();
  });

  it('returns undefined for a plain Error', () => {
    expect(wireErrorCode(new Error('plain'))).toBeUndefined();
  });

  it('reads a string code off any Error that carries one', () => {
    const e = Object.assign(new Error('enoent'), { code: 'ENOENT' });
    expect(wireErrorCode(e)).toBe('ENOENT');
  });

  it('ignores a non-string code on an Error', () => {
    const e = Object.assign(new Error('numeric'), { code: 42 });
    expect(wireErrorCode(e)).toBeUndefined();
  });

  it('returns undefined for a non-Error', () => {
    expect(wireErrorCode('helmraiser_unavailable')).toBeUndefined();
    expect(wireErrorCode({ code: 'helmraiser_unavailable' })).toBeUndefined();
    expect(wireErrorCode(undefined)).toBeUndefined();
  });
});
