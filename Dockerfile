FROM node:20-slim

# Install system build dependencies required for compiling better-sqlite3
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    sed -i '/debian-security/!s|http://deb.debian.org/debian|http://ftp.au.debian.org/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy remaining application files
COPY . .

# Expose app port
EXPOSE 2626

CMD ["node", "server.js"]
