# Chrome Web Store Disclosure Source

## Single Purpose

WebBlackbox records browser debugging metadata for sessions that the user explicitly starts, then lets the user export an encrypted `.webblackbox` archive for local debugging or support.

## Permission Rationale

- `activeTab`: grants temporary access to the active tab after a user gesture.
- `alarms`: schedules restart-safe cleanup for expired local session data.
- `offscreen`: runs the bounded recorder pipeline outside page content.
- `scripting`: injects a passive scope-checking bootstrap only after recording starts; capture instrumentation activates only in frames permitted by the effective capture scope.
- `storage`: stores local settings, local session metadata, and local audit records.
- `downloads`: saves user-requested archive exports.
- `webNavigation`: binds capture authorization and lifecycle work to exact frame/document navigation identities.

The store-safe profile does not request `debugger`, persistent `<all_urls>` host permissions, or always-on all-sites content scripts.

## Privacy Practices

Default capture masks or disables raw input values, DOM text, screenshots, storage values, cookies, raw headers, request bodies, and response bodies. Exports include a privacy manifest and scanner result.

Real-user exports and public shares require encryption. The public share server does not receive archive passphrases or decryption keys.

## Limited Use Statement

WebBlackbox uses captured data only to provide user-requested debugging, playback, export, and share functionality. Captured data is not sold, used for advertising, or used for unrelated profiling.
