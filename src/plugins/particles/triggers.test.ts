import { describe, expect, it } from 'vitest';
import { burstCount, BUILTIN_EFFECTS, MAX_LIVE, MAX_PER_BURST } from './effects';
import { effectFor, markerEffect, mergeStateEffects } from './triggers';

describe('effectFor', () => {
  const map = { success: 'confetti', active: 'sparkle', 'active.edit': null, 'active.command.Bash': 'firework' };

  it('matches the key itself and dotted children', () => {
    expect(effectFor(map, 'success')).toBe('confetti');
    expect(effectFor(map, 'success.big')).toBe('confetti');
    expect(effectFor(map, 'active.thinking')).toBe('sparkle');
  });

  it('prefers the longest match, including an explicit none', () => {
    expect(effectFor(map, 'active.edit')).toBeNull();
    expect(effectFor(map, 'active.command.Bash')).toBe('firework');
    expect(effectFor(map, 'active.command')).toBe('sparkle');
  });

  it('does not match a bare string prefix', () => {
    expect(effectFor({ succ: 'confetti' }, 'success')).toBeNull();
    expect(effectFor(map, 'idle')).toBeNull();
  });
});

describe('mergeStateEffects', () => {
  it('lets the pack add, replace and switch off', () => {
    const m = mergeStateEffects({ success: 'confetti' }, { onState: { error: 'sparkle', success: null } });
    expect(m).toEqual({ success: null, error: 'sparkle' });
  });

  it('ignores missing or malformed pack config', () => {
    expect(mergeStateEffects({ success: 'confetti' }, undefined)).toEqual({ success: 'confetti' });
    expect(mergeStateEffects({ success: 'confetti' }, { onState: 'x' })).toEqual({ success: 'confetti' });
    expect(mergeStateEffects({}, { onState: { a: 3, b: 'firework' } })).toEqual({ b: 'firework' });
  });
});

describe('markerEffect', () => {
  it('reads particle markers only', () => {
    expect(markerEffect('particle:confetti')).toBe('confetti');
    expect(markerEffect('particle:')).toBeNull();
    expect(markerEffect('swap')).toBeNull();
    expect(markerEffect(undefined)).toBeNull();
  });
});

describe('burstCount', () => {
  const confetti = BUILTIN_EFFECTS.confetti;
  it('scales with amount and respects both caps', () => {
    expect(burstCount(confetti, 1, 0)).toBe(confetti.count);
    expect(burstCount(confetti, 0.5, 0)).toBe(Math.round(confetti.count / 2));
    expect(burstCount(confetti, 10, 0)).toBe(MAX_PER_BURST);
    expect(burstCount(confetti, 1, MAX_LIVE - 3)).toBe(3);
    expect(burstCount(confetti, 1, MAX_LIVE)).toBe(0);
    expect(burstCount(confetti, -1, 0)).toBe(0);
  });
});
