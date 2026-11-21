/**
 * Kimbo JS — storage probe (serialized into the page via chrome.scripting).
 *
 * Reads localStorage, sessionStorage, non-HttpOnly cookies and a few common
 * SSR state globals. It returns only identity-shaped values; session tokens
 * and PII are skipped in the page before anything crosses the extension
 * boundary. HttpOnly cookies are intentionally invisible.
 *
 * This function must remain self-contained: Chrome serializes it.
 */
globalThis.KimboStorageProbe = function kimboStorageProbe() {
  'use strict';
  const MAX_ENTRIES = 320;
  const MAX_VALUE = 300;
  const MAX_URL_VALUE = 1200;
  const MAX_RAW = 200000;
  const MAX_DEPTH = 3;
  const MAX_OBJECT_KEYS = 40;
  const MAX_ARRAY = 20;

  const SENSITIVE_RE =
    /(?:^|[._-])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|pwd|authorization|bearer|session(?:[_-]?id)?|csrf|xsrf|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|signature|sig|nonce|otp|credential|cookie|jwt)(?:[._-]|$)/i;
  const PII_RE =
    /(?:^|[._-])(?:e?mail|phone|mobile|telephone|address|street|ssn|cpf|cnpj|rg|passport|birth|birthday|dob|first[_-]?name|last[_-]?name|full[_-]?name|username|user[_-]?name|name)(?:[._-]|$)/i;
  const ID_KEY_RE =
    /(?:^|[._-])(?:id|uuid|guid|oid|org|organization|tenant|user|member|account|owner|project|workspace|team|order|invoice|file|customer|role|group|device|asset|ticket|post|article|comment|message|event|job|task|product|item|sub|subject)(?:[._-]|$)/i;
  const ID_VALUE_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{24}$|^\d{1,20}$|^[A-Z]{2,8}[-_]?\d{2,}(?:[-_]\d{2,})*$/i;
  const URL_RE = /^(?:https?:\/\/|\/(?!\/)|\.\.?\/)/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
  const out = [];
  const seen = new Set();

  function looksIdValue(value) {
    return ID_VALUE_RE.test(value) || EMAIL_RE.test(value) || JWT_RE.test(value);
  }

  function interesting(key, value) {
    return ID_KEY_RE.test(key) || ID_VALUE_RE.test(value) || URL_RE.test(value);
  }

  function add(area, key, value, path) {
    if (out.length >= MAX_ENTRIES) return;
    const fullKey = String(key || '').slice(0, 120);
    if (!fullKey) return;
    const leaf = String(path && path.length ? path[path.length - 1] : fullKey);
    if (SENSITIVE_RE.test(fullKey) || SENSITIVE_RE.test(leaf)) return;
    if (PII_RE.test(fullKey) || PII_RE.test(leaf)) return;
    let text = String(value == null ? '' : value).trim();
    if (!text) return;
    if (JWT_RE.test(text)) return; // tokens never leave storage
    if (EMAIL_RE.test(text)) return;
    if (!interesting(fullKey, text)) return;
    const limit = URL_RE.test(text) ? MAX_URL_VALUE : MAX_VALUE;
    if (text.length > limit) text = text.slice(0, limit);
    const signature = area + '\u0000' + fullKey + '\u0000' + text;
    if (seen.has(signature)) return;
    seen.add(signature);
    out.push({
      area: area,
      key: path && path.length ? path.join('.') : fullKey,
      path: path ? path.slice() : [fullKey],
      value: text
    });
  }

  function walk(value, path, depth) {
    if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH || value == null) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && i < MAX_ARRAY; i++) {
        walk(value[i], path.concat(String(i)), depth + 1);
      }
      return;
    }
    if (typeof value === 'object') {
      let count = 0;
      for (const key of Object.keys(value)) {
        if (count++ > MAX_OBJECT_KEYS) break;
        walk(value[key], path.concat(String(key)), depth + 1);
      }
      return;
    }
    if (typeof value === 'boolean' || typeof value === 'object') return;
    add('state', path[0] || 'state', value, path);
  }

  function readArea(areaName) {
    let storage;
    try {
      storage = window[areaName];
    } catch (_) {
      return;
    }
    if (!storage) return;
    let keys = [];
    try {
      keys = Object.keys(storage);
    } catch (_) {
      return;
    }
    for (let i = 0; i < keys.length && i < 400 && out.length < MAX_ENTRIES; i++) {
      const key = keys[i];
      if (SENSITIVE_RE.test(key) || PII_RE.test(key)) continue;
      let raw;
      try {
        raw = storage.getItem(key);
      } catch (_) {
        continue;
      }
      if (raw == null) continue;
      if (raw.length > MAX_RAW) continue;
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          walk(JSON.parse(trimmed), [key], 0);
          continue;
        } catch (_) {
          /* fall through as a scalar */
        }
      }
      add(areaName === 'localStorage' ? 'localStorage' : 'sessionStorage', key, raw, [key]);
    }
  }

  try {
    readArea('localStorage');
  } catch (_) {
    /* blocked */
  }
  try {
    readArea('sessionStorage');
  } catch (_) {
    /* blocked */
  }

  try {
    const cookie = String(document.cookie || '');
    for (const part of cookie.split(';')) {
      if (out.length >= MAX_ENTRIES) break;
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      add('cookie', name, value, [name]);
    }
  } catch (_) {
    /* cookies blocked */
  }

  const globals = [
    '__NEXT_DATA__',
    '__NUXT__',
    '__INITIAL_STATE__',
    '__APOLLO_STATE__',
    '__PRELOADED_STATE__',
    '__REDUX_STATE__'
  ];
  for (const name of globals) {
    if (out.length >= MAX_ENTRIES) break;
    try {
      const state = window[name];
      if (state && typeof state === 'object') {
        walk(state, [name], 0);
      }
    } catch (_) {
      /* ignore */
    }
  }

  return out;
};
