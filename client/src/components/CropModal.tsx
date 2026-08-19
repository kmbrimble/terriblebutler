import { useEffect, useRef, useState } from 'react';
import ImportedCropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';

// Ports handleImageSelection()/confirmCrop()/cancelCrop() from public/index.html (Cropper.js
// 1.5.13 — the actual CDN version legacy loads; the npm equivalent is pinned to the same 1.x
// major since 2.x is an unrelated Web Components rewrite with no getCroppedCanvas()). Same
// window-override seam as BarcodeScannerModal, for the same reason and the same e2e benefit.
type CropperCtor = new (
  element: HTMLImageElement,
  options: Record<string, unknown>
) => {
  getCroppedCanvas: (options: Record<string, unknown>) => HTMLCanvasElement | null;
  destroy: () => void;
};

function resolveCropperCtor(): CropperCtor {
  return (window as unknown as { Cropper?: CropperCtor }).Cropper ?? (ImportedCropper as unknown as CropperCtor);
}

export function CropModal({ imageSrc, onConfirm, onCancel }: { imageSrc: string; onConfirm: (blob: Blob) => void; onCancel: () => void }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const cropperRef = useRef<InstanceType<CropperCtor> | null>(null);
  // Cropper.js initialises 50ms after mount (matching legacy's own setTimeout); the confirm
  // button stays disabled until then rather than silently no-op'ing on an early click — this
  // also gives e2e specs a real signal (button becomes enabled) to wait on instead of reaching
  // into Cropper's internal DOM structure, which the project's e2e-selector-guard forbids.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!imgRef.current) return undefined;
    const Ctor = resolveCropperCtor();
    setReady(false);
    const timer = setTimeout(() => {
      if (!imgRef.current) return;
      cropperRef.current = new Ctor(imgRef.current, {
        viewMode: 1,
        autoCropArea: 1,
        background: false,
        responsive: true,
        touchDragZoom: true,
        mouseWheelZoom: true,
        minCropBoxWidth: 50,
        minCropBoxHeight: 50,
      });
      setReady(true);
    }, 50);
    return () => {
      clearTimeout(timer);
      cropperRef.current?.destroy();
      cropperRef.current = null;
    };
  }, [imageSrc]);

  function handleConfirm() {
    const cropper = cropperRef.current;
    if (!cropper) return;
    const canvas = cropper.getCroppedCanvas({
      maxWidth: 800,
      maxHeight: 800,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    });
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) onConfirm(blob);
    }, 'image/jpeg');
  }

  return (
    <div data-testid="crop-modal" className="fixed inset-0 bg-black bg-opacity-95 z-[70] flex items-center justify-center p-4">
      <div className="bg-rimmy-charcoal border border-rimmy-orange rounded-lg w-full max-w-2xl flex flex-col h-[80vh] overflow-hidden">
        <div className="p-4 border-b border-rimmy-border flex justify-between items-center bg-rimmy-black shrink-0">
          <h2 className="text-xl font-bold text-rimmy-orange">Crop Label Area</h2>
          <button type="button" onClick={onCancel} className="text-rimmy-textMuted hover:text-rimmy-orange font-bold text-2xl leading-none">
            &times;
          </button>
        </div>
        <div className="flex-1 p-2 bg-black overflow-hidden flex items-center justify-center min-h-0">
          <img ref={imgRef} data-testid="crop-image" src={imageSrc} alt="Image to crop" style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }} />
        </div>
        <div className="p-4 border-t border-rimmy-border bg-rimmy-black flex gap-4 shrink-0">
          <button type="button" onClick={onCancel} className="touch-target flex-1 bg-gray-600 hover:bg-gray-500 text-white rounded font-bold">
            Cancel
          </button>
          <button
            type="button"
            data-testid="crop-confirm-button"
            disabled={!ready}
            onClick={handleConfirm}
            className="touch-target flex-1 bg-rimmy-purple hover:bg-rimmy-purpleHover disabled:opacity-40 disabled:cursor-not-allowed text-white rounded font-bold"
          >
            Scan Label
          </button>
        </div>
      </div>
    </div>
  );
}
