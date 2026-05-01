  function comparableText(value) {
    return decodeHtmlEntities(value)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeHtmlEntities(value) {
    const text = String(value || "");
    if (!text.includes("&")) {
      return text;
    }
    if (htmlDecodeCache.has(text)) {
      return htmlDecodeCache.get(text);
    }

    htmlDecodeTextarea = htmlDecodeTextarea || document.createElement("textarea");
    htmlDecodeTextarea.innerHTML = text.replace(/&(\d+);/g, "&#$1;");
    const decoded = htmlDecodeTextarea.value;
    if (htmlDecodeCache.size > 4000) {
      htmlDecodeCache.clear();
    }
    htmlDecodeCache.set(text, decoded);
    return decoded;
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

  function compactDecimal(value) {
    return value.toFixed(1).replace(/\.0$/, "");
  }

  function sizeNeedles(size) {
    const cacheKey = String(size || "");
    if (sizeNeedleCache.has(cacheKey)) {
      return sizeNeedleCache.get(cacheKey);
    }

    const value = Number(size);
    if (!Number.isFinite(value) || value <= 0) {
      return [];
    }

    const needles = [];
    const units = [
      [1024 ** 4, "TiB"],
      [1024 ** 3, "GiB"],
      [1024 ** 2, "MiB"],
      [1024, "KiB"],
    ];
    for (const [divisor, label] of units) {
      if (value >= divisor) {
        needles.push(comparableText(`${compactDecimal(value / divisor)} ${label}`));
        needles.push(comparableText(`${compactDecimal(value / divisor)}${label}`));
        break;
      }
    }
    needles.push(comparableText(String(size)));
    const result = Array.from(new Set(needles.filter(Boolean)));
    if (sizeNeedleCache.size > 4000) {
      sizeNeedleCache.clear();
    }
    sizeNeedleCache.set(cacheKey, result);
    return result;
  }

  function rowHasNumberToken(rowText, value) {
    if (!hasStrictValue(value)) {
      return false;
    }

    const cacheKey = String(value).trim();
    let pattern = numberTokenRegexCache.get(cacheKey);
    if (!pattern) {
      const token = cacheKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(`(^|\\D)${token}(\\D|$)`);
      if (numberTokenRegexCache.size > 4000) {
        numberTokenRegexCache.clear();
      }
      numberTokenRegexCache.set(cacheKey, pattern);
    }
    return pattern.test(rowText);
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
