# Handoff: security/frontend (#59 plus related front-end hardening)

## Changelog-ready summary
- **Retired the legacy front end (#59).** Removed the `/legacy` static route from `server.js`, `public/index.html` and the ten legacy (non-`v2-`) Playwright specs. The unpinned, SRI-less CDN scripts (Tailwind, html5-qrcode, Chart.js, Cropper 1.5.13) are gone with it. `/legacy/...` now falls through to the React SPA fallback like any unknown path. `public/uploads` still exists in the image (Dockerfile `RUN mkdir -p /app/public/uploads`; the entrypoint also `mkdir -p`s and chowns it).
- **No third-party runtime assets.** Google Fonts removed from all eight HTML entry points (`index.html` plus the seven alternate-style pages) and the seven variant stylesheets; fonts are now bundled by Vite from `@fontsource/*` (latin subset, only the weights used). OFL licences are in `client/public/font-licences/` (served at `/font-licences/`).
- **Content-Security-Policy** added to `securityHeaders` (every response): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. No `unsafe-inline`, no `unsafe-eval`, no `upgrade-insecure-requests` (the app is also reached over plain http on the LAN). `Permissions-Policy` unchanged (`camera=(self), fullscreen=(self)`).
- **Inline theme script** moved to external classic scripts `client/public/theme-init.js` (all pages) and `theme-init-locked.js` (Pixel Art and Modern Dark, the two dark-only styles). They are copied verbatim into `dist/`, stay blocking (no flash of wrong theme), and need no hash, so nothing is hand-maintained.
- **Cropper.js 2 regressions fixed** (`CropModal.tsx`): selection can no longer extend past the image, and the crop canvas is fitted to the image (it had been left at Cropper 2's 200x100 default, a tiny crop area letterboxed on a checkerboard; Phase 1 e2e did not notice).
- **Deduct modal feedback.** `DeductModal` swallowed API failures (an unhandled rejection, no message, modal stuck) and showed no success toast, unlike legacy. It now shows the server error as a red toast and stays open, and shows "Item quantity reduced." on success.
- **Schema:** none. **Dependencies:** client adds nine `@fontsource/*` packages (all OFL-1.1).

## Legacy spec -> v2 spec mapping
| Legacy spec (deleted) | Behaviour | Covered by |
|---|---|---|
| `app-loads` | header shows "Terrible" | `v2-login` (authenticated-view test now also asserts the header; added) |
| `auth` | login screen when logged out, login works, bad credentials error | `v2-login` (all three, already) |
| `barcode-scan` | scan fills barcode in Add; scan in Deduct selects without deducting | `v2-barcode-scan` (already, plus unknown-barcode case) |
| `card-double-tap` | single click does not open details; double click does | **Retired, not ported.** Behaviour intentionally changed in the React client (a single tap opens the unified detail view, `v2-item-detail` "unified detail view"; the scroll/drag guards are covered by two `v2-item-detail` tests) |
| `duplicate-detection` | exact name match, "Use this" merges quantity; "Add as new anyway" overrides | `v2-item-detail` "add, duplicate-detect/override, and edit" (exact match now auto-merges with no panel, fuzzy shows the panel with override: both asserted) |
| `error-handling` | failed request -> red error toast, no `alert()` dialog; success -> green toast | **Ported** to `v2-feedback-and-locations` (needed the `DeductModal` fix above; no v2 spec covered it) |
| `invoice-import` | Woolworths 32 lines; category persists across reload; commit creates items | `v2-invoice-import` (same three, already) |
| `label-scan-suggestion` | new category / custom name / exact match / close existing preselected | `v2-label-scan` covers the first three; the **close-existing-category preselect, no duplicate** case was **ported** to `v2-feedback-and-locations` |
| `location-tabs` | special tabs present; new location tab filters; rename updates label, delete falls back to All Inventory | tabs and filtering: `v2-inventory` ("tab filtering...", `locations_updated`); **rename / delete-fallback ported** to `v2-feedback-and-locations` |
| `multi-location` | All Inventory total + "elsewhere" note vs per-location qty; deduct picker only for multi-location | picker: `v2-item-detail` "deduct requires a location picker...". Totals: `v2-inventory` "Unavailable" split plus `client/src/lib/cardQuantity.test.ts` / `filterItems.test.ts`. The legacy "elsewhere" text note does not exist in the React client, so it is not ported |
`smoke.spec.js` (data-URL browser launch) is not legacy and was kept. Legacy suite removal also frees mutation-rate-limit budget for the remaining specs.

## New tests
- `test/csp.test.js`: CSP on several routes, directive values, no `unsafe-*`, no third-party origin, `camera=(self)` alongside; and (if `client/dist` is built) built HTML has no inline scripts, `on*=` handlers or third-party `src`/`href`. `test/stage3.test.js` still guards `camera=(self)`.
- `test-e2e/csp-guard.js`: every spec now imports `test`/`expect` from it; an auto fixture fails the test on any CSP violation (page `securitypolicyviolation` event and Chromium's console message). **Verified it can fail:** tightening to `style-src 'self'` first, then proving a deliberately provoked inline-script violation is blocked (`v2-csp` test 3).
- `test-e2e/v2-csp.spec.js`: real html5-qrcode scanner starts against a fake camera (Playwright launch flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, added to `playwright.config.js`) with no violations; `/` and all seven variant pages request only same-origin resources; CSP header present and inline script blocked.
- `test-e2e/v2-crop-bounds.spec.js`: image fitted (>400px wide, not the 200x100 default); resize outwards and move far past the edges stay inside the image. **Verified it fails** without `min-inset="0"`.
- `test-e2e/v2-feedback-and-locations.spec.js`: three ported specs above.

## Results (Node 24.21, this branch)
- `npm test`: backend 280/280, client 125/125.
- Client `npm run build`: passes (tsc + vite).
- e2e (`flock /tmp/butler-e2e.lock npm run test:e2e`): 55/55, every spec under the CSP-violation guard.
- Docker smoke (image `butler-sectest:frontend`, dummy auth env, probed from inside the container): `/` returns the CSP and `camera=(self)`; `/legacy/` serves the SPA shell; `/font-licences/...` and `/theme-init.js` 200; `/app/public/uploads` exists owned by 99:users.

## Decisions
- **`style-src 'self'` with no `unsafe-inline`.** I first assumed Cropper 2 / html5-qrcode needed inline styles; the e2e guard showed they style through the CSSOM, which CSP permits. Anything that later injects a `<style>` or `style="..."` markup will be blocked and the guard will say so.
- **`connect-src 'self'`** only: CSP3 `'self'` covers same-origin `ws:`/`wss:`. Older Safari (< 15.4) treated it as http(s) only; if a client that old matters, add explicit `ws://host`/`wss://host` (needs the request host, so deliberately not done).
- **All variant pages self-hosted too,** not just the main client the brief named, otherwise the CSP would block their fonts.
- **Cropper:** `min-inset="0"` on the selection, plus the canvas fitted to the image and the image made static (pan/zoom/rotate attributes dropped), because inset is measured against the canvas, not the image. A change that would leave the image is rejected outright (the selection stops at the edge rather than sliding along it). A container resize rebuilds the cropper and restarts the selection.
- **CLAUDE.md** gained constraint #9 (CSP, no third-party assets, use `csp-guard.js`) and corrected opening/layout lines. The owner may prefer that as a convention rather than a "non-negotiable"; trivially movable.
- Stale comments in `client/src/**` that say "ports X from public/index.html" were left: they are history pointers (the file is in git history), and editing ~25 files for that would be noise.

## Coordination
- **Uploads agent:** `public/uploads` is created by `RUN mkdir -p /app/public/uploads` in the Dockerfile (one line, just before the entrypoint COPY). Keep it, or keep an equivalent, if you change the uploads path. `.gitignore` ignores `public/uploads/`, so a `.gitkeep` would not have worked.
- **Auth/pipeline agents:** all e2e specs now import from `./csp-guard.js`; new specs must too. The CSP header is set first in `securityHeaders`, so any route that serves inline HTML/scripts would be blocked.

## Owner should eyeball
- Fonts on `/` and each variant page (`/claymorphism.html`, `enterprisesaas`, `flatdesign`, `material3`, `moderndark`, `pixelart`, `tactile`): same family and weights, now served locally (latin subset only; accented Latin-1 is covered, other scripts are not).
- The label-crop modal on a phone and desktop: the image should now fill the modal and the selection should stop at the image edge. Previously a small checkerboard-padded box.
- Deduct modal: error and success toasts.

## Left behind / not done
- Docker leftovers on the host daemon (permission layer blocked `docker rm`/`rmi` of anything it did not itself track): containers `fe-smoke`, `fe-smoke2` (exited) and image `butler-sectest:frontend`. Remove with `docker rm fe-smoke fe-smoke2; docker rmi butler-sectest:frontend`.
- Barcode scanning against a real camera on a real device is untested (the fake-camera stream only proves the scanner starts under the CSP).
- No Playwright coverage of the second browser context in `v2-inventory` for CSP (it opens its own context; the guard covers the default one).

## Process notes
`repository-reader` was not used: the files involved were small or located by grep. 
## Review
`code-diff-reviewer`: escalation score 4 (OWN band), 3 Sonnet passes, no Mythos/counsel by band. Two passes returned NO FINDINGS (a known failure mode, not evidence of clean code); one raised a single-pass finding, verified real and fixed: `moderndark.html` was moved to the generic `theme-init.js` and lost its dark-only lock (the old inline script set `data-theme-locked`, hiding the no-op Dark Mode toggle); it now loads `theme-init-locked.js`, with a `test/csp.test.js` guard on which page uses which script. Advisor pass run last (see the hand-back).
