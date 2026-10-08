import type { ItemLocation } from './api';

// <select> value for the "Unassigned" bucket; a real `''` is reserved for "nothing chosen yet".
export const UNASSIGNED = 'none';

const choiceFor = (l: ItemLocation) => (l.location_id === null ? UNASSIGNED : String(l.location_id));

// Issue #24 rules: with stock in exactly one location, deduct from it without asking;
// otherwise the user must choose (#45 — never submit an ambiguous request).
export function defaultDeductChoice(locations: ItemLocation[]): string {
  const stocked = locations.filter((l) => l.quantity > 0);
  return stocked.length === 1 ? choiceFor(stocked[0]) : '';
}

export const deductLocationChoice = choiceFor;

export function deductLocationId(choice: string): number | null {
  return choice === UNASSIGNED ? null : Number(choice);
}
