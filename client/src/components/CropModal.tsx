import { useEffect, useRef, useState } from 'react';
import type Cropper from 'cropperjs';
import { useLockBodyScroll } from '../lib/useLockBodyScroll';

// Ports handleImageSelection()/confirmCrop()/cancelCrop() from public/index.html. Cropper.js
// 2.x is a Web Components rewrite (no getCroppedCanvas()/viewMode/autoCropArea): the crop is
// read via the <cropper-selection> element's $toCanvas(), and the 2.x template is the
// default with the selection covering the whole image initially (legacy's autoCropArea: 1).
// cropperjs registers its custom elements at import time, which needs a DOM, so it is
// imported dynamically in the effect rather than at module load (keeps node-env unit tests
// that import this component working).

export function CropModal({ imageSrc, onConfirm, onCancel }: { imageSrc: string; onConfirm: (blob: Blob) => void; onCancel: () => void }) {
  useLockBodyScroll();
  const imgRef = useRef<HTMLImageElement>(null);
  const cropperRef = useRef<Cropper | null>(null);
  // Cropper.js initialises 50ms after mount (matching legacy's own setTimeout); the confirm
  // button stays disabled until then rather than silently no-op'ing on an early click — this
  // also gives e2e specs a real signal (button becomes enabled) to wait on instead of reaching
  // into Cropper's internal DOM structure, which the project's e2e-selector-guard forbids.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!imgRef.current) return undefined;
    setReady(false);
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { default: CropperCtor, DEFAULT_TEMPLATE } = await import('cropperjs');
      if (cancelled || !imgRef.current) return;
      cropperRef.current = new CropperCtor(imgRef.current, {
        template: DEFAULT_TEMPLATE.replace('initial-coverage="0.5"', 'initial-coverage="1"'),
      });
      setReady(true);
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cropperRef.current?.destroy();
      cropperRef.current = null;
    };
  }, [imageSrc]);

  async function handleConfirm() {
    const selection = cropperRef.current?.getCropperSelection();
    if (!selection) return;
    // Output at the source image's native resolution (selection coordinates are in on-screen
    // pixels), capped at 800px on the longer side with the aspect ratio kept (legacy's
    // maxWidth/maxHeight).
    const image = cropperRef.current?.getCropperImage();
    const displayed = image?.getBoundingClientRect().width;
    const native = image && displayed ? image.$image.naturalWidth / displayed : 1;
    const nativeWidth = selection.width * native;
    const nativeHeight = selection.height * native;
    const scale = Math.min(1, 800 / Math.max(nativeWidth, nativeHeight));
    const canvas = await selection.$toCanvas({
      width: Math.round(nativeWidth * scale),
      height: Math.round(nativeHeight * scale),
    });
    canvas.toBlob((blob) => {
      if (blob) onConfirm(blob);
    }, 'image/jpeg');
  }

  return (
    <div data-testid="crop-modal" className="fixed inset-0 bg-black/95 z-70 flex items-center justify-center p-4">
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
