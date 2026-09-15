import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

beforeEach(() => {
  // MenuDrawer reads `document.documentElement.dataset` and (via getTheme()) `localStorage`
  // at render time (not inside an effect), and this project's vitest config runs in the
  // 'node' environment with no jsdom.
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

const noop = () => {};
const props = {
  onOpenInvoiceImport: noop,
  onOpenManageCategories: noop,
  onOpenManageLocations: noop,
  onOpenManageDevices: noop,
};

describe('MenuDrawer log-out control', () => {
  it('renders a Log out item', async () => {
    const { MenuDrawer } = await import('./MenuDrawer');
    const html = renderToStaticMarkup(<MenuDrawer {...props} />);
    expect(html).toContain('menu-logout-button');
    expect(html).toContain('Log out');
  });
});
