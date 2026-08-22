import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchInput } from './SearchInput';

describe('SearchInput clear button', () => {
  it('is not rendered when the search box is empty', () => {
    const html = renderToStaticMarkup(<SearchInput value="" onChange={() => {}} />);
    expect(html).not.toContain('data-testid="search-clear-button"');
  });

  it('is rendered once there is search text', () => {
    const html = renderToStaticMarkup(<SearchInput value="milk" onChange={() => {}} />);
    expect(html).toContain('data-testid="search-clear-button"');
    expect(html).toContain('×');
  });
});
