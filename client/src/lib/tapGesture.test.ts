import { describe, expect, it } from 'vitest';
import { isTap, TAP_MAX_DISTANCE_PX, TAP_MAX_DURATION_MS } from './tapGesture';

describe('isTap', () => {
  it('is true for no movement and no time elapsed', () => {
    expect(isTap(0, 0, 0)).toBe(true);
  });

  it('is true right at the distance and duration thresholds', () => {
    expect(isTap(TAP_MAX_DISTANCE_PX, 0, TAP_MAX_DURATION_MS)).toBe(true);
  });

  it('is false once movement exceeds the distance threshold, even briefly', () => {
    expect(isTap(TAP_MAX_DISTANCE_PX + 1, 0, 0)).toBe(false);
  });

  it('is false for diagonal movement whose combined distance exceeds the threshold', () => {
    // 8px + 8px axis-aligned components combine (via hypot) to just over 10px.
    expect(isTap(8, 8, 0)).toBe(false);
  });

  it('is false once the touch runs longer than the duration threshold, even without movement', () => {
    expect(isTap(0, 0, TAP_MAX_DURATION_MS + 1)).toBe(false);
  });
});
