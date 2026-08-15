# Deploy to GitHub, Railway, and Vercel

## Architecture

- `apps/web`: React/Vite frontend deployed to Vercel.
- `apps/api`: Express, Socket.IO, WhatsApp, and AI API deployed to Railway.
- MongoDB Atlas: shared production database.

Do not deploy the API to Vercel. QR WhatsApp sessions require a long-running process and persistent storage.

## 1. Push to GitHub

Before committing, confirm that no environment files or WhatsApp credentials are included:

```bash
git status --short
git check-ignore apps/api/.env apps/web/.env apps/api/data/sessions
```

Create the repository and push it:

```bash
git init
git add .
git commit -m "Prepare WhatsApp agent platform for deployment"
git branch -M main
gh auth login
gh repo create whatsapp-agent-platform --private --source=. --remote=origin --push
```

Change `--private` to `--public` only if you intentionally want the source code public.

## 2. Create MongoDB Atlas

Create a production cluster, database user, and connection string. Configure Network Access for Railway. Use a database name in the URL:

```text
mongodb+srv://USER:PASSWORD@CLUSTER/whatsapp_agent_platform?retryWrites=true&w=majority
```

Do not run the demo seed with default passwords in production. If seed accounts are needed, set strong `SEED_OWNER_PASSWORD` and `SEED_ADMIN_PASSWORD` first, run the seed once, then remove those variables.

## 3. Deploy the API to Railway

1. Create a Railway project from the GitHub repository.
2. Create/select the API service and leave its root directory as `/` so npm workspaces and `railway.json` are available.
3. Generate a public Railway domain.
4. Add the variables below.
5. Set the health check to `/ready` if Railway did not import it from `railway.json`.

Required variables:

```env
NODE_ENV=production
MONGODB_URI=mongodb+srv://...
JWT_SECRET=GENERATE_A_RANDOM_64_HEX_CHARACTER_SECRET
WEB_ORIGIN=https://YOUR-VERCEL-DOMAIN.vercel.app
LOG_LEVEL=info
API_RATE_LIMIT=600
SESSION_DATA_DIR=/data/sessions
META_VERIFY_TOKEN=GENERATE_A_RANDOM_VERIFY_TOKEN
META_APP_SECRET=YOUR_META_APP_SECRET
META_GRAPH_VERSION=v23.0
```

`PORT` is provided by Railway. Do not set `API_PORT` in Railway.

Generate secrets locally:

```bash
openssl rand -hex 32
openssl rand -hex 24
```

AI provider keys can be configured from the Super Admin dashboard. For stronger production security, use a secret manager rather than storing provider keys directly in MongoDB.

### QR WhatsApp sessions

If QR sessions are used, attach one Railway volume to the API service and mount it at `/data`. Keep `SESSION_DATA_DIR=/data/sessions`. Run only one API replica while using the current QR-session implementation.

For multiple replicas or a large commercial deployment, use Meta WhatsApp Cloud API and a shared queue/session architecture.

## 4. Deploy the frontend to Vercel

1. Import the same GitHub repository into Vercel.
2. Set **Root Directory** to `apps/web`.
3. Vercel should detect Vite automatically.
4. Set the environment variable below for Production and Preview as appropriate:

```env
VITE_API_URL=https://YOUR-RAILWAY-API-DOMAIN.up.railway.app
```

5. Deploy the frontend.
6. Copy the final Vercel URL into Railway's `WEB_ORIGIN` variable and redeploy Railway.

The included `apps/web/vercel.json` rewrites client-side routes such as `/chats` and `/admin` to `index.html`.

## 5. Verify production

Check the API:

```bash
curl https://YOUR-RAILWAY-API-DOMAIN.up.railway.app/health
curl https://YOUR-RAILWAY-API-DOMAIN.up.railway.app/ready
```

Then verify:

1. Frontend login.
2. Super Admin login and AI configuration.
3. Customer workspace isolation.
4. WhatsApp connection and inbound message.
5. AI reply and manual reply.
6. Billing usage counters.
7. Product, FAQ, order, and settings operations.

## 6. Production limitations

The current QR/Baileys mode supports one Railway API replica with a persistent volume. Before horizontal scaling, move WhatsApp processing and Socket.IO coordination to shared infrastructure such as Redis and workers, or use Meta WhatsApp Cloud API.
