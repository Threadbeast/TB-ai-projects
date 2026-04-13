# GitHub Actions → Cloud Run

Three workflows, one per service. Each one runs `gcloud builds submit` against
the matching `cloudbuild/*.yaml`, so the actual build/push/deploy logic lives in
Cloud Build — GitHub Actions is just the trigger.

| Workflow | Triggers when you change |
|---|---|
| `deploy-analyzer.yml` | `projects/hate-it-rate-analyzer/**` |
| `deploy-pipeline.yml` | `projects/pipeline/**` |
| `deploy-proxy.yml`    | `nginx/**` |

All three also support manual runs from the Actions tab (`workflow_dispatch`).

The proxy workflow additionally resolves the analyzer + pipeline `*.run.app`
URLs at run time so the nginx config always points at the current backends.

---

## One-time setup (Workload Identity Federation)

GitHub Actions authenticates to GCP without a long-lived key by exchanging a
short-lived GitHub OIDC token for GCP credentials. This is a one-time setup.

Replace placeholders below. `YOUR_GITHUB_ORG/YOUR_REPO` is e.g. `threadbeast/TB-ai-projects`.

### 1. Do the Cloud Build setup first

Follow `cloudbuild/README.md` all the way through (enable APIs, create the
Artifact Registry repo, upload secrets to Secret Manager, create the
`tb-analyzer` / `tb-pipeline` runtime service accounts, grant Cloud Build its
roles).

### 2. Create a deployer service account

This is the identity GitHub Actions impersonates.

```bash
gcloud iam service-accounts create tb-gh-deployer \
    --display-name="GitHub Actions deployer"

DEPLOYER="tb-gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

# Needed to submit Cloud Build jobs and read their output
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER}" --role=roles/cloudbuild.builds.editor

# Needed because Cloud Build uploads the source tarball to a GCS bucket
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER}" --role=roles/storage.admin

# Needed so the proxy workflow can read the analyzer/pipeline .run.app URLs
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER}" --role=roles/run.viewer

# Needed so gcloud can act as the Cloud Build service account
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding \
    "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
    --member="serviceAccount:${DEPLOYER}" \
    --role=roles/iam.serviceAccountUser
```

### 3. Create the Workload Identity Pool + Provider

```bash
gcloud iam workload-identity-pools create "github-pool" \
    --location="global" \
    --display-name="GitHub Actions pool"

gcloud iam workload-identity-pools providers create-oidc "github-provider" \
    --location="global" \
    --workload-identity-pool="github-pool" \
    --display-name="GitHub provider" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner == 'YOUR_GITHUB_ORG'" \
    --issuer-uri="https://token.actions.githubusercontent.com"
```

### 4. Allow the GitHub repo to impersonate the deployer SA

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding \
    "tb-gh-deployer@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/YOUR_GITHUB_ORG/YOUR_REPO"
```

### 5. Get the provider resource name

```bash
gcloud iam workload-identity-pools providers describe "github-provider" \
    --location=global --workload-identity-pool="github-pool" \
    --format='value(name)'
# → projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider
```

### 6. Set GitHub repository variables

In GitHub: **Settings → Secrets and variables → Actions → Variables tab**.
These are *variables*, not *secrets* — none of them are sensitive on their own.

| Name | Value |
|---|---|
| `GCP_PROJECT_ID` | your project ID |
| `GCP_REGION` | e.g. `us-central1` |
| `GCP_WIF_PROVIDER` | full provider resource name from step 5 |
| `GCP_DEPLOYER_SA` | `tb-gh-deployer@PROJECT_ID.iam.gserviceaccount.com` |

That's it — pushing to `main` (or clicking **Run workflow** in the Actions tab)
will deploy.

---

## Deploy order for a fresh environment

`push to main` only deploys the service whose files changed. When spinning up
an entirely new GCP project, trigger the workflows manually in order:

1. **Run workflow** on `deploy-analyzer.yml`
2. **Run workflow** on `deploy-pipeline.yml`
3. **Run workflow** on `deploy-proxy.yml` (reads the URLs from the two above)

After that, ongoing pushes deploy whichever service changed. The proxy only
needs re-running if an upstream service is ever deleted and recreated under a
new `*.run.app` URL.
