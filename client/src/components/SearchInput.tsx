export function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <input
        type="text"
        data-testid="search-input"
        placeholder="Search items..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-rimmy-charcoal border border-rimmy-border focus:border-rimmy-orange focus:ring-1 focus:ring-rimmy-orange rounded p-3 pr-10 touch-target text-base outline-none transition-colors text-rimmy-text"
      />
      {value && (
        <button
          type="button"
          data-testid="search-clear-button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none"
        >
          &times;
        </button>
      )}
    </div>
  );
}
