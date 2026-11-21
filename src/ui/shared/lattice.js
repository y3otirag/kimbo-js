/* Kimbo JS — identity lattice. A small SVG map of anchors → endpoints. */
(function (root) {
  'use strict';
  const UI = (root.KimboUI = root.KimboUI || {});
  const D = UI.dom;
  const F = UI.format;

  const LEVEL_RANK = { pinned: 3, high: 3, medium: 2, low: 1 };

  function truncate(value, max) {
    const s = String(value == null ? '' : value);
    return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
  }

  function collect(session, compact) {
    const context = session.context || {};
    const edgeMap = new Map();
    const anchorMap = new Map();
    const endpointMap = new Map();

    for (const endpoint of Object.values(session.endpoints || {})) {
      const enrichment = endpoint.enrichment;
      if (!enrichment) continue;
      const results = enrichment.placeholderResults || {};
      for (const result of Object.values(results)) {
        for (const suggestion of result.suggestions || []) {
          const entry = context[suggestion.contextId];
          if (!entry) continue;
          const key = suggestion.contextId + '|' + endpoint.id;
          const level = suggestion.level === 'pinned' ? 'high' : suggestion.level;
          const existing = edgeMap.get(key);
          if (!existing || (LEVEL_RANK[level] || 0) > (LEVEL_RANK[existing.level] || 0)) {
            edgeMap.set(key, {
              anchorId: suggestion.contextId,
              endpointId: endpoint.id,
              level: level,
              confidence: suggestion.confidence
            });
          }
        }
      }
      const hints = enrichment.queryHints || {};
      for (const hint of Object.values(hints)) {
        const best = (hint.suggestions || []).find(function (s) {
          return s.level === 'high' || s.level === 'medium' || s.level === 'pinned';
        });
        if (!best) continue;
        const entry = context[best.contextId];
        if (!entry) continue;
        const key = best.contextId + '|' + endpoint.id;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            anchorId: best.contextId,
            endpointId: endpoint.id,
            level: best.level === 'pinned' ? 'high' : best.level,
            confidence: best.confidence
          });
        }
      }
    }

    for (const edge of edgeMap.values()) {
      if (!anchorMap.has(edge.anchorId)) {
        const entry = context[edge.anchorId];
        if (!entry) continue;
        anchorMap.set(edge.anchorId, { entry: entry, endpoints: new Set() });
      }
      if (!endpointMap.has(edge.endpointId)) {
        const endpoint = session.endpoints[edge.endpointId];
        if (!endpoint) continue;
        endpointMap.set(edge.endpointId, { endpoint: endpoint, anchors: new Set() });
      }
      const anchorNode = anchorMap.get(edge.anchorId);
      const endpointNode = endpointMap.get(edge.endpointId);
      if (anchorNode) anchorNode.endpoints.add(edge.endpointId);
      if (endpointNode) endpointNode.anchors.add(edge.anchorId);
    }

    const maxAnchors = compact ? 6 : 14;
    const maxEndpoints = compact ? 10 : 24;
    const anchors = Array.from(anchorMap.values())
      .sort(function (a, b) {
        return b.endpoints.size - a.endpoints.size;
      })
      .slice(0, maxAnchors);
    const anchorIds = new Set(anchors.map(function (node) { return node.entry.id; }));
    const endpoints = Array.from(endpointMap.values())
      .filter(function (node) {
        for (const id of node.anchors) if (anchorIds.has(id)) return true;
        return false;
      })
      .sort(function (a, b) {
        const ar = a.endpoint.risk ? a.endpoint.risk.score : 0;
        const br = b.endpoint.risk ? b.endpoint.risk.score : 0;
        if (br !== ar) return br - ar;
        return b.anchors.size - a.anchors.size;
      })
      .slice(0, maxEndpoints);
    const endpointIds = new Set(endpoints.map(function (node) { return node.endpoint.id; }));

    const edges = Array.from(edgeMap.values()).filter(function (edge) {
      return anchorIds.has(edge.anchorId) && endpointIds.has(edge.endpointId);
    });

    return { anchors: anchors, endpoints: endpoints, edges: edges };
  }

  function edgePath(x1, y1, x2, y2) {
    const mid = x1 + (x2 - x1) * 0.5;
    return 'M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2;
  }

  function renderEmpty(container, copy) {
    const empty = D.h('div', { class: 'lattice-empty' }, copy);
    container.appendChild(empty);
  }

  function render(container, session, opts) {
    const options = opts || {};
    D.clear(container);
    const compact = Boolean(options.compact);
    const view = D.h('div', { class: 'lattice-view' });
    const head = D.h(
      'div',
      { class: 'lattice-head' },
      D.h(
        'div',
        null,
        D.h('h2', { class: 'lattice-title' }, 'Identity lattice'),
        D.h(
          'p',
          { class: 'lattice-copy' },
          'Which session anchors can reach which endpoints. Edges are suggestions, not proof of authorization.'
        )
      ),
      D.h(
        'div',
        { class: 'lattice-legend' },
        D.h('span', null, D.h('i', { class: 'legend-line' }), 'high'),
        D.h('span', null, D.h('i', { class: 'legend-line med' }), 'likely'),
        D.h('span', null, D.h('i', { class: 'legend-line low' }), 'type-only')
      )
    );
    view.appendChild(head);
    const canvas = D.h('div', { class: 'lattice-canvas' });
    view.appendChild(canvas);
    container.appendChild(view);

    const graph = collect(session, compact);
    if (!graph.edges.length) {
      renderEmpty(
        canvas,
        'No anchored edges yet. Browse the app, capture context, or pin a value to draw the lattice.'
      );
      return;
    }

    const width = compact ? 414 : 760;
    const rowGap = compact ? 46 : 52;
    const rows = Math.max(graph.anchors.length, graph.endpoints.length);
    const height = Math.max(300, rows * rowGap + 56);
    const pad = 18;
    const anchorW = compact ? 118 : 196;
    const endpointW = compact ? 202 : 300;
    const anchorX = pad;
    const endpointX = width - pad - endpointW;
    const top = 34;
    const anchorStep = rows > 1 ? (height - top * 2) / (rows - 1) : 0;
    const endpointStep = rows > 1 ? (height - top * 2) / (rows - 1) : 0;

    const anchorPositions = new Map();
    const endpointPositions = new Map();
    const anchorOffset = (rows - graph.anchors.length) / 2;
    const endpointOffset = (rows - graph.endpoints.length) / 2;

    graph.anchors.forEach(function (node, index) {
      const y = top + (index + anchorOffset) * anchorStep;
      anchorPositions.set(node.entry.id, { x: anchorX, y: y, w: anchorW, h: 36 });
    });
    graph.endpoints.forEach(function (node, index) {
      const y = top + (index + endpointOffset) * endpointStep;
      endpointPositions.set(node.endpoint.id, { x: endpointX, y: y, w: endpointW, h: 38 });
    });

    const svgEl = D.svg('svg', {
      class: 'lattice-svg',
      viewBox: '0 0 ' + width + ' ' + height,
      width: '100%',
      height: String(height),
      role: 'img',
      'aria-label': 'Identity anchors connected to API endpoints'
    });

    for (const edge of graph.edges) {
      const a = anchorPositions.get(edge.anchorId);
      const b = endpointPositions.get(edge.endpointId);
      if (!a || !b) continue;
      const line = D.svg('path', {
        class: 'edge ' + (edge.level || 'low'),
        d: edgePath(a.x + a.w, a.y, b.x, b.y),
        'data-anchor': edge.anchorId,
        'data-endpoint': edge.endpointId
      });
      svgEl.appendChild(line);
    }

    graph.anchors.forEach(function (node) {
      const pos = anchorPositions.get(node.entry.id);
      const group = D.svg('g', {
        class: 'node node-anchor',
        tabindex: '0',
        role: 'button',
        'data-anchor': node.entry.id
      });
      group.appendChild(
        D.svg('rect', {
          x: pos.x,
          y: pos.y - pos.h / 2,
          width: pos.w,
          height: pos.h,
          rx: '2'
        })
      );
      const title = D.svg('title', null);
      title.textContent =
        node.entry.key +
        ' = ' +
        node.entry.value +
        ' · ' +
        node.endpoints.size +
        ' endpoint(s)';
      group.appendChild(title);
      const key = D.svg('text', {
        x: pos.x + 8,
        y: pos.y - 4,
        class: 'anchor-key',
        'font-size': compact ? '8.5' : '9.5'
      });
      key.textContent = truncate(node.entry.key, compact ? 16 : 24);
      group.appendChild(key);
      const value = D.svg('text', {
        x: pos.x + 8,
        y: pos.y + 10,
        class: 'anchor-value',
        'font-size': compact ? '8' : '9'
      });
      value.textContent =
        truncate(F.maskIdentityValue(node.entry.value), compact ? 17 : 28) +
        ' · ' +
        truncate(shortSource(node.entry), 8);
      group.appendChild(value);
      group.addEventListener('click', function () {
        if (options.onAnchor) options.onAnchor(node.entry.id);
      });
      group.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (options.onAnchor) options.onAnchor(node.entry.id);
        }
      });
      attachHover(svgEl, group, 'anchor', node.entry.id);
      svgEl.appendChild(group);
    });

    graph.endpoints.forEach(function (node) {
      const pos = endpointPositions.get(node.endpoint.id);
      const riskLevel = node.endpoint.risk ? node.endpoint.risk.level : 'info';
      const group = D.svg('g', {
        class:
          'node node-endpoint node-risk-' +
          riskLevel +
          (node.endpoint.id === options.activeEndpointId ? ' active' : ''),
        tabindex: '0',
        role: 'button',
        'data-endpoint': node.endpoint.id
      });
      group.appendChild(
        D.svg('rect', {
          x: pos.x,
          y: pos.y - pos.h / 2,
          width: pos.w,
          height: pos.h,
          rx: '2'
        })
      );
      const title = D.svg('title', null);
      title.textContent = node.endpoint.template + ' · ' + node.anchors.size + ' anchor(s)';
      group.appendChild(title);
      const method = (node.endpoint.methods && node.endpoint.methods[0]) || 'OBS';
      const methodText = D.svg('text', {
        x: pos.x + 8,
        y: pos.y + 4,
        class: 'ep-method',
        'font-size': compact ? '8' : '8.5',
        'font-weight': '700'
      });
      methodText.textContent = method;
      group.appendChild(methodText);
      const label = D.svg('text', {
        x: pos.x + (compact ? 42 : 52),
        y: pos.y + 4,
        class: 'ep-label',
        'font-size': compact ? '8' : '9'
      });
      label.textContent = truncate(
        node.endpoint.template,
        compact ? 24 : 38
      );
      group.appendChild(label);
      group.addEventListener('click', function () {
        if (options.onEndpoint) options.onEndpoint(node.endpoint.id);
      });
      group.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (options.onEndpoint) options.onEndpoint(node.endpoint.id);
        }
      });
      attachHover(svgEl, group, 'endpoint', node.endpoint.id);
      svgEl.appendChild(group);
    });

    canvas.appendChild(svgEl);
  }

  function shortSource(entry) {
    const source = entry.sources && entry.sources[0];
    if (!source) return 'ctx';
    if (source.kind === 'jwt') return 'JWT';
    if (source.kind === 'storage') return 'store';
    if (source.kind === 'cookie') return 'cookie';
    if (source.kind === 'dom') return 'DOM';
    if (source.kind === 'query') return 'query';
    if (source.kind === 'path') return 'path';
    return source.kind || 'ctx';
  }

  function attachHover(svgEl, group, type, id) {
    const focus = function (on) {
      const edges = svgEl.querySelectorAll('.edge');
      for (const edge of edges) {
        const anchor = edge.getAttribute('data-anchor');
        const endpoint = edge.getAttribute('data-endpoint');
        const related = type === 'anchor' ? anchor === id : endpoint === id;
        edge.classList.toggle('dim', on && !related);
      }
      const nodes = svgEl.querySelectorAll('.node');
      for (const node of nodes) {
        const anchor = node.getAttribute('data-anchor');
        const endpoint = node.getAttribute('data-endpoint');
        const related =
          !on ||
          (type === 'anchor'
            ? anchor === id || node.getAttribute('data-endpoint') === null
            : endpoint === id || node.getAttribute('data-anchor') === null);
        node.classList.toggle('dim', on && !related);
      }
    };
    group.addEventListener('mouseenter', function () {
      focus(true);
    });
    group.addEventListener('mouseleave', function () {
      focus(false);
    });
    group.addEventListener('focus', function () {
      focus(true);
    });
    group.addEventListener('blur', function () {
      focus(false);
    });
  }

  UI.lattice = { render: render, collect: collect };
})(typeof globalThis !== 'undefined' ? globalThis : this);
