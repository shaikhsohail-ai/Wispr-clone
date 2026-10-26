# syntax=docker/dockerfile:1

# ---- build stage: compile the web app and the server ---------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node (pulled in by @huggingface/transformers) would otherwise download about 270 MB of CUDA and
# TensorRT libraries from nuget.org that CPU inference never loads; skipping that keeps the build offline-safe.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci
COPY . .
RUN npm run build

# ---- runtime stage: production dependencies only --------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WISPR_DATA_DIR=/data
WORKDIR /app
# /data (history and the model cache) is the only directory the server writes to; /app stays root-owned and
# world-readable, which is all the node user needs (a recursive chown would copy every file into a new layer).
RUN mkdir -p /data && chown node:node /data
COPY package.json package-lock.json ./
# Local Whisper (Transformers.js + ONNX Runtime binaries for every platform) adds about 500 MB to the image
# and needs about 1 GB of RAM at run time.
# Build with --build-arg LOCAL_WHISPER=0 for a slim image that offers browser speech and OpenAI only.
ARG LOCAL_WHISPER=1
RUN if [ "$LOCAL_WHISPER" = "1" ]; then ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev; else npm ci --omit=dev --omit=optional; fi \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist-server/server/index.js"]
