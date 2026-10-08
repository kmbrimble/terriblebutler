import { test, expect } from './csp-guard.js';
import path from 'node:path';
import { ADD_OPEN_BUTTON, SNAP_LABEL_FILE_INPUT, CROP_CONFIRM_BUTTON, CROP_SELECTION, CROP_IMAGE_LAYER } from './testids.js';

// Regression for the Cropper.js 2 upgrade: the crop selection must stay inside the image, as
// Cropper 1's viewMode did. The crop feeds label parsing, so out-of-image area would arrive as
// black bars in the JPEG.

const PRODUCT_IMAGE = path.join(process.cwd(), 'test/fixtures/product1.jpg');
const TOLERANCE = 1; // px, sub-pixel layout

async function openCropper(page) {
  await page.goto('/');
  await page.getByTestId(ADD_OPEN_BUTTON).click();
  await page.getByTestId(SNAP_LABEL_FILE_INPUT).setInputFiles(PRODUCT_IMAGE);
  await expect(page.getByTestId(CROP_CONFIRM_BUTTON)).toBeEnabled();
  await expect(page.getByTestId(CROP_SELECTION)).toBeVisible();
}

async function boxes(page) {
  const image = await page.getByTestId(CROP_IMAGE_LAYER).boundingBox();
  const selection = await page.getByTestId(CROP_SELECTION).boundingBox();
  return { image, selection };
}

function expectInside(selection, image) {
  expect(selection.x).toBeGreaterThanOrEqual(image.x - TOLERANCE);
  expect(selection.y).toBeGreaterThanOrEqual(image.y - TOLERANCE);
  expect(selection.x + selection.width).toBeLessThanOrEqual(image.x + image.width + TOLERANCE);
  expect(selection.y + selection.height).toBeLessThanOrEqual(image.y + image.height + TOLERANCE);
}

test('the crop selection starts on the whole image and cannot be resized or moved past its edges', async ({ page }) => {
  await openCropper(page);

  const start = await boxes(page);
  // The image is fitted to the modal, not left at Cropper 2's 200x100 default canvas.
  expect(start.image.width).toBeGreaterThan(400);
  expect(start.selection.width).toBeGreaterThan(start.image.width - 2 * TOLERANCE);
  expectInside(start.selection, start.image);

  // Resize outwards from the bottom-right corner, well past the image: rejected.
  const se = { x: start.selection.x + start.selection.width - 3, y: start.selection.y + start.selection.height - 3 };
  await page.mouse.move(se.x, se.y);
  await page.mouse.down();
  await page.mouse.move(se.x + 25, se.y + 25, { steps: 5 });
  await page.mouse.move(se.x + 120, se.y + 120, { steps: 5 });
  await page.mouse.up();
  expectInside((await boxes(page)).selection, start.image);

  // Shrink from the top-left, then drag the whole selection far beyond the bottom-right.
  const nw = { x: start.selection.x + 3, y: start.selection.y + 3 };
  await page.mouse.move(nw.x, nw.y);
  await page.mouse.down();
  await page.mouse.move(nw.x + 60, nw.y + 60, { steps: 10 });
  await page.mouse.up();
  const shrunk = (await boxes(page)).selection;
  expect(shrunk.width).toBeLessThan(start.selection.width - 30);

  const centre = { x: shrunk.x + shrunk.width / 2, y: shrunk.y + shrunk.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let step = 1; step <= 20; step++) await page.mouse.move(centre.x + step * 15, centre.y + step * 15);
  await page.mouse.up();
  const moved = (await boxes(page)).selection;
  expectInside(moved, start.image);
  expect(moved.width).toBeCloseTo(shrunk.width, 0);
});
