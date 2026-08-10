# Changelog

The minor version (after the dot) is an integer counter that increments by 1 each change: 0.1, 0.2 ... 0.9, 0.10, 0.11, and so on. The major version (before the dot) is NOT auto-incremented — it only advances when the user manually declares a milestone.

## 0.14 - 2026-08-11
- Made the location tab bar dynamic instead of hardcoded, in `public/index.html`. Previously the tab bar and its filtering logic were built from a fixed array of location names, so a newly added location never got a tab and renaming/deleting a default location broke its filter.
  - The tab bar now always shows three fixed special tabs (All Inventory, Grocery List, Ignored Out-of-Stock) plus one tab per entry in the `locations` array (from `GET /api/locations`), inserted between All Inventory and Grocery List, in API order.
  - `currentTab` is now a `{ type: 'all' | 'location' | 'grocery' | 'ignored', id }` object rather than a tab-label string; location tabs filter by `item.location_id === currentTab.id` instead of matching `item.location_name` against a hardcoded string, so renames no longer break filtering.
  - The tab bar re-renders whenever `locations` is refetched (initial load and the existing `locations_updated` socket handler), so added/renamed/deleted locations are reflected immediately. If the selected location is deleted, the view falls back to "All Inventory".
  - Added `test-e2e/location-tabs.spec.js`: asserts the three special tabs are always present, that a location seeded via `POST /api/locations` gets its own tab and correctly filters items to that location (and excludes items in other locations), and that renaming/deleting a location updates/removes its tab with a sensible fallback.
  - Scope: `public/index.html` and `test-e2e/` only; `server.js` untouched. Full suite green: 29 backend (vitest) + 7 e2e (Playwright) tests.

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
