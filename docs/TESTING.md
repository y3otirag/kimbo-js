# Testing

## Requirements

- Chrome/Chromium 111+ (`google-chrome` by default; override with `KIMBO_CHROME`)
- Python 3.10+
- No Node, npm, Selenium or Playwright dependency

## Run everything

```bash
python3 -I test/run_tests.py
```

Expected last line:

```text
passed=170 failed=0
```

Options:

```bash
python3 -I test/run_tests.py --skip-e2e   # audit + core only
python3 -I test/run_tests.py --skip-core  # audit + e2e only
python3 -I test/e2e/smoke.py              # e2e only
```

## Layers

### 1. Audit

Checks:

- manifest v3, exact permission set, no broad `host_permissions`, no static `content_scripts`
- optional host permissions are only the two HTTP(S) wildcards
- CSP restricts scripts/objects to self
- all manifest assets and local page scripts/styles exist
- no remote scripts or styles in extension pages
- no `eval` except `chrome.devtools.inspectedWindow.eval('location.origin')`
- no `new Function`, `innerHTML`, `sendBeacon`, WebSocket, EventSource
- no `chrome.debugger`, `chrome.webRequest`, `chrome.storage.sync`, `tabCapture`
- fetch exists only in the passive hook and the cache-only bundle reader
- the cache-only reader uses `only-if-cached`, same-origin mode and redirect rejection
- every dynamically registered content-script file exists

### 2. Core tests

`test/unit/core-tests.html` runs in headless Chrome (`--dump-dom`) and tests:

- route canonicalization, template literals, colon routes, UUIDs, ObjectIds
- static/page-link filtering, same-site scope, sensitive query redaction
- JWT claim filtering (no email, roles or raw token)
- matcher exact/alias/generic/type-mismatch/pin behavior
- risk scores and manual-test hypotheses
- pipeline dedupe, same-site filtering, bundle URL redaction, pin overrides, paste import, context caps
- exporter JSON/CSV/URLs/Burp/Postman and no secret inclusion

### 3. End-to-end

`test/e2e/smoke.py`:

1. starts `test/fixtures/server.py` (logs every request);
2. launches headless Chrome with `--enable-unsafe-extension-debugging`;
3. loads the unpacked extension through CDP `Extensions.loadUnpacked`;
4. compiles every source file with V8;
5. verifies the real service worker loads constants/normalizer/matcher/risk/pipeline/exporter/probe/store/scope manager;
6. seeds a ledger and exercises the real popup and DevTools panel;
7. injects the real collector stack into:
   - a **React 18 SPA** (`test/fixtures/spa.html`) with fetch, XHR, dynamic import, `history.pushState`, open shadow DOM and inline scripts;
   - a **server-rendered page** (`test/fixtures/ssr.html`) with links, forms, meta tags and inline JS;
8. asserts:
   - GET/PATCH/DELETE/POST are observed;
   - JWT ID claims are captured but the raw JWT never crosses the bridge;
   - CSRF/password fixtures are not collected;
   - DOM, form, data-* and shadow-DOM routes are found;
   - a dynamic chunk is detected and analyzed from cache;
   - the storage probe reads org/user IDs and skips secrets/PII;
   - SPA and SSR page lifecycle events fire;
   - no collector runtime exceptions;
   - the fixture server sees **exactly the page’s own 7 + 2 API calls** and **exactly one** request for the dynamic chunk.

The last two points are the core safety proof: Kimbo added no API requests, and its cache-only bundle read did not re-fetch the chunk.

## Why the native permission prompt is manual

`chrome.permissions.request` opens a native Chrome permission bubble. Headless Chrome cannot accept it, and the callback never fires, so the automated suite stops at the scope gate.

Everything before the prompt is covered (gate rendering, origin/tab resolution, permission request code, busy state) and everything after it is covered by the collector, pipeline, store, UI and export tests. To validate the native prompt + dynamic registration + injection end to end, perform the manual test below.

## Manual scope-seal test

```bash
python3 -I test/fixtures/server.py --port 8080
```

1. Load the extension unpacked.
2. Open `http://127.0.0.1:8080/spa.html`.
3. Click the Kimbo JS toolbar icon.
4. Confirm the gate shows `http://127.0.0.1:8080`.
5. Leave **Include same-site API hosts** checked and click **Seal this origin**.
6. Accept Chrome’s permission prompt.
7. The header should switch to `SEALED`.
8. Reload the page.
9. Open Kimbo. Expect endpoints such as:
   - `/api/v1/orgs/{org_id}/projects/{project_id}/members`
   - `/api/v1/orgs/{org_id}/members/{member_id}`
   - `/api/v1/orgs/{org_id}/billing/invoices/{invoice_id}`
   - `/graphql`
   - routes from the dynamic chunk.
10. Expect identity anchors `org_id=482`, `user_id=91`, `tenant_id=acme`, `project_id=91`, `member_id=17`.
11. Confirm no `FIXTURE_CSRF_SECRET`, `FIXTURE_PASSWORD` or raw JWT appears anywhere in the UI.
12. Open **Context → JS bundles**; the chunk should be `analyzed` (cache-only). Click **Read cached** if needed.
13. Click **Capture context**; the context time should update.
14. Click an endpoint; pin a value; confirm the prepared URL changes.
15. Export JSON; confirm it contains `preparedUrl`, risk and provenance, but no token/cookie/body.
16. Watch the server log. Only the SPA’s own API calls should appear; Kimbo must not add any.
17. Open DevTools → **Kimbo JS** panel; confirm the same ledger and the identity lattice.
18. Open `http://127.0.0.1:8080/ssr.html`, seal the same origin (already sealed), reload, and confirm SSR links/forms/inline routes appear.
19. Unseal the origin; confirm collection stops and the ledger remains as a read-only snapshot.
20. Purge the origin; confirm the ledger disappears.

### Expected fixture API calls

SPA:

```text
GET  /api/v1/orgs/482/projects/91/members
GET  /api/v1/users/91/profile
PATCH /api/v1/orgs/482/projects/91
DELETE /api/v1/orgs/482/members/17
POST /api/v1/orgs/482/invites
GET  /api/v1/orgs/482/billing/invoices/INV-2026-0042
POST /graphql
```

SSR adds:

```text
GET  /api/v1/orgs/482/ssr/99
POST /api/v1/orgs/482/ssr/actions
```

## Debugging

- `chrome://extensions` → Kimbo JS → **Errors** for manifest/service-worker errors.
- **Inspect views: service worker** for `console.warn('[Kimbo] …')`.
- `chrome://extensions` → **Reload** after code changes, then reload the target tab.
- If the popup shows `UNSEALED` after granting, check `chrome://extensions` → Details → Site access.
- If bundles show `not-cached`, use **Paste JS**; the browser had no local copy.
- E2E logs are printed at the end (`chrome_log=…`, `fixture_log=…`).

## CI notes

- Headless Chrome supports extension loading only through CDP `Extensions.loadUnpacked` on branded builds in this environment; the test helper uses that path.
- The suite binds only to `127.0.0.1`.
- No external network is required at runtime; React is vendored.
