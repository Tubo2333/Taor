FROM node:22-alpine
WORKDIR /app
# Copy dependency manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/tools/package.json ./packages/tools/
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/permission/package.json ./packages/permission/
COPY packages/hooks/package.json ./packages/hooks/
COPY packages/subagent/package.json ./packages/subagent/
COPY packages/memory/package.json ./packages/memory/
COPY packages/compressor/package.json ./packages/compressor/
COPY packages/engine/package.json ./packages/engine/
COPY packages/cli/package.json ./packages/cli/
# Install dependencies (layer cached unless any package.json changes)
RUN npm ci
# Copy source code and build
COPY packages/ ./packages/
RUN npm run build
CMD ["node", "--experimental-vm-modules", "examples/basic.js"]
