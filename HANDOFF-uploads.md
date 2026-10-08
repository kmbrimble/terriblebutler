# Handoff: security/uploads (issues #41, #51, #60)

## Changelog-ready summary
- **Security (#41):** Uploaded images are no longer served statically or unauthenticated. `/uploads` is gone; stored images are delivered by `GET /media/:name?exp=&sig=` only, with an HMAC-SHA256 signature over `name.expiry`. Item payloads (every REST endpoint and Socket.IO broadcast) now return `image_path` as a freshly signed URL; the DB keeps the stable stored name.
- **Security (#41):** Uploads are never stored as sent. multer writes to a private scratch dir; sharp decodes the file, the *sniffed* format must be jpeg/png/webp/heif (declared MIME and client filename are ignored), and it is re-encoded to WebP (max 2048 px edge, EXIF/GPS/ICC stripped, orientation applied) under a server-generated `<32 hex>.webp` name. Non-images declared as images are rejected with 400.
- **Storage (#51):** one `UPLOADS_DIR` (lib/config.js), default `/app/public/uploads` = the existing bind mount. Uploads now survive container recreation. No template change, no data migration (live host had no uploaded files, 0/258 items with an image).
- **Parser bounds (#60):** `limitInputPixels` 50 MP; sharp loaders other than jpeg/png/webp/heif blocked (`sharp.block`); invoice PDFs over 20 pages are rejected (422) in `/api/invoices/parse` and `/import`; multipart envelope capped (5 fields, 6 parts, 16 KiB per field).
- **Behaviour changes:** `/api/upload-image` returns `{ image_id, image_path }` (signed URL). `/api/parse-label-llm` now returns 400 for a non-image (was a 200 empty result) and honours EXIF orientation. PDFs are never stored; non-PDF bytes declared as PDF get 400.
- **Schema:** none. `items.image_path` now holds the stored name (`<hex>.webp`); legacy values (none exist live) are served as `null`.

## Decisions
- **Signing:** HMAC-SHA256, key = HKDF-SHA256(JWT_SECRET, info `butler/media-url/v1`). Domain-separated from JWT signing, no second secret to deploy. Rotating JWT_SECRET invalidates outstanding image URLs only (clients refetch). Constant-time compare.
- **TTL:** expiry is quantised to the hour, so a URL is valid 1-2 h and identical for everyone within an hour: browsers can cache across list refetches (`Cache-Control: private, max-age=<remaining>`). Relative URL (`/media/...`), works for `<img>` and React Native `Image` with the API base prepended.
- **Route outside `/api`:** `/media` is authorised by signature, not by bearer, so `/api` auth (constraint #2) is untouched and no public `/api` route was added.
- **Canonical format WebP:** keeps alpha (PNG labels), small, decodable by browsers and RN. 2048 px cap.
- **Limits:** 50 MP (fits 48 MP phones; default is ~268 MP). PDF 20 pages, *reject not truncate*, so a long document can't silently drop invoice lines.
- **Allow-list is belt and braces:** with loaders blocked, the format allow-list is currently redundant (mutation-tested); kept because the spec asks for both layers.
- **HEIC:** sharp's prebuilt libvips has no HEVC decoder, so true iPhone HEIC files fail with 400 (as they already failed in the label parser). Browsers/iOS normally convert to JPEG on upload. Not a regression.
- **`/legacy`:** UPLOADS_DIR defaults inside `public/`, which `/legacy` serves. `denyUploadsUnder` blocks it by decoded path (review found the first raw-prefix guard bypassable). Remove the one `app.use('/legacy', uploads.denyUploadsUnder(...))` line if the frontend branch retires `/legacy`.
- **middleware.js:** multer config moved to `lib/uploads.js` (deleted from middleware.js and its exports). Expect a trivial merge touch near the exports with the auth branch.

## Deploy notes
- Force-update only; no env/template change. Dockerfile sets `UPLOADS_DIR=/app/public/uploads`; the entrypoint now chowns `$UPLOADS_DIR` (the old `/app/uploads` entry is gone).
- First deploy: confirm `https://butler.kiztigs.com` loads, then optionally upload a label photo and confirm the file appears in `/mnt/user/appdata/butler/uploads` as `<hex>.webp`.
- Docker smoke (`butler-sectest:uploads`, named volumes, image removed): non-root (uid 99, NoNewPrivs), upload 200 -> file in UPLOADS_DIR named `<hex>.webp` despite client filename `x.html`, scratch dir empty, signed GET 200 `image/webp` with CSP/nosniff, unsigned `/media` 403, unauthenticated upload 401, `/legacy/uploads/<id>` 404.
- **Left behind (permission layer blocked `docker volume rm`):** volumes `sectest-uploads-data`, `sectest-uploads-files`, `sectest-uploads-tmp` on the host daemon. Remove with `docker volume rm sectest-uploads-data sectest-uploads-files sectest-uploads-tmp`.

## Flags for integration / other agents
- **Nothing writes `items.image_path`** (POST/PUT items ignore it) and the React client renders no images, so `/api/upload-image` is currently orphaned: files uploaded there are not linked to an item and nothing garbage-collects them. Linking (and cleanup on item delete) is a feature, not done here. The `ItemRow.image_path` type is documented as a signed URL.
- **actionLogger logs response bodies**, so mutation responses put signed image URLs (1-2 h life) and, from the auth routes, tokens into the action log. Counsel also raised this. Owned by the auth/logging work; redact there.
- Counsel (below) also raised out-of-scope items: `/api/invoices/commit` input validation, LLM rate limit/concurrency for `/import` (#55), `trust proxy`, device-token timestamp NaN, error-message disclosure, label-parser 200-on-failure, rate-limit map bound, dangling `invoice_imports` row on LLM failure.
- Client: no React code consumes images yet; only the type doc changed. When one does, use `item.image_path` directly and refetch the item on 403/error (the URL is regenerated on every response).
- E2E now gives the server temp `UPLOADS_DIR`/`UPLOAD_TMP_DIR` (global-setup/teardown).

## Tests
`test/uploads.test.js` (28 cases): unsigned/tampered/expired/wrong-id rejection, traversal shapes, valid delivery + headers, signed URLs on list/detail/barcode/search/grocery/PUT and in `getItem` (broadcast source), legacy/junk values -> null, bucketed URLs, extension independence, content-not-MIME rejection (html, svg, gif, tiff, text), metadata stripped + orientation applied, pixel limit, loader block, `/legacy` encoded-path bypass, multipart padding, scratch cleanup, PDF 21 pages -> 422 on both routes, 20 pages accepted, non-PDF -> 400. Mutation-checked: removing the pixel limit, expiry check, loader block, metadata strip, page bound or the encoded-path guard each fails a test. `module-seam` route table gains `GET /media/:name`.

## Review
`code-diff-reviewer`: score 10 (CALL; exposure 3, authority 2, data 2, reversibility 1, test gap 1, modules 1; my first scoring wrongly applied the infra suppressor, corrected). 3 Sonnet + 1 Mythos (Mythos: NO FINDINGS). One finding, agreed 3/4 Sonnet: the `/legacy/uploads` raw-prefix guard was bypassable by `%75ploads`, `//`, `%2F` -> **fixed** (18180ac) with `denyUploadsUnder` + test. Counsel (gpt-5.6-terra): one in-scope item acted on (multipart field limits); a PDF extracted-text cap suggestion was not taken (20 pages bounds it; revisit with #55's line cap); the rest listed above.
