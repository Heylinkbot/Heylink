#!/usr/bin/env bash
set -e
[ -f apps/api/.env ] || cp apps/api/.env.example apps/api/.env
[ -f apps/web/.env ] || cp apps/web/.env.example apps/web/.env
npm install
echo "Setup complete. Edit apps/api/.env and set MONGODB_URI + JWT_SECRET, then run: npm run db:seed && npm run dev"
