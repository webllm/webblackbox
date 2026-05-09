# WebBlackbox Security Overview

## Extension Permissions

The store-safe Chrome profile uses `activeTab` and programmatic injection after a user gesture. It does not include `debugger`, persistent `<all_urls>` host permissions, or always-on all-sites content scripts.

The dev/enterprise profile can enable deeper diagnostics, including CDP, but these controls are separated from the store-safe profile and remain governed by capture policy.

## Data Flow

1. Capture adapters sanitize data before it enters the recorder pipeline.
2. The ingest gate rejects or replaces policy-violating artifacts with `privacy.violation` events.
3. Archives include `privacy/manifest.json` with policy, categories, encryption status, and pre-encryption scanner result.
4. Exports and shares recompute policy eligibility instead of trusting imported archive metadata.

## Encryption

Real-user archives require export encryption. Public share uploads require encrypted `.webblackbox` archives and never accept passphrases. Client-side share metadata is limited to an allowlisted public summary.

Plaintext synthetic or local-debug export exemptions require a trusted `captureContextEvidenceRef`, such as `synthetic-fixture:<id>`, `ci-run:<id>`, or `local-attestation:<id>`.

## Player Safety

The player treats archives as untrusted input. It does not load captured external resources by default, limits replay resources to inert local object/data URLs, revokes screenshot object URLs after a short TTL, and serves player/share views with no-referrer and restrictive CSP controls.

## Share Server

The share server supports scoped API keys, upload rate limits, expiry, revocation, redacted metadata, and redacted audit logs. Public deployments should keep plaintext uploads disabled.

## Reporting Security Issues

Report suspected security issues privately to the project maintainers. Do not include captured customer data, passphrases, or raw archive contents in reports.
