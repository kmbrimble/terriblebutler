import { getToken } from './api';
import { showToast } from './toast';

// One place for "an async user action failed": every handler goes through runAction/reportAction
// so a failure always reaches the user as a toast and never escapes as an unhandled rejection.
// installRejectionToast is the net underneath for any handler that forgets.

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// A 401 clears the token synchronously before the rejection lands (see authorizedFetch), and
// App is already redirecting to the login screen — don't stack a toast on top of that.
function report(err: unknown, fallback: string): void {
  if (getToken()) showToast(message(err, fallback), 'error');
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false };

// For handlers that need to know whether to continue (close the dialog, reset the form) or stay
// open after a failure.
export async function runAction<T>(action: () => Promise<T>, fallback: string): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (err) {
    report(err, fallback);
    return { ok: false };
  }
}

// For fire-and-forget actions (quick +/- buttons, toggles) that only need the failure surfaced.
export function reportAction(promise: Promise<unknown>, fallback: string): void {
  promise.catch((err) => report(err, fallback));
}

export function installRejectionToast(target: EventTarget = window): () => void {
  const handler = (e: Event) => {
    if (getToken()) showToast(`Something went wrong: ${message((e as PromiseRejectionEvent).reason, 'unexpected error')}`, 'error');
  };
  target.addEventListener('unhandledrejection', handler);
  return () => target.removeEventListener('unhandledrejection', handler);
}
