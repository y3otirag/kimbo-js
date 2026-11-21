/**
 * Kimbo JS — passive risk hypotheses.
 *
 * This is a triage heuristic, not a scanner and not a finding. It highlights
 * places where manual authorization testing (IDOR/BOLA-style) may be worth a
 * pentester's time, using only what the page already exposed.
 */
(function (root, factory) {
  'use strict';
  const isNode =
    typeof module === 'object' &&
    module.exports &&
    typeof require === 'function' &&
    typeof window === 'undefined';

  if (isNode) {
    module.exports = factory(require('./constants.js'), require('./normalizer.js'));
  } else {
    root.KimboCore = root.KimboCore || {};
    root.KimboCore.risk = factory(root.KimboCore.constants, root.KimboCore.normalizer);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, N) {
  'use strict';

  const LEVELS = C.RISK_LEVELS;
  const THRESHOLDS = C.RISK_THRESHOLDS;

  const STATE_CHANGING = new Set(['PUT', 'PATCH', 'DELETE']);
  const ADMIN_WORDS = /(?:admin|internal|export|download|invoice|billing|payment|upload|impersonat|debug|actuator|metrics|backup|restore|transfer|grant|revoke|permission|role|audit|secret|key)/i;
  const ORG_WORDS = /(?:org|organization|tenant|workspace|team|company|business|group)/i;

  function uniqueMethods(endpoint) {
    const methods = Array.isArray(endpoint.methods) ? endpoint.methods : [];
    return Array.from(new Set(methods.filter(Boolean)));
  }

  function scoreEndpoint(endpoint) {
    let score = 0;
    const reasons = [];
    const hypotheses = [];
    const placeholders = Array.isArray(endpoint.placeholders) ? endpoint.placeholders : [];
    const methods = uniqueMethods(endpoint);
    const querySamples = Array.isArray(endpoint.querySamples) ? endpoint.querySamples : [];
    const path = String(endpoint.template || endpoint.pathname || '');
    const pathname = String(endpoint.pathname || '');
    const enrichment = endpoint.enrichment || {};

    const visiblePlaceholders = placeholders.filter((p) => !p.sensitive);
    const sensitivePlaceholders = placeholders.filter((p) => p.sensitive);
    const objectRefs = visiblePlaceholders.length;

    if (objectRefs > 0) {
      const points = Math.min(24, 10 + (objectRefs - 1) * 4);
      score += points;
      reasons.push({
        code: 'object-reference',
        label: 'Object reference in path',
        detail:
          objectRefs +
          ' placeholder' +
          (objectRefs === 1 ? '' : 's') +
          ' can address server-side objects.'
      });
      hypotheses.push(
        'Swap the object reference for one owned by another authorized identity and compare the responses.'
      );
    }

    if (objectRefs >= 2) {
      score += 12;
      reasons.push({
        code: 'nested-object-graph',
        label: 'Nested object graph',
        detail: 'Two or more references in one path invite parent/child mismatch tests.'
      });
      hypotheses.push(
        'Try mismatched parent/child identifiers (for example, a child object from a different parent).'
      );
    }

    const anchored =
      Number(enrichment.highCount || 0) + Number(enrichment.mediumCount || 0);
    if (anchored > 0) {
      score += Math.min(12, 6 + anchored * 2);
      reasons.push({
        code: 'identity-anchored',
        label: 'Identity-anchored values',
        detail:
          anchored +
          ' placeholder' +
          (anchored === 1 ? '' : 's') +
          ' matched session identity context.'
      });
      hypotheses.push(
        'Compare high- and low-privilege sessions against the same anchored object reference.'
      );
    }

    if (methods.some((m) => STATE_CHANGING.has(m))) {
      score += 18;
      reasons.push({
        code: 'state-changing',
        label: 'State-changing method',
        detail: 'Observed methods: ' + methods.join(', ') + '.'
      });
      hypotheses.push('Verify role checks on state-changing requests, not only read access.');
    } else if (methods.includes('POST')) {
      score += 9;
      reasons.push({
        code: 'post',
        label: 'POST surface',
        detail: 'POST was observed; confirm object ownership checks in the handler.'
      });
    }

    if (ADMIN_WORDS.test(pathname)) {
      score += 12;
      reasons.push({
        code: 'sensitive-verb',
        label: 'Sensitive-looking route',
        detail: 'Path contains an administrative, financial or export-like term.'
      });
    }

    if (ORG_WORDS.test(path)) {
      score += 10;
      reasons.push({
        code: 'tenant-bound',
        label: 'Tenant-shaped path',
        detail: 'Path structure suggests tenant or organization scoping.'
      });
    }

    const queryKeys = new Set();
    for (const sample of querySamples) {
      const pairs = sample && Array.isArray(sample.pairs) ? sample.pairs : [];
      for (const pair of pairs) {
        if (!pair || !pair.key || pair.redacted) continue;
        if (N.isIdKey(pair.key) || N.isIdLikeType(N.classifyValue(pair.value))) {
          queryKeys.add(pair.key);
        }
      }
    }
    if (queryKeys.size) {
      score += Math.min(10, 6 + queryKeys.size);
      reasons.push({
        code: 'query-reference',
        label: 'Object reference in query',
        detail: 'Query keys: ' + Array.from(queryKeys).slice(0, 5).join(', ') + '.'
      });
      hypotheses.push(
        'Repeat the request with another authorized identity’s object ID in the query string.'
      );
    }

    if (sensitivePlaceholders.length) {
      score += 6;
      reasons.push({
        code: 'sensitive-placeholder',
        label: 'Sensitive path placeholder',
        detail: 'A token-like segment was intentionally not stored or filled.'
      });
    }

    if (/\/graphql(?:\/|$)/i.test(pathname)) {
      score += 8;
      reasons.push({
        code: 'graphql',
        label: 'GraphQL endpoint',
        detail: 'Field-level authorization and object ownership should be reviewed manually.'
      });
      hypotheses.push(
        'Inspect the schema/introspection manually and test field-level object authorization.'
      );
    }

    const calls = Array.isArray(endpoint.calls) ? endpoint.calls : [];
    const successOnSensitive = calls.some(
      (call) =>
        call &&
        STATE_CHANGING.has(String(call.method || '').toUpperCase()) &&
        Number(call.status) >= 200 &&
        Number(call.status) < 300
    );
    if (successOnSensitive) {
      score += 8;
      reasons.push({
        code: 'observed-success',
        label: 'Successful state change observed',
        detail: 'The page already completed a successful state-changing request.'
      });
    }

    if (endpoint.scope === 'site') {
      score += 3;
      reasons.push({
        code: 'companion-host',
        label: 'Same-site companion host',
        detail: 'Endpoint lives on a companion host observed from the sealed page.'
      });
    }

    score = Math.max(0, Math.min(100, score));

    let level = LEVELS.INFO;
    let label = 'Info';
    if (score >= THRESHOLDS.HIGH) {
      level = LEVELS.HIGH;
      label = 'High attention';
    } else if (score >= THRESHOLDS.MEDIUM) {
      level = LEVELS.MEDIUM;
      label = 'Review lead';
    } else if (score >= THRESHOLDS.LOW) {
      level = LEVELS.LOW;
      label = 'Watch';
    }

    const uniqueHypotheses = Array.from(new Set(hypotheses)).slice(0, 4);
    return {
      score: score,
      level: level,
      label: label,
      reasons: reasons.slice(0, 8),
      hypotheses: uniqueHypotheses,
      disclaimer:
        'Heuristic lead for manual authorization testing inside an authorized scope. Not a vulnerability finding.'
    };
  }

  return { scoreEndpoint: scoreEndpoint };
});
