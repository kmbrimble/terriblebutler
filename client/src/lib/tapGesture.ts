// Plain TypeScript, no React/DOM imports. A plain click/touchend handler on the item card
// can't tell a tap from a scroll that starts or ends on the card, so ItemCard tracks the
// pointerdown position/time and passes the delta here on pointerup.

export const TAP_MAX_DISTANCE_PX = 10;
export const TAP_MAX_DURATION_MS = 500;

export function isTap(dx: number, dy: number, durationMs: number): boolean {
  return Math.hypot(dx, dy) <= TAP_MAX_DISTANCE_PX && durationMs <= TAP_MAX_DURATION_MS;
}
