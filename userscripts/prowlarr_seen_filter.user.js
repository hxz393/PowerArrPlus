// ==UserScript==
// @name         PowerArrPlus - Prowlarr Seen Filter
// @namespace    local.powerarr-plus.prowlarr-seen-filter
// @version      0.1.4
// @description  Hide selected Prowlarr search results across future searches.
// @match        http://localhost:9696/*
// @match        http://127.0.0.1:9696/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SERVICE_ORIGIN =
    window.localStorage.getItem("powerarrPlusServiceOrigin") ||
    "http://127.0.0.1:17896";

  const state = {
    lastVisible: [],
    releaseByFingerprint: new Map(),
    selected: new Set(),
    lastHiddenCount: 0,
    lastTotal: 0,
    serviceOk: null,
    toolbar: null,
    statusEl: null,
    injectTimer: null,
  };

  const rowReleaseByFingerprint = new Map();

  function isSearchUrl(input) {
    try {
      const raw = typeof input === "string" ? input : input && input.url;
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
    state.lastVisible = Array.isArray(result.visible) ? result.visible : releases;
    state.releaseByFingerprint = new Map();
    for (const release of state.lastVisible) {
      if (release && release._seenFilterFingerprint) {
        state.releaseByFingerprint.set(release._seenFilterFingerprint, release);
      }
    }
    state.selected.clear();
    state.lastHiddenCount = result.hiddenCount || 0;
    state.lastTotal = result.total || releases.length;
    updateStatus();
    hideRowsForHiddenReleases(Array.isArray(result.hidden) ? result.hidden : []);
    scheduleInjectCheckboxes();
    return result;
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

    proto.open = function (method, url) {
      this.__powerArrPlusMethod = method;
      this.__powerArrPlusUrl = url;
      return nativeOpen.apply(this, arguments);
    };

    proto.send = function () {
      this.addEventListener("load", async () => {
        if (
          this.status < 200 ||
          this.status >= 300 ||
          String(this.__powerArrPlusMethod || "GET").toUpperCase() !== "GET" ||
          !isSearchUrl(this.__powerArrPlusUrl)
        ) {
          return;
        }

        try {
          const original = JSON.parse(this.responseText || "[]");
          if (Array.isArray(original)) {
            await filterReleases(original);
          }
        } catch (error) {
          state.serviceOk = false;
          updateStatus(`过滤服务不可用，显示原始结果：${error.message || error}`);
        }
      });
      return nativeSend.apply(this, arguments);
    };

    proto.__powerArrPlusSeenFilterInstalled = true;
  }

  function comparableText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function rowCandidates() {
    return Array.from(
      document.querySelectorAll("tr, [role='row'], div[class*='row'], div[class*='Row']")
    ).filter((row) => {
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
      return state.lastVisible.some((release) => {
        const title = comparableText(release.title || release.sortTitle);
        return title && text.includes(title);
      });
    });
  }

  function allResultRows() {
    return Array.from(
      document.querySelectorAll("tr, [role='row'], div[class*='row'], div[class*='Row']")
    ).filter((row) => row instanceof HTMLElement && !row.closest(".powerarr-plus-toolbar"));
  }

  function hideRowsForHiddenReleases(hiddenReleases) {
    if (!hiddenReleases.length) {
      return;
    }

    const hiddenTitles = hiddenReleases
      .map((release) => comparableText(release.title || release.sortTitle))
      .filter(Boolean);
    if (!hiddenTitles.length) {
      return;
    }

    for (const row of allResultRows()) {
      const rowText = comparableText(row.innerText || row.textContent || "");
      if (hiddenTitles.some((title) => rowText.includes(title))) {
        row.style.display = "none";
      }
    }
  }

  function findReleaseForRow(row, used) {
    const rowText = comparableText(row.innerText || row.textContent || "");
    let best = null;
    let bestLength = 0;

    for (const release of state.lastVisible) {
      const fingerprint = release._seenFilterFingerprint;
      if (!fingerprint || used.has(fingerprint)) {
        continue;
      }

      const title = comparableText(release.title || release.sortTitle);
      if (title && rowText.includes(title) && title.length > bestLength) {
        best = release;
        bestLength = title.length;
      }
    }

    return best;
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
      return;
    }

    let holder = row.querySelector(":scope > .powerarr-plus-cell");
    if (!holder) {
      holder = document.createElement("span");
      holder.className = "powerarr-plus-cell";
      row.insertBefore(holder, row.firstChild);
    }
    holder.replaceChildren(checkbox);
  }

  function injectCheckboxes() {
    if (!state.lastVisible.length) {
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
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          state.selected.add(fingerprint);
        } else {
          state.selected.delete(fingerprint);
        }
        updateStatus();
      });
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      checkbox.addEventListener("mousedown", (event) => {
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

  async function hideFingerprints(fingerprints) {
    if (!fingerprints.length) {
      updateStatus("没有选中结果");
      return;
    }

    const releases = fingerprints
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
    for (const fingerprint of fingerprints) {
      state.selected.delete(fingerprint);
      const row = document.querySelector(
        `[data-powerarr-plus-fingerprint="${CSS.escape(fingerprint)}"]`
      );
      if (row instanceof HTMLElement) {
        row.style.display = "none";
      }
    }
    updateStatus(`已隐藏 ${result.hiddenCount || releases.length} 条，重新搜索后不再显示`);
  }

  function currentVisibleFingerprints() {
    const fingerprints = new Set(state.releaseByFingerprint.keys());
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
    document.querySelectorAll(".powerarr-plus-checkbox:checked").forEach((checkbox) => {
      if (!(checkbox instanceof HTMLElement)) {
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
        makeButton("刷新勾选框", async () => {
          document
            .querySelectorAll("[data-powerarr-plus-fingerprint]")
            .forEach((row) => {
              row.removeAttribute("data-powerarr-plus-fingerprint");
              row.classList.remove("powerarr-plus-row");
              row.querySelectorAll(".powerarr-plus-cell").forEach((cell) => cell.remove());
            });
          injectCheckboxes();
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
    const hidden = state.lastHiddenCount;
    const total = state.lastTotal;
    const visible = state.lastVisible.length;
    state.statusEl.textContent =
      total > 0
        ? `结果 ${visible}/${total}，已过滤 ${hidden}，已选 ${selected}`
        : `等待搜索结果，已选 ${selected}`;
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
  if (window.localStorage.getItem("powerarrPlusEnableXhrObserver") === "1") {
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
