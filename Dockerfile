# syntax=docker/dockerfile:1

# ---- build stage: compile the web app and the server ---------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage: production dependencies only --------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    WISPR_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
# Local Whisper (Transformers.js + ONNX Runtime binaries for every platform) adds about 800 MB to the image
# and needs about 1 GB of RAM at run time.
# Build with --build-arg LOCAL_WHISPER=0 for a slim image that offers browser speech and OpenAI only.
ARG LOCAL_WHISPER=1
RUN if [ "$LOCAL_WHISPER" = "1" ]; then npm ci --omit=dev; else npm ci --omit=dev --omit=optional; fi \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist-server/server/index.js"]
