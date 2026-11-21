/**
 * Kimbo JS — ingestion pipeline.
 *
 * Turns raw observations into a per-origin evidence ledger:
 *   event -> normalize -> scope filter -> dedupe -> context extraction
 *         -> identity matcher -> risk hypotheses -> bounded storage
 *
 * No network. No endpoint invocation. Every persisted value is bounded and
 * sensitive material (tokens, cookies, bodies, PII) is dropped before storage.
 */
(function (root, factory) {
  'use strict';
  const isNode =
    typeof module === 'object' &&
    module.exports &&
    typeof require === 'function' &&
    typeof window === 'undefined';

  if (isNode) {
    module.exports = factory(
      require('./constants.js'),
      require('./normalizer.js'),
      require('./matcher.js'),
      require('./risk.js')
    );
  } else {
    root.KimboCore = root.KimboCore || {};
    root.KimboCore.pipeline = factory(
      root.KimboCore.constants,
      root.KimboCore.normalizer,
      root.KimboCore.matcher,
      root.KimboCore.risk
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, N, M, R) {
  'use strict';

  const LIMITS = C.LIMITS;
  const LEVELS = C.LEVELS;
  const RISK_LEVELS = C.RISK_LEVELS;
  const SCOPE_MODE = C.SCOPE_MODE;

  const DEFAULT_DROPPED = {
    external: 0,
    static: 0,
    ignored: 0,
    invalid: 0,
    rate: 0
  };

  const DEFAULT_TRUNCATED = {
    endpoints: 0,
    context: 0,
    calls: 0,
    pages: 0,
    bundles: 0
  };

  function nowMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    const now = Date.now();
    if (n > now + 60_000) return now;
    if (n < now - 86_400_000 * 7) return now;
    return Math.trunc(n);
  }

  function createSession(origin, opts) {
    const options = opts || {};
    const now = Date.now();
    return {
      schema: C.SCHEMA_VERSION,
      origin: origin,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      scope: {
        mode:
          options.scope && options.scope.mode === SCOPE_MODE.ORIGIN
            ? SCOPE_MODE.ORIGIN
            : SCOPE_MODE.SITE
      },
      endpoints: {},
      context: {},
      pages: {},
      bundles: {},
      identity: null,
      stats: null,
      dropped: Object.assign({}, DEFAULT_DROPPED),
      truncated: Object.assign({}, DEFAULT_TRUNCATED),
      errors: 0,
      contextCapturedAt: 0,
      lastEventAt: 0,
      lastPageUrl: ''
    };
  }

  function ensure(session, origin) {
    if (!session || typeof session !== 'object') {
      return createSession(origin || '', {});
    }
    if (!session.schema) session.schema = C.SCHEMA_VERSION;
    if (!session.origin && origin) session.origin = origin;
    if (!session.createdAt) session.createdAt = Date.now();
    if (!session.updatedAt) session.updatedAt = session.createdAt;
    if (!Number.isFinite(session.revision)) session.revision = 0;
    if (!session.scope || typeof session.scope !== 'object') {
      session.scope = { mode: SCOPE_MODE.SITE };
    }
    if (session.scope.mode !== SCOPE_MODE.ORIGIN && session.scope.mode !== SCOPE_MODE.SITE) {
      session.scope.mode = SCOPE_MODE.SITE;
    }
    if (!session.endpoints || typeof session.endpoints !== 'object' || Array.isArray(session.endpoints)) {
      session.endpoints = {};
    }
    if (!session.context || typeof session.context !== 'object' || Array.isArray(session.context)) {
      session.context = {};
    }
    if (!session.pages || typeof session.pages !== 'object' || Array.isArray(session.pages)) {
      session.pages = {};
    }
    if (!session.bundles || typeof session.bundles !== 'object' || Array.isArray(session.bundles)) {
      session.bundles = {};
    }
    session.dropped = Object.assign({}, DEFAULT_DROPPED, session.dropped || {});
    session.truncated = Object.assign({}, DEFAULT_TRUNCATED, session.truncated || {});
    if (!Number.isFinite(session.errors)) session.errors = 0;
    if (!Number.isFinite(session.contextCapturedAt)) session.contextCapturedAt = 0;
    if (!Number.isFinite(session.lastEventAt)) session.lastEventAt = 0;
    if (typeof session.lastPageUrl !== 'string') session.lastPageUrl = '';

    for (const endpoint of Object.values(session.endpoints)) {
      if (!endpoint || typeof endpoint !== 'object') continue;
      if (!Array.isArray(endpoint.placeholders)) endpoint.placeholders = [];
      if (!Array.isArray(endpoint.pathSegments)) endpoint.pathSegments = [];
      if (!Array.isArray(endpoint.querySamples)) endpoint.querySamples = [];
      if (!Array.isArray(endpoint.methods)) endpoint.methods = [];
      if (!Array.isArray(endpoint.calls)) endpoint.calls = [];
      if (!Array.isArray(endpoint.sources)) endpoint.sources = [];
      if (!Array.isArray(endpoint.pages)) endpoint.pages = [];
      if (!endpoint.pins || typeof endpoint.pins !== 'object') endpoint.pins = {};
      if (typeof endpoint.note !== 'string') endpoint.note = '';
      if (!endpoint.enrichment) endpoint.enrichment = null;
      if (!endpoint.risk) endpoint.risk = null;
      if (!Number.isFinite(endpoint.firstSeen)) endpoint.firstSeen = Date.now();
      if (!Number.isFinite(endpoint.lastSeen)) endpoint.lastSeen = endpoint.firstSeen;
    }
    for (const entry of Object.values(session.context)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!Array.isArray(entry.sources)) entry.sources = [];
      if (!Number.isFinite(entry.firstSeen)) entry.firstSeen = Date.now();
      if (!Number.isFinite(entry.lastSeen)) entry.lastSeen = entry.firstSeen;
    }
    return session;
  }

  /* ------------------------------------------------------------------ *
   * Context
   * ------------------------------------------------------------------ */

  function mergeSources(target, source) {
    if (!source || !source.kind) return false;
    const label = N.cleanText(source.label || source.kind, 120) || source.kind;
    const existing = target.find((s) => s.kind === source.kind && s.label === label);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.ts = Math.max(existing.ts || 0, source.ts || 0);
      if (source.pageUrl && !existing.pageUrl) existing.pageUrl = source.pageUrl;
      return false;
    }
    target.unshift({
      kind: source.kind,
      label: label,
      pageUrl: N.sanitizePageUrl(source.pageUrl || ''),
      ts: Number(source.ts) || Date.now(),
      count: 1
    });
    if (target.length > 4) target.length = 4;
    return true;
  }

  function addContext(session, candidate, ctx) {
    if (!candidate) return;
    const id = N.stableId('c', candidate.normKey + '\u0000' + candidate.value);
    const existing = session.context[id];
    if (existing) {
      existing.lastSeen = Math.max(existing.lastSeen || 0, candidate.source.ts || ctx.now);
      if (!existing.valueType && candidate.valueType) existing.valueType = candidate.valueType;
      const sourceAdded = mergeSources(existing.sources, candidate.source);
      if (sourceAdded) ctx.contextChanged = true;
      return;
    }
    session.context[id] = {
      id: id,
      key: candidate.key,
      normKey: candidate.normKey,
      value: candidate.value,
      valueType: candidate.valueType || N.classifyValue(candidate.value),
      sensitive: false,
      sources: [],
      firstSeen: candidate.source.ts || ctx.now,
      lastSeen: candidate.source.ts || ctx.now
    };
    mergeSources(session.context[id].sources, candidate.source);
    ctx.contextChanged = true;
  }

  function addContextRaw(session, data, ctx) {
    const candidate = N.makeContextCandidate({
      key: data.key,
      value: data.value,
      source: data.source,
      pageUrl: data.source && data.source.pageUrl,
      now: ctx.now
    });
    if (candidate) addContext(session, candidate, ctx);
  }

  function addClaims(session, claims, source, ctx) {
    if (!Array.isArray(claims)) return;
    for (const claim of claims.slice(0, 12)) {
      if (!claim || !claim.key) continue;
      addContextRaw(
        session,
        {
          key: claim.key,
          value: claim.value,
          source: {
            kind: source.kind,
            label: claim.claim ? source.label + ' ' + claim.claim : source.label,
            pageUrl: source.pageUrl,
            ts: ctx.now
          }
        },
        ctx
      );
    }
  }

  function addBodyFields(session, fields, pageUrl, ctx) {
    if (!Array.isArray(fields)) return;
    for (const field of fields.slice(0, 12)) {
      if (!field || !field.key) continue;
      addContextRaw(
        session,
        {
          key: field.key,
          value: field.value,
          source: {
            kind: 'request-body',
            label: 'request body ' + (field.path || field.key),
            pageUrl: pageUrl,
            ts: ctx.now
          }
        },
        ctx
      );
    }
  }

  function addPageQueryContext(session, rawUrl, ctx) {
    const candidates = N.extractQueryContext(rawUrl, ctx.now);
    for (const candidate of candidates) {
      addContext(session, candidate, ctx);
    }
  }

  function pruneContext(session, ctx) {
    const entries = Object.values(session.context);
    if (entries.length <= LIMITS.maxContext) return 0;
    const referenced = new Set();
    for (const endpoint of Object.values(session.endpoints)) {
      if (endpoint.pins) {
        for (const contextId of Object.values(endpoint.pins)) referenced.add(contextId);
      }
      const enrichment = endpoint.enrichment;
      if (enrichment && enrichment.placeholderResults) {
        for (const result of Object.values(enrichment.placeholderResults)) {
          for (const suggestion of result.suggestions || []) {
            if (suggestion.contextId) referenced.add(suggestion.contextId);
          }
        }
      }
      if (enrichment && enrichment.queryHints) {
        for (const hint of Object.values(enrichment.queryHints)) {
          for (const suggestion of hint.suggestions || []) {
            if (suggestion.contextId) referenced.add(suggestion.contextId);
          }
        }
      }
    }
    const sourceWeight = { jwt: 40, 'request-body': 30, storage: 25, cookie: 20, dom: 18, query: 12, path: 8 };
    const score = (entry) => {
      const ref = referenced.has(entry.id) ? 1000 : 0;
      let source = 0;
      for (const s of entry.sources || []) {
        source = Math.max(source, sourceWeight[s.kind] || 0);
      }
      return ref + source + Math.min(20, Math.max(0, (entry.lastSeen || 0) / 1e12));
    };
    entries.sort((a, b) => score(b) - score(a));
    const keep = new Set(entries.slice(0, LIMITS.maxContext).map((e) => e.id));
    let removed = 0;
    for (const entry of entries) {
      if (!keep.has(entry.id)) {
        delete session.context[entry.id];
        removed++;
      }
    }
    if (removed) session.truncated.context += removed;
    return removed;
  }

  /* ------------------------------------------------------------------ *
   * Pages & bundles
   * ------------------------------------------------------------------ */

  function touchPage(session, rawUrl, title, ts) {
    const url = N.sanitizePageUrl(rawUrl);
    if (!url) return '';
    const existing = session.pages[url];
    if (existing) {
      existing.lastSeen = Math.max(existing.lastSeen || 0, ts);
      existing.count = (existing.count || 1) + 1;
      if (title) existing.title = N.cleanText(title, LIMITS.maxPageTitleLength);
    } else {
      session.pages[url] = {
        url: url,
        title: N.cleanText(title || '', LIMITS.maxPageTitleLength),
        firstSeen: ts,
        lastSeen: ts,
        count: 1
      };
    }
    session.lastPageUrl = url;
    const pages = Object.values(session.pages);
    if (pages.length > LIMITS.maxPages) {
      pages.sort((a, b) => b.lastSeen - a.lastSeen);
      const keep = new Set(pages.slice(0, LIMITS.maxPages).map((p) => p.url));
      for (const page of pages) {
        if (!keep.has(page.url)) {
          delete session.pages[page.url];
          session.truncated.pages++;
        }
      }
    }
    return url;
  }

  function bundleId(url) {
    return N.stableId('b', url);
  }

  function sanitizeBundleUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return { url: '', redacted: false };
    if (/^paste:/i.test(value)) return { url: value, redacted: false };
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: '', redacted: false };
      u.username = '';
      u.password = '';
      u.hash = '';
      let redacted = false;
      const params = new URLSearchParams();
      for (const [key, val] of u.searchParams.entries()) {
        const type = N.classifyValue(val);
        if (N.isSensitiveKey(key) || type === 'jwt' || type === 'token') {
          redacted = true;
          continue;
        }
        params.append(key, val);
      }
      const serialized = params.toString();
      u.search = serialized ? '?' + serialized : '';
      return { url: u.href, redacted: redacted };
    } catch (_) {
      return { url: '', redacted: false };
    }
  }

  function addBundle(session, rawUrl, meta, ctx) {
    const sanitized = sanitizeBundleUrl(rawUrl);
    const url = sanitized.url;
    if (!url || url.length > LIMITS.maxUrlLength) return null;
    if (!/^(?:https?:|paste:)/i.test(url)) return null;

    let targetOrigin = '';
    if (/^https?:/i.test(url)) {
      try {
        targetOrigin = new URL(url).origin;
      } catch (_) {
        return null;
      }
      if (!N.originInScope(session.origin, targetOrigin, session.scope.mode)) {
        session.dropped.external++;
        return null;
      }
    }

    const id = bundleId(url);
    let bundle = session.bundles[id];
    if (!bundle) {
      bundle = {
        id: id,
        url: url,
        origin: targetOrigin,
        host: targetOrigin ? new URL(targetOrigin).host : '',
        status: meta.status || 'pending',
        readable: targetOrigin ? targetOrigin === session.origin && !sanitized.redacted : true,
        redacted: sanitized.redacted,
        firstSeen: ctx.now,
        lastSeen: ctx.now,
        bytes: 0,
        extracted: 0,
        error: '',
        trigger: meta.trigger || '',
        sameOrigin: targetOrigin ? targetOrigin === session.origin : true
      };
      session.bundles[id] = bundle;
    }
    bundle.lastSeen = ctx.now;
    if (meta.status) bundle.status = meta.status;
    if (Number.isFinite(meta.bytes)) bundle.bytes = Math.max(0, Math.trunc(meta.bytes));
    if (Number.isFinite(meta.count)) bundle.extracted = Math.max(0, Math.trunc(meta.count));
    if (meta.error) bundle.error = N.cleanText(meta.error, 180);
    if (meta.trigger) bundle.trigger = N.cleanText(meta.trigger, 40);
    if (meta.via) bundle.via = N.cleanText(meta.via, 30);
    if (targetOrigin) bundle.readable = targetOrigin === session.origin && !sanitized.redacted;
    bundle.redacted = Boolean(bundle.redacted || sanitized.redacted);
    return bundle;
  }

  function pruneBundles(session) {
    const bundles = Object.values(session.bundles);
    if (bundles.length <= LIMITS.maxBundles) return;
    bundles.sort((a, b) => {
      const aScore = (a.status === 'analyzed' ? 100 : 0) + (a.lastSeen || 0) / 1e13;
      const bScore = (b.status === 'analyzed' ? 100 : 0) + (b.lastSeen || 0) / 1e13;
      return bScore - aScore;
    });
    const keep = new Set(bundles.slice(0, LIMITS.maxBundles).map((b) => b.id));
    for (const bundle of bundles) {
      if (!keep.has(bundle.id)) {
        delete session.bundles[bundle.id];
        session.truncated.bundles++;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Endpoints
   * ------------------------------------------------------------------ */

  function placeholderSpecificity(ph) {
    if (!ph) return 0;
    const generic = C.GENERIC_PLACEHOLDERS.includes(ph.normName);
    if (generic) return 1;
    return 2 + String(ph.normName || '').split('_').length;
  }

  function shouldReplacePlaceholderName(existing, incoming) {
    if (!incoming || !incoming.name) return false;
    if (existing.kind !== 'template' && incoming.kind === 'template') return true;
    if (existing.kind === 'template' && incoming.kind !== 'template') return false;
    return placeholderSpecificity(incoming) > placeholderSpecificity(existing);
  }

  function rebuildTemplate(endpoint) {
    const segments = Array.isArray(endpoint.pathSegments) ? endpoint.pathSegments : [];
    const byId = new Map((endpoint.placeholders || []).map((p) => [p.id, p]));
    if (!segments.length) {
      endpoint.template = '/';
      return;
    }
    endpoint.template =
      '/' +
      segments
        .map((parts) =>
          (parts || [])
            .map((part) => {
              if (part.type === 'literal') return part.value;
              const ph = byId.get(part.id);
              return ph ? ph.display : '{id}';
            })
            .join('')
        )
        .join('/');
  }

  function mergePlaceholders(existing, incoming) {
    const byId = new Map((existing || []).map((p) => [p.id, p]));
    let changed = false;
    for (const ph of incoming || []) {
      const current = byId.get(ph.id);
      if (!current) {
        existing.push(ph);
        byId.set(ph.id, ph);
        changed = true;
        continue;
      }
      if (shouldReplacePlaceholderName(current, ph)) {
        current.name = ph.name;
        current.normName = ph.normName;
        current.display = ph.display;
        current.rawName = ph.rawName || current.rawName;
        changed = true;
      }
      if (!current.observedValue && ph.observedValue != null) {
        current.observedValue = ph.observedValue;
        changed = true;
      }
      if ((!current.valueType || current.valueType === 'unknown') && ph.valueType && ph.valueType !== 'unknown') {
        current.valueType = ph.valueType;
        changed = true;
      }
      if (ph.sensitive && !current.sensitive) {
        current.sensitive = true;
        current.observedValue = null;
        changed = true;
      }
      if (!current.segmentIndex && ph.segmentIndex) current.segmentIndex = ph.segmentIndex;
      if (!current.partIndex && ph.partIndex) current.partIndex = ph.partIndex;
    }
    return changed;
  }

  function mergeQuerySample(endpoint, pairs, ts) {
    if (!Array.isArray(pairs) || !pairs.length) return;
    const cleanPairs = pairs.slice(0, LIMITS.maxQueryPairs).map((pair) => ({
      key: pair.key,
      value: pair.value,
      sensitive: Boolean(pair.sensitive),
      pii: Boolean(pair.pii),
      redacted: Boolean(pair.redacted),
      placeholder: Boolean(pair.placeholder)
    }));
    const signature = JSON.stringify(cleanPairs);
    const samples = endpoint.querySamples;
    const existingIndex = samples.findIndex(
      (sample) => JSON.stringify(sample.pairs) === signature
    );
    if (existingIndex >= 0) {
      samples.splice(existingIndex, 1);
    }
    samples.unshift({ pairs: cleanPairs, ts: ts });
    if (samples.length > LIMITS.maxQuerySamples) samples.length = LIMITS.maxQuerySamples;
  }

  function mergeCall(session, endpoint, call, ts) {
    const calls = endpoint.calls;
    const existing = calls.find(
      (c) =>
        c.url === call.url &&
        Math.abs((c.ts || 0) - ts) < 6000 &&
        (c.method === call.method || !c.method || !call.method)
    );
    if (existing) {
      if (!existing.method && call.method) existing.method = call.method;
      if (call.status != null) existing.status = call.status;
      if (call.contentType) existing.contentType = call.contentType;
      existing.ts = Math.max(existing.ts || 0, ts);
      return;
    }
    calls.unshift(call);
    if (calls.length > LIMITS.maxCallsPerEndpoint) {
      calls.length = LIMITS.maxCallsPerEndpoint;
      session.truncated.calls++;
    }
  }

  function mergeEndpoint(session, ep, info, ctx) {
    if (!ep) return null;
    const key = ep.origin + ep.pathPattern;
    let id = N.stableId('e', key);
    if (session.endpoints[id] && session.endpoints[id].pathKey !== key) {
      id = id + N.fnv1a(key + '|collision').slice(0, 4);
    }
    let endpoint = session.endpoints[id];
    const source = info.source || { kind: 'unknown', label: 'observation' };
    const pageUrl = N.sanitizePageUrl(info.pageUrl || ctx.pageUrl || '');
    const ts = nowMs(info.ts || ctx.now);

    if (!endpoint) {
      endpoint = {
        id: id,
        pathKey: key,
        origin: ep.origin,
        host: ep.host,
        pathname: ep.pathname,
        pathPattern: ep.pathPattern,
        template: ep.template,
        pathSegments: ep.pathSegments,
        placeholders: ep.placeholders.slice(),
        querySamples: [],
        methods: [],
        calls: [],
        sources: [],
        pages: [],
        scope: ep.origin === session.origin ? 'origin' : 'site',
        pins: {},
        note: '',
        firstSeen: ts,
        lastSeen: ts,
        enrichment: null,
        risk: null
      };
      session.endpoints[id] = endpoint;
    } else {
      if (mergePlaceholders(endpoint.placeholders, ep.placeholders)) {
        rebuildTemplate(endpoint);
      }
      if (!endpoint.pathSegments || !endpoint.pathSegments.length) {
        endpoint.pathSegments = ep.pathSegments;
        endpoint.pathPattern = ep.pathPattern;
        rebuildTemplate(endpoint);
      }
      endpoint.lastSeen = Math.max(endpoint.lastSeen || 0, ts);
      endpoint.firstSeen = Math.min(endpoint.firstSeen || ts, ts);
      if (ep.origin === session.origin) endpoint.scope = 'origin';
    }

    if (ep.origin === session.origin) endpoint.scope = 'origin';
    else endpoint.scope = 'site';

    mergeQuerySample(endpoint, ep.queryPairs, ts);

    if (info.method) {
      if (!endpoint.methods.includes(info.method)) {
        endpoint.methods.unshift(info.method);
        if (endpoint.methods.length > 8) endpoint.methods.length = 8;
      }
    }

    const sourceKind = source.kind || 'unknown';
    const sourceLabel =
      N.cleanText(source.label || sourceKind, 120) || sourceKind;
    mergeSources(endpoint.sources, {
      kind: sourceKind,
      label: sourceLabel,
      pageUrl: pageUrl,
      ts: ts
    });

    if (pageUrl && !endpoint.pages.includes(pageUrl)) {
      endpoint.pages.unshift(pageUrl);
      if (endpoint.pages.length > 6) endpoint.pages.length = 6;
    }

    if (info.call !== false && (info.method || info.callSource === 'resource')) {
      const callUrl = N.endpointDisplayUrl(ep, { includeQuery: true }) || ep.origin + ep.pathname;
      mergeCall(
        session,
        endpoint,
        {
          method: info.method || null,
          status: N.sanitizeStatus(info.status),
          url: callUrl,
          pageUrl: pageUrl,
          ts: ts,
          source: info.callSource || 'fetch',
          contentType: N.cleanText(info.contentType || '', 100)
        },
        ts
      );
    }

    const candidates = N.endpointContextCandidates(ep, pageUrl, ts);
    for (const candidate of candidates) addContext(session, candidate, ctx);

    return endpoint;
  }

  function pruneEndpoints(session, ctx) {
    const list = Object.values(session.endpoints);
    if (list.length <= LIMITS.maxEndpoints) return;
    const score = (endpoint) => {
      const network = endpoint.sources.some((s) => s.kind === 'network') ? 30 : 0;
      const anchored = endpoint.enrichment && endpoint.enrichment.filledCount ? 15 : 0;
      const risk = endpoint.risk ? endpoint.risk.score : 0;
      const recency = Math.max(0, 30 - (ctx.now - (endpoint.lastSeen || 0)) / 60000);
      const placeholders = Math.min(10, (endpoint.placeholders || []).length * 2);
      return network + anchored + risk + recency + placeholders;
    };
    list.sort((a, b) => score(b) - score(a));
    const keep = new Set(list.slice(0, LIMITS.maxEndpoints).map((e) => e.id));
    for (const endpoint of list) {
      if (!keep.has(endpoint.id)) {
        delete session.endpoints[endpoint.id];
        session.truncated.endpoints++;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Enrichment / identity / stats
   * ------------------------------------------------------------------ */

  function enrichAll(session) {
    const index = M.buildIndex(session.context);
    for (const endpoint of Object.values(session.endpoints)) {
      endpoint.enrichment = M.enrichEndpoint(endpoint, index, {});
      endpoint.risk = R.scoreEndpoint(endpoint);
    }
    session.identity = computeIdentity(session);
  }

  function computeIdentity(session) {
    const entries = Object.values(session.context);
    if (!entries.length) return null;
    const latest = (keys, kinds) => {
      let best = null;
      for (const entry of entries) {
        if (!keys.includes(entry.normKey)) continue;
        const hasKind = (entry.sources || []).some((s) => kinds.includes(s.kind));
        if (!hasKind) continue;
        if (!best || (entry.firstSeen || 0) > (best.firstSeen || 0)) best = entry;
      }
      return best;
    };
    const user =
      latest(['sub', 'user_id', 'member_id', 'owner_id'], ['jwt']) ||
      latest(['user_id', 'member_id', 'owner_id'], ['storage', 'dom', 'query', 'path']);
    const org =
      latest(['org_id', 'tenant_id', 'workspace_id', 'team_id'], ['jwt']) ||
      latest(['org_id', 'tenant_id', 'workspace_id', 'team_id'], ['storage', 'dom', 'query', 'path']);
    if (!user && !org) return null;
    const pack = (entry) =>
      entry
        ? {
            key: entry.normKey,
            value: N.clampString(entry.value, 120),
            valueType: entry.valueType,
            sourceKind: (entry.sources[0] && entry.sources[0].kind) || 'context'
          }
        : null;
    return { user: pack(user), org: pack(org), at: Date.now() };
  }

  function computeStats(session) {
    const endpoints = Object.values(session.endpoints);
    let placeholders = 0;
    let filled = 0;
    let anchored = 0;
    let highConfidence = 0;
    let leadsHigh = 0;
    let leadsMedium = 0;
    for (const endpoint of endpoints) {
      const enrichment = endpoint.enrichment;
      if (enrichment) {
        placeholders += enrichment.placeholderCount || 0;
        filled += enrichment.filledCount || 0;
        if (enrichment.confidence === LEVELS.HIGH) highConfidence++;
        if (enrichment.confidence === LEVELS.HIGH || enrichment.confidence === LEVELS.MEDIUM) {
          anchored++;
        }
      }
      if (endpoint.risk) {
        if (endpoint.risk.level === RISK_LEVELS.HIGH) leadsHigh++;
        else if (endpoint.risk.level === RISK_LEVELS.MEDIUM) leadsMedium++;
      }
    }
    const bundles = Object.values(session.bundles);
    session.stats = {
      endpoints: endpoints.length,
      anchored: anchored,
      highConfidence: highConfidence,
      leadsHigh: leadsHigh,
      leadsMedium: leadsMedium,
      anchors: Object.keys(session.context).length,
      placeholders: placeholders,
      filled: filled,
      bundles: {
        total: bundles.length,
        pending: bundles.filter((b) => b.status === 'pending').length,
        analyzed: bundles.filter((b) => b.status === 'analyzed' || b.status === 'pasted').length,
        notCached: bundles.filter((b) => b.status === 'not-cached').length,
        crossOrigin: bundles.filter((b) => b.status === 'cross-origin').length
      },
      pages: Object.keys(session.pages).length,
      dropped: Object.assign({}, session.dropped),
      truncated: Object.assign({}, session.truncated),
      revision: session.revision,
      contextCapturedAt: session.contextCapturedAt,
      updatedAt: session.updatedAt
    };
    return session.stats;
  }

  /* ------------------------------------------------------------------ *
   * Event ingestion
   * ------------------------------------------------------------------ */

  function ingestNetwork(session, event, ctx) {
    const method = N.sanitizeMethod(event.method);
    const url = typeof event.url === 'string' ? event.url : '';
    if (!url) {
      session.dropped.invalid++;
      return;
    }
    if (N.isBundleUrl(url)) {
      addBundle(session, url, { status: 'pending', trigger: 'network' }, ctx);
      return;
    }
    const ep = N.normalizeEndpoint(url, { baseUrl: event.pageUrl, source: 'network' });
    if (!ep) {
      session.dropped.invalid++;
      return;
    }
    if (!N.originInScope(session.origin, ep.origin, session.scope.mode)) {
      session.dropped.external++;
      return;
    }
    const policy = N.shouldIngestEndpoint(ep, 'network');
    if (!policy.ok) {
      if (policy.reason === 'static') session.dropped.static++;
      else session.dropped.ignored++;
      return;
    }
    const sourceName = String(event.source || 'fetch').toLowerCase();
    const labelPrefix =
      sourceName === 'devtools' ? 'DevTools Network' : sourceName === 'resource' ? 'Resource timing' : sourceName === 'beacon' ? 'Beacon' : sourceName.toUpperCase();
    const status = N.sanitizeStatus(event.status);
    mergeEndpoint(
      session,
      ep,
      {
        method: method,
        status: status,
        pageUrl: event.pageUrl || ctx.pageUrl,
        ts: event.ts,
        contentType: event.contentType,
        source: {
          kind: 'network',
          label: labelPrefix + (method ? ' ' + method : '') + (status != null ? ' ' + status : '')
        },
        callSource: sourceName
      },
      ctx
    );
    addClaims(session, event.authClaims, { kind: 'jwt', label: 'JWT claim', pageUrl: event.pageUrl }, ctx);
    addBodyFields(session, event.bodyFields, event.pageUrl, ctx);
  }

  function ingestDom(session, event, ctx) {
    const candidates = Array.isArray(event.candidates) ? event.candidates.slice(0, LIMITS.maxDomCandidatesPerScan) : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.raw !== 'string') continue;
      const ep = N.normalizeEndpoint(candidate.raw, {
        baseUrl: candidate.baseUrl || event.pageUrl,
        source: 'dom'
      });
      if (!ep) {
        session.dropped.invalid++;
        continue;
      }
      if (!N.originInScope(session.origin, ep.origin, session.scope.mode)) {
        session.dropped.external++;
        continue;
      }
      const kind = candidate.source && candidate.source.kind === 'form' ? 'form' : 'dom';
      const policy = N.shouldIngestEndpoint(ep, kind);
      if (!policy.ok) {
        if (policy.reason === 'static') session.dropped.static++;
        else session.dropped.ignored++;
        continue;
      }
      mergeEndpoint(
        session,
        ep,
        {
          method: N.sanitizeMethod(candidate.method) || (kind === 'form' ? 'GET' : null),
          pageUrl: event.pageUrl,
          ts: event.ts,
          source: {
            kind: kind,
            label:
              (candidate.source && candidate.source.label) ||
              (kind === 'form' ? 'form action' : 'DOM attribute')
          },
          call: false
        },
        ctx
      );
    }

    const context = Array.isArray(event.context) ? event.context.slice(0, LIMITS.maxDomContextPerScan) : [];
    for (const item of context) {
      if (!item) continue;
      addContextRaw(
        session,
        {
          key: item.key,
          value: item.value,
          source: item.source || { kind: 'dom', label: 'DOM value', pageUrl: event.pageUrl }
        },
        ctx
      );
    }
  }

  function ingestScript(session, event, ctx) {
    const urls = Array.isArray(event.urls) ? event.urls.slice(0, 900) : [];
    const baseUrl = event.baseUrl || event.pageUrl;
    const sourceLabel =
      (event.source && event.source.label) || 'script string';
    for (const raw of urls) {
      const ep = N.normalizeEndpoint(raw, { baseUrl: baseUrl, source: 'script' });
      if (!ep) {
        session.dropped.invalid++;
        continue;
      }
      if (!N.originInScope(session.origin, ep.origin, session.scope.mode)) {
        session.dropped.external++;
        continue;
      }
      const policy = N.shouldIngestEndpoint(ep, 'script');
      if (!policy.ok) {
        if (policy.reason === 'static') session.dropped.static++;
        else session.dropped.ignored++;
        continue;
      }
      mergeEndpoint(
        session,
        ep,
        {
          method: null,
          pageUrl: event.pageUrl,
          ts: event.ts,
          source: { kind: 'script', label: sourceLabel },
          call: false
        },
        ctx
      );
    }
  }

  function ingestBundle(session, event, ctx) {
    const url = typeof event.url === 'string' ? event.url : '';
    if (!url) return;
    const bundle = addBundle(
      session,
      url,
      {
        status: event.status || 'pending',
        bytes: event.bytes,
        count: event.count,
        error: event.error,
        trigger: event.trigger,
        via: event.via
      },
      ctx
    );
    if (!bundle) return;
    if (Array.isArray(event.urls) && event.urls.length) {
      ingestScript(
        session,
        {
          kind: 'script',
          urls: event.urls,
          baseUrl: event.baseUrl || url,
          pageUrl: event.pageUrl,
          ts: event.ts,
          source: { kind: 'script', label: 'bundle ' + shortName(url) }
        },
        ctx
      );
    }
  }

  function shortName(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      return parts[parts.length - 1] || u.host;
    } catch (_) {
      return 'pasted script';
    }
  }

  function ingestStorage(session, event, ctx) {
    const entries = Array.isArray(event.entries) ? event.entries.slice(0, LIMITS.maxProbeEntries) : [];
    const pageUrl = event.pageUrl || ctx.pageUrl;
    for (const entry of entries) {
      if (!entry || !entry.key) continue;
      const rawKey = String(entry.key);
      const path = Array.isArray(entry.path) && entry.path.length
        ? entry.path.map((part) => String(part))
        : [rawKey];
      const leaf = path[path.length - 1] || rawKey;
      const key = N.bestContextKey(path, leaf) || rawKey;
      const value = entry.value == null ? '' : String(entry.value);
      const area = String(entry.area || 'storage');
      if (N.classifyValue(value) === 'jwt') {
        const claims = N.identityClaimsFromJwt(value);
        for (const claim of claims) {
          addContextRaw(
            session,
            {
              key: claim.key,
              value: claim.value,
              source: {
                kind: 'jwt',
                label: 'JWT claim ' + claim.claim + ' (' + area + ')',
                pageUrl: pageUrl,
                ts: ctx.now
              }
            },
            ctx
          );
        }
        continue;
      }
      if (
        N.isSensitiveKey(key) ||
        N.isPiiKey(key) ||
        N.isSensitiveKey(rawKey) ||
        N.isPiiKey(rawKey) ||
        (Array.isArray(entry.path) && entry.path.some(function (part) {
          return N.isSensitiveKey(String(part)) || N.isPiiKey(String(part));
        }))
      ) {
        continue;
      }
      if (N.looksLikeUrlCandidate(value)) {
        const ep = N.normalizeEndpoint(value, { baseUrl: pageUrl, source: 'storage' });
        if (!ep) continue;
        const segments = ep.pathname.split('/').filter(Boolean);
        if (segments.length < 2) continue;
        if (!N.originInScope(session.origin, ep.origin, session.scope.mode)) {
          session.dropped.external++;
          continue;
        }
        const policy = N.shouldIngestEndpoint(ep, 'storage');
        if (!policy.ok) {
          if (policy.reason === 'static') session.dropped.static++;
          else session.dropped.ignored++;
          continue;
        }
        mergeEndpoint(
          session,
          ep,
          {
            method: null,
            pageUrl: pageUrl,
            ts: ctx.now,
            source: {
              kind: 'storage',
              label: area + ' ' + key
            },
            call: false
          },
          ctx
        );
        continue;
      }
      addContextRaw(
        session,
        {
          key: key,
          value: value,
          source: {
            kind: area === 'cookie' ? 'cookie' : 'storage',
            label: area + ' ' + key,
            pageUrl: pageUrl,
            ts: ctx.now
          }
        },
        ctx
      );
    }
    session.contextCapturedAt = Date.now();
  }

  function ingestChunk(session, event, ctx) {
    const url = typeof event.url === 'string' ? event.url : '';
    if (!url) return;
    if (!N.isBundleUrl(url)) return;
    let origin;
    try {
      origin = new URL(url).origin;
    } catch (_) {
      return;
    }
    if (!N.originInScope(session.origin, origin, session.scope.mode)) {
      session.dropped.external++;
      return;
    }
    addBundle(
      session,
      url,
      {
        status: origin === session.origin ? 'pending' : 'cross-origin',
        trigger: event.initiatorType || 'chunk'
      },
      ctx
    );
  }

  function ingestPage(session, event, ctx) {
    const rawUrl = event.pageUrl || event.url || '';
    addPageQueryContext(session, rawUrl, ctx);
  }

  function ingestEvent(session, event, ctx) {
    if (!event || typeof event !== 'object') return;
    const ts = nowMs(event.ts);
    session.lastEventAt = Math.max(session.lastEventAt || 0, ts);
    if (event.pageUrl) {
      touchPage(session, event.pageUrl, event.pageTitle || '', ts);
      ctx.pageUrl = N.sanitizePageUrl(event.pageUrl) || ctx.pageUrl;
    }
    switch (event.kind) {
      case 'network':
        ingestNetwork(session, event, ctx);
        break;
      case 'dom':
        ingestDom(session, event, ctx);
        break;
      case 'script':
        ingestScript(session, event, ctx);
        break;
      case 'bundle':
        ingestBundle(session, event, ctx);
        break;
      case 'storage':
        ingestStorage(session, event, ctx);
        break;
      case 'chunk':
        ingestChunk(session, event, ctx);
        break;
      case 'page':
        ingestPage(session, event, ctx);
        break;
      default:
        session.dropped.invalid++;
    }
  }

  function aggressivePrune(session) {
    const ctx = { now: Date.now(), pageUrl: session.lastPageUrl || '' };
    const endpoints = Object.values(session.endpoints);
    endpoints.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const keepEndpoints = new Set(endpoints.slice(0, 150).map((e) => e.id));
    for (const endpoint of endpoints) {
      if (!keepEndpoints.has(endpoint.id)) {
        delete session.endpoints[endpoint.id];
        continue;
      }
      endpoint.calls = (endpoint.calls || []).slice(0, 3);
      endpoint.sources = (endpoint.sources || []).slice(0, 3);
      endpoint.pages = (endpoint.pages || []).slice(0, 4);
      endpoint.querySamples = (endpoint.querySamples || []).slice(0, 1);
    }
    const context = Object.values(session.context);
    context.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const keepContext = new Set(context.slice(0, 100).map((e) => e.id));
    for (const entry of context) {
      if (!keepContext.has(entry.id)) delete session.context[entry.id];
    }
    const bundles = Object.values(session.bundles).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const keepBundles = new Set(bundles.slice(0, 12).map((b) => b.id));
    for (const bundle of bundles) {
      if (!keepBundles.has(bundle.id)) delete session.bundles[bundle.id];
    }
    const pages = Object.values(session.pages).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const keepPages = new Set(pages.slice(0, 10).map((p) => p.url));
    for (const page of pages) {
      if (!keepPages.has(page.url)) delete session.pages[page.url];
    }
    enrichAll(session);
    computeStats(session);
    return ctx;
  }

  function prune(session, opts) {
    const options = opts || {};
    if (options.aggressive) return aggressivePrune(session);
    const ctx = { now: options.now || Date.now(), pageUrl: session.lastPageUrl || '' };
    pruneEndpoints(session, ctx);
    pruneBundles(session);
    pruneContext(session, ctx);
    return session;
  }

  function ingest(session, events, opts) {
    const options = opts || {};
    ensure(session, options.origin);
    if (options.scope && options.scope.mode) {
      session.scope.mode =
        options.scope.mode === SCOPE_MODE.ORIGIN ? SCOPE_MODE.ORIGIN : SCOPE_MODE.SITE;
    }
    const ctx = {
      now: nowMs(options.now || Date.now()),
      pageUrl: N.sanitizePageUrl(options.pageUrl || ''),
      contextChanged: false
    };
    const list = Array.isArray(events) ? events.slice(0, LIMITS.maxEventsPerBatch) : [];
    if (!list.length) {
      computeStats(session);
      return session;
    }
    for (const event of list) {
      try {
        ingestEvent(session, event, ctx);
      } catch (_) {
        session.errors++;
      }
    }
    pruneEndpoints(session, ctx);
    pruneBundles(session);
    enrichAll(session);
    const removedContext = pruneContext(session, ctx);
    if (removedContext) enrichAll(session);
    session.updatedAt = ctx.now;
    session.revision++;
    computeStats(session);
    return session;
  }

  function applyPin(session, payload) {
    ensure(session);
    const endpoint = session.endpoints[payload && payload.endpointId];
    if (!endpoint) return null;
    const placeholderId = payload.placeholderId;
    if (!placeholderId || !(endpoint.placeholders || []).some((p) => p.id === placeholderId)) {
      return null;
    }
    if (!endpoint.pins || typeof endpoint.pins !== 'object') endpoint.pins = {};
    if (!payload.contextId) {
      delete endpoint.pins[placeholderId];
    } else {
      const context = session.context[payload.contextId];
      if (!context || context.sensitive) return null;
      endpoint.pins[placeholderId] = payload.contextId;
    }
    const index = M.buildIndex(session.context);
    endpoint.enrichment = M.enrichEndpoint(endpoint, index, {});
    endpoint.risk = R.scoreEndpoint(endpoint);
    session.identity = computeIdentity(session);
    session.updatedAt = Date.now();
    session.revision++;
    computeStats(session);
    return endpoint;
  }

  function setNote(session, payload) {
    ensure(session);
    const endpoint = session.endpoints[payload && payload.endpointId];
    if (!endpoint) return null;
    endpoint.note = N.cleanText(payload.note || '', LIMITS.maxNoteLength);
    session.updatedAt = Date.now();
    session.revision++;
    computeStats(session);
    return endpoint;
  }

  function importScript(session, payload) {
    ensure(session);
    const text = String((payload && payload.text) || '');
    if (!text || text.length > LIMITS.maxPasteBytes) return { count: 0, bundle: null };
    const baseUrl =
      (payload && payload.baseUrl) ||
      session.lastPageUrl ||
      session.origin + '/';
    const urls = N.extractScriptUrls(text, baseUrl);
    const hash = N.fnv1a(text);
    const url = 'paste:' + hash;
    const event = {
      kind: 'bundle',
      url: url,
      baseUrl: baseUrl,
      status: 'pasted',
      urls: urls,
      bytes: text.length,
      count: urls.length,
      trigger: 'paste',
      ts: Date.now(),
      pageUrl: baseUrl
    };
    ingest(session, [event], { origin: session.origin, scope: session.scope });
    return { count: urls.length, bundle: session.bundles[bundleId(url)] || null };
  }

  function summarize(session) {
    ensure(session);
    if (!session.stats) computeStats(session);
    return {
      origin: session.origin,
      revision: session.revision,
      updatedAt: session.updatedAt,
      stats: session.stats,
      identity: session.identity
    };
  }

  return {
    createSession: createSession,
    ensure: ensure,
    ingest: ingest,
    applyPin: applyPin,
    setNote: setNote,
    importScript: importScript,
    enrichAll: enrichAll,
    computeStats: computeStats,
    computeIdentity: computeIdentity,
    prune: prune,
    aggressivePrune: aggressivePrune,
    summarize: summarize,
    mergeEndpoint: mergeEndpoint,
    touchPage: touchPage
  };
});
