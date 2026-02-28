# WebBlackbox Share Server

Lightweight cloud-collaboration backend for `.webblackbox` archives.

It provides:

- Upload storage (`POST /api/share/upload`)
- Share URL generation (`/share/:id`)
- Archive retrieval (`GET /api/share/:id/archive`)
- Server-side secondary index + redacted metadata summary (`GET /api/share/:id/meta`)

## Run

```bash
cd apps/share-server
pnpm dev
```

By default the server listens on `http://127.0.0.1:8787`.

## Security knobs

Set these environment variables for production-like deployments:

- `WEBBLACKBOX_SHARE_API_KEY`: API key for `/api/share/*` and `/share/*` routes. If unset, protected routes are limited to loopback clients (`127.0.0.1` / `::1`). When set, clients can authenticate with either:
  - `x-webblackbox-api-key: <key>`, or
  - `authorization: Bearer <key>`, or
  - `?key=<key>` query param
- `WEBBLACKBOX_SHARE_BIND_HOST`: bind host for the HTTP server (default `127.0.0.1`).
- `WEBBLACKBOX_SHARE_ALLOWED_ORIGIN`: CORS allow origin. Defaults to `same-origin`. Use `*` only for trusted environments.
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_MAX`: max uploads per client in each window (default `10`).
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_WINDOW_MS`: upload rate limit window in ms (default `60000`).
- `WEBBLACKBOX_TRUST_X_FORWARDED_FOR`: set `true` only behind a trusted proxy; otherwise upload rate limiting uses socket IP.

## API

### Upload archive

`POST /api/share/upload`

Headers:

- `content-type: application/octet-stream`
- `x-webblackbox-filename: <optional>`
- `x-webblackbox-passphrase: <optional, for encrypted archive analysis>`
- `x-webblackbox-api-key: <optional if WEBBLACKBOX_SHARE_API_KEY is set>`

Body:

- Raw `.webblackbox` bytes

Response:

```json
{
  "shareId": "abc123...",
  "shareUrl": "http://localhost:8787/share/abc123...",
  "fileName": "session.webblackbox",
  "sizeBytes": 123456,
  "summary": {
    "analyzed": true,
    "encrypted": false
  }
}
```

### Metadata and archive

- `GET /api/share/list`
- `GET /api/share/:id/meta`
- `GET /api/share/:id/archive`
- `GET /share/:id`

## Data storage

The server stores data under:

- `WEBBLACKBOX_SHARE_DATA_DIR` env var (if provided), otherwise
- `.webblackbox-share-data/` in the current working directory

Each share writes:

- `archives/<id>.webblackbox`
- `records/<id>.json` (includes redacted summary/index)
