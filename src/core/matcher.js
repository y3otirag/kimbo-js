/**
 * Kimbo JS — identity matcher.
 *
 * Maps endpoint placeholders (and ID-shaped query keys) to identity anchors
 * captured from the session. Confidence is intentionally conservative:
 *  - exact/strong name + compatible type  -> high
 *  - alias/token overlap + compatible type -> medium
 *  - generic placeholder matched by type   -> low
 *  - incompatible type                     -> excluded
 *
 * The matcher never reads a token, cookie or request body. It only sees
 * normalized context entries.
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
    root.KimboCore.matcher = factory(root.KimboCore.constants, root.KimboCore.normalizer);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, N) {
  'use strict';

  const LIMITS = C.LIMITS;
  const CONFIDENCE = C.CONFIDENCE;
  const LEVELS = C.LEVELS;

  const GENERIC = new Set([
    'id',
    'uuid',
    'guid',
    'object',
    'object_id',
    'objectid',
    'item',
    'item_id',
    'entity',
    'entity_id',
    'resource',
    'resource_id',
    'key',
    'value'
  ]);

  const ALIAS_GROUPS = [
    ['user', 'member', 'owner', 'customer', 'subject', 'sub', 'profile', 'identity'],
    ['org', 'organization', 'tenant', 'workspace', 'team', 'company', 'business', 'group'],
    ['project', 'repo', 'repository', 'board'],
    ['order', 'invoice', 'purchase', 'transaction'],
    ['file', 'upload', 'document', 'attachment', 'asset', 'media'],
    ['post', 'article', 'comment', 'message', 'ticket', 'issue'],
    ['product', 'item', 'sku'],
    ['role', 'permission', 'scope', 'policy']
  ];

  const ALIAS_INDEX = (function () {
    const index = new Map();
    ALIAS_GROUPS.forEach(function (group, idx) {
      group.forEach(function (token) {
        index.set(token, idx);
      });
    });
    return index;
  })();

  const SOURCE_PRIORITY = {
    jwt: 0.05,
    'request-body': 0.04,
    storage: 0.03,
    cookie: 0.025,
    dom: 0.025,
    query: 0.02,
    path: 0.015,
    unknown: 0
  };

  const SOURCE_LABEL = {
    jwt: 'JWT',
    'request-body': 'body',
    storage: 'storage',
    cookie: 'cookie',
    dom: 'DOM',
    query: 'query',
    path: 'path',
    unknown: 'context'
  };

  function round(value) {
    return Math.round(value * 1000) / 1000;
  }

  function levelFromScore(score) {
    if (score >= CONFIDENCE.HIGH) return LEVELS.HIGH;
    if (score >= CONFIDENCE.MEDIUM) return LEVELS.MEDIUM;
    if (score >= CONFIDENCE.LOW) return LEVELS.LOW;
    return LEVELS.NONE;
  }

  function tokensOf(normKey) {
    return String(normKey || '')
      .split('_')
      .filter(Boolean);
  }

  function meaningfulTokens(normKey) {
    return tokensOf(normKey).filter(function (token) {
      return !GENERIC.has(token);
    });
  }

  function isGenericName(normKey) {
    if (!normKey) return true;
    if (GENERIC.has(normKey)) return true;
    const meaningful = meaningfulTokens(normKey);
    return meaningful.length === 0;
  }

  function aliasGroup(normKey) {
    const tokens = meaningfulTokens(normKey);
    for (const token of tokens) {
      if (ALIAS_INDEX.has(token)) return ALIAS_INDEX.get(token);
    }
    return -1;
  }

  function bestSource(entry) {
    const sources = Array.isArray(entry.sources) ? entry.sources : [];
    let best = { kind: 'unknown', label: 'context', bonus: 0, ts: 0 };
    for (const source of sources) {
      const kind = source && source.kind ? source.kind : 'unknown';
      const bonus = Object.prototype.hasOwnProperty.call(SOURCE_PRIORITY, kind)
        ? SOURCE_PRIORITY[kind]
        : 0;
      if (bonus > best.bonus) {
        best = {
          kind: kind,
          label: source.label || SOURCE_LABEL[kind] || kind,
          bonus: bonus,
          ts: Number(source.ts) || 0
        };
      }
    }
    return best;
  }

  function typeCompatible(observedType, candidateType) {
    if (!observedType || observedType === 'unknown') return { ok: true, bonus: 0.02 };
    if (!candidateType || candidateType === 'unknown') return { ok: true, bonus: 0 };
    const a = N.typeFamily(observedType);
    const b = N.typeFamily(candidateType);
    if (a === 'unknown' || b === 'unknown') return { ok: true, bonus: 0.01 };
    if (a !== b) return { ok: false, bonus: -1 };
    if (a === 'secret' || a === 'email') return { ok: false, bonus: -1 };
    return { ok: true, bonus: 0.06 };
  }

  function nameScore(placeholderNorm, candidateNorm) {
    if (!placeholderNorm || !candidateNorm) {
      return { score: 0, reason: 'no-name' };
    }
    const placeholderGeneric = isGenericName(placeholderNorm);
    const candidateGeneric = isGenericName(candidateNorm);

    if (placeholderNorm === candidateNorm) {
      if (placeholderGeneric) return { score: 0.5, reason: 'generic name' };
      return { score: 0.95, reason: 'exact name' };
    }

    if (placeholderGeneric) {
      return { score: candidateGeneric ? 0.45 : 0.54, reason: 'generic name' };
    }

    if (candidateGeneric) {
      return { score: 0.42, reason: 'generic anchor' };
    }

    if (
      candidateNorm.endsWith('_' + placeholderNorm) ||
      placeholderNorm.endsWith('_' + candidateNorm)
    ) {
      return { score: 0.82, reason: 'key suffix' };
    }

    const pt = meaningfulTokens(placeholderNorm);
    const ct = meaningfulTokens(candidateNorm);
    if (pt.length && ct.length) {
      let intersection = 0;
      for (const token of pt) if (ct.includes(token)) intersection++;
      if (intersection > 0) {
        const union = new Set(pt.concat(ct)).size;
        const jaccard = intersection / union;
        if (pt.every((t) => ct.includes(t)) || ct.every((t) => pt.includes(t))) {
          return { score: 0.84, reason: 'token overlap' };
        }
        return { score: 0.56 + 0.24 * jaccard, reason: 'token overlap' };
      }
    }

    const pg = aliasGroup(placeholderNorm);
    const cg = aliasGroup(candidateNorm);
    if (pg >= 0 && pg === cg) {
      return { score: 0.67, reason: 'alias' };
    }

    return { score: 0, reason: 'no name match' };
  }

  function buildIndex(context) {
    const list = Array.isArray(context)
      ? context
      : context && typeof context === 'object'
        ? Object.values(context)
        : [];
    const byId = new Map();
    const byKey = new Map();
    const byToken = new Map();
    const entries = [];

    for (const entry of list) {
      if (!entry || !entry.id || entry.sensitive) continue;
      if (!N.isUsableContextValue(entry.key, entry.value)) continue;
      const clone = {
        id: entry.id,
        key: entry.key,
        normKey: entry.normKey || N.normalizeKey(entry.key),
        value: String(entry.value),
        valueType: entry.valueType || N.classifyValue(entry.value),
        sources: Array.isArray(entry.sources) ? entry.sources : [],
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen
      };
      entries.push(clone);
      byId.set(clone.id, clone);
      if (!byKey.has(clone.normKey)) byKey.set(clone.normKey, []);
      byKey.get(clone.normKey).push(clone);
      for (const token of meaningfulTokens(clone.normKey)) {
        if (!byToken.has(token)) byToken.set(token, []);
        byToken.get(token).push(clone);
      }
    }

    return { entries: entries, byId: byId, byKey: byKey, byToken: byToken };
  }

  function candidateEntries(normName, index) {
    const set = new Map();
    const exact = index.byKey.get(normName);
    if (exact) for (const entry of exact) set.set(entry.id, entry);

    for (const token of meaningfulTokens(normName)) {
      const tokenEntries = index.byToken.get(token);
      if (tokenEntries) for (const entry of tokenEntries) set.set(entry.id, entry);
    }

    const group = aliasGroup(normName);
    if (group >= 0) {
      for (const entry of index.entries) {
        if (aliasGroup(entry.normKey) === group) set.set(entry.id, entry);
      }
    }

    if (set.size === 0 && isGenericName(normName)) {
      for (const entry of index.entries) {
        if (N.isIdLikeType(entry.valueType)) set.set(entry.id, entry);
        if (set.size >= 24) break;
      }
    }

    return Array.from(set.values());
  }

  function suggestionReason(nameInfo, typeInfo, source, entry, opts) {
    const parts = [];
    if (opts && opts.pinned) {
      parts.push('pinned by you');
    } else {
      parts.push(nameInfo.reason);
      if (typeInfo.bonus > 0) parts.push('type ' + (entry.valueType || 'id'));
      parts.push(source.kind === 'unknown' ? 'context' : SOURCE_LABEL[source.kind] || source.kind);
    }
    return parts.join(' · ');
  }

  function suggestForName(name, observedValue, index, opts) {
    const options = opts || {};
    const normName = N.normalizeKey(name) || 'id';
    const observedType =
      options.observedType && options.observedType !== 'unknown'
        ? options.observedType
        : observedValue != null && observedValue !== ''
          ? N.classifyValue(observedValue)
          : 'unknown';
    const candidates = candidateEntries(normName, index);
    const results = [];
    const seen = new Set();

    if (options.pinContextId) {
      const pinned = index.byId.get(options.pinContextId);
      if (pinned && !pinned.sensitive) {
        results.push({
          contextId: pinned.id,
          contextKey: pinned.normKey,
          confidence: 1,
          level: LEVELS.PINNED,
          reason: 'pinned by you',
          sourceKind: bestSource(pinned).kind,
          sourceLabel: bestSource(pinned).label,
          nameScore: 1,
          typeScore: 0
        });
        seen.add(pinned.id);
      }
    }

    for (const entry of candidates) {
      if (seen.has(entry.id)) continue;
      const typeInfo = typeCompatible(observedType, entry.valueType);
      if (!typeInfo.ok) continue;
      const nameInfo = nameScore(normName, entry.normKey);
      if (nameInfo.score <= 0) continue;
      const source = bestSource(entry);
      let score = nameInfo.score + typeInfo.bonus + source.bonus;
      if (isGenericName(normName)) score = Math.min(score, 0.55);
      if (isGenericName(entry.normKey) && !isGenericName(normName)) {
        score = Math.min(score, 0.5);
      }
      score = Math.max(0, Math.min(0.99, score));
      const level = levelFromScore(score);
      if (level === LEVELS.NONE) continue;
      results.push({
        contextId: entry.id,
        contextKey: entry.normKey,
        confidence: round(score),
        level: level,
        reason: suggestionReason(nameInfo, typeInfo, source, entry, options),
        sourceKind: source.kind,
        sourceLabel: source.label,
        nameScore: round(nameInfo.score),
        typeScore: round(typeInfo.bonus)
      });
      seen.add(entry.id);
    }

    results.sort(function (a, b) {
      if (a.level === LEVELS.PINNED && b.level !== LEVELS.PINNED) return -1;
      if (b.level === LEVELS.PINNED && a.level !== LEVELS.PINNED) return 1;
      return b.confidence - a.confidence;
    });

    return results.slice(0, options.maxSuggestions || LIMITS.maxSuggestionsPerPlaceholder);
  }

  function observedByQueryKey(endpoint) {
    const map = new Map();
    const samples = Array.isArray(endpoint.querySamples) ? endpoint.querySamples : [];
    for (const sample of samples) {
      const pairs = sample && Array.isArray(sample.pairs) ? sample.pairs : [];
      for (const pair of pairs) {
        if (!pair || !pair.key) continue;
        if (pair.redacted || pair.placeholder) continue;
        if (!map.has(pair.key)) {
          map.set(pair.key, {
            key: pair.key,
            value: pair.value,
            valueType: N.classifyValue(pair.value),
            ts: sample.ts || 0
          });
        }
      }
    }
    return map;
  }

  function enrichEndpoint(endpoint, index, opts) {
    const options = opts || {};
    const pins = endpoint.pins && typeof endpoint.pins === 'object' ? endpoint.pins : {};
    const placeholderResults = {};
    const placeholders = Array.isArray(endpoint.placeholders) ? endpoint.placeholders : [];
    let filledCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let pinnedCount = 0;

    for (const ph of placeholders) {
      const suggestions = suggestForName(ph.name, ph.observedValue, index, {
        observedType: ph.valueType,
        pinContextId: pins[ph.id] || null,
        kind: 'path',
        maxSuggestions: LIMITS.maxSuggestionsPerPlaceholder
      });
      const best = suggestions[0] || null;
      placeholderResults[ph.id] = {
        suggestions: suggestions,
        bestContextId: best ? best.contextId : null,
        level: best ? best.level : LEVELS.NONE,
        observedValue: ph.observedValue || null,
        pinned: Boolean(best && best.level === LEVELS.PINNED)
      };
      if (best) {
        filledCount++;
        if (best.level === LEVELS.PINNED) pinnedCount++;
        else if (best.level === LEVELS.HIGH) highCount++;
        else if (best.level === LEVELS.MEDIUM) mediumCount++;
        else if (best.level === LEVELS.LOW) lowCount++;
      }
    }

    const queryHints = {};
    const queryMap = observedByQueryKey(endpoint);
    let queryIndex = 0;
    for (const [key, observed] of queryMap) {
      if (queryIndex++ > 20) break;
      if (!N.isIdKey(key) && !N.isIdLikeType(observed.valueType)) continue;
      if (N.isSensitiveKey(key)) continue;
      const suggestions = suggestForName(key, observed.value, index, {
        observedType: observed.valueType,
        kind: 'query',
        maxSuggestions: 2
      });
      if (!suggestions.length) continue;
      const best = suggestions[0];
      const safeKey = /^(?:__proto__|constructor|prototype)$/i.test(key) ? 'q_' + key : key;
      queryHints[safeKey] = {
        key: key,
        observedValue: observed.value,
        observedType: observed.valueType,
        suggestions: suggestions,
        bestContextId: best.contextId,
        level: best.level,
        differsFromObserved: false
      };
      const entry = index.byId.get(best.contextId);
      if (entry && String(entry.value) !== String(observed.value)) {
        queryHints[safeKey].differsFromObserved = true;
      }
    }

    const placeholderCount = placeholders.length;
    let confidence = LEVELS.NONE;
    if (placeholderCount === 0) {
      confidence = LEVELS.STATIC;
    } else if (filledCount === 0) {
      confidence = LEVELS.NONE;
    } else if (
      filledCount === placeholderCount &&
      highCount + pinnedCount === placeholderCount
    ) {
      confidence = LEVELS.HIGH;
    } else if (
      filledCount === placeholderCount &&
      lowCount === 0
    ) {
      confidence = LEVELS.MEDIUM;
    } else {
      confidence = LEVELS.LOW;
    }

    return {
      updatedAt: Date.now(),
      placeholderResults: placeholderResults,
      queryHints: queryHints,
      placeholderCount: placeholderCount,
      filledCount: filledCount,
      highCount: highCount + pinnedCount,
      mediumCount: mediumCount,
      lowCount: lowCount,
      pinnedCount: pinnedCount,
      coverage: placeholderCount ? round(filledCount / placeholderCount) : 0,
      confidence: confidence,
      note:
        placeholderCount > 0 && filledCount === 0
          ? 'No identity anchor matched these placeholders.'
          : ''
    };
  }

  function bestSuggestion(enrichment, placeholderId) {
    if (!enrichment || !enrichment.placeholderResults) return null;
    const result = enrichment.placeholderResults[placeholderId];
    if (!result || !Array.isArray(result.suggestions) || !result.suggestions.length) return null;
    return result.suggestions[0];
  }

  return {
    buildIndex: buildIndex,
    suggestForName: suggestForName,
    enrichEndpoint: enrichEndpoint,
    bestSuggestion: bestSuggestion,
    levelFromScore: levelFromScore,
    nameScore: nameScore,
    typeCompatible: typeCompatible
  };
});
