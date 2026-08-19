import { useEffect, useState } from 'react';
import { subscribeToast, type ToastState } from '../lib/toast';

export function Toast() {
  const [state, setState] = useState<ToastState | null>(null);

  useEffect(() => subscribeToast(setState), []);

  if (!state) return null;

  return (
    <div
      data-testid="toast-notification"
      className={`fixed bottom-20 left-1/2 -translate-x-1/2 text-white font-bold px-6 py-3 rounded shadow-xl z-[100] ${
        state.type === 'error' ? 'bg-red-600' : 'bg-green-600'
      }`}
    >
      {state.message}
    </div>
  );
}
