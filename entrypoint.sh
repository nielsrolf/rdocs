#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (via .env or environment)}"
: "${SESSION_SECRET:?SESSION_SECRET must be set (via .env or environment)}"

npm ci
npx prisma generate
npx prisma db push --skip-generate
npm run build

export PORT=14141
exec npm run start
