# WebBlackbox Chrome Extension Privacy Commercialization Plan

Last reviewed: 2026-05-09 (manual)
Status: planning document only. No implementation is included here.

## 1. Executive Summary

WebBlackbox is in a high-sensitivity product category: browser session replay, DevTools-style capture, network recording, DOM snapshots, screenshots, console logs, storage inspection, and shareable archives. A commercially usable privacy posture cannot rely on "capture broadly, redact later." The product must be redesigned around privacy-by-default capture, explicit user consent, source-side sanitization, encrypted local-first storage, and zero-trust export/share workflows.

The commercial target should be:

- Default mode captures only metadata needed for debugging, with all text, inputs, screenshots, storage values, request/response bodies, and console object payloads disabled or masked before they leave the page context.
- Full-fidelity capture is a temporary, explicit, high-risk mode for trusted development or enterprise environments only.
- Broad Chrome permissions are minimized or isolated into a separate product/distribution channel.
- Every stored artifact carries a machine-readable privacy provenance record.
- Exports and shares are blocked unless privacy preflight passes.
- Cloud share must be zero-plaintext by default: the server stores encrypted archive bytes and minimal redacted metadata, but does not receive decryption keys or raw sensitive content.

This is not legal advice. The plan translates current browser-extension policy, session replay industry patterns, and the current repository architecture into an engineering roadmap.

## 2. Industry Baseline

Comparable session replay and observability tools have converged on the following practices:

- Sentry Session Replay masks DOM text, images, and user input by default, and treats network request/response bodies and headers as opt-in because the safest way to avoid PII is not collecting it.
  Source: https://docs.sentry.dev/platforms/javascript/session-replay/
- Datadog Session Replay defaults to `mask` when privacy level is not specified; masked data is not collected in original form and is not sent to Datadog.
  Source: https://docs.datadoghq.com/session_replay/browser/privacy_options/
- Fullstory offers Exclude, Mask, and Unmask semantics, with Form Privacy masking form elements including `input`, `textarea`, `select`, and `contenteditable`.
  Source: https://help.fullstory.com/hc/en-us/articles/360020623574-How-do-I-protect-my-users-privacy-in-Fullstory
- LogRocket supports `data-private`, automatic sanitization of text, inputs, and images, and exclusion of request bodies, response bodies, headers, URLs, Redux state, and Redux actions.
  Source: https://docs.logrocket.com/docs/privacy
- OpenPanel disables session replay unless explicitly enabled, and masks all text and inputs by default before content leaves the browser.
  Source: https://openpanel.dev/docs/session-replay
- Microsoft Clarity states masked data is not uploaded and input boxes are masked in all modes; it also documents retention limits.
  Source: https://learn.microsoft.com/en-us/clarity/faq
- Chrome Web Store requires an accurate privacy policy, limited use of user data, narrowest necessary permissions, prominent disclosure/consent where required, and secure handling of collected data.
  Source: https://developer.chrome.com/docs/webstore/program-policies/policies
- Chrome recommends optional permissions where possible and documents `activeTab` as temporary tab access after a user gesture.
  Sources:
  - https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
  - https://developer.chrome.com/docs/extensions/develop/concepts/activeTab

The important pattern is that commercial products do not treat privacy as an export-time filter. They prevent sensitive data from being captured in the first place, and they provide opt-in controls for riskier debugging use cases.

## 3. Threat Model and Trust Boundaries

Commercial privacy work needs an explicit threat model. The product should assume that each boundary can fail independently and that sensitive data must not cross a boundary unless the active policy allows it.

### 3.1 Actors

- End user being recorded.
- User who starts/stops recording.
- Organization or admin that configures capture policy.
- Page JavaScript and third-party scripts running in the recorded page.
- Extension content script and injected page hooks.
- Extension service worker and offscreen document.
- Local browser profile storage, including IndexedDB, chrome storage, object URLs, and temporary export buffers.
- Archive file recipients.
- Player/viewer runtime that opens archives.
- Public share server.
- Self-hosted or enterprise share server.
- Product telemetry, crash reporting, operational logs, and audit logs.
- WebBlackbox operators and support staff.
- Enterprise administrators.
- Attackers who compromise the extension, a share link, the share server, or a viewer machine.

### 3.2 Trust Boundary Rules

- Page context is untrusted. It may contain malicious scripts and sensitive data.
- Content script and injected hooks must sanitize before emitting. They must not rely on downstream redaction for high-risk data.
- Service worker and offscreen document must treat all incoming events as untrusted and enforce policy again.
- Pipeline storage must not receive raw high-risk artifacts in commercial default modes.
- Archive files are portable sensitive containers. Opening an archive must not execute captured scripts or fetch captured third-party resources by default.
- Public share server is not trusted with decryption keys or raw sensitive archive contents by default.
- Enterprise/self-hosted share server may be trusted only under explicit customer-managed policy.
- Product telemetry, crash reporting, operational logs, and audit logs must not receive captured payloads, raw URLs, raw selectors, consent PII, passphrases, or key material.
- Operators must not read user data except under explicit support consent or security/legal exception.

### 3.3 Security Properties to Prove

- In Private mode, fixture secrets do not appear in content-script batches, service-worker ingest, pipeline storage, archives, share uploads, or player-rendered DOM.
- A public share upload cannot expose archive plaintext or decryption keys to the server.
- A viewer opening an archive cannot cause the player to load captured external resources or execute captured scripts by default.
- Policy violations fail closed and produce non-sensitive audit events.
- Consent provenance is recorded for each session so reviewers can distinguish self-recording, support-assisted recording, and enterprise-admin-policy recording.
- Fixture secrets, key material, URL fragments, and selector HMAC keys never enter telemetry, crash, operational log, or audit pipelines.

## 4. Current Repository Risk Inventory

The current extension already has useful privacy primitives, including redaction profiles, optional archive passphrases, player privacy preflight, and share summaries. The issue is that the capture surface is still too broad for a commercial privacy posture.

### 4.1 Broad Permissions and Always-On Injection

Current manifest generation requires:

- `debugger`
- `downloads`
- `offscreen`
- `scripting`
- `storage`
- `tabs`
- `webRequest`
- `<all_urls>` as host permissions
- content script injection on `<all_urls>`, all frames, at `document_start`

Relevant code:

- `apps/extension/scripts/lib/extension-build.mjs`

Risk:

- `debugger` and `<all_urls>` are high-trust capabilities.
- All-frame `document_start` injection creates a privacy and supply-chain blast radius even when capture logic is mostly gated at runtime.
- Chrome Web Store review and enterprise security review will question why broad persistent access is required.

### 4.2 Defaults Capture Too Much

Current defaults include:

- `sampling.bodyCaptureMaxBytes = 262144`
- `DEFAULT_EXPORT_POLICY.includeScreenshots = true`

Relevant code:

- `packages/protocol/src/defaults.ts`

Risk:

- Response bodies and screenshots are among the highest-risk categories.
- These defaults are not aligned with privacy-first session replay products, which mask text/input and keep network bodies opt-in.

### 4.3 Text Input Capture

Current lite capture records text input values up to 256 characters unless the input type is `password`, `email`, `tel`, or `number`.

Relevant code:

- `packages/webblackbox/src/lite-capture-agent.ts`

Risk:

- Normal `text`, `search`, `url`, `textarea`, and many custom form controls can contain names, addresses, API keys, prompts, messages, customer records, medical data, support tickets, or credentials.
- Commercial default should never store raw user-entered text.

### 4.4 Local Storage Sampling

Current lite capture stores `localStorage` keys and a value sample.

Relevant code:

- `packages/webblackbox/src/lite-capture-agent.ts`

Full mode also captures a local storage snapshot through CDP.

Relevant code:

- `apps/extension/src/sw/index.ts`

Risk:

- `localStorage` and `sessionStorage` commonly contain JWTs, refresh tokens, feature flags with user context, PII caches, and app state.
- Even keys can be sensitive in regulated environments, but values and samples are much more dangerous.

### 4.5 CDP Full-Mode Artifacts

Full mode can capture:

- `Network.getResponseBody`
- `Page.captureScreenshot`
- `DOMSnapshot.captureSnapshot`
- `Storage.getCookies`
- local storage snapshots
- performance and advanced profiles

Relevant code:

- `apps/extension/src/sw/index.ts`

Risk:

- Raw DOM snapshots and screenshots can expose everything visible to the user.
- Network bodies can expose API payloads, auth tokens, and personal data.
- Heap/profile artifacts can contain application memory and should be treated as lab-only diagnostics.

### 4.6 Redaction Is Mostly Blocklist-Based

Current redaction relies on configured header names, cookie names, body patterns, selector string checks, and plain SHA-256 hashing.

Relevant code:

- `packages/recorder/src/redaction.ts`
- `apps/extension/src/sw/body-capture-utils.ts`
- `packages/webblackbox/src/lite-materializer.ts`

Risk:

- Blocklists miss unknown secrets.
- Plain SHA-256 is vulnerable to dictionary attacks for low-entropy values.
- Body redaction treats text as text, not structured JSON/form/multipart/URL data.
- Base64/binary payloads are not structurally redacted.
- Selector matching is not a complete DOM privacy model.

### 4.7 Console Capture Can Leak Secrets

Injected hooks serialize console arguments and DOM element text.

Relevant code:

- `packages/webblackbox/src/injected-hooks.ts`

Risk:

- Console logs often contain user objects, API payloads, tokens, email addresses, payment errors, and AI prompts.
- Errors and stack traces can contain query strings and identifiers.

### 4.8 Share Server Receives Sensitive Material

The share server builds summaries and sensitive previews. It also supports passphrase-based analysis of encrypted archives through a request header.

Relevant code:

- `apps/share-server/src/index.ts`

Risk:

- A commercial cloud service should not receive archive passphrases by default.
- Privacy summaries should be computed client-side or in a customer-controlled deployment unless the user explicitly chooses a trusted hosted analysis mode.

### 4.9 Player and Replay Can Leak Data

Archive playback is also a privacy boundary. A replay player that renders captured DOM, CSS, images, fonts, links, iframes, or source URLs can leak information even after capture is complete.

Risk:

- Opening an archive may trigger external network requests if captured resources are replayed naively.
- Captured DOM must never execute scripts.
- Captured URLs, CSS, source maps, and media references can disclose viewer IP, referrer, or archive contents.
- Player bugs can turn an archive into an active attack payload.

## 5. Product Strategy

### 5.1 Recommended Product Split

Chrome's `debugger` permission is not a good fit for a low-friction consumer Chrome Web Store extension. It is powerful, alarming, and cannot be treated like a simple optional host permission.

Recommended split:

1. **WebBlackbox Lite - Chrome Web Store**
   - No `debugger`.
   - No persistent `<all_urls>` by default.
   - Use `activeTab` and/or `optional_host_permissions`.
   - Programmatic injection only after a user gesture.
   - In activeTab-only mode, stop or re-prompt when navigation crosses origin; cross-origin continuity requires optional host permission or an enterprise policy.
   - Captures privacy-safe metadata and masked replay.
   - Suitable for public store distribution and basic commercial use.

2. **WebBlackbox Dev/Enterprise - High-Trust Build**
   - May include `debugger` and full CDP mode.
   - Distributed as enterprise-managed extension, private listing, or developer tool build.
   - Requires explicit organization policy, admin controls, and per-session high-risk consent.
   - Suitable for internal QA, staging, support sessions, and customer-approved diagnostics.

If maintaining two SKUs is too expensive initially, keep one SKU but ship with Lite behavior as the only default path and put Full mode behind an explicit "advanced diagnostic mode" gate. Still, a split is the stronger commercial posture.

### 5.2 Capture Modes

Define three product modes:

| Mode    | Audience                             | Default availability  | Data posture                                                            |
| ------- | ------------------------------------ | --------------------- | ----------------------------------------------------------------------- |
| Private | General commercial users             | Default               | Metadata only, text/input masked, screenshots/storage/body off          |
| Debug   | Developers/support with user consent | Explicit per session  | Selective artifacts with source-side sanitization and strict allowlists |
| Lab     | Internal trusted environments        | Enterprise/admin only | Full CDP diagnostics, no cloud share unless encrypted and approved      |

Mode selection must be recorded in the archive manifest and privacy manifest.

## 6. Design Principles

1. **Do not collect what is not needed.**
   Not collecting data is more reliable than collecting and redacting.

2. **Sanitize before storage.**
   Sensitive data must be removed in the page/content/CDP adapter before it enters pipeline storage, offscreen storage, archive blobs, logs, or share requests.

3. **Default to mask, block, or metadata.**
   Unmasking is an explicit, scoped exception.

4. **Use allowlists for risky data.**
   Headers, body fields, URL parameters, storage values, console payloads, and DOM text should be allowlisted, not blocklisted.

5. **Treat screenshots as high-risk data.**
   A screenshot is not just another artifact. It is a pixel dump of visible user data.

6. **Separate capability from policy.**
   Even if the extension has a permission, runtime policy decides whether a capture adapter may use it.

7. **Make privacy state inspectable.**
   Every artifact should declare how it was captured, sanitized, masked, truncated, encrypted, and scanned.

8. **Make sharing zero-trust.**
   Shared archives must be encrypted before upload for all real-user captures, have expiry/revocation, and avoid server-side decryption by default.

9. **Make dangerous operations reversible.**
   Users need pause, stop, discard, delete, and revoke controls.

10. **Test privacy like correctness.**
    Privacy regressions should break CI.

11. **Treat replay as another data boundary.**
    A player must not execute captured content or fetch captured external resources unless explicitly allowed.

12. **State the limits of encryption honestly.**
    Browser-local convenience encryption is useful, but it does not protect against a compromised extension profile. Passphrase or enterprise-managed keys provide stronger separation.

## 7. Target Architecture

### 7.1 High-Level Flow

```text
User Gesture / Consent UI
  -> Capture Policy Engine
  -> Site Scope Resolver
  -> Capture Adapters
      - DOM/input adapter
      - network adapter
      - console/error adapter
      - storage adapter
      - screenshot adapter
      - CDP adapter
  -> Source-Side Sanitizers
  -> Ingest Privacy Gate
  -> Encrypted Local Pipeline Storage
  -> Archive Builder
  -> Plaintext Export Bundle Secret Scanner + Privacy Manifest
  -> Archive Encryption / Packaging
  -> Export / Share Preflight
  -> Local Download or Zero-Plaintext Share
```

### 7.2 Capture Policy Engine

Create a single policy object that every capture path must consult. This should replace scattered checks like "mode full", "bodyCaptureMaxBytes > 0", and local booleans.

Proposed conceptual schema:

```ts
type CapturePolicy = {
  schemaVersion: 2;
  mode: "private" | "debug" | "lab";
  // Derived by trusted recorder runtime/build profile, enterprise policy, or signed fixture/local-dev attestation.
  // Never trust user input, imported archive metadata, query params, or test flags to relax this value.
  captureContext: "real-user" | "synthetic" | "local-debug";
  // Required when captureContext is not real-user. References a local attestation/audit record, not user PII.
  captureContextEvidenceRef?: string;
  consent: {
    id: string;
    provenance: "self-recording" | "support-assisted" | "enterprise-admin-policy";
    purpose: "debugging" | "support" | "qa" | "incident-response" | "other";
    // Pseudonymous actor id only. Do not store raw emails, names, support ticket URLs, or internal admin URLs in shareable archives.
    grantedBy?: string;
    grantedAt: string;
    expiresAt?: string;
    // Reference id or policy id only. Real revocation URLs stay in local/server-side mapping, not archive/share metadata.
    revocationRef?: string;
  };
  unmaskPolicySource: "none" | "extension-managed" | "enterprise" | "signed-site-owner";
  scope: {
    tabId: number;
    origin: string;
    allowedOrigins: string[];
    deniedOrigins: string[];
    includeSubframes: boolean;
    stopOnOriginChange: boolean;
    excludedUrlPatterns: string[];
  };
  categories: {
    actions: "metadata" | "masked" | "allow";
    inputs: "none" | "length-only" | "masked" | "allow";
    dom: "off" | "wireframe" | "masked" | "allow";
    screenshots: "off" | "masked" | "allow";
    console: "off" | "metadata" | "sanitized" | "allow";
    network: "metadata" | "headers-allowlist" | "body-allowlist";
    storage: "off" | "counts-only" | "names-only" | "lengths-only" | "allow";
    indexedDb: "off" | "counts-only" | "names-only";
    cookies: "off" | "count-only" | "names-only";
    cdp: "off" | "safe-subset" | "full";
    heapProfiles: "off" | "lab-only";
  };
  redaction: RedactionPolicy;
  // Session-level minimums only. Each export/share must compute a transfer-time ExportPolicy or SharePolicy.
  encryption: {
    localAtRest: "required";
    archive: "required" | "synthetic-local-debug-exempt" | "explicit-low-risk-override";
    archiveKeyEnvelope: "passphrase" | "enterprise-managed" | "client-side-share-fragment" | "none";
    // Required for explicit-low-risk-override. References an audit/preflight record, not free-form user text.
    overrideReasonRef?: string;
  };
  retention: {
    localTtlMs: number;
    shareTtlMs?: number;
  };
};
```

Export and share decisions are transfer-time policies, not a one-time capture decision. A single recording may be downloaded locally, shared publicly, or uploaded to support under different constraints, and each transfer must recompute its own policy from the active `CapturePolicy`, privacy manifest, scanner result, destination, and user/admin approval.

```ts
type ExportPolicy = {
  destination: "local-download" | "support-upload" | "enterprise-upload" | "public-cloud-share";
  archive: "required" | "synthetic-local-debug-exempt" | "explicit-low-risk-override";
  archiveKeyEnvelope: "passphrase" | "enterprise-managed" | "client-side-share-fragment" | "none";
  overrideReasonRef?: string;
  preflightRef: string;
};

type SharePolicy = ExportPolicy & {
  destination: "public-cloud-share" | "support-upload" | "enterprise-upload";
  publicSummarySchemaVersion: number;
  publicSummaryClassification: "public-metadata-allowlisted";
};
```

Rules:

- Capture adapters must fail closed if no policy exists.
- Policies are immutable per session except for explicit user changes recorded as events.
- Policy changes must be visible in the player timeline.
- The archive must include the final policy and a list of policy transitions.
- Consent provenance must be included in the session metadata and privacy manifest.
- `captureContext` must be assigned by the recorder runtime from trusted build profile, enterprise policy, or signed fixture/local-dev attestation. Export/share preflight must not trust imported archive metadata or user-editable state to relax privacy gates.
- Missing, unverifiable, or stale `captureContextEvidenceRef` fails closed to `captureContext: "real-user"`.
- `captureContext: "real-user"` requires `localAtRest: "required"` and `archive: "required"` for exported or shared archives.
- `archiveKeyEnvelope: "none"` is valid only for local downloads when `archive` is an allowed synthetic/local-debug exemption or an explicit low-risk override; it is never valid for public share, support upload, or enterprise upload.
- `synthetic-local-debug-exempt` is limited to localhost/dev/staging fixtures or local developer captures that use synthetic/test accounts and contain no real customer, employee, tenant, or end-user data. Any production origin, production tenant, or real account must be treated as `captureContext: "real-user"` even if the recorder is operated by a developer.
- `explicit-low-risk-override` is local-download-only and requires second confirmation, scanner pass, privacy manifest low-risk classification, no high-risk categories, and an audit-linked `overrideReasonRef`.
- `explicit-low-risk-override` is not valid for share links, support uploads, public-cloud uploads, enterprise uploads, or archives containing screenshots, DOM snapshots, body blobs, console payloads, storage data, or other high-risk categories.
- Every local download, support upload, enterprise upload, and public-cloud share must write its computed `ExportPolicy` or `SharePolicy` into the artifact privacy manifest. Imported archive policy is evidence only; preflight must recompute transfer eligibility before any new transfer.

### 7.3 Site Scope Resolver

The resolver decides whether capture is allowed for the current URL before any adapter records data.

Required behavior:

- Default deny all pages until a user starts recording.
- Allow only the active tab and current origin by default.
- In `activeTab`-only mode, origin-changing navigation stops recording or triggers a new user permission prompt.
- Cross-origin iframes are denied unless the origin is explicitly allowed.
- Sensitive origins are denied by default:
  - banking and payment pages
  - password managers
  - identity providers and OAuth callback pages
  - healthcare and insurance portals
  - government portals
  - email and messaging apps
  - admin consoles and cloud provider consoles
  - configured enterprise denylist
- URL fragments and query strings are stripped before storage unless explicitly allowlisted.
- Raw path segments are normalized by default because IDs, emails, reset tokens, tenant names, and case numbers often appear in paths. Store origin plus route template, for example `/users/:id`, unless a path segment allowlist exists.
- Incognito and file URL capture require separate explicit enablement.

### 7.4 Source-Side Sanitizers

Sanitizers must run before data reaches the pipeline.

Required sanitizer types:

- DOM sanitizer:
  - mask all text by default
  - mask all inputs, textareas, selects, and contenteditable nodes
  - block payment, auth, profile, message, prompt, and custom sensitive selectors
  - support explicit `data-webblackbox-allow` unmasking only when backed by extension-managed policy, enterprise policy, or a signed/versioned site-owner policy
  - do not trust `data-webblackbox-allow` merely because the current origin is allowlisted; XSS or third-party scripts can add DOM attributes dynamically
  - in Store-safe generic recording, honor page-provided `mask`, `block`, and `ignore` directives, but do not trust page-provided `allow` because page or third-party scripts can add it dynamically
  - support `data-webblackbox-mask`, `data-webblackbox-block`, and `data-webblackbox-ignore`
  - build safe target selectors by default: tag name, role category, stable positional path, and per-session HMAC/salted id/class tokens only
  - selector HMAC/salt keys must not be written to archive, share metadata, logs, telemetry, or player state
  - do not store raw text-derived selectors, `aria-label`, `title`, `placeholder`, `value`, arbitrary `data-*`, email-like ids, or user-controlled classes unless policy explicitly allows them

- Screenshot sanitizer:
  - default off
  - if enabled, apply a temporary same-page privacy stylesheet or sanitized clone before capture
  - mask all text and sensitive elements unless unmasked by policy
  - never capture raw CDP screenshots in Private mode
  - block or placeholder images, videos, canvas, WebGL, cross-origin iframes, and embedded documents by default
  - treat shadow DOM, CSS generated content, background images, and SVG text as sensitive unless explicitly allowed
  - verify masked screenshot output with fixture string checks plus pixel/OCR heuristics where practical

- Network sanitizer:
  - strip query and fragment by default
  - method/status/type/timing allowed by default
  - request and response bodies off by default
  - header allowlist only, for example `content-type`, `content-length`, selected safe tracing IDs
  - structured JSON/form redaction before byte storage
  - route allowlist required for body capture
  - max byte caps and rate limits remain mandatory

- Console/error sanitizer:
  - default stores level, timestamp, stack top, and template/hash
  - string/object payloads require sanitizer and consent
  - DOM element serialization must not include text by default
  - stack traces must strip query strings and local paths where appropriate

- Storage sanitizer:
  - default off or counts-only in Private mode
  - key/name capture requires an explicit site policy because storage keys and cookie names can contain personal or business identifiers
  - value samples off
  - values require per-site allowlist and scanner
  - cookies values never captured; cookie names only when needed

- Hashing:
  - replace plain SHA-256 of sensitive values with either fixed redaction tokens or per-session HMAC/salted hashes
  - do not expose deterministic cross-session hashes unless explicitly needed and documented

### 7.5 Ingest Privacy Gate

The ingest gate sits immediately before `pipeline.ingest` / blob storage. It should reject or quarantine any artifact that violates policy.

Gate responsibilities:

- Validate event type against active `CapturePolicy`.
- Validate artifact metadata includes `privacy.classification`.
- Validate redaction status for high-risk fields.
- Run fast secret scanning on strings and small blobs.
- Reject raw screenshots, DOM snapshots, response bodies, console payloads, or storage values that are not policy-allowed.
- Emit `privacy.violation` events for blocked artifacts without storing sensitive content.

### 7.6 Privacy Manifest

Each archive must contain a `privacy/manifest.json` file.

Required fields:

- policy schema version and effective policy
- extension build version
- capture mode
- capture context and capture context evidence verification status
- enabled data categories
- disabled data categories
- redaction engine version
- scanner version
- scanner timing, including whether plaintext pre-encryption scanning was completed
- per-artifact classification summary
- redaction counts
- truncation counts
- blocked artifact counts
- encryption status
- computed export/share transfer policy for the current artifact
- share eligibility status
- public summary schema/classification when an artifact is shared
- known residual risks

Example:

```json
{
  "schemaVersion": 1,
  "mode": "private",
  "captureContext": "real-user",
  "captureContextEvidenceRef": null,
  "shareEligible": true,
  "encryption": {
    "archive": true,
    "assertedLocalAtRestEncryption": true,
    "archiveKeyEnvelope": "client-side-share-fragment",
    "overrideReasonRef": null
  },
  "transferPolicy": {
    "destination": "public-cloud-share",
    "archive": "required",
    "archiveKeyEnvelope": "client-side-share-fragment",
    "preflightRef": "preflight_2026_05_09_001",
    "publicSummarySchemaVersion": 1,
    "publicSummaryClassification": "public-metadata-allowlisted"
  },
  "categories": {
    "inputs": "length-only",
    "dom": "masked",
    "screenshots": "off",
    "networkBodies": "off",
    "storageValues": "off"
  },
  "scanner": {
    "version": "2026.05.09",
    "plaintextPreEncryptionScanCompleted": true,
    "highConfidenceFindings": 0,
    "quarantinedArtifacts": 0
  },
  "publicCloudSummary": {
    "schemaVersion": 1,
    "classification": "public-metadata-allowlisted",
    "rawOriginIncluded": false,
    "rawHostIncluded": false,
    "rawRouteIncluded": false,
    "rawSelectorIncluded": false,
    "freeFormCapturedTextIncluded": false
  }
}
```

### 7.7 Player and Archive Rendering Safety

The player must treat archives as untrusted input.

Required player behavior:

- Render replay content in a sandboxed iframe with scripts disabled.
- Apply a strict Content Security Policy for replay views.
- Do not load captured external scripts, stylesheets, fonts, images, iframes, videos, source maps, or arbitrary URLs by default.
- Convert captured resource references to inert placeholders unless they are bundled, sanitized, and policy-approved.
- Use `Referrer-Policy: no-referrer` for player and share views.
- Strip or neutralize event handlers, inline scripts, `javascript:` URLs, dangerous SVG payloads, and active form submission behavior.
- Use object URLs with short TTLs and revoke them after use.
- Treat archive metadata and indexes as untrusted; validate schema and size before rendering.
- Keep "load external assets for fidelity" as an explicit local-only debugging option, not a public share default.

## 8. Data Category Policy Matrix

| Data category               | Commercial default              | Opt-in path                                 | Hard block                                        |
| --------------------------- | ------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Click/scroll/navigation     | Metadata only                   | Include selectors if sanitized              | Events on blocked elements                        |
| Keyboard                    | Shortcut metadata only          | Never raw character stream                  | Password/auth/payment fields                      |
| Input values                | Length only or masked           | Per-selector synthetic/lipsum only          | Raw values in default product                     |
| DOM text                    | Mask all                        | Policy-backed allow only                    | Auth/payment/profile/message areas                |
| DOM structure               | Sanitized wireframe             | Masked DOM snapshot                         | Raw DOM in Private mode                           |
| Screenshots                 | Off                             | Masked screenshot after source-side overlay | Raw screenshot in Private mode                    |
| Network URL                 | Origin + route template only    | Allowlisted path segments and query params  | Tokens/codes/fragments/raw IDs                    |
| Network headers             | Header allowlist                | Per-route allowlist                         | `authorization`, `cookie`, `set-cookie`, API keys |
| Request body                | Off                             | Route + MIME + schema allowlist             | Auth/payment/PII routes                           |
| Response body               | Off                             | Route + MIME + schema allowlist             | Binary, large, auth/payment/PII routes            |
| Console                     | Level/template/hash             | Sanitized strings                           | Raw objects/DOM text by default                   |
| Errors                      | Name/message template/stack top | Sanitized full stack                        | Query strings/secrets                             |
| localStorage/sessionStorage | Off or counts only              | Key names/value length under site policy    | Raw values by default                             |
| IndexedDB                   | Off or DB counts only           | DB/object store names under site policy     | Records by default                                |
| Cookies                     | Off or count only               | Names under site policy                     | Values always                                     |
| Heap/profile                | Off                             | Lab mode only                               | Cloud share by default                            |

## 9. Permission and Extension Packaging Plan

### 9.1 Chrome Web Store Build

Goal: minimize install warnings and reduce blast radius.

Recommended manifest posture:

- Required permissions:
  - `storage`
  - `scripting`
  - `downloads` only if export download cannot use a safer UI path
  - `activeTab`
- Optional permissions:
  - host permissions for user-approved origins
  - `webRequest` only if required for an explicitly enabled feature
- Avoid:
  - `debugger`
  - persistent `<all_urls>`
  - always-on content scripts matching all URLs

Implementation direction:

- Remove static `<all_urls>` content script injection for the store build.
- Inject content scripts programmatically after action click / start capture.
- Use optional host permission requests for persistent site allowlists.
- Provide a pre-permission explanation screen before Chrome's permission prompt.

### 9.2 Enterprise / Dev Build

Goal: preserve full diagnostic power while making the risk explicit and administratively controlled.

Allowed with policy:

- `debugger`
- broader host permissions
- full CDP capture
- internal/self-hosted share

Required controls:

- admin-managed allowlist/denylist
- visible recording indicator
- per-session explicit consent
- no cloud share without encryption
- lab-only heap/profile capture
- audit trail of who recorded, exported, shared, opened, and deleted

## 10. User Experience Requirements

### 10.1 Start Recording

Before recording:

- Show current origin and tab.
- Show capture mode.
- Show data categories with toggles.
- Highlight high-risk toggles:
  - screenshots
  - DOM text
  - network bodies
  - storage values
  - console payloads
  - full CDP
- Explain whether data stays local, is encrypted, and can be shared.
- Require explicit confirmation for Debug or Lab mode.

During recording:

- Persistent visible indicator on the page.
- Popup badge state.
- Pause/resume.
- Stop and discard.
- "Mask this page" / "Block this element" quick action.
- "Panic delete current session" action.

After recording:

- Privacy summary before export.
- Archive data category list.
- Detected sensitive signal count.
- Encryption status.
- Share eligibility.
- Clear delete/export/share controls.

### 10.2 Export

Rules:

- All real-user archives must be encrypted by default, including metadata-only archives, because metadata can disclose origin, route templates, timing, errors, tenant context, and project details.
- Unencrypted export is allowed only as a local download for synthetic/local-debug captures or an explicit low-risk override recorded in policy/audit after scanner and privacy manifest classify the archive as low-risk.
- Unencrypted export is never allowed for public share, support upload, enterprise upload, or any workflow where the archive leaves the user's machine through WebBlackbox-managed transfer.
- Any archive with screenshots, DOM snapshots, body blobs, console payloads, or storage data must require encryption and cannot use a low-risk override.
- User must review privacy preflight before export.
- Export must include `privacy/manifest.json`.

### 10.3 Share

Rules:

- Upload blocked unless privacy preflight passes.
- Public cloud share is zero-plaintext/server-blind by default and must require an encrypted archive.
- Production share/support endpoints must never accept `archive: "synthetic-local-debug-exempt"`, `archive: "explicit-low-risk-override"`, or `archiveKeyEnvelope: "none"`.
- Fixture upload exceptions must use a separate test-only build flag and localhost-only harness that cannot be packaged into commercial builds or routed through production share/support endpoints.
- Share server must not receive passphrase by default.
- Client computes privacy summary before upload.
- Privacy summary for encrypted public-cloud uploads must be computed from sanitized plaintext before archive encryption, then uploaded as a redacted summary that contains no secrets.
- Public-cloud share summary must use an allowlisted schema and be treated as public metadata: no raw origin, hostname, subdomain, route/path, selector, raw error payload, tenant/project/customer identifiers, high-cardinality values, or free-form captured text unless a public-domain allowlist explicitly permits that exact field.
- Decryption keys and passphrases must never be sent in query strings, path segments, headers, request bodies, or server-visible metadata.
- If a share link carries client-side decryption material, it must use the URL fragment only, and player/share pages must set `Referrer-Policy: no-referrer`.
- If a player reads decryption material from a URL fragment, it must call `history.replaceState` immediately after parsing, never persist the key in `localStorage` or `sessionStorage`, and initialize analytics/crash reporting only after the full URL has been scrubbed.
- Prefer out-of-band passphrase exchange for enterprise and support workflows.
- Share link requires expiry.
- Share can be revoked.
- Accesses are audited.
- Metadata returned by share server must be redacted.
- API keys must be scoped and revocable.

Enterprise option:

- A self-hosted share server can allow server-side archive analysis with customer-managed keys, but this must be disabled in public cloud defaults.

## 11. Storage, Encryption, Retention

### 11.1 Local Storage

Required:

- Encrypt pipeline chunk/blob storage at rest by default.
- Use WebCrypto AES-GCM.
- Support one of:
  - user passphrase
  - browser-local generated key
  - enterprise-managed key material
- Keep keys non-extractable where possible.
- Avoid writing plaintext high-risk blobs to IndexedDB, chrome storage, logs, or temporary object URLs.
- Document protection level honestly:
  - browser-local generated keys protect against some disk, backup, and casual file disclosure risks, but not against a compromised extension/browser profile
  - user passphrases protect exported archives better when the passphrase is not stored
  - enterprise-managed keys provide the strongest operational control when backed by device or organization policy

### 11.2 Archive Encryption

Required:

- AES-GCM archive encryption remains appropriate.
- Increase KDF policy as needed after performance testing.
- Store encryption metadata in manifest.
- Encrypt every real-user exported or shared archive with a random per-archive data key.
- Wrap archive keys with a user passphrase, an enterprise-managed key, or client-side share material that is never visible to the server.
- `client-side-share-fragment` is a convenience envelope for lower-risk public share after preflight; enterprise and support workflows should default to out-of-band passphrase exchange or enterprise-managed key wrapping.
- Require passphrase or enterprise-managed key wrapping for high-risk exports; browser-local generated keys alone are insufficient for portable high-risk exports.
- Warn and block weak passphrases for shareable archives.
- Do not place passphrases or derived keys in archive metadata.

### 11.3 Retention

Defaults:

- Local stopped sessions auto-expire after a short TTL unless pinned.
- Shared archives default to short expiry, for example 7 or 14 days.
- Enterprise admins can configure retention caps.
- Delete must remove local indexes, chunks, blobs, annotations, object URLs, and share records.

## 12. Compliance and Governance

Commercial readiness needs engineering plus documentation.

Required documents:

- Public privacy policy
- Chrome Web Store privacy practices disclosure
- Limited Use disclosure
- Data Processing Addendum template
- Subprocessor list
- Security overview
- Data retention policy
- Deletion request process
- Incident response process
- Enterprise admin guide

Required product controls:

- Single-purpose disclosure aligned with Chrome Web Store listing.
- In-product prominent disclosure before sensitive capture.
- Consent event stored in archive metadata.
- No user data sale or advertising use.
- Human access to user data prohibited unless explicit support consent or security/legal exception applies.
- Role-based access control for share/player cloud.
- Audit logs for share access and admin actions.
- External security review checklist for Chrome permissions, archive parser safety, share access control, and data deletion.
- Telemetry/crash/log/audit pipeline policy that forbids captured payloads, raw URLs, raw selectors, consent PII, passphrases, derived keys, archive plaintext, URL fragments, and selector HMAC keys; each pipeline must have an explicit retention limit.

## 13. Implementation Roadmap

### Phase 0 - Release Gate and Risk Freeze

Goal: prevent accidental commercial release with high-risk defaults.

Tasks:

- Mark current Chrome extension as development/preview until privacy baseline is implemented.
- Add this plan to repo and open tracking issues.
- Document current high-risk capabilities in README or release notes.
- Require manual review before packaging any public Chrome Web Store build.
- Define consent provenance requirements for self-recording, support-assisted recording, and enterprise-admin-policy recording.

Exit criteria:

- Team agrees on product split or single-SKU fallback.
- No public release occurs without a privacy checklist.

### Phase 1 - Safe Defaults and Store-Safe Packaging

Goal: make default capture and the public extension package safe even before deeper architecture changes.

Tasks:

- Create a store-safe manifest profile with no `debugger` and no persistent `<all_urls>`.
- Remove static all-sites content script injection from the store-safe build.
- Add programmatic injection after user gesture for store-safe capture.
- Add permission regression tests for store-safe and dev/enterprise profiles.
- Set default body capture to `0`.
- Set default export screenshots to `false`.
- Stop recording raw input values; record length/type only.
- Stop localStorage value sampling; use off or counts-only in Private mode.
- Disable screenshots by default in Lite mode.
- Disable DOM text capture by default; introduce mask-all text behavior.
- Strip URL query and fragment by default.
- Normalize raw URL paths into route templates by default.
- Disable raw selector metadata by default; use safe selector/token builder.
- Encrypt real-user archives by default; allow unencrypted local download only for synthetic/local-debug captures or audited explicit low-risk override, never for share/upload or high-risk categories.

Exit criteria:

- Store-safe build has no `debugger`, no persistent `<all_urls>`, and no always-on all-sites content script.
- `activeTab`-only sessions stop or re-prompt on cross-origin navigation.
- URL paths are route-templated and target selectors are tokenized/normalized by default.
- Default archive from a sensitive fixture contains no fixture secrets.
- Default capture still provides useful action/error/network metadata.

### Phase 2 - Capture Policy Engine

Goal: replace scattered capture conditionals with one enforceable policy.

Tasks:

- Add `CapturePolicy` and `PrivacyClassification` types in `packages/protocol`.
- Thread policy into extension service worker, content script, injected hooks, lite SDK, and pipeline.
- Add policy checks before every capture adapter emits data.
- Add privacy violation events for blocked artifacts.
- Add manifest recording of effective policy.

Exit criteria:

- Every event/blob has a privacy classification.
- Tests fail if high-risk event types bypass policy.

### Phase 3 - Source-Side Sanitizers

Goal: sanitize before storage.

Tasks:

- DOM sanitizer with mask/block/allow selectors.
- Input sanitizer for all input-like elements and contenteditable.
- URL sanitizer.
- Header allowlist sanitizer.
- JSON/form body sanitizer.
- Console/error sanitizer.
- Storage sanitizer.
- HMAC/salted hash support or fixed redaction tokens.
- Replace selector substring checks with real selector/rule evaluation where possible.

Exit criteria:

- Synthetic secrets in DOM, input, storage, console, URL, headers, and body do not appear in pipeline storage or archives.
- Sanitizers emit redaction counts for privacy manifest.

### Phase 4 - Dev/Enterprise Packaging and Policy Administration

Goal: preserve high-trust diagnostic power while keeping it administratively controlled.

Tasks:

- Create dev/enterprise manifest profile.
- Add optional host permission flow for persistent site allowlists.
- Add admin-managed allowlist/denylist plumbing.
- Add high-risk permission disclosure and release checklist.
- Update build/package scripts to produce clearly separated artifacts.

Exit criteria:

- Dev/enterprise build clearly declares high-risk permissions and is gated by product UX.

### Phase 5 - Privacy Manifest and Archive Scanner

Goal: make archive privacy inspectable and enforceable.

Tasks:

- Add `privacy/manifest.json`.
- Add archive scanner for high-confidence secrets:
  - JWT
  - Bearer tokens
  - API keys
  - OAuth codes
  - session cookies
  - emails
  - phone numbers
  - credit card patterns
  - SSN-like patterns where relevant
  - private keys
  - long base64/hex secrets
- Add scanner result to player and share preflight.
- Run scanning on the sanitized plaintext export bundle before archive encryption; encrypted archives get structure/manifest validation after encryption.
- Quarantine or block export/share on high-confidence findings.

Exit criteria:

- Share/upload blocked for known raw secret fixtures.
- Scanner result proves pre-encryption plaintext scanning ran for encrypted exports.
- Player can explain privacy posture without opening raw high-risk content.

### Phase 6 - Export and Share Hardening

Goal: make external transfer commercially defensible.

Tasks:

- Require encryption for all real-user exported or shared archives.
- Prohibit low-risk override for high-risk archives.
- Remove public-cloud passphrase header analysis path.
- Move encrypted archive privacy summary generation to client side.
- Add share expiry, revocation, and access audit.
- Add API key scope and rotation guidance.
- Add redacted-only metadata endpoint.
- Add configurable retention.

Exit criteria:

- Share server never needs the user's archive passphrase in public-cloud mode.
- A shared real-user archive is encrypted, expiring, revocable, and audited.
- A shared high-risk archive cannot use a low-risk encryption override.

### Phase 7 - Enterprise Controls

Goal: support commercial security reviews.

Tasks:

- Admin-managed site allowlist and denylist.
- Admin-managed data category caps.
- Disable Lab mode in production orgs unless explicitly enabled.
- Export audit logs.
- Share audit logs.
- Retention policies.
- Self-hosted deployment guide.
- Security and privacy documentation.

Exit criteria:

- Enterprise customer can prove which sites and data categories are allowed.
- Security review has clear answers for permissions, data flows, encryption, retention, and deletion.

## 14. Test Strategy

### 14.1 Privacy Fixture Suite

Create a synthetic test app containing:

- login form with username/password
- profile page with name/email/address/phone
- payment form with card-like values
- OAuth callback with `code` and `state`
- URL query tokens
- path-based identifiers, emails, reset tokens, tenant names, and case numbers
- text-derived ids/classes, `aria-label`, `title`, `placeholder`, and sensitive `data-*` attributes
- `localStorage` JWT and refresh token
- `sessionStorage` secret
- cookies
- console logs with token/user object
- fetch/XHR request and response bodies with secrets
- contenteditable chat/prompt area
- cross-origin iframe
- visible secret text for screenshot/DOM tests
- shadow DOM secret
- canvas/WebGL/video/image secret or marker
- CSS generated content and background image marker
- SVG text/script-like payload
- malicious archive fixture for player sandbox tests

### 14.2 Required CI Checks

Add tests that:

- Record fixture in Private mode.
- Inspect raw content-script batches where tests can observe them.
- Inspect service-worker ingest payloads.
- Inspect pipeline IndexedDB/chunk/blob storage.
- Inspect offscreen temporary export buffers where practical.
- Export archive.
- Decompress archive.
- Search raw bytes for fixture secrets.
- Fail on any match.
- Assert raw URL paths and target selectors are normalized or tokenized by default.
- Assert privacy manifest exists and categories match policy.
- Assert privacy manifest records consent provenance and pre-encryption scanner status.
- Assert high-risk features are disabled by default.
- Assert Store manifest profile has no broad permissions.
- Assert Dev/Enterprise manifest profile is clearly separate.
- Assert forged, imported, missing, or stale `captureContext` / `captureContextEvidenceRef` cannot relax encryption, export, or share gates.
- Assert synthetic/local-debug exemptions require trusted evidence and are rejected by production share/support upload paths.
- Assert synthetic/local-debug exemptions are rejected for production origins, production tenants, and real accounts even when operated by a developer.
- Assert export/share preflight recomputes `ExportPolicy` / `SharePolicy` and does not trust imported archive policy as authorization.
- Assert `archiveKeyEnvelope: "none"` is rejected for real-user share, support upload, and enterprise upload.
- Assert explicit low-risk override succeeds only for local download and fails whenever high-risk categories are present.
- Assert share upload payload does not include plaintext secrets or decryption keys.
- Assert public-cloud share summary bytes match the allowlisted schema and do not include fixture raw origins, hostnames, subdomains, routes, paths, selectors, error payloads, tenant/project/customer identifiers, high-cardinality values, or free-form captured text.
- Assert player rendering does not execute captured scripts or load captured external resources by default.
- Assert telemetry, crash, operational log, and audit payloads do not include fixture secrets, raw URLs, raw selectors, URL fragments, consent PII, passphrases, derived keys, archive plaintext, or selector HMAC keys.

### 14.3 Browser Verification

For UI and screenshot privacy:

- Run extension e2e on fixture pages.
- Capture screenshots only in allowed modes.
- Verify masked regions replace visible secrets.
- Use exact fixture-string checks where possible.
- Use OCR/pixel heuristics only as supplemental checks.

## 15. Acceptance Criteria for Commercial Readiness

The extension is commercially privacy-ready when all are true:

- Default installation does not grant persistent access to all sites in the store-safe build.
- Default capture cannot store raw input values, DOM text, screenshots, storage values, cookies, raw or unallowlisted headers, request bodies, or response bodies.
- Store-safe build has no `debugger`, no persistent `<all_urls>`, and no always-on all-sites content script.
- Full/CDP capture is explicit, temporary, visible, and admin-controllable.
- Every high-risk data category has a clear user-facing opt-in.
- Every artifact has privacy classification and provenance.
- Archive scanner blocks known secret fixtures before encryption, and encrypted outputs record that pre-encryption plaintext scanning completed.
- Real-user archives are encrypted by default; unencrypted export is limited to local download for synthetic/local-debug captures or audited explicit low-risk override, never for share/upload or high-risk categories.
- Public share server does not receive archive passphrases.
- Public share links do not expose decryption material to the server.
- Player opens archives in a sandbox and does not fetch captured external resources by default.
- Shares are expiring, revocable, and audited.
- Privacy policy, Chrome disclosure, Limited Use statement, retention policy, and deletion process are published.
- CI includes privacy regression tests.
- The product can answer: what is collected, why, where it is stored, who can access it, how long it is retained, and how it is deleted.

## 16. Recommended First Engineering Cut

If we want the shortest path to meaningful risk reduction, do this first:

1. Change defaults:
   - response body capture off
   - screenshots off
   - raw input values off
   - storage value samples off
   - storage/cookie names off or counts-only in Private mode
   - query/hash stripping and path route-templating on
   - raw selector metadata off; safe selector/token builder on
2. Add a store-safe manifest profile with no `debugger`, no persistent `<all_urls>`, and no always-on all-sites content script.
3. Add `CapturePolicy` and make adapters fail closed.
4. Add fixture archive scanner and CI byte-search for raw secrets across intermediate storage and final archive, with scanning before archive encryption.
5. Encrypt real-user archives by default; allow unencrypted local download only for synthetic/local-debug captures or audited explicit low-risk override, never for share/upload or high-risk categories.
6. Harden player sandboxing and external-resource blocking.
7. Remove cloud share passphrase analysis from public default path.

This sequence reduces actual leakage risk before investing in more polished enterprise controls.

## 17. Open Decisions

1. Should WebBlackbox ship as two Chrome extension SKUs, or one SKU with profiles?
   Recommendation: two SKUs.

2. Should cloud share ever support server-side encrypted archive analysis?
   Recommendation: only in self-hosted or enterprise-managed deployments, not public cloud default.

3. Should Private mode allow DOM text unmasking?
   Recommendation: yes, but only through policy-backed allow rules from extension-managed, enterprise, or signed site-owner policy sources. Ordinary user-entered selectors must not unmask DOM text in Store-safe generic recording.

4. Should screenshot capture exist in Store-safe Lite?
   Recommendation: off by default, masked-only when enabled, and never raw.

5. Should raw response body capture exist in commercial builds?
   Recommendation: only route allowlist + structured sanitizer + encryption + scanner.

6. Should hashes preserve cross-session correlation?
   Recommendation: no by default. Use per-session HMAC only when correlation is needed.

7. Should player support external asset loading for replay fidelity?
   Recommendation: disabled by default and local-only when enabled.

8. What local encryption mode should be used by default?
   Recommendation: browser-local generated key for local at-rest convenience; exported or shared real-user archives use random per-archive data keys wrapped by passphrase, client-side share material, or enterprise-managed keys. High-risk exports require passphrase or enterprise-managed key wrapping.

9. What consent provenance is required for support-assisted recording?
   Recommendation: require explicit end-user consent or documented enterprise-admin policy, with purpose, scope, expiry, and a pseudonymous deletion/revocation reference stored in session metadata.

## 18. File/Package Impact Map

Likely implementation areas:

- `packages/protocol`
  - Add `CapturePolicy`, consent provenance, `PrivacyClassification`, privacy manifest schema, and default safe policy.
- `packages/recorder`
  - Replace generic blocklist redaction with structured sanitizers and HMAC/fixed-token support.
- `packages/webblackbox`
  - Enforce input, DOM, safe selector, URL route-template, screenshot, storage, console, and network capture policy in lite SDK/agent/hooks.
- `apps/extension`
  - Add permission profiles, start consent UI, site scope resolver, policy threading, source-side screenshot/DOM sanitization, and export gates.
- `packages/pipeline`
  - Add privacy manifest, scanner integration, encrypted-at-rest default, and export blocking.
- `packages/player-sdk`
  - Extend privacy reports to consume privacy manifest and scanner output.
- `apps/player`
  - Show preflight blockers, privacy manifest, encryption status, and share eligibility; sandbox archive rendering and block external resource loads by default.
- `apps/share-server`
  - Remove public-cloud passphrase analysis path, add expiry/revocation/audit, and keep summaries redacted.
- Shared telemetry/logging utilities and app logging paths
  - Enforce the telemetry/crash/log/audit payload policy across extension, player, share server, and server-side tools.
- `docs`
  - Add public privacy model, security overview, enterprise admin guide, and Chrome Web Store disclosure source text.

## 19. Non-Goals and Anti-Patterns

Do not:

- Claim "no sensitive data collected" while retaining screenshots, DOM, body blobs, or storage samples.
- Rely on a privacy policy as the only consent mechanism.
- Use broad permissions to future-proof features.
- Store raw artifacts and promise to redact during export.
- Send passphrases to a public share server.
- Treat console logs as low-risk.
- Treat screenshots as harmless because they are compressed.
- Treat SHA-256 hashes of secrets as anonymous data.
- Add more redaction patterns without reducing capture scope.
- Load captured external resources in public share/player views by default.
- Put archive decryption material in server-visible URLs, headers, request bodies, logs, or metadata.
- Treat raw URL paths, CSS selectors, ids/classes, ARIA labels, titles, placeholders, or `data-*` attributes as safe metadata by default.

## 20. Commercial Positioning

The desired market message after implementation:

"WebBlackbox is a privacy-first browser debugging recorder. By default, it records only the minimum metadata needed to reproduce issues. Text, inputs, screenshots, storage values, headers, and bodies are masked or disabled before they leave the browser context. High-fidelity capture is explicit, temporary, encrypted, auditable, and suitable for trusted development or enterprise support workflows."

This is the standard needed for serious commercial use.
