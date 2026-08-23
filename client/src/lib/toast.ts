// Plain TypeScript pub-sub, no React import — a single module-scope singleton mirroring
// legacy's showToast()/showError() (one shared #toastNotification element reused across the
// whole page), so any component can call showToast() without prop-drilling through modals.
export type ToastType = 'success' | 'error';

export interface ToastState {
  message: string;
  type: ToastType;
}

let listeners: Array<(state: ToastState | null) => void> = [];
let hideTimer: ReturnType<typeof setTimeout> | undefined;
// Kept so a Toast that mounts mid-flight (e.g. the login screen swapping to the app root
// right after a toast fires) can pick up the still-active message instead of starting blank.
let currentState: ToastState | null = null;

export function showToast(message: string, type: ToastType = 'success'): void {
  clearTimeout(hideTimer);
  currentState = { message, type };
  listeners.forEach((cb) => cb(currentState));
  hideTimer = setTimeout(() => {
    currentState = null;
    listeners.forEach((cb) => cb(null));
  }, 3000);
}

export function subscribeToast(cb: (state: ToastState | null) => void): () => void {
  listeners.push(cb);
  cb(currentState);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}
