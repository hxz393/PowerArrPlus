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

  function rebuildReleaseIndex() {
    state.releaseByFingerprint = new Map();
    for (const release of state.lastAllVisible) {
      if (release && release._seenFilterFingerprint) {
        state.releaseByFingerprint.set(release._seenFilterFingerprint, release);
      }
    }
  }

  function removeFingerprintsFromCurrentResults(fingerprints, hiddenCount) {
    const hidden = new Set(fingerprints.filter(Boolean));
    if (!hidden.size || !state.lastAllVisible.length) {
      return 0;
    }

    const beforeVisible = state.lastVisible.length;
    state.lastAllVisible = state.lastAllVisible.filter((release) => {
      const fingerprint = release && release._seenFilterFingerprint;
      return !fingerprint || !hidden.has(fingerprint);
    });

    rebuildReleaseIndex();
    const deduped = dedupeReleases(state.lastAllVisible);
    rowReleaseByFingerprint.clear();
    state.lastVisible = deduped.visible;
    state.dedupeGroupByFingerprint = deduped.groupByFingerprint;
    state.lastDedupeHiddenCount = deduped.hidden.length;
    rebuildReleaseTitleIndex();
    state.lastHiddenCount += hiddenCount || hidden.size;
    return Math.max(0, beforeVisible - state.lastVisible.length);
  }

  function armCurrentSearchReplay(releases = state.lastVisible.slice()) {
    state.searchReplay = {
      visible: releases.slice(),
      expiresAt: Date.now() + 3000,
    };
  }

  function queryInputElement() {
    return document.querySelector('input[name="searchQuery"], #query');
  }

  function dispatchEnterSearch(input) {
    if (!(input instanceof HTMLElement)) {
      return;
    }

    input.focus();
    ["keydown", "keypress", "keyup"].forEach((type) => {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
  }

  function searchRefreshButton() {
    return (
      document.querySelector("#searchButton") ||
      document.querySelector('button[class*="SearchFooter-searchButton"]')
    );
  }

  function captureFocusedInput() {
    const element = document.activeElement;
    if (!(element instanceof HTMLInputElement)) {
      return null;
    }

    return {
      element,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
    };
  }

  function restoreFocusedInput(focusState, options = {}) {
    if (!focusState || !(focusState.element instanceof HTMLInputElement)) {
      return;
    }
    if (!document.contains(focusState.element)) {
      return;
    }

    focusState.element.focus({ preventScroll: true });
    if (
      options.restoreSelection !== false &&
      focusState.selectionStart !== null &&
      focusState.selectionEnd !== null &&
      typeof focusState.element.setSelectionRange === "function"
    ) {
      focusState.element.setSelectionRange(
        focusState.selectionStart,
        focusState.selectionEnd
      );
    }
  }

  function refreshCurrentSearchFromReplay(releases = state.lastVisible.slice(), options = {}) {
    const focusState = options.preserveFocus ? captureFocusedInput() : null;
    const restoreReplayFocus = () => {
      if (
        options.shouldRestoreFocus &&
        !options.shouldRestoreFocus(focusState)
      ) {
        return;
      }
      restoreFocusedInput(focusState, {
        restoreSelection: options.restoreSelection,
      });
    };

    armCurrentSearchReplay(releases);
    if (options.dispatchEnter !== false) {
      dispatchEnterSearch(queryInputElement());
    }
    restoreReplayFocus();

    const triggerReplaySearch = () => {
      if (!state.searchReplay) {
        restoreReplayFocus();
        return;
      }

      const button = searchRefreshButton();
      if (button instanceof HTMLElement && !button.disabled) {
        button.click();
      }
      restoreReplayFocus();
    };

    if (options.clickDelay === 0) {
      triggerReplaySearch();
    } else {
      window.setTimeout(triggerReplaySearch, 80);
    }

    window.setTimeout(() => {
      if (state.searchReplay) {
        state.searchReplay = null;
        scheduleInjectCheckboxes();
      }
      restoreReplayFocus();
    }, 3000);
  }

  function refreshCurrentSearchForQuickFilter(options = {}) {
    if (!state.lastVisible.length) {
      return;
    }

    rowReleaseByFingerprint.clear();
    refreshCurrentSearchFromReplay(scopedVisibleReleases(), {
      clickDelay: 0,
      dispatchEnter: false,
      preserveFocus: options.preserveFocus !== false,
    });
  }

  function applyQuickFilterValue(value, options = {}) {
    const next = String(value || "").trim();
    if (state.quickFilterText === next) {
      return;
    }

    state.quickFilterText = next;
    state.quickFilterDraft = next;
    state.searchReplay = null;
    state.transientStatusMessage = "";
    state.transientStatusUntil = 0;
    state.selected.clear();
    syncNativeSelectionControls();
    updateStatus();
    refreshCurrentSearchForQuickFilter(options);
  }

  function applyQuickFilter(options = {}) {
    applyQuickFilterValue(state.quickFilterDraft, options);
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
    const hiddenCount = result.hiddenCount || releases.length;
    for (const fingerprint of expandedFingerprints) {
      state.selected.delete(fingerprint);
      state.currentPageActionHiddenFingerprints.add(fingerprint);
    }
    removeFingerprintsFromCurrentResults(expandedFingerprints, hiddenCount);
    state.selected.clear();
    document.querySelectorAll('input[type="checkbox"]:checked').forEach((checkbox) => {
      if (!(checkbox instanceof HTMLInputElement) || checkbox.closest(".powerarr-plus-toolbar")) {
        return;
      }
      checkbox.checked = false;
    });
    syncNativeSelectionControls();
    refreshCurrentSearchFromReplay(scopedVisibleReleases());
    const message = `已隐藏 ${hiddenCount} 条，已从当前结果移除`;
    updateStatus(message);
    window.setTimeout(() => updateStatus(message), 0);
    window.setTimeout(() => updateStatus(message), 100);
    window.setTimeout(() => updateStatus(message), 250);
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
    window.setTimeout(() => updateStatus(message), 100);
    window.setTimeout(() => updateStatus(message), 250);
  }

  function currentVisibleFingerprints() {
    const fingerprints = new Set(currentVisibleReleaseFingerprints());
    document
      .querySelectorAll("[data-powerarr-plus-fingerprint]")
      .forEach((row) => {
        if (
          row instanceof HTMLElement &&
          isElementVisible(row) &&
          fingerprints.has(row.dataset.powerarrPlusFingerprint)
        ) {
          fingerprints.add(row.dataset.powerarrPlusFingerprint);
        }
      });

    return Array.from(fingerprints).filter(Boolean);
  }

  function checkedFingerprints() {
    const fingerprints = new Set(state.selected);

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
