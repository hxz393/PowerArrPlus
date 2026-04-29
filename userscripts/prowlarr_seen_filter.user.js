// ==UserScript==
// @name         PowerArrPlus - Prowlarr Seen Filter
// @namespace    local.powerarr-plus.prowlarr-seen-filter
// @version      0.1.18
// @description  Hide selected Prowlarr search results across future searches.
// @match        http://localhost:9696/*
// @match        http://127.0.0.1:9696/*
// @include      /^https?:\/\/[^/]+:9696\/.*$/
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
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
  };

  const rowReleaseByFingerprint = new Map();
  const RESULT_ELEMENT_SELECTOR =
    "[role='gridcell'], tr, [role='row'], div[class*='row'], div[class*='Row']";

  function isSearchUrl(input) {
    try {
      let raw = null;
      if (typeof input === "string") {
        raw = input;
      } else if (input && typeof input.url === "string") {
        raw = input.url;
      } else if (input && typeof input.href === "string") {
        raw = input.href;
      } else if (input !== null && input !== undefined) {
        raw = String(input);
      }
      if (!raw) {
        return false;
      }
      const url = new URL(raw, window.location.href);
      return url.pathname.replace(/\/+$/, "").endsWith("/api/v1/search");
    } catch (_error) {
      return false;
    }
  }

  function isGetRequest(input, init) {
    const method =
      (init && init.method) ||
      (typeof input === "object" && input && input.method) ||
      "GET";
    return String(method).toUpperCase() === "GET";
  }

  async function requestJson(method, path, payload) {
    const url = SERVICE_ORIGIN + path;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const response = await window.fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body,
    });

    if (!response.ok) {
      throw new Error(`local filter service returned HTTP ${response.status}`);
    }

    return response.json();
  }

  async function servicePost(path, payload) {
    const result = await requestJson("POST", path, payload);
    state.serviceOk = Boolean(result && result.ok);
    if (!result || result.ok === false) {
      throw new Error((result && result.error) || "local filter service failed");
    }
    return result;
  }

  async function filterReleases(releases) {
    const result = await servicePost("/api/filter", { releases });
    const serviceVisible = Array.isArray(result.visible) ? result.visible : releases;
    const serviceHidden = Array.isArray(result.hidden) ? result.hidden : [];
    const deduped = dedupeReleases(serviceVisible);

    rowReleaseByFingerprint.clear();
    state.lastAllVisible = serviceVisible;
    state.lastVisible = deduped.visible;
    state.releaseByFingerprint = new Map();
    for (const release of state.lastAllVisible) {
      if (release && release._seenFilterFingerprint) {
        state.releaseByFingerprint.set(release._seenFilterFingerprint, release);
      }
    }
    state.dedupeGroupByFingerprint = deduped.groupByFingerprint;
    state.lastDedupeHiddenCount = deduped.hidden.length;
    state.lastServiceHiddenFingerprints = serviceHidden
      .map((release) => release && (release.fingerprint || release._seenFilterFingerprint))
      .filter(Boolean);
    state.currentPageActionHiddenFingerprints.clear();
    state.selected.clear();
    state.lastHiddenCount = result.hiddenCount || 0;
    state.lastTotal = result.total || releases.length;
    updateStatus();
    scheduleInjectCheckboxes();
    return {
      ...result,
      visible: deduped.visible,
      duplicateHidden: deduped.hidden,
      duplicateHiddenCount: deduped.hidden.length,
    };
  }

  function installFetchHook() {
    if (!window.fetch || window.fetch.__powerArrPlusSeenFilterInstalled) {
      return;
    }

    const nativeFetch = window.fetch.bind(window);
    const wrappedFetch = async function (input, init) {
      const response = await nativeFetch(input, init);
      if (!response || !response.ok || !isGetRequest(input, init) || !isSearchUrl(input)) {
        return response;
      }

      try {
        const original = await response.clone().json();
        if (!Array.isArray(original)) {
          return response;
        }

        const result = await filterReleases(original);
        const headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.delete("Content-Length");
        return new Response(JSON.stringify(result.visible || []), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        state.serviceOk = false;
        updateStatus(`过滤服务不可用，显示原始结果：${error.message || error}`);
        return response;
      }
    };

    wrappedFetch.__powerArrPlusSeenFilterInstalled = true;
    window.fetch = wrappedFetch;
  }

  function installXhrObserver() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__powerArrPlusSeenFilterInstalled) {
      return;
    }

    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const nativeSetRequestHeader = proto.setRequestHeader;

    proto.open = function (method, url) {
      this.__powerArrPlusMethod = method;
      this.__powerArrPlusUrl = url;
      return nativeOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function (name, value) {
      this.__powerArrPlusRequestHeaders = this.__powerArrPlusRequestHeaders || {};
      this.__powerArrPlusRequestHeaders[name] = value;
      return nativeSetRequestHeader.apply(this, arguments);
    };

    proto.send = function () {
      if (
        String(this.__powerArrPlusMethod || "GET").toUpperCase() === "GET" &&
        isSearchUrl(this.__powerArrPlusUrl)
      ) {
        sendSyntheticSearchXhr(this);
        return undefined;
      }
      return nativeSend.apply(this, arguments);
    };

    proto.__powerArrPlusSeenFilterInstalled = true;
  }

  function setSyntheticXhrProperty(xhr, name, getter) {
    Object.defineProperty(xhr, name, {
      configurable: true,
      enumerable: true,
      get: getter,
    });
  }

  function installSyntheticXhrState(xhr) {
    if (xhr.__powerArrPlusSyntheticInstalled) {
      return;
    }

    xhr.__powerArrPlusSyntheticReadyState = 1;
    xhr.__powerArrPlusSyntheticStatus = 0;
    xhr.__powerArrPlusSyntheticStatusText = "";
    xhr.__powerArrPlusSyntheticResponseUrl = "";
    xhr.__powerArrPlusSyntheticResponseText = "";
    xhr.__powerArrPlusSyntheticResponseHeaders = new Headers();

    setSyntheticXhrProperty(xhr, "readyState", function () {
      return this.__powerArrPlusSyntheticReadyState;
    });
    setSyntheticXhrProperty(xhr, "status", function () {
      return this.__powerArrPlusSyntheticStatus;
    });
    setSyntheticXhrProperty(xhr, "statusText", function () {
      return this.__powerArrPlusSyntheticStatusText;
    });
    setSyntheticXhrProperty(xhr, "responseURL", function () {
      return this.__powerArrPlusSyntheticResponseUrl;
    });
    setSyntheticXhrProperty(xhr, "responseText", function () {
      return this.__powerArrPlusSyntheticResponseText;
    });
    setSyntheticXhrProperty(xhr, "response", function () {
      if (this.responseType === "json") {
        try {
          return JSON.parse(this.__powerArrPlusSyntheticResponseText || "null");
        } catch (_error) {
          return null;
        }
      }
      return this.__powerArrPlusSyntheticResponseText;
    });

    xhr.getResponseHeader = function (name) {
      return this.__powerArrPlusSyntheticResponseHeaders.get(name);
    };
    xhr.getAllResponseHeaders = function () {
      const lines = [];
      this.__powerArrPlusSyntheticResponseHeaders.forEach((value, name) => {
        lines.push(`${name}: ${value}`);
      });
      return lines.join("\r\n");
    };
    xhr.__powerArrPlusSyntheticInstalled = true;
  }

  function dispatchSyntheticXhrEvent(xhr, type) {
    xhr.dispatchEvent(new Event(type));
  }

  async function sendSyntheticSearchXhr(xhr) {
    installSyntheticXhrState(xhr);
    const url = new URL(xhr.__powerArrPlusUrl, window.location.href).href;
    const headers = xhr.__powerArrPlusRequestHeaders || {};

    try {
      xhr.__powerArrPlusSyntheticReadyState = 2;
      dispatchSyntheticXhrEvent(xhr, "readystatechange");

      const response = await window.fetch(url, {
        method: "GET",
        credentials: "same-origin",
        headers,
      });
      const text = await response.text();
      xhr.__powerArrPlusSyntheticStatus = response.status;
      xhr.__powerArrPlusSyntheticStatusText = response.statusText;
      xhr.__powerArrPlusSyntheticResponseUrl = response.url;
      xhr.__powerArrPlusSyntheticResponseText = text;
      xhr.__powerArrPlusSyntheticResponseHeaders = response.headers;
      xhr.__powerArrPlusSyntheticReadyState = 4;

      dispatchSyntheticXhrEvent(xhr, "readystatechange");
      dispatchSyntheticXhrEvent(xhr, response.ok ? "load" : "error");
      dispatchSyntheticXhrEvent(xhr, "loadend");
    } catch (error) {
      xhr.__powerArrPlusSyntheticStatus = 0;
      xhr.__powerArrPlusSyntheticStatusText = "";
      xhr.__powerArrPlusSyntheticReadyState = 4;
      state.serviceOk = false;
      updateStatus(`搜索请求失败：${error.message || error}`);
      dispatchSyntheticXhrEvent(xhr, "readystatechange");
      dispatchSyntheticXhrEvent(xhr, "error");
      dispatchSyntheticXhrEvent(xhr, "loadend");
    }
  }

  function comparableText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeHtmlEntities(value) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(value || "");
    return textarea.value;
  }

  function strictTitle(value) {
    return decodeHtmlEntities(value).normalize("NFC").trim();
  }

  function hasStrictValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function isNzbProtocol(release) {
    const protocol = comparableText(release && release.protocol);
    return protocol === "nzb" || protocol === "usenet";
  }

  function dedupeKeyForRelease(release) {
    if (!release || !isNzbProtocol(release)) {
      return null;
    }

    const title = strictTitle(release.title || release.sortTitle);
    if (!title || !hasStrictValue(release.size) || !hasStrictValue(release.files)) {
      return null;
    }

    return [
      "dedupe:nzb:v1",
      title,
      String(release.size).trim(),
      String(release.files).trim(),
    ].join("\u001f");
  }

  function numericGrabs(release) {
    const grabs = Number(release && release.grabs);
    return Number.isFinite(grabs) ? grabs : 0;
  }

  function dedupeReleases(releases) {
    const groups = new Map();
    const groupByFingerprint = new Map();
    const visibleFingerprints = new Set();
    const hidden = [];

    for (const release of releases) {
      const key = dedupeKeyForRelease(release);
      if (!key || !release._seenFilterFingerprint) {
        continue;
      }

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(release);
    }

    for (const group of groups.values()) {
      if (group.length < 2) {
        visibleFingerprints.add(group[0]._seenFilterFingerprint);
        continue;
      }

      let representative = group[0];
      for (const release of group.slice(1)) {
        if (numericGrabs(release) > numericGrabs(representative)) {
          representative = release;
        }
      }

      visibleFingerprints.add(representative._seenFilterFingerprint);
      for (const release of group) {
        groupByFingerprint.set(release._seenFilterFingerprint, group);
        if (release !== representative) {
          hidden.push(release);
        }
      }
    }

    const visible = releases.filter((release) => {
      const fingerprint = release && release._seenFilterFingerprint;
      const key = dedupeKeyForRelease(release);
      return !key || !fingerprint || visibleFingerprints.has(fingerprint);
    });

    return { visible, hidden, groupByFingerprint };
  }

  function releaseToHiddenSpec(release) {
    return {
      fingerprint: release.fingerprint || release._seenFilterFingerprint,
      title: release.title,
      sortTitle: release.sortTitle,
      indexer: release.indexer,
      indexerId: release.indexerId,
      size: release.size,
      files: release.files,
    };
  }

  function rowCandidates() {
    return resultElements().filter((row) => {
      if (!(row instanceof HTMLElement)) {
        return false;
      }
      if (row.closest(".powerarr-plus-toolbar")) {
        return false;
      }
      const text = comparableText(row.innerText || row.textContent || "");
      if (!text || text.length < 8) {
        return false;
      }
      return state.lastVisible.some((release) => releaseMatchScore(text, release) > 0);
    });
  }

  function resultRowForElement(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return element.closest(RESULT_ELEMENT_SELECTOR);
  }

  function resultText(element) {
    return comparableText(element.innerText || element.textContent || "");
  }

  function hasNestedGridResults(element) {
    if (element.matches("[role='gridcell']")) {
      return false;
    }

    return Boolean(element.querySelector("[role='gridcell']"));
  }

  function resultElements() {
    return Array.from(document.querySelectorAll(RESULT_ELEMENT_SELECTOR)).filter((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      if (element.closest(".powerarr-plus-toolbar")) {
        return false;
      }

      return !hasNestedGridResults(element);
    });
  }

  function releaseMatchScore(rowText, release) {
    const title = comparableText(release.title || release.sortTitle);
    if (!title || !rowText.includes(title)) {
      return 0;
    }

    let score = title.length;
    const indexer = comparableText(release.indexer);
    if (indexer && !rowText.includes(indexer)) {
      return 0;
    }
    if (indexer) {
      score += 1000 + indexer.length;
    }

    const protocol = comparableText(release.protocol);
    if (protocol && rowText.includes(protocol)) {
      score += 50;
    }

    return score;
  }

  function findReleaseForRow(row, used) {
    const rowText = resultText(row);
    let best = null;
    let bestScore = 0;

    for (const release of state.lastVisible) {
      const fingerprint = release._seenFilterFingerprint;
      if (!fingerprint || used.has(fingerprint)) {
        continue;
      }

      const score = releaseMatchScore(rowText, release);
      if (score > bestScore) {
        best = release;
        bestScore = score;
      }
    }

    return best;
  }

  function syncResultRows() {
    const used = new Set();
    for (const row of rowCandidates()) {
      const existingFingerprint = row.dataset.powerarrPlusFingerprint;
      if (existingFingerprint) {
        used.add(existingFingerprint);
        continue;
      }

      const release = findReleaseForRow(row, used);
      if (!release || !release._seenFilterFingerprint) {
        continue;
      }

      const fingerprint = release._seenFilterFingerprint;
      used.add(fingerprint);
      row.dataset.powerarrPlusFingerprint = fingerprint;
      rowReleaseByFingerprint.set(fingerprint, release);
      row.classList.add("powerarr-plus-row");
    }
  }

  function releaseRowForNativeCheckbox(checkbox) {
    let row = resultRowForElement(checkbox);
    while (row instanceof HTMLElement) {
      if (row.closest(".powerarr-plus-toolbar")) {
        return null;
      }

      if (row.dataset.powerarrPlusFingerprint) {
        return row;
      }

      row = row.parentElement ? resultRowForElement(row.parentElement) : null;
    }

    return null;
  }

  function nativeSelectionFingerprints() {
    const fingerprints = new Set();
    const used = new Set();

    document.querySelectorAll('input[type="checkbox"]:checked').forEach((checkbox) => {
      if (!(checkbox instanceof HTMLInputElement)) {
        return;
      }
      if (checkbox.closest(".powerarr-plus-toolbar") || checkbox.classList.contains("powerarr-plus-checkbox")) {
        return;
      }

      const row = releaseRowForNativeCheckbox(checkbox);
      if (!(row instanceof HTMLElement)) {
        return;
      }

      let fingerprint = row.dataset.powerarrPlusFingerprint;
      if (!fingerprint) {
        const release = findReleaseForRow(row, used);
        fingerprint = release && release._seenFilterFingerprint;
      }

      if (fingerprint) {
        used.add(fingerprint);
        fingerprints.add(fingerprint);
      }
    });

    return Array.from(fingerprints);
  }

  function bindNativeSelectionControls() {
    document.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      if (!(checkbox instanceof HTMLInputElement)) {
        return;
      }
      if (checkbox.closest(".powerarr-plus-toolbar") || checkbox.classList.contains("powerarr-plus-checkbox")) {
        return;
      }
      if (!releaseRowForNativeCheckbox(checkbox)) {
        return;
      }
      if (checkbox.dataset.powerarrPlusNativeBound === "1") {
        return;
      }

      checkbox.dataset.powerarrPlusNativeBound = "1";
      checkbox.addEventListener("change", () => {
        window.setTimeout(updateStatus, 0);
      });
    });
  }

  function hasNativeSelectionControls() {
    return Array.from(document.querySelectorAll('input[type="checkbox"]')).some((checkbox) => {
      if (!(checkbox instanceof HTMLInputElement)) {
        return false;
      }
      if (checkbox.closest(".powerarr-plus-toolbar") || checkbox.classList.contains("powerarr-plus-checkbox")) {
        return false;
      }
      return Boolean(releaseRowForNativeCheckbox(checkbox));
    });
  }

  function injectCell(row, checkbox) {
    if (row.tagName.toLowerCase() === "tr") {
      let cell = row.querySelector(":scope > .powerarr-plus-cell");
      if (!cell) {
        cell = document.createElement("td");
        cell.className = "powerarr-plus-cell";
        row.insertBefore(cell, row.firstElementChild);
      }
      cell.replaceChildren(checkbox);
      bindSelectionCell(cell, checkbox);
      return;
    }

    let holder = row.querySelector(":scope > .powerarr-plus-cell");
    if (!holder) {
      holder = document.createElement("span");
      holder.className = "powerarr-plus-cell";
      row.insertBefore(holder, row.firstChild);
    }
    holder.replaceChildren(checkbox);
    bindSelectionCell(holder, checkbox);
  }

  function bindSelectionCell(cell, checkbox) {
    if (cell.dataset.powerarrPlusSelectionBound === "1") {
      return;
    }

    cell.dataset.powerarrPlusSelectionBound = "1";
    cell.title = "点击选择该结果";
    cell.addEventListener("pointerdown", (event) => {
      if (event.target === checkbox) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setCheckboxSelected(checkbox, !checkbox.checked);
    });
    cell.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  function setCheckboxSelected(checkbox, selected) {
    const fingerprint = checkbox.dataset.powerarrPlusFingerprint;
    checkbox.checked = selected;
    checkbox.setAttribute("aria-checked", selected ? "true" : "false");

    const row = checkbox.closest("[data-powerarr-plus-fingerprint]");
    if (row) {
      row.classList.toggle("powerarr-plus-selected", selected);
    }

    if (fingerprint) {
      if (selected) {
        state.selected.add(fingerprint);
      } else {
        state.selected.delete(fingerprint);
      }
    }

    updateStatus();
  }

  function injectCheckboxes() {
    if (!state.lastVisible.length) {
      return;
    }

    syncResultRows();
    bindNativeSelectionControls();
    if (hasNativeSelectionControls()) {
      updateStatus();
      return;
    }

    const used = new Set();
    for (const row of rowCandidates()) {
      const existingFingerprint = row.dataset.powerarrPlusFingerprint;
      if (existingFingerprint) {
        used.add(existingFingerprint);
        continue;
      }

      const release = findReleaseForRow(row, used);
      if (!release || !release._seenFilterFingerprint) {
        continue;
      }

      const fingerprint = release._seenFilterFingerprint;
      used.add(fingerprint);
      row.dataset.powerarrPlusFingerprint = fingerprint;
      rowReleaseByFingerprint.set(fingerprint, release);
      row.classList.add("powerarr-plus-row");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "powerarr-plus-checkbox";
      checkbox.dataset.powerarrPlusFingerprint = fingerprint;
      checkbox.title = "选中后可加入隐藏过滤";
      checkbox.checked = state.selected.has(fingerprint);
      checkbox.setAttribute("aria-label", "选中后可加入隐藏过滤");
      checkbox.setAttribute("aria-checked", checkbox.checked ? "true" : "false");
      checkbox.addEventListener("change", () => {
        setCheckboxSelected(checkbox, checkbox.checked);
      });
      checkbox.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setCheckboxSelected(checkbox, !checkbox.checked);
      });
      checkbox.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      injectCell(row, checkbox);
    }

    updateStatus();
  }

  function scheduleInjectCheckboxes() {
    window.clearTimeout(state.injectTimer);
    state.injectTimer = window.setTimeout(injectCheckboxes, 250);
  }

  function expandFingerprintsWithDuplicates(fingerprints) {
    const expanded = new Set();
    for (const fingerprint of fingerprints) {
      if (!fingerprint) {
        continue;
      }

      const group = state.dedupeGroupByFingerprint.get(fingerprint);
      if (group && group.length) {
        for (const release of group) {
          if (release && release._seenFilterFingerprint) {
            expanded.add(release._seenFilterFingerprint);
          }
        }
      } else {
        expanded.add(fingerprint);
      }
    }

    return Array.from(expanded);
  }

  async function hideFingerprints(fingerprints) {
    if (!fingerprints.length) {
      updateStatus("没有选中结果");
      return;
    }

    const expandedFingerprints = expandFingerprintsWithDuplicates(fingerprints);
    const releases = expandedFingerprints
      .map(
        (fingerprint) =>
          state.releaseByFingerprint.get(fingerprint) ||
          rowReleaseByFingerprint.get(fingerprint)
      )
      .filter(Boolean);

    if (!releases.length) {
      updateStatus("没有找到可隐藏的选中结果");
      return;
    }

    const result = await servicePost("/api/hide", { releases });
    for (const fingerprint of expandedFingerprints) {
      state.selected.delete(fingerprint);
      state.currentPageActionHiddenFingerprints.add(fingerprint);
    }
    document.querySelectorAll('input[type="checkbox"]:checked').forEach((checkbox) => {
      if (!(checkbox instanceof HTMLInputElement) || checkbox.closest(".powerarr-plus-toolbar")) {
        return;
      }
      checkbox.checked = false;
    });
    const message = `已隐藏 ${result.hiddenCount || releases.length} 条，下次搜索时隐藏`;
    updateStatus(message);
    window.setTimeout(() => updateStatus(message), 0);
  }

  function currentPageHiddenFingerprints() {
    const fingerprints = new Set(state.lastServiceHiddenFingerprints);
    for (const fingerprint of state.currentPageActionHiddenFingerprints) {
      fingerprints.add(fingerprint);
    }

    return Array.from(fingerprints).filter(Boolean);
  }

  async function unhideCurrentPageHidden() {
    const fingerprints = currentPageHiddenFingerprints();
    if (!fingerprints.length) {
      updateStatus("本页没有已隐藏结果");
      return;
    }

    const hiddenByService = new Set(state.lastServiceHiddenFingerprints);
    const result = await servicePost("/api/unhide", { fingerprints });
    const unhidden = result.unhiddenCount || fingerprints.length;
    const unhiddenSet = new Set(fingerprints);
    const serviceUnhidden = fingerprints.filter((fingerprint) =>
      hiddenByService.has(fingerprint)
    ).length;

    state.lastServiceHiddenFingerprints = state.lastServiceHiddenFingerprints.filter(
      (fingerprint) => !unhiddenSet.has(fingerprint)
    );
    for (const fingerprint of unhiddenSet) {
      state.currentPageActionHiddenFingerprints.delete(fingerprint);
    }
    state.lastHiddenCount = Math.max(0, state.lastHiddenCount - serviceUnhidden);

    const message = `已取消本页已隐藏 ${unhidden} 条，下次搜索时显示`;
    updateStatus(message);
    window.setTimeout(() => updateStatus(message), 0);
  }

  function currentVisibleFingerprints() {
    const fingerprints = new Set(
      state.lastVisible
        .map((release) => release && release._seenFilterFingerprint)
        .filter(Boolean)
    );
    document
      .querySelectorAll("[data-powerarr-plus-fingerprint]")
      .forEach((row) => {
        if (row instanceof HTMLElement && row.style.display !== "none") {
          fingerprints.add(row.dataset.powerarrPlusFingerprint);
        }
      });

    return Array.from(fingerprints).filter(Boolean);
  }

  function checkedFingerprints() {
    const fingerprints = new Set(state.selected);
    nativeSelectionFingerprints().forEach((fingerprint) => fingerprints.add(fingerprint));

    document.querySelectorAll(".powerarr-plus-checkbox").forEach((checkbox) => {
      if (!checkbox || checkbox.checked !== true) {
        return;
      }

      const direct = checkbox.dataset.powerarrPlusFingerprint;
      if (direct) {
        fingerprints.add(direct);
        return;
      }

      const row = checkbox.closest("[data-powerarr-plus-fingerprint]");
      if (row instanceof HTMLElement && row.dataset.powerarrPlusFingerprint) {
        fingerprints.add(row.dataset.powerarrPlusFingerprint);
      }
    });

    return Array.from(fingerprints).filter(Boolean);
  }

  function makeButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await onClick();
      } catch (error) {
        updateStatus(`操作失败：${error.message || error}`);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function ensureToolbar() {
    if (!document.body) {
      return;
    }

    let created = false;
    if (!state.toolbar) {
      const toolbar = document.createElement("div");
      toolbar.className = "powerarr-plus-toolbar";

      const title = document.createElement("strong");
      title.textContent = "Seen Filter";
      toolbar.appendChild(title);

      toolbar.appendChild(
        makeButton("隐藏选中", async () => {
          await hideFingerprints(checkedFingerprints());
        })
      );

      toolbar.appendChild(
        makeButton("隐藏本页", async () => {
          const visibleFingerprints = currentVisibleFingerprints();
          if (window.confirm(`隐藏本页 ${visibleFingerprints.length} 条可见结果？`)) {
            await hideFingerprints(visibleFingerprints);
          }
        })
      );

      toolbar.appendChild(
        makeButton("取消本页已隐藏", async () => {
          await unhideCurrentPageHidden();
        })
      );

      const status = document.createElement("span");
      status.className = "powerarr-plus-status";
      toolbar.appendChild(status);

      state.toolbar = toolbar;
      state.statusEl = status;
      document.body.appendChild(toolbar);
      created = true;
    }

    placeToolbar();
    if (created) {
      updateStatus();
    }
  }

  function placeToolbar() {
    const toolbar = state.toolbar;
    if (!toolbar) {
      return;
    }

    if (toolbar.parentElement !== document.body) {
      document.body.appendChild(toolbar);
    }

    const donate = document.querySelector(
      'a[href*="prowlarr.com/donate"], a[href*="/donate"]'
    );
    if (donate instanceof HTMLElement) {
      const rect = donate.getBoundingClientRect();
      const width = toolbar.offsetWidth || 420;
      const height = toolbar.offsetHeight || 32;
      const left = Math.max(8, rect.left - width - 8);
      const top = Math.max(8, rect.top + (rect.height - height) / 2);
      toolbar.classList.remove("powerarr-plus-floating");
      toolbar.classList.add("powerarr-plus-anchored");
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
      return;
    }

    toolbar.classList.add("powerarr-plus-floating");
    toolbar.classList.remove("powerarr-plus-anchored");
    toolbar.style.left = "";
    toolbar.style.top = "";
    toolbar.style.right = "";
    toolbar.style.bottom = "";
  }

  function updateStatus(message) {
    if (!state.statusEl) {
      return;
    }

    if (message) {
      state.statusEl.textContent = message;
      return;
    }

    if (state.serviceOk === false) {
      state.statusEl.textContent = "过滤服务离线";
      return;
    }

    const selected = state.selected.size;
    const checked = checkedFingerprints().length;
    const hidden = state.lastHiddenCount;
    const deduped = state.lastDedupeHiddenCount;
    const total = state.lastTotal;
    const visible = state.lastVisible.length;
    const dedupeText = deduped > 0 ? `，已去重 ${deduped}` : "";
    state.statusEl.textContent =
      total > 0
        ? `结果 ${visible}/${total}，已过滤 ${hidden}${dedupeText}，已选 ${Math.max(selected, checked)}`
        : `等待搜索结果，已选 ${Math.max(selected, checked)}`;
  }

  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .powerarr-plus-toolbar {
        position: fixed;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: min(620px, calc(100vw - 32px));
        margin: 0 8px;
        padding: 3px 8px;
        border: 1px solid rgba(148, 163, 184, 0.55);
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.94);
        color: #e5e7eb;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .powerarr-plus-toolbar.powerarr-plus-anchored {
        bottom: auto;
        right: auto;
      }
      .powerarr-plus-toolbar.powerarr-plus-floating {
        right: 16px;
        bottom: 16px;
        margin: 0;
        padding: 8px 10px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
      }
      .powerarr-plus-toolbar button {
        border: 1px solid rgba(148, 163, 184, 0.55);
        border-radius: 4px;
        background: #1f2937;
        color: #f9fafb;
        cursor: pointer;
        font: inherit;
        padding: 2px 7px;
      }
      .powerarr-plus-toolbar button:hover {
        background: #374151;
      }
      .powerarr-plus-toolbar button:disabled {
        cursor: wait;
        opacity: 0.6;
      }
      .powerarr-plus-status {
        white-space: nowrap;
        color: #cbd5e1;
      }
      .powerarr-plus-cell {
        width: 30px;
        min-width: 30px;
        text-align: center;
        cursor: pointer;
      }
      .powerarr-plus-selected {
        background: rgba(59, 130, 246, 0.08);
      }
      .powerarr-plus-checkbox {
        width: 16px;
        height: 16px;
        margin: 0 6px;
        vertical-align: middle;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function startDomObserver() {
    const observer = new MutationObserver((mutations) => {
      if (
        state.toolbar &&
        mutations.every((mutation) => state.toolbar.contains(mutation.target))
      ) {
        return;
      }

      if (!state.toolbar) {
        ensureToolbar();
      } else {
        placeToolbar();
      }
      scheduleInjectCheckboxes();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", placeToolbar);
    window.addEventListener("scroll", placeToolbar, true);
  }

  installFetchHook();
  if (window.localStorage.getItem("powerarrPlusDisableXhrObserver") !== "1") {
    installXhrObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      addStyles();
      ensureToolbar();
      startDomObserver();
    });
  } else {
    addStyles();
    ensureToolbar();
    startDomObserver();
  }
})();
