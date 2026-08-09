# The Drawer — write.hminv.com

A place to write things down. React SPA served by a Cloudflare Worker, with snippets
and tags stored in D1.

```
index.html, src/   the app (Vite + React + Tailwind)
worker/index.js    the Worker: serves the built SPA, plus a JSON API under /api
schema.sql         D1 tables
wrangler.jsonc     Worker config — assets, D1 binding, custom domain
```

## Deploying to Cloudflare

Run these from this directory (`write-app/`), signed in to the Cloudflare account
that holds the `hminv.com` zone.

```bash
npm install
npx wrangler login              # or export CLOUDFLARE_API_TOKEN=...
```

**1. Create the database** and copy the returned id into `wrangler.jsonc`
(`d1_databases[0].database_id`, replacing `REPLACE_WITH_D1_DATABASE_ID`):

```bash
npx wrangler d1 create drawer
```

**2. Create the tables:**

```bash
npx wrangler d1 execute drawer --remote --file=schema.sql
```

**3. Set the two secrets.** `APP_PASSWORD` is the passphrase that opens the app;
`SESSION_SECRET` signs the session cookie and should be a long random string
(`openssl rand -base64 32`):

```bash
npx wrangler secret put APP_PASSWORD
npx wrangler secret put SESSION_SECRET
```

**4. Build and deploy:**

```bash
npm run deploy
```

The `routes` entry in `wrangler.jsonc` claims `write.hminv.com` as a custom domain.
Cloudflare creates the DNS record automatically on deploy, as long as `hminv.com` is
a zone in the same account. Certificates take a minute or two to issue.

## Working on it locally

```bash
cp .dev.vars.example .dev.vars          # then edit the values
npx wrangler d1 execute drawer --local --file=schema.sql
npx wrangler dev                        # http://localhost:8787
```

`wrangler dev` serves the built `dist/`, so run `npm run build` after changing the
frontend. `npm run dev` gives you Vite's hot reload, but the `/api` calls it makes
have no Worker behind them — use `wrangler dev` to exercise the whole thing.

## The API

Every route except `/api/session` and `/api/login` requires the session cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/session` | Is this browser signed in? |
| `POST` | `/api/login` | `{ password }` → sets a 30-day signed cookie |
| `POST` | `/api/logout` | Clears the cookie |
| `GET` | `/api/state` | All snippets and known tags |
| `POST` | `/api/snippets` | `{ body, tags }` → the created snippet |
| `PUT` | `/api/snippets/:id` | `{ body, tags }` |
| `DELETE` | `/api/snippets/:id` | |
| `POST` | `/api/snippets/bulk` | `{ snippets: [{ body, tags, createdAt }] }` — CSV import |
| `POST` | `/api/tags` | `{ name }` — registers a tag with no snippet yet |

## A note on the passphrase

A single shared passphrase is the whole access model: anyone who knows it can read and
write everything. That is proportionate for a private notebook, but if this ever holds
something you'd be unhappy to see leaked, put Cloudflare Access in front of the
Worker instead — it gives you real identity, per-person revocation, and an audit log.
