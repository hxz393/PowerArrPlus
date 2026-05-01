  function prowlarrPersistedState() {
    try {
      const raw = window.localStorage.getItem("prowlarr");
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function activeReleaseFilterKey() {
    const persisted = prowlarrPersistedState();
    const key = persisted && persisted.releases && persisted.releases.selectedFilterKey;
    if (key === undefined || key === null || key === "" || key === "all") {
      return null;
    }

    return String(key);
  }

  function prowlarrApiRoot() {
    const root = window.Prowlarr && window.Prowlarr.apiRoot ? window.Prowlarr.apiRoot : "/api/v1";
    return `${window.Prowlarr && window.Prowlarr.urlBase ? window.Prowlarr.urlBase : ""}${root}`;
  }

  async function refreshCustomFilters(force = false) {
    const now = Date.now();
    if (!force && state.customFiltersLoadedAt && now - state.customFiltersLoadedAt < 60_000) {
      return state.customFilters;
    }
    if (state.customFiltersRequest) {
      return state.customFiltersRequest;
    }
    if (!window.Prowlarr || !window.Prowlarr.apiKey) {
      return state.customFilters;
    }

    state.customFiltersRequest = window
      .fetch(`${prowlarrApiRoot()}/customFilter`, {
        headers: {
          "X-Api-Key": window.Prowlarr.apiKey,
          Accept: "application/json",
        },
      })
      .then((response) => (response.ok ? response.json() : []))
      .then((filters) => {
        state.customFilters = Array.isArray(filters)
          ? filters.filter((filter) => filter && filter.type === "releases")
          : [];
        state.customFiltersLoadedAt = Date.now();
        return state.customFilters;
      })
      .catch(() => state.customFilters)
      .finally(() => {
        state.customFiltersRequest = null;
      });

    return state.customFiltersRequest;
  }

  function refreshCustomFiltersAndResync(force = false) {
    refreshCustomFilters(force).then(() => {
      syncResultRows();
      syncNativeSelectionControls();
      updateStatus();
    });
  }

  function rawFilterValues(value) {
    return Array.isArray(value) ? value : [value];
  }

  function releaseValueForFilter(release, key) {
    if (!release || !key) {
      return "";
    }
    if (key === "title") {
      return release.title || release.sortTitle || "";
    }
    if (key === "category") {
      return (release.categories || [])
        .map((category) => category && category.name)
        .filter(Boolean)
        .join(" ");
    }

    return release[key];
  }

  function numericComparable(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function releaseMatchesFilterValue(releaseValue, filterValue, type) {
    const itemText = comparableText(releaseValue);
    const filterText = comparableText(filterValue);
    const itemNumber = numericComparable(releaseValue);
    const filterNumber = numericComparable(filterValue);

    switch (type) {
      case "contains":
        return itemText.includes(filterText);
      case "doesNotContain":
      case "notContains":
      case "not_contains":
        return !itemText.includes(filterText);
      case "startsWith":
      case "starts_with":
        return itemText.startsWith(filterText);
      case "notStartsWith":
      case "not_starts_with":
        return !itemText.startsWith(filterText);
      case "endsWith":
      case "ends_with":
        return itemText.endsWith(filterText);
      case "notEndsWith":
      case "not_ends_with":
        return !itemText.endsWith(filterText);
      case "greaterThan":
      case "greater_than":
        return itemNumber !== null && filterNumber !== null && itemNumber > filterNumber;
      case "greaterThanOrEqual":
      case "greater_than_or_equal":
        return itemNumber !== null && filterNumber !== null && itemNumber >= filterNumber;
      case "lessThan":
      case "less_than":
        return itemNumber !== null && filterNumber !== null && itemNumber < filterNumber;
      case "lessThanOrEqual":
      case "less_than_or_equal":
        return itemNumber !== null && filterNumber !== null && itemNumber <= filterNumber;
      case "notEqual":
      case "not_equal":
        return itemText !== filterText;
      case "equal":
      default:
        return itemText === filterText;
    }
  }

  function releaseMatchesCustomFilter(release, customFilter) {
    const filters = Array.isArray(customFilter && customFilter.filters)
      ? customFilter.filters
      : [];
    return filters.every((filter) => {
      if (!filter || !filter.key) {
        return true;
      }

      const releaseValue = releaseValueForFilter(release, filter.key);
      const values = rawFilterValues(filter.value);
      const type = filter.type || "equal";

      if (
        type === "doesNotContain" ||
        type === "notContains" ||
        type === "not_contains" ||
        type === "notEqual" ||
        type === "not_equal" ||
        type === "notStartsWith" ||
        type === "not_starts_with" ||
        type === "notEndsWith" ||
        type === "not_ends_with"
      ) {
        return values.every((value) => releaseMatchesFilterValue(releaseValue, value, type));
      }

      return values.some((value) => releaseMatchesFilterValue(releaseValue, value, type));
    });
  }

  function activeFilteredReleases() {
    const key = activeReleaseFilterKey();
    if (!key) {
      return null;
    }

    const customFilter = state.customFilters.find((filter) => String(filter.id) === key);
    if (!customFilter) {
      return null;
    }

    return state.lastVisible.filter((release) =>
      releaseMatchesCustomFilter(release, customFilter)
    );
  }

  function quickFilterComparable(value) {
    return comparableText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function quickFilterNeedles() {
    const raw = String(state.quickFilterText || "").trim();
    if (!raw) {
      return { raw: "", normalized: "", terms: [] };
    }

    const normalized = quickFilterComparable(raw);
    return {
      raw: comparableText(raw),
      normalized,
      terms: normalized ? normalized.split(/\s+/).filter(Boolean) : [],
    };
  }

  function quickFilterReleaseText(release) {
    if (!release) {
      return "";
    }

    return [
      release.title,
      release.sortTitle,
      release.indexer,
      release.protocol,
      release.size,
      release.files,
      release.grabs,
      release.age,
      ...(release.categories || []).map((category) => category && category.name),
    ]
      .filter((value) => value !== undefined && value !== null)
      .join(" ");
  }

  function releaseMatchesQuickFilter(release, needles = quickFilterNeedles()) {
    if (!needles.raw && !needles.normalized && !needles.terms.length) {
      return true;
    }

    const rawText = comparableText(quickFilterReleaseText(release));
    if (needles.raw && rawText.includes(needles.raw)) {
      return true;
    }

    const normalizedText = quickFilterComparable(rawText);
    if (needles.normalized && normalizedText.includes(needles.normalized)) {
      return true;
    }

    return needles.terms.every((term) => normalizedText.includes(term));
  }

  function scopedVisibleReleases() {
    const customFiltered = activeFilteredReleases();
    const releases = customFiltered || state.lastVisible;
    const needles = quickFilterNeedles();
    return releases.filter((release) => releaseMatchesQuickFilter(release, needles));
  }

  function assignedVisibleReleaseFingerprints() {
    const fingerprints = [];
    const seen = new Set();
    for (const row of rowCandidates()) {
      const fingerprint = row.dataset.powerarrPlusFingerprint;
      if (!fingerprint || seen.has(fingerprint) || !isElementVisible(row)) {
        continue;
      }
      seen.add(fingerprint);
      fingerprints.push(fingerprint);
    }
    return fingerprints;
  }

  function parseNativeResultCount(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) {
      return null;
    }

    const patterns = [
      /找到\s*(\d+)\s*版本/,
      /选中\s*\d+\s*中的\s*(\d+)\s*版本/,
      /found\s*(\d+)\s*(?:release|result|version)s?/i,
      /(\d+)\s*(?:release|result|version)s?\s*found/i,
      /selected\s*\d+\s*of\s*(\d+)\s*(?:release|result|version)s?/i,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) {
        const count = Number(match[1]);
        return Number.isFinite(count) ? count : null;
      }
    }

    return null;
  }

  function nativeTableResultCount() {
    const selectors = [
      "#resultCount",
      "[class*='SearchFooter']",
      "[class*='searchFooter']",
      "[class*='Footer']",
      "[class*='footer']",
      "footer",
    ];
    const candidates = new Set();

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((element) => {
        if (element instanceof HTMLElement && !element.closest(".powerarr-plus-toolbar")) {
          candidates.add(element);
        }
      });
    }

    for (const element of candidates) {
      if (!isElementDisplayed(element)) {
        continue;
      }
      const text = element.textContent || "";
      if (text.length > 500) {
        continue;
      }
      const count = parseNativeResultCount(text);
      if (count !== null) {
        return count;
      }
    }

    if (state.lastVisible.length <= 250) {
      document.querySelectorAll("div, span").forEach((element) => {
        if (!(element instanceof HTMLElement) || element.closest(".powerarr-plus-toolbar")) {
          return;
        }
        const text = element.textContent || "";
        if (text.length <= 120 && parseNativeResultCount(text) !== null) {
          candidates.add(element);
        }
      });

      for (const element of candidates) {
        if (!isElementDisplayed(element)) {
          continue;
        }
        const text = element.textContent || "";
        if (text.length > 500) {
          continue;
        }
        const count = parseNativeResultCount(text);
        if (count !== null) {
          return count;
        }
      }
    }

    return null;
  }

  function nativeTableFilteredFingerprints(preferredFingerprints) {
    const nativeCount = nativeTableResultCount();
    if (nativeCount === null || nativeCount >= preferredFingerprints.length) {
      return null;
    }

    const assigned = assignedVisibleReleaseFingerprints();
    if (!assigned.length) {
      return [];
    }

    if (assigned.length <= nativeCount) {
      return assigned;
    }

    return assigned.slice(0, nativeCount);
  }

  function currentVisibleReleaseFingerprints() {
    const filtered = scopedVisibleReleases()
      .map((release) => release && release._seenFilterFingerprint)
      .filter(Boolean);

    const nativeFiltered = nativeTableFilteredFingerprints(filtered);
    if (nativeFiltered) {
      return nativeFiltered;
    }

    return filtered;
  }
