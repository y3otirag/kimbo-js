/**
 * Kimbo JS — content-script event bus.
 * Batches, deduplicates and ships observations to the service worker.
 * Contains no network logic. In a plain page harness it can write to
 * __KIMBO_TEST_SINK__ for offline tests.
 */
(function (root) {
  'use strict';
  if (root.KimboBus) return;

  const MAX_QUEUE = 120;
  const MAX_EVENTS_PER_MESSAGE = 40;
  const MAX_MESSAGE_BYTES = 220000;
  const DEDUPE_TTL_MS = 4000;
  const DEDUPE_MAX = 700;

  let queue = [];
  let timer = null;
  const recent = new Map();
  const rescanListeners = new Set();

  function pageInfo() {
    let topUrl = '';
    try {
      if (root.top && root.top !== root) topUrl = root.top.location.href || '';
      else topUrl = root.location.href || '';
    } catch (_) {
      topUrl = '';
    }
    return {
      pageUrl: root.location && root.location.href ? root.location.href : '',
      pageTitle: root.document && root.document.title ? root.document.title : '',
      topUrl: topUrl,
      frame: root.top === root ? 'top' : 'sub'
    };
  }

  function arrayHint(value) {
    if (!Array.isArray(value)) return '';
    const head = value
      .slice(0, 3)
      .map(function (item) {
        if (typeof item === 'string') return item;
        if (item && typeof item.raw === 'string') return item.raw;
        if (item && item.key) return item.key + '=' + item.value;
        return '';
      })
      .filter(Boolean)
      .join('~');
    return value.length + ':' + head;
  }

  function dedupeKey(event) {
    return [
      event.kind || '',
      event.url || event.raw || '',
      event.method || '',
      event.status == null ? '' : event.status,
      event.source && event.source.label ? event.source.label : '',
      arrayHint(event.urls),
      arrayHint(event.candidates),
      arrayHint(event.context)
    ].join('|');
  }

  function isDuplicate(event) {
    const now = Date.now();
    const key = dedupeKey(event);
    const previous = recent.get(key);
    if (previous && now - previous < DEDUPE_TTL_MS) return true;
    recent.set(key, now);
    if (recent.size > DEDUPE_MAX) {
      for (const [k, ts] of recent) {
        if (now - ts > DEDUPE_TTL_MS) recent.delete(k);
        if (recent.size <= DEDUPE_MAX / 2) break;
      }
    }
    return false;
  }

  function emit(event) {
    if (!event || typeof event !== 'object' || !event.kind) return;
    try {
      if (isDuplicate(event)) return;
    } catch (_) {
      /* never let dedupe break collection */
    }
    const info = pageInfo();
    const enriched = Object.assign({}, event, info, {
      ts: Number(event.ts) || Date.now(),
      v: 1
    });
    queue.push(enriched);
    if (queue.length >= MAX_QUEUE) {
      flush();
      return;
    }
    schedule();
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      flush();
    }, 140);
  }

  function sink(events) {
    if (Array.isArray(root.__KIMBO_TEST_SINK__)) {
      for (const event of events) root.__KIMBO_TEST_SINK__.push(event);
      return;
    }
    const runtime = root.chrome && root.chrome.runtime;
    if (!runtime || !runtime.id || typeof runtime.sendMessage !== 'function') {
      return;
    }
    runtime.sendMessage({ type: 'kimbo:events', events: events }, function () {
      // Reading lastError prevents noisy "Unchecked runtime.lastError".
      void (root.chrome.runtime.lastError);
    });
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return;
    const pending = queue;
    queue = [];
    let batch = [];
    let bytes = 0;

    function ship() {
      if (!batch.length) return;
      try {
        sink(batch);
      } catch (_) {
        /* extension reloaded or page tearing down */
      }
      batch = [];
      bytes = 0;
    }

    for (const event of pending) {
      let size = 0;
      try {
        size = JSON.stringify(event).length;
      } catch (_) {
        size = 0;
      }
      if (batch.length >= MAX_EVENTS_PER_MESSAGE || bytes + size > MAX_MESSAGE_BYTES) {
        ship();
      }
      batch.push(event);
      bytes += size;
    }
    ship();
  }

  function onRescan(listener) {
    if (typeof listener !== 'function') return function () {};
    rescanListeners.add(listener);
    return function () {
      rescanListeners.delete(listener);
    };
  }

  function requestRescan() {
    for (const listener of Array.from(rescanListeners)) {
      try {
        listener();
      } catch (_) {
        /* isolation between collectors */
      }
    }
  }

  root.KimboBus = {
    emit: emit,
    flush: flush,
    onRescan: onRescan,
    requestRescan: requestRescan,
    pageInfo: pageInfo
  };

  try {
    root.addEventListener('pagehide', flush, { capture: true });
    root.document.addEventListener('visibilitychange', function () {
      if (root.document.visibilityState === 'hidden') flush();
    });
  } catch (_) {
    /* non-DOM harness */
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
