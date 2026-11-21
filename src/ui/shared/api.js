/* Kimbo JS — typed-ish IPC with the service worker. */
(function (root) {
  'use strict';
  const UI = (root.KimboUI = root.KimboUI || {});

  function send(type, payload) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(Object.assign({ type: type }, payload || {}), function (response) {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error('extension-unavailable'));
            return;
          }
          if (!response || response.ok !== true) {
            reject(new Error((response && response.error) || 'request-failed'));
            return;
          }
          resolve(response.data);
        });
      } catch (_) {
        reject(new Error('extension-unavailable'));
      }
    });
  }

  function safeOrigin(value) {
    try {
      const u = new URL(String(value));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch (_) {
      return null;
    }
  }

  function getScopeStatus(origin, tabId) {
    return send('kimbo:scope.status', { origin: origin, tabId: tabId });
  }

  function getSession(origin) {
    return send('kimbo:session.get', { origin: origin });
  }

  function enableScope(origin, tabId, includeSameSite) {
    return send('kimbo:scope.enable', {
      origin: origin,
      tabId: tabId,
      includeSameSite: includeSameSite !== false
    });
  }

  function disableScope(origin, opts) {
    const options = opts || {};
    return send('kimbo:scope.disable', {
      origin: origin,
      purge: Boolean(options.purge),
      removePermission: options.removePermission !== false
    });
  }

  function rearm(origin, tabId) {
    return send('kimbo:scope.rearm', { origin: origin, tabId: tabId });
  }

  function captureContext(origin, tabId) {
    return send('kimbo:context.capture', { origin: origin, tabId: tabId });
  }

  function readBundles(origin, tabId, urls) {
    return send('kimbo:bundle.read', {
      origin: origin,
      tabId: tabId,
      urls: Array.isArray(urls) ? urls : []
    });
  }

  function importBundle(origin, text, baseUrl) {
    return send('kimbo:bundle.import', {
      origin: origin,
      text: text,
      baseUrl: baseUrl
    });
  }

  function pin(origin, endpointId, placeholderId, contextId) {
    return send('kimbo:endpoint.pin', {
      origin: origin,
      endpointId: endpointId,
      placeholderId: placeholderId,
      contextId: contextId || null
    });
  }

  function note(origin, endpointId, text) {
    return send('kimbo:endpoint.note', {
      origin: origin,
      endpointId: endpointId,
      note: text
    });
  }

  function purge(origin, tabId) {
    return send('kimbo:session.purge', { origin: origin, tabId: tabId });
  }

  function resolveActive() {
    return send('kimbo:resolve.active', {});
  }

  function devtoolsRequest(payload) {
    return send('kimbo:devtools.request', payload);
  }

  function requestHostPermission(origin) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.permissions.request({ origins: [origin + '/*'] }, function (granted) {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message || 'permission-request-failed'));
          else resolve(Boolean(granted));
        });
      } catch (_) {
        reject(new Error('permission-request-failed'));
      }
    });
  }

  function removeHostPermission(origin) {
    return new Promise(function (resolve) {
      try {
        chrome.permissions.remove({ origins: [origin + '/*'] }, function (removed) {
          void chrome.runtime.lastError;
          resolve(Boolean(removed));
        });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function getActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
        void chrome.runtime.lastError;
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function reloadTab(tabId) {
    return new Promise(function (resolve, reject) {
      if (!Number.isInteger(tabId)) {
        reject(new Error('missing-tab'));
        return;
      }
      chrome.tabs.reload(tabId, function () {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error('reload-failed'));
        else resolve(true);
      });
    });
  }

  function subscribe(origin, handler) {
    const listener = function (message) {
      if (!message || typeof message.type !== 'string') return;
      if (message.type !== 'kimbo:session.updated' &&
          message.type !== 'kimbo:session.purged' &&
          message.type !== 'kimbo:scope.changed') {
        return;
      }
      if (message.origin && message.origin !== origin) return;
      try {
        handler(message);
      } catch (_) {
        /* UI handler must never break IPC */
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return function () {
      try {
        chrome.runtime.onMessage.removeListener(listener);
      } catch (_) {
        /* ignore */
      }
    };
  }

  UI.api = {
    send: send,
    safeOrigin: safeOrigin,
    getScopeStatus: getScopeStatus,
    getSession: getSession,
    enableScope: enableScope,
    disableScope: disableScope,
    rearm: rearm,
    captureContext: captureContext,
    readBundles: readBundles,
    importBundle: importBundle,
    pin: pin,
    note: note,
    purge: purge,
    resolveActive: resolveActive,
    devtoolsRequest: devtoolsRequest,
    requestHostPermission: requestHostPermission,
    removeHostPermission: removeHostPermission,
    getActiveTab: getActiveTab,
    reloadTab: reloadTab,
    subscribe: subscribe
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
