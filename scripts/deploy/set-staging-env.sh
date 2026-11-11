#!/usr/bin/env bash
#
# N3.3 (staging) — wire env vars + Secret Manager secrets onto the Cloud Run
# service `bcc-rentals` in project `bcc-storefront-staging`.
#
# Secrets are read from your local .env.local and piped straight into gcloud —
# no secret value is ever printed. Run this yourself; it never leaves your shell.
#
#   bash scripts/deploy/set-staging-env.sh
#
# Idempotent: secrets are created or a new version is added; the service update
# is declarative. Re-run any time .env.local changes.
set -euo pipefail

PROJECT_ID=bcc-storefront-staging
PROJECT_NUMBER=78017895905
SERVICE=bcc-rentals
REGION=us-east1
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
SITE_URL="https://bcc-rentals-78017895905.us-east1.run.app"
ENV_FILE=".env.local"

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found (run from repo root)"; exit 1; }

# Read a single var's value out of .env.local (handles `export ` prefix and
# surrounding quotes; keeps '=' inside connection strings). Never echoed.
val() {
  grep -E "^(export[[:space:]]+)?$1=" "$ENV_FILE" | tail -n1 \
    | sed -E "s/^(export[[:space:]]+)?$1=//" \
    | sed -E "s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"
}

SECRETS=(PAYPAL_CLIENT_SECRET RESEND_API_KEY UPSTASH_REDIS_REST_TOKEN DATABASE_URL)

echo "==> 1/3 Upserting secrets into Secret Manager"
for s in "${SECRETS[@]}"; do
  v="$(val "$s")"
  if [ -z "$v" ]; then echo "  ERROR: $s missing/empty in $ENV_FILE"; exit 1; fi
  if gcloud secrets describe "$s" --project="$PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "$v" | gcloud secrets versions add "$s" --project="$PROJECT_ID" --data-file=- >/dev/null
    echo "  $s: new version added"
  else
    printf '%s' "$v" | gcloud secrets create "$s" --project="$PROJECT_ID" --data-file=- >/dev/null
    echo "  $s: created"
  fi
done

echo "==> 2/3 Granting the runtime service account secret access"
for s in "${SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT_ID" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor \
    --condition=None >/dev/null
  echo "  $s: accessor granted to $SA"
done

# Non-secret / environment-specific config. Client IDs + Upstash URL + emails are
# not secrets but are env-specific, so they're sourced from .env.local too.
PAYPAL_ENV_VAL="$(val PAYPAL_ENV)";                 [ -z "$PAYPAL_ENV_VAL" ] && PAYPAL_ENV_VAL="sandbox"
PAYPAL_WEBHOOK_VAL="$(val PAYPAL_WEBHOOK_ID)";      [ -z "$PAYPAL_WEBHOOK_VAL" ] && PAYPAL_WEBHOOK_VAL="pending-n3.5"

echo "==> 3/3 Updating the Cloud Run service (secrets + plain config)"
gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --set-secrets "PAYPAL_CLIENT_SECRET=PAYPAL_CLIENT_SECRET:latest,RESEND_API_KEY=RESEND_API_KEY:latest,UPSTASH_REDIS_REST_TOKEN=UPSTASH_REDIS_REST_TOKEN:latest,DATABASE_URL=DATABASE_URL:latest" \
  --set-env-vars "^@@^NODE_ENV=production@@NEXT_PUBLIC_SITE_URL=${SITE_URL}@@PAYPAL_ENV=${PAYPAL_ENV_VAL}@@PAYPAL_CLIENT_ID=$(val PAYPAL_CLIENT_ID)@@PAYPAL_WEBHOOK_ID=${PAYPAL_WEBHOOK_VAL}@@NEXT_PUBLIC_PAYPAL_CLIENT_ID=$(val NEXT_PUBLIC_PAYPAL_CLIENT_ID)@@EMAIL_FROM=$(val EMAIL_FROM)@@STAFF_NOTIFICATION_EMAIL=$(val STAFF_NOTIFICATION_EMAIL)@@UPSTASH_REDIS_REST_URL=$(val UPSTASH_REDIS_REST_URL)"

echo
echo "Done. Verify:  curl -sI ${SITE_URL}/  | head -n1   # expect HTTP/2 200"
