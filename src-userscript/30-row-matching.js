  function releaseMatchData(release) {
    if (!release) {
      return {
        title: "",
        sortTitle: "",
        indexer: "",
        protocol: "",
        sizeNeedles: [],
        ageText: "",
        grabs: 0,
      };
    }
    const cached = releaseMatchCache.get(release);
    if (cached) {
      return cached;
    }

    const data = {
      title: comparableText(release.title || release.sortTitle),
      sortTitle: comparableText(release.sortTitle || release.title),
      indexer: comparableText(release.indexer),
      protocol: comparableText(release.protocol),
      sizeNeedles: sizeNeedles(release.size),
      ageText: hasStrictValue(release.age) ? comparableText(`${release.age} days`) : "",
      grabs: numericGrabs(release),
    };
    releaseMatchCache.set(release, data);
    return data;
  }

  function releaseTitleKeys(release) {
    const data = releaseMatchData(release);
    return Array.from(new Set([data.title, data.sortTitle].filter(Boolean)));
  }

  function addReleaseTitleIndex(key, release) {
    if (!key) {
      return;
    }
    if (!state.releaseByTitleKey.has(key)) {
      state.releaseByTitleKey.set(key, []);
    }
    state.releaseByTitleKey.get(key).push(release);
  }

  function rebuildReleaseTitleIndex() {
    state.releaseByTitleKey = new Map();
    for (const release of state.lastVisible) {
      for (const key of releaseTitleKeys(release)) {
        addReleaseTitleIndex(key, release);
      }
    }
  }

  function cachedRowComparableText(row) {
    if (!(row instanceof HTMLElement)) {
      return "";
    }

    const raw = row.textContent || "";
    const cached = rowTextCache.get(row);
    if (cached && cached.raw === raw) {
      return cached.text;
    }

    const text = comparableText(raw);
    rowTextCache.set(row, { raw, text });
    return text;
  }

  function rowTitleKeys(row) {
    if (!(row instanceof HTMLElement)) {
      return [];
    }

    const keys = [];
    row.querySelectorAll("a[href]").forEach((anchor) => {
      const key = comparableText(anchor.textContent || "");
      if (key) {
        keys.push(key);
      }
    });

    const aria = comparableText(row.getAttribute("aria-label") || row.title || "");
    if (aria) {
      keys.push(aria);
    }

    return Array.from(new Set(keys));
  }

  function candidateReleasesForRow(row) {
    const direct = [];
    const seen = new Set();

    for (const key of rowTitleKeys(row)) {
      const matches = state.releaseByTitleKey.get(key);
      if (!matches) {
        continue;
      }
      for (const release of matches) {
        const fingerprint = release && release._seenFilterFingerprint;
        if (!fingerprint || seen.has(fingerprint)) {
          continue;
        }
        seen.add(fingerprint);
        direct.push(release);
      }
    }

    if (direct.length) {
      return direct;
    }

    if (state.lastVisible.length > 250 && row.querySelector("a[href]")) {
      return [];
    }
    return state.lastVisible;
  }

  function rowCandidates() {
    return resultElements().filter((row) => {
      if (!(row instanceof HTMLElement)) {
        return false;
      }
      if (row.closest(".powerarr-plus-toolbar")) {
        return false;
      }
      const text = cachedRowComparableText(row);
      if (!text || text.length < 8) {
        return false;
      }
      return candidateReleasesForRow(row).some(
        (release) => releaseMatchScore(text, release) > 0
      );
    });
  }

  function resultRowForElement(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return element.closest(RESULT_ELEMENT_SELECTOR);
  }

  function checkboxIdentityText(checkbox) {
    return comparableText(
      [
        checkbox.name,
        checkbox.id,
        checkbox.getAttribute("aria-label"),
        checkbox.title,
      ].join(" ")
    );
  }

  function looksLikeSelectAllText(text) {
    return /\bselectall\b/.test(text) || text.includes("select all") || text.includes("全选");
  }

  function resultText(element) {
    return cachedRowComparableText(element);
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isElementDisplayed(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
