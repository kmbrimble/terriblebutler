import type { Location } from '../lib/api';
import type { Tab, TabType } from '../lib/filterItems';

interface TabDef {
  type: TabType;
  id: number | null;
  label: string;
}

// Ported from public/index.html's renderTabs(): same order, same labels.
function buildTabDefs(locations: Location[]): TabDef[] {
  return [
    { type: 'all', id: null, label: 'All Inventory' },
    ...locations.map((loc) => ({ type: 'location' as const, id: loc.id, label: loc.name })),
    { type: 'grocery', id: null, label: 'Grocery List' },
    { type: 'ignored', id: null, label: 'Ignored Out-of-Stock' },
  ];
}

export function TabBar({
  locations,
  activeTab,
  onSelect,
}: {
  locations: Location[];
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
}) {
  const tabDefs = buildTabDefs(locations);

  return (
    <nav className="bg-rimmy-charcoal shadow-md border-b border-rimmy-border">
      <ul className="flex overflow-x-auto no-scrollbar p-2 gap-2 whitespace-nowrap">
        {tabDefs.map((tab) => {
          const isActive = activeTab.type === tab.type && activeTab.id === tab.id;
          return (
            <li key={`${tab.type}-${tab.id ?? ''}`}>
              <button
                type="button"
                data-testid="location-tab-button"
                onClick={() => onSelect({ type: tab.type, id: tab.id })}
                className={`shrink-0 touch-target px-4 py-2 rounded-full font-bold transition-all duration-300 ${
                  isActive
                    ? 'bg-rimmy-purple text-white shadow-[0_0_10px_rgba(106,13,173,0.5)]'
                    : 'bg-rimmy-black text-rimmy-textMuted border border-rimmy-border hover:border-rimmy-orange/50 hover:text-rimmy-text'
                }`}
              >
                {tab.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
