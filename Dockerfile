# R-DEP-1: build web, server and extension zip, then a slim Debian runtime (demoparser2/duckdb ship glibc binaries).
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY extension/package.json extension/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
COPY extension extension
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# bzip2/zstd: raw demo (de)compression (R-DL-4, R-RET-3).
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 zstd ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/extension/dist/demo-analyzer-extension.zip extension/dist/demo-analyzer-extension.zip
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# R-DEP-2: the API process starts the worker; if either dies the container exits and is restarted.
CMD ["node", "--enable-source-maps", "server/dist/main.js"]
