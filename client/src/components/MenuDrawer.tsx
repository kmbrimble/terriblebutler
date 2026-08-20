import { useState } from 'react';
import { getTheme, setTheme } from '../lib/theme';

// Ports legacy's hamburger/settings drawer (public/index.html L138-198,
// toggleDrawer()/toggleFullScreen()/applyTheme() at L695-725) — the one piece of top-level nav
// chrome no React-rewrite stage ever picked up (see CHANGELOG). Sort By/Sort Direction/Expanded
// View live in legacy's drawer too, but are deliberately NOT duplicated here — they're already
// inline in ItemList.tsx. "Upload Invoice" (the plain-LLM flow) is deliberately not ported at
// all — see CHANGELOG. Legacy has no logout button, so none is added here either.
export function MenuDrawer({
  onOpenInvoiceImport,
  onOpenManageCategories,
  onOpenManageLocations,
}: {
  onOpenInvoiceImport: () => void;
  onOpenManageCategories: () => void;
  onOpenManageLocations: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(() => getTheme() === 'dark');

  function toggleFullScreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }

  function handleThemeChange(checked: boolean) {
    const next = checked ? 'dark' : 'light';
    setTheme(next);
    setDark(checked);
  }

  function pick(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="menu-open-button"
        className="touch-target w-11 h-11 flex items-center justify-center bg-rimmy-charcoal border border-rimmy-border hover:border-rimmy-orange text-white rounded"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {open && <div className="fixed inset-0 bg-black bg-opacity-60 z-40" onClick={() => setOpen(false)} />}

      <div
        data-testid="menu-drawer"
        className={`fixed top-0 right-0 h-full w-64 bg-rimmy-charcoal border-l border-rimmy-border transform transition-transform duration-300 z-50 p-6 flex flex-col gap-6 shadow-2xl overflow-y-auto ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ visibility: open ? 'visible' : 'hidden' }}
      >
        <div className="flex justify-between items-center border-b border-rimmy-border pb-3 shrink-0">
          <h2 className="text-xl font-bold text-rimmy-orange">Settings</h2>
          <button type="button" onClick={() => setOpen(false)} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>

        <div className="flex flex-col gap-3 shrink-0">
          <button
            type="button"
            onClick={() => pick(onOpenInvoiceImport)}
            className="w-full bg-rimmy-purple hover:bg-rimmy-purpleHover text-white font-bold py-3 rounded shadow"
          >
            Import Coles/Woolworths Invoice
          </button>
          <button
            type="button"
            onClick={() => pick(toggleFullScreen)}
            className="w-full bg-rimmy-black border border-rimmy-border hover:border-rimmy-orange text-rimmy-text font-bold py-3 rounded shadow"
          >
            Toggle Full Screen
          </button>
        </div>

        <div className="flex flex-col gap-5 mt-2 border-t border-rimmy-border pt-4 shrink-0">
          <h3 className="text-rimmy-orange font-bold uppercase text-xs tracking-wider">Manage Options</h3>
          <button
            type="button"
            onClick={() => pick(onOpenManageCategories)}
            className="w-full bg-rimmy-black border border-rimmy-border hover:border-rimmy-orange text-rimmy-text font-bold py-2 rounded shadow-sm text-sm"
          >
            Manage Categories
          </button>
          <button
            type="button"
            onClick={() => pick(onOpenManageLocations)}
            className="w-full bg-rimmy-black border border-rimmy-border hover:border-rimmy-orange text-rimmy-text font-bold py-2 rounded shadow-sm text-sm"
          >
            Manage Locations
          </button>
        </div>

        <div className="flex flex-col gap-5 mt-2 border-t border-rimmy-border pt-4 shrink-0">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-rimmy-text font-bold text-sm">Dark Mode</span>
            <div className="relative">
              <input
                type="checkbox"
                data-testid="menu-dark-mode-toggle"
                checked={dark}
                onChange={(e) => handleThemeChange(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rimmy-purple" />
            </div>
          </label>
        </div>
      </div>
    </>
  );
}
