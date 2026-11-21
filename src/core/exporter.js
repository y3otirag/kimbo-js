/**
 * Kimbo JS — export formats.
 *
 * Everything here is text generation. No request is sent and no discovered
 * endpoint is executed. Authentication material is never included: the
 * pentester brings their own session (Burp/browser/Postman).
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
    root.KimboCore.exporter = factory(root.KimboCore.constants, root.KimboCore.normalizer);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, N) {
  'use strict';

  const METHOD_WEIGHT = {
    DELETE: 5,
    PATCH: 4,
    PUT: 3,
    POST: 2,
    GET: 1,
    HEAD: 0,
    OPTIONS: 0
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function uniqueMethods(endpoint) {
    const methods = Array.isArray(endpoint.methods)
      ? endpoint.methods.filter((m) => typeof m === 'string' && m)
      : [];
    return Array.from(new Set(methods));
  }

  function preferredMethod(endpoint) {
    const methods = uniqueMethods(endpoint);
    if (!methods.length) return 'GET';
    return methods.slice().sort((a, b) => {
      return (METHOD_WEIGHT[b] || 0) - (METHOD_WEIGHT[a] || 0);
    })[0];
  }

  function contextOf(session, contextId) {
    return session && session.context ? session.context[contextId] : null;
  }

  function suggestionUsable(level) {
    return level === 'pinned' || level === 'high' || level === 'medium';
  }

  function bestForPlaceholder(session, endpoint, placeholder) {
    const result =
      endpoint.enrichment &&
      endpoint.enrichment.placeholderResults &&
      endpoint.enrichment.placeholderResults[placeholder.id];
    const suggestions = result && Array.isArray(result.suggestions) ? result.suggestions : [];
    const pins = endpoint.pins || {};
    const pinnedId = pins[placeholder.id];

    if (pinnedId) {
      const context = contextOf(session, pinnedId);
      if (context && !context.sensitive) {
        return {
          value: context.value,
          origin: 'pin',
          level: 'pinned',
          confidence: 1,
          contextId: context.id,
          sourceLabel: (context.sources && context.sources[0] && context.sources[0].label) || 'pinned'
        };
      }
    }

    const strong = suggestions.find((s) => suggestionUsable(s.level));
    if (strong) {
      const context = contextOf(session, strong.contextId);
      if (context && !context.sensitive) {
        return {
          value: context.value,
          origin: 'suggested',
          level: strong.level,
          confidence: strong.confidence,
          contextId: context.id,
          sourceLabel: strong.sourceLabel || 'context'
        };
      }
    }

    if (placeholder.observedValue != null && placeholder.observedValue !== '') {
      return {
        value: placeholder.observedValue,
        origin: 'observed',
        level: 'observed',
        confidence: null,
        contextId: null,
        sourceLabel: 'observed in traffic'
      };
    }

    const weak = suggestions[0];
    if (weak) {
      const context = contextOf(session, weak.contextId);
      if (context && !context.sensitive) {
        return {
          value: context.value,
          origin: 'low-suggestion',
          level: weak.level,
          confidence: weak.confidence,
          contextId: context.id,
          sourceLabel: weak.sourceLabel || 'context'
        };
      }
    }

    return {
      value: null,
      origin: 'placeholder',
      level: 'none',
      confidence: null,
      contextId: null,
      sourceLabel: ''
    };
  }

  function bestForQuery(session, endpoint, key) {
    const hints =
      endpoint.enrichment && endpoint.enrichment.queryHints
        ? endpoint.enrichment.queryHints
        : null;
    if (!hints) return null;
    let hint = hints[key] || null;
    if (!hint) {
      for (const candidate of Object.values(hints)) {
        if (candidate && candidate.key === key) {
          hint = candidate;
          break;
        }
      }
    }
    if (!hint || !Array.isArray(hint.suggestions) || !hint.suggestions.length) return null;
    const best = hint.suggestions.find((s) => suggestionUsable(s.level));
    if (!best) return null;
    const context = contextOf(session, best.contextId);
    if (!context || context.sensitive) return null;
    return {
      value: context.value,
      level: best.level,
      confidence: best.confidence,
      contextId: context.id,
      sourceLabel: best.sourceLabel || 'context'
    };
  }

  function buildPreparedUrl(session, endpoint, opts) {
    const options = opts || {};
    const pin = endpoint.pins || {};
    const plan = {};
    const resolver = function (placeholder) {
      if (!placeholder) return null;
      const best = bestForPlaceholder(session, endpoint, placeholder);
      plan[placeholder.id] = best;
      return best.value;
    };
    const path = N.renderPath(endpoint, resolver, { encode: true });

    let query = '';
    if (options.includeQuery !== false) {
      const samples = Array.isArray(endpoint.querySamples) ? endpoint.querySamples : [];
      const sample = samples[0];
      if (sample && Array.isArray(sample.pairs) && sample.pairs.length) {
        const params = new URLSearchParams();
        for (const pair of sample.pairs) {
          if (!pair || pair.redacted || pair.placeholder) continue;
          if (pair.sensitive && options.omitSensitiveQuery !== false) continue;
          let value = pair.value == null ? '' : String(pair.value);
          const hint = bestForQuery(session, endpoint, pair.key);
          if (hint) value = hint.value;
          params.append(pair.key, value);
        }
        const serialized = params.toString();
        if (serialized) query = '?' + serialized;
      }
    }

    return {
      url: (endpoint.origin || '') + path + query,
      path: path,
      plan: plan,
      pins: Object.keys(pin).length
    };
  }

  function preparedUrl(session, endpoint, opts) {
    return buildPreparedUrl(session, endpoint, opts).url;
  }

  function endpointLabel(endpoint) {
    return endpoint.template || endpoint.pathname || '/';
  }

  function selectEndpoints(session, opts) {
    const options = opts || {};
    const all = Object.values(session.endpoints || {});
    const requested = Array.isArray(options.endpointIds) && options.endpointIds.length
      ? new Set(options.endpointIds)
      : null;
    return all
      .filter((endpoint) => {
        if (!endpoint || !endpoint.id) return false;
        if (requested && !requested.has(endpoint.id)) return false;
        if (options.includeSameSite === false && endpoint.scope === 'site') return false;
        return true;
      })
      .sort((a, b) => {
        const ar = a.risk ? a.risk.score : 0;
        const br = b.risk ? b.risk.score : 0;
        if (br !== ar) return br - ar;
        return String(endpointLabel(a)).localeCompare(String(endpointLabel(b)));
      });
  }

  function iso(ts) {
    if (!Number.isFinite(Number(ts))) return '';
    try {
      return new Date(Number(ts)).toISOString();
    } catch (_) {
      return '';
    }
  }

  function serializePlaceholder(session, endpoint, placeholder) {
    const result =
      endpoint.enrichment &&
      endpoint.enrichment.placeholderResults &&
      endpoint.enrichment.placeholderResults[placeholder.id];
    const suggestions = result && Array.isArray(result.suggestions) ? result.suggestions : [];
    const best = bestForPlaceholder(session, endpoint, placeholder);
    return {
      id: placeholder.id,
      name: placeholder.name,
      kind: placeholder.kind,
      valueType: placeholder.valueType,
      sensitive: Boolean(placeholder.sensitive),
      observedValue: placeholder.observedValue || null,
      selected: best,
      suggestions: suggestions.map((suggestion) => {
        const context = contextOf(session, suggestion.contextId);
        return {
          contextId: suggestion.contextId,
          contextKey: suggestion.contextKey,
          value: context ? context.value : null,
          confidence: suggestion.confidence,
          level: suggestion.level,
          reason: suggestion.reason,
          source: suggestion.sourceLabel
        };
      })
    };
  }

  function serializeEndpoint(session, endpoint) {
    const prepared = buildPreparedUrl(session, endpoint);
    return {
      id: endpoint.id,
      origin: endpoint.origin,
      host: endpoint.host,
      scope: endpoint.scope,
      template: endpoint.template,
      pathPattern: endpoint.pathPattern,
      methods: uniqueMethods(endpoint),
      preferredMethod: preferredMethod(endpoint),
      preparedUrl: prepared.url,
      placeholders: (endpoint.placeholders || []).map((placeholder) =>
        serializePlaceholder(session, endpoint, placeholder)
      ),
      querySamples: endpoint.querySamples || [],
      enrichment: endpoint.enrichment
        ? {
            confidence: endpoint.enrichment.confidence,
            coverage: endpoint.enrichment.coverage,
            placeholderCount: endpoint.enrichment.placeholderCount,
            filledCount: endpoint.enrichment.filledCount,
            highCount: endpoint.enrichment.highCount,
            mediumCount: endpoint.enrichment.mediumCount,
            lowCount: endpoint.enrichment.lowCount,
            pinnedCount: endpoint.enrichment.pinnedCount
          }
        : null,
      risk: endpoint.risk || null,
      calls: endpoint.calls || [],
      sources: endpoint.sources || [],
      pages: endpoint.pages || [],
      pins: endpoint.pins || {},
      note: endpoint.note || '',
      firstSeen: iso(endpoint.firstSeen),
      lastSeen: iso(endpoint.lastSeen)
    };
  }

  function serializeContext(session) {
    return Object.values(session.context || {})
      .filter((entry) => entry && !entry.sensitive)
      .map((entry) => ({
        id: entry.id,
        key: entry.key,
        normKey: entry.normKey,
        value: entry.value,
        valueType: entry.valueType,
        sources: entry.sources || [],
        firstSeen: iso(entry.firstSeen),
        lastSeen: iso(entry.lastSeen)
      }));
  }

  function toJSON(session, opts) {
    const options = opts || {};
    const endpoints = selectEndpoints(session, options);
    const payload = {
      schema: 'kimbojs.ledger.v1',
      tool: { name: C.TOOL_NAME, version: C.VERSION },
      generatedAt: nowIso(),
      scope: {
        origin: session.origin,
        mode: session.scope ? session.scope.mode : 'site'
      },
      summary: session.stats || null,
      identity: session.identity || null,
      context: serializeContext(session),
      endpoints: endpoints.map((endpoint) => serializeEndpoint(session, endpoint)),
      bundles: Object.values(session.bundles || {}).map((bundle) => ({
        url: bundle.url,
        origin: bundle.origin,
        status: bundle.status,
        readable: bundle.readable,
        bytes: bundle.bytes,
        extracted: bundle.extracted,
        trigger: bundle.trigger,
        lastSeen: iso(bundle.lastSeen)
      })),
      notes: [
        'All values were observed passively from the sealed page.',
        'No token, cookie, request body or response body is included.',
        'Risk entries are manual-test hypotheses, not vulnerability findings.',
        'Authentication is intentionally absent. Use your own authorized session.'
      ]
    };
    return JSON.stringify(payload, null, 2);
  }

  function csvCell(value) {
    const s = String(value == null ? '' : value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(session, opts) {
    const options = opts || {};
    const endpoints = selectEndpoints(session, options);
    const header = [
      'origin',
      'host',
      'methods',
      'template',
      'prepared_url',
      'confidence',
      'filled',
      'placeholders',
      'risk_level',
      'risk_score',
      'scope',
      'first_seen',
      'last_seen',
      'note'
    ];
    const rows = [header.join(',')];
    for (const endpoint of endpoints) {
      const enrichment = endpoint.enrichment || {};
      const risk = endpoint.risk || {};
      rows.push(
        [
          endpoint.origin,
          endpoint.host,
          uniqueMethods(endpoint).join(' '),
          endpointLabel(endpoint),
          preparedUrl(session, endpoint),
          enrichment.confidence || '',
          enrichment.filledCount == null ? '' : enrichment.filledCount,
          enrichment.placeholderCount == null ? '' : enrichment.placeholderCount,
          risk.level || '',
          risk.score == null ? '' : risk.score,
          endpoint.scope || '',
          iso(endpoint.firstSeen),
          iso(endpoint.lastSeen),
          options.includeNotes === false ? '' : endpoint.note || ''
        ]
          .map(csvCell)
          .join(',')
      );
    }
    return rows.join('\n') + '\n';
  }

  function toUrlsTxt(session, opts) {
    const endpoints = selectEndpoints(session, opts);
    const seen = new Set();
    const lines = [];
    for (const endpoint of endpoints) {
      const url = preparedUrl(session, endpoint);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      lines.push(url);
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function toCurl(session, endpoint, opts) {
    const method = (opts && opts.method) || preferredMethod(endpoint);
    const url = preparedUrl(session, endpoint, opts);
    return (
      '# Kimbo JS — manual request template. No cookies or authorization included.\n' +
      'curl -X ' +
      method +
      ' ' +
      shellQuote(url) +
      " -H 'Accept: application/json'"
    );
  }

  function rawRequestFor(session, endpoint, method, opts) {
    const url = preparedUrl(session, endpoint, opts);
    const placeholders = new Map();
    let index = 0;
    const sentinel = url.replace(/\{([^}]+)\}/g, function (_match, name) {
      const token = 'KIMBOPLACEHOLDER' + index;
      placeholders.set(token, name);
      index++;
      return token;
    });
    let parsed;
    try {
      parsed = new URL(sentinel);
    } catch (_) {
      parsed = null;
    }
    if (!parsed) return '';
    const restore = function (value) {
      return value.replace(/KIMBOPLACEHOLDER(\d+)/g, function (_match, idx) {
        const name = placeholders.get('KIMBOPLACEHOLDER' + idx);
        return name ? '{' + name + '}' : _match;
      });
    };
    const path = restore(parsed.pathname + parsed.search);
    const host = parsed.host;
    return (
      method +
      ' ' +
      path +
      ' HTTP/1.1\n' +
      'Host: ' +
      host +
      '\n' +
      'Accept: application/json\n' +
      (method === 'POST' || method === 'PUT' || method === 'PATCH'
        ? 'Content-Type: application/json\n'
        : '') +
      'Connection: close\n\n'
    );
  }

  function toBurpRequestsTxt(session, opts) {
    const options = opts || {};
    const endpoints = selectEndpoints(session, options);
    const blocks = [
      '# Kimbo JS — raw request bundle',
      '# Paste one block at a time into Burp Repeater.',
      '# No cookies or authorization headers are included.',
      '# Request bodies were not stored by design; add them manually.',
      ''
    ];
    let index = 1;
    for (const endpoint of endpoints) {
      const methods = uniqueMethods(endpoint);
      const list = methods.length ? methods : ['GET'];
      for (const method of list) {
        const raw = rawRequestFor(session, endpoint, method, options);
        if (!raw) continue;
        blocks.push(
          '# ==== ' +
            index++ +
            '. ' +
            method +
            ' ' +
            endpointLabel(endpoint) +
            (endpoint.risk ? ' (risk ' + endpoint.risk.score + ')' : '') +
            ' ===='
        );
        blocks.push(raw);
      }
    }
    return blocks.join('\n');
  }

  function postmanItem(session, endpoint, method, options) {
    const prepared = preparedUrl(session, endpoint, options);
    const description = [
      'Template: ' + endpointLabel(endpoint),
      endpoint.risk
        ? 'Risk hypothesis: ' + endpoint.risk.label + ' (' + endpoint.risk.score + '/100)'
        : 'Risk hypothesis: info',
      endpoint.enrichment
        ? 'Identity coverage: ' + endpoint.enrichment.filledCount + '/' + endpoint.enrichment.placeholderCount
        : '',
      '',
      'No authentication headers or cookies are included. Kimbo JS never sent this request.',
      'Risk labels are heuristics for manual testing, not vulnerability findings.'
    ]
      .filter(Boolean)
      .join('\n');
    return {
      name: method + ' ' + endpointLabel(endpoint),
      request: {
        method: method,
        header: [{ key: 'Accept', value: 'application/json' }],
        url: prepared,
        description: description
      },
      response: []
    };
  }

  function toPostmanItem(session, endpoint, method, opts) {
    const options = opts || {};
    return JSON.stringify(
      postmanItem(session, endpoint, method || preferredMethod(endpoint), options),
      null,
      2
    );
  }

  function toPostman(session, opts) {
    const options = opts || {};
    const endpoints = selectEndpoints(session, options);
    const folders = new Map();

    function folderName(endpoint) {
      const host = endpoint.host || 'host';
      const first = String(endpoint.pathname || '/')
        .split('/')
        .filter(Boolean)[0];
      return host + (first ? ' / ' + first : '');
    }

    endpoints.forEach(function (endpoint) {
      const name = folderName(endpoint);
      if (!folders.has(name)) folders.set(name, []);
      const methods = uniqueMethods(endpoint);
      const list = methods.length ? methods : ['GET'];
      for (const method of list) {
        folders.get(name).push(postmanItem(session, endpoint, method, options));
      }
    });

    const collection = {
      info: {
        name: 'Kimbo JS — ' + session.origin,
        description:
          'Passive endpoint inventory generated by Kimbo JS. No request was sent by the extension. Add your own authorized authentication.',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: Array.from(folders.entries()).map(function ([name, items]) {
        return { name: name, item: items };
      })
    };
    return JSON.stringify(collection, null, 2);
  }

  function safeHost(origin) {
    try {
      return new URL(origin).hostname.replace(/[^a-z0-9.-]/gi, '_');
    } catch (_) {
      return 'scope';
    }
  }

  function stamp() {
    return new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
  }

  function filename(session, format) {
    const base = 'kimbo-' + safeHost(session.origin) + '-' + stamp();
    if (format === 'json') return base + '.json';
    if (format === 'csv') return base + '.csv';
    if (format === 'urls') return base + '-burp-urls.txt';
    if (format === 'burp') return base + '-burp-repeater.txt';
    if (format === 'postman') return base + '.postman_collection.json';
    return base + '.txt';
  }

  function exportSession(session, format, opts) {
    const selected = selectEndpoints(session, opts);
    if (format === 'json') {
      return {
        text: toJSON(session, opts),
        mime: 'application/json',
        filename: filename(session, 'json'),
        count: selected.length
      };
    }
    if (format === 'csv') {
      return {
        text: toCSV(session, opts),
        mime: 'text/csv',
        filename: filename(session, 'csv'),
        count: selected.length
      };
    }
    if (format === 'urls') {
      return {
        text: toUrlsTxt(session, opts),
        mime: 'text/plain',
        filename: filename(session, 'urls'),
        count: selected.length
      };
    }
    if (format === 'burp') {
      return {
        text: toBurpRequestsTxt(session, opts),
        mime: 'text/plain',
        filename: filename(session, 'burp'),
        count: selected.length
      };
    }
    if (format === 'postman') {
      return {
        text: toPostman(session, opts),
        mime: 'application/json',
        filename: filename(session, 'postman'),
        count: selected.length
      };
    }
    throw new Error('unknown-export-format');
  }

  return {
    preferredMethod: preferredMethod,
    uniqueMethods: uniqueMethods,
    buildPreparedUrl: buildPreparedUrl,
    preparedUrl: preparedUrl,
    bestForPlaceholder: bestForPlaceholder,
    bestForQuery: bestForQuery,
    selectEndpoints: selectEndpoints,
    serializeEndpoint: serializeEndpoint,
    toJSON: toJSON,
    toCSV: toCSV,
    toUrlsTxt: toUrlsTxt,
    toCurl: toCurl,
    rawRequestFor: rawRequestFor,
    toBurpRequestsTxt: toBurpRequestsTxt,
    toPostman: toPostman,
    toPostmanItem: toPostmanItem,
    exportSession: exportSession,
    filename: filename
  };
});
