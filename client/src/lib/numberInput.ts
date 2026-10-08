// A blank or non-numeric number box means "none" for optional amounts such as the reorder
// threshold. The server refuses a missing value rather than reading it as 0 (it would be
// NaN -> null in JSON), so the form says 0 explicitly.
export function numberOrZero(text: string): number {
  const parsed = parseFloat(text);
  return Number.isFinite(parsed) ? parsed : 0;
}
