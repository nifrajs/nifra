# nifra on Node, containerized. Build with Bun (nifra's build toolchain), then run the self-contained
# bundle on a slim Node image — the final image carries no build tools or node_modules.
#   docker build -t my-nifra-app .
#   docker run -p 3000:3000 my-nifra-app
FROM oven/bun:1 AS build
WORKDIR /app
# Copy manifests first so the install layer caches across source-only changes.
COPY package.json bun.lock* ./
RUN bun install
COPY . .
RUN bun run build:node

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# build:node emits a self-contained server-bundle + the client assets it serves from disk.
COPY --from=build /app/dist-node ./dist-node
EXPOSE 3000
CMD ["node", "dist-node/server-node.js"]
