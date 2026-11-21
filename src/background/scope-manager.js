/**
 * Kimbo JS — scope manager.
 *
 * A scope is an explicit, user-granted origin permission. No content script
 * runs anywhere else. Registration is dynamic (registerContentScripts) and
 * injection into the current tab happens only after the permission check.
 */
(function (root) {
  'use strict';
  const N = root.KimboCore && root.KimboCore.normalizer;
  const C = root.KimboCore && root.KimboCore.constants;
  const SessionStore = root.KimboBG && root.KimboBG.SessionStore;
  if (!N || !C || !SessionStore) return;

  const SCOPES_KEY = 'kimbo:scopes';
  const MAIN_FILES = [
    'src/core/constants.js',
    'src/core/normalizer.js',
    'src/collectors/network-hook.js'
  ];
  const ISOLATED_FILES = [
    'src/core/constants.js',
    'src/core/normalizer.js',
    'src/collectors/bus.js',
    'src/collectors/dom-collector.js',
    'src/collectors/script-collector.js',
    'src/collectors/lifecycle.js'
  ];
  let chain = Promise.resolve();

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(function () {});
    return run;
  }

  function storageGet(keys) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(keys, function (items) {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(items || {});
      });
    });
  }

  function storageSet(items) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(items, function () {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function patternsContain(origins) {
    return new Promise(function (resolve) {
      chrome.permissions.contains({ origins: origins }, function (result) {
        void chrome.runtime.lastError;
        resolve(Boolean(result));
      });
    });
  }

  function getTab(tabId) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.get(tabId, function (tab) {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(tab);
      });
    });
  }

  function patternFor(origin) {
    return origin + '/*';
  }

  function idsFor(origin) {
    const hash = N.fnv1a(origin);
    return {
      main: 'kimbo-main-' + hash,
      isolated: 'kimbo-iso-' + hash
    };
  }

  function safeOrigin(value) {
    try {
      const u = new URL(String(value));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!u.hostname) return null;
      return u.origin;
    } catch (_) {
      return null;
    }
  }

  async function readScopes() {
    const items = await storageGet(SCOPES_KEY);
    const scopes = items[SCOPES_KEY];
    return scopes && typeof scopes === 'object' ? scopes : {};
  }

  async function writeScopes(scopes) {
    await storageSet({ [SCOPES_KEY]: scopes });
  }

  async function getScope(origin) {
    const scopes = await readScopes();
    return scopes[origin] || null;
  }

  async function unregister(origin) {
    const ids = idsFor(origin);
    try {
      await chrome.scripting.unregisterContentScripts({
        ids: [ids.main, ids.isolated]
      });
    } catch (_) {
      /* nothing registered */
    }
  }

  async function register(origin) {
    const ids = idsFor(origin);
    const pattern = patternFor(origin);
    await unregister(origin);
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: ids.main,
          matches: [pattern],
          js: MAIN_FILES,
          runAt: 'document_start',
          allFrames: true,
          world: 'MAIN',
          persistAcrossSessions: true
        },
        {
          id: ids.isolated,
          matches: [pattern],
          js: ISOLATED_FILES,
          runAt: 'document_start',
          allFrames: true,
          persistAcrossSessions: true
        }
      ]);
    } catch (error) {
      try {
        await unregister(origin);
      } catch (_) {
        /* ignore */
      }
      throw error;
    }
  }

  async function executeFiles(tabId, files, world) {
    const payload = {
      target: { tabId: tabId, allFrames: true },
      files: files,
      injectImmediately: true
    };
    if (world) payload.world = world;
    try {
      await chrome.scripting.executeScript(payload);
      return true;
    } catch (_) {
      // A cross-origin iframe can make allFrames fail. Fall back to the main frame.
      const fallback = {
        target: { tabId: tabId },
        files: files,
        injectImmediately: true
      };
      if (world) fallback.world = world;
      await chrome.scripting.executeScript(fallback);
      return true;
    }
  }

  async function injectNow(tabId) {
    await executeFiles(tabId, MAIN_FILES, 'MAIN');
    await executeFiles(tabId, ISOLATED_FILES, null);
  }

  async function tabMatchesOrigin(tabId, origin) {
    if (!Number.isInteger(tabId)) return { ok: false, reason: 'missing-tab' };
    let tab;
    try {
      tab = await getTab(tabId);
    } catch (_) {
      return { ok: false, reason: 'tab-unavailable' };
    }
    const url = tab.url || tab.pendingUrl || '';
    const tabOrigin = safeOrigin(url);
    if (!tabOrigin) return { ok: false, reason: 'tab-origin-unreadable' };
    if (tabOrigin !== origin) return { ok: false, reason: 'tab-origin-mismatch' };
    return { ok: true, tab: tab };
  }

  async function enable(payload) {
    return enqueue(async function () {
      const origin = safeOrigin(payload && payload.origin);
      if (!origin) throw new Error('invalid-origin');
      const tabId = Number(payload && payload.tabId);
      const includeSameSite = !payload || payload.includeSameSite !== false;
      const match = await tabMatchesOrigin(tabId, origin);
      if (!match.ok) throw new Error(match.reason);

      const pattern = patternFor(origin);
      const hasPermission = await patternsContain([pattern]);
      if (!hasPermission) throw new Error('permission-required');

      try {
        await register(origin);
      } catch (error) {
        throw new Error('registration-failed');
      }

      const scopes = await readScopes();
      scopes[origin] = {
        origin: origin,
        pattern: pattern,
        includeSameSite: includeSameSite,
        enabledAt: (scopes[origin] && scopes[origin].enabledAt) || Date.now(),
        updatedAt: Date.now(),
        version: C.VERSION,
        active: true
      };
      await writeScopes(scopes);
      await SessionStore.ensure(origin, {
        scope: { mode: includeSameSite ? C.SCOPE_MODE.SITE : C.SCOPE_MODE.ORIGIN }
      });

      let injected = true;
      let injectError = '';
      try {
        await injectNow(tabId);
      } catch (error) {
        injected = false;
        injectError = 'injection-failed';
      }

      return {
        origin: origin,
        includeSameSite: includeSameSite,
        injected: injected,
        injectError: injectError,
        status: await status(origin, tabId, { skipQueue: true })
      };
    });
  }

  async function disable(payload) {
    return enqueue(async function () {
      const origin = safeOrigin(payload && payload.origin);
      if (!origin) throw new Error('invalid-origin');
      await unregister(origin);
      const scopes = await readScopes();
      delete scopes[origin];
      await writeScopes(scopes);
      if (payload && payload.removePermission) {
        try {
          await chrome.permissions.remove({ origins: [patternFor(origin)] });
        } catch (_) {
          /* permission cleanup is best effort */
        }
      }
      if (payload && payload.purge) {
        await SessionStore.remove(origin);
      }
      return { origin: origin, disabled: true };
    });
  }

  async function registeredIds(origin) {
    const ids = idsFor(origin);
    try {
      const list = await chrome.scripting.getRegisteredContentScripts({
        ids: [ids.main, ids.isolated]
      });
      return list.map(function (item) {
        return item.id;
      });
    } catch (_) {
      return [];
    }
  }

  async function status(origin, tabId, opts) {
    const normalized = safeOrigin(origin);
    if (!normalized) {
      return { origin: origin || '', sealed: false, reason: 'invalid-origin' };
    }
    const scopes = await readScopes();
    const scope = scopes[normalized] || null;
    const permission = await patternsContain([patternFor(normalized)]);
    const registered = await registeredIds(normalized);
    const sealed = Boolean(scope && permission && registered.length >= 2);
    let reason = '';
    if (!scope) reason = 'not-sealed';
    else if (!permission) reason = 'permission-lost';
    else if (registered.length < 2) reason = 'not-registered';
    return {
      origin: normalized,
      sealed: sealed,
      permission: permission,
      registered: registered,
      active: Boolean(scope && scope.active),
      includeSameSite: scope ? scope.includeSameSite !== false : true,
      enabledAt: scope ? scope.enabledAt : null,
      updatedAt: scope ? scope.updatedAt : null,
      pattern: patternFor(normalized),
      reason: reason,
      tabId: tabId || null
    };
  }

  async function reconcile() {
    return enqueue(async function () {
      const scopes = await readScopes();
      let changed = false;
      for (const origin of Object.keys(scopes)) {
        const scope = scopes[origin];
        const validOrigin = safeOrigin(origin);
        if (!validOrigin) {
          delete scopes[origin];
          changed = true;
          continue;
        }
        const permission = await patternsContain([patternFor(origin)]);
        if (!permission) {
          scope.active = false;
          scope.permissionLostAt = Date.now();
          changed = true;
          await unregister(origin);
          continue;
        }
        try {
          await register(origin);
          scope.active = true;
          delete scope.permissionLostAt;
          scope.version = C.VERSION;
          delete scope.registrationError;
          changed = true;
        } catch (_) {
          scope.active = false;
          scope.registrationError = 'registration-failed';
          changed = true;
          await unregister(origin);
        }
      }
      if (changed) await writeScopes(scopes);
      return scopes;
    });
  }

  async function rearm(payload) {
    const origin = safeOrigin(payload && payload.origin);
    if (!origin) throw new Error('invalid-origin');
    const tabId = Number(payload && payload.tabId);
    const match = await tabMatchesOrigin(tabId, origin);
    if (!match.ok) throw new Error(match.reason);
    const hasPermission = await patternsContain([patternFor(origin)]);
    if (!hasPermission) throw new Error('permission-required');
    await injectNow(tabId);
    return { origin: origin, injected: true };
  }

  root.KimboBG = root.KimboBG || {};
  root.KimboBG.ScopeManager = {
    enable: enable,
    disable: disable,
    status: status,
    reconcile: reconcile,
    rearm: rearm,
    getScope: getScope,
    listScopes: readScopes,
    patternFor: patternFor,
    safeOrigin: safeOrigin,
    injectNow: injectNow
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
