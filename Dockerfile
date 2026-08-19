FROM node:20-slim AS builder

# Use Australian Debian mirror to speed up package downloads (best-effort)
RUN sed -i '/debian-security/!s|http://deb.debian.org/debian|http://ftp.au.debian.org/debian|g' /etc/apt/sources.list.d/debian.sources || true

# Install system build dependencies required for compiling better-sqlite3 and sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and install dependencies (compiles native modules)
COPY package.json package-lock.json ./
RUN npm install --production

FROM node:20-slim AS client-builder

WORKDIR /app/client

# Separate stage: the client has its own package.json (Vite/React/TypeScript
# devDependencies) that `npm install --production` in the builder stage above never
# installs. Building it here keeps those devDependencies out of the runtime image.
COPY client/package.json client/package-lock.json ./
RUN npm install

COPY client/ ./
RUN npm run build

FROM node:20-slim

WORKDIR /app

# Copy compiled node_modules and manifests from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json ./

# Copy application source
COPY . .

# Copy the built React client (stage 1 of the front-end rewrite) — only the built output,
# not the client's source or devDependencies
COPY --from=client-builder /app/client/dist ./client/dist

# Expose app port
EXPOSE 2626

CMD ["node", "server.js"]
