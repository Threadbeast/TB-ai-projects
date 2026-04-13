# Secrets for docker compose build

This folder holds the Anthropic API key used at **build time** by the `pipeline`
image. BigQuery auth uses your own `gcloud` Application Default Credentials —
no service account needed.

Add to your `.gitignore`:

```
secrets/*
!secrets/README.md
```

## Required

### 1. BigQuery (your user account)

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project threadbeast-warehouse
```

This writes credentials to
`~/.config/gcloud/application_default_credentials.json`, which
`docker-compose.yml` mounts into the build as a secret. Your user needs
BigQuery Data Viewer + Job User on `threadbeast-warehouse`.

### 2. Anthropic API key

```bash
printf 'sk-ant-...' > secrets/anthropic-api-key.txt
```

## Build

```bash
docker compose build pipeline
docker compose up -d
```

BuildKit mounts both secrets into the single `RUN` that needs them — they're
never baked into image layers.
