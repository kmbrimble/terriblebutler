# Node 24 is the Active LTS line. Base image pinned by digest (tag: node:24-slim, Debian 12);
# Dependabot's docker ecosystem bumps the digest. Pinning the digest, rather than individual
# apt package versions, is the chosen reproducibility mechanism: apt versions are removed from
# the Debian mirrors and make builds fail, and the apt packages below exist only in the
# discarded builder stage.
ARG NODE_IMAGE=node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS builder

# Use Australian Debian mirror to speed up package downloads (best-effort)
RUN sed -i '/debian-security/!s|http://deb.debian.org/debian|http://ftp.au.debian.org/debian|g' /etc/apt/sources.list.d/debian.sources || true

# Build tools only as a fallback for compiling better-sqlite3 / sharp when no prebuilt
# binary matches the platform. Not present in the final image.
# Not pinned, deliberately (hadolint DL3008): this is the discarded builder stage, the base image is
# pinned by digest above, and pinned Debian package versions are withdrawn from the mirrors, which
# breaks otherwise-unchanged builds. Nothing from this layer reaches the runtime image.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Reproducible install from the lockfile (production dependencies only)
COPY package.json package-lock.json ./
# Install scripts are an explicit allow-list (allowScripts in package.json). npm 11.19 skips an unlisted
# install script with only a warning, and --strict-allow-scripts does not turn that into an error, so the
# first command asserts the policy itself: better-sqlite3 allowed, fsevents denied. (The CI repo-config test
# is the real guard; this fails the image build too.) The second only proves the native module loads: a
# prebuilt binary would load even if the policy were lost, so it does not prove the policy.
RUN node -e "const a = require('./package.json').allowScripts || {}; if (a['better-sqlite3'] !== true || a.fsevents !== false) { console.error('package.json allowScripts must allow better-sqlite3 and deny fsevents'); process.exit(1); }" \
    && npm ci --omit=dev --strict-allow-scripts \
    && node -e "require('better-sqlite3'); console.log('better-sqlite3 loads')"

FROM ${NODE_IMAGE} AS client-builder

WORKDIR /app/client

# Separate stage: the client has its own package.json (Vite/React/TypeScript
# devDependencies) that the server install above never installs. Building it here keeps
# those devDependencies out of the runtime image.
COPY client/package.json client/package-lock.json ./
RUN npm ci --strict-allow-scripts

COPY client/ ./
RUN npm run build

FROM ${NODE_IMAGE}

# UPLOADS_DIR is the single directory processed images are stored in; it is the path the
# container bind-mounts, so it must match the volume in the unRAID template / docker-compose.yml.
ENV NODE_ENV=production \
    PUID=99 \
    PGID=100 \
    UPLOADS_DIR=/app/public/uploads \
    WRITABLE_ROOT=/app

WORKDIR /app

# Copy compiled node_modules and manifests from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json ./

# Application source: an explicit allow-list, root-owned and read-only to the app user. Anything
# the server needs at run time must be listed here (test/docker-build-context.test.js checks
# that every module reachable from server.js is). The client's source is deliberately absent:
# only its build output, below, is served.
COPY server.js backup.js logger.js db-migrations.js item-matching.js llm-schema.js ./
COPY lib ./lib
COPY routes ./routes
COPY parsers ./parsers
COPY scripts ./scripts

# Built React client: only the output, not the client's source or devDependencies.
COPY --from=client-builder /app/client/dist ./client/dist

# .dockerignore keeps local uploads out of the build context, so create the (empty) directory the
# volume mounts over; the entrypoint chowns it to PUID:PGID.
RUN mkdir -p "$UPLOADS_DIR"

# Starts as root only to fix ownership of the writable paths, then drops to PUID:PGID.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Expose app port
EXPOSE 2626

# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint -- deliberate: the entrypoint runs as root only to chown the writable mounts, then setpriv drops to PUID:PGID (never root) before exec'ing node
ENTRYPOINT ["docker-entrypoint.sh"]
# nosemgrep: dockerfile.security.missing-user.missing-user -- same: privileges are dropped by the entrypoint (setpriv --no-new-privs), see docker-entrypoint.sh
CMD ["node", "server.js"]
