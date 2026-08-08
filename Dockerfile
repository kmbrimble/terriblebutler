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

FROM node:20-slim

WORKDIR /app

# Copy compiled node_modules and manifests from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json ./

# Copy application source
COPY . .

# Expose app port
EXPOSE 2626

CMD ["node", "server.js"]
