#!/bin/sh
# Deploy = push. Pushes main to GitHub (history) and to your server's bare repo,
# whose post-receive hook (deploy/post-receive.example) checks the code out and
# restarts the server if Python changed.
#
# Server details stay out of git, in local/deploy.env:
#   DEPLOY_REMOTE=server            git remote of the server's bare repo
#   SITE_URL=https://example.com    printed after a deploy
set -e
cd "$(dirname "$0")"
[ -f local/deploy.env ] && . ./local/deploy.env
if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes - commit first:"; git status --short; exit 1
fi
git push -q origin main
git push "${DEPLOY_REMOTE:-server}" main 2>&1 | sed -n 's/^remote: //p'
[ -n "$SITE_URL" ] && echo "live at $SITE_URL"
exit 0
