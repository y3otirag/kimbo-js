/**
 * Kimbo JS — DOM collector.
 *
 * Walks the live DOM (including open shadow roots and template content),
 * extracts URL-bearing attributes, forms, data-* identity hints, inline
 * handlers and inline scripts. Inline JS is parsed locally; the raw script
 * text never leaves the page.
 */
(function (root) {
  'use strict';
  const core = root.KimboCore;
  const N = core && core.normalizer;
  const C = core && core.constants;
  const bus = root.KimboBus;
  if (!N || !C || !bus) return;

  const LIMITS = C.LIMITS;
  const URL_ATTRS = new Set([
    'href',
    'src',
    'action',
    'formaction',
    'ping',
    'cite',
    'data',
    'longdesc',
    'manifest',
    'background',
    'poster'
  ]);
  const SKIP_SRC_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'IMG',
    'SOURCE',
    'VIDEO',
    'AUDIO',
    'TRACK',
    'EMBED',
    'OBJECT',
    'INPUT'
  ]);
  const SKIP_HOST_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
  const DATA_URL_ATTR_RE = /^data-(?:api|url|uri|endpoint|href|src|action|path|route|fetch|base|graphql|rpc)(?:[-_].*)?$/i;
  const DATA_ID_ATTR_RE = /^data-(?:id|uuid|guid|oid|user[-_]?id|org[-_]?id|organization[-_]?id|tenant[-_]?id|account[-_]?id|member[-_]?id|owner[-_]?id|project[-_]?id|workspace[-_]?id|team[-_]?id|order[-_]?id|invoice[-_]?id|file[-_]?id|.*[-_]id)$/i;
  const META_HINT_RE = /(?:api|url|endpoint|identity|user|org|tenant|account|project|member|owner|id|uuid)/i;

  const seenAttrs = new WeakMap();
  const seenScripts = new Set();
  const observedRoots = new WeakSet();
  const pendingElements = new Set();
  const pendingRoots = new Set();
  let scheduled = false;
  let scanBudget = 0;
  let observer = null;
  let shadowObserverCount = 0;
  let batchCandidates = [];
  let batchContext = [];
  let batchTimer = null;
  let batchSeen = new Set();
  let initialized = false;

  function locator(el) {
    if (!el || !el.tagName) return 'node';
    let name = el.tagName.toLowerCase();
    try {
      if (el.id) return clamp(name + '#' + el.id, 110);
      const cls = el.classList && el.classList.length ? el.classList[0] : '';
      if (cls) name += '.' + cls;
      if (el.getAttribute && el.getAttribute('name')) {
        name += '[name="' + el.getAttribute('name') + '"]';
      }
    } catch (_) {
      /* keep tag */
    }
    return clamp(name, 110);
  }

  function clamp(value, max) {
    const s = String(value == null ? '' : value);
    return s.length > max ? s.slice(0, max) : s;
  }

  function isSeen(el, name, value) {
    let map = seenAttrs.get(el);
    if (!map) {
      map = new Map();
      seenAttrs.set(el, map);
    }
    if (map.get(name) === value) return true;
    map.set(name, value);
    return false;
  }

  function addCandidate(raw, el, attrName, method, kind) {
    if (typeof raw !== 'string') return;
    const value = raw.trim();
    if (!value || value.length > LIMITS.maxUrlLength) return;
    if (/^(?:#|javascript:|data:|blob:|mailto:|tel:|about:)/i.test(value)) return;
    if (!N.looksLikeUrlCandidate(value)) return;
    const key = [value, method || '', attrName || ''].join('|');
    if (batchSeen.has(key)) return;
    batchSeen.add(key);
    batchCandidates.push({
      raw: value,
      baseUrl: root.location.href,
      method: method || null,
      source: {
        kind: kind || 'dom-attr',
        label: '<' + locator(el) + ' ' + (attrName || 'url') + '>'
      }
    });
    if (batchCandidates.length >= LIMITS.maxDomCandidatesPerScan) flushBatch(true);
    else scheduleBatch();
  }

  function addContext(key, value, el, label) {
    if (!key || value == null) return;
    const text = String(value).trim();
    if (!text || text.length > LIMITS.maxValueLength) return;
    const candidate = N.makeContextCandidate({
      key: key,
      value: text,
      source: {
        kind: 'dom',
        label: label || '<' + locator(el) + '>',
        pageUrl: root.location.href
      }
    });
    if (!candidate) return;
    const signature = candidate.normKey + '\u0000' + candidate.value;
    if (batchSeen.has('ctx|' + signature)) return;
    batchSeen.add('ctx|' + signature);
    batchContext.push({
      key: candidate.key,
      value: candidate.value,
      source: candidate.source
    });
    if (batchContext.length >= LIMITS.maxDomContextPerScan) flushBatch(true);
    else scheduleBatch();
  }

  function flushBatch(force) {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    if (!batchCandidates.length && !batchContext.length) return;
    if (!force && batchCandidates.length + batchContext.length < 20) {
      scheduleBatch();
      return;
    }
    const event = {
      kind: 'dom',
      candidates: batchCandidates.slice(0, LIMITS.maxDomCandidatesPerScan),
      context: batchContext.slice(0, LIMITS.maxDomContextPerScan),
      ts: Date.now()
    };
    batchCandidates = [];
    batchContext = [];
    batchSeen = new Set();
    bus.emit(event);
  }

  function scheduleBatch() {
    if (batchTimer) return;
    batchTimer = setTimeout(function () {
      batchTimer = null;
      flushBatch(true);
    }, 180);
  }

  function emitScript(urls, baseUrl, label) {
    if (!Array.isArray(urls) || !urls.length) return;
    bus.emit({
      kind: 'script',
      urls: urls.slice(0, 400),
      baseUrl: baseUrl || root.location.href,
      source: { kind: 'inline-script', label: label || 'inline script' },
      ts: Date.now()
    });
  }

  function processInlineScript(el) {
    if (!el || el.tagName !== 'SCRIPT') return;
    if (el.getAttribute('src')) return;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type && !/(?:javascript|ecmascript|json|ld\+json|module)/.test(type)) return;
    const raw = el.textContent || '';
    if (!raw.trim()) return;
    const text = raw.length > LIMITS.maxInlineScriptBytes ? raw.slice(0, LIMITS.maxInlineScriptBytes) : raw;
    const hash = N.fnv1a(text);
    if (seenScripts.has(hash)) return;
    seenScripts.add(hash);
    if (seenScripts.size > 300) seenScripts.clear();
    const urls = N.extractScriptUrls(text, root.location.href);
    if (urls.length) {
      emitScript(urls, root.location.href, 'inline <script> ' + hash);
    }
  }

  function processInlineHandler(el, attrName, raw) {
    if (!raw || raw.length > 8192) return;
    const urls = N.extractScriptUrls(raw, root.location.href);
    if (urls.length) {
      emitScript(urls, root.location.href, '<' + locator(el) + ' ' + attrName + '>');
    }
  }

  function processMeta(el, attrName, value) {
    if (attrName !== 'content') return;
    const hint = (el.getAttribute('name') || el.getAttribute('property') || el.getAttribute('http-equiv') || '');
    if (!META_HINT_RE.test(hint)) return;
    if (N.looksLikeUrlCandidate(value)) {
      addCandidate(value, el, 'meta:' + hint, null, 'dom-meta');
      return;
    }
    if (N.isIdKey(hint) && N.isUsableContextValue(hint, value)) {
      addContext(hint, value, el, '<meta name="' + hint + '">');
    }
  }

  function processInput(el) {
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
    const name = el.getAttribute('name') || el.getAttribute('id') || '';
    if (!name) return;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password' || type === 'file' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'reset') {
        return;
      }
    }
    const value = el.value;
    if (!value) return;
    if (N.isIdKey(name) && !N.isSensitiveKey(name) && !N.isPiiKey(name)) {
      addContext(name, value, el, 'form field ' + name);
    }
  }

  function processForm(el) {
    if (el.tagName !== 'FORM') return;
    const action = el.getAttribute('action');
    const method = (el.getAttribute('method') || 'GET').toUpperCase();
    if (action) addCandidate(action, el, 'action', method, 'form');
    const fields = el.querySelectorAll('input,select,textarea');
    let count = 0;
    for (const field of fields) {
      if (count++ > 60) break;
      processInput(field);
    }
  }

  function processAttribute(el, attr) {
    if (!attr) return;
    const name = String(attr.name || '').toLowerCase();
    const value = String(attr.value == null ? '' : attr.value);
    if (!name || !value.trim()) return;
    if (isSeen(el, name, value)) return;
    if (SKIP_HOST_TAGS.has(el.tagName) && name !== 'content') {
      // Inline script text is handled separately; CSS is irrelevant.
      if (!name.startsWith('on')) return;
    }

    if (name.startsWith('on') && name.length > 2) {
      processInlineHandler(el, name, value);
      return;
    }

    if (name === 'srcdoc') {
      const urls = N.extractScriptUrls(value, root.location.href);
      if (urls.length) emitScript(urls, root.location.href, '<' + locator(el) + ' srcdoc>');
      return;
    }

    if (name === 'srcset') {
      if (['IMG', 'SOURCE', 'PICTURE'].includes(el.tagName)) return;
      for (const part of value.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url) addCandidate(url, el, name, null, 'dom-attr');
      }
      return;
    }

    if (name === 'content') {
      processMeta(el, name, value);
      return;
    }

    if (DATA_URL_ATTR_RE.test(name)) {
      addCandidate(value, el, name, null, 'dom-data');
    } else if (name.startsWith('data-') && N.looksLikeUrlCandidate(value)) {
      addCandidate(value, el, name, null, 'dom-data');
    }

    if (DATA_ID_ATTR_RE.test(name)) {
      const key = name.replace(/^data-/, '');
      addContext(key, value, el, '<' + locator(el) + ' ' + name + '>');
    }

    if (!URL_ATTRS.has(name)) return;

    if (name === 'src') {
      if (SKIP_SRC_TAGS.has(el.tagName)) return;
      if (!N.isApiLike(value) && !/[/](?:api|graphql|rest|v\d+)[/]/i.test(value)) return;
    }

    if (name === 'href' && el.tagName === 'LINK') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      const as = (el.getAttribute('as') || '').toLowerCase();
      if (/stylesheet|icon|manifest|preload|prefetch|modulepreload/.test(rel) && as !== 'fetch') {
        return;
      }
    }

    if (name === 'ping') {
      for (const url of value.split(/\s+/)) {
        if (url) addCandidate(url, el, name, 'POST', 'dom-ping');
      }
      return;
    }

    if (name === 'action' && el.tagName === 'FORM') return;

    addCandidate(value, el, name, null, 'dom-attr');
  }

  function processElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (scanBudget <= 0) return;
    scanBudget--;
    try {
      if (el.tagName === 'SCRIPT') processInlineScript(el);
      if (el.tagName === 'FORM') processForm(el);
      if (el.attributes && el.attributes.length) {
        for (const attr of Array.from(el.attributes)) processAttribute(el, attr);
      }
      if (el.shadowRoot) {
        observeRoot(el.shadowRoot);
        scanRoot(el.shadowRoot);
      }
      if (el.tagName === 'TEMPLATE' && el.content) scanRoot(el.content);
    } catch (_) {
      /* one bad node must not stop the scan */
    }
  }

  function scanRoot(rootNode) {
    if (!rootNode || scanBudget <= 0) return;
    if (rootNode.nodeType === 1) processElement(rootNode);
    let nodes;
    try {
      nodes = rootNode.querySelectorAll ? rootNode.querySelectorAll('*') : [];
    } catch (_) {
      return;
    }
    for (const el of nodes) {
      if (scanBudget <= 0) break;
      processElement(el);
    }
  }

  function observeRoot(rootNode) {
    if (!rootNode || observedRoots.has(rootNode)) return;
    observedRoots.add(rootNode);
    if (shadowObserverCount >= 25) return;
    shadowObserverCount++;
    try {
      const mo = new MutationObserver(handleMutations);
      mo.observe(rootNode, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: false
      });
    } catch (_) {
      /* shadow root may disappear */
    }
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target) {
        pendingElements.add(mutation.target);
      } else if (mutation.type === 'childList') {
        if (mutation.target && mutation.target.nodeType === 1) {
          pendingElements.add(mutation.target);
        }
        for (const node of mutation.addedNodes) {
          if (node && node.nodeType === 1) pendingRoots.add(node);
        }
      }
    }
    scheduleScan();
  }

  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      scanBudget = LIMITS.maxDomNodesPerScan;
      const elements = Array.from(pendingElements);
      const roots = Array.from(pendingRoots);
      pendingElements.clear();
      pendingRoots.clear();
      for (const el of elements) {
        if (!el.isConnected && !el.shadowRoot) continue;
        processElement(el);
      }
      for (const node of roots) {
        if (!node.isConnected && node.parentNode) continue;
        scanRoot(node);
      }
      flushBatch(false);
    }, 140);
  }

  function initialScan() {
    if (initialized) return;
    initialized = true;
    scanBudget = LIMITS.maxDomNodesPerScan;
    scanRoot(root.document);
    flushBatch(true);
    try {
      if (observer) observer.disconnect();
      observer = new MutationObserver(handleMutations);
      observer.observe(root.document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: false
      });
    } catch (_) {
      /* extremely early document */
    }
  }

  function boot() {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', function () {
        setTimeout(initialScan, 0);
      }, { once: true });
    } else {
      setTimeout(initialScan, 0);
    }
  }

  bus.onRescan(function () {
    initialized = false;
    setTimeout(initialScan, 80);
  });

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
