/* Kimbo JS — user actions, modals and handoff exports. */
(function (root) {
  'use strict';
  const UI = (root.KimboUI = root.KimboUI || {});
  const D = UI.dom;
  const API = UI.api;
  const F = UI.format;
  const Exporter = root.KimboCore.exporter;
  const C = root.KimboCore.constants;
  const h = D.h;

  let activeModal = null;

  function errorMessage(error) {
    const code = error && error.message ? error.message : String(error || '');
    switch (code) {
      case 'permission-denied':
        return 'Chrome did not grant access to this origin.';
      case 'permission-required':
        return 'Host permission is missing. Seal the origin again.';
      case 'tab-origin-mismatch':
        return 'The active tab changed. Reopen Kimbo on the target tab.';
      case 'tab-origin-unreadable':
        return 'Chrome would not reveal this tab URL. Try a normal http(s) page.';
      case 'tab-unavailable':
        return 'The tab is no longer available.';
      case 'registration-failed':
        return 'Could not register collectors. Reload the extension and retry.';
      case 'scope-not-sealed':
        return 'This origin is not sealed.';
      case 'extension-unavailable':
        return 'Kimbo was reloaded. Reopen this popup/panel.';
      case 'content-unreachable':
        return 'The page has no active Kimbo collector. Reload the tab.';
      case 'bundle-read-failed':
        return 'The bundle reader did not respond. Reload the tab and retry.';
      case 'invalid-paste-size':
        return 'The pasted script exceeds the 2 MB limit.';
      case 'probe-failed':
        return 'Could not read page context. Reload the tab and retry.';
      default:
        return code && code !== 'undefined' ? code.replace(/-/g, ' ') : 'Something went wrong.';
    }
  }

  function closeModal() {
    if (!activeModal) return;
    if (activeModal.cleanup) activeModal.cleanup();
    activeModal.root.remove();
    activeModal = null;
  }

  function openModal(options) {
    closeModal();
    const opts = options || {};
    const rootEl = document.getElementById('modal-root') || document.body;
    const backdrop = h('div', { class: 'modal-backdrop' });
    const modal = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
    const title = h('h2', { class: 'modal-title' }, opts.title || '');
    const close = h(
      'button',
      { class: 'modal-close', type: 'button', title: 'Close', 'aria-label': 'Close' },
      D.icon('x')
    );
    close.addEventListener('click', closeModal);
    modal.appendChild(close);
    modal.appendChild(title);
    if (opts.copy) modal.appendChild(h('p', { class: 'modal-copy' }, opts.copy));
    if (opts.body) modal.appendChild(opts.body);
    if (Array.isArray(opts.actions) && opts.actions.length) {
      const actions = h('div', { class: 'modal-actions' });
      for (const action of opts.actions) {
        const button = h(
          'button',
          {
            class: 'btn ' + (action.kind || 'btn-ghost'),
            type: 'button'
          },
          action.label
        );
        button.addEventListener('click', function () {
          if (action.onClick) action.onClick();
          if (action.close !== false) closeModal();
        });
        actions.appendChild(button);
      }
      modal.appendChild(actions);
    }
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) closeModal();
    });
    const esc = function (event) {
      if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', esc);
    rootEl.appendChild(backdrop);
    activeModal = {
      root: backdrop,
      cleanup: function () {
        document.removeEventListener('keydown', esc);
      }
    };
    setTimeout(function () {
      const focusable = modal.querySelector('input, textarea, select, button');
      if (focusable) focusable.focus();
    }, 0);
    return modal;
  }

  function confirm(options) {
    const opts = options || {};
    openModal({
      title: opts.title || 'Confirm',
      copy: opts.copy || '',
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        {
          label: opts.confirmLabel || 'Confirm',
          kind: opts.danger ? 'btn-danger' : 'btn-acid',
          close: false,
          onClick: function () {
            Promise.resolve(opts.onConfirm ? opts.onConfirm() : null)
              .then(function () {
                closeModal();
              })
              .catch(function (error) {
                if (opts.toast) opts.toast(errorMessage(error), 'error');
              });
          }
        }
      ]
    });
  }

  async function copyWithToast(text, toast, message) {
    try {
      await D.copyText(text);
      if (toast) toast(message || 'Copied', 'ok');
    } catch (_) {
      if (toast) toast('Clipboard unavailable', 'error');
    }
  }

  async function seal(options) {
    const opts = options || {};
    if (!opts.origin || !Number.isInteger(opts.tabId)) {
      if (opts.setError) opts.setError('Open Kimbo from the toolbar on the target tab.');
      return;
    }
    if (opts.setBusy) opts.setBusy(true);
    if (opts.setError) opts.setError('');
    try {
      const granted = await API.requestHostPermission(opts.origin);
      if (!granted) throw new Error('permission-denied');
      const result = await API.enableScope(opts.origin, opts.tabId, opts.includeSameSite !== false);
      if (opts.toast) {
        opts.toast(
          result && result.injected === false
            ? 'Scope sealed. Reload the page to capture page-load calls.'
            : 'Scope sealed. Listening.',
          'ok'
        );
      }
      if (opts.onDone) await opts.onDone();
    } catch (error) {
      if (opts.setError) opts.setError(errorMessage(error));
      if (opts.toast) opts.toast(errorMessage(error), 'error');
    } finally {
      if (opts.setBusy) opts.setBusy(false);
    }
  }

  function unseal(options) {
    const opts = options || {};
    confirm({
      title: 'Unseal this origin?',
      copy:
        'Collection stops immediately and Chrome host access is removed. The local ledger is kept until you purge it.',
      confirmLabel: 'Unseal origin',
      danger: true,
      toast: opts.toast,
      onConfirm: async function () {
        await API.removeHostPermission(opts.origin);
        await API.disableScope(opts.origin, { removePermission: false, purge: false });
        if (opts.toast) opts.toast('Scope unsealed', 'ok');
        if (opts.onDone) await opts.onDone();
      }
    });
  }

  function purge(options) {
    const opts = options || {};
    confirm({
      title: 'Purge this origin ledger?',
      copy:
        'Endpoints, anchors, notes and bundle metadata for this origin are deleted from chrome.storage.local. This cannot be undone.',
      confirmLabel: 'Purge ledger',
      danger: true,
      toast: opts.toast,
      onConfirm: async function () {
        await API.purge(opts.origin, opts.tabId);
        if (opts.toast) opts.toast('Ledger purged', 'ok');
        if (opts.onDone) await opts.onDone();
      }
    });
  }

  async function capture(options) {
    const opts = options || {};
    try {
      const result = await API.captureContext(opts.origin, opts.tabId);
      if (opts.toast) {
        opts.toast(
          result && result.entries != null
            ? 'Captured ' + result.entries + ' context ' + F.plural(result.entries, 'value')
            : 'Context captured',
          'ok'
        );
      }
      if (opts.onDone) await opts.onDone();
    } catch (error) {
      if (opts.toast) opts.toast(errorMessage(error), 'error');
    }
  }

  async function readBundles(options) {
    const opts = options || {};
    if (!Number.isInteger(opts.tabId)) {
      if (opts.toast) opts.toast('No page attached', 'error');
      return;
    }
    try {
      const result = await API.readBundles(opts.origin, opts.tabId);
      const results = (result && result.results) || [];
      const analyzed = results.filter(function (item) { return item.status === 'analyzed'; }).length;
      const missed = results.filter(function (item) { return item.status === 'not-cached'; }).length;
      if (opts.toast) {
        if (!results.length) opts.toast('No cached bundles to read', 'ok');
        else opts.toast(analyzed + ' analyzed · ' + missed + ' not cached', 'ok');
      }
      if (opts.onDone) await opts.onDone();
    } catch (error) {
      if (opts.toast) opts.toast(errorMessage(error), 'error');
    }
  }

  function pasteBundle(options) {
    const opts = options || {};
    const body = h('div');
    const field = h('div', { class: 'field' });
    field.appendChild(h('label', { for: 'kimbo-paste' }, 'JavaScript text'));
    const textarea = h('textarea', {
      id: 'kimbo-paste',
      placeholder: 'Paste a bundle from DevTools Sources or Burp. It is parsed locally.',
      spellcheck: 'false'
    });
    field.appendChild(textarea);
    body.appendChild(field);
    const baseField = h('div', { class: 'field' });
    baseField.appendChild(h('label', { for: 'kimbo-paste-base' }, 'Base URL for relative routes'));
    const input = h('input', {
      id: 'kimbo-paste-base',
      type: 'text',
      value: opts.origin + '/',
      spellcheck: 'false'
    });
    baseField.appendChild(input);
    body.appendChild(baseField);
    body.appendChild(
      h(
        'div',
        { class: 'hint' },
        'The text is parsed by the normalizer locally. Nothing is fetched or executed. Max 2 MB.'
      )
    );
    const modal = openModal({
      title: 'Paste a JS bundle',
      copy: 'A safe fallback when the browser has no cached copy of a chunk.',
      body: body,
      wide: true,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        {
          label: 'Extract routes',
          kind: 'btn-acid',
          close: false,
          onClick: async function () {
            if (!textarea.value.trim()) {
              if (opts.toast) opts.toast('Paste some JavaScript first', 'error');
              return;
            }
            try {
              const result = await API.importBundle(opts.origin, textarea.value, input.value);
              closeModal();
              if (opts.toast) {
                opts.toast((result && result.count ? result.count : 0) + ' route(s) extracted', 'ok');
              }
              if (opts.onDone) await opts.onDone();
            } catch (error) {
              if (opts.toast) opts.toast(errorMessage(error), 'error');
            }
          }
        }
      ]
    });
    setTimeout(function () {
      textarea.focus();
    }, 0);
    return modal;
  }

  async function pin(options) {
    const opts = options || {};
    try {
      await API.pin(opts.origin, opts.endpointId, opts.placeholderId, opts.contextId);
      if (opts.toast) opts.toast(opts.contextId ? 'Value pinned' : 'Pin removed', 'ok');
      if (opts.onDone) await opts.onDone();
    } catch (error) {
      if (opts.toast) opts.toast(errorMessage(error), 'error');
    }
  }

  async function saveNote(options) {
    const opts = options || {};
    try {
      await API.note(opts.origin, opts.endpointId, opts.text);
    } catch (error) {
      if (opts.toast) opts.toast(errorMessage(error), 'error');
    }
  }

  function copyUrl(options) {
    const opts = options || {};
    let url = '';
    try {
      url = Exporter.preparedUrl(opts.session, opts.endpoint);
    } catch (_) {
      url = '';
    }
    copyWithToast(url, opts.toast, 'Prepared URL copied');
  }

  function copyCurl(options) {
    const opts = options || {};
    try {
      const text = Exporter.toCurl(opts.session, opts.endpoint);
      copyWithToast(text, opts.toast, 'cURL copied');
    } catch (_) {
      if (opts.toast) opts.toast('Could not build cURL', 'error');
    }
  }

  function copyBurp(options) {
    const opts = options || {};
    try {
      const text = Exporter.rawRequestFor(
        opts.session,
        opts.endpoint,
        Exporter.preferredMethod(opts.endpoint)
      );
      copyWithToast(text, opts.toast, 'Raw request copied');
    } catch (_) {
      if (opts.toast) opts.toast('Could not build raw request', 'error');
    }
  }

  function copyPostman(options) {
    const opts = options || {};
    try {
      const text = Exporter.toPostmanItem(
        opts.session,
        opts.endpoint,
        Exporter.preferredMethod(opts.endpoint)
      );
      copyWithToast(text, opts.toast, 'Postman item copied');
    } catch (_) {
      if (opts.toast) opts.toast('Could not build Postman item', 'error');
    }
  }

  function copyNetworkFilter(options) {
    const opts = options || {};
    const endpoint = opts.endpoint;
    const prefix = String(endpoint.template || '').split('{')[0] || '/';
    const filter = 'url:' + prefix;
    copyWithToast(filter, opts.toast, 'Network filter copied');
  }

  function exportModal(options) {
    const opts = options || {};
    const session = opts.session;
    if (!session) {
      if (opts.toast) opts.toast('Nothing to export yet', 'error');
      return;
    }
    let format = 'json';
    let includeFiltered = false;
    let includeSameSite = session.scope ? session.scope.mode !== 'origin' : true;

    const body = h('div');
    const grid = h('div', { class: 'export-grid' });
    const formats = [
      ['json', 'JSON ledger', 'Context, evidence, fills, risk'],
      ['csv', 'CSV', 'Spreadsheet of routes and fills'],
      ['urls', 'Burp site map', 'One prepared URL per line'],
      ['burp', 'Burp Repeater', 'Raw HTTP request blocks'],
      ['postman', 'Postman', 'Collection v2.1']
    ];
    const optionButtons = [];
    for (const item of formats) {
      const button = h(
        'button',
        {
          class: 'export-option' + (item[0] === format ? ' active' : ''),
          type: 'button'
        },
        h('span', { class: 'name' }, item[1]),
        h('span', { class: 'desc' }, item[2])
      );
      button.addEventListener('click', function () {
        format = item[0];
        for (const other of optionButtons) other.classList.remove('active');
        button.classList.add('active');
        refreshPreview();
      });
      optionButtons.push(button);
      grid.appendChild(button);
    }
    body.appendChild(grid);

    const filteredLabel = h('label', { class: 'check' });
    const filteredInput = h('input', { type: 'checkbox' });
    filteredInput.addEventListener('change', function () {
      includeFiltered = filteredInput.checked;
      refreshPreview();
    });
    filteredLabel.appendChild(filteredInput);
    filteredLabel.appendChild(
      h('span', null, 'Only endpoints in the current filter (' + (opts.visibleIds || []).length + ')')
    );
    body.appendChild(filteredLabel);

    const sameSiteLabel = h('label', { class: 'check', style: 'margin-top:9px' });
    const sameSiteInput = h('input', { type: 'checkbox', checked: includeSameSite });
    sameSiteInput.addEventListener('change', function () {
      includeSameSite = sameSiteInput.checked;
      refreshPreview();
    });
    sameSiteLabel.appendChild(sameSiteInput);
    sameSiteLabel.appendChild(h('span', null, 'Include same-site companion hosts'));
    body.appendChild(sameSiteLabel);

    const preview = h('div', { class: 'export-foot' });
    body.appendChild(preview);

    function selection() {
      return {
        endpointIds: includeFiltered ? opts.visibleIds || [] : null,
        includeSameSite: includeSameSite
      };
    }

    function refreshPreview() {
      const optsForExport = selection();
      const count = Exporter.selectEndpoints(session, optsForExport).length;
      preview.textContent =
        count +
        ' endpoint' +
        (count === 1 ? '' : 's') +
        ' selected. Exports never include tokens, cookies, bodies or PII. Add your own authorized session.';
    }
    refreshPreview();

    openModal({
      title: 'Export ledger',
      copy: 'Handoff artifacts only. Kimbo never sends a request.',
      body: body,
      wide: true,
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        {
          label: 'Download',
          kind: 'btn-acid',
          close: false,
          onClick: async function () {
            try {
              const result = Exporter.exportSession(session, format, selection());
              D.download(result.filename, result.text, result.mime);
              if (opts.toast) opts.toast('Downloaded ' + result.count + ' endpoint(s)', 'ok');
              closeModal();
            } catch (error) {
              if (opts.toast) opts.toast('Export failed: ' + errorMessage(error), 'error');
            }
          }
        }
      ]
    });
  }

  UI.actions = {
    openModal: openModal,
    closeModal: closeModal,
    confirm: confirm,
    errorMessage: errorMessage,
    seal: seal,
    unseal: unseal,
    purge: purge,
    capture: capture,
    readBundles: readBundles,
    pasteBundle: pasteBundle,
    pin: pin,
    saveNote: saveNote,
    copyUrl: copyUrl,
    copyCurl: copyCurl,
    copyBurp: copyBurp,
    copyPostman: copyPostman,
    copyNetworkFilter: copyNetworkFilter,
    exportModal: exportModal
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
