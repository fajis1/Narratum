# The ordinary image installs the CPU ONNX Runtime. The CUDA target overrides
# this with v11 so its embedded worker receives the P100-compatible native
# provider while the default build remains portable.
ARG ONNXRUNTIME_NODE_INSTALL_CUDA=skip

# Stage 1: extract seaweedfs weed binary (for optional embedded weed mini)
# Pin to 4.18 because CI observed upload regressions on 4.19.
FROM chrislusf/seaweedfs:4.18 AS seaweedfs-builder
RUN cp "$(command -v weed)" /tmp/weed && \
    (wget -qO /tmp/SeaweedFS-LICENSE.txt "https://raw.githubusercontent.com/seaweedfs/seaweedfs/master/LICENSE" || \
     wget -qO /tmp/SeaweedFS-LICENSE.txt "https://raw.githubusercontent.com/seaweedfs/seaweedfs/main/LICENSE")

# Stage 1b: extract nats-server binary for embedded single-container worker mode.
FROM nats:2.11-alpine AS nats-builder
RUN cp "$(command -v nats-server)" /tmp/nats-server

# Stage 2: build the Next.js app
FROM node:lts-slim AS app-builder

# Install pnpm globally
RUN npm install -g pnpm@10.33.4
ARG ONNXRUNTIME_NODE_INSTALL_CUDA
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=${ONNXRUNTIME_NODE_INSTALL_CUDA}

# Create app directory
WORKDIR /app

# Copy workspace manifests needed for dependency installation
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY compute/core/package.json ./compute/core/package.json
COPY compute/worker/package.json ./compute/worker/package.json
COPY docker/entrypoint-migration-tools/package.json ./docker/entrypoint-migration-tools/package.json

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy project files
COPY . .

# Build the Next.js application
RUN pnpm exec next telemetry disable
RUN AUTH_SECRET=build-placeholder-secret-value-32chars!! BASE_URL=http://localhost:3003 pnpm build
RUN pnpm --config.inject-workspace-packages=true --filter @openreader/entrypoint-migration-tools deploy /opt/entrypoint-migration-tools
RUN pnpm --config.inject-workspace-packages=true --filter @openreader/compute-worker deploy /opt/embedded-compute-worker
# Generate third-party dependency license report plus copied license files.
RUN mkdir -p /app/THIRD_PARTY_LICENSES && \
    pnpm dlx license-checker-rseidelsohn@4.3.0 \
      --production \
      --json \
      --relativeLicensePath \
      --out /app/THIRD_PARTY_LICENSES/licenses.json \
      --files /app/THIRD_PARTY_LICENSES/files


# Stage 3: minimal runtime image
FROM node:lts-slim AS runner

# Add runtime OS dependencies:
# - libreoffice-writer: required for DOCX → PDF conversion
# - pandoc: required for publication-grade EPUB eBook generation
# - python3, python3-pip, python3-venv: required for smart audio worker (audiobook_worker.py)
# ffmpeg is provided by ffmpeg-static from node_modules.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        libreoffice-writer \
        pandoc \
        python3 \
        python3-pip \
        python3-venv && \
    rm -rf /var/lib/apt/lists/*

# App runtime directory
WORKDIR /app

# Copy only the standalone Next runtime and assets.
COPY --from=app-builder /app/.next/standalone ./
COPY --from=app-builder /app/.next/static ./.next/static
COPY --from=app-builder /app/public ./public

# Copy the entrypoint and migration/runtime helper files it invokes directly.
COPY --from=app-builder /app/scripts/openreader-entrypoint.mjs ./scripts/openreader-entrypoint.mjs
COPY --from=app-builder /app/scripts/migrate-fs-v2.mjs ./scripts/migrate-fs-v2.mjs
COPY --from=app-builder /app/scripts/sync-dict-to-git.mjs ./scripts/sync-dict-to-git.mjs
COPY --from=app-builder /app/scripts/clean-git-pronunciation-library.mjs ./scripts/clean-git-pronunciation-library.mjs
COPY --from=app-builder /app/drizzle ./drizzle
COPY --from=app-builder /app/drizzle.config.pg.ts ./drizzle.config.pg.ts
COPY --from=app-builder /app/drizzle.config.sqlite.ts ./drizzle.config.sqlite.ts
COPY --from=app-builder /app/src/db ./src/db
COPY --from=app-builder /app/src/lib/server/default_global_pronunciations.json ./src/lib/server/default_global_pronunciations.json
COPY --from=app-builder /app/src/lib/server/default_global_definitions.json ./src/lib/server/default_global_definitions.json
COPY --from=app-builder /app/src/lib/server/default_global_pronunciation_tombstones.json ./src/lib/server/default_global_pronunciation_tombstones.json

# Merge in the dependency subset needed by the entrypoint migration scripts.
COPY --from=app-builder /opt/entrypoint-migration-tools/node_modules /tmp/runtime-tools-node_modules
RUN mkdir -p /app/node_modules && \
    rm -rf /tmp/runtime-tools-node_modules/@aws-sdk \
           /tmp/runtime-tools-node_modules/better-sqlite3 \
           /tmp/runtime-tools-node_modules/ffmpeg-static \
           /tmp/runtime-tools-node_modules/pg && \
    cp -an /tmp/runtime-tools-node_modules/. /app/node_modules/ && \
    rm -rf /tmp/runtime-tools-node_modules

# Ship the embedded compute worker as a separate deployed bundle.
COPY --from=app-builder /opt/embedded-compute-worker ./embedded-compute-worker
# Include third-party license report and copied license texts at a stable path in the image.
COPY --from=app-builder /app/THIRD_PARTY_LICENSES /licenses
# Include SeaweedFS license text for the copied weed binary.
COPY --from=seaweedfs-builder /tmp/SeaweedFS-LICENSE.txt /licenses/SeaweedFS-LICENSE.txt
# Include static model notices for runtime-downloaded assets.
COPY --from=app-builder /app/compute/core/src/pdf/assets/LICENSE.txt /licenses/pp-doclayoutv3-LICENSE.txt

# Copy seaweedfs weed binary for optional embedded local S3.
COPY --from=seaweedfs-builder /tmp/weed /usr/local/bin/weed
RUN chmod +x /usr/local/bin/weed
# Copy nats-server binary for embedded local JetStream.
COPY --from=nats-builder /tmp/nats-server /usr/local/bin/nats-server
RUN chmod +x /usr/local/bin/nats-server

# Include OpenAI Whisper license text for runtime-downloaded ONNX artifacts.
COPY --from=app-builder /app/compute/core/src/whisper/assets/LICENSE.txt /licenses/openai-whisper-LICENSE.txt

# Copy smart audio Python worker & scan_pdf_foreign_words script, and install dependencies into a venv.
# The entrypoint checks for .venv/bin/python first, then falls back to python3.
COPY --from=app-builder /app/audiobook_worker.py ./audiobook_worker.py
COPY --from=app-builder /app/biblical_scholar_worker.py ./biblical_scholar_worker.py
COPY --from=app-builder /app/gemini_rate_limiter.py ./gemini_rate_limiter.py
COPY --from=app-builder /app/scan_pdf_foreign_words.py ./scan_pdf_foreign_words.py
RUN python3 -m venv .venv && \
    .venv/bin/pip install --no-cache-dir nats-py google-genai pydantic pypdf nltk wordfreq

# Match the app's historical container port now that standalone server.js
# is started directly instead of `next start -p 3003`.
ENV PORT=3003

# Expose the port the app runs on
EXPOSE 3003

# Start the application
ENTRYPOINT ["node", "scripts/openreader-entrypoint.mjs", "--"]
CMD ["node", "server.js"]

# Optional all-in-one CUDA runtime. It retains the same private embedded NATS,
# SeaweedFS, and compute-worker topology as the ordinary image; only the native
# CUDA/cuDNN runtime and provider defaults differ. CUDA 11.8 + cuDNN 8.9.6
# matches onnxruntime-node 1.18.0 and supports the Pascal Tesla P100 (sm_60).
FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04@sha256:85fb7ac694079fff1061a0140fd5b5a641997880e12112d92589c3bbb1e8b7ca AS cuda-runtime

FROM runner AS runner-cuda

COPY --from=cuda-runtime /usr/local/cuda-11.8 /usr/local/cuda-11.8
COPY --from=cuda-runtime /usr/lib/x86_64-linux-gnu/libcudnn* /usr/lib/x86_64-linux-gnu/

ENV LD_LIBRARY_PATH=/usr/local/cuda-11.8/targets/x86_64-linux/lib:/usr/lib/x86_64-linux-gnu
ENV COMPUTE_JOB_CONCURRENCY=1
ENV PDF_LAYOUT_ONNX_EXECUTION_PROVIDER=auto
ENV WHISPER_ONNX_EXECUTION_PROVIDER=cpu
ENV COMPUTE_CUDA_DEVICE_ID=0
ENV COMPUTE_CUDA_ALLOW_CPU_FALLBACK=true
ENV COMPUTE_RELEASE_ONNX_SESSIONS_AFTER_JOB=true

# Keep the final/default target CPU-only for ordinary `docker build .`.
FROM runner AS final
