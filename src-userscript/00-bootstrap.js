  "use strict";

  function defaultServiceOrigin() {
    const host = window.location.hostname;
    const serviceHost = host === "localhost" || host === "127.0.0.1" ? "127.0.0.1" : host;
    return `${window.location.protocol}//${serviceHost}:17896`;
  }

  const SERVICE_ORIGIN =
    window.localStorage.getItem("powerarrPlusServiceOrigin") ||
    defaultServiceOrigin();

  const state = {
    lastVisible: [],
    lastAllVisible: [],
    releaseByFingerprint: new Map(),
    dedupeGroupByFingerprint: new Map(),
    lastDedupeHiddenCount: 0,
    lastServiceHiddenFingerprints: [],
    currentPageActionHiddenFingerprints: new Set(),
    selected: new Set(),
    lastHiddenCount: 0,
    lastTotal: 0,
    serviceOk: null,
    toolbar: null,
    statusEl: null,
    injectTimer: null,
    nativeSelectionInterceptorInstalled: false,
    lastNativeSelectionKey: "",
    lastNativeSelectionAt: 0,
    searchReplay: null,
    releaseByTitleKey: new Map(),
    customFilters: [],
    customFiltersLoadedAt: 0,
    customFiltersRequest: null,
    transientStatusMessage: "",
    transientStatusUntil: 0,
    quickFilterText: "",
    quickFilterDraft: "",
  };

  const rowReleaseByFingerprint = new Map();
  const htmlDecodeCache = new Map();
  const rowTextCache = new WeakMap();
  const releaseMatchCache = new WeakMap();
  const nativeCheckboxVisualCache = new WeakMap();
  const nativeCheckboxStateCache = new WeakMap();
  const sizeNeedleCache = new Map();
  const numberTokenRegexCache = new Map();
  let htmlDecodeTextarea = null;
  const RESULT_ELEMENT_SELECTOR =
    "[role='gridcell'], tr, [role='row'], div[class*='row'], div[class*='Row']";
