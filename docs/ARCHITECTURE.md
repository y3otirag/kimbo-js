# Architecture

Kimbo JS is a Chrome Manifest V3 extension with four deliberately separated layers. The design goal is to make every displayed value traceable while making accidental requests or accidental secret persistence difficult.

## Invariants

1. **No discovered endpoint is ever called.** There is exactly one `fetch()` call in the extension source (`src/collectors/script-collector.js`) and it uses `cache: 'only-if-cached'`, `mode: 'same-origin'`, `redirect: 'error'`.
2. **No broad host access.** The manifest has no `host_permissions`. Dynamic collectors are registered only after an explicit `chrome.permissions.request` for one origin.
3. **No token, cookie, raw body or response body is persisted.** Sensitive query values are redacted before storage. JWT payloads are decoded only for identity claims and the raw token is discarded.
4. **The service worker does not contain recon logic.** It orchestrates. Normalization, matching, risk and persistence live in `src/core/` and `src/background/session-store.js`.
5. **Every dynamic value in the UI is inserted with `textContent`.** No `innerHTML`, no `eval`, no remote code.
6. **The page is untrusted.** Observations from `window.postMessage` are re-validated in the isolated world and again in the pipeline.

## Layers

### 1. Collectors

| File | World | Responsibility |
|---|---|---|
| `dom-collector.js` | isolated | DOM attributes, forms, data-*, open shadow roots, template content, inline scripts and inline handlers. Inline JS is parsed locally; only route candidates leave the page. |
| `network-hook.js` | MAIN | Wraps `fetch` and `XMLHttpRequest` passively. Captures method/URL/status, ID-shaped body fields, and non-sensitive JWT ID claims. Never posts `Authorization`, cookies or raw bodies. |
| `script-collector.js` | isolated | Relays sanitized network messages; watches `PerformanceObserver` + DOM for SPA chunks; reads bundles cache-only; offers manual-paste fallback. |
| `lifecycle.js` | isolated | Announces document/bfcache and reacts to SPA route changes. |
| `storage-probe.js` | MAIN, via `chrome.scripting.executeScript` | Reads localStorage, sessionStorage, non-HttpOnly cookies and common SSR state globals. Returns only identity-shaped values. |
| `bus.js` | isolated | Batches, deduplicates and ships events. Includes a test-only sink used by the headless harness. |

Collectors do not own route regexes. They produce raw candidates and normalized context candidates using `core/normalizer.js`.

### 2. Normalizer

`src/core/normalizer.js` is the single source of truth for:

- URL/route extraction from strings, template literals and JavaScript bundles
- observed-value → canonical template conversion (`/users/482` → `/users/{user_id}`)
- placeholder inference (`orgs` → `org_id`, `members` → `member_id`)
- ID classification (UUID, Mongo ObjectId, numeric PK, order numbers, hex)
- JWT payload decoding and identity-claim filtering
- context-key normalization (`current_org_id` → `org_id`, `memberId` → `member_id`)
- sensitivity/PII rules
- same-site/origin scope checks
- page URL and query redaction

### 3. Matcher, risk, pipeline

- **Matcher** scores placeholder ↔ context candidates by normalized name, token overlap, alias group, value type compatibility and source provenance. Generic `{id}` matches are capped at low confidence. Type mismatches are excluded. Pins override.
- **Risk** creates a 0–100 hypothesis score from object references, state-changing methods, tenant-shaped paths, query references, GraphQL and observed 2xx state changes. It emits manual test cards and a disclaimer.
- **Pipeline** merges observations into canonical endpoints, deduplicates calls, bounds storage, prunes context, and recomputes enrichment and risk. It is pure and can be unit tested without Chrome APIs.

### 4. Presentation and export

- Popup: compact list, detail, identity lattice, context ledger.
- DevTools panel: master-detail layout, same ledger, passive HAR metadata mirror.
- Exporter: JSON, CSV, Burp site-map URLs, Burp Repeater raw requests, Postman collection.

## Event flow

```text
fetch/XHR (page)
  └─ network-hook (MAIN) ── window.postMessage(sanitized) ──► script-collector (isolated)
                                                                     │
DOM / inline JS ─────────────────────────────────────────────► dom-collector
storage probe (executeScript) ───────────────────────────────► service-worker
chunks / bundles ────────────────────────────────────────────► script-collector
                                                                     │
                                                              KimboBus batch
                                                                     │
                                                              runtime.sendMessage
                                                                     ▼
service worker ──► SessionStore.update ──► Pipeline.ingest ──► chrome.storage.local
                                                                     │
                                                              broadcast summary
                                                                     ▼
                                                           popup / panel (local)
```

Network events are emitted on completion (or on rejection with status 0). The bridge validates URL scheme, length, method, status, claim shapes and field shapes. Duplicate observations are merged by the pipeline within a short window.

## Data model

```text
session = {
  origin, revision, timestamps, scope: { mode: 'origin'|'site' },
  endpoints: {
    [id]: {
      template, pathPattern, pathSegments, placeholders,
      querySamples, methods, calls, sources, pages,
      scope, pins, note,
      enrichment: { confidence, coverage, placeholderResults, queryHints },
      risk: { score, level, label, reasons, hypotheses }
    }
  },
  context: {
    [id]: { key, normKey, value, valueType, sources, firstSeen, lastSeen }
  },
  pages, bundles, identity, stats, dropped, truncated, errors
}
```

Endpoint identity is `origin + pathPattern`, where dynamic segments become `{}`. Observed `/orgs/482` and `/orgs/999` therefore converge, while the placeholder labels and observed values are preserved.

Placeholders keep:

- `name` / `normName` / `display`
- `kind`: `observed` or `template`
- `valueType`
- `observedValue` (never a sensitive value)
- `sensitive` flag

Context entries are deduplicated by `normKey + value`. Sources are merged with provenance. Sensitive entries never enter the dictionary.

## Confidence

| Level | Meaning |
|---|---|
| Pinned | A human explicitly selected this context value. |
| Anchored (high) | Strong name + compatible type + provenance. |
| Likely (medium) | Alias/token overlap + compatible type. |
| Type-only (low) | Generic placeholder matched mainly by value shape. |
| Unanchored | No compatible context match. |

Low-confidence suggestions do **not** override an observed value in prepared URLs. They remain visible as alternatives.

## Why cache-only bundle reading

Re-fetching target resources can invalidate one-time tokens, rotate sessions or trigger side effects. LinkFinder-style tools often request every JS file. Kimbo avoids that:

1. Try `caches.match(url)` (Workbox/precache hit — entirely local).
2. Try `fetch(url, { cache: 'only-if-cached', mode: 'same-origin', credentials: 'same-origin', redirect: 'error' })`.
3. On a cache miss, record `not-cached`.
4. Offer a **Paste JS** modal for bundles from DevTools Sources or Burp.

The test suite asserts that the fixture server sees exactly one request for the dynamic chunk even though Kimbo analyzes it. A page-controlled service worker could observe the cache-only fetch; Kimbo still never calls a discovered API.

## Persistence and bounds

`SessionStore` serializes every read-modify-write through one promise chain to avoid lost updates. It keeps a compact origin index and degrades gracefully on quota errors by aggressively pruning calls/sources/pages/context and then evicting the oldest other sessions.

Caps (per origin): 400 endpoints, 250 context anchors, 8 calls per endpoint, 6 sources per endpoint, 30 pages, 60 bundles, 3 query samples, 8 methods. Every cap writes a truncation counter rather than failing silently.

## Scope model

See [SCOPE-MODEL.md](SCOPE-MODEL.md).

## Test architecture

- Core tests run in headless Chrome without extension APIs.
- E2E loads the real extension through CDP and uses a fixture server that logs every request.
- Collector tests inject the real collector stack into the React SPA and SSR fixture with a test sink.
- UI tests use the real popup/panel pages with a seeded ledger.
- Every source file is compiled by V8 before the behavioral tests.
