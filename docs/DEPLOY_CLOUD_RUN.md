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

[`lib/env.ts`](../lib/env.ts) is the source of truth for the full var list, split
into **secrets** (Secret Manager) and **plain config** (`--set-env-vars`). The
helper script [`scripts/deploy/set-staging-env.sh`](../scripts/deploy/set-staging-env.sh)
performs the entire step — run it instead of assembling the commands by hand:

```bash
# Run from the repo root, authenticated as yourself (see `gcloud auth login` above).
bash scripts/deploy/set-staging-env.sh
```

**What it does**, in one idempotent pass: (1) upserts the four secrets
(`PAYPAL_CLIENT_SECRET`, `RESEND_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`,
`DATABASE_URL`) into Secret Manager, (2) grants the Cloud Run runtime service
account `secretmanager.secretAccessor` on each, and (3) updates the service with
`--set-secrets` plus the non-secret `--set-env-vars`.

**Why the script rather than raw `gcloud`:** it reads each value straight from
your local `.env.local` and pipes it into `gcloud` over stdin, so **no secret is
ever printed, pasted into a command, or written to shell history**. Being
idempotent, it's also safe to re-run after any `.env.local` edit.

**When to run it:** immediately after the N3.2 deploy, and any time the service is
missing or has stale env vars. The tell-tale symptom is the service returning
**HTTP 500 on every route** — that means `lib/env.ts` failed its boot-time Zod
validation because a required var is unset. Env vars do **not** carry across GCP
projects, so a newly created project/service always needs this step.

The script is preset for the **staging** target (project `bcc-storefront-staging`,
service `bcc-rentals`, the run.app `SITE_URL`). For a different project — or for
**production** — edit the config block at the top of the script: set `SITE_URL` to
the custom domain and change `PAYPAL_ENV` to `live` in `.env.local` (the script
sources it from there).

Notes:
- `NEXT_PUBLIC_PAYPAL_CLIENT_ID` appears in **both** the build arg (N3.2) and the
  runtime env — the build value is what the browser actually ships; the runtime
  copy just satisfies `lib/env.ts` at boot. Keep them identical, and note the
  browser only picks up a new value on the next `--set-build-env-vars` **rebuild**,
  not from this runtime update.
- Stripe has been removed (Block D / D1) — no `STRIPE_*` vars are needed. PayPal
  handles cards via guest checkout.
- `DATABASE_URL` defaults to Neon's **pooled `main`** endpoint (read from
  `.env.local`). For a staging service that must not touch production data, point
  the `DATABASE_URL` secret at the **dev** branch (`DATABASE_URL_DEV`) instead.

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
