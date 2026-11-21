# Scope model

Kimbo JS uses an **explicit origin seal**, not a global content-script match.

## Seal

A seal is created when the user clicks **Seal this origin** and Chrome grants an optional host permission for that exact origin pattern.

Example:

```text
origin:  https://app.example.com
pattern: https://app.example.com/*
```

Only after the permission exists does the service worker:

1. register two dynamic content-script entries for that pattern;
2. inject the same files into the current tab;
3. create a local session for the origin;
4. schedule a storage-context probe.

Content scripts run at `document_start`, in all frames that match the origin, with:

- a MAIN-world hook (`constants` + `normalizer` + `network-hook`);
- an isolated-world stack (`constants` + `normalizer` + `bus` + DOM/script/lifecycle collectors).

## What is injected where

| Origin | Content scripts | Storage probe | Ledger |
|---|---|---|---|
| Exact sealed origin | Yes | Yes (top frame) | Yes |
| Same-site companion host (e.g. `api.example.com`) | No | No | Observed traffic only, if enabled |
| Other registrable domain | No | No | Dropped and counted |
| `chrome://`, Web Store, PDF viewer, `file://` | No | No | Not supported |

A companion host can only appear in the ledger if the sealed page itself made a request or exposed a URL to it. Kimbo never grants itself host permission for companions and never injects into them.

## Same-site mode vs exact-origin mode

The seal dialog has one option:

> Include same-site API hosts observed from this page.

### Same-site mode (default)

- Requests/DOM URLs to the same registrable site are kept.
- Example: `app.example.com` → `api.example.com`.
- The endpoint is tagged `scope: "site"` and grouped by host.
- Deep bundle reading is only attempted for the exact page origin (cache-only, same-origin).
- Cross-site third-party calls are dropped and counted in `dropped.external`.

### Exact-origin mode

- Only URLs on the sealed origin are kept.
- Same-site companion endpoints are dropped and counted.
- Useful when the authorization scope is strictly one host.

The mode is chosen at seal time and stored in the session. Re-seal to change it for new observations.

## Localhost and IPs

- `localhost` and IP hosts do not use the registrable-domain heuristic.
- Same-site matching for them requires the same hostname; different ports are treated as different origins for injection.
- Use exact-origin mode if you want to be strict.

## Frames

- Dynamic registration uses `allFrames: true`.
- Only frames matching the sealed origin receive collectors.
- Cross-origin iframes do not receive host permission and are not scanned.
- Same-origin iframe events are merged into the same origin session.
- The storage probe runs on the top frame only.

## SPA navigation

- `chrome.webNavigation.onHistoryStateUpdated` and `onReferenceFragmentUpdated` notify the top-frame lifecycle.
- The lifecycle re-announces the page, triggers a DOM rescan and schedules a context probe.
- `popstate`/`hashchange` are fallbacks inside the page.
- `webNavigation.onCommitted` tracks the active origin for badges and route changes.

## Permission loss and revocation

Chrome can revoke optional host permissions independently. On startup, install, update, and `permissions.onRemoved`:

- `ScopeManager.reconcile()` checks each stored scope;
- if permission is missing, the scope is marked inactive, collectors are unregistered, and the UI shows `LOST`;
- existing local data remains available as a read-only snapshot;
- re-sealing restores collection.

## Re-arm vs reload

- **Re-arm page** injects the collector files into the current page without reloading. Useful after you change the extension or navigate a page that was already open when the seal was created.
- **Reload page** is the reliable way to capture requests made during initial page load. Kimbo never reloads a page automatically.

## Unseal and purge

- **Unseal origin** stops collection, unregisters collectors, removes host permission, and keeps the local ledger as a snapshot until you purge it.
- **Purge ledger** deletes endpoints, context, notes, and bundle metadata for the origin. If the origin remains sealed, new observations will recreate a session.
- **Purge all** is available in the DevTools console (`KimboBG.SessionStore.purgeAll()`); the UI exposes per-origin purge.

## Multiple origins

Each origin gets its own session, identity anchors, permissions, and caps. There is no cross-origin merge. Seal each authorized origin individually. If two apps share a backend, the endpoint data stays separated by page origin until you export and correlate manually.

## Authorization is human

The seal is a technical guardrail:

- It prevents accidental collection outside the selected origin.
- It does not prove authorization.
- Same-site observations can include an API host you were not authorized to touch. Choose exact-origin mode if your rules of engagement require it.
- The pentester remains responsible for scope, data handling, and whether any manual test is allowed.

## Verification checklist

1. `chrome://extensions` → Kimbo JS → Details → Site access should show only the origins you sealed.
2. `chrome://extensions` → Inspect service worker → Application → Storage should show `kimbo:session:<origin>` only for sealed origins.
3. On a companion host, `chrome://extensions` should not list that host as granted access.
4. The fixture server log should show only the page’s own API calls after sealing.
