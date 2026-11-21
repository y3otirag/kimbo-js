/**
 * Kimbo JS — service worker.
 *
 * Thin orchestration only:
 *  - routes messages between collectors, UI and the DevTools panel
 *  - owns dynamic content-script registration through ScopeManager
 *  - schedules storage probes (via chrome.scripting)
 *  - persists through SessionStore, which invokes the pure core pipeline
 *
 * No endpoint is ever requested. The only fetch in the whole extension lives
 * in script-collector.js and uses cache:'only-if-cached'.
 */
importScripts(
  '/src/core/constants.js',
  '/src/core/normalizer.js',
  '/src/core/matcher.js',
  '/src/core/risk.js',
  '/src/core/pipeline.js',
  '/src/core/exporter.js',
  '/src/collectors/storage-probe.js',
  '/src/background/session-store.js',
  '/src/background/scope-manager.js'
);

const C = globalThis.KimboCore.constants;
const N = globalThis.KimboCore.normalizer;
const Pipeline = globalThis.KimboCore.pipeline;
const SessionStore = globalThis.KimboBG.SessionStore;
const ScopeManager = globalThis.KimboBG.ScopeManager;

const probeTimers = new Map();
const lastProbeAt = new Map();
const tabOrigins = new Map();
const devtoolsWindows = new Map();

function logError(scope, error) {
  try {
    console.warn('[Kimbo] ' + scope + ':', error && error.message ? error.message : error);
  } catch (_) {
    /* ignore */
  }
}

function errorCode(error) {
  if (!error) return 'internal-error';
  const message = String(error.message || error);
  if (message.length <= 80 && /^[a-z0-9-]+$/i.test(message)) return message;
  return 'internal-error';
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

function senderOrigin(sender) {
  return safeOrigin(sender && sender.origin) || safeOrigin(sender && sender.url);
}

function scopeMode(scope) {
  return scope && scope.includeSameSite === false ? C.SCOPE_MODE.ORIGIN : C.SCOPE_MODE.SITE;
}

function broadcast(payload) {
  try {
    chrome.runtime.sendMessage(payload, function () {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    /* no listeners */
  }
}

function broadcastSession(origin, session) {
  if (!session) return;
  const stats = session.stats || Pipeline.computeStats(session);
  broadcast({
    type: 'kimbo:session.updated',
    origin: origin,
    revision: session.revision,
    stats: stats,
    identity: session.identity,
    updatedAt: session.updatedAt
  });
}

function updateBadge(tabId, origin, session) {
  if (!Number.isInteger(tabId)) return;
  const count = session && session.stats ? session.stats.endpoints : 0;
  const text = count > 999 ? '999+' : count > 0 ? String(count) : '';
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: text });
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#C8FF3D' });
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ tabId: tabId, color: '#071007' });
    }
    chrome.action.setTitle({
      tabId: tabId,
      title: count
        ? 'Kimbo JS — ' + count + ' endpoint' + (count === 1 ? '' : 's') + ' mapped'
        : 'Kimbo JS — passive API map'
    });
  } catch (_) {
    /* tab closed */
  }
}

async function refreshBadgeForTab(tabId) {
  let origin = tabOrigins.get(tabId) || null;
  if (!origin) {
    try {
      const tab = await chrome.tabs.get(tabId);
      origin = safeOrigin(tab && tab.url);
      if (origin) tabOrigins.set(tabId, origin);
    } catch (_) {
      return;
    }
  }
  if (!origin) return;
  try {
    const session = await SessionStore.get(origin);
    updateBadge(tabId, origin, session);
  } catch (_) {
    /* ignore */
  }
}

async function scheduleProbe(tabId, origin, delay) {
  if (!Number.isInteger(tabId) || !origin) return;
  const key = tabId + '|' + origin;
  const wait = Math.max(0, Number(delay) || 0);
  if (probeTimers.has(key)) clearTimeout(probeTimers.get(key));
  const timer = setTimeout(function () {
    probeTimers.delete(key);
    probeContext(tabId, origin, { manual: false }).catch(function (error) {
      logError('probe', error);
    });
  }, wait);
  probeTimers.set(key, timer);
}

async function probeContext(tabId, origin, opts) {
  const options = opts || {};
  const key = tabId + '|' + origin;
  const last = lastProbeAt.get(key) || 0;
  if (!options.manual && Date.now() - last < C.LIMITS.probeMinIntervalMs) {
    return { skipped: true, reason: 'rate-limited' };
  }
  const scope = await ScopeManager.getScope(origin);
  if (!scope || !scope.active) throw new Error('scope-not-sealed');
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    throw new Error('tab-unavailable');
  }
  const tabOrigin = safeOrigin(tab && (tab.url || tab.pendingUrl));
  if (tabOrigin !== origin) throw new Error('tab-origin-mismatch');

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: globalThis.KimboStorageProbe
    });
  } catch (_) {
    throw new Error('probe-failed');
  }
  lastProbeAt.set(key, Date.now());
  const entries =
    Array.isArray(results) && results[0] && Array.isArray(results[0].result)
      ? results[0].result.slice(0, C.LIMITS.maxProbeEntries)
      : [];
  const pageUrl = (tab && tab.url) || '';
  const session = await SessionStore.update(
    origin,
    function (state) {
      return Pipeline.ingest(
        state,
        [
          {
            kind: 'storage',
            entries: entries,
            pageUrl: pageUrl,
            pageTitle: (tab && tab.title) || '',
            ts: Date.now()
          }
        ],
        { origin: origin, scope: { mode: scopeMode(scope) }, pageUrl: pageUrl, now: Date.now() }
      );
    },
    { scope: { mode: scopeMode(scope) } }
  );
  broadcastSession(origin, session);
  updateBadge(tabId, origin, session);
  return {
    entries: entries.length,
    revision: session.revision,
    stats: session.stats,
    contextCapturedAt: session.contextCapturedAt
  };
}

async function handleContentEvents(message, sender) {
  if (!sender || sender.id !== chrome.runtime.id) throw new Error('invalid-sender');
  if (!sender.tab || !Number.isInteger(sender.tab.id)) throw new Error('not-a-content-script');
  const origin = senderOrigin(sender);
  if (!origin) throw new Error('invalid-origin');
  const scope = await ScopeManager.getScope(origin);
  if (!scope || !scope.active) throw new Error('scope-not-sealed');
  const events = Array.isArray(message.events) ? message.events.slice(0, C.LIMITS.maxEventsPerMessage) : [];
  if (!events.length) return { accepted: 0 };

  let sawPage = false;
  for (const event of events) {
    if (event && event.kind === 'page') {
      sawPage = true;
      break;
    }
  }

  const tabId = sender.tab.id;
  tabOrigins.set(tabId, origin);
  const pageUrl = sender.url || (sender.tab && sender.tab.url) || '';
  const session = await SessionStore.update(
    origin,
    function (state) {
      return Pipeline.ingest(state, events, {
        origin: origin,
        scope: { mode: scopeMode(scope) },
        pageUrl: pageUrl,
        now: Date.now()
      });
    },
    { scope: { mode: scopeMode(scope) } }
  );
  if (sawPage) {
    scheduleProbe(tabId, origin, C.LIMITS.probeLoadDelayMs);
  }
  broadcastSession(origin, session);
  updateBadge(tabId, origin, session);
  return {
    accepted: events.length,
    revision: session.revision,
    stats: session.stats
  };
}

async function sessionPayload(origin) {
  const session = await SessionStore.get(origin);
  return {
    session: session,
    summary: session ? Pipeline.summarize(session) : null
  };
}

async function handleScopeStatus(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  const status = await ScopeManager.status(origin, message.tabId);
  const payload = await sessionPayload(origin);
  return { status: status, summary: payload.summary };
}

async function handleScopeEnable(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  const tabId = Number(message.tabId);
  const result = await ScopeManager.enable({
    origin: origin,
    tabId: tabId,
    includeSameSite: message.includeSameSite !== false
  });
  await SessionStore.ensure(origin, {
    scope: {
      mode:
        message.includeSameSite === false ? C.SCOPE_MODE.ORIGIN : C.SCOPE_MODE.SITE
    }
  });
  const payload = await sessionPayload(origin);
  broadcast({ type: 'kimbo:scope.changed', origin: origin });
  if (result.injected) {
    scheduleProbe(tabId, origin, 500);
  }
  return { scope: result.status, summary: payload.summary };
}

async function handleScopeDisable(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  const result = await ScopeManager.disable({
    origin: origin,
    purge: Boolean(message.purge),
    removePermission: message.removePermission !== false
  });
  broadcast({ type: 'kimbo:scope.changed', origin: origin });
  return result;
}

async function handleContextCapture(message) {
  const origin = safeOrigin(message.origin);
  const tabId = Number(message.tabId);
  if (!origin || !Number.isInteger(tabId)) throw new Error('invalid-request');
  return probeContext(tabId, origin, { manual: true });
}

function tabMessage(tabId, payload, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('content-timeout'));
    }, timeoutMs || 10000);
    try {
      chrome.tabs.sendMessage(tabId, payload, function (response) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error('content-unreachable'));
        else resolve(response);
      });
    } catch (_) {
      clearTimeout(timer);
      reject(new Error('content-unreachable'));
    }
  });
}

async function handleBundleRead(message) {
  const origin = safeOrigin(message.origin);
  const tabId = Number(message.tabId);
  if (!origin || !Number.isInteger(tabId)) throw new Error('invalid-request');
  const scope = await ScopeManager.getScope(origin);
  if (!scope || !scope.active) throw new Error('scope-not-sealed');
  let urls = Array.isArray(message.urls)
    ? message.urls.filter((u) => typeof u === 'string')
    : [];
  if (!urls.length) {
    const session = await SessionStore.get(origin);
    if (session) {
      urls = Object.values(session.bundles || {})
        .filter((bundle) => bundle.readable && bundle.origin === origin)
        .filter((bundle) => bundle.status !== 'analyzed')
        .map((bundle) => bundle.url)
        .slice(0, 12);
    }
  }
  urls = urls.slice(0, 12);
  if (!urls.length) return { results: [], message: 'no-readable-bundles' };
  const response = await tabMessage(tabId, { type: 'kimbo:read-bundles', urls: urls }, 15000);
  if (!response || response.ok !== true) throw new Error('bundle-read-failed');
  return response.data || { results: [] };
}

async function handleBundleImport(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  const scope = await ScopeManager.getScope(origin);
  if (!scope || !scope.active) throw new Error('scope-not-sealed');
  const text = String(message.text || '');
  if (!text || text.length > C.LIMITS.maxPasteBytes) throw new Error('invalid-paste-size');
  const baseUrl = safeOrigin(message.baseUrl)
    ? message.baseUrl
    : origin + '/';
  let result = null;
  const session = await SessionStore.update(
    origin,
    function (state) {
      result = Pipeline.importScript(state, {
        text: text,
        baseUrl: baseUrl,
        label: message.label || 'pasted script'
      });
      return state;
    },
    { scope: { mode: scopeMode(scope) } }
  );
  broadcastSession(origin, session);
  return { count: result ? result.count : 0, revision: session.revision };
}

async function handlePin(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  let endpoint = null;
  const session = await SessionStore.update(origin, function (state) {
    endpoint = Pipeline.applyPin(state, {
      endpointId: message.endpointId,
      placeholderId: message.placeholderId,
      contextId: message.contextId || null
    });
    if (!endpoint) throw new Error('pin-failed');
    return state;
  });
  broadcastSession(origin, session);
  return { endpointId: endpoint.id, revision: session.revision };
}

async function handleNote(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  let endpoint = null;
  const session = await SessionStore.update(origin, function (state) {
    endpoint = Pipeline.setNote(state, {
      endpointId: message.endpointId,
      note: message.note
    });
    if (!endpoint) throw new Error('note-failed');
    return state;
  });
  broadcastSession(origin, session);
  return { endpointId: endpoint.id, revision: session.revision };
}

async function handlePurge(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  await SessionStore.remove(origin);
  broadcast({ type: 'kimbo:session.purged', origin: origin });
  const tabId = Number(message.tabId);
  if (Number.isInteger(tabId)) updateBadge(tabId, origin, null);
  return { origin: origin, purged: true };
}

async function handleDevtoolsRequest(message) {
  const origin = safeOrigin(message.origin);
  if (!origin) throw new Error('invalid-origin');
  const scope = await ScopeManager.getScope(origin);
  if (!scope || !scope.active) throw new Error('scope-not-sealed');
  const url = String(message.url || '');
  if (!/^https?:\/\//i.test(url)) return { accepted: false, reason: 'non-http' };
  let targetOrigin;
  try {
    targetOrigin = new URL(url).origin;
  } catch (_) {
    return { accepted: false, reason: 'invalid-url' };
  }
  if (!N.originInScope(origin, targetOrigin, scopeMode(scope))) {
    return { accepted: false, reason: 'out-of-scope' };
  }

  const now = Date.now();
  const windowKey = origin;
  const state = devtoolsWindows.get(windowKey) || { start: now, count: 0 };
  if (now - state.start >= 1000) {
    state.start = now;
    state.count = 0;
  }
  state.count++;
  devtoolsWindows.set(windowKey, state);
  if (state.count > C.LIMITS.maxDevtoolsEventsPerSecond) {
    return { accepted: false, reason: 'rate-limited' };
  }

  const event = {
    kind: 'network',
    method: N.sanitizeMethod(message.method) || 'GET',
    url: url,
    status: N.sanitizeStatus(message.status),
    contentType: N.cleanText(message.mimeType || '', 100),
    source: 'devtools',
    pageUrl: origin + '/',
    ts: now
  };
  const session = await SessionStore.update(
    origin,
    function (sessionState) {
      return Pipeline.ingest(sessionState, [event], {
        origin: origin,
        scope: { mode: scopeMode(scope) },
        pageUrl: origin + '/',
        now: now
      });
    },
    { scope: { mode: scopeMode(scope) } }
  );
  broadcastSession(origin, session);
  return { accepted: true, revision: session.revision };
}

function getActiveTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
      void chrome.runtime.lastError;
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

async function handleResolveActive() {
  const tab = await getActiveTab();
  if (!tab || !Number.isInteger(tab.id)) return { origin: null, tabId: null };
  let origin = safeOrigin(tab.url);
  if (!origin) origin = tabOrigins.get(tab.id) || null;
  return { origin: origin, tabId: tab.id };
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('invalid-message');
  const tabId = sender && sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case 'kimbo:events':
      return handleContentEvents(message, sender);
    case 'kimbo:scope.status':
      return handleScopeStatus(message);
    case 'kimbo:scope.enable':
      return handleScopeEnable(message);
    case 'kimbo:scope.disable':
      return handleScopeDisable(message);
    case 'kimbo:scope.rearm': {
      const origin = safeOrigin(message.origin);
      if (!origin) throw new Error('invalid-origin');
      const result = await ScopeManager.rearm({ origin: origin, tabId: Number(message.tabId) });
      scheduleProbe(Number(message.tabId), origin, 500);
      return result;
    }
    case 'kimbo:session.get': {
      const origin = safeOrigin(message.origin);
      if (!origin) throw new Error('invalid-origin');
      return sessionPayload(origin);
    }
    case 'kimbo:session.list':
      return { sessions: await SessionStore.list() };
    case 'kimbo:session.purge':
      return handlePurge(message);
    case 'kimbo:context.capture':
      return handleContextCapture(message);
    case 'kimbo:bundle.read':
      return handleBundleRead(message);
    case 'kimbo:bundle.import':
      return handleBundleImport(message);
    case 'kimbo:endpoint.pin':
      return handlePin(message);
    case 'kimbo:endpoint.note':
      return handleNote(message);
    case 'kimbo:devtools.request':
      return handleDevtoolsRequest(message);
    case 'kimbo:resolve.active':
      return handleResolveActive();
    default:
      throw new Error('unknown-message');
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  handleMessage(message, sender)
    .then(function (data) {
      sendResponse({ ok: true, data: data, tabId: sender && sender.tab ? sender.tab.id : null });
    })
    .catch(function (error) {
      logError(message && message.type, error);
      sendResponse({ ok: false, error: errorCode(error) });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(function () {
  ScopeManager.reconcile().catch(function (error) {
    logError('onInstalled/reconcile', error);
  });
});

chrome.runtime.onStartup.addListener(function () {
  ScopeManager.reconcile().catch(function (error) {
    logError('onStartup/reconcile', error);
  });
});

chrome.permissions.onRemoved.addListener(function () {
  ScopeManager.reconcile()
    .then(function () {
      broadcast({ type: 'kimbo:scope.changed' });
    })
    .catch(function (error) {
      logError('permissions/onRemoved', error);
    });
});

chrome.permissions.onAdded.addListener(function () {
  ScopeManager.reconcile().catch(function (error) {
    logError('permissions/onAdded', error);
  });
});

chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId !== 0) return;
  const origin = safeOrigin(details.url);
  if (!origin) return;
  tabOrigins.set(details.tabId, origin);
  refreshBadgeForTab(details.tabId).catch(function () {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener(function (details) {
  if (details.frameId !== 0) return;
  const origin = safeOrigin(details.url);
  if (!origin) return;
  tabOrigins.set(details.tabId, origin);
  ScopeManager.getScope(origin)
    .then(function (scope) {
      if (!scope || !scope.active) return;
      try {
        chrome.tabs.sendMessage(details.tabId, { type: 'kimbo:route-changed' }, function () {
          void chrome.runtime.lastError;
        });
      } catch (_) {
        /* frame not ready */
      }
      scheduleProbe(details.tabId, origin, C.LIMITS.probeRouteDelayMs);
    })
    .catch(function (error) {
      logError('historyStateUpdated', error);
    });
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener(function (details) {
  if (details.frameId !== 0) return;
  const origin = safeOrigin(details.url);
  if (!origin) return;
  tabOrigins.set(details.tabId, origin);
  ScopeManager.getScope(origin)
    .then(function (scope) {
      if (!scope || !scope.active) return;
      try {
        chrome.tabs.sendMessage(details.tabId, { type: 'kimbo:route-changed' }, function () {
          void chrome.runtime.lastError;
        });
      } catch (_) {
        /* ignore */
      }
    })
    .catch(function () {});
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
  refreshBadgeForTab(activeInfo.tabId).catch(function () {});
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  tabOrigins.delete(tabId);
  for (const key of Array.from(probeTimers.keys())) {
    if (key.indexOf(tabId + '|') === 0) {
      clearTimeout(probeTimers.get(key));
      probeTimers.delete(key);
    }
  }
});
