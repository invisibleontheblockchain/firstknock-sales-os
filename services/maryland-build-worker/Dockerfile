FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/canvas-evidence ./scripts/canvas-evidence

USER node
CMD ["node", "scripts/canvas-evidence/statewide/maryland-build-worker.mjs"]