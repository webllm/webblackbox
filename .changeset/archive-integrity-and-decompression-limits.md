---
"@webblackbox/protocol": minor
"@webblackbox/pipeline": minor
"@webblackbox/player-sdk": minor
"@webblackbox/share-server": minor
"@webblackbox/extension": patch
---

Harden archive reading and the share server.

- Encrypted archives now encrypt `integrity/hashes.json`. Readers refuse an encrypted archive whose hash list or any session-content entry is missing from the encryption map, so encrypted archives written by earlier versions can no longer be opened, and earlier readers cannot open encrypted archives written by this version.
- Readers enforce a decompression budget (64 MiB per entry or decoded event chunk, 1 GiB total by default; override with `limits`) and stop inflating an entry as soon as it outgrows its declared size. The exporter refuses to write archives over the same budget, and `maxArchiveBytes` is capped at 1 GiB.
- The pipeline no longer gives overlapping chunk finalizes the same chunk id, which made storage overwrite a chunk and lose its events, and keeps buffered events when encoding a chunk fails.
- The share server rejects unknown `Host` headers with `421` (configure `WEBBLACKBOX_SHARE_ALLOWED_HOSTS`; loopback names are accepted on any port), rejects cross-site uploads and revokes with `403`, takes `X-Forwarded-Proto` into account only when `WEBBLACKBOX_TRUST_X_FORWARDED_FOR` is set, and rejects plaintext or incompletely encrypted uploads before decoding them.
