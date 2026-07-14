# syntax=docker/dockerfile:1
# Multi-stage build for GCP Cloud Run. Produces a minimal non-root image that
# runs the Next.js standalone server on port 8080 (Cloud Run's default $PORT).
# See docs/DEPLOY_CLOUD_RUN.md for how this image is built and deployed.

# ---- deps: install production+build deps from the lockfile --------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js standalone output --------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# lib/env.ts Zod-validates process.env at module load and throws on missing
# vars; SKIP_ENV_VALIDATION bypasses it so the build needs no real secrets.
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_PAYPAL_CLIENT_ID is read client-side (BookingWidget) and inlined
# into the browser bundle at build time, so it must be the REAL value here, not
# just a Cloud Run runtime env var. Pass it via --build-arg.
ARG NEXT_PUBLIC_PAYPAL_CLIENT_ID
ENV NEXT_PUBLIC_PAYPAL_CLIENT_ID=${NEXT_PUBLIC_PAYPAL_CLIENT_ID}

RUN npm run build

# ---- runner: minimal non-root runtime ---------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# `node` (uid 1000) already exists in the base image — run unprivileged.
# The standalone output bundles a minimal server.js + traced node_modules.
# .next/static is not part of the standalone trace and must be copied alongside.
# (No public/ directory exists in this repo, so none is copied.)
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 8080

CMD ["node", "server.js"]
