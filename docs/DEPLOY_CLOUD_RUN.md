# Deploy to GCP Cloud Run

Runbook for [EXECUTION_PLAN.md](./EXECUTION_PLAN.md) Block 3 steps **N3.2–N3.5**.
N3.1 (containerization) is done in-repo: [`Dockerfile`](../Dockerfile), [`.dockerignore`](../.dockerignore),
and `output: 'standalone'` in [`next.config.ts`](../next.config.ts).

The app is a single Next.js 16 container. Cloud Run runs it scale-to-zero
(min-instances 0), so idle cost is ~$0/mo. Neon + Upstash stay in AWS `us-east-1`,
so deploy Cloud Run to a nearby region (`us-east1`).

These `gcloud` commands act on **your** GCP account (plus GoDaddy/PayPal dashboard
steps), so I couldn't run them for you — but you **can** run them from this
devcontainer: `gcloud` is installed here. First authenticate (the container has no
logged-in account by default), then replace `PROJECT_ID` and the placeholder
values. The only non-shell steps are the GoDaddy CNAME entry (N3.4) and the
PayPal webhook creation (N3.5), done in those web dashboards.

```bash
gcloud auth login          # one-time: log in as yourself (opens a browser link)
export PROJECT_ID=your-gcp-project
export REGION=us-east1
export SERVICE=bcc-rentals
gcloud config set project "$PROJECT_ID"
```

---

## N3.2 — Create the Cloud Run service

Cloud Build reads the repo `Dockerfile` when you deploy `--source .`, so local
Docker is **not** required.

```bash
# One-time: enable the APIs
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

# Deploy from source. NEXT_PUBLIC_PAYPAL_CLIENT_ID is inlined into the browser
# bundle AT BUILD TIME (it's read client-side), so it must be a BUILD arg, not a
# runtime env var. --allow-unauthenticated makes the storefront public.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --port 8080 \
  --min-instances 0 \
  --allow-unauthenticated \
  --set-build-env-vars "NEXT_PUBLIC_PAYPAL_CLIENT_ID=YOUR_LIVE_PAYPAL_CLIENT_ID"
```

> The flag is `--set-build-env-vars` (older docs/versions show `--build-env-vars`,
> which current gcloud rejects). If your gcloud version supports neither on
> `run deploy`, instead build first with a substitution and deploy the image:
> `gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/bcc-rentals/app --substitutions _PAYPAL=... ` (with a `cloudbuild.yaml` passing `--build-arg NEXT_PUBLIC_PAYPAL_CLIENT_ID=$_PAYPAL`), then `gcloud run deploy $SERVICE --image ...`.

The first deploy prints the service URL (`https://bcc-rentals-xxxx.a.run.app`).
Use it for the initial smoke test before the custom domain is live.

---

## N3.3 — Env vars & secrets

[`lib/env.ts`](../lib/env.ts) is the source of truth for the full var list. Split
into **secrets** (Secret Manager) and **plain config** (`--set-env-vars`).

```bash
# Create secrets (repeat per secret; --data-file=- reads stdin)
for s in PAYPAL_CLIENT_SECRET RESEND_API_KEY UPSTASH_REDIS_REST_TOKEN DATABASE_URL; do
  printf '%s' "REPLACE_ME" | gcloud secrets create "$s" --data-file=- 2>/dev/null \
    || printf '%s' "REPLACE_ME" | gcloud secrets versions add "$s" --data-file=-
done

# Grant the Cloud Run runtime service account access
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for s in PAYPAL_CLIENT_SECRET RESEND_API_KEY UPSTASH_REDIS_REST_TOKEN DATABASE_URL; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor
done

# Wire secrets + plain config onto the service
gcloud run services update "$SERVICE" --region "$REGION" \
  --set-secrets "PAYPAL_CLIENT_SECRET=PAYPAL_CLIENT_SECRET:latest,\
RESEND_API_KEY=RESEND_API_KEY:latest,\
UPSTASH_REDIS_REST_TOKEN=UPSTASH_REDIS_REST_TOKEN:latest,\
DATABASE_URL=DATABASE_URL:latest" \
  --set-env-vars "NODE_ENV=production,\
NEXT_PUBLIC_SITE_URL=https://rentals.bachmancc.org,\
PAYPAL_ENV=live,\
PAYPAL_CLIENT_ID=YOUR_LIVE_PAYPAL_CLIENT_ID,\
PAYPAL_WEBHOOK_ID=SET_AFTER_N3.5,\
NEXT_PUBLIC_PAYPAL_CLIENT_ID=YOUR_LIVE_PAYPAL_CLIENT_ID,\
EMAIL_FROM=BCC Rentals <rentals@bachmancc.org>,\
STAFF_NOTIFICATION_EMAIL=reservations@bachmancc.org,\
UPSTASH_REDIS_REST_URL=https://your-db.upstash.io"
```

Notes:
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID` appears in **both** the build arg (N3.2) and the
  runtime env — the build value is what the browser actually ships; the runtime
  copy just satisfies `lib/env.ts` at boot. Keep them identical.
- Stripe has been removed (Block D / D1) — no `STRIPE_*` vars are needed. PayPal
  handles cards via guest checkout.
- `DATABASE_URL` must be Neon's **pooled** `main`-branch endpoint.

---

## N3.4 — Custom domain

```bash
# Lower the GoDaddy TTL on the existing record FIRST (e.g. 600s), wait for it to
# propagate, then:
gcloud beta run domain-mappings create \
  --service "$SERVICE" --region "$REGION" \
  --domain rentals.bachmancc.org
```

The command prints the DNS record to add. Create the matching **CNAME** in
GoDaddy (`rentals` → `ghs.googlehosted.com` or the exact target returned). Cloud
Run provisions the TLS cert automatically once DNS resolves (can take
minutes–hours). Verify: `curl -sI https://rentals.bachmancc.org/` → `200`.

---

## N3.5 — PayPal live webhook

1. In the PayPal Developer dashboard (Live), add a webhook for your app:
   URL `https://rentals.bachmancc.org/api/webhooks/paypal`, subscribed to the
   payment/checkout order events the app handles.
2. Copy the generated **Webhook ID** into the `PAYPAL_WEBHOOK_ID` env var:
   ```bash
   gcloud run services update "$SERVICE" --region "$REGION" \
     --update-env-vars "PAYPAL_WEBHOOK_ID=YOUR_WEBHOOK_ID"
   ```
3. Send a test event from the dashboard and confirm it's accepted (the route
   verifies the signature with `PAYPAL_WEBHOOK_ID`).

Then run the Block 5 production smoke tests.
