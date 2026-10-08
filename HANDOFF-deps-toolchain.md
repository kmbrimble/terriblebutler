# Handoff: security/deps-toolchain (issues #57, #58)

## Changelog-ready summary
- **Runtime:** Node 20 -> 24 (Active LTS; Node 26 enters LTS 2026-10-28). `engines >=24` (root and client), `.nvmrc`, all Dockerfile stages. Base image pinned by digest (`node:24-slim`).
- **Server deps (all latest, osv-clean):** express 4.22 -> 5.2.1, multer 1.4.5-lts.2 -> 2.4.0, better-sqlite3 11.10 -> 13.0.3, sharp 0.33.5 -> 0.35.5, @anthropic-ai/sdk 0.120 -> 0.132.1, socket.io 4.8.3 -> 4.8.4 (engine.io patched), vitest 2.1.9 -> 5.0.3, @playwright/test + playwright 1.62.1 -> 1.64.0, supertest 7.2.2 -> 7.3.1, cors 2.8.6. bcryptjs, fuse.js, jsonwebtoken, pdf-parse already latest.
- **Client deps (all latest):** react/react-dom 18 -> 19.3, @types/react(-dom) 19, vite 5 -> 8.3, @vitejs/plugin-react 4 -> 6, tailwindcss 3 -> 4.3 (+ @tailwindcss/vite; autoprefixer and postcss removed), typescript 5.9 -> 7.0.2, vitest 2 -> 5, cropperjs 1.6 -> 2.3, @types/node 20 -> 24, socket.io-client 4.8.4.
- **Code changes:** Express 5 SPA fallback `'*'` -> `'/{*splat}'`; `req.body` defaults to `{}` (Express 5 leaves it undefined; new test `test/express5-body-default.test.js`); `CropModal` rewritten for Cropper.js 2 (`<cropper-selection>.$toCanvas`, lazy-loaded, native-resolution output capped at 800px); Tailwind 4 migration (`@import 'tailwindcss'`, `@config` for the existing theme, `bg-opacity-*` -> `/NN`, 3.x border-colour default retained); `src/vite-env.d.ts` for TS 7; `vitest.config.js` -> `.mjs`; `test:client`/`build:client` use `npm ci`.
- **module-seam snapshot changed deliberately:** `GET *` -> `GET /{*splat}` (path-to-regexp 8 rejects bare `*`), `app._router` -> `app.router`. Nothing else in the route table changed.
- **Schema:** none.
- **Container (#58):** `npm ci --omit=dev` / `npm ci`; non-root via `docker-entrypoint.sh` (PUID/PGID, default 99:100; chowns data/uploads/logs then `setpriv` drop, no-new-privs, node is PID 1); `NODE_ENV=production`; `.dockerignore` now excludes `logs/` and `uploads/` (a local build previously baked local action logs into the image).
- **Keeping current:** `.github/dependabot.yml` (npm root + client, docker, github-actions; weekly, grouped). Actions SHA-pinned: checkout v7.0.1, login-action v4.6.0, build-push-action v7.4.0, claude-code-action v1.0.246.
- **osv-scanner (offline DB refreshed):** before 40 advisories (28 root, 12 client; 14 on runtime deps: engine.io, multer x11 [counted above], proxy-addr, qs x2, sharp x3); after 0 on both lockfiles.

## Decisions
- Apt packages are not version-pinned: they exist only in the discarded builder stage and pinned Debian versions vanish from mirrors; the digest-pinned base is the reproducibility lever.
- PUID/PGID 0 is refused by the entrypoint. `--user` at `docker run` skips the drop.
- Cropper.js 2 has no `viewMode`/`minCropBox` equivalent; the selection can extend past the image edge (transparent area -> black in JPEG). Accepted; revisit if it matters.
- CI workflows have no Node steps, so there was no CI Node version to change.

## CLAUDE.md
Already edited here: Node 24/Express 5 mention, new "Container runtime (non-root)" section. Live deploy note for the owner: existing unRAID template needs no change (defaults 99:100); first start chowns `inventory.db*` to 99:100.
