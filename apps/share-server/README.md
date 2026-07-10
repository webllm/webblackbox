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
WEBBLACKBOX_SHARE_API_KEYS="local-dev:admin" pnpm dev
```

By default the server listens on `http://127.0.0.1:8787`.

## Security knobs

Set these environment variables for production-like deployments:

- `WEBBLACKBOX_SHARE_API_KEY`: legacy single admin API key for `/api/share/*` and `/share/*` routes. Protected routes require a configured credential by default, including for direct loopback clients. Clients can authenticate with either:
  - `x-webblackbox-api-key: <key>`, or
  - `authorization: Bearer <key>`
- `WEBBLACKBOX_SHARE_API_KEYS`: semicolon-separated scoped keys for rotation and least privilege. Format: `secret:scope,scope;next-secret:scope`. Supported scopes are `upload`, `read`, `list`, `revoke`, and `admin`. `admin` covers all scopes. Unknown or empty scopes and duplicate secrets fail startup instead of falling back to `admin`. A key without `:scope` retains the legacy explicit-admin behavior. Keep an old key and a new key configured during rotation, then remove the old key after clients are updated.
- `WEBBLACKBOX_SHARE_ALLOW_UNAUTHENTICATED_LOOPBACK`: development-only opt-out, default `false`. When explicitly enabled, protected routes may be used without a credential only when the actual socket peer, bind host, and public origin are loopback. Startup fails if proxy/forwarded-client configuration is present or either endpoint is non-loopback. Never enable this behind a reverse proxy; use scoped credentials instead.
- `WEBBLACKBOX_SHARE_ALLOW_QUERY_API_KEY`: optional browser bootstrap for `GET /share/:id?key=<key>`. Keep this disabled in production unless the key is short-lived; when enabled, the server redirects to a clean URL and uses a short HttpOnly read-session cookie for page links.
- `WEBBLACKBOX_SHARE_BIND_HOST`: bind host for the HTTP server (default `127.0.0.1`).
- `WEBBLACKBOX_SHARE_PUBLIC_ORIGIN`: canonical external origin used for share URLs, same-origin CORS, and secure-cookie policy. It is required when binding to a non-loopback host, must be HTTPS unless it names a loopback host, and must not include credentials, a path, query, or fragment. A non-loopback public origin also requires an API credential, including when a local reverse proxy fronts a loopback bind. Request `Host` and `X-Forwarded-Proto` headers are never used as public-origin authority.
- `WEBBLACKBOX_SHARE_ALLOWED_ORIGIN`: CORS allow origin. Defaults to `same-origin`. Use `*` only for trusted environments.
- `WEBBLACKBOX_SHARE_MAX_UPLOAD_BYTES`: max accepted upload body size in bytes (default `262144000`, hard-capped by the Player SDK's 256 MiB input ceiling).
- `WEBBLACKBOX_SHARE_MAX_CONCURRENT_INSPECTIONS`: maximum upload bodies that may be received and inspected concurrently (default `1`). Additional uploads receive `503` with `Retry-After`.
- `WEBBLACKBOX_SHARE_UPLOAD_IDLE_TIMEOUT_MS`: maximum idle time while receiving an upload body (default `15000`).
- `WEBBLACKBOX_SHARE_UPLOAD_TOTAL_TIMEOUT_MS`: maximum total upload-body receive time (default `120000`).
- `WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS`: default `false`. Public deployments should keep this disabled so uploads must be encrypted before reaching the server.
- `WEBBLACKBOX_SHARE_DEFAULT_TTL_MS`: default share lifetime in ms (default `604800000`, seven days; minimum `1000`).
- `WEBBLACKBOX_SHARE_MAX_TTL_MS`: maximum accepted share lifetime in ms (default `2592000000`, 30 days; minimum `1000`). It must be greater than or equal to the default TTL.
- `WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS`: how long expired share records/files are retained before pruning (default `2592000000`, 30 days). Set it to `0` to prune as soon as a share expires. TTL and retention values must be safe integers whose combined timestamp remains representable; invalid startup configuration is rejected.
- `WEBBLACKBOX_SHARE_MAX_RECORDS`: upload admission limit for retained record files (default `10000`, with a non-relaxable hard ceiling of `10000`). Uploads fail with `507` before body buffering when capacity remains full after expiry pruning. Lowering this value blocks new uploads at the new limit but does not prevent startup, listing, metadata access, or revocation for existing valid records within the hard ceiling.
- `WEBBLACKBOX_SHARE_MAX_AUDIT_LOG_BYTES`: rotate the serialized audit log at this byte size (default `16777216`, hard ceiling `67108864`). One previous segment is retained.
- `WEBBLACKBOX_SHARE_SHUTDOWN_TIMEOUT_MS`: maximum time to drain in-flight requests and queued audit events after `SIGINT` or `SIGTERM` (default `10000`, hard ceiling `60000`). A timeout forces remaining connections closed and terminates the process.
- `WEBBLACKBOX_SHARE_MAX_AUDIT_QUEUE_ENTRIES`: maximum in-process audit appends, including the active append (default `128`, hard ceiling `1024`). Events above this capacity are dropped with a rate-limited operational warning instead of extending the request backlog.
- `WEBBLACKBOX_SHARE_AUDIT_QUEUE_TIMEOUT_MS`: maximum time an admitted audit event may wait to start (default `1000`, hard ceiling `30000`). Stale events are dropped rather than written out of order long after their request.
- `WEBBLACKBOX_SHARE_AUDIT_WRITE_TIMEOUT_MS`: maximum time a request waits for one audit append (default `2000`, hard ceiling `30000`). Timing out degrades audit logging but does not change an already committed Share operation into an HTTP failure.
- `WEBBLACKBOX_SHARE_AUDIT_RETRY_COOLDOWN_MS`: delay before one recovery probe is allowed after an audit append error or timeout (default `5000`, hard ceiling `300000`). No probe is attempted while the timed-out filesystem operation remains unsettled, preventing repeated hung writes from accumulating.
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_MAX`: max uploads per client in each window (default `10`).
- `WEBBLACKBOX_UPLOAD_RATE_LIMIT_WINDOW_MS`: upload rate limit window in ms (default `60000`).
- `WEBBLACKBOX_TRUST_X_FORWARDED_FOR`: enables proxy-aware client addresses for rate limiting and redacted audit hashes only; authorization never trusts forwarded headers. Forwarded chains are used only when the socket peer is explicitly listed in `WEBBLACKBOX_TRUSTED_PROXY_IPS`, and the first untrusted hop is selected from right to left.
- `WEBBLACKBOX_TRUSTED_PROXY_IPS`: comma-separated exact proxy IPs allowed to extend the trusted forwarded chain. The edge proxy must append or overwrite `X-Forwarded-For`; invalid IP configuration fails startup. Loopback proxies are not trusted implicitly: list `127.0.0.1` or `::1` explicitly when the proxy connects from that address.

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
- `x-webblackbox-share-summary: <optional URL-encoded schema-v2 public claim computed client-side>`
- `x-webblackbox-share-ttl-ms: <optional requested TTL, clamped by WEBBLACKBOX_SHARE_MAX_TTL_MS>`
- `x-webblackbox-api-key: <required scoped credential unless using an authorized read-session cookie or the explicit loopback development opt-out>`

Body:

- Raw encrypted `.webblackbox` bytes. Public deployments do not accept plaintext uploads by default.
- Outer ZIP entry count, actual per-entry inflater output, metadata bytes, total expanded bytes, compression ratio, manifest shape, encryption map coverage, and obvious plaintext private files are checked against non-relaxable safety ceilings before the upload is retained. Plaintext uploads that opt into server analysis additionally receive Player event-codec, event-count, and index-cardinality checks.
- Encrypted uploads must include encryption metadata for every private archive path: `events/*`, `blobs/*`, `index/time.json`, `index/req.json`, `index/inv.json`, and `privacy/manifest.json` when present. The server scans the full bounded contents of those entries for recognizable plaintext formats. This is a rejection heuristic, not cryptographic proof that opaque bytes are ciphertext. Legacy encrypted archives that left private indexes in plaintext must be re-exported with the current exporter before public share upload.

When the optional client claim is sent, it must use `schemaVersion: 2`, include the SHA-256 of the exact archive bytes in `archiveSha256`, and agree with server-inspected outer manifest facts. A digest mismatch, a conflicting encryption/manifest claim, or any legacy `x-webblackbox-encryption`, `x-webblackbox-policy-eligible`, or `x-webblackbox-redaction-summary` header is rejected. The digest prevents a summary for one archive from being attached to another; it does **not** authenticate the uploader or prove that the claimed pre-encryption scan ran honestly.

The server never receives the passphrase, so it cannot inspect encrypted private content. Bound client fields are isolated under `clientClaim` and returned as `source: "client-unverified"`, `analyzed: false`, with `trust.privateContent: "client-claim-unverified"`; verified server analysis uses the top-level `privacy` field instead. A missing client claim is accepted only as an encrypted envelope and is returned as `source: "unavailable"`. Neither encrypted state is privacy attestation. Legacy stored client summaries are downgraded to the same unverified shape without claiming a digest match. Deployments that require attestation must add a trusted signer or remote pre-encryption scanner and verify its signature outside this protocol.

Response:

```json
{
  "shareId": "abc123...",
  "shareUrl": "http://localhost:8787/share/abc123...",
  "expiresAt": 1770902400000,
  "fileName": "webblackbox-share-abc123.webblackbox",
  "sizeBytes": 123456,
  "summary": {
    "schemaVersion": 2,
    "source": "client-unverified",
    "analyzed": false,
    "encrypted": true,
    "trust": {
      "archiveEnvelope": "server-inspected",
      "privateContent": "client-claim-unverified",
      "archiveDigestMatched": true
    },
    "clientClaim": {
      "privacy": {
        "scanner": {
          "preEncryption": true,
          "status": "passed",
          "findingCount": 0
        }
      }
    }
  }
}
```

### Metadata and archive

- `GET /api/share/list?offset=0&limit=100` (strict offset pagination; maximum page size `200`, with `total` and `nextOffset` in the response)
- `GET /api/share/:id/meta`
- `GET /api/share/:id/archive`
- `GET /share/:id`
- `POST /api/share/:id/revoke`

Expired or revoked shares return `410`.
Archive downloads are streamed from disk and the stream is cancelled when the client disconnects.

## Data storage

The server stores data under:

- `WEBBLACKBOX_SHARE_DATA_DIR` env var (if provided), otherwise
- `.webblackbox-share-data/` in the current working directory

Each share writes:

- `archives/<id>.webblackbox`
- `records/<id>.json` (redacted public summary only)
- `audit/share-access.jsonl` (action, outcome, share id, timestamp, and client hash only)

New storage directories are mode `0700`. Uploads are streamed to mode-`0600` temporary files under `archives/`, synced, removed on every rejection or disconnect, and atomically renamed only after validation succeeds. Record JSON is likewise written through a synced mode-`0600` temporary file and atomic rename. At startup the server removes interrupted temporary files, orphan archives, orphan records, and corrupt record/archive pairs before serving requests.

Audit logs cover successful, blocked, unavailable, and internal-error outcomes for recognized Share routes, including authorization, upload rate/capacity, client-claim, pagination, expiry, and revocation decisions. Writes are serialized through a capacity- and time-bounded queue and rotate into one bounded previous segment. Logs must not contain archive plaintext, passphrases, API keys, raw URLs, filenames supplied by the client, or request payloads.
Audit queue overflow, expiry, append timeout, and append errors are reported through rate-limited operational warnings. A failed or timed-out sink opens a circuit: queued events are dropped, and after the retry cooldown one recovery probe is admitted only after the physical append has settled. These audit degradations do not turn an already committed upload, revoke, metadata response, page response, or download into a failed HTTP operation.
