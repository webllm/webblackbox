# WebBlackbox Share Server

Lightweight cloud-collaboration backend for `.webblackbox` archives.

It provides:

- Upload storage (`POST /api/share/upload`)
- Share URL generation (`/share/:id`)
- Archive retrieval (`GET /api/share/:id/archive`)
- Redacted public metadata summary (`GET /api/share/:id/meta`)
- Expiry, revocation, and redacted access audit logs

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
- `WEBBLACKBOX_SHARE_API_KEYS`: semicolon-separated scoped keys for rotation and least privilege. Format: `secret:scope,scope;next-secret:scope`. Supported scopes are `upload`, `read`, `list`, `revoke`, and `admin`. `admin` covers all scopes. Keep an old key and a new key configured during rotation, then remove the old key after clients are updated.
- `WEBBLACKBOX_SHARE_BIND_HOST`: bind host for the HTTP server (default `127.0.0.1`).
- `WEBBLACKBOX_SHARE_ALLOWED_ORIGIN`: CORS allow origin. Defaults to `same-origin`. Use `*` only for trusted environments.
- `WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES`: max accepted upload body size in bytes (default `262144000`).
- `WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS`: default `false`. Public deployments should keep this disabled so uploads must be encrypted before reaching the server.
- `WEBBLACKBOX_SHARE_DEFAULT_TTL_MS`: default share lifetime in ms (default `604800000`, seven days).
- `WEBBLACKBOX_SHARE_MAX_TTL_MS`: maximum accepted share lifetime in ms (default `2592000000`, 30 days).
- `WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS`: how long expired share records/files are retained before pruning (default `2592000000`, 30 days).
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_MAX`: max uploads per client in each window (default `10`).
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_WINDOW_MS`: upload rate limit window in ms (default `60000`).
- `WEBBLACKBOX_TRUST_X_FORWARDED_FOR`: set `true` only behind a trusted proxy; otherwise upload rate limiting uses socket IP.

For production, prefer scoped keys over a single admin key:

```bash
WEBBLACKBOX_SHARE_API_KEYS="upload-v2:upload;reader-v2:read;ops-v2:list,revoke"
```

Rotation pattern:

1. Add the new key beside the old key with the same or narrower scopes.
2. Deploy and update clients.
3. Confirm audit logs show the new key path in use without storing raw key material.
4. Remove the old key and redeploy.

## API

### Upload archive

`POST /api/share/upload`

Headers:

- `content-type: application/octet-stream`
- `x-webblackbox-filename: <optional>`
- `x-webblackbox-share-summary: <optional URL-encoded JSON public summary computed client-side>`
- `x-webblackbox-share-ttl-ms: <optional requested TTL, clamped by WEBBLACKBOX_SHARE_MAX_TTL_MS>`
- `x-webblackbox-api-key: <optional if WEBBLACKBOX_SHARE_API_KEY is set>`

Body:

- Raw encrypted `.webblackbox` bytes. Public deployments do not accept plaintext uploads by default.

Response:

```json
{
  "shareId": "abc123...",
  "shareUrl": "http://localhost:8787/share/abc123...",
  "expiresAt": 1770902400000,
  "fileName": "webblackbox-share-abc123.webblackbox",
  "sizeBytes": 123456,
  "summary": {
    "schemaVersion": 1,
    "source": "client",
    "analyzed": true,
    "encrypted": true
  }
}
```

### Metadata and archive

- `GET /api/share/list`
- `GET /api/share/:id/meta`
- `GET /api/share/:id/archive`
- `GET /share/:id`
- `POST /api/share/:id/revoke`

Expired or revoked shares return `410`.

## Data storage

The server stores data under:

- `WEBBLACKBOX_SHARE_DATA_DIR` env var (if provided), otherwise
- `.webblackbox-share-data/` in the current working directory

Each share writes:

- `archives/<id>.webblackbox`
- `records/<id>.json` (redacted public summary only)
- `audit/share-access.jsonl` (action, outcome, share id, timestamp, and client hash only)

Audit logs must not contain archive plaintext, passphrases, API keys, raw URLs, filenames supplied by the client, or request payloads.
