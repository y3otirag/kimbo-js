/* Kimbo JS — popup boot. */
(function (root) {
  'use strict';
  const UI = root.KimboUI;
  function boot() {
    UI.shell.mount({ mode: 'popup' }).catch(function (error) {
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
      copy.textContent = error && error.message ? error.message : 'Reload the extension and try again.';
      box.appendChild(title);
      box.appendChild(copy);
      app.appendChild(box);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
