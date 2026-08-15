# WhatsApp AI Agent Platform — Node + React + MongoDB

Production-oriented multi-tenant WhatsApp chatbot SaaS starter. This version uses **Node.js/Express + React/Vite + MongoDB/Mongoose** and does **not require Docker, PostgreSQL, or Prisma**.

## Included

- Multi-tenant customer portal and separate superadmin view
- JWT authentication and role checks (SUPERADMIN / OWNER / STAFF)
- Dashboard metrics
- Products, FAQs and orders
- Conversation inbox with live Socket.IO updates
- Manual human replies and human handoff
- WhatsApp QR session linking using Baileys
- Meta WhatsApp Cloud API webhook/send foundation
- OpenAI sales agent with Sinhala/English behavior
- Live product/stock lookup through a custom commerce API
- AI order creation tool
- Business settings, system prompt, welcome sequence, collection fields and notifications data model
- Integrations and document-template data model
- Basic security middleware: Helmet, CORS allow-list and auth rate limiting
- MongoDB Atlas or local MongoDB support

> Important: QR-based WhatsApp Web automation depends on an unofficial WhatsApp Web client library and can be less suitable for a commercial SaaS than Meta's official WhatsApp Business Cloud API. For a public commercial service, use the META session path where possible and follow Meta's platform requirements.

## Requirements

- Node.js 20+ recommended
- npm 10+
- MongoDB 7/8 locally **or** a MongoDB Atlas connection string
- OpenAI API key for AI replies (optional for basic fallback responses)

No Docker is required.

## 1. Install

```bash
cd whatsapp-agent-platform
npm install
```

Or:

```bash
./setup.sh
```

## 2. Configure MongoDB

### Recommended: MongoDB Atlas

Create a free/paid MongoDB Atlas cluster, create a database user, allow your development IP, and copy the connection string.

Example:

```env
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster.example.mongodb.net/whatsapp_agent_platform?retryWrites=true&w=majority
```

### Local MongoDB on macOS

If you already run MongoDB locally:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/whatsapp_agent_platform
```

## 3. Environment files

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Edit `apps/api/.env`:

```env
NODE_ENV=development
API_PORT=5050
MONGODB_URI=mongodb://127.0.0.1:27017/whatsapp_agent_platform
JWT_SECRET=replace-with-a-long-random-secret-at-least-32-characters
WEB_ORIGIN=http://localhost:5173
OPENAI_API_KEY=YOUR_OPENAI_KEY
OPENAI_MODEL=gpt-5-mini
SESSION_DATA_DIR=data/sessions
META_VERIFY_TOKEN=change-me
META_GRAPH_VERSION=v23.0
```

Generate a JWT secret on macOS:

```bash
openssl rand -hex 32
```

The web `.env` normally contains:

```env
VITE_API_URL=http://localhost:5050
```

## 4. Create demo accounts

```bash
npm run db:seed
```

Defaults (change them through environment variables before seeding for a real deployment):

- Customer: `owner@example.com` / `Admin@123456`
- Superadmin: `admin@example.com` / `Admin@123456`

## 5. Start development

```bash
npm run dev
```

Open:

- Web: http://localhost:5173
- API health: http://localhost:5050/health

## WhatsApp QR connection

1. Sign in as a customer owner.
2. Open **Account → WhatsApp**.
3. Create a session.
4. Click **Generate QR Code**.
5. On the business phone open **WhatsApp → Linked Devices → Link a Device**.
6. Scan the QR code.
7. The backend keeps the auth state under `apps/api/data/sessions` by default.

For production QR sessions, deploy the API to a persistent always-on Node host (for example Railway or a VPS) with persistent storage for the session directory. Do not use a stateless serverless function for the QR session worker.

## Meta WhatsApp Cloud API

The backend includes:

- `GET /meta/webhook` verification
- `POST /meta/webhook` inbound messages
- outbound message sending using a configured META WhatsApp session

For production, create a META-mode WhatsApp session record with the phone-number ID, access token and verify token, configure the webhook URL as:

```text
https://YOUR-API-DOMAIN/meta/webhook
```

Keep Meta access tokens secret. A future enhancement should encrypt tenant integration secrets at rest (KMS/Vault) instead of plain MongoDB fields.

## Custom store/API integration

Create an integration with type `custom_api` and a base URL. The agent supports:

```http
GET /products/search?q=charger
Authorization: Bearer YOUR_API_KEY
```

Expected data may be either an array or `{ "products": [...] }` / `{ "items": [...] }`.

Example item:

```json
{
  "name": "UGREEN 20W Charger",
  "sku": "UG-001",
  "price": 4500,
  "stock": 12
}
```

For order creation it calls:

```http
POST /orders
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

If the remote order endpoint fails, the order is still stored locally in MongoDB and the failure is logged.

## Production deployment

### Frontend

Build:

```bash
npm run build
```

Deploy `apps/web` to Vercel or another static/Vite-compatible host. Set:

```env
VITE_API_URL=https://api.yourdomain.com
```

### Backend

Deploy `apps/api` to an always-on Node service such as Railway/VPS. Configure at least:

```env
NODE_ENV=production
MONGODB_URI=your-mongodb-atlas-uri
JWT_SECRET=strong-random-secret
WEB_ORIGIN=https://app.yourdomain.com
OPENAI_API_KEY=...
```

For QR linking, attach persistent storage and set `SESSION_DATA_DIR` to that mounted path.

## Security before public launch

This project contains production-oriented foundations, but a real SaaS launch should additionally implement: encrypted tenant secrets, password reset/email verification, MFA for superadmins, audit logs, stricter request schemas, CSRF strategy if moving auth to cookies, per-tenant usage enforcement, webhook signature verification, backups, monitoring/error reporting, Redis/job queues for high message volume, malware scanning for uploaded documents, payment-provider webhooks and subscription enforcement.

## Useful commands

```bash
npm run dev       # API + React dev servers
npm run build     # production frontend build
npm run check     # API syntax checks + frontend build
npm run db:seed   # seed demo customer and superadmin
npm start         # API only
```

## Project structure

```text
apps/
  api/
    src/
      models.js
      server.js
      seed.js
    data/sessions/
    .env.example
  web/
    src/
      main.jsx
      styles.css
    .env.example
```
