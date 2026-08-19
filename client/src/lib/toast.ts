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

export function showToast(message: string, type: ToastType = 'success'): void {
  clearTimeout(hideTimer);
  listeners.forEach((cb) => cb({ message, type }));
  hideTimer = setTimeout(() => listeners.forEach((cb) => cb(null)), 3000);
}

export function subscribeToast(cb: (state: ToastState | null) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}
