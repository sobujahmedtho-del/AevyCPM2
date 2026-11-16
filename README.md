# AevyCPM

An open, no-account script library. Anyone can publish Lua, JS, TXT, ZIP and other code files; an admin reviews them before they go public.

- **Frontend:** HTML, CSS and vanilla JavaScript on Cloudflare Pages (no build step)
- **API:** one Cloudflare Worker (`worker/index.js`)
- **Database:** Cloudflare D1 (`schema.sql`)
- **Files:** a private Cloudflare R2 bucket, only reachable through the Worker
- Runs on the Cloudflare **free plan**

```
aevycpm/
├── frontend/            Cloudflare Pages site
│   ├── index.html
│   ├── css/style.css    light + dark theme
│   ├── js/app.js        router, browse, detail, publish, admin
│   ├── js/config.js     API URL and optional Turnstile key (public)
│   ├── js/theme.js
│   ├── _headers         security headers + CSP
│   └── _redirects       SPA fallback
├── worker/index.js      API
├── schema.sql           D1 schema + seed categories
├── wrangler.toml        Worker, D1 and R2 bindings
└── package.json
```

## Deploy

You need a free Cloudflare account, Node.js 18+ and a GitHub account (optional).

```bash
npm install
npx wrangler login
```

**1. Create the database and bucket**

```bash
npx wrangler d1 create aevycpm          # copy the printed database_id into wrangler.toml
npx wrangler r2 bucket create aevycpm-files
npm run db:remote                       # applies schema.sql
```

Leave the R2 bucket private (do not enable a public URL or custom domain on it).

**2. Set secrets** (stored by Cloudflare, never in the repo)

```bash
npx wrangler secret put ADMIN_PASSWORD   # a long passphrase
npx wrangler secret put SESSION_SECRET   # e.g. output of: openssl rand -hex 32
```

**3. Deploy the API**

```bash
npm run deploy:api
```

Choose one way to connect the frontend to it:

- **Same domain (recommended, no CORS).** Put your domain on Cloudflare, uncomment `routes` in `wrangler.toml`
  (`example.com/api/*`), redeploy, and leave `API_BASE` as `/api` in `frontend/js/config.js`.
- **workers.dev URL.** Set `API_BASE` in `frontend/js/config.js` to
  `https://aevycpm-api.<subdomain>.workers.dev/api` and set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages URL
  (comma separate several). Redeploy the Worker. `_headers` already allows `*.workers.dev` in `connect-src`.

**4. Deploy the frontend**

```bash
npm run deploy:web
```

Or connect the GitHub repo in **Workers & Pages > Create > Pages > Connect to Git** with build command empty and
output directory `frontend`.

**5. Use it.** Open `/admin`, sign in with `ADMIN_PASSWORD`, and review the first submissions.

### Local development

```bash
cp .dev.vars.example .dev.vars          # local secrets
npm run db:local
npm run dev:api                         # http://localhost:8787
```

Serve `frontend/` with any static server that falls back to `index.html`, and set `API_BASE` to
`http://localhost:8787/api`. Add that frontend origin to `ALLOWED_ORIGIN` while testing.

### Optional: Turnstile

Create a Turnstile widget, put the **site key** in `config.js` (`TURNSTILE_SITE_KEY`) and run
`npx wrangler secret put TURNSTILE_SECRET`. The upload form then requires the human check.

## Features

**Public:** browse, search (title, description, tags, author), filter by category or tag, sort by newest, most
downloaded or name; script pages with a line-numbered code preview (ZIP files show their file list); copy code;
copy share link; signed downloads with a counter; report a script; light/dark mode.

**Publishing:** no account. Title, description, category, tags, version, author name and one file
(Lua, Luau, JS, TS, TXT, JSON, Python, shell, Markdown and other text formats, or ZIP; 5 MB by default via `MAX_UPLOAD_MB`).
New uploads are pending until approved (switchable to auto-publish in Admin > Settings).

**Admin (`/admin`):** overview with uploads/downloads for 14 days and top scripts, review queue (approve, reject with reason),
all scripts (filter, change category, rename, remove), reports (resolve, dismiss, remove script), categories (add, rename, delete), settings.

## Security

| Area | What is done |
|---|---|
| Upload validation | Extension allowlist, size cap, text files must be valid UTF-8 with no binary bytes, ZIP magic and central directory checked, ZIPs with `.exe/.dll/.msi...`, path traversal (`../`) or more than 50 MB uncompressed are rejected, duplicate files (SHA-256) rejected |
| Spam | Honeypot field, minimum fill time, link limits, per-IP limits (8 uploads/hour, 30/day, 5 reports/hour, 6 login attempts/15 min, 60 downloads/min) stored in D1, optional Turnstile |
| Storage | R2 bucket is private; files are served only by the Worker as `attachment` with `nosniff` and a sandbox CSP, so uploaded code is never rendered or executed |
| Download links | Short-lived (10 min) HMAC-signed URLs; one count per visitor per script per day |
| Admin | Password compared in constant time against a Worker secret; signed 8 hour bearer token kept in `sessionStorage`; every `/api/admin/*` route re-verifies it |
| Privacy | IPs are never stored, only a keyed hash used for rate limits and duplicate reports |
| Secrets | Only `config.js` (public values) ships to the browser. All credentials are Worker secrets |
| Frontend | All user content is escaped; strict CSP (no inline scripts or styles) |

Notes: rate limits depend on `CF-Connecting-IP`, so they work behind Cloudflare. For heavier abuse, add a
Cloudflare WAF rate-limiting rule on `/api/scripts` (POST) in front of the Worker.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/scripts?q&category&tag&sort&page` | Published scripts |
| POST | `/api/scripts` | `multipart/form-data` upload |
| GET | `/api/scripts/:id` | Script details |
| GET | `/api/scripts/:id/preview` | Text (first 200 KB) or ZIP file list |
| POST | `/api/scripts/:id/download-link` | Returns a signed, expiring download URL |
| GET | `/api/scripts/:id/download?e&a&s` | Streams the file from R2 |
| POST | `/api/scripts/:id/report` | `{reason, details}` |
| GET | `/api/categories`, `/api/stats` | Categories with counts, public totals |
| POST | `/api/admin/login` | `{password}` returns a token |
| GET | `/api/admin/stats`, `/scripts`, `/reports` | Admin only |
| PATCH/DELETE | `/api/admin/scripts/:id` | Status, category, title / remove |
| PATCH | `/api/admin/reports/:id` | `open`, `resolved`, `dismissed` |
| POST/PATCH/DELETE | `/api/admin/categories[/:slug]` | Manage categories |
| GET/PUT | `/api/admin/settings` | `auto_approve` |

## Free plan limits

Workers free: 100,000 requests/day. D1 free: 5M row reads and 100k row writes/day. R2 free: 10 GB storage, 1M writes and 10M reads/month.
A browse request costs one Worker call and a few D1 reads; an upload costs one R2 write and a handful of D1 writes.
