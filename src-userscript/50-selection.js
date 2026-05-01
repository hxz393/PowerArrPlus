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
    const data = releaseMatchData(release);
    const title = data.title;
    if (!title || !rowText.includes(title)) {
      return 0;
    }

    let score = title.length;
    const indexer = data.indexer;
    if (indexer && !rowText.includes(indexer)) {
      return 0;
    }
    if (indexer) {
      score += 1000 + indexer.length;
    }

    const sizeMatches = data.sizeNeedles.some((needle) => rowText.includes(needle));
    if (sizeMatches) {
      score += 500;
    }

    if (rowHasNumberToken(rowText, release.files)) {
      score += 250;
    }

    if (
      hasStrictValue(release.age) &&
      (rowText.includes(data.ageText) || rowHasNumberToken(rowText, release.age))
    ) {
      score += 150;
    }

    if (rowHasNumberToken(rowText, data.grabs)) {
      score += 100;
    }

    const protocol = data.protocol;
    if (protocol && rowText.includes(protocol)) {
      score += 50;
    }

    return score;
  }

  function findReleaseForRow(row, used, preferredFingerprint) {
    const rowText = resultText(row);
    let best = null;
    let bestScore = 0;

    for (const release of candidateReleasesForRow(row)) {
      const fingerprint = release._seenFilterFingerprint;
      if (!fingerprint || used.has(fingerprint)) {
        continue;
      }

      const score = releaseMatchScore(rowText, release);
      if (
        score > bestScore ||
        (score === bestScore &&
          score > 0 &&
          preferredFingerprint &&
          fingerprint === preferredFingerprint)
      ) {
        best = release;
        bestScore = score;
      }
    }

    return best;
  }

  function assignReleaseToRow(row, used) {
    const previousFingerprint = row.dataset.powerarrPlusFingerprint;
    const release = findReleaseForRow(row, used, previousFingerprint);
    if (!release || !release._seenFilterFingerprint) {
      delete row.dataset.powerarrPlusFingerprint;
      row.classList.remove("powerarr-plus-row", "powerarr-plus-selected");
      return null;
    }

    const fingerprint = release._seenFilterFingerprint;
    row.dataset.powerarrPlusFingerprint = fingerprint;
    rowReleaseByFingerprint.set(fingerprint, release);
    row.classList.add("powerarr-plus-row");

    row.querySelectorAll(".powerarr-plus-checkbox").forEach((checkbox) => {
      checkbox.dataset.powerarrPlusFingerprint = fingerprint;
      checkbox.checked = state.selected.has(fingerprint);
      checkbox.setAttribute("aria-checked", checkbox.checked ? "true" : "false");
    });

    used.add(fingerprint);
    return release;
  }

  function syncResultRows() {
    const used = new Set();
    for (const row of rowCandidates()) {
      assignReleaseToRow(row, used);
    }
  }

  function releaseRowForNativeCheckbox(checkbox) {
    let row = resultRowForElement(checkbox);
    if (looksLikeSelectAllText(checkboxIdentityText(checkbox))) {
      return null;
    }

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

  function isNativeSelectAllCheckbox(checkbox) {
    if (!(checkbox instanceof HTMLInputElement)) {
      return false;
    }
    if (checkbox.closest(".powerarr-plus-toolbar") || checkbox.classList.contains("powerarr-plus-checkbox")) {
      return false;
    }
    if (releaseRowForNativeCheckbox(checkbox)) {
      return false;
    }

    const directLabel = checkboxIdentityText(checkbox);
    if (looksLikeSelectAllText(directLabel)) {
      return true;
    }
    if (releaseRowForNativeCheckbox(checkbox)) {
      return false;
    }

    const headerLabel = comparableText(
      checkbox.closest("[role='columnheader'], th, [class*='Header'], [class*='header']")?.textContent
    );
    return looksLikeSelectAllText(headerLabel);
  }

  function setCurrentPageSelected(selected) {
    const fingerprints = currentVisibleReleaseFingerprints();
    for (const fingerprint of fingerprints) {
      if (selected && !state.currentPageActionHiddenFingerprints.has(fingerprint)) {
        state.selected.add(fingerprint);
      } else {
        state.selected.delete(fingerprint);
      }
    }
    syncNativeSelectionControls();
    updateStatus();
  }

  function toggleCurrentPageSelection() {
    const fingerprints = currentVisibleReleaseFingerprints();
    const selectable = fingerprints.filter(
      (fingerprint) => !state.currentPageActionHiddenFingerprints.has(fingerprint)
    );
    const allSelected =
      selectable.length > 0 && selectable.every((fingerprint) => state.selected.has(fingerprint));
    setCurrentPageSelected(!allSelected);
  }

  function nearestCheckboxContainer(checkbox) {
    if (!(checkbox instanceof HTMLInputElement)) {
      return null;
    }

    let current = checkbox.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 6) {
      if (
        current.matches(
          "label, [class*='CheckInput'], [class*='Checkbox'], [class*='VirtualTableSelect'], [role='gridcell'], [role='columnheader'], th"
        )
      ) {
        return current;
      }
      current = current.parentElement;
      depth += 1;
    }

    return checkbox.parentElement;
  }

  function nativeCheckboxVisualElements(checkbox) {
    const cached = nativeCheckboxVisualCache.get(checkbox);
    if (
      cached &&
      cached.elements.every((element) => element instanceof HTMLElement && document.contains(element))
    ) {
      return cached.elements;
    }

    const elements = new Set();
    const container = nearestCheckboxContainer(checkbox);
    if (container instanceof HTMLElement) {
      if (container.matches("[class*='CheckInput-input']")) {
        elements.add(container);
      }
      container.querySelectorAll("[class*='CheckInput-input']").forEach((element) => {
        if (element instanceof HTMLElement) {
          elements.add(element);
        }
      });
    }

    let current = checkbox.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 6) {
      Array.from(current.children).forEach((child) => {
        if (child instanceof HTMLElement && child.matches("[class*='CheckInput-input']")) {
          elements.add(child);
        }
      });
      current = current.parentElement;
      depth += 1;
    }

    const result = Array.from(elements);
    nativeCheckboxVisualCache.set(checkbox, { elements: result });
    return result;
  }

  function syncNativeCheckboxVisual(checkbox, selected, indeterminate = false) {
    if (!(checkbox instanceof HTMLInputElement)) {
      return;
    }

    const previous = nativeCheckboxStateCache.get(checkbox);
    if (
      previous &&
      previous.selected === selected &&
      previous.indeterminate === indeterminate &&
      checkbox.checked === selected &&
      checkbox.indeterminate === indeterminate &&
      !selected &&
      !indeterminate
    ) {
      return;
    }

    checkbox.setAttribute("aria-checked", indeterminate ? "mixed" : selected ? "true" : "false");
    if (
      !previous &&
      !selected &&
      !indeterminate &&
      checkbox.checked === false &&
      checkbox.indeterminate === false
    ) {
      nativeCheckboxStateCache.set(checkbox, { selected, indeterminate });
      return;
    }

    const container = nearestCheckboxContainer(checkbox);
    if (container instanceof HTMLElement) {
      container.classList.toggle("powerarr-plus-native-checked", selected);
      container.classList.toggle("powerarr-plus-native-indeterminate", indeterminate);
    }

    nativeCheckboxVisualElements(checkbox).forEach((element) => {
      element.classList.toggle("powerarr-plus-native-checked", selected);
      element.classList.toggle("powerarr-plus-native-indeterminate", indeterminate);
    });
    nativeCheckboxStateCache.set(checkbox, { selected, indeterminate });
  }

  function syncNativeSelectionControls() {
    if (state.searchInFlight) {
      return;
    }

    syncResultRows();
    const fingerprints = currentVisibleReleaseFingerprints().filter(
      (fingerprint) => !state.currentPageActionHiddenFingerprints.has(fingerprint)
    );
    const selectedCount = fingerprints.filter((fingerprint) => state.selected.has(fingerprint)).length;
    const allSelected = fingerprints.length > 0 && selectedCount === fingerprints.length;
    const partlySelected = selectedCount > 0 && !allSelected;

    document.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      if (!(checkbox instanceof HTMLInputElement)) {
        return;
      }
      if (checkbox.closest(".powerarr-plus-toolbar") || checkbox.classList.contains("powerarr-plus-checkbox")) {
        return;
      }
      if (isNativeSelectAllCheckbox(checkbox)) {
        checkbox.checked = allSelected;
        checkbox.indeterminate = partlySelected;
        syncNativeCheckboxVisual(checkbox, allSelected, partlySelected);
        return;
      }

      const row = releaseRowForNativeCheckbox(checkbox);
      if (!(row instanceof HTMLElement)) {
        return;
      }

      const fingerprint = row.dataset.powerarrPlusFingerprint;
      if (!fingerprint) {
        return;
      }

      const selected =
        state.selected.has(fingerprint) &&
        !state.currentPageActionHiddenFingerprints.has(fingerprint);
      checkbox.checked = selected;
      checkbox.indeterminate = false;
      syncNativeCheckboxVisual(checkbox, selected, false);
      row.classList.toggle("powerarr-plus-selected", selected);
    });
  }

  function bindNativeSelectionControls() {
    if (state.searchInFlight) {
      return;
    }

    installNativeSelectionInterceptor();
    document.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      if (!(checkbox instanceof HTMLInputElement)) {
        return;
      }
      if (checkbox.closest(".powerarr-plus-toolbar") || checkbox.classList.contains("powerarr-plus-checkbox")) {
        return;
      }
      const isSelectAll = isNativeSelectAllCheckbox(checkbox);
      if (!isSelectAll && !releaseRowForNativeCheckbox(checkbox)) {
        return;
      }
      if (checkbox.dataset.powerarrPlusNativeBound === "1") {
        return;
      }

      checkbox.dataset.powerarrPlusNativeBound = "1";
      const handleEvent = (event) => handleNativeCheckboxSelection(checkbox, event);
      ["pointerdown", "mousedown", "click", "input", "change"].forEach((eventName) => {
        checkbox.addEventListener(eventName, handleEvent, true);
      });
    });
  }

  function nativeCheckboxFromEvent(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return null;
    }
    let checkbox = target.closest('input[type="checkbox"]');
    let wrapper = null;
    if (!(checkbox instanceof HTMLInputElement)) {
      wrapper = target.closest("label, [class*='CheckInput'], [class*='Checkbox'], [class*='Check'], [class*='check']");
      checkbox = wrapper && wrapper.querySelector('input[type="checkbox"]');
    }
    if (!(checkbox instanceof HTMLInputElement) && wrapper) {
      let current = wrapper.parentElement;
      let depth = 0;
      while (!(checkbox instanceof HTMLInputElement) && current && depth < 6) {
        checkbox = current.querySelector('input[type="checkbox"]');
        current = current.parentElement;
        depth += 1;
      }
    }
    if (!(checkbox instanceof HTMLInputElement)) {
      return null;
    }
    if (checkbox.closest(".powerarr-plus-toolbar") || checkbox.classList.contains("powerarr-plus-checkbox")) {
      return null;
    }
    return checkbox;
  }

  function installNativeSelectionInterceptor() {
    if (state.nativeSelectionInterceptorInstalled) {
      return;
    }
    if (!document.documentElement) {
      document.addEventListener("DOMContentLoaded", installNativeSelectionInterceptor, { once: true });
      return;
    }

    const handleNativeCheckboxEvent = (event) => {
      const checkbox = nativeCheckboxFromEvent(event);
      if (!checkbox) {
        return;
      }

      handleNativeCheckboxSelection(checkbox, event);
    };

    ["pointerdown", "mousedown", "click", "input", "change"].forEach((eventName) => {
      window.addEventListener(eventName, handleNativeCheckboxEvent, true);
      document.addEventListener(eventName, handleNativeCheckboxEvent, true);
      document.documentElement.addEventListener(eventName, handleNativeCheckboxEvent, true);
    });
    state.nativeSelectionInterceptorInstalled = true;
  }

  function handleNativeCheckboxSelection(checkbox, event) {
    if (!(checkbox instanceof HTMLInputElement)) {
      return;
    }
    if (
      (event.type === "pointerdown" || event.type === "mousedown") &&
      typeof event.button === "number" &&
      event.button !== 0
    ) {
      return;
    }
    if (state.searchInFlight) {
      return;
    }

    syncResultRows();
    const isSelectAll = isNativeSelectAllCheckbox(checkbox);
    const row = isSelectAll ? null : releaseRowForNativeCheckbox(checkbox);
    if (!isSelectAll && !(row instanceof HTMLElement)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    const fingerprint = isSelectAll ? "__powerarr_plus_select_all__" : row.dataset.powerarrPlusFingerprint;
    const now = Date.now();
    if (
      fingerprint &&
      state.lastNativeSelectionKey === fingerprint &&
      now - state.lastNativeSelectionAt < 250
    ) {
      if (!isSelectAll && row instanceof HTMLElement) {
        const selected =
          state.selected.has(fingerprint) &&
          !state.currentPageActionHiddenFingerprints.has(fingerprint);
        checkbox.checked = selected;
        checkbox.indeterminate = false;
        syncNativeCheckboxVisual(checkbox, selected, false);
        row.classList.toggle("powerarr-plus-selected", selected);
      }
      return;
    }
    state.lastNativeSelectionKey = fingerprint || "";
    state.lastNativeSelectionAt = now;

    if (isSelectAll) {
      toggleCurrentPageSelection();
    } else if (fingerprint) {
      if (state.selected.has(fingerprint)) {
        state.selected.delete(fingerprint);
      } else if (!state.currentPageActionHiddenFingerprints.has(fingerprint)) {
        state.selected.add(fingerprint);
      }
      syncNativeSelectionControls();
      updateStatus();
    }

    window.setTimeout(syncNativeSelectionControls, 0);
    window.setTimeout(syncNativeSelectionControls, 50);
  }

  function hasNativeSelectionControls() {
    if (state.searchInFlight) {
      return false;
    }

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
    if (state.searchInFlight) {
      return;
    }
    if (!state.lastVisible.length) {
      return;
    }

    syncResultRows();
    bindNativeSelectionControls();
    if (hasNativeSelectionControls()) {
      syncNativeSelectionControls();
      updateStatus();
      return;
    }

    const used = new Set();
    for (const row of rowCandidates()) {
      const release = assignReleaseToRow(row, used);
      if (!release || !release._seenFilterFingerprint) {
        continue;
      }

      const fingerprint = row.dataset.powerarrPlusFingerprint;
      if (row.querySelector(":scope .powerarr-plus-checkbox")) {
        continue;
      }

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
    state.injectTimer = window.setTimeout(injectCheckboxes, 50);
  }
