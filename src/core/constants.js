/**
 * Kimbo JS — shared constants.
 * Original work. MIT licensed. See NOTICE.md for conceptual inspiration.
 */
(function (root, factory) {
  'use strict';
  const isNode =
    typeof module === 'object' &&
    module.exports &&
    typeof require === 'function' &&
    typeof window === 'undefined';

  if (isNode) {
    module.exports = factory();
  } else {
    root.KimboCore = root.KimboCore || {};
    root.KimboCore.constants = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const TOOL_NAME = 'Kimbo JS';
  const VERSION = '0.1.0';

  const LIMITS = Object.freeze({
    maxEventsPerMessage: 80,
    maxEventsPerBatch: 80,
    maxEndpoints: 400,
    maxContext: 250,
    maxCallsPerEndpoint: 8,
    maxSourcesPerEndpoint: 6,
    maxPages: 30,
    maxQuerySamples: 3,
    maxQueryPairs: 30,
    maxBundles: 60,
    maxBundlesPerPage: 20,
    maxSuggestionsPerPlaceholder: 3,
    maxCandidatesPerScript: 1500,
    maxScriptBytes: 2_000_000,
    maxInlineScriptBytes: 262_144,
    maxPasteBytes: 2_000_000,
    maxUrlLength: 4096,
    maxPathLength: 1024,
    maxValueLength: 300,
    maxNameLength: 120,
    maxClaimLength: 300,
    maxNoteLength: 2000,
    maxBundleReadBytes: 2_500_000,
    maxBundleReadTotalBytes: 12_000_000,
    batchWindowMs: 140,
    storageWarnBytes: 1_500_000,
    maxDomNodesPerScan: 8000,
    maxDomCandidatesPerScan: 300,
    maxDomContextPerScan: 120,
    maxProbeEntries: 320,
    maxPageTitleLength: 180,
    probeMinIntervalMs: 3500,
    probeRouteDelayMs: 1200,
    probeLoadDelayMs: 700,
    bundleReadDelayMs: 1200,
    maxDevtoolsEventsPerSecond: 8
  });

  const CONFIDENCE = Object.freeze({
    HIGH: 0.8,
    MEDIUM: 0.58,
    LOW: 0.34
  });

  const LEVELS = Object.freeze({
    PINNED: 'pinned',
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW: 'low',
    NONE: 'none',
    STATIC: 'static'
  });

  const RISK_LEVELS = Object.freeze({
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW: 'low',
    INFO: 'info'
  });

  const RISK_THRESHOLDS = Object.freeze({
    HIGH: 65,
    MEDIUM: 38,
    LOW: 1
  });

  const SCOPE_MODE = Object.freeze({
    ORIGIN: 'origin',
    SITE: 'site'
  });

  const GENERIC_PLACEHOLDERS = Object.freeze([
    'id',
    'uuid',
    'guid',
    'object_id',
    'objectid',
    'item_id',
    'entity_id',
    'resource_id',
    'key'
  ]);

  return {
    SCHEMA_VERSION,
    TOOL_NAME,
    VERSION,
    LIMITS,
    CONFIDENCE,
    LEVELS,
    RISK_LEVELS,
    RISK_THRESHOLDS,
    SCOPE_MODE,
    GENERIC_PLACEHOLDERS
  };
});
