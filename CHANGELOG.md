# Changelog

The minor version (after the dot) is an integer counter that increments by 1 each change: 0.1, 0.2 ... 0.9, 0.10, 0.11, and so on. The major version (before the dot) is NOT auto-incremented — it only advances when the user manually declares a milestone.

## 0.14 - 2026-08-11
- Plan: make the location tab bar dynamic instead of hardcoded, in `public/index.html`.
  - Replace the hardcoded `tabs` array with three fixed special tabs (All Inventory, Grocery List, Ignored Out-of-Stock) plus one tab per entry in the `locations` array (from `GET /api/locations`), inserted between All Inventory and Grocery List, in API order.
  - Replace `currentTab` (a tab-label string) with a `{ type: 'all' | 'location' | 'grocery' | 'ignored', id }` object; filter location tabs by `item.location_id === currentTab.id` instead of matching `item.location_name` against a hardcoded string, so renames no longer break filtering.
  - Re-render the tab bar whenever `locations` is refetched (initial load and the existing `locations_updated` socket handler), so added/renamed/deleted locations are reflected immediately. If the selected location tab no longer exists after a refresh, fall back to "All Inventory".
  - Tests: new Playwright e2e spec (`test-e2e/location-tabs.spec.js`) that seeds a location via `POST /api/locations`, reloads the page, asserts the three special tabs plus a tab for the new location all appear, and that selecting the new tab filters the item list to items in that location only.
  - Scope: `public/index.html` and `test-e2e/` only; `server.js` untouched.

## 0.13 - 2026-08-10
- Added a `version` field to the `GET /healthz` response (now `{ status: 'ok', version: '0.13' }`), so a running deployment's version can be verified against this changelog. Updated the backend healthz test to assert on `status` and `version` individually rather than an exact body match.

## 0.12 - 2026-08-10
- Stage 3-lite: graceful shutdown (fixes slow stop), /healthz endpoint, rate limiting, and security headers with camera allowed.

## 0.11 - 2026-08-09
- Stage 2: fixed barcode scanner (context capture), select-before-deduct behavior, XSS escaping; added Playwright e2e suite.

## 0.10 - 2026-08-09
- Stage 1: data-integrity fixes (validation, transactions, guarded deduct, 404s, price recalculation).

## 0.9 - 2026-08-09
- Test harness: Stage 1 red baseline (23 tests).

## 0.8 - 2026-08-09
- Multi-stage build to slim final image (drop compiler toolchain from runtime).

## 0.7 - 2026-08-08
- Added synchronous=FULL pragma for power-loss durability.

## 0.6 - 2026-08-08
- Bumped GitHub Actions to Node 24 versions (checkout v5, login v4, build-push v7).

## 0.5 - 2026-08-08
- Containerised Butler: added Dockerfile, GHCR workflow, dockerignore; externalised LLM config and port.

## 0.4 - 2026-07-26
- Changed server port to 2626 and updated log message.

## 0.3 - 2026-07-26
- Changed page title from 'Household Inventory' to 'Terrible Butler'.

## 0.2 - 2026-07-26
- Removed SQLite WAL files from tracking.

## 0.1 - 2026-07-26
- Initial commit of household inventory app.
