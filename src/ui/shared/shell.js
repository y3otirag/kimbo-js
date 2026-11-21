/* Kimbo JS — shared shell for popup and DevTools panel. */
(function (root) {
  'use strict';
  const UI = (root.KimboUI = root.KimboUI || {});
  const D = UI.dom;
  const F = UI.format;
  const R = UI.render;
  const A = UI.actions;
  const API = UI.api;
  const L = UI.lattice;
  const h = D.h;

  let state = null;
  let refs = null;
  let origin = null;
  let tabId = null;
  let mode = 'popup';
  let unsubscribe = null;
  let reloadTimer = null;
  let loadSeq = 0;
  let noteTimer = null;
  let lastListScroll = 0;

  function safeOrigin(value) {
    try {
      const u = new URL(String(value));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch (_) {
      return null;
    }
  }

  function queryParam(name) {
    try {
      return new URLSearchParams(location.search).get(name);
    } catch (_) {
      return null;
    }
  }

  async function resolveContext(options) {
    const paramsOrigin = safeOrigin(queryParam('origin'));
    const paramsTab = Number(queryParam('tabId'));
    if (options.origin) {
      origin = safeOrigin(options.origin);
    }
    if (!origin && paramsOrigin) origin = paramsOrigin;
    if (options.tabId && Number.isInteger(Number(options.tabId))) tabId = Number(options.tabId);
    if (!Number.isInteger(tabId) && Number.isInteger(paramsTab)) tabId = paramsTab;

    if (origin && !Number.isInteger(tabId)) {
      const tab = await API.getActiveTab();
      if (tab && Number.isInteger(tab.id)) tabId = tab.id;
    }

    if (!origin) {
      const tab = await API.getActiveTab();
      if (tab) {
        if (!Number.isInteger(tabId)) tabId = tab.id;
        origin = safeOrigin(tab.url);
      }
      if (!origin) {
        try {
          const resolved = await API.resolveActive();
          origin = safeOrigin(resolved && resolved.origin);
          if (!origin && resolved && Number.isInteger(resolved.tabId)) tabId = resolved.tabId;
        } catch (_) {
          origin = null;
        }
      }
    }
  }

  function buildShell() {
    const app = document.getElementById('app');
    D.clear(app);
    app.className = 'app mode-' + mode;

    const brand = h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark' }, R.brandMark(18)),
      h('div', { class: 'brand-word' }, 'KIMBO', h('span', null, 'JS')),
      h('span', { class: 'pill brand-pill' }, 'PASSIVE')
    );
    const scopeChip = h('button', {
      id: 'kimbo-scope-chip',
      class: 'scope-chip',
      type: 'button',
      title: 'Scope controls'
    });
    scopeChip.appendChild(h('span', { class: 'dot' }));
    scopeChip.appendChild(h('span', { class: 'label' }, 'UNSEALED'));
    scopeChip.addEventListener('click', openScopeMenu);
    const topbar = h('header', { class: 'topbar' }, brand, h('span', { class: 'topbar-spacer' }), scopeChip);

    const identity = h('div', { class: 'identity-strip', id: 'kimbo-identity' });
    const stats = h('div', { id: 'kimbo-stats' });
    const tabs = h('nav', { class: 'tabs', id: 'kimbo-tabs', role: 'tablist' });
    const tabDefs = [
      ['endpoints', 'Endpoints'],
      ['lattice', 'Lattice'],
      ['context', 'Context']
    ];
    const tabButtons = {};
    for (const def of tabDefs) {
      const button = h(
        'button',
        {
          class: 'tab',
          type: 'button',
          role: 'tab',
          'data-tab': def[0]
        },
        def[1],
        h('span', { class: 'tab-count' }, '0')
      );
      button.addEventListener('click', function () {
        state.view = def[0];
        state.selectedId = def[0] === 'endpoints' ? state.selectedId : state.selectedId;
        render();
      });
      tabButtons[def[0]] = button;
      tabs.appendChild(button);
    }

    const view = h('div', { class: 'view', id: 'kimbo-view' });
    const footer = h(
      'footer',
      { class: 'footer' },
      h(
        'span',
        { class: 'no-egress', title: 'Kimbo never calls discovered endpoints' },
        D.icon('shield'),
        '0 requests sent'
      ),
      h('span', { class: 'footer-spacer' }),
      h(
        'button',
        {
          id: 'kimbo-export',
          class: 'btn btn-acid',
          type: 'button',
          on: {
            click: function () {
              if (!state.session || !Object.keys(state.session.endpoints || {}).length) {
                toast('Nothing to export yet', 'error');
                return;
              }
              A.exportModal({
                session: state.session,
                visibleIds: currentVisibleIds(),
                toast: toast
              });
            }
          }
        },
        D.icon('download'),
        'Export'
      )
    );
    const modalRoot = h('div', { id: 'modal-root' });
    const toastRoot = h('div', { class: 'toast-root', id: 'toast-root' });
    app.appendChild(topbar);
    app.appendChild(identity);
    app.appendChild(stats);
    app.appendChild(tabs);
    app.appendChild(view);
    app.appendChild(footer);
    app.appendChild(modalRoot);
    app.appendChild(toastRoot);

    refs = {
      app: app,
      scopeChip: scopeChip,
      scopeLabel: scopeChip.querySelector('.label'),
      identity: identity,
      stats: stats,
      tabs: tabs,
      tabButtons: tabButtons,
      view: view,
      footerExport: app.querySelector('#kimbo-export'),
      modalRoot: modalRoot,
      toastRoot: toastRoot
    };

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (document.querySelector('.modal-backdrop')) {
          A.closeModal();
          return;
        }
        if (state.selectedId) {
          state.selectedId = null;
          render();
        }
        return;
      }
      if (event.key === '/' && !isFormField(event.target) && state.scope && state.scope.sealed) {
        if (state.view !== 'endpoints') {
          state.view = 'endpoints';
          render();
        }
        setTimeout(function () {
          const input = document.getElementById('kimbo-search');
          if (input) input.focus();
        }, 0);
        event.preventDefault();
      }
    });
  }

  function isFormField(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function toast(message, kind) {
    if (!refs || !refs.toastRoot) return;
    const node = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, String(message || ''));
    refs.toastRoot.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, 2800);
  }

  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () {
      reloadTimer = null;
      refresh({ silent: true });
    }, 140);
  }

  async function refresh(options) {
    const opts = options || {};
    if (!origin) {
      state.loading = false;
      render();
      return;
    }
    const seq = ++loadSeq;
    if (!opts.silent) {
      state.loading = true;
      render();
    }
    try {
      const results = await Promise.all([
        API.getScopeStatus(origin, tabId).catch(function (error) {
          return { status: { origin: origin, sealed: false, reason: 'status-failed' }, summary: null, error: error };
        }),
        API.getSession(origin).catch(function (error) {
          return { session: null, summary: null, error: error };
        })
      ]);
      if (seq !== loadSeq) return;
      const statusPayload = results[0] || {};
      const sessionPayload = results[1] || {};
      state.scope = statusPayload.status || { origin: origin, sealed: false };
      state.session = sessionPayload.session || null;
      state.summary = sessionPayload.summary || null;
      state.includeSameSite = state.scope.includeSameSite !== false;
      state.loadError = null;
      if (!state.session) state.snapshot = false;
      if (state.snapshot && state.scope.sealed) state.snapshot = false;
      if (state.selectedId && (!state.session || !state.session.endpoints[state.selectedId])) {
        state.selectedId = null;
      }
      state.loading = false;
      render();
    } catch (error) {
      if (seq !== loadSeq) return;
      state.loading = false;
      state.loadError = A.errorMessage(error);
      render();
    }
  }

  async function enableSeal(includeSameSite) {
    await A.seal({
      origin: origin,
      tabId: tabId,
      includeSameSite: includeSameSite,
      setBusy: function (busy) {
        state.busy = busy;
        render();
      },
      setError: function (message) {
        state.scopeError = message;
        render();
      },
      toast: toast,
      onDone: async function () {
        state.snapshot = false;
        state.scopeError = '';
        await refresh({ silent: false });
      }
    });
  }

  function openScopeMenu() {
    if (!origin) return;
    const sealed = Boolean(state.scope && state.scope.sealed);
    const body = h('div');
    body.appendChild(
      h(
        'div',
        { class: 'gate-origin' },
        h('span', { class: 'dot' }),
        h('span', null, origin)
      )
    );
    body.appendChild(
      h(
        'div',
        { class: 'hint', style: 'margin-bottom:9px' },
        sealed
          ? 'Scope is sealed. Collectors are registered for this origin only.'
          : 'Scope is not sealed. Enable it to collect on this origin.'
      )
    );
    const actions = [];
    if (!sealed) {
      actions.push({
        label: 'Seal origin',
        kind: 'btn-acid',
        onClick: function () {
          enableSeal(state.includeSameSite !== false);
        }
      });
    } else {
      actions.push({
        label: 'Capture context',
        kind: 'btn-ghost',
        onClick: function () {
          A.capture({ origin: origin, tabId: tabId, onDone: function () { refresh({ silent: true }); }, toast: toast });
        }
      });
      actions.push({
        label: 'Re-arm page',
        kind: 'btn-ghost',
        onClick: async function () {
          try {
            await API.rearm(origin, tabId);
            toast('Collectors re-injected into the current page', 'ok');
            await refresh({ silent: true });
          } catch (error) {
            toast(A.errorMessage(error), 'error');
          }
        }
      });
      actions.push({
        label: 'Reload page',
        kind: 'btn-ghost',
        onClick: async function () {
          try {
            await API.reloadTab(tabId);
          } catch (error) {
            toast(A.errorMessage(error), 'error');
          }
        }
      });
      actions.push({
        label: 'Export ledger',
        kind: 'btn-ghost',
        onClick: function () {
          A.exportModal({ session: state.session, visibleIds: currentVisibleIds(), toast: toast });
        }
      });
      actions.push({
        label: 'Unseal origin',
        kind: 'btn-danger',
        onClick: function () {
          A.unseal({ origin: origin, onDone: function () { state.snapshot = false; refresh({ silent: false }); }, toast: toast });
        }
      });
      actions.push({
        label: 'Purge ledger',
        kind: 'btn-danger',
        onClick: function () {
          A.purge({ origin: origin, tabId: tabId, onDone: function () { refresh({ silent: false }); }, toast: toast });
        }
      });
    }
    actions.push({ label: 'Cancel', kind: 'btn-ghost' });
    A.openModal({
      title: 'Scope controls',
      copy: 'Kimbo only observes traffic the page already makes.',
      body: body,
      actions: actions
    });
  }

  function currentVisibleIds() {
    if (!state.session) return [];
    try {
      return R.filterEndpoints(state.session, state).map(function (endpoint) {
        return endpoint.id;
      });
    } catch (_) {
      return [];
    }
  }

  function actions() {
    return {
      openEndpoint: function (id) {
        state.selectedId = id;
        state.view = 'endpoints';
        render();
      },
      closeDetail: function () {
        state.selectedId = null;
        render();
      },
      setQuery: function (value) {
        state.query = value;
        render();
      },
      setFilter: function (filter) {
        state.filter = filter;
        render();
      },
      setSort: function (sort) {
        state.sort = sort;
        render();
      },
      setIncludeSameSite: function (value) {
        state.includeSameSite = Boolean(value);
        render();
      },
      seal: function (includeSameSite) {
        enableSeal(includeSameSite !== false);
      },
      viewSnapshot: function () {
        state.snapshot = true;
        render();
      },
      capture: function () {
        A.capture({
          origin: origin,
          tabId: tabId,
          onDone: function () {
            refresh({ silent: true });
          },
          toast: toast
        });
      },
      readBundles: function () {
        A.readBundles({
          origin: origin,
          tabId: tabId,
          onDone: function () {
            refresh({ silent: true });
          },
          toast: toast
        });
      },
      pasteBundle: function () {
        A.pasteBundle({
          origin: origin,
          onDone: function () {
            refresh({ silent: true });
          },
          toast: toast
        });
      },
      purge: function () {
        A.purge({
          origin: origin,
          tabId: tabId,
          onDone: function () {
            state.snapshot = false;
            refresh({ silent: false });
          },
          toast: toast
        });
      },
      pin: function (endpointId, placeholderId, contextId) {
        A.pin({
          origin: origin,
          endpointId: endpointId,
          placeholderId: placeholderId,
          contextId: contextId,
          onDone: function () {
            refresh({ silent: true });
          },
          toast: toast
        });
      },
      note: function (endpointId, text) {
        const endpoint = state.session && state.session.endpoints[endpointId];
        if (endpoint) endpoint.note = text;
        if (noteTimer) clearTimeout(noteTimer);
        noteTimer = setTimeout(function () {
          noteTimer = null;
          A.saveNote({ origin: origin, endpointId: endpointId, text: text, toast: toast });
        }, 650);
      },
      copyUrl: function (endpoint) {
        A.copyUrl({ session: state.session, endpoint: endpoint, toast: toast });
      },
      copyCurl: function (endpoint) {
        A.copyCurl({ session: state.session, endpoint: endpoint, toast: toast });
      },
      copyBurp: function (endpoint) {
        A.copyBurp({ session: state.session, endpoint: endpoint, toast: toast });
      },
      copyPostman: function (endpoint) {
        A.copyPostman({ session: state.session, endpoint: endpoint, toast: toast });
      },
      copyNetworkFilter: function (endpoint) {
        A.copyNetworkFilter({ endpoint: endpoint, toast: toast });
      },
      filterAnchor: function (contextId) {
        state.anchorFilter = contextId;
        state.view = 'endpoints';
        state.selectedId = null;
        render();
      },
      clearAnchorFilter: function () {
        state.anchorFilter = null;
        render();
      }
    };
  }

  function renderIdentity() {
    if (!refs) return;
    D.clear(refs.identity);
    if (!origin) {
      refs.identity.appendChild(h('span', { class: 'muted' }, 'No attachable http(s) origin'));
      return;
    }
    const originSpan = h('span', { class: 'origin', title: origin }, origin);
    refs.identity.appendChild(originSpan);
    refs.identity.appendChild(h('span', { class: 'sep' }, '·'));
    if (!state.session || !state.session.identity) {
      refs.identity.appendChild(h('span', { class: 'unsealed' }, 'identity unanchored'));
      return;
    }
    const parts = F.identityParts(state.session.identity);
    if (!parts.length) {
      refs.identity.appendChild(h('span', { class: 'unsealed' }, 'identity unanchored'));
      return;
    }
    parts.forEach(function (part, index) {
      if (index) refs.identity.appendChild(h('span', { class: 'sep' }, '·'));
      const span = h('span', { class: 'identity' });
      span.appendChild(h('span', { class: part.className }, part.key + ' '));
      span.appendChild(h('b', null, part.value));
      refs.identity.appendChild(span);
    });
  }

  function renderStats() {
    D.clear(refs.stats);
    refs.stats.appendChild(R.renderStats(state.session));
  }

  function renderTabs() {
    const stats = (state.session && state.session.stats) || { endpoints: 0, anchors: 0 };
    const collecting = Boolean((state.scope && state.scope.sealed) || state.snapshot);
    refs.tabs.hidden = !collecting;
    for (const key of Object.keys(refs.tabButtons)) {
      const button = refs.tabButtons[key];
      button.classList.toggle('active', state.view === key);
      button.setAttribute('aria-selected', state.view === key ? 'true' : 'false');
      const count = key === 'endpoints' ? stats.endpoints || 0 : stats.anchors || 0;
      const badge = button.querySelector('.tab-count');
      if (badge) badge.textContent = String(count);
    }
  }

  function renderScopeChip() {
    if (!refs) return;
    const sealed = Boolean(state.scope && state.scope.sealed);
    const lost = state.scope && state.scope.reason === 'permission-lost';
    refs.scopeChip.classList.toggle('sealed', sealed);
    refs.scopeChip.classList.toggle('lost', !sealed && lost);
    refs.scopeLabel.textContent = sealed ? 'SEALED' : lost ? 'LOST' : 'UNSEALED';
    refs.scopeChip.title = sealed
      ? 'Scope sealed — open controls'
      : lost
        ? 'Host permission lost — open controls'
        : 'Scope unsealed — open controls';
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !active.id) return null;
    return {
      id: active.id,
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
    };
  }

  function restoreFocus(info) {
    if (!info) return;
    const el = document.getElementById(info.id);
    if (!el) return;
    try {
      el.focus();
      if (info.start != null && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(info.start, info.end == null ? info.start : info.end);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function render() {
    if (!refs || !state) return;
    const focus = captureFocus();
    const oldList = document.getElementById('kimbo-list');
    if (oldList) lastListScroll = oldList.scrollTop;

    const collecting = Boolean((state.scope && state.scope.sealed) || state.snapshot);
    refs.app.classList.toggle('has-selection', Boolean(state.selectedId));
    renderScopeChip();
    renderIdentity();
    renderStats();
    renderTabs();
    refs.footerExport.disabled = !state.session || !Object.keys(state.session.endpoints || {}).length;
    D.clear(refs.view);
    refs.view.hidden = false;

    if (!origin) {
      refs.view.appendChild(
        R.emptyState(
          'alert',
          'Unsupported page',
          'Kimbo only attaches to normal http(s) origins. Open a target tab and launch it from the toolbar or DevTools panel.',
          null
        )
      );
      restoreFocus(focus);
      return;
    }

    if (!collecting) {
      const hasSnapshot = Boolean(
        state.session &&
          (Object.keys(state.session.endpoints || {}).length ||
            Object.keys(state.session.context || {}).length)
      );
      refs.view.appendChild(
        R.renderScopeGate({
          origin: origin,
          tabId: tabId,
          scopeStatus: state.scope || {},
          state: state,
          actions: actions(),
          hasSnapshot: hasSnapshot,
          mode: mode
        })
      );
      restoreFocus(focus);
      return;
    }

    if (state.snapshot && !(state.scope && state.scope.sealed)) {
      refs.view.appendChild(
        R.renderSnapshotBanner({
          state: state,
          origin: origin,
          actions: actions()
        })
      );
    }

    const session = state.session;
    const endpointCount = session ? Object.keys(session.endpoints || {}).length : 0;
    const ctxActions = actions();
    state.visibleIds = session ? R.filterEndpoints(session, state).map(function (endpoint) { return endpoint.id; }) : [];

    if (state.loading && !session) {
      refs.view.appendChild(h('div', { class: 'skeleton' }));
      refs.view.appendChild(h('div', { class: 'skeleton' }));
      restoreFocus(focus);
      return;
    }

    if (state.loadError && !session) {
      const retry = R.emptyState(
        'alert',
        'Could not load the ledger',
        state.loadError,
        null
      );
      const button = h(
        'button',
        {
          class: 'btn',
          type: 'button',
          on: {
            click: function () {
              refresh({ silent: false });
            }
          }
        },
        'Retry'
      );
      retry.appendChild(button);
      refs.view.appendChild(retry);
      restoreFocus(focus);
      return;
    }

    if (state.view === 'lattice') {
      if (!session || !endpointCount) {
        L.render(refs.view, session || { endpoints: {}, context: {} }, {
          compact: mode === 'popup',
          onAnchor: ctxActions.filterAnchor,
          onEndpoint: ctxActions.openEndpoint
        });
      } else {
        L.render(refs.view, session, {
          compact: mode === 'popup',
          activeEndpointId: state.selectedId,
          onAnchor: ctxActions.filterAnchor,
          onEndpoint: ctxActions.openEndpoint
        });
      }
      restoreFocus(focus);
      return;
    }

    if (state.view === 'context') {
      if (!session) {
        refs.view.appendChild(
          R.emptyState('database', 'No context yet', 'Browse the app or capture context after logging in.', null)
        );
      } else {
        refs.view.appendChild(R.renderContext({ session: session, state: state, actions: ctxActions }));
      }
      restoreFocus(focus);
      return;
    }

    if (!session || !endpointCount) {
      refs.view.appendChild(R.renderListening({ origin: origin, actions: ctxActions }));
      restoreFocus(focus);
      return;
    }

    const ctx = { session: session, state: state, actions: ctxActions, mode: mode };
    if (mode === 'popup') {
      if (state.selectedId) {
        const detailPane = h('div', { class: 'detail-pane' });
        const detail = R.renderDetail(ctx);
        if (detail) detailPane.appendChild(detail);
        refs.view.appendChild(detailPane);
      } else {
        refs.view.appendChild(R.renderListPane(ctx));
      }
    } else {
      const split = h('div', { class: 'panel-split' });
      split.appendChild(R.renderListPane(ctx));
      const detailPane = h('div', {
        class: 'detail-pane' + (state.selectedId ? '' : ' empty-detail')
      });
      if (state.selectedId) {
        const detail = R.renderDetail(ctx);
        if (detail) detailPane.appendChild(detail);
      } else {
        detailPane.appendChild(document.createTextNode('Select an endpoint'));
      }
      split.appendChild(detailPane);
      refs.view.appendChild(split);
    }

    const list = document.getElementById('kimbo-list');
    if (list && lastListScroll) list.scrollTop = lastListScroll;
    restoreFocus(focus);
  }

  async function mount(options) {
    mode = options && options.mode === 'panel' ? 'panel' : 'popup';
    state = {
      session: null,
      summary: null,
      scope: null,
      loading: true,
      busy: false,
      view: 'endpoints',
      filter: 'all',
      query: '',
      sort: 'risk',
      selectedId: null,
      anchorFilter: null,
      snapshot: false,
      includeSameSite: true,
      scopeError: '',
      loadError: null,
      visibleIds: []
    };
    await resolveContext(options || {});
    buildShell();
    if (origin) {
      unsubscribe = API.subscribe(origin, function () {
        scheduleReload();
      });
    }
    await refresh({ silent: false });
    window.addEventListener('beforeunload', function () {
      if (unsubscribe) unsubscribe();
    });
  }

  UI.shell = {
    mount: mount,
    getState: function () {
      return state;
    },
    getOrigin: function () {
      return origin;
    },
    getTabId: function () {
      return tabId;
    },
    refresh: refresh
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
