import { useEffect, useRef, useState } from 'react';
import type Cropper from 'cropperjs';
import { useLockBodyScroll } from '../lib/useLockBodyScroll';
import { runAction, reportAction } from '../lib/actionFeedback';

// Ports handleImageSelection()/confirmCrop()/cancelCrop() from public/index.html. Cropper.js
// 2.x is a Web Components rewrite (no getCroppedCanvas()/viewMode/autoCropArea): the crop is
// read via the <cropper-selection> element's $toCanvas(), and the 2.x template is
// customised below (selection covers the whole image initially, legacy's autoCropArea: 1).
// cropperjs registers its custom elements at import time, which needs a DOM, so it is
// imported dynamically in the effect rather than at module load (keeps node-env unit tests
// that import this component working).

// Cropper 1's `viewMode: 1` kept the crop box inside the image; 2.x has no such option, so the
// selection could be dragged or resized past the image edge (transparent area, black in the
// JPEG sent for label parsing). Fix: the selection starts covering the whole image and carries
// `min-inset="0"`, which makes Cropper reject any change that would put an edge outside the
// canvas (sized to the image in the effect below). That only equals "inside the image" while the image fills the canvas, so the image's
// pan/zoom/rotate/skew attributes are dropped too (the crop is a region pick, not a viewer).
const CROP_TEMPLATE = (base: string) =>
  base
    .replace('<cropper-image rotatable scalable skewable translatable>', '<cropper-image data-testid="crop-image-layer">')
    .replace('<cropper-selection initial-coverage="0.5" movable resizable>', '<cropper-selection data-testid="crop-selection" initial-coverage="1" min-inset="0" movable resizable>');

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
    let observer: ResizeObserver | undefined;
    const init = async () => {
      const { default: CropperCtor, DEFAULT_TEMPLATE } = await import('cropperjs');
      const source = imgRef.current;
      const container = source?.parentElement;
      if (cancelled || !source || !container) return;
      await source.decode().catch(() => undefined);
      if (cancelled || !source.naturalWidth || !source.naturalHeight) return;

      // Cropper 2 leaves <cropper-canvas> at its 200x100 default rather than following the
      // <img>, which shrinks the crop area and letterboxes the image. Size the canvas to the
      // image's own aspect, contained in the available space (CSSOM, so CSP-safe), BEFORE the
      // image initialises, so the canvas is exactly the image and the selection's min-inset
      // bounds are the image edge. (Cropper cannot re-fit an initialised image, so a resize
      // rebuilds the cropper instead.)
      const build = async () => {
        // A resize can fire while the modal is closing; a cropper built on a detached tree never
        // upgrades its elements (no `$ready`), so skip the rebuild once this effect is torn down.
        if (cancelled || !container.isConnected) return;
        cropperRef.current?.destroy();
        const cropper = new CropperCtor(source, { template: CROP_TEMPLATE(DEFAULT_TEMPLATE) });
        cropperRef.current = cropper;
        const styles = getComputedStyle(container);
        const availableWidth = container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
        const availableHeight = container.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
        const scale = Math.min(availableWidth / source.naturalWidth, availableHeight / source.naturalHeight);
        const canvas = cropper.getCropperCanvas();
        if (canvas && scale > 0) {
          canvas.style.width = `${Math.floor(source.naturalWidth * scale)}px`;
          canvas.style.height = `${Math.floor(source.naturalHeight * scale)}px`;
        }
        await cropper.getCropperImage()?.$ready();
      };

      await build();
      if (cancelled) return;
      setReady(true);
      let lastWidth = container.clientWidth;
      let lastHeight = container.clientHeight;
      observer = new ResizeObserver(() => {
        if (container.clientWidth === lastWidth && container.clientHeight === lastHeight) return;
        lastWidth = container.clientWidth;
        lastHeight = container.clientHeight;
        reportAction(build(), 'Could not resize the crop area.');
      });
      observer.observe(container);
    };
    const timer = setTimeout(() => reportAction(init(), 'Could not prepare the crop area.'), 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer?.disconnect();
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
    const rendered = await runAction(
      () => selection.$toCanvas({ width: Math.round(nativeWidth * scale), height: Math.round(nativeHeight * scale) }),
      'Could not crop the image.'
    );
    if (!rendered.ok) return;
    rendered.value.toBlob((blob) => {
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
