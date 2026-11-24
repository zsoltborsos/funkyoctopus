import { describe, expect, it } from 'vitest';
import { WireCallError } from '@shared/transport/errors.ts';
import { humaneError, notInstalledLine, startHint } from './humane-error.ts';

describe('humaneError', () => {
  it('maps a thrown helmraiser_unavailable to the not-installed line and flags it as unavailable', () => {
    const result = humaneError(new WireCallError('Helmraiser CLI not found: helmraiser', 'helmraiser_unavailable'), 'x');
    expect(result).toEqual({
      message: 'Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net',
      code: 'helmraiser_unavailable',
      unavailable: true,
    });
  });

  it('maps an in-band leeboard_unavailable envelope to the not-installed line', () => {
    expect(humaneError({ code: 'leeboard_unavailable', message: 'lb was not found on PATH' }, 'x')).toEqual({
      message: 'Leeboard is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net',
      code: 'leeboard_unavailable',
      unavailable: true,
    });
  });

  it('passes an unknown coded error through with its raw message', () => {
    const result = humaneError(new WireCallError('helmraiser status exited 2: boom', 'helmraiser_cli_error'), 'x');
    expect(result).toEqual({ message: 'helmraiser status exited 2: boom', code: 'helmraiser_cli_error', unavailable: false });
  });

  it('passes a plain Error and a non-Error through, falling back when there is no message', () => {
    expect(humaneError(new Error('boom'), 'fallback')).toEqual({ message: 'boom', code: null, unavailable: false });
    expect(humaneError(undefined, 'fallback')).toEqual({ message: 'fallback', code: null, unavailable: false });
    expect(humaneError({ code: 'route_unavailable' }, 'fallback')).toEqual({ message: 'fallback', code: 'route_unavailable', unavailable: false });
  });
});

describe('startHint', () => {
  it('gives the not-installed line for a known optional tool and nothing for an unknown one', () => {
    expect(startHint('helmraiser')).toBe('Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net');
    expect(startHint('leeboard')).toBe('Leeboard is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net');
    expect(startHint('pi')).toBeNull();
  });
});

describe('notInstalledLine', () => {
  it('says what is missing, that FunkyOctopus works without it, and where to get it', () => {
    expect(notInstalledLine('helmraiser')).toEqual({
      text: 'Helmraiser is not installed — FunkyOctopus works without it. Install:',
      url: 'https://zsoltborsos.net',
    });
    expect(notInstalledLine('leeboard')).toEqual({
      text: 'Leeboard is not installed — FunkyOctopus works without it. Install:',
      url: 'https://zsoltborsos.net',
    });
  });
});
