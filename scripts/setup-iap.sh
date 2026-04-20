#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Sets up an external HTTPS load balancer with IAP in front of
# the tb-proxy Cloud Run service, which serves the homepage and
# reverse-proxies to tb-analyzer and tb-pipeline.
#
# No custom domain needed — uses a self-signed cert on the LB's
# static IP. Your team accepts the browser cert warning once.
#
# Architecture:
#   Users → Google Login (IAP) → HTTPS LB (static IP) → tb-proxy
#                                                         ├── /          → landing page
#                                                         ├── /analyzer/ → tb-analyzer
#                                                         └── /pipeline/ → tb-pipeline
#
# Prerequisites:
#   - Cloud Run services tb-proxy, tb-analyzer, tb-pipeline deployed
#   - An OAuth client ID + secret created in the GCP console
#     (APIs & Services → Credentials → OAuth 2.0 Client ID, type: Web)
#     Authorized redirect URI:
#       https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect
#   - openssl available on the machine running this script
#
# Usage:
#   export PROJECT_ID=threadbeast-devops
#   export REGION=us-central1
#   export IAP_CLIENT_ID=<your-oauth-client-id>
#   export IAP_CLIENT_SECRET=<your-oauth-client-secret>
#   bash scripts/setup-iap.sh
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

: "${PROJECT_ID:=threadbeast-devops}"
: "${REGION:=us-central1}"
: "${IAP_CLIENT_ID:?Set IAP_CLIENT_ID}"
: "${IAP_CLIENT_SECRET:?Set IAP_CLIENT_SECRET}"
: "${WORKSPACE_DOMAIN:=threadbeast.com}"

gcloud config set project "$PROJECT_ID"

echo "==> Enabling APIs..."
gcloud services enable \
    iap.googleapis.com \
    compute.googleapis.com

# ── Lock down backend Cloud Run services ─────────────────────────
# Removes the allUsers binding so the services require authentication.
# (--no-allow-unauthenticated only works on `gcloud run deploy`, not on update.)
echo "==> Removing public access from backend services..."
for SVC in tb-analyzer tb-pipeline; do
    gcloud run services remove-iam-policy-binding "$SVC" \
        --region="$REGION" \
        --member="allUsers" \
        --role="roles/run.invoker" \
        --quiet 2>/dev/null || echo "  ($SVC: allUsers binding already absent)"
done

# Grant the proxy's runtime SA permission to invoke the backend services.
PROXY_SA=$(gcloud run services describe tb-proxy \
    --region="$REGION" \
    --format='value(spec.template.spec.serviceAccountName)')
echo "  Proxy runtime SA: $PROXY_SA"

for SVC in tb-analyzer tb-pipeline; do
    gcloud run services add-iam-policy-binding "$SVC" \
        --region="$REGION" \
        --member="serviceAccount:${PROXY_SA}" \
        --role=roles/run.invoker \
        --quiet
done

# Helper that tolerates "already exists" but surfaces every other error.
create_if_missing() {
    local desc="$1"
    shift
    local tmp
    tmp=$(mktemp)
    if "$@" >"$tmp" 2>&1; then
        cat "$tmp"
    else
        if grep -qi "already exists" "$tmp"; then
            echo "  ($desc already exists)"
        else
            echo "ERROR while creating $desc:" >&2
            cat "$tmp" >&2
            rm -f "$tmp"
            exit 1
        fi
    fi
    rm -f "$tmp"
}

# ── Serverless NEG for the proxy ─────────────────────────────────
echo "==> Creating serverless NEG for tb-proxy..."
create_if_missing "tb-proxy-neg" \
    gcloud compute network-endpoint-groups create tb-proxy-neg \
        --region="$REGION" \
        --network-endpoint-type=serverless \
        --cloud-run-service=tb-proxy \
        --quiet

# ── Backend service ──────────────────────────────────────────────
echo "==> Creating backend service..."
create_if_missing "tb-proxy-backend" \
    gcloud compute backend-services create tb-proxy-backend \
        --global \
        --load-balancing-scheme=EXTERNAL_MANAGED \
        --quiet

create_if_missing "backend attachment" \
    gcloud compute backend-services add-backend tb-proxy-backend \
        --global \
        --network-endpoint-group=tb-proxy-neg \
        --network-endpoint-group-region="$REGION" \
        --quiet

# ── URL map (all traffic → proxy) ────────────────────────────────
echo "==> Creating URL map..."
create_if_missing "tb-ai-lb" \
    gcloud compute url-maps create tb-ai-lb \
        --default-service=tb-proxy-backend \
        --global \
        --quiet

# ── Static IP ────────────────────────────────────────────────────
echo "==> Reserving static IP..."
create_if_missing "tb-ai-ip" \
    gcloud compute addresses create tb-ai-ip --global --quiet

LB_IP=$(gcloud compute addresses describe tb-ai-ip --global --format='value(address)')
echo "  Static IP: $LB_IP"

# ── Self-signed SSL cert ─────────────────────────────────────────
# No custom domain needed — generate a self-signed cert for the IP.
# Users accept the browser warning once; fine for internal tools.
echo "==> Generating self-signed SSL certificate for $LB_IP..."
CERT_DIR=$(mktemp -d)
openssl req -x509 -nodes -days 3650 \
    -newkey rsa:2048 \
    -keyout "${CERT_DIR}/key.pem" \
    -out "${CERT_DIR}/cert.pem" \
    -subj "/CN=${LB_IP}/O=ThreadBeast/OU=AI Projects" \
    -addext "subjectAltName=IP:${LB_IP}" \
    2>/dev/null

create_if_missing "tb-ai-cert" \
    gcloud compute ssl-certificates create tb-ai-cert \
        --certificate="${CERT_DIR}/cert.pem" \
        --private-key="${CERT_DIR}/key.pem" \
        --global \
        --quiet

rm -rf "$CERT_DIR"

# ── HTTPS proxy + forwarding rule ────────────────────────────────
echo "==> Creating HTTPS proxy and forwarding rule..."
create_if_missing "tb-ai-https-proxy" \
    gcloud compute target-https-proxies create tb-ai-https-proxy \
        --url-map=tb-ai-lb \
        --ssl-certificates=tb-ai-cert \
        --global \
        --quiet

create_if_missing "tb-ai-forwarding" \
    gcloud compute forwarding-rules create tb-ai-forwarding \
        --global \
        --target-https-proxy=tb-ai-https-proxy \
        --address=tb-ai-ip \
        --ports=443 \
        --quiet

# ── Enable IAP ───────────────────────────────────────────────────
echo "==> Enabling IAP on proxy backend service..."
gcloud iap web enable \
    --resource-type=backend-services \
    --service=tb-proxy-backend \
    --oauth2-client-id="$IAP_CLIENT_ID" \
    --oauth2-client-secret="$IAP_CLIENT_SECRET"

# ── Grant Workspace domain access via IAP ────────────────────────
echo "==> Granting IAP access to domain: $WORKSPACE_DOMAIN..."
gcloud iap web add-iam-policy-binding \
    --resource-type=backend-services \
    --service=tb-proxy-backend \
    --member="domain:$WORKSPACE_DOMAIN" \
    --role=roles/iap.httpsResourceAccessor \
    --quiet

# ── Grant IAP service agent → Cloud Run invoker on proxy ─────────
echo "==> Granting IAP service agent Cloud Run invoker role on proxy..."
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
IAP_SA="service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"

gcloud run services add-iam-policy-binding tb-proxy \
    --region="$REGION" \
    --member="serviceAccount:${IAP_SA}" \
    --role=roles/run.invoker \
    --quiet

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  IAP setup complete!"
echo "========================================"
echo ""
echo "  Architecture:"
echo "    Users → Google Login (IAP) → LB → tb-proxy"
echo "                                       ├── /          → landing page"
echo "                                       ├── /analyzer/ → tb-analyzer"
echo "                                       └── /pipeline/ → tb-pipeline"
echo ""
echo "  Access URL: https://$LB_IP"
echo ""
echo "  Your browser will show a certificate warning on first visit"
echo "  (self-signed cert). Click 'Advanced' → 'Proceed' to continue."
echo "  After that, you'll see the Google Workspace login prompt."
echo "  Only @$WORKSPACE_DOMAIN accounts will be granted access."
echo ""
echo "  No DNS setup needed — just bookmark https://$LB_IP"
echo ""
echo "  If you later want a custom domain, replace the self-signed cert:"
echo "    gcloud compute ssl-certificates delete tb-ai-cert --global"
echo "    gcloud compute ssl-certificates create tb-ai-cert \\"
echo "        --domains=ai.threadbeast.com --global"
echo "    # Then point ai.threadbeast.com → $LB_IP in DNS"
echo ""
echo "  Local dev is unchanged: docker-compose up still uses the nginx proxy."
echo ""
