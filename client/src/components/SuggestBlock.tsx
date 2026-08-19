import { useState } from 'react';
import type { SuggestionState } from '../lib/labelScan';

// Ports renderSuggestBlock()/onSuggestSelectChange()/createSuggested()/applySuggestion() from
// public/index.html. Legacy has separate but identical copies of this for category and
// location (driven by its SUGGEST_KINDS map) — one generic component covers both here, which
// also gives location suggestion a testid contract for the first time (legacy's own
// locationSuggestBlock has an id but no data-testid; only category was ever tested).
export function SuggestBlock({
  kind,
  suggestion,
  items,
  onCreate,
  onApply,
}: {
  kind: 'category' | 'location';
  suggestion: SuggestionState;
  items: { id: number; name: string }[];
  onCreate: (name: string) => Promise<{ id: number; name: string }>;
  onApply: (id: number) => void;
}) {
  const [selectValue, setSelectValue] = useState(() => (suggestion.similar ? String(suggestion.similar.id) : '__new__'));
  const [customName, setCustomName] = useState('');

  const testidPrefix = kind === 'category' ? 'category' : 'location';

  async function handleUse() {
    let id: number | null;
    if (selectValue === '__custom__') {
      const name = customName.trim();
      if (!name) return;
      id = (await onCreate(name).catch(() => null))?.id ?? null;
    } else if (selectValue === '__new__') {
      id = (await onCreate(suggestion.suggestedName).catch(() => null))?.id ?? null;
    } else {
      id = parseInt(selectValue, 10);
    }
    if (id === null || isNaN(id)) return;
    onApply(id);
  }

  return (
    <div data-testid={`${testidPrefix}-suggest-block`} className="border border-amber-500 rounded p-3 bg-rimmy-black space-y-2">
      <p className="text-sm font-bold text-amber-400">
        Scanned {kind} "<span>{suggestion.suggestedName}</span>" isn't in your list:
      </p>
      <select
        data-testid={`${testidPrefix}-suggest-select`}
        value={selectValue}
        onChange={(e) => setSelectValue(e.target.value)}
        className="w-full bg-rimmy-black border border-rimmy-border rounded p-2 text-rimmy-text"
      >
        <option value="__new__">Add "{suggestion.suggestedName}" as new {kind}</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
        <option value="__custom__">Type a different name...</option>
      </select>
      {selectValue === '__custom__' && (
        <input
          type="text"
          data-testid={`${testidPrefix}-suggest-custom-input`}
          placeholder={`New ${kind} name`}
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          className="w-full bg-rimmy-black border border-rimmy-border rounded p-2 text-rimmy-text"
        />
      )}
      <button type="button" onClick={handleUse} className="touch-target px-3 py-1 bg-rimmy-purple text-white text-xs font-bold rounded">
        Use this
      </button>
    </div>
  );
}
