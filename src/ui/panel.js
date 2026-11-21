/* Kimbo JS — DevTools panel boot + passive HAR metadata mirror. */
(function (root) {
  'use strict';
  const UI = root.KimboUI;
  const API = UI.api;

  function inspectedOrigin(callback) {
    try {
      const params = new URLSearchParams(location.search);
      const forced = params.get('origin');
      if (forced) {
        callback(API.safeOrigin(forced));
        return;
      }
      if (!chrome.devtools || !chrome.devtools.inspectedWindow) {
        callback(null);
        return;
      }
      chrome.devtools.inspectedWindow.eval('location.origin', function (origin, exception) {
        if (exception) {
          callback(null);
          return;
        }
        callback(API.safeOrigin(origin));
      });
    } catch (_) {
      callback(null);
    }
  }

  function inspectedTabId() {
    try {
      if (chrome.devtools && chrome.devtools.inspectedWindow) {
        return Number(chrome.devtools.inspectedWindow.tabId);
      }
    } catch (_) {
      /* opened as a plain extension page for testing */
    }
    try {
      const params = new URLSearchParams(location.search);
      const tabId = Number(params.get('tabId'));
      return Number.isInteger(tabId) ? tabId : null;
    } catch (_) {
      return null;
    }
  }

  function boot() {
    const tabId = inspectedTabId();
    inspectedOrigin(function (origin) {
      UI.shell
        .mount({ mode: 'panel', origin: origin, tabId: tabId })
        .then(function () {
          startNetworkMirror(origin, tabId);
        })
        .catch(function (error) {
          const app = document.getElementById('app');
          if (!app) return;
          app.textContent = '';
          const box = document.createElement('div');
          box.className = 'empty-state';
          const title = document.createElement('div');
          title.className = 'empty-title';
          title.textContent = 'Kimbo could not start';
          const copy = document.createElement('div');
          copy.className = 'empty-copy';
          copy.textContent = error && error.message ? error.message : 'Reload DevTools and retry.';
          box.appendChild(title);
          box.appendChild(copy);
          app.appendChild(box);
        });
    });
  }

  function startNetworkMirror(origin, tabId) {
    if (!origin || !Number.isInteger(tabId)) return;
    if (!chrome.devtools || !chrome.devtools.network) return;
    let windowStart = 0;
    let count = 0;
    chrome.devtools.network.onRequestFinished.addListener(function (har) {
      if (!har || !har.request || !har.response) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      count++;
      if (count > 8) return;
      const type = String(har._resourceType || '').toLowerCase();
      const mime = String(
        (har.response.content && har.response.content.mimeType) || ''
      ).toLowerCase();
      const isApi =
        type === 'xhr' ||
        type === 'fetch' ||
        mime.includes('json') ||
        mime.includes('graphql');
      if (!isApi) return;
      const url = String(har.request.url || '');
      if (!/^https?:\/\//i.test(url)) return;
      API.devtoolsRequest({
        origin: origin,
        tabId: tabId,
        url: url,
        method: har.request.method || 'GET',
        status: har.response.status,
        mimeType: mime
      }).catch(function () {
        /* panel may be closed or scope inactive */
      });
    });
    chrome.devtools.network.onNavigated.addListener(function () {
      setTimeout(function () {
        location.reload();
      }, 280);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
