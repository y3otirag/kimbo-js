/**
 * Kimbo JS — page lifecycle.
 * Announces the document to the service worker (which triggers a storage
 * probe) and reacts to SPA history changes and bfcache restores.
 */
(function (root) {
  'use strict';
  const bus = root.KimboBus;
  if (!bus) return;

  let lastAnnounce = 0;
  let pending = null;

  function isTop() {
    try {
      return root.top === root;
    } catch (_) {
      return true;
    }
  }

  function announce(reason) {
    if (!isTop()) return;
    const now = Date.now();
    if (now - lastAnnounce < 250) return;
    lastAnnounce = now;
    bus.emit({
      kind: 'page',
      url: root.location.href,
      title: root.document && root.document.title ? root.document.title : '',
      reason: reason || 'load',
      ts: now
    });
  }

  function announceSoon(delay) {
    if (pending) clearTimeout(pending);
    pending = setTimeout(function () {
      pending = null;
      announce('load');
      bus.requestRescan();
    }, delay || 0);
  }

  function boot() {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener(
        'DOMContentLoaded',
        function () {
          announceSoon(250);
        },
        { once: true }
      );
    } else {
      announceSoon(0);
    }
    try {
      root.addEventListener('load', function () {
        announce('load');
      });
      root.addEventListener('pageshow', function (event) {
        if (event && event.persisted) {
          announce('bfcache');
          bus.requestRescan();
        }
      });
      root.addEventListener('popstate', function () {
        announceSoon(80);
      });
      root.addEventListener('hashchange', function () {
        announceSoon(80);
      });
    } catch (_) {
      /* non-DOM harness */
    }
  }

  if (root.chrome && root.chrome.runtime && root.chrome.runtime.onMessage) {
    root.chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== 'kimbo:route-changed') return false;
      if (!isTop()) return false;
      announceSoon(60);
      setTimeout(function () {
        if (isTop()) bus.requestRescan();
      }, 650);
      return false;
    });
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
