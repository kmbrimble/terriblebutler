export function SearchInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="text"
      data-testid="search-input"
      placeholder="Search items..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-rimmy-charcoal border border-rimmy-border focus:border-rimmy-orange focus:ring-1 focus:ring-rimmy-orange rounded p-3 touch-target text-base outline-none transition-colors text-rimmy-text"
    />
  );
}
