# Cloud Run deployment

This directory contains three Cloud Build configs that deploy the stack to
Cloud Run as three independent services behind an nginx reverse proxy.

```
  ┌──────────────┐          /analyzer/* ──► tb-analyzer (Node, *.run.app)
  │   tb-proxy   │
  │ (nginx)      │──────────┐
  │ public URL   │          └── /pipeline/* ──► tb-pipeline (nginx+viewer, *.run.app)
  └──────────────┘
         ▲
         │
      users
```

---

## One-time setup

Replace `PROJECT_ID` with your GCP project ID and `REGION` with your preferred
region (defaults below assume `us-central1`).

### 1. Enable APIs

```bash
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com
```

### 2. Create the Artifact Registry repo

```bash
gcloud artifacts repositories create tb-ai-projects \
    --repository-format=docker \
    --location=us-central1 \
    --description="TB AI projects container images"
```

### 3. Upload secrets to Secret Manager

```bash
# Anthropic API key (for both analyzer and pipeline)
printf '%s' 'sk-ant-api03-...' | \
    gcloud secrets create anthropic-api-key --data-file=-

# Service-account JSON with BigQuery read access (pipeline build time only)
gcloud secrets create gcp-sa-json --data-file=./secrets/gcp-sa.json
```

Grant the Cloud Build service account access to both secrets:

```bash
PROJECT_NUMBER=$(gcloud projects describe "threadbeast-devops" --format='value(projectNumber)')
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

for SECRET in anthropic-api-key gcp-sa-json; do
    gcloud secrets add-iam-policy-binding "$SECRET" \
        --member="serviceAccount:${CB_SA}" \
        --role=roles/secretmanager.secretAccessor
done
```
gcloud secrets add-iam-policy-binding "gcp-sa-json" --member="serviceAccount:${CB_SA}" --role=roles/secretmanager.secretAccessor

### 4. Create runtime service accounts

```bash
# Analyzer runtime SA (no special perms beyond Anthropic secret access)
gcloud iam service-accounts create tb-analyzer \
    --display-name="TB analyzer runtime"
gcloud secrets add-iam-policy-binding anthropic-api-key \
    --member="serviceAccount:tb-analyzer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
    
gcloud secrets add-iam-policy-binding anthropic-api-key --member="serviceAccount:ai-projects@threadbeast-devops.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor

# Pipeline runtime SA — also gets the Anthropic secret for interactive reruns.
# (BigQuery access is only needed at build time via gcp-sa-json.)
gcloud iam service-accounts create tb-pipeline \
    --display-name="TB pipeline runtime"
gcloud secrets add-iam-policy-binding anthropic-api-key \
    --member="serviceAccount:tb-pipeline@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
```

### 5. Grant Cloud Build permission to deploy Cloud Run services

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${CB_SA}" \
    --role=roles/run.admin
gcloud projects add-iam-policy-binding "threadbeast-devops" --member="serviceAccount:${CB_SA}" --role=roles/iam.serviceAccountUser
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${CB_SA}" \
    --role=roles/iam.serviceAccountUser
```

---

## Deploy

Run from the repo root. Order matters — the proxy needs the other two URLs.

### Analyzer

```bash
gcloud builds submit --config=cloudbuild/analyzer.yaml .
```

### Pipeline

```bash
gcloud builds submit --config=cloudbuild/pipeline.yaml .
```

### Proxy (after the above have completed)

```bash
ANALYZER_URL=$(gcloud run services describe tb-analyzer \
    --region=us-central1 --format='value(status.url)')
PIPELINE_URL=$(gcloud run services describe tb-pipeline \
    --region=us-central1 --format='value(status.url)')

gcloud builds submit --config=cloudbuild/proxy.yaml \
    --substitutions="_ANALYZER_UPSTREAM=${ANALYZER_URL#https://},_PIPELINE_UPSTREAM=${PIPELINE_URL#https://}" .
```

The public URL is whatever `gcloud run services describe tb-proxy --region=us-central1 --format='value(status.url)'` returns.

---

## Re-deploying a single service

Each config is standalone — rerunning one of the three `gcloud builds submit`
commands redeploys just that service. The proxy does **not** need to be
redeployed when analyzer/pipeline change, because it resolves upstreams lazily
at request time (see `resolver` in `nginx/proxy.conf.template`).

You only need to redeploy the proxy if one of the upstream `*.run.app` URLs
changes — which in practice means deleting and recreating a service.

## Local development

`docker-compose up --build` still works end-to-end with the same images; the
proxy's templated config falls back to the in-network hostnames defined in
`docker-compose.yml`.
