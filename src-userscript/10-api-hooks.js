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
    rebuildReleaseTitleIndex();
    state.lastServiceHiddenFingerprints = serviceHidden
      .map((release) => release && (release.fingerprint || release._seenFilterFingerprint))
      .filter(Boolean);
    state.currentPageActionHiddenFingerprints.clear();
    state.selected.clear();
    state.lastHiddenCount = result.hiddenCount || 0;
    state.lastTotal = result.total || releases.length;
    updateStatus();
    refreshCustomFiltersAndResync();
    scheduleInjectCheckboxes();
    if (state.quickFilterText) {
      window.setTimeout(() => applyQuickFilter({ preserveFocus: false }), 250);
    }
    return {
      ...result,
      visible: deduped.visible,
      duplicateHidden: deduped.hidden,
      duplicateHiddenCount: deduped.hidden.length,
    };
  }

  function jsonSearchResponse(releases, status = 200, statusText = "OK") {
    return new Response(JSON.stringify(releases || []), {
      status,
      statusText,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }

  function consumeSearchReplay() {
    const replay = state.searchReplay;
    if (!replay) {
      return null;
    }
    if (Date.now() > replay.expiresAt) {
      state.searchReplay = null;
      return null;
    }

    state.searchReplay = null;
    return jsonSearchResponse(replay.visible);
  }

  function installFetchHook() {
    if (!window.fetch || window.fetch.__powerArrPlusSeenFilterInstalled) {
      return;
    }

    const nativeFetch = window.fetch.bind(window);
    const wrappedFetch = async function (input, init) {
      if (isGetRequest(input, init) && isSearchUrl(input)) {
        const replayResponse = consumeSearchReplay();
        if (replayResponse) {
          return replayResponse;
        }
      }

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
