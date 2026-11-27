#!/usr/bin/env bash
#
# N3.3 (staging) — wire env vars + Secret Manager secrets onto the Cloud Run
# service `bcc-rentals` in project `bcc-storefront-staging`.
#
# Secrets are read from your local .env.local and piped straight into gcloud —
# no secret value is ever printed. Run this yourself; it never leaves your shell.
#
#   bash scripts/deploy/set-staging-env.sh            # validate, show, confirm, apply
#   bash scripts/deploy/set-staging-env.sh --check    # validate + show only; no gcloud
#   bash scripts/deploy/set-staging-env.sh --yes      # skip the confirmation prompt
#
# .env.local is parsed the way Next.js reads it (scripts/deploy/lib/dotenv.sh):
# inline `# comments` and quotes are stripped, CRLF is tolerated, and
# `$VAR` / `${VAR}` references are expanded. Before anything is written, every
# value is validated (Issue #26); any problem exits non-zero naming the variable
# (never its value) before step 1/3.
#
# Idempotent: secrets are created or a new version is added; the service update
# is declarative. NOTE: `--set-env-vars` REPLACES the whole plain-config set, so
# a value changed directly on Cloud Run (e.g. PAYPAL_WEBHOOK_ID) is overwritten
# by .env.local — check the printed summary before confirming.
set -euo pipefail

PROJECT_ID=bcc-storefront-staging
PROJECT_NUMBER=78017895905
SERVICE=bcc-rentals
REGION=us-east1
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
SITE_URL="https://bcc-rentals-78017895905.us-east1.run.app"
ENV_FILE="${ENV_FILE:-.env.local}"

CHECK_ONLY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --check | --dry-run) CHECK_ONLY=1 ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found (run from repo root)" >&2; exit 1; }

# shellcheck source=lib/dotenv.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/dotenv.sh"

# Read a single var's value out of .env.local. Never echoed.
val() { dotenv_get "$1" "$ENV_FILE"; }

# Stored in Secret Manager — NEVER printed.
SECRETS=(PAYPAL_CLIENT_SECRET RESEND_API_KEY UPSTASH_REDIS_REST_TOKEN DATABASE_URL)
# Plain config passed to --set-env-vars (non-secret; printed for review).
PLAIN=(PAYPAL_ENV PAYPAL_CLIENT_ID PAYPAL_WEBHOOK_ID NEXT_PUBLIC_PAYPAL_CLIENT_ID EMAIL_FROM STAFF_NOTIFICATION_EMAIL UPSTASH_REDIS_REST_URL)

# ---------------------------------------------------------------------------
# Pre-flight: parse + validate everything before touching gcloud.
# Values are held in CFG_<NAME> shell variables (bash 3.2-safe; no assoc arrays).
# ---------------------------------------------------------------------------
echo "==> Pre-flight: parsing and validating $ENV_FILE"
errors=0
fail() { echo "  ERROR: $*" >&2; errors=$((errors + 1)); }

for name in "${SECRETS[@]}" "${PLAIN[@]}"; do
  if v="$(val "$name")"; then
    printf -v "CFG_$name" '%s' "$v"
  else
    # dotenv.sh already printed the reason (variable names only).
    fail "$name could not be parsed from $ENV_FILE"
    printf -v "CFG_$name" '%s' ""
    continue
  fi
  if [ -z "$v" ]; then
    fail "$name is missing or empty in $ENV_FILE"
    continue
  fi
  # A `$` followed by a name/brace means a reference survived parsing (e.g. a
  # single-quoted '$VAR' or an escaped \$VAR) — almost certainly a mistake.
  case "$v" in
    *'$'[A-Za-z_{]*) fail "$name still contains an unexpanded \$VAR reference after parsing" ;;
  esac
  case "$v" in
    *@@*) fail "$name contains '@@', which is the --set-env-vars delimiter" ;;
  esac
  case "$v" in
    *$'\n'* | *$'\r'*) fail "$name contains a newline or carriage return" ;;
  esac
done

case "$CFG_PAYPAL_ENV" in
  sandbox | live) ;;
  "") ;; # already reported as empty
  *) fail "PAYPAL_ENV must be exactly 'sandbox' or 'live'" ;;
esac
case "$CFG_DATABASE_URL" in
  postgres://* | postgresql://*) ;;
  "") ;;
  *) fail "DATABASE_URL must start with postgres:// or postgresql://" ;;
esac
case "$CFG_RESEND_API_KEY" in
  re_*) ;;
  "") ;;
  *) fail "RESEND_API_KEY must start with re_" ;;
esac
case "$CFG_UPSTASH_REDIS_REST_URL" in
  https://*) ;;
  "") ;;
  *) fail "UPSTASH_REDIS_REST_URL must start with https://" ;;
esac
case "$CFG_PAYPAL_WEBHOOK_ID" in
  pending-*) fail "PAYPAL_WEBHOOK_ID is a placeholder; set the real webhook ID in $ENV_FILE" ;;
esac

if [ "$errors" -gt 0 ]; then
  echo "Aborting: $errors problem(s) in $ENV_FILE. Nothing was written." >&2
  exit 1
fi

echo
echo "Target: service $SERVICE, project $PROJECT_ID, region $REGION"
echo "Plain config to be set (replaces the service's whole env-var set):"
printf '  %-30s %s\n' NODE_ENV production
printf '  %-30s %s\n' NEXT_PUBLIC_SITE_URL "$SITE_URL"
for name in "${PLAIN[@]}"; do
  ref="CFG_$name"
  printf '  %-30s %s\n' "$name" "${!ref}"
done
echo "Secrets (Secret Manager, values not shown):"
for name in "${SECRETS[@]}"; do
  printf '  %-30s %s\n' "$name" "set (new version will be added)"
done
echo

if [ "$CHECK_ONLY" = 1 ]; then
  echo "Check passed (--check): no changes made."
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  if [ -t 0 ]; then
    printf 'Apply these to %s? [y/N] ' "$SERVICE"
    read -r answer
    case "$answer" in
      y | Y | yes | YES) ;;
      *) echo "Aborted: nothing was written."; exit 1 ;;
    esac
  else
    echo "ERROR: not a terminal; re-run with --yes to apply without confirmation." >&2
    exit 1
  fi
fi

echo "==> 1/3 Upserting secrets into Secret Manager"
for s in "${SECRETS[@]}"; do
  ref="CFG_$s"
  if gcloud secrets describe "$s" --project="$PROJECT_ID" >/dev/null 2>&1; then
    printf '%s' "${!ref}" | gcloud secrets versions add "$s" --project="$PROJECT_ID" --data-file=- >/dev/null
    echo "  $s: new version added"
  else
    printf '%s' "${!ref}" | gcloud secrets create "$s" --project="$PROJECT_ID" --data-file=- >/dev/null
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

ENV_VARS="^@@^NODE_ENV=production@@NEXT_PUBLIC_SITE_URL=${SITE_URL}"
for name in "${PLAIN[@]}"; do
  ref="CFG_$name"
  ENV_VARS="${ENV_VARS}@@${name}=${!ref}"
done

echo "==> 3/3 Updating the Cloud Run service (secrets + plain config)"
gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
  --set-secrets "PAYPAL_CLIENT_SECRET=PAYPAL_CLIENT_SECRET:latest,RESEND_API_KEY=RESEND_API_KEY:latest,UPSTASH_REDIS_REST_TOKEN=UPSTASH_REDIS_REST_TOKEN:latest,DATABASE_URL=DATABASE_URL:latest" \
  --set-env-vars "$ENV_VARS"

echo
echo "Done. Verify:  curl -sI ${SITE_URL}/  | head -n1   # expect HTTP/2 200"
