import { useEffect } from 'react';

// Every modal is a `fixed inset-0` overlay, but without this the page underneath stays
// scrollable — on mobile, a touch-scroll gesture starting on the overlay's own background can
// still scroll the body behind it, so reopening a modal (or closing one) can appear to jump to
// a stale scroll position (issue #22). Locking body scroll for as long as any modal is mounted
// stops that.
export function useLockBodyScroll() {
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, []);
}
