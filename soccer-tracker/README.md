# soccer-tracker (soccer.hminv.com)

Source for the Cloudflare Worker behind **soccer.hminv.com** — a soccer game
tracker (teams, rosters, games, goals/assists, substitutions) backed by a
Cloudflare D1 database, with an offline-capable front end that syncs through
`POST /api/sync`.

Until now this code lived only as the deployed Worker in Cloudflare
(worker name `soccer-tracker`). This folder puts it under version control.

## Provenance

Recovered from the live Cloudflare deployment on 2026-08-28:

- `src/index.js` — the Worker API, extracted from the deployed bundle and
  cleaned of bundler artifacts. Functionally identical to what is running.
- `schema.sql` — exported from the live D1 database (`soccer`,
  id `252f3743-20d9-41e9-b56f-fd332d7c0f7c`) via `sqlite_master`.
- `wrangler.jsonc` — reconstructed: worker name, D1 binding (`DB`), and the
  static assets binding (`ASSETS`) the code uses.

## Front end (`public/`)

Recovered from the live site on 2026-08-29 after allowing soccer.hminv.com
in the session's network policy: `index.html`, `app.js`, `app.css`, `sw.js`
(service worker), `manifest.webmanifest`, and icons. This is the complete
deployed asset set, so the repo now fully reproduces the live worker.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | liveness check |
| `/api/bootstrap` | GET | teams + active players + last 100 games |
| `/api/games?team=&limit=` | GET | list games |
| `/api/games/:id` | GET | one game with its events and roster |
| `/api/sync` | POST | last-write-wins upsert of teams/players/games/events |
| `/api/export.csv?game=` or `?team=` | GET | CSV export of events |

Anything outside `/api/` serves `public/index.html` (SPA shell).

## Deploying

```sh
npx wrangler deploy
```

The D1 database and its data already exist in the Cloudflare account; the
binding in `wrangler.jsonc` points at it. `schema.sql` is for reference /
recreating the database from scratch, not something the deploy runs.

## Notes

- The live D1 database also contains two empty leftover tables
  (`ui_assets`, `ui_assets_original`) not used by the current code.
- A `SOCCER_STATS` KV namespace exists in the account but is not bound by
  the current Worker; likely an earlier iteration of the app.
