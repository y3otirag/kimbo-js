/**
 * Kimbo JS — normalizer.
 *
 * Single source of truth for:
 *  - URL / route extraction from DOM strings, inline JS and bundles
 *  - placeholder inference and canonical route patterns
 *  - ID classification (UUID, Mongo ObjectId, numeric PK, order numbers)
 *  - JWT claim extraction (payload only; signature is never verified)
 *  - context-key normalization and sensitivity rules
 *  - site/origin scope checks
 *
 * No network access. No code execution. Everything here is pure parsing.
 */
(function (root, factory) {
  'use strict';
  const isNode =
    typeof module === 'object' &&
    module.exports &&
    typeof require === 'function' &&
    typeof window === 'undefined';

  if (isNode) {
    module.exports = factory(require('./constants.js'));
  } else {
    root.KimboCore = root.KimboCore || {};
    root.KimboCore.normalizer = factory(root.KimboCore.constants);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  const LIMITS = C.LIMITS;

  const STATIC_EXT_RE = /\.(?:m?js|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|pdf|zip|gz|tgz|rar|7z|tar|wasm|exe|dmg|apk|ipa|bin)$/i;
  const BUNDLE_EXT_RE = /\.(?:m?js|cjs)$/i;
  const API_EXT_RE = /\.(?:json|xml|graphql|gql|php|aspx?|jsp|do|action|cgi|ashx|svc)$/i;
  const API_HINT_RE = /(?:^|\/)(?:api|apis|rest|graphql|gql|rpc|services?|internal|admin|auth|oauth|sso|actuator|metrics|debug|v\d+|__graphql)(?:\/|$)/i;
  const RESOURCE_HINT_RE = /(?:^|\/)(?:users?|accounts?|orgs?|organizations?|tenants?|members?|customers?|owners?|orders?|invoices?|payments?|projects?|workspaces?|teams?|files?|uploads?|documents?|reports?|billing|subscriptions?|sessions?|permissions?|roles?|groups?|devices?|assets?|tickets?|posts?|articles?|comments?|messages?|notifications?|events?|jobs?|tasks?|products?|items?|carts?|checkouts?)(?:\/|$)/i;
  const AUTH_HINT_RE = /(?:^|\/)(?:login|logout|signin|sign-in|signup|sign-up|token|oauth|authorize|consent|password|mfa|otp|saml|sso)(?:\/|$)/i;
  const PAGE_PREFIX_RE = /^\/(?:about|blog|docs?|help|support|pricing|company|careers?|contact|legal|terms|privacy|features?|solutions?|customers?|resources?|team|events?|news|press|partners?|community|academy|guides?|tutorials?)(?:\/|$)/i;
  const GENERIC_KEY_RE = /^(?:id|uuid|guid|object_id|objectid|item_id|entity_id|resource_id|key|value|sub|subject|uid|oid)$/;
  const DATE_CONTEXT_RE = /^(?:date|day|month|year|week|timestamp|time|since|until)$/i;
  const SAFE_METHOD_RE = /^[A-Z]{3,12}$/;
  const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const IPV6_RE = /^\[?[0-9a-f:]+\]?$/i;

  const UNCOUNTABLE = new Set([
    'address',
    'analysis',
    'alias',
    'audio',
    'bus',
    'class',
    'data',
    'equipment',
    'fish',
    'information',
    'media',
    'metadata',
    'news',
    'process',
    'series',
    'species',
    'status',
    'storage',
    'traffic'
  ]);

  const SES_EXCEPTIONS = Object.freeze({
    analyses: 'analysis',
    bases: 'base',
    cases: 'case',
    changes: 'change',
    databases: 'database',
    hypotheses: 'hypothesis',
    licenses: 'license',
    phases: 'phase',
    purchases: 'purchase',
    responses: 'response',
    releases: 'release',
    services: 'service',
    uses: 'use'
  });

  const MULTI_LABEL_SUFFIXES = new Set([
    'ac.il',
    'ac.uk',
    'co.id',
    'co.il',
    'co.in',
    'co.jp',
    'co.kr',
    'co.nz',
    'co.uk',
    'co.za',
    'com.ar',
    'com.au',
    'com.bo',
    'com.br',
    'com.cn',
    'com.co',
    'com.do',
    'com.ec',
    'com.eg',
    'com.gt',
    'com.hk',
    'com.hn',
    'com.mx',
    'com.my',
    'com.ng',
    'com.ni',
    'com.pa',
    'com.pe',
    'com.ph',
    'com.pk',
    'com.py',
    'com.sa',
    'com.sg',
    'com.sv',
    'com.tr',
    'com.tw',
    'com.uy',
    'com.ve',
    'com.vn',
    'gov.il',
    'gov.uk',
    'net.il',
    'org.il',
    'org.uk'
  ]);

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  function fnv1a(input) {
    const str = String(input == null ? '' : input);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function stableId(prefix, value) {
    const str = String(value == null ? '' : value);
    return prefix + '_' + fnv1a(str) + (str.length % 97).toString(36);
  }

  function clampString(value, max) {
    const s = String(value == null ? '' : value);
    return s.length > max ? s.slice(0, max) : s;
  }

  function cleanText(value, max) {
    const s = String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return String(value);
    }
  }

  function normalizeMethod(value) {
    const s = String(value == null ? '' : value).trim().toUpperCase();
    return SAFE_METHOD_RE.test(s) ? s : null;
  }

  function normalizeStatus(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const i = Math.trunc(n);
    return i >= 0 && i <= 599 ? i : null;
  }

  function singularize(word) {
    let w = String(word == null ? '' : word).toLowerCase();
    if (!w) return w;
    if (UNCOUNTABLE.has(w)) return w;
    if (SES_EXCEPTIONS[w]) return SES_EXCEPTIONS[w];
    if (w.endsWith('ies') && w.length > 3) return w.slice(0, -3) + 'y';
    if (/(?:ches|shes|xes|zes)$/.test(w)) return w.slice(0, -2);
    if (w.endsWith('sses')) return w.slice(0, -2);
    if (w.endsWith('ses')) {
      const withoutEs = w.slice(0, -2);
      if (withoutEs.endsWith('s')) return withoutEs;
      return w.slice(0, -1);
    }
    if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  }

  /**
   * Normalizes camelCase / dotted / sloppy keys into snake_case anchor names.
   * Context prefixes such as "current_", "selected_" and "my_" are removed so
   * `current_org_id` and `org_id` converge.
   */
  function normalizeKey(key) {
    let k = String(key == null ? '' : key).trim();
    if (!k) return '';
    k = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    k = k.toLowerCase();
    k = k.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    k = k.replace(
      /^(?:current|selected|active|my|the|authenticated|logged_in|loggedin|user_selected|app|ui)_+/,
      ''
    );
    if (!k) return '';
    const parts = k.split('_').filter(Boolean);
    if (parts.length > 1 && parts[parts.length - 1] === 'id') {
      const prefix = parts.slice(0, -1).join('_');
      return singularize(prefix) + '_id';
    }
    return singularize(k);
  }

  function isSensitiveKey(key) {
    const k = String(key == null ? '' : key).toLowerCase().trim();
    if (!k) return false;
    if (/^(?:code|state|nonce|otp|password|passwd|pwd|token|secret|authorization|signature|sig|jwt)$/.test(k)) {
      return true;
    }
    if (
      /(?:^|[._-])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|session(?:[_-]?id)?|csrf|xsrf|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|auth[_-]?code|oauth[_-]?code|signature|sig|nonce|otp|password|passwd|pwd|credential|cookie|jwt)(?:[._-]|$)/i.test(
        k
      )
    ) {
      return true;
    }
    if (/(?:token|secret|password|passwd|csrf|xsrf|api[_-]?key)$/i.test(k)) return true;
    return false;
  }

  function isPiiKey(key) {
    const k = String(key == null ? '' : key).toLowerCase().trim();
    if (!k) return false;
    return /(?:^|[._-])(?:e?mail|phone|mobile|telephone|address|street|ssn|cpf|cnpj|rg|passport|birth|birthday|dob|first[_-]?name|last[_-]?name|full[_-]?name|username|user[_-]?name|name)(?:[._-]|$)/i.test(
      k
    );
  }

  function isIdKey(key) {
    const norm = normalizeKey(key);
    if (!norm) return false;
    if (isSensitiveKey(key) || isPiiKey(key)) return false;
    if (GENERIC_KEY_RE.test(norm)) return true;
    if (/_id$|_uuid$|_guid$/.test(norm)) return true;
    const tokens = norm.split('_');
    return tokens.some((t) =>
      [
        'org',
        'organization',
        'tenant',
        'user',
        'member',
        'account',
        'owner',
        'project',
        'workspace',
        'team',
        'order',
        'invoice',
        'file',
        'upload',
        'document',
        'report',
        'customer',
        'role',
        'group',
        'device',
        'asset',
        'ticket',
        'post',
        'article',
        'comment',
        'message',
        'notification',
        'event',
        'job',
        'task',
        'product',
        'item',
        'cart',
        'checkout',
        'subscription',
        'payment',
        'payment_method',
        'subject'
      ].includes(t)
    );
  }

  function classifyValue(value) {
    if (value == null) return 'empty';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'string';
      return Number.isInteger(value) ? 'int' : 'string';
    }
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value !== 'string') return 'object';
    const v = value.trim();
    if (!v) return 'empty';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'uuid';
    if (/^[0-9a-f]{24}$/i.test(v)) return 'objectid';
    if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/.test(v)) return 'jwt';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
    if (/^\d{1,20}$/.test(v)) return 'int';
    if (/^(?:0x)?[0-9a-f]{16,64}$/i.test(v)) return 'hex';
    if (/^https?:\/\//i.test(v) || /^\/(?!\/)/.test(v)) return 'url';
    if (/^[A-Z]{2,8}[-_]?\d{2,}(?:[-_]\d{2,})*$/.test(v)) return 'orderno';
    if (
      v.length >= 40 &&
      /^[A-Za-z0-9_~+/=-]+$/.test(v) &&
      /[A-Z]/.test(v) &&
      /[a-z]/.test(v) &&
      /\d/.test(v)
    ) {
      return 'token';
    }
    return 'string';
  }

  function typeFamily(type) {
    switch (type) {
      case 'uuid':
        return 'uuid';
      case 'objectid':
      case 'hex':
        return 'hex';
      case 'int':
        return 'int';
      case 'orderno':
      case 'string':
        return 'string';
      case 'jwt':
      case 'token':
        return 'secret';
      case 'email':
        return 'email';
      default:
        return 'unknown';
    }
  }

  function isIdLikeType(type) {
    return ['uuid', 'objectid', 'int', 'hex', 'orderno', 'string'].includes(type);
  }

  function isUsableContextValue(key, value) {
    const v = String(value == null ? '' : value).trim();
    if (!v || v.length > LIMITS.maxValueLength) return false;
    if (isSensitiveKey(key) || isPiiKey(key)) return false;
    const type = classifyValue(v);
    if (['empty', 'boolean', 'object', 'url', 'jwt', 'token', 'email', 'secret'].includes(type)) {
      return false;
    }
    if (isIdKey(key)) return true;
    return ['uuid', 'objectid', 'int', 'hex', 'orderno'].includes(type);
  }

  function bestContextKey(fullPath, leaf) {
    const parts = Array.isArray(fullPath) ? fullPath.slice() : [fullPath];
    const leafRaw = leaf == null ? parts[parts.length - 1] : leaf;
    const leafNorm = normalizeKey(leafRaw);
    if (!leafNorm) return '';
    if (GENERIC_KEY_RE.test(leafNorm) && parts.length > 1) {
      const parentNorm = normalizeKey(parts[parts.length - 2]);
      if (parentNorm && !GENERIC_KEY_RE.test(parentNorm)) {
        if (leafNorm === 'id' || leafNorm === 'uuid' || leafNorm === 'guid') {
          return parentNorm + '_' + leafNorm;
        }
        return parentNorm + '_' + leafNorm;
      }
    }
    return leafNorm;
  }

  function maskValue(value, type) {
    const v = String(value == null ? '' : value);
    const t = type || classifyValue(v);
    if (!v) return '';
    if (t === 'email') {
      const at = v.indexOf('@');
      if (at > 0) return v.slice(0, 1) + '***' + v.slice(at);
    }
    if (t === 'jwt' || t === 'token') return '[sensitive]';
    if (v.length > 32) return v.slice(0, 10) + '…' + v.slice(-4);
    return v;
  }

  /* ------------------------------------------------------------------ *
   * URL candidates & JavaScript string extraction
   * ------------------------------------------------------------------ */

  function looksLikeUrlCandidate(value) {
    if (typeof value !== 'string') return false;
    const s = value.trim();
    if (s.length < 4 || s.length > LIMITS.maxUrlLength) return false;
    if (/[\s<>"'`]/.test(s)) return false;
    if (/^(?:data|blob|javascript|mailto|tel|about|chrome|moz-extension|chrome-extension):/i.test(s)) {
      return false;
    }
    if (/\\[dDsSwWbB]|\[\^|\(\?[=!:<>]|\$\/|^\^|\$$/.test(s)) return false;
    if (/=>|function\s*\(|return\s|;\s*$/.test(s)) return false;
    if (s.startsWith('//')) return /^\/\/[A-Za-z0-9\-._~%]+/.test(s) && s.length > 5;
    if (s.startsWith('/')) {
      if (s.length === 1) return false;
      if (/^\/(?:\*|\/)/.test(s)) return false;
      return /[A-Za-z0-9]/.test(s);
    }
    if (/^https?:\/\//i.test(s)) return true;
    if (/^\.{1,2}\//.test(s)) return true;
    if (/^(?:api|apis|rest|graphql|gql|v\d+|services?)\//i.test(s)) return true;
    if (
      /^[A-Za-z0-9._~-]+\/[A-Za-z0-9._~/-]+/.test(s) &&
      /(?:api|v\d+|users|orgs|rest|graphql)/i.test(s)
    ) {
      return true;
    }
    return false;
  }

  function skipQuoted(text, index) {
    const quote = text[index];
    let i = index + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      i++;
    }
    return i;
  }

  function readTemplateExpression(text, start) {
    let depth = 1;
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        i = skipQuoted(text, i);
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return -1;
  }

  function scanQuotedStrings(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n && out.length < 6000) {
      const quote = text[i];
      if (quote === '"' || quote === "'" || quote === '`') {
        let j = i + 1;
        let buf = '';
        let closed = false;
        while (j < n) {
          const ch = text[j];
          if (ch === '\\') {
            buf += ch;
            if (j + 1 < n) buf += text[j + 1];
            j += 2;
            continue;
          }
          if (ch === quote) {
            closed = true;
            j++;
            break;
          }
          if (ch === '\n' && quote !== '`') {
            j++;
            break;
          }
          if (quote === '`' && ch === '$' && text[j + 1] === '{') {
            const exprEnd = readTemplateExpression(text, j + 2);
            if (exprEnd > j) {
              buf += text.slice(j, exprEnd);
              j = exprEnd;
              continue;
            }
          }
          buf += ch;
          j++;
        }
        if (buf) out.push(buf);
        i = closed ? j : j + 1;
        continue;
      }
      i++;
    }
    return out;
  }

  function decodeJsEscapes(raw) {
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch !== '\\') {
        out += ch;
        i++;
        continue;
      }
      const next = raw[i + 1];
      if (next === undefined) break;
      switch (next) {
        case 'n':
          out += '\n';
          i += 2;
          break;
        case 'r':
          out += '\r';
          i += 2;
          break;
        case 't':
          out += '\t';
          i += 2;
          break;
        case 'b':
          out += '\b';
          i += 2;
          break;
        case 'f':
          out += '\f';
          i += 2;
          break;
        case 'v':
          out += '\v';
          i += 2;
          break;
        case '0':
          out += '\0';
          i += 2;
          break;
        case '\\':
        case '/':
        case "'":
        case '"':
        case '`':
          out += next;
          i += 2;
          break;
        case 'x': {
          const hex = raw.slice(i + 2, i + 4);
          if (/^[0-9a-f]{2}$/i.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            out += next;
            i += 2;
          }
          break;
        }
        case 'u': {
          if (raw[i + 2] === '{') {
            const end = raw.indexOf('}', i + 3);
            if (end > 0) {
              const hex = raw.slice(i + 3, end);
              if (/^[0-9a-f]{1,6}$/i.test(hex)) {
                const cp = parseInt(hex, 16);
                if (cp <= 0x10ffff) {
                  out += String.fromCodePoint(cp);
                  i = end + 1;
                  break;
                }
              }
            }
            out += next;
            i += 2;
            break;
          }
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-f]{4}$/i.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            out += next;
            i += 2;
          }
          break;
        }
        default:
          out += next;
          i += 2;
      }
    }
    return out;
  }

  /**
   * Extracts URL-ish string literals from JavaScript text.
   * The caller decides whether each candidate is an API endpoint.
   */
  function extractScriptUrls(text, baseUrl) {
    if (typeof text !== 'string' || !text) return [];
    const input =
      text.length > LIMITS.maxScriptBytes ? text.slice(0, LIMITS.maxScriptBytes) : text;
    const rawStrings = scanQuotedStrings(input);
    const seen = new Set();
    const out = [];
    for (const raw of rawStrings) {
      if (out.length >= LIMITS.maxCandidatesPerScript) break;
      const decoded = decodeJsEscapes(raw).trim();
      if (!looksLikeUrlCandidate(decoded)) continue;
      if (seen.has(decoded)) continue;
      seen.add(decoded);
      out.push(decoded);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Templates, routes and placeholders
   * ------------------------------------------------------------------ */

  function exprToName(expr) {
    const s = String(expr == null ? '' : expr).trim();
    if (!s) return 'id';
    const cleaned = s.replace(/[^\w$.[\]]+/g, '_');
    const parts = cleaned.split(/[.[\]]+/).filter(Boolean);
    let name = parts[parts.length - 1] || 'id';
    name = name.replace(/\$/g, '');
    if (!name || /^\d/.test(name)) return 'id';
    if (GENERIC_KEY_RE.test(normalizeKey(name)) && parts.length > 1) {
      const parent = parts[parts.length - 2].replace(/\$/g, '');
      if (parent) name = parent + '_' + name;
    }
    return sanitizePlaceholderName(name);
  }

  function sanitizePlaceholderName(name) {
    let n = String(name == null ? 'id' : name).trim();
    n = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    n = n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return clampString(n || 'id', 60);
  }

  function prepareTemplate(raw) {
    const placeholders = [];
    let value = String(raw == null ? '' : raw);

    function tokenFor(name, rawName) {
      const idx = placeholders.length;
      placeholders.push({
        name: sanitizePlaceholderName(name),
        rawName: cleanText(rawName || name, 80),
        kind: 'template'
      });
      return '__KPH' + idx + '__';
    }

    value = value.replace(/\$\{([^{}]*)\}/g, function (_m, expr) {
      return tokenFor(exprToName(expr), expr);
    });
    value = value.replace(/\{([A-Za-z_][A-Za-z0-9_.-]{0,60})\}/g, function (_m, name) {
      return tokenFor(name, name);
    });
    value = value.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, function (_m, name) {
      return '/' + tokenFor(name, name);
    });

    return { value: value, placeholders: placeholders };
  }

  function resolveUrl(raw, baseUrl) {
    try {
      let s = String(raw == null ? '' : raw).trim();
      const base =
        baseUrl && /^https?:\/\//i.test(baseUrl)
          ? baseUrl
          : typeof location !== 'undefined' && /^https?:\/\//i.test(location.href)
            ? location.href
            : 'https://example.invalid/';
      if (s.startsWith('//')) {
        s = new URL(base).protocol + s;
      }
      const u = new URL(s, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.username = '';
      u.password = '';
      u.hash = '';
      return u;
    } catch (_) {
      return null;
    }
  }

  function inferIdName(prevSegment, type) {
    if (type === 'email') return 'email';
    if (type === 'jwt' || type === 'token') return 'token';
    if (prevSegment) {
      const prev = singularize(normalizeKey(prevSegment));
      if (
        prev &&
        !/^(?:api|apis|rest|graphql|gql|rpc|v\d+|version|auth|oauth|sso|page|offset|cursor|limit)$/.test(prev)
      ) {
        if (prev.endsWith('_id')) return prev;
        return prev + '_id';
      }
    }
    return 'id';
  }

  function isDatePart(segments, index) {
    const cur = segments[index];
    const prev = index > 0 ? segments[index - 1] : '';
    const next = index + 1 < segments.length ? segments[index + 1] : '';
    const nextNext = index + 2 < segments.length ? segments[index + 2] : '';
    if (/^(?:19|20)\d{2}$/.test(cur) && /^\d{1,2}$/.test(next)) {
      return /^\d{1,2}$/.test(nextNext) || !nextNext;
    }
    if (/^(?:19|20)\d{2}$/.test(prev) && /^\d{1,2}$/.test(cur)) return true;
    if (DATE_CONTEXT_RE.test(prev)) return true;
    return false;
  }

  function isNumericId(seg, prev, segments, index) {
    if (!/^\d{1,20}$/.test(seg)) return false;
    if (isDatePart(segments, index)) return false;
    if (/^(?:v\d+|version|ver)$/i.test(prev || '')) return false;
    if (/^(?:page|p|offset|cursor|limit|per_page|static|assets?|img|images?|fonts?|docs?|blog)$/i.test(prev || '')) {
      return false;
    }
    if (seg.length >= 5) return true;
    if (prev && (RESOURCE_HINT_RE.test('/' + prev + '/') || isIdKey(prev))) return true;
    if (index > 0 && seg.length >= 2) return true;
    return false;
  }

  function observedDynamic(seg, prev, segments, index) {
    if (!seg) return null;
    const type = classifyValue(seg);
    if (type === 'uuid') return { type: 'uuid', name: inferIdName(prev, 'uuid') };
    if (type === 'objectid') return { type: 'objectid', name: inferIdName(prev, 'objectid') };
    if (type === 'jwt') return { type: 'jwt', name: 'token', sensitive: true };
    if (type === 'token') return { type: 'token', name: 'token', sensitive: true };
    if (type === 'email') return { type: 'email', name: 'email', sensitive: true };
    if (type === 'orderno') return { type: 'orderno', name: inferIdName(prev, 'orderno') };
    if (type === 'int' && isNumericId(seg, prev, segments, index)) {
      return { type: 'int', name: inferIdName(prev, 'int') };
    }
    if (type === 'hex' && seg.length >= 24) {
      if (prev && (RESOURCE_HINT_RE.test('/' + prev + '/') || isIdKey(prev))) {
        return { type: 'hex', name: inferIdName(prev, 'hex') };
      }
    }
    return null;
  }

  function makePlaceholder(segIndex, ordinal, name, kind, type, observedValue, sensitive) {
    const safeName = sanitizePlaceholderName(name);
    return {
      id: 'p' + segIndex + '_' + ordinal,
      name: safeName,
      normName: normalizeKey(safeName),
      display: '{' + safeName + '}',
      segmentIndex: segIndex,
      partIndex: ordinal,
      kind: kind,
      valueType: type || 'unknown',
      observedValue: sensitive ? null : observedValue == null ? null : String(observedValue),
      sensitive: Boolean(sensitive)
    };
  }

  function normalizeEndpoint(raw, opts) {
    const options = opts || {};
    const source = options.source || 'unknown';
    const baseUrl = options.baseUrl || '';
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    const allowRoot =
      trimmed === '/' && (source === 'network' || source === 'form' || options.allowRoot === true);
    if (!trimmed || (!allowRoot && !looksLikeUrlCandidate(trimmed))) return null;

    const prepared = prepareTemplate(trimmed);
    const resolved = resolveUrl(prepared.value, baseUrl);
    if (!resolved) return null;

    const pathname = resolved.pathname || '/';
    const rawSegments =
      pathname === '/'
        ? []
        : pathname.replace(/^\//, '').split('/');

    const placeholders = [];
    const pathSegments = [];
    const tokenRe = /__KPH(\d+)__/g;

    for (let segIndex = 0; segIndex < rawSegments.length; segIndex++) {
      const rawSegment = rawSegments[segIndex];
      const templateParts = [];
      let lastIndex = 0;
      let match;
      tokenRe.lastIndex = 0;
      while ((match = tokenRe.exec(rawSegment)) !== null) {
        if (match.index > lastIndex) {
          templateParts.push({
            type: 'literal',
            value: safeDecode(rawSegment.slice(lastIndex, match.index))
          });
        }
        const meta = prepared.placeholders[Number(match[1])];
        if (meta) {
          const ph = makePlaceholder(
            segIndex,
            templateParts.filter((p) => p.type === 'ph').length,
            meta.name,
            'template',
            'unknown',
            null,
            false
          );
          ph.rawName = meta.rawName;
          placeholders.push(ph);
          templateParts.push({ type: 'ph', id: ph.id });
        }
        lastIndex = tokenRe.lastIndex;
      }
      if (lastIndex < rawSegment.length || templateParts.length === 0) {
        templateParts.push({
          type: 'literal',
          value: safeDecode(rawSegment.slice(lastIndex))
        });
      }

      if (templateParts.length === 1 && templateParts[0].type === 'literal') {
        const decoded = templateParts[0].value;
        const prev =
          pathSegments.length &&
          pathSegments[pathSegments.length - 1].length === 1 &&
          pathSegments[pathSegments.length - 1][0].type === 'literal'
            ? pathSegments[pathSegments.length - 1][0].value
            : '';
        const dynamic = observedDynamic(
          decoded,
          prev,
          rawSegments.map((s) => safeDecode(s)),
          segIndex
        );
        if (dynamic) {
          const ph = makePlaceholder(
            segIndex,
            0,
            dynamic.name,
            'observed',
            dynamic.type,
            dynamic.sensitive ? null : decoded,
            Boolean(dynamic.sensitive)
          );
          placeholders.push(ph);
          templateParts.length = 0;
          templateParts.push({ type: 'ph', id: ph.id });
        }
      }

      pathSegments.push(templateParts);
    }

    const pathPattern =
      pathSegments.length === 0
        ? '/'
        : '/' +
          pathSegments
            .map((parts) =>
              parts
                .map((p) => (p.type === 'literal' ? p.value : '{}'))
                .join('')
            )
            .join('/');

    const template =
      pathSegments.length === 0
        ? '/'
        : '/' +
          pathSegments
            .map((parts) =>
              parts
                .map((p) => {
                  if (p.type === 'literal') return p.value;
                  const ph = placeholders.find((x) => x.id === p.id);
                  return ph ? ph.display : '{id}';
                })
                .join('')
            )
            .join('/');

    const queryPairs = [];
    try {
      const entries = Array.from(resolved.searchParams.entries());
      for (let i = 0; i < entries.length && i < LIMITS.maxQueryPairs; i++) {
        const key = cleanText(entries[i][0], LIMITS.maxNameLength);
        let value = String(entries[i][1] == null ? '' : entries[i][1]);
        let placeholder = false;
        value = value.replace(/__KPH(\d+)__/g, function (_m, idx) {
          const ph = prepared.placeholders[Number(idx)];
          placeholder = true;
          return ph ? '{' + ph.name + '}' : '{id}';
        });
        const sensitive = isSensitiveKey(key) || classifyValue(value) === 'jwt';
        const pii = isPiiKey(key) || classifyValue(value) === 'email';
        const redacted = sensitive || pii;
        queryPairs.push({
          key: key,
          value: redacted ? '[redacted]' : clampString(value, LIMITS.maxValueLength),
          sensitive: sensitive,
          pii: pii,
          redacted: redacted,
          placeholder: placeholder
        });
      }
    } catch (_) {
      /* ignore malformed query */
    }

    return {
      url: resolved.href,
      origin: resolved.origin,
      host: resolved.host,
      protocol: resolved.protocol,
      pathname: pathname,
      pathPattern: pathPattern,
      template: template,
      pathSegments: pathSegments,
      placeholders: placeholders,
      queryPairs: queryPairs,
      isTemplate: placeholders.some((p) => p.kind === 'template') || prepared.placeholders.length > 0,
      source: source
    };
  }

  function findPlaceholder(endpoint, id) {
    if (!endpoint || !Array.isArray(endpoint.placeholders)) return null;
    return endpoint.placeholders.find((p) => p.id === id) || null;
  }

  /**
   * Renders an endpoint path. `resolver` receives each placeholder and returns
   * a value, or null to keep the "{name}" token.
   */
  function renderPath(endpoint, resolver, opts) {
    const options = opts || {};
    const segments = endpoint && Array.isArray(endpoint.pathSegments) ? endpoint.pathSegments : [];
    if (!segments.length) return endpoint && endpoint.template ? endpoint.template : '/';
    const rendered = [];
    for (const parts of segments) {
      let segment = '';
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part.type === 'literal') {
          segment += part.value;
          continue;
        }
        const ph = findPlaceholder(endpoint, part.id);
        const value = resolver ? resolver(ph) : null;
        if (value == null || value === '') {
          segment += ph ? ph.display : '{id}';
        } else {
          segment += options.encode === false ? String(value) : encodeURIComponent(String(value));
        }
      }
      rendered.push(segment);
    }
    return '/' + rendered.join('/');
  }

  function buildQueryString(pairs, opts) {
    const options = opts || {};
    const params = [];
    if (!Array.isArray(pairs)) return '';
    for (const pair of pairs) {
      if (!pair || pair.key == null) continue;
      if (pair.redacted && options.omitRedacted !== false) continue;
      if (pair.placeholder && options.omitPlaceholders !== false) continue;
      const value = pair.value == null ? '' : String(pair.value);
      params.push([String(pair.key), value]);
    }
    if (!params.length) return '';
    const search = new URLSearchParams();
    for (const [key, value] of params) search.append(key, value);
    return '?' + search.toString();
  }

  function endpointDisplayUrl(endpoint, opts) {
    const options = opts || {};
    const path = renderPath(
      endpoint,
      function (ph) {
        if (!ph) return null;
        return ph.sensitive ? null : ph.observedValue;
      },
      { encode: true }
    );
    const query = options.includeQuery === false ? '' : buildQueryString(endpoint.queryPairs);
    return (endpoint.origin || '') + path + query;
  }

  /* ------------------------------------------------------------------ *
   * Context / identity extraction
   * ------------------------------------------------------------------ */

  function b64urlDecode(input) {
    let s = String(input == null ? '' : input).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    try {
      if (typeof atob === 'function') {
        const binary = atob(s);
        if (typeof TextDecoder === 'function') {
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
        return binary;
      }
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(s, 'base64').toString('utf8');
      }
    } catch (_) {
      return '';
    }
    return '';
  }

  function decodeJwtClaims(token) {
    const t = String(token == null ? '' : token).trim();
    if (t.length < 20 || t.length > 8192) return null;
    const parts = t.split('.');
    if (parts.length < 2) return null;
    try {
      const json = b64urlDecode(parts[1]);
      if (!json || json.length > 8192) return null;
      const payload = JSON.parse(json);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  /**
   * Returns only identity-shaped, non-sensitive claims.
   * Raw tokens and PII claims are never returned.
   */
  function identityClaimsFromJwt(token) {
    const payload = decodeJwtClaims(token);
    if (!payload) return [];
    const out = [];
    const seen = new Set();
    const excluded = new Set(['client_id', 'azp', 'app_id', 'jti', 'sid', 'session_id']);

    function walk(obj, path, depth) {
      if (depth > 2 || out.length >= 12) return;
      for (const key of Object.keys(obj)) {
        if (out.length >= 12) return;
        const value = obj[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          walk(value, path.concat(key), depth + 1);
          continue;
        }
        if (Array.isArray(value) || value == null) continue;
        if (typeof value === 'object') continue;
        const leaf = String(key);
        if (isSensitiveKey(leaf) || isPiiKey(leaf)) continue;
        const normKey = bestContextKey(path.concat(leaf), leaf);
        if (!normKey || excluded.has(normKey)) continue;
        if (!isIdKey(normKey) && normKey !== 'sub') continue;
        const text = String(value);
        if (!isUsableContextValue(normKey, text)) continue;
        const signature = normKey + '\u0000' + text;
        if (seen.has(signature)) continue;
        seen.add(signature);
        out.push({
          key: normKey,
          claim: path.concat(leaf).join('.'),
          value: clampString(text, LIMITS.maxClaimLength),
          valueType: classifyValue(text)
        });
      }
    }

    walk(payload, [], 0);
    return out;
  }

  function makeContextCandidate(input) {
    const data = input || {};
    const key = clampString(cleanText(data.key, LIMITS.maxNameLength), LIMITS.maxNameLength);
    const rawValue = data.value == null ? '' : String(data.value).trim();
    if (!key || !rawValue) return null;
    if (!isUsableContextValue(key, rawValue)) return null;
    const normKey = normalizeKey(key);
    if (!normKey) return null;
    const value = clampString(rawValue, LIMITS.maxValueLength);
    const source = data.source || {};
    const kind = cleanText(source.kind || 'context', 40) || 'context';
    const label = cleanText(source.label || kind, 160) || kind;
    return {
      key: key,
      normKey: normKey,
      value: value,
      valueType: classifyValue(value),
      source: {
        kind: kind,
        label: label,
        pageUrl: sanitizePageUrl(source.pageUrl || data.pageUrl || ''),
        ts: Number(data.now || source.ts) || Date.now()
      }
    };
  }

  function harvestIdFields(input, opts) {
    const options = opts || {};
    const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 2;
    const maxFields = Number.isFinite(options.maxFields) ? options.maxFields : 12;
    const out = [];
    const seen = new Set();

    function walk(value, path, depth) {
      if (out.length >= maxFields || depth > maxDepth || value == null) return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 10)) walk(item, path, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        let count = 0;
        for (const key of Object.keys(value)) {
          if (count++ > 40) break;
          walk(value[key], path.concat(key), depth + 1);
        }
        return;
      }
      if (typeof value === 'boolean' || typeof value === 'object') return;
      const leaf = path.length ? path[path.length - 1] : '';
      if (isSensitiveKey(leaf) || isPiiKey(leaf)) return;
      const key = bestContextKey(path, leaf);
      if (!key || !isIdKey(key)) return;
      const text = String(value);
      if (!isUsableContextValue(key, text)) return;
      const signature = key + '\u0000' + text;
      if (seen.has(signature)) return;
      seen.add(signature);
      out.push({
        key: key,
        value: clampString(text, LIMITS.maxClaimLength),
        path: path.join('.'),
        valueType: classifyValue(text)
      });
    }

    walk(input, [], 0);
    return out;
  }

  function extractQueryContext(rawUrl, now) {
    const out = [];
    try {
      const u = new URL(String(rawUrl), 'https://example.invalid/');
      for (const [key, value] of u.searchParams.entries()) {
        if (out.length >= 20) break;
        const candidate = makeContextCandidate({
          key: key,
          value: value,
          source: { kind: 'query', label: 'page query ' + key, pageUrl: rawUrl, ts: now },
          now: now
        });
        if (candidate) out.push(candidate);
      }
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  function endpointContextCandidates(endpoint, pageUrl, now) {
    const out = [];
    if (!endpoint) return out;
    for (const ph of endpoint.placeholders || []) {
      if (!ph.observedValue || ph.sensitive) continue;
      const candidate = makeContextCandidate({
        key: ph.name,
        value: ph.observedValue,
        source: {
          kind: 'path',
          label: 'path segment ' + ph.display,
          pageUrl: pageUrl,
          ts: now
        },
        now: now
      });
      if (candidate) out.push(candidate);
    }
    for (const pair of endpoint.queryPairs || []) {
      if (pair.redacted || pair.placeholder) continue;
      const candidate = makeContextCandidate({
        key: pair.key,
        value: pair.value,
        source: {
          kind: 'query',
          label: 'query ' + pair.key,
          pageUrl: pageUrl,
          ts: now
        },
        now: now
      });
      if (candidate) out.push(candidate);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Page URL / origin / scope
   * ------------------------------------------------------------------ */

  function sanitizePageUrl(raw) {
    if (!raw) return '';
    try {
      const u = new URL(String(raw));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      u.username = '';
      u.password = '';
      u.hash = '';
      u.search = '';
      return clampString(u.origin + u.pathname, 1024);
    } catch (_) {
      return '';
    }
  }

  function originOf(raw) {
    try {
      const u = new URL(String(raw));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch (_) {
      return null;
    }
  }

  function isIpHost(hostname) {
    const h = String(hostname || '').replace(/^\[|\]$/g, '');
    return IPV4_RE.test(h) || (h.includes(':') && IPV6_RE.test(h));
  }

  function siteKey(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!h || isIpHost(h) || h === 'localhost') return h;
    const parts = h.split('.').filter(Boolean);
    if (parts.length <= 2) return h;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
      return parts.slice(-3).join('.');
    }
    return lastTwo;
  }

  function sameSite(hostA, hostB) {
    const a = String(hostA || '').toLowerCase();
    const b = String(hostB || '').toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    if (isIpHost(a) || isIpHost(b) || a === 'localhost' || b === 'localhost') return false;
    return siteKey(a) === siteKey(b);
  }

  function originInScope(scopeOrigin, targetOrigin, mode) {
    try {
      const a = new URL(scopeOrigin);
      const b = new URL(targetOrigin);
      if (a.origin === b.origin) return true;
      if (mode === C.SCOPE_MODE.ORIGIN) return false;
      return sameSite(a.hostname, b.hostname);
    } catch (_) {
      return false;
    }
  }

  function isStaticAsset(pathname) {
    const p = String(pathname || '').toLowerCase();
    if (!p) return false;
    if (STATIC_EXT_RE.test(p)) return true;
    if (
      /^\/(?:_next\/static|static|assets|build|dist|cdn-cgi|__webpack|node_modules|@vite|@fs|fonts?|images?|img|media|css|js)\//.test(
        p
      )
    ) {
      return true;
    }
    return false;
  }

  function isBundleUrl(urlOrPath) {
    try {
      const p = String(urlOrPath || '').startsWith('http')
        ? new URL(urlOrPath).pathname
        : String(urlOrPath || '').split('?')[0];
      return BUNDLE_EXT_RE.test(p) && !/\.map$/i.test(p);
    } catch (_) {
      return false;
    }
  }

  function hasDynamicSegment(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.some(function (part) {
      if (part.startsWith(':') || part.indexOf('{') >= 0 || /__KPH\d+__/.test(part)) {
        return true;
      }
      const type = classifyValue(part);
      return (
        type === 'uuid' ||
        type === 'objectid' ||
        type === 'orderno' ||
        (type === 'int' && part.length >= 2)
      );
    });
  }

  function isApiLike(pathname) {
    const p = String(pathname || '');
    if (!p || p === '/' || isStaticAsset(p)) return false;
    if (API_HINT_RE.test(p) || API_EXT_RE.test(p) || AUTH_HINT_RE.test(p)) return true;
    if (PAGE_PREFIX_RE.test(p) && !hasDynamicSegment(p)) return false;
    if (RESOURCE_HINT_RE.test(p)) {
      const segments = p.split('/').filter(Boolean);
      return segments.length >= 2;
    }
    return false;
  }

  /**
   * Source-aware ingestion policy.
   * Network observations are accepted unless static; string-derived routes need
   * an API hint to keep page links and CSS out of the ledger.
   */
  function shouldIngestEndpoint(endpoint, source) {
    if (!endpoint || !endpoint.pathname) return { ok: false, reason: 'invalid' };
    if (isBundleUrl(endpoint.pathname)) return { ok: false, reason: 'bundle' };
    if (isStaticAsset(endpoint.pathname)) return { ok: false, reason: 'static' };
    if (source === 'network' || source === 'form') return { ok: true, reason: 'observed' };
    if (isApiLike(endpoint.pathname)) return { ok: true, reason: 'api-like' };
    return { ok: false, reason: 'not-api' };
  }

  function sanitizeMethod(value) {
    return normalizeMethod(value);
  }

  function sanitizeStatus(value) {
    return normalizeStatus(value);
  }

  return {
    fnv1a: fnv1a,
    stableId: stableId,
    clampString: clampString,
    cleanText: cleanText,
    safeDecode: safeDecode,
    singularize: singularize,
    normalizeKey: normalizeKey,
    isSensitiveKey: isSensitiveKey,
    isPiiKey: isPiiKey,
    isIdKey: isIdKey,
    classifyValue: classifyValue,
    typeFamily: typeFamily,
    isIdLikeType: isIdLikeType,
    isUsableContextValue: isUsableContextValue,
    bestContextKey: bestContextKey,
    maskValue: maskValue,
    looksLikeUrlCandidate: looksLikeUrlCandidate,
    extractScriptUrls: extractScriptUrls,
    decodeJsEscapes: decodeJsEscapes,
    decodeJwtClaims: decodeJwtClaims,
    identityClaimsFromJwt: identityClaimsFromJwt,
    makeContextCandidate: makeContextCandidate,
    harvestIdFields: harvestIdFields,
    extractQueryContext: extractQueryContext,
    endpointContextCandidates: endpointContextCandidates,
    normalizeEndpoint: normalizeEndpoint,
    findPlaceholder: findPlaceholder,
    renderPath: renderPath,
    buildQueryString: buildQueryString,
    endpointDisplayUrl: endpointDisplayUrl,
    sanitizePageUrl: sanitizePageUrl,
    originOf: originOf,
    siteKey: siteKey,
    sameSite: sameSite,
    originInScope: originInScope,
    isStaticAsset: isStaticAsset,
    isBundleUrl: isBundleUrl,
    isApiLike: isApiLike,
    hasDynamicSegment: hasDynamicSegment,
    shouldIngestEndpoint: shouldIngestEndpoint,
    sanitizeMethod: sanitizeMethod,
    sanitizeStatus: sanitizeStatus
  };
});
