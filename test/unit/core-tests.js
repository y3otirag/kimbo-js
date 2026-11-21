/* Kimbo JS — core tests. Runs in Chrome headless; no network. */
(function () {
  'use strict';
  const C = KimboCore.constants;
  const N = KimboCore.normalizer;
  const M = KimboCore.matcher;
  const R = KimboCore.risk;
  const P = KimboCore.pipeline;
  const X = KimboCore.exporter;

  const lines = [];
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      passed++;
      lines.push('PASS ' + name);
    } catch (error) {
      failed++;
      lines.push('FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)));
    }
  }

  function ok(value, message) {
    if (!value) throw new Error(message || 'expected truthy');
  }

  function eq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((message || 'not equal') + ' — expected ' + b + ', got ' + a);
  }

  function includes(haystack, needle, message) {
    if (String(haystack).indexOf(needle) === -1) {
      throw new Error(message || 'expected to include ' + needle);
    }
  }

  function excludes(haystack, needle, message) {
    if (String(haystack).indexOf(needle) !== -1) {
      throw new Error(message || 'expected NOT to include ' + needle);
    }
  }

  function b64url(obj) {
    return btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function jwt(payload) {
    return b64url({ alg: 'none', typ: 'JWT' }) + '.' + b64url(payload) + '.sig';
  }

  function ctxEntry(key, value, kind, idSuffix) {
    const normKey = N.normalizeKey(key);
    return {
      id: 'c_' + (idSuffix || normKey) + '_' + String(value),
      key: key,
      normKey: normKey,
      value: String(value),
      valueType: N.classifyValue(String(value)),
      sensitive: false,
      sources: [{ kind: kind || 'storage', label: kind || 'storage', ts: 1 }],
      firstSeen: 1,
      lastSeen: 2
    };
  }

  function ph(id, name, value, type) {
    return {
      id: id,
      name: name,
      normName: N.normalizeKey(name),
      display: '{' + name + '}',
      segmentIndex: 1,
      partIndex: 0,
      kind: value == null ? 'template' : 'observed',
      valueType: type || (value == null ? 'unknown' : N.classifyValue(String(value))),
      observedValue: value == null ? null : String(value),
      sensitive: false
    };
  }

  /* ---------------------------------------------------------------- normalizer */

  test('normalizer: observed URL canonicalizes to typed placeholders', function () {
    const ep = N.normalizeEndpoint('http://app.test/api/orgs/482/users/91?status=active', {
      baseUrl: 'http://app.test/app'
    });
    ok(ep, 'endpoint');
    eq(ep.pathPattern, '/api/orgs/{}/users/{}');
    eq(ep.template, '/api/orgs/{org_id}/users/{user_id}');
    eq(ep.placeholders.map(function (p) { return p.name; }), ['org_id', 'user_id']);
    eq(ep.placeholders.map(function (p) { return p.observedValue; }), ['482', '91']);
    eq(ep.queryPairs[0].key, 'status');
    eq(ep.queryPairs[0].value, 'active');
  });

  test('normalizer: template literals become named placeholders', function () {
    const ep = N.normalizeEndpoint('/api/users/${userId}/files', {
      baseUrl: 'http://app.test/'
    });
    ok(ep);
    eq(ep.template, '/api/users/{user_id}/files');
    eq(ep.placeholders[0].kind, 'template');
    eq(ep.placeholders[0].name, 'user_id');
    eq(ep.placeholders[0].observedValue, null);
  });

  test('normalizer: colon routes become placeholders', function () {
    const ep = N.normalizeEndpoint('/api/users/:id/posts/:postId', {
      baseUrl: 'http://app.test/'
    });
    ok(ep);
    eq(ep.template, '/api/users/{id}/posts/{post_id}');
    eq(ep.placeholders.length, 2);
  });

  test('normalizer: UUID and Mongo ObjectId are recognized', function () {
    const uuid = N.normalizeEndpoint('/api/orgs/550e8400-e29b-41d4-a716-446655440000', {
      baseUrl: 'http://app.test/'
    });
    ok(uuid);
    eq(uuid.placeholders[0].valueType, 'uuid');
    eq(uuid.placeholders[0].name, 'org_id');
    const oid = N.normalizeEndpoint('/api/files/507f1f77bcf86cd799439011', {
      baseUrl: 'http://app.test/'
    });
    ok(oid);
    eq(oid.placeholders[0].valueType, 'objectid');
    eq(oid.placeholders[0].name, 'file_id');
  });

  test('normalizer: static assets and page links are filtered', function () {
    const asset = N.normalizeEndpoint('/static/app.js', { baseUrl: 'http://app.test/' });
    eq(N.shouldIngestEndpoint(asset, 'script').ok, false);
    const css = N.normalizeEndpoint('/assets/app.css', { baseUrl: 'http://app.test/' });
    eq(N.shouldIngestEndpoint(css, 'dom').ok, false);
    const link = N.normalizeEndpoint('/about/team', { baseUrl: 'http://app.test/' });
    eq(N.shouldIngestEndpoint(link, 'dom').ok, false);
    const api = N.normalizeEndpoint('/api/v1/users/91', { baseUrl: 'http://app.test/' });
    eq(N.shouldIngestEndpoint(api, 'dom').ok, true);
    const fetchRoot = N.normalizeEndpoint('/', { baseUrl: 'http://app.test/', source: 'network' });
    eq(N.shouldIngestEndpoint(fetchRoot, 'network').ok, true);
  });

  test('normalizer: sensitive query values are redacted before storage', function () {
    const ep = N.normalizeEndpoint('/api/auth?access_token=SECRET_TOKEN&org_id=482&email=a%40b.test', {
      baseUrl: 'http://app.test/'
    });
    ok(ep);
    const token = ep.queryPairs.find(function (p) { return p.key === 'access_token'; });
    const org = ep.queryPairs.find(function (p) { return p.key === 'org_id'; });
    eq(token.redacted, true);
    eq(token.value, '[redacted]');
    eq(org.value, '482');
    excludes(JSON.stringify(ep.queryPairs), 'SECRET_TOKEN');
  });

  test('normalizer: JWT identity claims exclude email, roles and raw token', function () {
    const token = jwt({
      sub: 'user-91',
      org_id: 482,
      tenant_id: 'acme',
      email: 'tester@example.test',
      roles: ['admin'],
      nested: { project_id: 91 }
    });
    const claims = N.identityClaimsFromJwt(token);
    const keys = claims.map(function (c) { return c.key; });
    ok(keys.indexOf('sub') >= 0, 'sub');
    ok(keys.indexOf('org_id') >= 0, 'org_id');
    ok(keys.indexOf('tenant_id') >= 0, 'tenant_id');
    ok(keys.indexOf('project_id') >= 0, 'project_id');
    eq(keys.indexOf('email'), -1);
    eq(keys.indexOf('roles'), -1);
    excludes(JSON.stringify(claims), token);
    excludes(JSON.stringify(claims), 'tester@example.test');
  });

  test('normalizer: sensitive keys and PII are not usable context', function () {
    eq(N.makeContextCandidate({ key: 'access_token', value: 'SECRET' }), null);
    eq(N.makeContextCandidate({ key: 'email', value: 'a@b.test' }), null);
    eq(N.makeContextCandidate({ key: 'password', value: 'hunter2' }), null);
    ok(N.makeContextCandidate({ key: 'current_org_id', value: '482' }));
    ok(N.makeContextCandidate({ key: 'memberId', value: '17' }));
    eq(N.normalizeKey('current_org_id'), 'org_id');
    eq(N.normalizeKey('memberId'), 'member_id');
    eq(N.normalizeKey('organizations'), 'organization');
  });

  test('normalizer: same-site scope is explicit and origin mode is strict', function () {
    eq(N.siteKey('app.example.co.uk'), 'example.co.uk');
    eq(N.siteKey('api.example.com'), 'example.com');
    ok(N.sameSite('app.example.com', 'api.example.com'));
    eq(N.sameSite('localhost', 'api.localhost'), false);
    eq(N.originInScope('https://app.example.com', 'https://api.example.com', 'site'), true);
    eq(N.originInScope('https://app.example.com', 'https://api.example.com', 'origin'), false);
    eq(N.originInScope('https://app.example.com', 'https://evil.test', 'site'), false);
  });

  test('normalizer: page URLs drop query and fragment before storage', function () {
    eq(N.sanitizePageUrl('http://app.test/app?token=SECRET#x'), 'http://app.test/app');
    eq(N.sanitizePageUrl('chrome://extensions'), '');
  });

  test('normalizer: script strings are extracted without static filtering', function () {
    const source = [
      'fetch("/api/v1/users/${userId}");',
      "const a = '/assets/app.js';",
      'const b = "/graphql";',
      'const c = "https://api.example.com/v1/orgs/1";',
      'const d = "/api/v1/orgs/:orgId/members/:memberId";'
    ].join('\n');
    const urls = N.extractScriptUrls(source, 'http://app.test/assets/chunk.js');
    includes(urls.join('|'), '/api/v1/users/${userId}');
    includes(urls.join('|'), '/assets/app.js');
    includes(urls.join('|'), '/graphql');
    includes(urls.join('|'), 'https://api.example.com/v1/orgs/1');
    includes(urls.join('|'), '/api/v1/orgs/:orgId/members/:memberId');
  });

  /* ------------------------------------------------------------------- matcher */

  const context = [
    ctxEntry('current_org_id', '482', 'storage'),
    ctxEntry('user_id', '91', 'storage'),
    ctxEntry('tenant_id', 'acme', 'storage'),
    ctxEntry('project_id', '91', 'storage')
  ];
  const index = M.buildIndex(context);

  test('matcher: exact name + compatible type is high confidence', function () {
    const suggestions = M.suggestForName('org_id', '482', index, { observedType: 'int' });
    ok(suggestions.length, 'suggestions');
    eq(suggestions[0].level, 'high');
    eq(suggestions[0].contextId, context[0].id);
    includes(suggestions[0].reason, 'exact name');
  });

  test('matcher: member_id aliases to user_id as medium confidence', function () {
    const suggestions = M.suggestForName('member_id', '17', index, { observedType: 'int' });
    ok(suggestions.length, 'suggestions');
    eq(suggestions[0].contextId, context[1].id);
    eq(suggestions[0].level, 'medium');
    includes(suggestions[0].reason, 'alias');
  });

  test('matcher: generic {id} stays type-only / low', function () {
    const suggestions = M.suggestForName('id', '91', index, { observedType: 'int' });
    ok(suggestions.length, 'suggestions');
    eq(suggestions[0].level, 'low');
  });

  test('matcher: incompatible value type is excluded', function () {
    const uuidContext = [ctxEntry('org_id', '550e8400-e29b-41d4-a716-446655440000', 'storage')];
    const uuidIndex = M.buildIndex(uuidContext);
    const suggestions = M.suggestForName('org_id', '482', uuidIndex, { observedType: 'int' });
    eq(suggestions.length, 0);
  });

  test('matcher: query hints surface a different identity value', function () {
    const endpoint = {
      placeholders: [ph('p1', 'org_id', '482', 'int')],
      querySamples: [{ pairs: [{ key: 'org_id', value: '999', redacted: false }], ts: 1 }],
      pins: {}
    };
    const enrichment = M.enrichEndpoint(endpoint, index);
    ok(enrichment.queryHints.org_id, 'query hint');
    eq(enrichment.queryHints.org_id.differsFromObserved, true);
    const entry = index.byId.get(enrichment.queryHints.org_id.bestContextId);
    eq(entry.value, '482');
  });

  test('matcher: a human pin wins over automatic suggestions', function () {
    const endpoint = {
      placeholders: [ph('p1', 'org_id', '482', 'int')],
      querySamples: [],
      pins: { p1: index.byId.get(M.suggestForName('org_id', '91', index, { observedType: 'int' })[0].contextId).id }
    };
    const enrichment = M.enrichEndpoint(endpoint, index);
    eq(enrichment.placeholderResults.p1.suggestions[0].level, 'pinned');
    eq(enrichment.placeholderResults.p1.pinned, true);
  });

  /* ---------------------------------------------------------------------- risk */

  test('risk: tenant object graph + state-changing method is high attention', function () {
    const endpoint = {
      template: '/api/orgs/{org_id}/members/{member_id}',
      pathname: '/api/orgs/482/members/17',
      placeholders: [ph('p1', 'org_id', '482', 'int'), ph('p2', 'member_id', '17', 'int')],
      methods: ['DELETE'],
      querySamples: [],
      calls: [{ method: 'DELETE', status: 204, ts: 1 }],
      enrichment: { highCount: 2, mediumCount: 0 },
      scope: 'origin'
    };
    const risk = R.scoreEndpoint(endpoint);
    eq(risk.level, 'high');
    ok(risk.score >= 65, 'score');
    includes(JSON.stringify(risk.reasons), 'State-changing');
    ok(risk.hypotheses.length > 0, 'hypotheses');
    includes(risk.disclaimer, 'Not a vulnerability finding');
  });

  test('risk: a static read-only path is info', function () {
    const risk = R.scoreEndpoint({
      template: '/api/v1/health',
      pathname: '/api/v1/health',
      placeholders: [],
      methods: ['GET'],
      querySamples: [],
      calls: [],
      enrichment: { highCount: 0, mediumCount: 0 },
      scope: 'origin'
    });
    eq(risk.level, 'info');
    eq(risk.score, 0);
  });

  /* ------------------------------------------------------------------ pipeline */

  function buildSession() {
    const origin = 'http://app.example.test';
    const session = P.createSession(origin, { scope: { mode: 'site' } });
    const now = Date.now();
    const tok = jwt({ sub: 'user-91', org_id: 482, tenant_id: 'acme', email: 'tester@example.test' });
    P.ingest(
      session,
      [
        {
          kind: 'network',
          url: origin + '/api/v1/orgs/482/projects/91?role=admin',
          method: 'GET',
          status: 200,
          source: 'fetch',
          pageUrl: origin + '/app/projects/91',
          ts: now,
          authClaims: N.identityClaimsFromJwt(tok)
        },
        {
          kind: 'network',
          url: origin + '/api/v1/orgs/482/members/17',
          method: 'DELETE',
          status: 204,
          source: 'xhr',
          pageUrl: origin + '/app/members',
          ts: now - 1000
        },
        {
          kind: 'storage',
          entries: [
            { area: 'localStorage', key: 'current_org_id', path: ['current_org_id'], value: '482' },
            { area: 'localStorage', key: 'user_id', path: ['user_id'], value: '91' },
            { area: 'localStorage', key: 'session_token', path: ['session_token'], value: 'SECRET_TOKEN' },
            { area: 'localStorage', key: 'email', path: ['email'], value: 'tester@example.test' }
          ],
          pageUrl: origin + '/app',
          ts: now
        },
        {
          kind: 'network',
          url: 'https://api.example.test/v1/health',
          method: 'GET',
          status: 200,
          source: 'fetch',
          pageUrl: origin + '/app',
          ts: now
        },
        {
          kind: 'network',
          url: 'https://evil.test/api/v1/users/1',
          method: 'GET',
          status: 200,
          source: 'fetch',
          pageUrl: origin + '/app',
          ts: now
        },
        {
          kind: 'network',
          url: origin + '/static/logo.png',
          method: 'GET',
          status: 200,
          source: 'fetch',
          pageUrl: origin + '/app',
          ts: now
        },
        {
          kind: 'network',
          url: origin + '/assets/app.js?token=SECRET_SIGNED&v=2',
          method: 'GET',
          status: 200,
          source: 'fetch',
          pageUrl: origin + '/app',
          ts: now
        }
      ],
      { origin: origin, scope: { mode: 'site' } }
    );
    return session;
  }

  test('pipeline: merges observations into an anchored ledger', function () {
    const session = buildSession();
    eq(Object.keys(session.endpoints).length, 3);
    const orgEndpoint = Object.values(session.endpoints).find(function (e) {
      return e.template.indexOf('/members/') >= 0;
    });
    ok(orgEndpoint);
    eq(orgEndpoint.template, '/api/v1/orgs/{org_id}/members/{member_id}');
    eq(orgEndpoint.enrichment.confidence, 'high');
    eq(orgEndpoint.methods.indexOf('DELETE') >= 0, true);
    ok(session.identity && session.identity.user, 'identity');
    ok(session.stats.endpoints >= 2, 'stats');
  });

  test('pipeline: only same-site hosts are kept in site mode', function () {
    const session = buildSession();
    const hosts = Object.values(session.endpoints).map(function (e) { return e.host; });
    ok(hosts.indexOf('api.example.test') >= 0, 'same-site host kept');
    eq(hosts.indexOf('evil.test'), -1);
    ok(session.dropped.external >= 1, 'external count');
    ok(session.dropped.static >= 1, 'static count');
  });

  test('pipeline: never persists tokens, cookie-like secrets or PII', function () {
    const session = buildSession();
    const serialized = JSON.stringify(session);
    excludes(serialized, 'SECRET_TOKEN');
    excludes(serialized, 'SECRET_SIGNED');
    excludes(serialized, 'tester@example.test');
    excludes(serialized, 'access_token');
    const bundle = Object.values(session.bundles)[0];
    ok(bundle, 'bundle');
    eq(bundle.redacted, true);
    excludes(bundle.url, 'token=');
  });

  test('pipeline: sensitive query values are omitted from the prepared URL', function () {
    const session = P.createSession('http://app.test', {});
    P.ingest(session, [{
      kind: 'network',
      url: 'http://app.test/api/v1/users/91?access_token=SECRET123&org_id=482',
      method: 'GET',
      status: 200,
      source: 'fetch',
      pageUrl: 'http://app.test/app',
      ts: Date.now()
    }], { origin: 'http://app.test', scope: { mode: 'site' } });
    const endpoint = Object.values(session.endpoints)[0];
    const prepared = X.preparedUrl(session, endpoint);
    excludes(prepared, 'SECRET123');
    includes(prepared, 'org_id=482');
  });

  test('pipeline: two observed IDs merge into one canonical endpoint', function () {
    const origin = 'http://app.test';
    const session = P.createSession(origin, {});
    P.ingest(session, [
      { kind: 'network', url: origin + '/api/users/12/posts/1', method: 'GET', status: 200, source: 'fetch', pageUrl: origin + '/a', ts: 1 },
      { kind: 'network', url: origin + '/api/users/13/posts/2', method: 'GET', status: 200, source: 'fetch', pageUrl: origin + '/b', ts: 2 }
    ], { origin: origin, scope: { mode: 'site' } });
    eq(Object.keys(session.endpoints).length, 1);
    const endpoint = Object.values(session.endpoints)[0];
    eq(endpoint.template, '/api/users/{user_id}/posts/{post_id}');
    eq(endpoint.calls.length, 2);
  });

  test('pipeline: human pin changes the prepared URL', function () {
    const session = buildSession();
    const endpoint = Object.values(session.endpoints).find(function (e) {
      return e.template.indexOf('/members/') >= 0;
    });
    const orgPh = endpoint.placeholders.find(function (p) { return p.name === 'org_id'; });
    const otherOrg = P.createSession('http://app.example.test', {});
    const alt = N.makeContextCandidate({
      key: 'org_id',
      value: '999',
      source: { kind: 'storage', label: 'test alt org' }
    });
    P.ingest(otherOrg, [{ kind: 'storage', entries: [{ area: 'localStorage', key: 'org_id', value: '999' }], pageUrl: 'http://app.example.test/app', ts: Date.now() }], { origin: 'http://app.example.test' });
    const altEntry = Object.values(otherOrg.context).find(function (c) { return c.value === '999'; });
    ok(altEntry, 'alt context');
    session.context[altEntry.id] = altEntry;
    P.applyPin(session, {
      endpointId: endpoint.id,
      placeholderId: orgPh.id,
      contextId: altEntry.id
    });
    const prepared = X.preparedUrl(session, endpoint);
    includes(prepared, '/999/');
    ok(endpoint.enrichment.placeholderResults[orgPh.id].pinned, 'pinned');
  });

  test('pipeline: pasted JS extracts routes without fetching', function () {
    const origin = 'http://app.test';
    const session = P.createSession(origin, {});
    const result = P.importScript(session, {
      text: 'const a="/api/v1/users/91/files"; const b=`/api/v1/orgs/482/members/${id}`;',
      baseUrl: origin + '/'
    });
    ok(result.count >= 2, 'count');
    ok(Object.keys(session.endpoints).length >= 2, 'endpoints');
    const bundle = Object.values(session.bundles)[0];
    ok(bundle && bundle.status === 'pasted', 'bundle pasted');
  });

  test('pipeline: context pruning is bounded and keeps referenced anchors', function () {
    const session = P.createSession('http://app.test', {});
    const entries = [];
    for (let i = 0; i < 400; i++) {
      entries.push({
        area: 'localStorage',
        key: 'org_id',
        value: String(1000 + i)
      });
    }
    P.ingest(session, [{
      kind: 'storage',
      entries: entries,
      pageUrl: 'http://app.test/app',
      ts: Date.now()
    }], { origin: 'http://app.test', scope: { mode: 'site' } });
    ok(Object.keys(session.context).length <= C.LIMITS.maxContext, 'context cap');
    ok(session.truncated.context > 0, 'truncation recorded');
  });

  /* ------------------------------------------------------------------ exporter */

  test('exporter: fills high/medium values and keeps observed fallbacks', function () {
    const session = buildSession();
    const endpoint = Object.values(session.endpoints).find(function (e) {
      return e.template.indexOf('/members/') >= 0;
    });
    const url = X.preparedUrl(session, endpoint);
    includes(url, '/orgs/482/members/17');
    const curl = X.toCurl(session, endpoint);
    excludes(curl, 'Authorization');
    excludes(curl, 'Cookie');
    includes(curl, 'curl -X DELETE');
  });

  test('exporter: raw HTTP request preserves underscored placeholders', function () {
    const session = P.createSession('http://app.test', {});
    P.ingest(session, [{
      kind: 'script',
      urls: ['/api/users/${user_id}/files'],
      baseUrl: 'http://app.test/',
      source: { kind: 'script', label: 'inline test' },
      pageUrl: 'http://app.test/app',
      ts: Date.now()
    }], { origin: 'http://app.test', scope: { mode: 'site' } });
    const endpoint = Object.values(session.endpoints)[0];
    const raw = X.rawRequestFor(session, endpoint, 'GET');
    includes(raw, '/api/users/{user_id}/files');
    includes(raw, 'Host: app.test');
    excludes(raw, 'Authorization');
  });

  test('exporter: URLs, CSV and Postman are well formed', function () {
    const session = buildSession();
    const urls = X.toUrlsTxt(session);
    ok(urls.trim().split('\n').length >= 2, 'urls');
    const csv = X.toCSV(session);
    includes(csv, 'prepared_url');
    includes(csv, 'risk_score');
    const postmanText = X.toPostman(session);
    const postman = JSON.parse(postmanText);
    eq(postman.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    ok(postman.item.length >= 1, 'postman folders');
    const itemText = X.toPostmanItem(session, Object.values(session.endpoints)[0], 'GET');
    const item = JSON.parse(itemText);
    ok(item.request.url, 'postman item url');
    excludes(itemText, 'SECRET_TOKEN');
  });

  test('exporter: JSON ledger excludes sensitive material and includes provenance', function () {
    const session = buildSession();
    const text = X.toJSON(session);
    const payload = JSON.parse(text);
    eq(payload.schema, 'kimbojs.ledger.v1');
    includes(text, 'preparedUrl');
    includes(text, 'risk');
    excludes(text, 'SECRET_TOKEN');
    excludes(text, 'SECRET_SIGNED');
    excludes(text, 'tester@example.test');
    excludes(text, 'access_token');
  });

  test('exporter: burp bundle includes raw request blocks and no auth', function () {
    const session = buildSession();
    const text = X.toBurpRequestsTxt(session);
    includes(text, 'HTTP/1.1');
    includes(text, 'Host: app.example.test');
    excludes(text, 'Authorization');
    excludes(text, 'Cookie');
  });

  /* -------------------------------------------------------------------- report */

  const summary = '\nSUMMARY passed=' + passed + ' failed=' + failed;
  const output = lines.join('\n') + summary;
  const pre = document.getElementById('results');
  if (pre) pre.textContent = output;
  document.title = failed ? 'FAIL' : 'PASS';
  document.body.setAttribute('data-failures', String(failed));
})();
