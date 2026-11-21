/* Kimbo JS — safe DOM helpers. Dynamic recon data is always inserted as text. */
(function (root) {
  'use strict';
  const UI = (root.KimboUI = root.KimboUI || {});

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ICON_PATHS = {
    copy: [
      'M9 9h10v11H9z',
      'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'
    ],
    check: ['M20 6 9 17l-5-5'],
    search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm20 20-4-4'],
    shield: ['M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z', 'M9 12l2 2 4-4'],
    graph: [
      'M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
      'M19 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
      'M17 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
      'M7 15l10-8M7 16l8 1'
    ],
    database: [
      'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Z',
      'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
      'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'
    ],
    pin: [
      'M12 17v5',
      'M8 3h8l-1 6 3 4H6l3-4-1-6Z'
    ],
    x: ['M18 6 6 18M6 6l12 12'],
    download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
    refresh: [
      'M20 11a8 8 0 1 0-2.3 5.7',
      'M20 4v7h-7'
    ],
    'arrow-left': ['M19 12H5', 'm12 19-7-7 7-7'],
    'chevron-right': ['m9 18 6-6-6-6'],
    zap: ['M13 2 3 14h9l-1 8 10-12h-9l1-8Z'],
    package: [
      'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z',
      'M4 7.5 12 12l8-4.5',
      'M12 12v9'
    ],
    note: [
      'M5 3h10l4 4v14H5z',
      'M14 3v5h5',
      'M8 13h8M8 17h5'
    ],
    trash: [
      'M3 6h18',
      'M8 6V4h8v2',
      'm6 6 1 15h10l1-15',
      'M10 11v6M14 11v6'
    ],
    alert: [
      'M12 3 2 21h20L12 3Z',
      'M12 9v5',
      'M12 18h.01'
    ],
    link: [
      'M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2',
      'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2'
    ],
    file: [
      'M6 2h8l4 4v16H6z',
      'M14 2v6h6',
      'M9 13h6M9 17h6'
    ],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
    route: [
      'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M9 16h4a4 4 0 0 0 0-8h-2'
    ],
    terminal: ['m4 6 6 6-6 6', 'M13 18h7'],
    eye: [
      'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z',
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'
    ],
    lock: [
      'M5 11h14v10H5z',
      'M8 11V7a4 4 0 0 1 8 0v4'
    ],
    layers: [
      'm12 3 9 5-9 5-9-5 9-5Z',
      'm3 12 9 5 9-5',
      'm3 16 9 5 9-5'
    ],
    compass: [
      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
      'm15.5 8.5-2 5-5 2 2-5 5-2Z'
    ]
  };

  function flatten(children, target) {
    for (const child of children) {
      if (child == null || child === false || child === true) continue;
      if (Array.isArray(child)) flatten(child, target);
      else if (child instanceof Node) target.push(child);
      else target.push(document.createTextNode(String(child)));
    }
  }

  function applyAttrs(el, attrs) {
    if (!attrs || typeof attrs !== 'object') return;
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') {
        el.setAttribute('class', String(value));
      } else if (key === 'text') {
        el.textContent = String(value);
      } else if (key === 'dataset') {
        for (const dataKey of Object.keys(value)) {
          if (value[dataKey] != null) el.dataset[dataKey] = String(value[dataKey]);
        }
      } else if (key === 'on' && value && typeof value === 'object') {
        for (const eventName of Object.keys(value)) {
          if (typeof value[eventName] === 'function') {
            el.addEventListener(eventName, value[eventName]);
          }
        }
      } else if (key === 'attrs' && value && typeof value === 'object') {
        for (const attrName of Object.keys(value)) {
          if (value[attrName] == null || value[attrName] === false) continue;
          el.setAttribute(attrName, value[attrName] === true ? '' : String(value[attrName]));
        }
      } else if (key === 'value') {
        el.value = value == null ? '' : String(value);
        el.setAttribute('value', String(value == null ? '' : value));
      } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') {
        if (value) el.setAttribute(key, '');
        if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') {
          el[key] = Boolean(value);
        }
      } else if (key === 'style' && typeof value === 'string') {
        el.style.cssText = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }

  function h(tag, attrs) {
    const el = document.createElement(tag);
    applyAttrs(el, attrs);
    const children = [];
    for (let i = 2; i < arguments.length; i++) flatten([arguments[i]], children);
    for (const child of children) el.appendChild(child);
    return el;
  }

  function svg(tag, attrs, children) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value == null || value === false) continue;
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    if (children) {
      const list = Array.isArray(children) ? children : [children];
      for (const child of list) if (child instanceof Node) el.appendChild(child);
    }
    return el;
  }

  function icon(name, className) {
    const paths = ICON_PATHS[name] || ICON_PATHS.file;
    const el = svg('svg', {
      viewBox: '0 0 24 24',
      class: 'icon' + (className ? ' ' + className : ''),
      'aria-hidden': 'true',
      focusable: 'false'
    });
    for (const d of paths) el.appendChild(svg('path', { d: d }));
    return el;
  }

  function clear(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  function copyText(text) {
    const value = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).catch(function () {
        return fallbackCopy(value);
      });
    }
    return Promise.resolve(fallbackCopy(value));
  }

  function fallbackCopy(value) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    textarea.remove();
    if (!ok) throw new Error('copy-failed');
    return true;
  }

  function download(filename, text, mime) {
    const blob = new Blob([String(text == null ? '' : text)], {
      type: mime || 'text/plain;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments;
      const context = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(context, args);
      }, wait);
    };
  }

  UI.dom = {
    h: h,
    svg: svg,
    icon: icon,
    clear: clear,
    copyText: copyText,
    download: download,
    debounce: debounce,
    applyAttrs: applyAttrs
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
