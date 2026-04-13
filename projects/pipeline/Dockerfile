# syntax=docker/dockerfile:1.7

# End-to-end Docker build that follows the pipeline README:
#   1. Install Python deps from requirements.txt
#   2. Drop config.example.py in place as config.py
#   3. For each email in customers.txt: python3 run_customer.py <email>
#      (uses the `claude` CLI for layers 3 & 4)
#   4. python3 generate_viewer_data.py
#   5. Serve the resulting viewer.html via nginx
#
# The runtime image keeps Python + pip deps + the `claude` CLI installed so
# you can rerun the pipeline interactively without a rebuild:
#   docker compose exec pipeline claude --version
#   docker compose exec pipeline python3 /app/pipeline/run_customer.py <email>
#
# Expected build secrets (BuildKit):
#   --secret id=gcp_sa,src=<ADC or service-account JSON>   # BigQuery auth
#   --secret id=anthropic_api_key,src=<file-with-key>      # claude CLI auth
#
# Build context for this image is ./projects/pipeline (see docker-compose.yml).


# ── Stage 1: Run the full pipeline, produce /build/output/viewer.html ─
FROM node:22-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        ca-certificates \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (provides the `claude` binary used by generate.py)
RUN npm install -g @anthropic-ai/claude-code \
    && which claude \
    && claude --version

WORKDIR /build/pipeline

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages -r requirements.txt

COPY . ./

# config.py per the README: start from example; code picks up creds from
# GOOGLE_APPLICATION_CREDENTIALS / ANTHROPIC_API_KEY at runtime.
RUN cp config.example.py config.py

RUN rm -rf /build/output && mkdir -p /build/output

# Run the full pipeline for every email listed in customers.txt.

RUN --mount=type=secret,id=gcp_sa,target=/run/secrets/gcp_sa.json \
    --mount=type=secret,id=anthropic_api_key,target=/run/secrets/anthropic_api_key \
    set -eu; \
    if [ ! -s customers.txt ]; then \
        echo "ERROR: customers.txt is empty. Add at least one email."; exit 1; \
    fi; \
    export GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/gcp_sa.json; \
    ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key | tr -d '[:space:]')"; \
    export ANTHROPIC_API_KEY; \
    grep -vE '^\s*(#|$)' customers.txt | while IFS= read -r email; do \
        email="$(echo "$email" | tr -d '[:space:]')"; \
        [ -z "$email" ] && continue; \
        echo "────────────────────────────────────────────────────────"; \
        echo "  Running pipeline for: $email"; \
        echo "────────────────────────────────────────────────────────"; \
        python3 run_customer.py "$email"; \
    done

RUN python3 generate_viewer_data.py


# ── Stage 2: Runtime image — nginx + python + claude CLI ──────────────
FROM nginx:alpine

# Install Python, pip, Node, and the Claude Code CLI so operators can
# `docker compose exec pipeline claude …` and rerun run_customer.py
# without rebuilding the image.
RUN apk add --no-cache \
        python3 \
        py3-pip \
        nodejs \
        npm \
        bash \
        ca-certificates \
 && npm install -g @anthropic-ai/claude-code \
 && which claude \
 && claude --version

# Wrapper: auto-loads ANTHROPIC_API_KEY from the mounted runtime secret, so
# `docker compose exec pipeline claude …` works without extra env plumbing.
RUN mv /usr/local/bin/claude /usr/local/bin/claude.real \
 && printf '%s\n' \
      '#!/bin/sh' \
      'if [ -z "$ANTHROPIC_API_KEY" ] && [ -r /run/secrets/anthropic_api_key ]; then' \
      '    ANTHROPIC_API_KEY="$(cat /run/secrets/anthropic_api_key)"' \
      '    export ANTHROPIC_API_KEY' \
      'fi' \
      'exec /usr/local/bin/claude.real "$@"' \
      > /usr/local/bin/claude \
 && chmod +x /usr/local/bin/claude

# Python deps for interactive reruns
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --break-system-packages -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt

# Keep a working copy of the pipeline source inside the container so you can
# `docker compose exec pipeline python3 /app/pipeline/run_customer.py <email>`.
WORKDIR /app/pipeline
COPY --from=builder /build/pipeline /app/pipeline

# Static assets served by nginx
COPY --from=builder /build/output/viewer.html /usr/share/nginx/html/viewer.html
COPY data /usr/share/nginx/html/data

# Templated nginx config — nginx's official entrypoint envsubsts this into
# /etc/nginx/conf.d/default.conf at container start. Lets us honour Cloud Run's
# $PORT convention without a custom entrypoint.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=80 \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
