/**
 * Kimbo JS — passive network observer (MAIN world).
 *
 * Observes fetch() and XMLHttpRequest calls the page already makes. It does
 * not create requests. Authorization material is never posted: only
 * non-sensitive ID claims decoded from a JWT payload leave this closure.
 * Request bodies are reduced to identity-shaped fields and then discarded.
 *
 * The page can see window.postMessage traffic. That is why this file is
 * deliberately paranoid about what it posts.
 */
(function (root) {
  'use strict';
  const core = root.KimboCore;
  const N = core && core.normalizer;
  if (!N) return;

  const GUARD = '__kimboNetworkObserverV1';
  if (root[GUARD]) return;
  try {
    Object.defineProperty(root, GUARD, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });
  } catch (_) {
    root[GUARD] = true;
  }

  const MAX_URL = 4096;
  const MAX_BODY_SCAN = 65536;
  const MAX_EVENTS_PER_SECOND = 120;
  const DEDUPE_MS = 900;
  let rateStart = 0;
  let rateCount = 0;
  const recent = new Map();

  function clean(value, max) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, max);
  }

  function headersObject(input) {
    const out = {};
    if (!input) return out;
    try {
      if (typeof Headers !== 'undefined' && input instanceof Headers) {
        input.forEach(function (value, key) {
          out[String(key).toLowerCase()] = String(value);
        });
        return out;
      }
      if (Array.isArray(input)) {
        for (const pair of input) {
          if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
        return out;
      }
      if (typeof input === 'object') {
        for (const key of Object.keys(input)) out[String(key).toLowerCase()] = String(input[key]);
      }
    } catch (_) {
      /* ignore malformed headers */
    }
    return out;
  }

  function mergeHeaders(a, b) {
    return Object.assign({}, a || {}, b || {});
  }

  function authFromHeader(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return { scheme: '', claims: [] };
    const bearer = /^Bearer\s+(.+)$/i.exec(raw);
    if (bearer) {
      const claims = N.identityClaimsFromJwt(bearer[1].trim());
      return { scheme: 'bearer', claims: claims };
    }
    if (/^Basic\s+/i.test(raw)) return { scheme: 'basic', claims: [] };
    if (raw.split('.').length >= 3) {
      const claims = N.identityClaimsFromJwt(raw);
      if (claims.length) return { scheme: 'jwt', claims: claims };
    }
    return { scheme: 'other', claims: [] };
  }

  function fieldsFromPairs(iterable) {
    const out = [];
    const seen = new Set();
    if (!iterable) return out;
    try {
      for (const entry of iterable) {
        const key = String(entry[0]);
        const value = entry[1];
        if (typeof value !== 'string') continue;
        if (!N.isIdKey(key) || !N.isUsableContextValue(key, value)) continue;
        const sig = key + '\u0000' + value;
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({ key: key, value: value.slice(0, 300), valueType: N.classifyValue(value) });
        if (out.length >= 12) break;
      }
    } catch (_) {
      /* ignore */
    }
    return out;
  }

  function extractBodyFields(body) {
    if (body == null) return [];
    try {
      if (typeof body === 'string') {
        if (body.length > MAX_BODY_SCAN) return [];
        const trimmed = body.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          const parsed = JSON.parse(trimmed);
          return N.harvestIdFields(parsed, { maxDepth: 2, maxFields: 12 });
        }
        if (/^[^\s=&#]+=[^\n]*/.test(trimmed)) {
          return fieldsFromPairs(new URLSearchParams(trimmed));
        }
        return [];
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return fieldsFromPairs(body);
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        return fieldsFromPairs(body.entries());
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) return [];
      if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
        return [];
      }
    } catch (_) {
      /* unparseable body */
    }
    return [];
  }

  function sanitizeUrl(raw) {
    try {
      const u = new URL(String(raw), root.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.username = '';
      u.password = '';
      u.hash = '';
      const href = u.href;
      if (href.length > MAX_URL) return null;
      return href;
    } catch (_) {
      return null;
    }
  }

  function describe(input, init) {
    let url = null;
    let method = 'GET';
    let headers = {};
    let body = init && init.body != null ? init.body : null;
    let bodyPromise = null;

    const isRequest =
      typeof Request !== 'undefined' && input instanceof Request;

    if (isRequest) {
      url = sanitizeUrl(input.url);
      method = (init && init.method) || input.method || 'GET';
      headers = headersObject(input.headers);
      if (init && init.headers) headers = mergeHeaders(headers, headersObject(init.headers));
      if (body == null) {
        try {
          const clone = input.clone();
          bodyPromise = clone
            .text()
            .then(function (text) {
              return extractBodyFields(text);
            })
            .catch(function () {
              return [];
            });
        } catch (_) {
          bodyPromise = null;
        }
      }
    } else {
      url = sanitizeUrl(input);
      method = (init && init.method) || 'GET';
      headers = headersObject(init && init.headers);
    }

    if (!url) return null;
    method = N.sanitizeMethod(method) || 'GET';
    const auth = authFromHeader(headers.authorization);
    const directFields = body == null ? [] : extractBodyFields(body);

    return {
      url: url,
      method: method,
      source: 'fetch',
      contentType: clean(headers['content-type'] || '', 120),
      authScheme: auth.scheme,
      authClaims: auth.claims,
      bodyFields: directFields,
      bodyPromise: bodyPromise
    };
  }

  function withinRate() {
    const now = Date.now();
    if (!rateStart || now - rateStart >= 1000) {
      rateStart = now;
      rateCount = 0;
    }
    rateCount++;
    return rateCount <= MAX_EVENTS_PER_SECOND;
  }

  function alreadySeen(meta, status) {
    const now = Date.now();
    const key = meta.method + '|' + meta.url + '|' + String(status == null ? '' : status) + '|' + meta.source;
    const previous = recent.get(key);
    if (previous && now - previous < DEDUPE_MS) return true;
    recent.set(key, now);
    if (recent.size > 400) {
      for (const [k, ts] of recent) {
        if (now - ts > DEDUPE_MS) recent.delete(k);
        if (recent.size <= 200) break;
      }
    }
    return false;
  }

  function post(event) {
    try {
      if (!withinRate()) return;
      root.postMessage(
        { __kimbo: 1, channel: 'kimbo:network', event: event },
        '*'
      );
    } catch (_) {
      /* page teardown */
    }
  }

  function finish(meta, status, contentType) {
    if (!meta || meta.emitted) return;
    meta.emitted = true;
    if (alreadySeen(meta, status)) return;
    const claims = Array.isArray(meta.authClaims) ? meta.authClaims.slice(0, 12) : [];
    const fields = Array.isArray(meta.bodyFields) ? meta.bodyFields.slice(0, 12) : [];
    post({
      kind: 'network',
      method: meta.method,
      url: meta.url,
      status: N.sanitizeStatus(status),
      contentType: clean(contentType || meta.contentType || '', 120),
      authScheme: meta.authScheme || '',
      authClaims: claims,
      bodyFields: fields,
      source: meta.source,
      pageUrl: root.location.href,
      ts: Date.now()
    });
  }

  function finishWithBody(meta, status, contentType) {
    if (!meta) return;
    if (meta.bodyPromise) {
      meta.bodyPromise.then(
        function (fields) {
          meta.bodyFields = Array.isArray(fields) ? fields : [];
          finish(meta, status, contentType);
        },
        function () {
          finish(meta, status, contentType);
        }
      );
    } else {
      finish(meta, status, contentType);
    }
  }

  /* ------------------------------------------------------------------ *
   * fetch
   * ------------------------------------------------------------------ */

  try {
    const nativeFetch = root.fetch;
    if (typeof nativeFetch === 'function') {
      const kimboFetch = function fetch(input, init) {
        let meta = null;
        try {
          meta = describe(input, init);
        } catch (_) {
          meta = null;
        }
        let promise;
        try {
          promise = nativeFetch.apply(this, arguments);
        } catch (error) {
          if (meta) finish(meta, 0, null);
          throw error;
        }
        try {
          promise.then(
            function (response) {
              try {
                finishWithBody(meta, response.status, response.headers.get('content-type'));
              } catch (_) {
                finish(meta, response.status, null);
              }
            },
            function () {
              finishWithBody(meta, 0, null);
            }
          );
        } catch (_) {
          /* never break fetch */
        }
        return promise;
      };
      try {
        Object.defineProperty(kimboFetch, 'name', { value: nativeFetch.name || 'fetch' });
      } catch (_) {
        /* ignore */
      }
      try {
        kimboFetch.toString = nativeFetch.toString.bind(nativeFetch);
      } catch (_) {
        /* ignore */
      }
      try {
        root.fetch = kimboFetch;
      } catch (_) {
        try {
          Object.defineProperty(root, 'fetch', {
            value: kimboFetch,
            configurable: true,
            writable: true
          });
        } catch (_) {
          /* page forbids patching */
        }
      }
    }
  } catch (_) {
    /* no fetch */
  }

  /* ------------------------------------------------------------------ *
   * XMLHttpRequest
   * ------------------------------------------------------------------ */

  try {
    const XHR = root.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const proto = XHR.prototype;
      const nativeOpen = proto.open;
      const nativeSend = proto.send;
      const nativeSetHeader = proto.setRequestHeader;

      proto.open = function open(method, url) {
        try {
          const absolute = sanitizeUrl(url);
          this.__kimboMeta = absolute
            ? {
                url: absolute,
                method: N.sanitizeMethod(method) || 'GET',
                source: 'xhr',
                contentType: '',
                authScheme: '',
                authClaims: [],
                bodyFields: [],
                emitted: false,
                generation: (this.__kimboGeneration || 0) + 1
              }
            : null;
          if (absolute) this.__kimboGeneration = this.__kimboMeta.generation;
        } catch (_) {
          this.__kimboMeta = null;
        }
        return nativeOpen.apply(this, arguments);
      };

      proto.setRequestHeader = function setRequestHeader(name, value) {
        try {
          const meta = this.__kimboMeta;
          if (meta) {
            const header = String(name || '').toLowerCase();
            if (header === 'authorization') {
              const auth = authFromHeader(value);
              meta.authScheme = auth.scheme;
              meta.authClaims = auth.claims;
            } else if (header === 'content-type') {
              meta.contentType = clean(value, 120);
            }
          }
        } catch (_) {
          /* ignore */
        }
        return nativeSetHeader.apply(this, arguments);
      };

      proto.send = function send(body) {
        const meta = this.__kimboMeta;
        const xhr = this;
        if (meta) {
          try {
            meta.bodyFields = extractBodyFields(body);
          } catch (_) {
            meta.bodyFields = [];
          }
          const onEnd = function () {
            try {
              xhr.removeEventListener('loadend', onEnd);
            } catch (_) {
              /* ignore */
            }
            if (xhr.__kimboMeta !== meta) return;
            let contentType = null;
            try {
              contentType = xhr.getResponseHeader('content-type');
            } catch (_) {
              contentType = null;
            }
            finish(meta, xhr.status, contentType);
          };
          try {
            xhr.addEventListener('loadend', onEnd, { once: true });
          } catch (_) {
            setTimeout(function () {
              if (xhr.readyState === 4) onEnd();
            }, 0);
          }
        }
        try {
          return nativeSend.apply(this, arguments);
        } catch (error) {
          if (meta) finish(meta, 0, null);
          throw error;
        }
      };
    }
  } catch (_) {
    /* no XHR */
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
