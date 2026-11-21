# Privacy and data handling

Kimbo JS is a local recon tool. It has no telemetry, no backend, no analytics, no sync and no third-party requests.

## Data inventory

### Stored in `chrome.storage.local`

| Data | Example | Notes |
|---|---|---|
| Endpoint shape | `/api/orgs/{org_id}/members/{member_id}` | Canonical template |
| Host/origin | `https://api.example.com` | Same-site companions included if enabled |
| Methods/statuses | `GET 200`, `DELETE 204` | Observed calls only |
| Non-sensitive query values | `status=active`, `org_id=482` | Sensitive values become `[redacted]` |
| Identity anchors | `org_id=482`, UUIDs, ObjectIds, order numbers | Non-sensitive, ID-shaped |
| Provenance | `localStorage current_org_id`, `JWT claim org_id` | Source kind, label, page path, timestamp |
| Discovery sources | `fetch`, `XHR`, DOM, inline script, bundle | Includes labels, not raw code |
| Page paths | `/app/projects/91` | Query and fragment removed |
| Bundle metadata | URL (sensitive query removed), status, bytes, extracted count | No bundle content |
| User notes and pins | Manual text | Stored locally; included in exports |

### Never stored

- `Authorization` headers or bearer tokens
- JWTs (raw tokens), API keys, passwords, CSRF/XSRF tokens, session identifiers
- Cookie values for sensitive names (and all HttpOnly cookies, which are inaccessible)
- Raw request bodies or response bodies
- Emails, phone numbers, names, addresses and other PII keys/values
- Full page HTML or JavaScript source
- Page query strings in page evidence
- Credentials embedded in URLs

### JWT handling

The network hook decodes the **payload only** to extract identity-shaped claims (`sub`, `org_id`, `tenant_id`, `project_id`, etc.). It does not verify the signature. The raw token is never posted through the bridge, stored, or exported. Claims that look sensitive or PII (`email`, `name`, `jti`, session IDs, client IDs) are discarded.

### Request bodies

The hook inspects a request body only to extract ID-shaped fields (`user_id`, `org_id`, …) for the context dictionary. The raw body is discarded immediately and is never stored or exported.

## Network egress

- There is no analytics, telemetry, update check or remote logging.
- The only `fetch` in the extension is the cache-only bundle reader:
  `fetch(url, { cache: 'only-if-cached', mode: 'same-origin', credentials: 'same-origin', redirect: 'error' })`.
- A cache miss becomes a local error; the UI offers a manual paste fallback.
- Discovery of endpoints never triggers a request.
- Exports are generated in-memory and downloaded locally.

The test fixture server logs every request. The E2E suite asserts that the extension adds zero API requests and that a dynamically imported chunk is fetched exactly once, proving the cache-only read did not hit the network.

## Storage location and retention

- Data lives only in `chrome.storage.local` for the current Chrome profile.
- It is keyed by sealed origin.
- It persists until you purge it or remove the extension.
- Incognito is disabled (`"incognito": "not_allowed"`).
- **Context → Local ledger → Purge this origin** deletes the session and index entry.
- **Scope controls → Unseal origin** stops collection and removes host access; it keeps the local ledger until you purge it.

## Threat model

### Page is untrusted

- The MAIN-world hook posts sanitized metadata through `window.postMessage`. A malicious page can see and spoof these messages.
- The isolated-world bridge re-validates shape and value rules; the pipeline validates again.
- Spoofed observations can pollute recon data. They cannot execute code, call APIs, or exfiltrate stored data.
- All dynamic UI values are inserted as text nodes. No `innerHTML`, `eval`, or remote script is used.

### Extension pages are trusted

Popup, DevTools panel and service worker are extension pages. IPC is accepted only from the extension’s own contexts (`sender.id` checks for content events). A web page cannot send internal messages because `externally_connectable` is not configured.

### Host permissions

- No host access is granted at install time.
- A seal requests one exact origin pattern (`https://app.example.com/*`).
- Dynamic content scripts only match that origin.
- Same-site companion hosts are observed through the page’s own traffic; they do not receive host permission or injection.
- Revoking permission in Chrome marks the scope inactive; the UI offers a re-seal path.

### Storage compromise

`chrome.storage.local` is accessible to other extension contexts and to anyone with access to the Chrome profile. Kimbo minimizes the blast radius by refusing to store secrets and PII. It is still recon data: endpoint structure and object IDs can be sensitive. Protect the profile like any pentest artifact.

## What the extension cannot see

- HttpOnly cookies
- Response bodies
- WebSocket or EventSource payloads
- Requests made by service workers outside the page context unless the page itself surfaces them
- Traffic in other tabs, other origins, or before the scope was sealed (unless you reload)

## Auditing

Run:

```bash
python3 -I test/run_tests.py
```

The audit checks:

- exact permission set
- no broad `host_permissions`
- no static `content_scripts`
- no remote code
- one cache-only fetch
- no `sendBeacon`, WebSocket, `chrome.debugger`, `chrome.webRequest`, or `chrome.storage.sync`
- no `innerHTML` or `new Function`
- no remote script/styles in extension pages

Source review starting points:

- `src/collectors/network-hook.js` — what leaves a request
- `src/collectors/script-collector.js` — the sole fetch
- `src/collectors/storage-probe.js` — what is read from storage
- `src/core/normalizer.js` — sensitivity and PII rules
- `src/core/pipeline.js` — what is persisted
- `src/core/exporter.js` — what is exported
