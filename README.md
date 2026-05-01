# PowerArrPlus

PowerArrPlus adds a small seen-result workflow to Prowlarr. It lets you hide
selected search results, persist those hidden release fingerprints, and filter
them out the next time you search.

The project has two parts:

- A lightweight Python HTTP service. SQLite is the default persistent store.
- A Tampermonkey userscript that integrates with the Prowlarr search page.

## Features

- Adds a compact `Seen Filter` toolbar to the Prowlarr search page.
- Uses Prowlarr's native result checkboxes for `隐藏选中` and `隐藏本页`.
- Removes hidden rows from the current page immediately without triggering
  another Prowlarr search request.
- Filters hidden releases on later manual searches.
- Supports `取消本页已隐藏`, which only restores releases hidden from the
  current search response.
- Deduplicates NZB/Usenet results in the current response when `title + size +
  files` match exactly, keeping the row with the highest grab count.
- Stores release fingerprints and metadata only. Prowlarr API keys and download
  links are not stored.

## How It Works

The userscript intercepts Prowlarr search responses from `/api/v1/search`, sends
the release list to the local PowerArrPlus service, and gives Prowlarr back only
the visible releases. Hide and unhide actions call the same local service.

Persistent hiding and current-response deduplication are separate:

- Hidden releases are stored in SQLite and stay hidden across searches.
- Deduplication only affects the current search response and is not written to
  the database.

## Requirements

- Prowlarr
- Tampermonkey or another compatible userscript manager
- Python 3.10+ for local development, or Docker Compose for deployment

Redis is no longer required for normal use. It is still supported as a legacy
store and as a migration source.

## Deploy With Docker Compose

Clone the repository:

```bash
git clone https://github.com/hxz393/PowerArrPlus.git
cd PowerArrPlus
```

Copy the environment template:

```bash
cp .env.example .env
```

Default `.env` values use SQLite under the Compose-mounted `./data` directory:

```env
POWERARR_PLUS_PORT=17896
POWERARR_PLUS_STORE=sqlite
POWERARR_PLUS_DB_PATH=/data/powerarrplus.sqlite3
POWERARR_PLUS_ALLOW_ORIGIN=*
```

Start the service:

```bash
docker compose up -d --build
```

Check health:

```bash
curl -sS http://127.0.0.1:17896/health
```

Expected shape:

```json
{"ok": true, "store": "sqlite", "status": "OK"}
```

Check database status:

```bash
curl -sS http://127.0.0.1:17896/api/stats
```

SQLite stats include `hiddenCount`, `dbPath`, `dbSizeBytes`, `walSizeBytes`,
`totalSizeBytes`, `oldestHiddenAt`, `newestHiddenAt`, `sqliteVersion`,
`journalMode`, `pageSize`, `pageCount`, and `freelistCount`.

If the service runs on another machine, test it from the browser/Prowlarr
machine:

```bash
curl -sS http://<backend-host>:17896/health
```

## Install The Userscript

Install Tampermonkey, create a new script, and paste:

```text
userscripts/prowlarr_seen_filter.user.js
```

You can also install or copy from GitHub raw:

```text
https://raw.githubusercontent.com/hxz393/PowerArrPlus/main/userscripts/prowlarr_seen_filter.user.js
```

The userscript infers the backend service address:

- `http://localhost:9696` or `http://127.0.0.1:9696` uses
  `http://127.0.0.1:17896`
- `http://<host>:9696` uses `http://<host>:17896`

If your Prowlarr URL uses another port or reverse-proxy path, update the
userscript `@match` / `@include` rules.

If PowerArrPlus is on a different host, set the service origin in the browser
console on the Prowlarr page:

```javascript
localStorage.setItem("powerarrPlusServiceOrigin", "http://<backend-host>:17896");
```

Reset to automatic inference:

```javascript
localStorage.removeItem("powerarrPlusServiceOrigin");
```

## Usage

1. Open the Prowlarr search page.
2. Search normally.
3. Tick releases you do not want to see again.
4. Click `隐藏选中`.
5. Search manually next time; hidden releases are filtered out.

Button behavior:

- `隐藏选中`: persistently hides checked releases. If a checked release belongs
  to an exact dedupe group, the matching group members are hidden together.
- `隐藏本页`: persistently hides all currently visible releases.
- `取消本页已隐藏`: restores only releases that were hidden from the current
  search response.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `POWERARR_PLUS_BIND` | `127.0.0.1` | HTTP bind address. Compose sets this to `0.0.0.0`. |
| `POWERARR_PLUS_PORT` | `17896` | HTTP service port. |
| `POWERARR_PLUS_STORE` | `sqlite` | Storage backend: `sqlite` or `redis`. |
| `POWERARR_PLUS_DB_PATH` | `data/powerarrplus.sqlite3` | SQLite database path. Compose uses `/data/powerarrplus.sqlite3`. |
| `POWERARR_PLUS_REDIS_HOST` | `127.0.0.1` | Redis host for legacy Redis mode or migration. |
| `POWERARR_PLUS_REDIS_PORT` | `6379` | Redis port for legacy Redis mode or migration. |
| `POWERARR_PLUS_KEY_PREFIX` | `powerarr_plus:prowlarr_seen_filter` | Redis key prefix for legacy Redis data. |
| `POWERARR_PLUS_ALLOW_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin`. |

## Redis To SQLite Migration

If you used an older Redis-backed version, migrate hidden releases into SQLite
before switching the running service to SQLite.

With Docker Compose:

```bash
docker compose run --rm powerarrplus powerarr-plus-seen-filter \
  --migrate-redis-to-sqlite \
  --redis-host <redis-host> \
  --redis-port 6379 \
  --key-prefix powerarr_plus:prowlarr_seen_filter \
  --db-path /data/powerarrplus.sqlite3
```

Without Docker:

```bash
powerarr-plus-seen-filter \
  --migrate-redis-to-sqlite \
  --redis-host <redis-host> \
  --redis-port 6379 \
  --key-prefix powerarr_plus:prowlarr_seen_filter \
  --db-path data/powerarrplus.sqlite3
```

The command is idempotent. It upserts by fingerprint, so running it again will
not duplicate rows.

To keep using Redis temporarily:

```env
POWERARR_PLUS_STORE=redis
POWERARR_PLUS_REDIS_HOST=<redis-host>
POWERARR_PLUS_REDIS_PORT=6379
```

## SQLite Data

The default table is `hidden_release`. The primary key is the release
fingerprint. Metadata is stored both as queryable columns and as the original
JSON payload for future compatibility.

Release fingerprint priority:

1. `infoHash`
2. `indexerId + guid`
3. `indexerId + releaseHash`
4. `indexerId + infoUrl`, with sensitive query parameters removed
5. `indexerId + normalized(title) + size`

## Deduplication Rule

Deduplication is intentionally strict. A result is considered a duplicate only
when all of these are true:

```text
protocol is NZB/Usenet
title matches exactly after trim, Unicode NFC, and HTML entity decode
size matches exactly
files matches exactly
```

If `files` is missing, the result is not deduplicated. Similar-looking releases
can still be different packages, so approximate matching is deliberately avoided.

## Local Development

Create a virtual environment:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
pip install -e .
```

Run the service with SQLite:

```bash
powerarr-plus-seen-filter --store sqlite --db-path data/powerarrplus.sqlite3
```

Windows PowerShell helper:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-powerarr-plus.ps1
```

### Userscript Development

The Tampermonkey script is built from modular source files under
`src-userscript/`. Edit those files first, then rebuild the single installable
userscript:

```bash
node scripts/build-userscript.js
```

The generated output remains:

```text
userscripts/prowlarr_seen_filter.user.js
```

Tampermonkey should still install that generated file. Do not edit it directly
unless you also copy the same change back into `src-userscript/`.

## Tests

Python unit tests:

```bash
PYTHONPATH=src python -m unittest discover -s tests
```

Windows PowerShell:

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests
```

Userscript syntax check:

```bash
node scripts/build-userscript.js
node --check userscripts/prowlarr_seen_filter.user.js
```

Browser harness smoke tests require the Node.js Playwright package. If it is not
installed in the repository, install it in any external dependency directory and
point `PLAYWRIGHT_MODULE` at it:

```bash
npm install --prefix /path/to/powerarrplus-node-deps --no-save --package-lock=false playwright
PLAYWRIGHT_MODULE=/path/to/powerarrplus-node-deps/node_modules/playwright \
PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright \
npx --prefix /path/to/powerarrplus-node-deps playwright install chromium
```

Then run:

```bash
node tests/browser_harness_smoke.js
```

Real Prowlarr smoke tests may trigger a real search request and consume indexer
quota:

```bash
node tests/real_prowlarr_smoke.js
```

## Security Notes

- Keep PowerArrPlus reachable only from trusted machines or behind your own
  reverse proxy/auth layer.
- `POWERARR_PLUS_ALLOW_ORIGIN=*` is convenient for LAN use, but should be
  tightened if the service is exposed beyond a trusted network.
- If Prowlarr is served over HTTPS, serve PowerArrPlus over HTTPS as well or the
  browser may block mixed-content requests.
- PowerArrPlus does not download NZBs. It only filters Prowlarr search results
  in the browser.
