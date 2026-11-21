/* Kimbo JS — UI formatting helpers. */
(function (root) {
  'use strict';
  const UI = (root.KimboUI = root.KimboUI || {});
  const N = root.KimboCore && root.KimboCore.normalizer;

  function relativeTime(ts) {
    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const diff = Math.max(0, Date.now() - value);
    if (diff < 4000) return 'just now';
    if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function absoluteTime(ts) {
    const value = Number(ts);
    if (!Number.isFinite(value) || value <= 0) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch (_) {
      return String(value);
    }
  }

  function methodClass(method) {
    const m = String(method || '').toUpperCase();
    if (m === 'GET') return 'm-get';
    if (m === 'POST') return 'm-post';
    if (m === 'PUT' || m === 'PATCH') return 'm-put';
    if (m === 'DELETE') return 'm-delete';
    if (m === 'HEAD' || m === 'OPTIONS') return 'm-head';
    return 'm-unknown';
  }

  function levelLabel(level) {
    switch (level) {
      case 'pinned':
        return 'Pinned';
      case 'high':
        return 'Anchored';
      case 'medium':
        return 'Likely';
      case 'low':
        return 'Type-only';
      case 'static':
        return 'Static';
      case 'observed':
        return 'Observed';
      default:
        return 'Unanchored';
    }
  }

  function levelClass(level) {
    if (level === 'pinned') return 'conf-pinned';
    if (level === 'high') return 'conf-high';
    if (level === 'medium') return 'conf-medium';
    if (level === 'low') return 'conf-low';
    if (level === 'static') return 'conf-static';
    return 'conf-none';
  }

  function riskLabel(level) {
    if (level === 'high') return 'High attention';
    if (level === 'medium') return 'Review lead';
    if (level === 'low') return 'Watch';
    return 'Info';
  }

  function riskClass(level) {
    if (level === 'high') return 'risk-high';
    if (level === 'medium') return 'risk-medium';
    if (level === 'low') return 'risk-low';
    return 'risk-info';
  }

  function hostOf(origin) {
    try {
      return new URL(origin).host;
    } catch (_) {
      return String(origin || '');
    }
  }

  function hostnameOf(origin) {
    try {
      return new URL(origin).hostname;
    } catch (_) {
      return String(origin || '');
    }
  }

  function shortPath(path, max) {
    const limit = max || 56;
    const value = String(path || '');
    if (value.length <= limit) return value;
    return value.slice(0, Math.max(8, limit - 1)) + '…';
  }

  function statusText(status) {
    if (status == null || status === '') return '—';
    return String(status);
  }

  function statusClass(status) {
    const n = Number(status);
    if (!Number.isFinite(n)) return '';
    if (n >= 200 && n < 400) return '';
    return 'err';
  }

  function bytesLabel(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 102.4) / 10 + ' KB';
    return Math.round(n / (1024 * 1024) * 10) / 10 + ' MB';
  }

  function maskIdentityValue(value) {
    const text = String(value == null ? '' : value);
    if (!text) return '';
    if (text.includes('@')) {
      const at = text.indexOf('@');
      return text.slice(0, 1) + '***' + text.slice(at);
    }
    if (text.length > 28) return text.slice(0, 12) + '…' + text.slice(-4);
    return text;
  }

  function identityParts(identity) {
    if (!identity) return [];
    const out = [];
    if (identity.user) {
      out.push({
        className: 'id-user',
        key: identity.user.key,
        value: maskIdentityValue(identity.user.value),
        raw: identity.user.value,
        source: identity.user.sourceKind
      });
    }
    if (identity.org) {
      out.push({
        className: 'id-org',
        key: identity.org.key,
        value: maskIdentityValue(identity.org.value),
        raw: identity.org.value,
        source: identity.org.sourceKind
      });
    }
    return out;
  }

  function identityText(identity) {
    const parts = identityParts(identity);
    if (!parts.length) return '';
    return parts.map(function (part) {
      return part.key + ' ' + part.value;
    }).join(' · ');
  }

  function plural(count, singular, pluralForm) {
    return count === 1 ? singular : pluralForm || singular + 's';
  }

  function pct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0%';
    return Math.round(n * 100) + '%';
  }

  function confidenceSummary(enrichment) {
    if (!enrichment) return 'no enrichment';
    if (enrichment.placeholderCount === 0) return 'static path';
    return enrichment.filledCount + '/' + enrichment.placeholderCount + ' anchored';
  }

  function sourceKindOf(endpoint) {
    const kinds = new Set((endpoint.sources || []).map(function (source) {
      return source.kind;
    }));
    if (kinds.has('network')) return 'network';
    if (kinds.has('form')) return 'dom';
    if (kinds.has('script')) return 'script';
    if (kinds.has('storage')) return 'storage';
    return 'dom';
  }

  function maskValue(value) {
    if (N && typeof N.maskValue === 'function') return N.maskValue(value);
    return String(value == null ? '' : value);
  }

  UI.format = {
    relativeTime: relativeTime,
    absoluteTime: absoluteTime,
    methodClass: methodClass,
    levelLabel: levelLabel,
    levelClass: levelClass,
    riskLabel: riskLabel,
    riskClass: riskClass,
    hostOf: hostOf,
    hostnameOf: hostnameOf,
    shortPath: shortPath,
    statusText: statusText,
    statusClass: statusClass,
    bytesLabel: bytesLabel,
    maskIdentityValue: maskIdentityValue,
    identityParts: identityParts,
    identityText: identityText,
    plural: plural,
    pct: pct,
    confidenceSummary: confidenceSummary,
    sourceKindOf: sourceKindOf,
    maskValue: maskValue
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
