# WebBlackbox Enterprise Administration

## Managed Extension Policy

Enterprise deployments can provide a managed policy object through `chrome.storage.managed` under `enterprisePolicy`.

```json
{
  "enterprisePolicy": {
    "siteAllowlist": ["https://app.example.com", "*.trusted.example"],
    "siteDenylist": ["https://admin.example.com"],
    "dataCategoryCaps": {
      "screenshots": "off",
      "network": "metadata",
      "storage": "counts-only",
      "cdp": "off"
    },
    "disableLabMode": true,
    "retention": {
      "localTtlMs": 86400000,
      "shareTtlMs": 604800000
    }
  }
}
```

`siteDenylist` wins over `siteAllowlist`. If `siteAllowlist` is non-empty, recording is denied outside the allowlist. `disableLabMode` forces lab-only categories such as full CDP and heap profiles off.

## Self-Hosted Share Server

Recommended production settings:

```bash
WEBBLACKBOX_SHARE_BIND_HOST=127.0.0.1
WEBBLACKBOX_SHARE_ALLOWED_ORIGIN=https://player.example.com
WEBBLACKBOX_SHARE_API_KEYS="upload-v2:upload;reader-v2:read;ops-v2:list,revoke"
WEBBLACKBOX_SHARE_ALLOW_PLAINTEXT_UPLOADS=false
WEBBLACKBOX_SHARE_DEFAULT_TTL_MS=604800000
WEBBLACKBOX_SHARE_MAX_TTL_MS=2592000000
WEBBLACKBOX_SHARE_RETAIN_EXPIRED_MS=2592000000
```

Rotate share API keys by deploying old and new scoped keys together, moving clients to the new key, confirming audit activity, then removing the old key.

## Audit Logs

Local export audit events are stored under `webblackbox.audit.exports` in extension local storage. Share access audit events are written to `audit/share-access.jsonl` under the share data directory.

Audit entries are redacted and must not contain raw URLs, payloads, selectors, passphrases, API keys, or archive plaintext.

## Retention And Deletion

Use managed extension `retention` caps for local sessions and share server TTL settings for shared archives. Revocation blocks share access immediately. Expired archives are pruned after the configured expired-retention window.
