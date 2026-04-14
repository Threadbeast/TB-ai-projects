# GitHub Actions → Cloud Run

Three workflows, one per service. Each builds the Docker image directly on the
GitHub runner, pushes to Artifact Registry at
`us-central1-docker.pkg.dev/<project>/tb-ai-projects/<service>`, and deploys to
Cloud Run.

| Workflow | Triggers when you change |
|---|---|
| `deploy-analyzer.yml` | `projects/hate-it-rate-analyzer/**` |
| `deploy-pipeline.yml` | `projects/pipeline/**` |
| `deploy-proxy.yml`    | `nginx/**` |

All three also support manual runs from the Actions tab (`workflow_dispatch`).

The pipeline workflow pulls two build-time secrets (`anthropic-api-key`,
`gcp-sa-json`) from Secret Manager and feeds them into BuildKit via
`--secret=id=...,src=...`, matching the `RUN --mount=type=secret` lines in
`projects/pipeline/Dockerfile`.

The proxy workflow resolves the current analyzer + pipeline `*.run.app` URLs at
deploy time and passes them to the proxy as env vars, so nginx always points at
the latest backends.

Each image is tagged with both `:latest` and `:<short-sha>` (7-char commit SHA).
Cloud Run is deployed from the immutable `:<short-sha>` tag so re-runs don't
accidentally roll back.

---

## One-time setup

### 1. Enable APIs

```bash
gcloud services enable \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    secretmanager.googleapis.com \
    iamcredentials.googleapis.com
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
# Anthropic API key (analyzer + pipeline, at both build and runtime)
printf '%s' 'sk-ant-api03-...' | \
    gcloud secrets create anthropic-api-key --data-file=-

# Service-account JSON with BigQuery read access (pipeline build time only)
gcloud secrets create gcp-sa-json --data-file=./secrets/gcp-sa.json
```

### 4. Create runtime service accounts

These are the identities the Cloud Run services run as.

```bash
gcloud iam service-accounts create tb-analyzer \
    --display-name="TB analyzer runtime"
gcloud secrets add-iam-policy-binding anthropic-api-key \
    --member="serviceAccount:tb-analyzer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor

gcloud iam service-accounts create tb-pipeline \
    --display-name="TB pipeline runtime"
gcloud secrets add-iam-policy-binding anthropic-api-key \
    --member="serviceAccount:tb-pipeline@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
```

### 5. Create the deployer service account

This is the identity GitHub Actions impersonates via Workload Identity
Federation. In this repo we use `ai-projects@threadbeast-devops.iam.gserviceaccount.com`.

```bash
DEPLOYER="ai-projects@${PROJECT_ID}.iam.gserviceaccount.com"

# Push images to Artifact Registry
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER}" --role=roles/artifactregistry.writer

# Deploy and view Cloud Run services
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER}" --role=roles/run.admin

# Read the pipeline's build-time secrets from Secret Manager
for SECRET in anthropic-api-key gcp-sa-json; do
    gcloud secrets add-iam-policy-binding "$SECRET" \
        --member="serviceAccount:${DEPLOYER}" \
        --role=roles/secretmanager.secretAccessor
done

# Needed because `gcloud run deploy --service-account=...` requires the
# deployer to be able to act as the runtime SAs.
for RUNTIME in tb-analyzer tb-pipeline; do
    gcloud iam service-accounts add-iam-policy-binding \
        "${RUNTIME}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --member="serviceAccount:${DEPLOYER}" \
        --role=roles/iam.serviceAccountUser
done
```

### 6. Create the Workload Identity Pool + Provider

```bash
gcloud iam workload-identity-pools create "github-pool" \
    --location="global" \
    --display-name="GitHub Actions pool"

gcloud iam workload-identity-pools providers create-oidc "github-provider" \
    --location="global" \
    --workload-identity-pool="github-pool" \
    --display-name="GitHub provider" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner == 'Threadbeast'" \
    --issuer-uri="https://token.actions.githubusercontent.com"
```

### 7. Allow the GitHub repo to impersonate the deployer SA

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding \
    "ai-projects@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/Threadbeast/TB-ai-projects"
```

### 8. Get the provider resource name

```bash
gcloud iam workload-identity-pools providers describe "github-provider" \
    --location=global --workload-identity-pool="github-pool" \
    --format='value(name)'
# → projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider
```

### 9. Set GitHub repository variables

In GitHub: **Settings → Secrets and variables → Actions → Variables tab**.
These are *variables*, not *secrets* — none are sensitive on their own.

| Name | Value |
|---|---|
| `GCP_PROJECT_ID` | `threadbeast-devops` |
| `GCP_REGION` | `us-central1` |
| `GCP_WIF_PROVIDER` | full provider resource name from step 8 |
| `GCP_DEPLOYER_SA` | `ai-projects@threadbeast-devops.iam.gserviceaccount.com` |

That's it — pushing to `main` (or clicking **Run workflow** in the Actions tab)
will deploy.

---

## Deploy order for a fresh environment

Path filters mean pushes only redeploy the service that changed. For an initial
cold start, trigger the workflows manually in order:

1. **Run workflow** on `deploy-analyzer.yml`
2. **Run workflow** on `deploy-pipeline.yml`
3. **Run workflow** on `deploy-proxy.yml` (reads URLs from the two above)

The proxy resolves upstreams lazily at request time via `resolver` in
`nginx/proxy.conf.template`, so it does **not** need re-deploying every time an
upstream is updated — only if an upstream is deleted and recreated under a new
`*.run.app` URL.

---

## Cloud Build (alternative / legacy)

The `cloudbuild/` directory still contains `analyzer.yaml` / `pipeline.yaml` /
`proxy.yaml` for anyone who prefers `gcloud builds submit`. The GitHub
workflows no longer use them — they build directly on the runner.
