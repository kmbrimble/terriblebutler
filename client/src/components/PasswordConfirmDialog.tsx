import { useEffect, useRef, useState, type FormEvent } from 'react';

// Presentational half, so the markup can be unit-tested without a DOM.
export function PasswordConfirmView({
  title, message, confirmLabel, password, error, busy, onPasswordChange, onSubmit, onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  password: string;
  error: string | null;
  busy: boolean;
  onPasswordChange: (value: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <div data-testid="password-confirm-dialog" className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-4">
      <form onSubmit={onSubmit} className="bg-rimmy-charcoal border border-rimmy-purple rounded-lg w-full max-w-sm p-6 space-y-4">
        <h2 className="text-xl font-bold text-rimmy-orange">{title}</h2>
        <p className="text-rimmy-text text-sm">{message}</p>
        <input
          data-testid="password-confirm-input"
          name="password"
          type="password"
          placeholder="Household password"
          autoComplete="current-password"
          required
          autoFocus
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          className="w-full p-2 rounded border border-rimmy-border bg-rimmy-black text-rimmy-text"
        />
        {error && (
          <p data-testid="password-confirm-error" role="alert" className="text-red-500 text-sm">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button type="button" data-testid="password-confirm-cancel" onClick={onCancel} className="px-3 py-2 border border-rimmy-border rounded text-rimmy-text">
            Cancel
          </button>
          <button type="submit" data-testid="password-confirm-submit" disabled={busy} className="px-3 py-2 border border-rimmy-border rounded text-red-500 font-bold disabled:opacity-50">
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

// Asks for the household password before a revocation. The password lives only in this
// component's state: it is passed to `onConfirm`, cleared after every attempt, and gone when the
// dialog unmounts. It is never stored or logged. `onConfirm` rejecting (wrong password, rate
// limited) keeps the dialog open and shows the message; resolving closes it via the parent.
export function PasswordConfirmDialog({
  title, message, confirmLabel, onConfirm, onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: (password: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A successful confirm closes the dialog while onConfirm is still resolving; don't set state after that.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const attempt = password;
    setPassword('');
    try {
      await onConfirm(attempt);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not confirm your password.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <PasswordConfirmView
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      password={password}
      error={error}
      busy={busy}
      onPasswordChange={setPassword}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}
