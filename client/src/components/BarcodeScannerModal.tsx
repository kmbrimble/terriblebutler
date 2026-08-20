import { useEffect, useRef } from 'react';
import { Html5Qrcode as ImportedHtml5Qrcode } from 'html5-qrcode';
import { showToast } from '../lib/toast';
import { useLockBodyScroll } from '../lib/useLockBodyScroll';

// Ports openBarcodeScanner()/closeBarcodeScanner() from public/index.html. Legacy loads
// html5-qrcode from a CDN <script>, so its e2e tests stub the scanner by overriding the
// window.Html5Qrcode global before the page loads. The client bundles the same library as a
// real npm dependency instead, but resolving the constructor as `window.Html5Qrcode ?? (the
// imported class)` keeps that exact stubbing seam working unchanged for the client's own e2e specs.
type Html5QrcodeCtor = new (elementId: string) => {
  start: (
    camera: unknown,
    config: unknown,
    onSuccess: (text: string) => void,
    onError?: (message: string) => void
  ) => Promise<null>;
  stop: () => Promise<void>;
};

function resolveHtml5QrcodeCtor(): Html5QrcodeCtor {
  return (window as unknown as { Html5Qrcode?: Html5QrcodeCtor }).Html5Qrcode ?? (ImportedHtml5Qrcode as unknown as Html5QrcodeCtor);
}

export function BarcodeScannerModal({ onScan, onClose }: { onScan: (barcode: string) => void; onClose: () => void }) {
  useLockBodyScroll();
  const readerId = 'barcode-scanner-reader';
  const scannerRef = useRef<InstanceType<Html5QrcodeCtor> | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const Ctor = resolveHtml5QrcodeCtor();
    const scanner = new Ctor(readerId);
    scannerRef.current = scanner;
    let cancelled = false;

    scanner
      .start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 250 } }, (text) => {
        if (!cancelled) onScanRef.current(text);
      })
      .catch((err) => {
        // Ports the camera-error branch of openBarcodeScanner() (legacy shows a blocking
        // alert() with the same message, then closes); a toast plus close matches the rest of
        // this stage's non-blocking error UI instead.
        if (cancelled) return;
        showToast(`Camera error: ${err}`, 'error');
        onCloseRef.current();
      });

    return () => {
      cancelled = true;
      scanner.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div data-testid="barcode-scanner-modal" className="fixed inset-0 bg-black bg-opacity-95 z-[90] flex flex-col items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-orange rounded-lg w-full max-w-md flex flex-col overflow-hidden">
        <div className="p-4 border-b border-rimmy-border flex justify-between items-center bg-rimmy-black">
          <h2 className="text-xl font-bold text-rimmy-orange">Scan Barcode</h2>
          <button type="button" onClick={onClose} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>
        <div className="flex-1 p-2 bg-black min-h-[300px] flex items-center justify-center">
          <div id={readerId} data-testid="barcode-scanner-reader" className="w-full h-full bg-black" />
        </div>
        <div className="p-4 border-t border-rimmy-border bg-rimmy-black">
          <button type="button" onClick={onClose} className="touch-target w-full bg-gray-600 hover:bg-gray-500 text-white rounded font-bold">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
