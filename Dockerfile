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
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Reproducible install from the lockfile (production dependencies only)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE} AS client-builder

WORKDIR /app/client

# Separate stage: the client has its own package.json (Vite/React/TypeScript
# devDependencies) that the server install above never installs. Building it here keeps
# those devDependencies out of the runtime image.
COPY client/package.json client/package-lock.json ./
RUN npm ci

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

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
