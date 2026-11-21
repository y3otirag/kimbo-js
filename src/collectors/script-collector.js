/**
 * Kimbo JS — script collector (content script, isolated world).
 *
 *  - relays sanitized fetch/XHR observations from the MAIN-world hook
 *  - watches PerformanceResourceTiming + DOM for new JS chunks in SPAs
 *  - dissects bundles using CacheStorage or a cache-only fetch
 *      fetch(url, { cache: 'only-if-cached', mode: 'same-origin' })
 *
 * The cache-only fetch is the sole fetch in the extension. It never reaches
 * the network: a cache miss produces a network error and the UI offers a
 * manual paste fallback. Discovered API endpoints are never called.
 */
(function (root) {
  'use strict';
  const core = root.KimboCore;
  const N = core && core.normalizer;
  const C = core && core.constants;
  const bus = root.KimboBus;
  if (!N || !C || !bus) return;

  const LIMITS = C.LIMITS;
  const seenChunks = new Set();
  const seenResources = new Set();
  const hookedUrls = new Map();
  const bundleAttempts = new Map();
  const readTotals = { bytes: 0, auto: 0 };
  let fallbackEvents = 0;
  let manualInFlight = false;

  function clean(value, max) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, max);
  }

  function absoluteHttp(value) {
    try {
      const u = new URL(String(value), root.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.username = '';
      u.password = '';
      u.hash = '';
      if (u.href.length > LIMITS.maxUrlLength) return null;
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function markHooked(url) {
    const now = Date.now();
    hookedUrls.set(url, now);
    if (hookedUrls.size > 300) {
      for (const [key, ts] of hookedUrls) {
        if (now - ts > 15000) hookedUrls.delete(key);
        if (hookedUrls.size <= 150) break;
      }
    }
  }

  function sanitizeClaims(claims) {
    if (!Array.isArray(claims)) return [];
    const out = [];
    const seen = new Set();
    for (const claim of claims.slice(0, 12)) {
      if (!claim || !claim.key) continue;
      const key = clean(claim.key, 80);
      const value = clean(claim.value, 200);
      if (!N.isIdKey(key) || !N.isUsableContextValue(key, value)) continue;
      const signature = key + '\u0000' + value;
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push({
        key: key,
        value: value,
        claim: clean(claim.claim || key, 120),
        valueType: N.classifyValue(value)
      });
    }
    return out;
  }

  function sanitizeFields(fields) {
    if (!Array.isArray(fields)) return [];
    const out = [];
    const seen = new Set();
    for (const field of fields.slice(0, 12)) {
      if (!field || !field.key) continue;
      const key = clean(field.key, 80);
      const value = clean(field.value, 200);
      if (!N.isIdKey(key) || !N.isUsableContextValue(key, value)) continue;
      const signature = key + '\u0000' + value;
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push({
        key: key,
        value: value,
        path: clean(field.path || key, 120),
        valueType: N.classifyValue(value)
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * MAIN-world relay
   * ------------------------------------------------------------------ */

  root.addEventListener('message', function (event) {
    if (event.source !== root) return;
    const data = event.data;
    if (!data || data.__kimbo !== 1 || data.channel !== 'kimbo:network') return;
    const input = data.event;
    if (!input || input.kind !== 'network') return;
    const url = absoluteHttp(input.url);
    if (!url) return;
    const method = N.sanitizeMethod(input.method);
    const status = N.sanitizeStatus(input.status);
    const source = input.source === 'xhr' ? 'xhr' : 'fetch';
    markHooked(url);
    bus.emit({
      kind: 'network',
      method: method,
      url: url,
      status: status,
      contentType: clean(input.contentType, 100),
      authScheme: clean(input.authScheme, 20),
      authClaims: sanitizeClaims(input.authClaims),
      bodyFields: sanitizeFields(input.bodyFields),
      source: source,
      pageUrl: root.location.href,
      ts: Number(input.ts) || Date.now()
    });
  });

  /* ------------------------------------------------------------------ *
   * Bundle discovery
   * ------------------------------------------------------------------ */

  function shouldTreatAsChunk(url, initiatorType) {
    if (!url) return false;
    if (initiatorType === 'script') return true;
    return N.isBundleUrl(url);
  }

  function handleChunk(rawUrl, initiatorType) {
    const url = absoluteHttp(rawUrl);
    if (!url || seenChunks.has(url)) return;
    if (!N.isBundleUrl(url)) return;
    seenChunks.add(url);
    if (seenChunks.size > 400) seenChunks.clear();
    bus.emit({
      kind: 'chunk',
      url: url,
      initiatorType: clean(initiatorType || 'script', 40),
      pageUrl: root.location.href,
      ts: Date.now()
    });
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === root.location.origin;
    } catch (_) {
      sameOrigin = false;
    }
    if (sameOrigin && readTotals.auto < LIMITS.maxBundlesPerPage) {
      readTotals.auto++;
      setTimeout(function () {
        readBundle(url, { trigger: 'auto', manual: false }).catch(function () {});
      }, LIMITS.bundleReadDelayMs);
    }
  }

  function handleResourceEntry(entry) {
    if (!entry || !entry.name) return;
    const url = absoluteHttp(entry.name);
    if (!url) return;
    const initiatorType = entry.initiatorType || '';
    if (seenResources.has(url + '|' + initiatorType)) return;
    seenResources.add(url + '|' + initiatorType);
    if (seenResources.size > 1200) seenResources.clear();

    if (shouldTreatAsChunk(url, initiatorType)) {
      handleChunk(url, initiatorType);
      return;
    }

    if (initiatorType === 'fetch' || initiatorType === 'xmlhttprequest' || initiatorType === 'beacon') {
      if (fallbackEvents >= 150) return;
      const hooked = hookedUrls.get(url);
      if (hooked && Date.now() - hooked < 15000) return;
      fallbackEvents++;
      bus.emit({
        kind: 'network',
        method: null,
        url: url,
        status: null,
        source: 'resource',
        initiatorType: initiatorType,
        pageUrl: root.location.href,
        ts: Date.now()
      });
    }
  }

  try {
    const observer = new PerformanceObserver(function (list) {
      for (const entry of list.getEntries()) handleResourceEntry(entry);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch (_) {
    try {
      for (const entry of performance.getEntriesByType('resource')) handleResourceEntry(entry);
    } catch (_) {
      /* no performance API */
    }
  }

  function handleNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'SCRIPT') {
      const src = node.getAttribute('src');
      if (src) handleChunk(src, 'script-tag');
    } else if (node.tagName === 'LINK') {
      const rel = (node.getAttribute('rel') || '').toLowerCase();
      if (rel.includes('modulepreload') || (rel.includes('preload') && (node.getAttribute('as') || '') === 'script')) {
        const href = node.getAttribute('href');
        if (href) handleChunk(href, 'modulepreload');
      }
    }
  }

  function scanExisting() {
    try {
      for (const el of document.querySelectorAll(
        'script[src], link[rel="modulepreload"][href], link[rel="preload"][as="script"][href]'
      )) {
        handleNode(el);
      }
    } catch (_) {
      /* ignore */
    }
  }

  try {
    const mo = new MutationObserver(function (mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node && node.nodeType === 1) handleNode(node);
        }
      }
    });
    const start = function () {
      scanExisting();
      try {
        mo.observe(document.documentElement, { subtree: true, childList: true });
      } catch (_) {
        /* ignore */
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      setTimeout(start, 0);
    }
  } catch (_) {
    /* ignore */
  }

  /* ------------------------------------------------------------------ *
   * Cache-only bundle dissection
   * ------------------------------------------------------------------ */

  function emitBundle(url, status, extra) {
    const data = extra || {};
    bus.emit({
      kind: 'bundle',
      url: url,
      status: status,
      urls: Array.isArray(data.urls) ? data.urls.slice(0, 900) : [],
      bytes: data.bytes || 0,
      count: Array.isArray(data.urls) ? data.urls.length : 0,
      error: data.error ? clean(data.error, 120) : '',
      trigger: data.trigger || 'auto',
      via: data.via || '',
      pageUrl: root.location.href,
      ts: Date.now()
    });
  }

  async function responseFromCache(url) {
    // CacheStorage first: a Workbox/precache hit is entirely local.
    try {
      if (root.caches && typeof root.caches.match === 'function') {
        const cached = await root.caches.match(url);
        if (cached) return { response: cached, via: 'cache-storage' };
      }
    } catch (_) {
      /* no CacheStorage access */
    }
    // HTTP cache only. A miss must fail rather than touch the network.
    const response = await fetch(url, {
      cache: 'only-if-cached',
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error'
    });
    return { response: response, via: 'http-cache' };
  }

  async function readBundle(rawUrl, opts) {
    const options = opts || {};
    const url = absoluteHttp(rawUrl);
    if (!url) return { url: String(rawUrl || ''), status: 'invalid' };
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return { url: url, status: 'invalid' };
    }
    if (parsed.origin !== root.location.origin) {
      return { url: url, status: 'cross-origin' };
    }
    if (!N.isBundleUrl(parsed.pathname)) {
      return { url: url, status: 'not-a-bundle' };
    }

    const attemptKey = url;
    const previous = bundleAttempts.get(attemptKey) || { count: 0, last: 0 };
    if (!options.manual && previous.count >= 2) {
      return { url: url, status: 'attempts-exhausted' };
    }
    if (readTotals.bytes >= LIMITS.maxBundleReadTotalBytes) {
      emitBundle(url, 'skipped', { error: 'page byte budget reached', trigger: options.trigger });
      return { url: url, status: 'skipped', error: 'byte-budget' };
    }
    bundleAttempts.set(attemptKey, { count: previous.count + 1, last: Date.now() });

    let via = '';
    let response;
    try {
      const cached = await responseFromCache(url);
      response = cached.response;
      via = cached.via;
    } catch (error) {
      emitBundle(url, 'not-cached', {
        error: 'not available from cache',
        trigger: options.trigger
      });
      return { url: url, status: 'not-cached', error: 'cache-miss' };
    }

    try {
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !/(?:javascript|ecmascript|text\/plain|application\/octet-stream|application\/json)/.test(contentType)) {
        emitBundle(url, 'skipped', {
          error: 'unexpected content-type',
          trigger: options.trigger
        });
        return { url: url, status: 'skipped', error: 'content-type' };
      }
      const lengthHeader = Number(response.headers.get('content-length'));
      if (Number.isFinite(lengthHeader) && lengthHeader > LIMITS.maxBundleReadBytes) {
        emitBundle(url, 'skipped', {
          error: 'bundle too large',
          trigger: options.trigger
        });
        return { url: url, status: 'skipped', error: 'too-large' };
      }
      const text = await response.text();
      if (!text) {
        emitBundle(url, 'skipped', { error: 'empty bundle', trigger: options.trigger });
        return { url: url, status: 'skipped', error: 'empty' };
      }
      const capped = text.length > LIMITS.maxBundleReadBytes
        ? text.slice(0, LIMITS.maxBundleReadBytes)
        : text;
      readTotals.bytes += capped.length;
      const urls = N.extractScriptUrls(capped, url);
      emitBundle(url, 'analyzed', {
        urls: urls,
        bytes: capped.length,
        trigger: options.trigger,
        via: via
      });
      return {
        url: url,
        status: 'analyzed',
        count: urls.length,
        bytes: capped.length,
        via: via
      };
    } catch (error) {
      emitBundle(url, 'error', {
        error: 'read failed',
        trigger: options.trigger
      });
      return { url: url, status: 'error', error: 'read-failed' };
    }
  }

  if (root.chrome && root.chrome.runtime && root.chrome.runtime.onMessage) {
    root.chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== 'kimbo:read-bundles') return false;
      if (root.top !== root) return false;
      if (!Array.isArray(message.urls) || manualInFlight) {
        sendResponse({ ok: true, data: { results: [] } });
        return false;
      }
      manualInFlight = true;
      (async function () {
        const results = [];
        for (const url of message.urls.slice(0, 12)) {
          try {
            results.push(await readBundle(url, { trigger: 'manual', manual: true }));
          } catch (error) {
            results.push({ url: String(url), status: 'error' });
          }
        }
        manualInFlight = false;
        sendResponse({ ok: true, data: { results: results } });
      })();
      return true;
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
