import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Header pulls in MenuDrawer, which reads `document` at render time — out of scope for this
// file (structural check of ItemList's own status branching), so it's stubbed out.
vi.mock('./Header', () => ({ Header: () => null }));

const mockUseInventory = vi.fn();
vi.mock('../lib/useInventory', () => ({ useInventory: () => mockUseInventory() }));

function makeLocalStorage() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage());
});

function baseInventory(overrides: Record<string, unknown> = {}) {
  return {
    items: [],
    locations: [],
    categories: [],
    status: 'ready',
    refetchItems: vi.fn(),
    quickAdjust: vi.fn(),
    toggleIgnore: vi.fn(),
    toggleOpen: vi.fn(),
    ...overrides,
  };
}

describe('ItemList empty/error/loading status handling', () => {
  it('shows "No items found." only for a successful, genuinely empty response', async () => {
    mockUseInventory.mockReturnValue(baseInventory({ status: 'ready' }));
    const { ItemList } = await import('./ItemList');
    const html = renderToStaticMarkup(<ItemList />);
    expect(html).toContain('No items found.');
  });

  it('shows an error message instead of "No items found." when the items fetch failed', async () => {
    mockUseInventory.mockReturnValue(baseInventory({ status: 'error' }));
    const { ItemList } = await import('./ItemList');
    const html = renderToStaticMarkup(<ItemList />);
    expect(html).not.toContain('No items found.');
    expect(html).toContain('items-error');
  });

  it('does not show "No items found." while the initial fetch is still loading', async () => {
    mockUseInventory.mockReturnValue(baseInventory({ status: 'loading' }));
    const { ItemList } = await import('./ItemList');
    const html = renderToStaticMarkup(<ItemList />);
    expect(html).not.toContain('No items found.');
  });
});
