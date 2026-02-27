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

By default the server listens on `http://localhost:8787`.

## API

### Upload archive

`POST /api/share/upload`

Headers:

- `content-type: application/octet-stream`
- `x-webblackbox-filename: <optional>`
- `x-webblackbox-passphrase: <optional, for encrypted archive analysis>`

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
