#!/usr/bin/env bash
# Runs once when the devcontainer is created (postCreateCommand).
# Never fails container creation: every step is best-effort.

sudo chown -R node:node /home/node/.claude /home/node/.config/gcloud /home/node/.config/gh

[ -n "$GIT_USER_NAME" ] && git config --global user.name "$GIT_USER_NAME"
[ -n "$GIT_USER_EMAIL" ] && git config --global user.email "$GIT_USER_EMAIL"

# github-workflow Claude Code plugin (skills, agents, PR hook shared with
# bcc-rentals-admin). .claude/settings.json already declares and enables it
# for the project; this pre-installs it at user scope so a fresh container
# (or an empty ~/.claude volume) has it without a /plugin prompt.
# User scope on purpose: --scope project would rewrite the tracked
# .claude/settings.json on every rebuild. Both commands are idempotent.
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add thedavidhanks/github-workflows \
    && claude plugin marketplace update github-workflows \
    && claude plugin install github-workflow@github-workflows \
    || echo "post-create: github-workflow plugin install failed; run it manually (see README)" >&2
fi

true
