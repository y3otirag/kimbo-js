/**
 * Kimbo JS — session store.
 *
 * Serializes every read-modify-write of chrome.storage.local through a single
 * promise chain (no lost updates), keeps a compact origin index, and degrades
 * gracefully when the extension hits its local storage quota.
 */
(function (root) {
  'use strict';
  const Pipeline = root.KimboCore && root.KimboCore.pipeline;
  if (!Pipeline) return;

  const KEY_PREFIX = 'kimbo:session:';
  const INDEX_KEY = 'kimbo:index';
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

  function storageRemove(keys) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.remove(keys, function () {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function keyFor(origin) {
    return KEY_PREFIX + origin;
  }

  async function get(origin) {
    if (!origin) return null;
    const items = await storageGet(keyFor(origin));
    const session = items[keyFor(origin)];
    if (!session) return null;
    return Pipeline.ensure(session, origin);
  }

  async function readIndex() {
    const items = await storageGet(INDEX_KEY);
    const index = items[INDEX_KEY];
    return index && typeof index === 'object' ? index : {};
  }

  async function updateIndex(origin, session) {
    const index = await readIndex();
    index[origin] = {
      origin: origin,
      updatedAt: session.updatedAt || Date.now(),
      revision: session.revision || 0,
      endpointCount: session.stats ? session.stats.endpoints : Object.keys(session.endpoints || {}).length,
      anchored: session.stats ? session.stats.anchored : 0,
      leadsHigh: session.stats ? session.stats.leadsHigh : 0
    };
    const entries = Object.values(index).sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const capped = {};
    for (const entry of entries.slice(0, 20)) capped[entry.origin] = entry;
    await storageSet({ [INDEX_KEY]: capped });
  }

  async function evictOldSessions(origin) {
    const index = await readIndex();
    const entries = Object.values(index)
      .filter(function (entry) {
        return entry.origin !== origin;
      })
      .sort(function (a, b) {
        return (a.updatedAt || 0) - (b.updatedAt || 0);
      });
    const victims = entries.slice(0, 3);
    if (!victims.length) return false;
    const keys = victims.map(function (entry) {
      return keyFor(entry.origin);
    });
    await storageRemove(keys);
    for (const entry of victims) delete index[entry.origin];
    await storageSet({ [INDEX_KEY]: index });
    return true;
  }

  async function write(origin, session) {
    session.updatedAt = session.updatedAt || Date.now();
    try {
      await storageSet({ [keyFor(origin)]: session });
    } catch (error) {
      Pipeline.prune(session, { aggressive: true });
      Pipeline.computeStats(session);
      try {
        await storageSet({ [keyFor(origin)]: session });
      } catch (second) {
        const evicted = await evictOldSessions(origin);
        if (!evicted) throw second;
        await storageSet({ [keyFor(origin)]: session });
      }
    }
    await updateIndex(origin, session);
  }

  async function ensure(origin, opts) {
    if (!origin) throw new Error('missing-origin');
    return enqueue(async function () {
      let session = await get(origin);
      if (!session) {
        session = Pipeline.createSession(origin, opts || {});
        await write(origin, session);
      }
      return session;
    });
  }

  async function update(origin, mutator, opts) {
    if (!origin) throw new Error('missing-origin');
    if (typeof mutator !== 'function') throw new Error('missing-mutator');
    return enqueue(async function () {
      let session = await get(origin);
      if (!session) session = Pipeline.createSession(origin, opts || {});
      else Pipeline.ensure(session, origin);
      const result = await mutator(session);
      if (result && result !== session) {
        // Mutators may return a replacement session.
        session = result;
      }
      await write(origin, session);
      return session;
    });
  }

  async function remove(origin) {
    return enqueue(async function () {
      await storageRemove([keyFor(origin)]);
      const index = await readIndex();
      if (index[origin]) {
        delete index[origin];
        await storageSet({ [INDEX_KEY]: index });
      }
    });
  }

  async function list() {
    const index = await readIndex();
    return Object.values(index).sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  async function purgeAll() {
    const items = await storageGet(null);
    const keys = Object.keys(items).filter(function (key) {
      return key === INDEX_KEY || key.indexOf(KEY_PREFIX) === 0;
    });
    if (keys.length) await storageRemove(keys);
  }

  root.KimboBG = root.KimboBG || {};
  root.KimboBG.SessionStore = {
    get: get,
    ensure: ensure,
    update: update,
    remove: remove,
    list: list,
    purgeAll: purgeAll,
    keyFor: keyFor
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
