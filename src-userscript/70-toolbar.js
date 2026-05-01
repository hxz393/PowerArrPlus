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

  function makeQuickFilterInput() {
    const input = document.createElement("input");
    input.type = "search";
    input.className = "powerarr-plus-quick-filter";
    input.placeholder = "快筛结果";
    input.title = "输入关键字即时过滤当前搜索结果，清空恢复";
    input.setAttribute("aria-label", "PowerArrPlus 快速过滤");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = state.quickFilterDraft || state.quickFilterText;
    input.addEventListener("input", () => {
      state.quickFilterDraft = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyQuickFilter({ preserveFocus: true });
      }
      if (event.key === "Escape") {
        input.value = "";
        state.quickFilterDraft = "";
        applyQuickFilter({ preserveFocus: true });
      }
      event.stopPropagation();
    });
    ["click", "pointerdown", "mousedown"].forEach((eventName) => {
      input.addEventListener(eventName, (event) => {
        event.stopPropagation();
      });
    });
    return input;
  }

  function quickFilterInputElement() {
    return state.toolbar && state.toolbar.querySelector(".powerarr-plus-quick-filter");
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

      toolbar.appendChild(makeQuickFilterInput());

      toolbar.appendChild(
        makeButton("筛选", async () => {
          const input = quickFilterInputElement();
          if (input instanceof HTMLInputElement) {
            state.quickFilterDraft = input.value;
          }
          applyQuickFilter({ preserveFocus: false });
        })
      );

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
      state.transientStatusMessage = message;
      state.transientStatusUntil = Date.now() + 1500;
      state.statusEl.textContent = message;
      return;
    }

    if (state.transientStatusMessage && Date.now() < state.transientStatusUntil) {
      state.statusEl.textContent = state.transientStatusMessage;
      return;
    }
    state.transientStatusMessage = "";
    state.transientStatusUntil = 0;

    if (state.serviceOk === false) {
      state.statusEl.textContent = "过滤服务离线";
      return;
    }

    if (state.searchInFlight) {
      state.statusEl.textContent = "搜索中";
      return;
    }

    const selected = state.selected.size;
    const checked = checkedFingerprints().length;
    const hidden = state.lastHiddenCount;
    const deduped = state.lastDedupeHiddenCount;
    const total = state.lastTotal;
    const visible = currentVisibleReleaseFingerprints().length;
    const dedupeText = deduped > 0 ? `，已去重 ${deduped}` : "";
    const quickText = state.quickFilterText ? `，快筛 ${visible}` : "";
    state.statusEl.textContent =
      total > 0
        ? `结果 ${visible}/${total}，已过滤 ${hidden}${dedupeText}${quickText}，已选 ${Math.max(selected, checked)}`
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
        width: min(880px, calc(100vw - 32px));
        max-width: calc(100vw - 32px);
        box-sizing: border-box;
        margin: 0;
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
        padding: 8px 10px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
      }
      .powerarr-plus-toolbar strong {
        flex: 0 0 auto;
      }
      .powerarr-plus-toolbar button {
        flex: 0 0 auto;
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
      .powerarr-plus-quick-filter {
        flex: 0 0 150px;
        width: 150px;
        min-width: 110px;
        height: 24px;
        border: 1px solid rgba(148, 163, 184, 0.6);
        border-radius: 4px;
        background: #0f172a;
        color: #f8fafc;
        font: inherit;
        padding: 2px 7px;
        outline: none;
      }
      .powerarr-plus-quick-filter:focus {
        border-color: #60a5fa;
        box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.4);
      }
      .powerarr-plus-quick-filter::placeholder {
        color: #94a3b8;
      }
      .powerarr-plus-status {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
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
      .powerarr-plus-native-checked[class*='CheckInput-input'],
      .powerarr-plus-native-indeterminate[class*='CheckInput-input'] {
        background-color: #5aa1f2 !important;
        border-color: #5aa1f2 !important;
        position: relative;
      }
      .powerarr-plus-native-checked[class*='CheckInput-input']::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 46%;
        width: 6px;
        height: 11px;
        border: solid #fff;
        border-width: 0 2px 2px 0;
        box-sizing: border-box;
        transform: translate(-50%, -55%) rotate(45deg);
      }
      .powerarr-plus-native-indeterminate[class*='CheckInput-input']::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 12px;
        height: 2px;
        background: #fff;
        transform: translate(-50%, -50%);
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
