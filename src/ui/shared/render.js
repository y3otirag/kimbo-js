/* Kimbo JS — rendering. All untrusted values are inserted as text nodes. */
(function (root) {
  'use strict';
  const UI = (root.KimboUI = root.KimboUI || {});
  const D = UI.dom;
  const F = UI.format;
  const C = root.KimboCore.constants;
  const N = root.KimboCore.normalizer;
  const Exporter = root.KimboCore.exporter;
  const h = D.h;

  function placeholderById(endpoint, id) {
    return (endpoint.placeholders || []).find(function (ph) {
      return ph.id === id;
    });
  }

  function renderPath(endpoint, opts) {
    const options = opts || {};
    const wrapper = h('span', { class: 'path-line', title: endpoint.template || '' });
    const segments = endpoint.pathSegments;
    if (!Array.isArray(segments) || !segments.length) {
      wrapper.appendChild(document.createTextNode(endpoint.template || endpoint.pathname || '/'));
      return wrapper;
    }
    wrapper.appendChild(document.createTextNode('/'));
    segments.forEach(function (parts, index) {
      if (index > 0) wrapper.appendChild(document.createTextNode('/'));
      for (const part of parts || []) {
        if (part.type === 'literal') {
          wrapper.appendChild(document.createTextNode(part.value));
        } else {
          const ph = placeholderById(endpoint, part.id);
          const token = h('span', {
            class: 'ph-token' + (options.risk ? ' risk' : ''),
            title: ph ? ph.name : 'placeholder'
          });
          token.textContent = ph ? ph.display : '{id}';
          wrapper.appendChild(token);
        }
      }
    });
    return wrapper;
  }

  function methodList(endpoint) {
    const methods = Exporter.uniqueMethods(endpoint);
    return methods.length ? methods : ['OBS'];
  }

  function renderMethods(endpoint, max) {
    const group = h('span', { class: 'method-set' });
    const methods = methodList(endpoint);
    const limit = max || 4;
    methods.slice(0, limit).forEach(function (method) {
      group.appendChild(
        h('span', { class: 'pill pill-method ' + F.methodClass(method) }, method)
      );
    });
    if (methods.length > limit) {
      group.appendChild(h('span', { class: 'pill' }, '+' + (methods.length - limit)));
    }
    return group;
  }

  function riskBadge(endpoint) {
    const risk = endpoint.risk;
    if (!risk || !risk.score) return null;
    const badge = h('span', { class: 'risk-badge ' + F.riskClass(risk.level), title: risk.disclaimer });
    const bar = h('span', { class: 'bar' });
    const fill = h('i');
    fill.style.width = Math.max(3, Math.min(100, risk.score)) + '%';
    bar.appendChild(fill);
    badge.appendChild(bar);
    badge.appendChild(document.createTextNode(String(risk.score)));
    return badge;
  }

  function confidencePill(level) {
    return h(
      'span',
      { class: 'conf-pill ' + F.levelClass(level) },
      F.levelLabel(level)
    );
  }

  function sourceKinds(endpoint) {
    const kinds = [];
    for (const source of endpoint.sources || []) {
      if (!kinds.includes(source.kind)) kinds.push(source.kind);
    }
    return kinds;
  }

  function sourceChip(kind) {
    return h(
      'span',
      { class: 'source-chip ' + (kind === 'form' ? 'dom' : kind) },
      h('span', { class: 'swatch' }),
      kind === 'form' ? 'form' : kind
    );
  }

  function subtitle(endpoint, session) {
    const parts = [];
    parts.push(endpoint.host || F.hostOf(endpoint.origin));
    if (endpoint.origin !== session.origin) parts.push('same-site companion');
    if (endpoint.scope === 'site' && endpoint.origin === session.origin) parts.push('site scope');
    parts.push('seen ' + F.relativeTime(endpoint.lastSeen));
    return parts.join(' · ');
  }

  function endpointCard(ctx, endpoint) {
    const state = ctx.state;
    const session = ctx.session;
    const risk = endpoint.risk;
    const enrichment = endpoint.enrichment;
    const card = h('article', {
      class:
        'endpoint-card' +
        (state.selectedId === endpoint.id ? ' active' : '') +
        (risk && risk.level === 'high' ? ' risk-high' : '') +
        (risk && risk.level === 'medium' ? ' risk-medium' : ''),
      tabindex: '0',
      role: 'button',
      'data-endpoint-id': endpoint.id,
      'aria-label': endpoint.template
    });

    const top = h('div', { class: 'card-top' }, renderMethods(endpoint));
    top.appendChild(h('span', { class: 'card-top-spacer' }));
    const riskEl = riskBadge(endpoint);
    if (riskEl) top.appendChild(riskEl);
    const copy = h(
      'button',
      {
        class: 'card-copy',
        type: 'button',
        title: 'Copy prepared URL',
        'aria-label': 'Copy prepared URL',
        on: {
          click: function (event) {
            event.stopPropagation();
            ctx.actions.copyUrl(endpoint);
          }
        }
      },
      D.icon('copy')
    );
    top.appendChild(copy);
    card.appendChild(top);
    card.appendChild(renderPath(endpoint));

    if (endpoint.host && endpoint.host !== F.hostOf(session.origin)) {
      const host = h('div', { class: 'host-chip' }, endpoint.host + ' · same-site');
      card.appendChild(host);
    }

    let prepared = '';
    try {
      prepared = Exporter.preparedUrl(session, endpoint);
    } catch (_) {
      prepared = '';
    }
    if (prepared) card.appendChild(h('div', { class: 'card-prepared', title: prepared }, prepared));

    const meta = h('div', { class: 'card-meta' });
    if (enrichment) {
      if (enrichment.placeholderCount === 0) {
        meta.appendChild(h('span', { class: 'conf-pill conf-static' }, 'static'));
      } else {
        meta.appendChild(confidencePill(enrichment.confidence));
        meta.appendChild(
          h(
            'span',
            { class: 'meta-text' },
            h('b', null, String(enrichment.filledCount)),
            '/' + enrichment.placeholderCount + ' anchored'
          )
        );
      }
      if (enrichment.pinnedCount) {
        meta.appendChild(h('span', { class: 'meta-text' }, h('b', null, String(enrichment.pinnedCount)) + ' pinned'));
      }
    }
    const kinds = sourceKinds(endpoint);
    if (kinds.length) {
      meta.appendChild(h('span', { class: 'meta-sep' }));
      for (const kind of kinds.slice(0, 3)) {
        meta.appendChild(
          h(
            'span',
            { class: 'meta-text' },
            kind === 'form' ? 'form' : kind
          )
        );
      }
    }
    card.appendChild(meta);

    card.addEventListener('click', function () {
      ctx.actions.openEndpoint(endpoint.id);
    });
    card.addEventListener('keydown', function (event) {
      if (event.target !== card) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        ctx.actions.openEndpoint(endpoint.id);
      }
    });
    return card;
  }

  function computeChipCounts(session) {
    const list = Object.values(session.endpoints || {});
    return {
      all: list.length,
      anchored: list.filter(function (endpoint) {
        return endpoint.enrichment && endpoint.enrichment.filledCount > 0;
      }).length,
      leads: list.filter(function (endpoint) {
        return endpoint.risk && endpoint.risk.score >= C.RISK_THRESHOLDS.MEDIUM;
      }).length,
      network: list.filter(function (endpoint) {
        return (endpoint.sources || []).some(function (source) {
          return source.kind === 'network';
        });
      }).length,
      unanchored: list.filter(function (endpoint) {
        const e = endpoint.enrichment;
        return e && e.placeholderCount > 0 && e.filledCount < e.placeholderCount;
      }).length
    };
  }

  function filterEndpoints(session, state) {
    const all = Object.values(session.endpoints || {});
    const query = String(state.query || '').trim().toLowerCase();
    const anchorId = state.anchorFilter || null;
    const filtered = all.filter(function (endpoint) {
      const enrichment = endpoint.enrichment;
      if (state.filter === 'anchored' && !(enrichment && enrichment.filledCount > 0)) return false;
      if (state.filter === 'leads' && !(endpoint.risk && endpoint.risk.score >= C.RISK_THRESHOLDS.MEDIUM)) return false;
      if (state.filter === 'network') {
        const hasNetwork = (endpoint.sources || []).some(function (source) {
          return source.kind === 'network';
        });
        if (!hasNetwork) return false;
      }
      if (state.filter === 'unanchored') {
        if (!(enrichment && enrichment.placeholderCount > 0 && enrichment.filledCount < enrichment.placeholderCount)) {
          return false;
        }
      }
      if (anchorId) {
        let linked = false;
        if (endpoint.pins) {
          for (const id of Object.values(endpoint.pins)) if (id === anchorId) linked = true;
        }
        if (!linked && enrichment) {
          for (const result of Object.values(enrichment.placeholderResults || {})) {
            for (const suggestion of result.suggestions || []) {
              if (suggestion.contextId === anchorId) linked = true;
            }
          }
          for (const hint of Object.values(enrichment.queryHints || {})) {
            for (const suggestion of hint.suggestions || []) {
              if (suggestion.contextId === anchorId) linked = true;
            }
          }
        }
        if (!linked) return false;
      }
      if (!query) return true;
      let prepared = '';
      try {
        prepared = Exporter.preparedUrl(session, endpoint);
      } catch (_) {
        prepared = '';
      }
      const haystack = [
        endpoint.template,
        endpoint.pathname,
        endpoint.host,
        endpoint.origin,
        endpoint.note,
        endpoint.methods.join(' '),
        prepared,
        (endpoint.querySamples || []).map(function (sample) {
          return (sample.pairs || []).map(function (pair) {
            return pair.key + '=' + pair.value;
          }).join('&');
        }).join(' ')
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    filtered.sort(function (a, b) {
      if (state.sort === 'recent') {
        return (b.lastSeen || 0) - (a.lastSeen || 0);
      }
      if (state.sort === 'path') {
        return String(a.template).localeCompare(String(b.template));
      }
      const ar = a.risk ? a.risk.score : 0;
      const br = b.risk ? b.risk.score : 0;
      if (br !== ar) return br - ar;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
    return filtered;
  }

  function renderToolbar(ctx) {
    const state = ctx.state;
    const counts = computeChipCounts(ctx.session);
    const toolbar = h('div', { class: 'toolbar' });
    const row = h('div', { class: 'toolbar-row' });
    const searchWrap = h('div', { class: 'search-wrap' }, D.icon('search'));
    const input = h('input', {
      id: 'kimbo-search',
      type: 'search',
      placeholder: 'Filter path, host, method, note…',
      value: state.query || '',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Filter endpoints'
    });
    input.addEventListener('input', function () {
      ctx.actions.setQuery(input.value);
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        input.value = '';
        ctx.actions.setQuery('');
      }
    });
    searchWrap.appendChild(input);
    row.appendChild(searchWrap);
    const select = h(
      'select',
      { id: 'kimbo-sort', 'aria-label': 'Sort endpoints', title: 'Sort' },
      h('option', { value: 'risk', selected: state.sort === 'risk' }, 'Risk'),
      h('option', { value: 'recent', selected: state.sort === 'recent' }, 'Recent'),
      h('option', { value: 'path', selected: state.sort === 'path' }, 'Path')
    );
    select.addEventListener('change', function () {
      ctx.actions.setSort(select.value);
    });
    row.appendChild(select);
    toolbar.appendChild(row);

    const chips = h('div', { class: 'chips' });
    [
      ['all', 'All', counts.all],
      ['anchored', 'Anchored', counts.anchored],
      ['leads', 'Leads', counts.leads],
      ['network', 'Network', counts.network],
      ['unanchored', 'Needs anchor', counts.unanchored]
    ].forEach(function (item) {
      const button = h(
        'button',
        {
          class: 'chip' + (state.filter === item[0] ? ' active' : ''),
          type: 'button',
          'aria-pressed': state.filter === item[0] ? 'true' : 'false'
        },
        item[1],
        h('span', { class: 'n' }, String(item[2]))
      );
      button.addEventListener('click', function () {
        ctx.actions.setFilter(item[0]);
      });
      chips.appendChild(button);
    });
    toolbar.appendChild(chips);

    if (state.anchorFilter) {
      const entry = ctx.session.context[state.anchorFilter];
      const filter = h('div', { class: 'anchor-filter' });
      filter.appendChild(D.icon('pin'));
      filter.appendChild(
        document.createTextNode(
          'anchor: ' +
            (entry ? entry.key + ' = ' + F.maskIdentityValue(entry.value) : state.anchorFilter)
        )
      );
      const clear = h(
        'button',
        { type: 'button', title: 'Clear anchor filter', 'aria-label': 'Clear anchor filter' },
        D.icon('x')
      );
      clear.addEventListener('click', function () {
        ctx.actions.clearAnchorFilter();
      });
      filter.appendChild(clear);
      toolbar.appendChild(filter);
    }
    return toolbar;
  }

  function renderListPane(ctx) {
    const pane = h('div', { class: 'list-pane' });
    pane.appendChild(renderToolbar(ctx));
    const list = h('div', { class: 'endpoint-list', id: 'kimbo-list' });
    const endpoints = filterEndpoints(ctx.session, ctx.state);
    ctx.state.visibleIds = endpoints.map(function (endpoint) {
      return endpoint.id;
    });
    if (!endpoints.length) {
      list.appendChild(
        emptyState(
          'search',
          'No endpoints match',
          'Adjust the filter or keep browsing. Kimbo only records what the page already exposes.',
          null
        )
      );
    } else {
      const limit = ctx.mode === 'popup' ? 180 : 260;
      endpoints.slice(0, limit).forEach(function (endpoint) {
        list.appendChild(endpointCard(ctx, endpoint));
      });
      if (endpoints.length > limit) {
        list.appendChild(
          h(
            'div',
            { class: 'hint' },
            'Showing ' + limit + ' of ' + endpoints.length + '. Narrow the filter to see the rest.'
          )
        );
      }
    }
    pane.appendChild(list);
    const footer = h('div', { class: 'list-footer' });
    footer.appendChild(h('span', null, endpoints.length + ' shown'));
    const total = Object.keys(ctx.session.endpoints || {}).length;
    footer.appendChild(h('span', null, total + ' total'));
    pane.appendChild(footer);
    return pane;
  }

  function emptyState(iconName, title, copy, tips) {
    const wrapper = h(
      'div',
      { class: 'empty-state' },
      h('div', { class: 'empty-icon' }, D.icon(iconName, 'icon-lg')),
      h('div', { class: 'empty-title' }, title),
      h('div', { class: 'empty-copy' }, copy)
    );
    if (Array.isArray(tips) && tips.length) {
      const list = h('ul', { class: 'empty-tips' });
      for (const tip of tips) list.appendChild(h('li', null, tip));
      wrapper.appendChild(list);
    }
    return wrapper;
  }

  function suggestionRow(ctx, endpoint, placeholder, suggestion) {
    const context = ctx.session.context[suggestion.contextId];
    if (!context) return null;
    const pinned = endpoint.pins && endpoint.pins[placeholder.id] === suggestion.contextId;
    const row = h('div', { class: 'suggestion-row' + (pinned ? ' pinned' : '') });
    row.appendChild(confidencePill(suggestion.level));
    row.appendChild(
      h(
        'span',
        { class: 'suggestion-value', title: context.value },
        F.maskIdentityValue(context.value)
      )
    );
    row.appendChild(
      h(
        'span',
        { class: 'suggestion-reason', title: suggestion.reason },
        context.key + ' · ' + (suggestion.sourceLabel || suggestion.sourceKind) + ' · ' + suggestion.reason
      )
    );
    const pin = h(
      'button',
      {
        class: 'btn btn-sm' + (pinned ? ' btn-acid' : ' btn-ghost'),
        type: 'button',
        title: pinned ? 'Remove this pin' : 'Use this value for this placeholder',
        'aria-label': pinned ? 'Unpin value' : 'Pin value'
      },
      pinned ? 'Pinned' : 'Pin'
    );
    pin.addEventListener('click', function (event) {
      event.stopPropagation();
      ctx.actions.pin(endpoint.id, placeholder.id, pinned ? null : suggestion.contextId);
    });
    row.appendChild(pin);
    return row;
  }

  function renderPlaceholderSection(ctx, endpoint) {
    const section = h('div', { class: 'section' });
    section.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'Identity fills'),
        h('span', { class: 'line' })
      )
    );
    const placeholders = endpoint.placeholders || [];
    if (!placeholders.length) {
      section.appendChild(
        h(
          'div',
          { class: 'ph-reason' },
          'Static path. No identity placeholder was inferred from this route.'
        )
      );
      return section;
    }
    for (const placeholder of placeholders) {
      const result =
        endpoint.enrichment &&
        endpoint.enrichment.placeholderResults &&
        endpoint.enrichment.placeholderResults[placeholder.id];
      const suggestions = result && Array.isArray(result.suggestions) ? result.suggestions : [];
      const chosen = Exporter.bestForPlaceholder(ctx.session, endpoint, placeholder);
      const card = h('div', { class: 'placeholder-card' });
      const head = h('div', { class: 'ph-head' });
      head.appendChild(h('span', { class: 'ph-name' }, placeholder.display || '{' + placeholder.name + '}'));
      if (chosen.level && chosen.level !== 'none') {
        head.appendChild(confidencePill(chosen.level));
      }
      const value = h(
        'span',
        { class: 'ph-value', title: chosen.value || '' },
        chosen.value == null ? 'no value' : F.maskIdentityValue(chosen.value)
      );
      head.appendChild(value);
      card.appendChild(head);
      const body = h('div', { class: 'ph-body' });
      const meta = h('div', { class: 'ph-meta' });
      meta.appendChild(
        h(
          'span',
          { class: 'meta-text' },
          chosen.origin === 'pin'
            ? 'pinned'
            : chosen.origin === 'suggested'
              ? 'suggested'
              : chosen.origin === 'observed'
                ? 'observed value'
              : chosen.origin === 'low-suggestion'
                ? 'low-confidence suggestion'
                : 'placeholder'
        )
      );
      if (chosen.sourceLabel) {
        meta.appendChild(h('span', { class: 'meta-sep' }));
        meta.appendChild(h('span', { class: 'meta-text' }, chosen.sourceLabel));
      }
      if (placeholder.valueType && placeholder.valueType !== 'unknown') {
        meta.appendChild(h('span', { class: 'meta-sep' }));
        meta.appendChild(h('span', { class: 'meta-text' }, placeholder.valueType));
      }
      if (placeholder.sensitive) {
        meta.appendChild(h('span', { class: 'meta-sep' }));
        meta.appendChild(h('span', { class: 'meta-text' }, 'sensitive — not stored'));
      }
      body.appendChild(meta);
      if (suggestions.length) {
        body.appendChild(
          h(
            'div',
            { class: 'ph-reason' },
            suggestions[0].reason +
              (chosen.origin === 'observed'
                ? ' · low-confidence suggestions do not override the observed value'
                : '')
          )
        );
      } else {
        body.appendChild(
          h(
            'div',
            { class: 'ph-reason' },
            placeholder.sensitive
              ? 'Sensitive placeholder. Kimbo intentionally does not fill it.'
              : 'No session anchor matched. This is a manual decision.'
          )
        );
      }
      if (chosen.contextId) {
        const pinnedNow = endpoint.pins && endpoint.pins[placeholder.id] === chosen.contextId;
        const pinAction = h(
          'button',
          {
            class: 'btn btn-sm' + (pinnedNow ? ' btn-acid' : ' btn-ghost'),
            type: 'button',
            title: pinnedNow ? 'Remove this pin' : 'Pin this value'
          },
          pinnedNow ? 'Pinned' : 'Pin chosen'
        );
        pinAction.addEventListener('click', function (event) {
          event.stopPropagation();
          ctx.actions.pin(
            endpoint.id,
            placeholder.id,
            pinnedNow ? null : chosen.contextId
          );
        });
        const pinRow = h('div', { class: 'ph-actions' }, pinAction);
        body.appendChild(pinRow);
      }
      const list = h('div', { class: 'suggestions' });
      let rendered = 0;
      for (const suggestion of suggestions) {
        if (
          chosen.contextId &&
          suggestion.contextId === chosen.contextId &&
          chosen.origin !== 'observed'
        ) {
          continue;
        }
        const row = suggestionRow(ctx, endpoint, placeholder, suggestion);
        if (row) {
          list.appendChild(row);
          rendered++;
        }
      }
      if (rendered) body.appendChild(list);
      card.appendChild(body);
      section.appendChild(card);
    }
    return section;
  }

  function findQueryHint(endpoint, key) {
    const hints = (endpoint.enrichment && endpoint.enrichment.queryHints) || {};
    if (hints[key]) return hints[key];
    for (const hint of Object.values(hints)) {
      if (hint && hint.key === key) return hint;
    }
    return null;
  }

  function renderQuerySection(ctx, endpoint) {
    const samples = endpoint.querySamples || [];
    if (!samples.length) return null;
    const pairs = samples[0].pairs || [];
    if (!pairs.length) return null;
    const section = h('div', { class: 'section' });
    section.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'Query surface'),
        h('span', { class: 'line' })
      )
    );
    const list = h('div', { class: 'query-list' });
    for (const pair of pairs) {
      const hint = findQueryHint(endpoint, pair.key);
      const suggested =
        hint &&
        hint.suggestions &&
        hint.suggestions.find(function (s) {
          return s.level === 'high' || s.level === 'medium' || s.level === 'pinned';
        });
      const row = h('div', { class: 'query-row' });
      row.appendChild(h('span', { class: 'query-key' }, pair.key));
      row.appendChild(document.createTextNode('='));
      row.appendChild(
        h(
          'span',
          { class: 'query-value', title: pair.value },
          pair.redacted ? '[redacted]' : pair.value
        )
      );
      if (suggested) {
        row.appendChild(
          h(
            'span',
            { class: 'tag', title: 'Preferred value for export/copy' },
            '→ ' + F.levelLabel(suggested.level)
          )
        );
      } else if (pair.redacted) {
        row.appendChild(h('span', { class: 'tag' }, 'not stored'));
      }
      list.appendChild(row);
    }
    section.appendChild(list);
    section.appendChild(
      h(
        'div',
        { class: 'hint' },
        'High/medium identity suggestions replace observed query values in the prepared URL. Redacted values are omitted.'
      )
    );
    return section;
  }

  function renderRisk(ctx, endpoint) {
    const risk = endpoint.risk;
    if (!risk) return null;
    const panel = h('div', {
      class: 'risk-panel ' + (risk.level === 'high' ? 'high' : risk.level === 'medium' ? 'medium' : '')
    });
    const head = h('div', { class: 'risk-head' });
    head.appendChild(h('span', { class: 'conf-pill ' + F.riskClass(risk.level) }, F.riskLabel(risk.level)));
    head.appendChild(h('span', { class: 'risk-title' }, 'Authorization review lead'));
    head.appendChild(h('span', { class: 'risk-score' }, risk.score + '/100'));
    panel.appendChild(head);
    const reasons = h('ul', { class: 'risk-reasons' });
    for (const reason of risk.reasons || []) {
      reasons.appendChild(
        h('li', { title: reason.detail }, h('b', null, reason.label))
      );
    }
    panel.appendChild(reasons);
    if (risk.hypotheses && risk.hypotheses.length) {
      const box = h('div', { class: 'hypotheses' });
      box.appendChild(h('span', { class: 'section-label' }, 'Manual test cards'));
      const list = h('ul');
      for (const hypothesis of risk.hypotheses) list.appendChild(h('li', null, hypothesis));
      box.appendChild(list);
      panel.appendChild(box);
    }
    panel.appendChild(h('div', { class: 'disclaimer' }, risk.disclaimer));
    return panel;
  }

  function renderCalls(endpoint) {
    const calls = endpoint.calls || [];
    if (!calls.length) return null;
    const list = h('div', { class: 'call-list' });
    for (const call of calls) {
      const row = h('div', { class: 'call-row', title: call.url });
      row.appendChild(
        h('span', { class: 'call-method ' + F.methodClass(call.method) }, call.method || '—')
      );
      row.appendChild(
        h('span', { class: 'call-status ' + F.statusClass(call.status) }, F.statusText(call.status))
      );
      row.appendChild(h('span', { class: 'call-url' }, call.url));
      row.appendChild(h('span', { class: 'call-time' }, F.relativeTime(call.ts)));
      list.appendChild(row);
    }
    return list;
  }

  function renderEvidence(ctx, endpoint) {
    const section = h('div', { class: 'section' });
    section.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'Evidence ledger'),
        h('span', { class: 'line' })
      )
    );
    const calls = renderCalls(endpoint);
    if (calls) {
      section.appendChild(h('div', { class: 'ph-reason' }, 'Observed calls'));
      section.appendChild(calls);
    }
    const sources = endpoint.sources || [];
    if (sources.length) {
      section.appendChild(h('div', { class: 'section-label', style: 'margin-top:8px' }, 'Discovery'));
      const chips = h('div', { class: 'source-chips' });
      for (const source of sources) {
        const kindClass = source.kind === 'form' ? 'dom' : source.kind;
        chips.appendChild(
          h(
            'span',
            { class: 'source-chip ' + kindClass, title: source.pageUrl || '' },
            h('span', { class: 'swatch' }),
            source.label + (source.count > 1 ? ' ×' + source.count : '')
          )
        );
      }
      section.appendChild(chips);
    }
    if ((endpoint.pages || []).length) {
      section.appendChild(h('div', { class: 'section-label', style: 'margin-top:8px' }, 'Seen on pages'));
      const pages = h('div', { class: 'pages-list' });
      for (const page of endpoint.pages) pages.appendChild(h('div', { class: 'page-row' }, page));
      section.appendChild(pages);
    }
    section.appendChild(
      h(
        'div',
        { class: 'hint' },
        'Headers, cookies, request bodies and response bodies are intentionally not stored.'
      )
    );
    return section;
  }

  function renderDetail(ctx) {
    const endpoint = ctx.session.endpoints[ctx.state.selectedId];
    if (!endpoint) return null;
    const wrapper = h('div', { class: 'detail' });
    const head = h('div', { class: 'detail-head' });
    const main = h('div', { class: 'detail-head-main' });
    const back = h(
      'button',
      { class: 'back-btn', type: 'button', title: 'Back' },
      D.icon('arrow-left'),
      'Back'
    );
    back.addEventListener('click', function () {
      ctx.actions.closeDetail();
    });
    const titleRow = h('div', { class: 'detail-sub' }, back, renderMethods(endpoint, 5));
    const risk = riskBadge(endpoint);
    if (risk) titleRow.appendChild(risk);
    main.appendChild(titleRow);
    main.appendChild(renderPath(endpoint));
    main.appendChild(h('div', { class: 'detail-sub' }, subtitle(endpoint, ctx.session)));
    head.appendChild(main);
    wrapper.appendChild(head);

    let prepared = '';
    try {
      prepared = Exporter.preparedUrl(ctx.session, endpoint);
    } catch (_) {
      prepared = '';
    }
    const section = h('div', { class: 'section' });
    section.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'Prepared for manual testing'),
        h('span', { class: 'line' })
      )
    );
    const box = h('div', { class: 'prepared-box' });
    box.appendChild(h('div', { class: 'prepared-url' }, prepared || '(no URL)'));
    const copy = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        title: 'Copy prepared URL',
        on: {
          click: function () {
            ctx.actions.copyUrl(endpoint);
          }
        }
      },
      D.icon('copy'),
      'Copy'
    );
    box.appendChild(copy);
    section.appendChild(box);
    const fill = h('div', { class: 'fill-line' });
    fill.appendChild(
      document.createTextNode(
        'confidence ' +
          (endpoint.enrichment ? F.levelLabel(endpoint.enrichment.confidence) : 'none') +
          (endpoint.enrichment
            ? ' · ' + endpoint.enrichment.filledCount + '/' + endpoint.enrichment.placeholderCount + ' anchored'
            : '')
      )
    );
    if (endpoint.enrichment && endpoint.enrichment.pinnedCount) {
      fill.appendChild(document.createTextNode(' · ' + endpoint.enrichment.pinnedCount + ' pinned'));
    }
    section.appendChild(fill);
    wrapper.appendChild(section);

    const riskPanel = renderRisk(ctx, endpoint);
    if (riskPanel) wrapper.appendChild(riskPanel);
    wrapper.appendChild(renderPlaceholderSection(ctx, endpoint));
    const querySection = renderQuerySection(ctx, endpoint);
    if (querySection) wrapper.appendChild(querySection);
    wrapper.appendChild(renderEvidence(ctx, endpoint));

    const actionsSection = h('div', { class: 'section' });
    actionsSection.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'Handoff'),
        h('span', { class: 'line' })
      )
    );
    const actions = h('div', { class: 'detail-actions' });
    actions.appendChild(
      actionButton('cURL', 'terminal', function () {
        ctx.actions.copyCurl(endpoint);
      })
    );
    actions.appendChild(
      actionButton('Burp raw', 'shield', function () {
        ctx.actions.copyBurp(endpoint);
      })
    );
    actions.appendChild(
      actionButton('Postman item', 'package', function () {
        ctx.actions.copyPostman(endpoint);
      })
    );
    actions.appendChild(
      actionButton('Network filter', 'search', function () {
        ctx.actions.copyNetworkFilter(endpoint);
      })
    );
    actionsSection.appendChild(actions);
    actionsSection.appendChild(
      h(
        'div',
        { class: 'hint' },
        'No cookies or Authorization header. Add your own authorized session. Kimbo never sends these requests.'
      )
    );
    wrapper.appendChild(actionsSection);

    const notes = h('div', { class: 'section' });
    notes.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'Field note'),
        h('span', { class: 'line' })
      )
    );
    const textarea = h('textarea', {
      class: 'notes-area',
      id: 'kimbo-note',
      placeholder: 'Manual decision, authorization hypothesis, follow-up…',
      maxlength: String(C.LIMITS.maxNoteLength)
    });
    textarea.value = endpoint.note || '';
    textarea.addEventListener('input', function () {
      ctx.actions.note(endpoint.id, textarea.value);
    });
    notes.appendChild(textarea);
    wrapper.appendChild(notes);
    return wrapper;
  }

  function actionButton(label, iconName, handler) {
    const button = h(
      'button',
      { class: 'btn', type: 'button', on: { click: handler } },
      D.icon(iconName),
      label
    );
    return button;
  }

  function usageMap(session) {
    const usage = new Map();
    for (const endpoint of Object.values(session.endpoints || {})) {
      if (endpoint.pins) {
        for (const id of Object.values(endpoint.pins)) {
          usage.set(id, (usage.get(id) || 0) + 1);
        }
      }
      const enrichment = endpoint.enrichment;
      if (enrichment) {
        for (const result of Object.values(enrichment.placeholderResults || {})) {
          for (const suggestion of result.suggestions || []) {
            usage.set(suggestion.contextId, (usage.get(suggestion.contextId) || 0) + 1);
          }
        }
        for (const hint of Object.values(enrichment.queryHints || {})) {
          for (const suggestion of hint.suggestions || []) {
            usage.set(suggestion.contextId, (usage.get(suggestion.contextId) || 0) + 1);
          }
        }
      }
    }
    return usage;
  }

  function renderIdentityCard(ctx) {
    const session = ctx.session;
    const identity = session.identity;
    const card = h('div', { class: 'identity-card' });
    const line = h('div', { class: 'id-line' });
    const parts = F.identityParts(identity);
    if (!parts.length) {
      line.appendChild(h('span', { class: 'muted' }, 'No identity anchor captured yet.'));
    } else {
      for (const part of parts) {
        const span = h('span', { class: part.className });
        span.appendChild(h('span', { class: 'id-key' }, part.key));
        span.appendChild(document.createTextNode(' '));
        span.appendChild(h('b', null, part.value));
        line.appendChild(span);
      }
    }
    card.appendChild(line);
    const actions = h('div', { class: 'identity-actions' });
    const capture = h(
      'button',
      { class: 'btn btn-sm', type: 'button', on: { click: ctx.actions.capture } },
      D.icon('refresh'),
      'Capture now'
    );
    actions.appendChild(capture);
    actions.appendChild(
      h(
        'span',
        { class: 'hint' },
        session.contextCapturedAt ? 'context read ' + F.relativeTime(session.contextCapturedAt) : 'not captured yet'
      )
    );
    card.appendChild(actions);
    card.appendChild(
      h(
        'div',
        { class: 'hint', style: 'margin-top:6px' },
        'Tokens, passwords, cookies and request bodies are not stored. HttpOnly cookies are invisible to the extension.'
      )
    );
    return card;
  }

  function renderContext(ctx) {
    const session = ctx.session;
    const view = h('div', { class: 'context-view' });
    view.appendChild(renderIdentityCard(ctx));

    const usage = usageMap(session);
    const anchors = Object.values(session.context || {}).sort(function (a, b) {
      const au = usage.get(a.id) || 0;
      const bu = usage.get(b.id) || 0;
      if (bu !== au) return bu - au;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
    const section = h('div', { class: 'section' });
    section.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'Anchors · ' + anchors.length),
        h('span', { class: 'line' })
      )
    );
    if (!anchors.length) {
      section.appendChild(
        h('div', { class: 'hint' }, 'No identity-shaped values found yet. Capture context after logging in.')
      );
    } else {
      const list = h('div', { class: 'anchor-list' });
      for (const entry of anchors.slice(0, 120)) {
        const row = h('div', { class: 'anchor-row' });
        const main = h('div', { class: 'anchor-main' });
        main.appendChild(h('div', { class: 'anchor-key' }, entry.key));
        main.appendChild(
          h(
            'div',
            { class: 'anchor-value', title: entry.value },
            F.maskIdentityValue(entry.value)
          )
        );
        const meta = h('div', { class: 'anchor-meta' });
        meta.appendChild(h('span', null, entry.valueType || 'id'));
        const source = (entry.sources && entry.sources[0]) || null;
        if (source) meta.appendChild(h('span', null, source.label));
        if (usage.get(entry.id)) meta.appendChild(h('span', null, usage.get(entry.id) + ' link(s)'));
        main.appendChild(meta);
        row.appendChild(main);
        if (usage.get(entry.id)) {
          const show = h(
            'button',
            {
              class: 'btn btn-sm btn-ghost',
              type: 'button',
              title: 'Show endpoints linked to this anchor',
              on: {
                click: function () {
                  ctx.actions.filterAnchor(entry.id);
                }
              }
            },
            'Routes'
          );
          row.appendChild(show);
        }
        list.appendChild(row);
      }
      section.appendChild(list);
      if (anchors.length > 120) {
        section.appendChild(h('div', { class: 'hint' }, 'Showing the 120 most useful anchors.'));
      }
    }
    view.appendChild(section);

    const bundles = Object.values(session.bundles || {}).sort(function (a, b) {
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
    const bundleSection = h('div', { class: 'section' });
    bundleSection.appendChild(
      h(
        'div',
        { class: 'section-head' },
        h('span', { class: 'section-label' }, 'JS bundles · ' + bundles.length),
        h('span', { class: 'line' })
      )
    );
    const bundleActions = h('div', { class: 'detail-actions' });
    bundleActions.appendChild(
      actionButton('Read cached', 'refresh', ctx.actions.readBundles)
    );
    bundleActions.appendChild(
      actionButton('Paste JS', 'file', ctx.actions.pasteBundle)
    );
    bundleSection.appendChild(bundleActions);
    if (!bundles.length) {
      bundleSection.appendChild(
        h(
          'div',
          { class: 'hint' },
          'Kimbo watches SPA chunks. Cached bundles are dissected locally; uncached ones can be pasted manually.'
        )
      );
    } else {
      const list = h('div', { class: 'bundle-list' });
      for (const bundle of bundles.slice(0, 12)) {
        const row = h('div', { class: 'bundle-row' });
        row.appendChild(
          h(
            'span',
            { class: 'bundle-status ' + String(bundle.status || '').replace(/[^a-z-]/g, '') },
            bundle.status || 'pending'
          )
        );
        row.appendChild(h('span', { class: 'bundle-url', title: bundle.url }, bundle.url));
        const meta = [];
        if (bundle.extracted) meta.push(bundle.extracted + ' routes');
        if (bundle.bytes) meta.push(F.bytesLabel(bundle.bytes));
        if (bundle.redacted) meta.push('query redacted');
        if (bundle.readable === false) meta.push('manual paste');
        row.appendChild(h('span', { class: 'bundle-meta' }, meta.join(' · ')));
        list.appendChild(row);
      }
      bundleSection.appendChild(list);
      bundleSection.appendChild(
        h(
          'div',
          { class: 'hint', style: 'margin-top:5px' },
          'Cache-only reads never touch the network. “not-cached” means the browser had no local copy; paste it instead.'
        )
      );
    }
    view.appendChild(bundleSection);

    const danger = h('div', { class: 'danger-zone' });
    danger.appendChild(h('div', { class: 'section-label' }, 'Local ledger'));
    const dangerActions = h('div', { class: 'danger-actions' });
    dangerActions.appendChild(
      actionButton('Purge this origin', 'trash', ctx.actions.purge)
    );
    danger.appendChild(dangerActions);
    danger.appendChild(
      h(
        'div',
        { class: 'hint', style: 'margin-top:6px' },
        'Data stays in chrome.storage.local for this origin. It is never uploaded.'
      )
    );
    view.appendChild(danger);
    return view;
  }

  function renderScopeGate(ctx) {
    const scope = ctx.scopeStatus || {};
    const gate = h('div', { class: 'scope-gate' });
    const mark = h('div', { class: 'gate-mark' });
    mark.appendChild(brandMark(30));
    gate.appendChild(mark);
    gate.appendChild(h('div', { class: 'gate-kicker' }, scope.reason === 'permission-lost' ? 'Permission lost' : 'Scope seal'));
    gate.appendChild(
      h(
        'h1',
        { class: 'gate-title' },
        scope.reason === 'permission-lost'
          ? 'The seal was broken.'
          : 'Kimbo is asleep on this origin.'
      )
    );
    gate.appendChild(
      h(
        'p',
        { class: 'gate-copy' },
        'Seal this origin to start a passive map. Kimbo observes only traffic the page already makes, anchors object IDs from the current session, and hands you a prepared list. It never calls discovered APIs.'
      )
    );
    const origin = h('div', { class: 'gate-origin' }, h('span', { class: 'dot' }));
    origin.appendChild(h('span', null, ctx.origin || 'unknown origin'));
    gate.appendChild(origin);

    const list = h('ul', { class: 'gate-list' });
    for (const item of [
      ['shield', 'Explicit per-origin permission. No broad host access.'],
      ['zap', 'Passive fetch/XHR observation. Zero endpoint requests.'],
      ['lock', 'Tokens, cookies, bodies and PII never persisted.'],
      ['layers', 'Cached JS is dissected locally; uncached bundles can be pasted.']
    ]) {
      list.appendChild(h('li', null, D.icon(item[0]), item[1]));
    }
    gate.appendChild(list);

    const options = h('div', { class: 'gate-options' });
    const checkboxLabel = h('label', { class: 'check' });
    const checkbox = h('input', {
      type: 'checkbox',
      id: 'kimbo-same-site',
      checked: ctx.state.includeSameSite !== false
    });
    checkbox.addEventListener('change', function () {
      ctx.actions.setIncludeSameSite(checkbox.checked);
    });
    checkboxLabel.appendChild(checkbox);
    checkboxLabel.appendChild(
      h(
        'span',
        null,
        'Include same-site API hosts observed from this page (recommended for SPA APIs).'
      )
    );
    options.appendChild(checkboxLabel);
    options.appendChild(
      h(
        'div',
        { class: 'hint' },
        'Companion hosts are grouped in the ledger but never receive content-script injection.'
      )
    );
    gate.appendChild(options);

    const actions = h('div', { class: 'gate-actions' });
    const seal = h(
      'button',
      {
        class: 'btn btn-acid',
        type: 'button',
        disabled: !ctx.tabId || ctx.state.busy,
        title: ctx.tabId ? 'Request permission for this origin' : 'Open from the action popup or DevTools panel'
      },
      D.icon('lock'),
      ctx.state.busy ? 'Sealing…' : 'Seal this origin'
    );
    seal.addEventListener('click', function () {
      ctx.actions.seal(checkbox.checked);
    });
    actions.appendChild(seal);
    if (ctx.hasSnapshot) {
      const snapshot = h(
        'button',
        { class: 'btn btn-ghost', type: 'button', on: { click: ctx.actions.viewSnapshot } },
        'View last snapshot'
      );
      actions.appendChild(snapshot);
    }
    gate.appendChild(actions);
    if (!ctx.tabId) {
      gate.appendChild(
        h('div', { class: 'hint', style: 'margin-top:7px' }, 'No attachable tab. Open Kimbo from the toolbar on a normal http(s) page.')
      );
    }
    if (ctx.state.scopeError) {
      gate.appendChild(h('div', { class: 'gate-error' }, ctx.state.scopeError));
    }
    gate.appendChild(
      h(
        'div',
        { class: 'gate-foot' },
        'Chrome will ask for access to ' + (ctx.origin || 'this origin') + ' only. Same-site observations do not grant host permissions.'
      )
    );
    return gate;
  }

  function renderListening(ctx) {
    const wrapper = h('div', { class: 'empty-state' });
    wrapper.appendChild(h('div', { class: 'empty-icon' }, D.icon('compass', 'icon-lg')));
    wrapper.appendChild(h('div', { class: 'empty-title' }, 'Listening on ' + F.hostOf(ctx.origin)));
    wrapper.appendChild(
      h(
        'div',
        { class: 'empty-copy' },
        'Browse the app normally. Kimbo only records endpoints the page already exposes.'
      )
    );
    const tips = h('ul', { class: 'empty-tips' });
    for (const tip of [
      'Log in and open a few list/detail screens.',
      'Trigger the SPA routes you care about.',
      'Capture context after switching tenant/account.',
      'Read cached bundles to pull routes out of JS.'
    ]) {
      tips.appendChild(h('li', null, tip));
    }
    wrapper.appendChild(tips);
    const actions = h('div', { class: 'detail-actions' });
    actions.appendChild(actionButton('Capture context', 'refresh', ctx.actions.capture));
    actions.appendChild(actionButton('Read cached JS', 'package', ctx.actions.readBundles));
    actions.appendChild(actionButton('Paste JS', 'file', ctx.actions.pasteBundle));
    wrapper.appendChild(actions);
    return wrapper;
  }

  function renderSnapshotBanner(ctx) {
    const banner = h('div', { class: 'banner' });
    banner.appendChild(D.icon('alert'));
    banner.appendChild(
      document.createTextNode('Read-only snapshot. Scope is not sealed; no new observations are being collected.')
    );
    const seal = h(
      'button',
      { class: 'btn btn-sm btn-ghost', type: 'button', on: { click: function () { ctx.actions.seal(ctx.state.includeSameSite); } } },
      'Seal origin'
    );
    banner.appendChild(seal);
    return banner;
  }

  function renderStats(session) {
    const stats = (session && session.stats) || {
      endpoints: 0,
      anchored: 0,
      leadsHigh: 0,
      anchors: 0
    };
    const row = h('div', { class: 'stats-row' });
    const items = [
      { num: stats.endpoints || 0, label: 'endpoints', cls: '' },
      { num: stats.anchored || 0, label: 'anchored', cls: 'acid' },
      { num: (stats.leadsHigh || 0) + (stats.leadsMedium || 0), label: 'review leads', cls: 'ember' },
      { num: stats.anchors || 0, label: 'identity anchors', cls: 'amber' }
    ];
    for (const item of items) {
      const cell = h('div', { class: 'stat' });
      cell.appendChild(h('div', { class: 'stat-num ' + item.cls }, String(item.num)));
      cell.appendChild(h('div', { class: 'stat-label' }, item.label));
      row.appendChild(cell);
    }
    return row;
  }

  function brandMark(size) {
    const svgEl = D.svg('svg', {
      viewBox: '0 0 32 32',
      width: String(size || 18),
      height: String(size || 18),
      'aria-hidden': 'true'
    });
    svgEl.appendChild(
      D.svg('path', {
        d: 'M8 5v22M8 16.5 21 5M8 16.5 22 27',
        stroke: 'var(--acid)',
        'stroke-width': '3.2',
        'stroke-linecap': 'square',
        fill: 'none'
      })
    );
    svgEl.appendChild(
      D.svg('circle', {
        cx: '25',
        cy: '7',
        r: '2.6',
        fill: 'var(--ember)'
      })
    );
    return svgEl;
  }

  UI.render = {
    renderPath: renderPath,
    renderMethods: renderMethods,
    renderListPane: renderListPane,
    renderDetail: renderDetail,
    renderContext: renderContext,
    renderScopeGate: renderScopeGate,
    renderListening: renderListening,
    renderSnapshotBanner: renderSnapshotBanner,
    renderStats: renderStats,
    filterEndpoints: filterEndpoints,
    computeChipCounts: computeChipCounts,
    endpointCard: endpointCard,
    emptyState: emptyState,
    brandMark: brandMark,
    riskBadge: riskBadge,
    confidencePill: confidencePill
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
