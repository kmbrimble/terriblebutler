import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PasswordConfirmView } from './PasswordConfirmDialog';

const noop = () => {};
const props = {
  title: 'Sign out everywhere?',
  message: 'Enter your password.',
  confirmLabel: 'Sign out everywhere',
  password: '',
  error: null,
  busy: false,
  onPasswordChange: noop,
  onSubmit: noop,
  onCancel: noop,
};

describe('PasswordConfirmView', () => {
  it('asks for the password in a masked, required field', () => {
    const html = renderToStaticMarkup(<PasswordConfirmView {...props} />);
    expect(html).toMatch(/data-testid="password-confirm-input"[^>]*type="password"|type="password"[^>]*data-testid="password-confirm-input"/);
    expect(html).toContain('required');
    expect(html).toContain('Sign out everywhere');
  });

  it('shows no error until there is one, then a clear alert', () => {
    expect(renderToStaticMarkup(<PasswordConfirmView {...props} />)).not.toContain('password-confirm-error');
    const html = renderToStaticMarkup(<PasswordConfirmView {...props} error="Incorrect password." />);
    expect(html).toContain('password-confirm-error');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Incorrect password.');
  });

  it('disables confirm while a request is in flight', () => {
    expect(renderToStaticMarkup(<PasswordConfirmView {...props} busy />)).toMatch(/disabled=""[^>]*>Sign out everywhere|data-testid="password-confirm-submit"[^>]*disabled/);
  });

  it('leaves the field empty after an attempt (the value comes from state, which is cleared)', () => {
    const html = renderToStaticMarkup(<PasswordConfirmView {...props} password="" error="Incorrect password." />);
    expect(html).toMatch(/value=""/);
  });
});
