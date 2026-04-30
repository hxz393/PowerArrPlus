const fs = require("node:fs");
const path = require("node:path");

const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(playwrightModule);

const ROOT = path.resolve(__dirname, "..");
const USERSCRIPT_PATH = path.join(ROOT, "userscripts", "prowlarr_seen_filter.user.js");
const PROWLARR_URL = process.env.PROWLARR_URL || "http://localhost:9696/search";
const QUERY =
  process.env.PROWLARR_QUERY || "Vaxxed.From.Cover-Up.to.Catastrophe.2016";
const SERVICE_ORIGIN = "http://127.0.0.1:18081";

const userscript = fs.readFileSync(USERSCRIPT_PATH, "utf8");
const hiddenFingerprints = new Set();
const filterCalls = [];
const hideCalls = [];

function fingerprintRelease(release) {
  return `real-smoke:${release.indexerId || ""}:${release.guid || release.title || ""}`;
}

function jsonResponse(payload) {
  return {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };
}

function visibleResultCountScript() {
  const candidates = Array.from(document.querySelectorAll("[role='gridcell'], tr"));
  return candidates.filter((element) => {
    if (element.closest(".powerarr-plus-toolbar")) {
      return false;
    }
    const text = (element.innerText || element.textContent || "").trim();
    if (!text || !element.querySelector('input[type="checkbox"]')) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }).length;
}

function dedupeCountFromStatus(text) {
  const match = String(text || "").match(/已去重\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function visibleCountFromStatus(text) {
  const match = String(text || "").match(/结果\s+(\d+)\s*\//);
  return match ? Number(match[1]) : 0;
}

function searchRequestCount(requests) {
  return requests.filter(
    (entry) => entry.startsWith("REQ ") && entry.includes("/api/v1/search")
  ).length;
}

async function waitForSelectedNativeVisual(page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("[class*='CheckInput-input']")).some(
        (element) =>
          element instanceof HTMLElement &&
          Boolean(element.offsetParent) &&
          element.classList.contains("powerarr-plus-native-checked")
      ),
    null,
    { timeout: 30000 }
  );
}

function isTrackedRequestUrl(url) {
  return (
    url.includes("/api/v1/search") ||
    url.includes("/api/filter") ||
    url.includes("/api/hide") ||
    url.includes("/api/unhide")
  );
}

function virtualRowGapStatsScript() {
  const rows = Array.from(document.querySelectorAll("[role='gridcell']"))
    .filter((element) => {
      if (element.closest(".powerarr-plus-toolbar")) {
        return false;
      }
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.position === "absolute"
      );
    })
    .map((element) => {
      const style = window.getComputedStyle(element);
      return {
        top: Number.parseFloat(element.style.top || style.top || "0"),
        height: Number.parseFloat(element.style.height || style.height || "0"),
      };
    })
    .filter((row) => Number.isFinite(row.top) && Number.isFinite(row.height));

  rows.sort((left, right) => left.top - right.top);
  const rowHeight = rows.find((row) => row.height > 0)?.height || 38;
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    gaps.push(rows[index].top - rows[index - 1].top - rowHeight);
  }

  return {
    count: rows.length,
    maxGap: gaps.length ? Math.max(...gaps) : 0,
    tops: rows.slice(0, 12).map((row) => row.top),
  };
}

function assertNoVirtualRowGaps(stats, label) {
  if (stats.count > 1 && stats.maxGap > 1) {
    throw new Error(`${label} still has virtual row gaps: ${JSON.stringify(stats)}`);
  }
}

function firstSelectableResultScript() {
  const allRows = Array.from(document.querySelectorAll("[role='gridcell'], tr"));
  const rows = allRows.filter(
    (row) =>
      !row.closest(".powerarr-plus-toolbar") &&
      row.querySelector('input[type="checkbox"]') &&
      row.querySelector("a[href]") &&
      (row.innerText || row.textContent || "").trim()
  );
  const row = rows.find((candidate) => {
    const checkbox = candidate.querySelector('input[type="checkbox"]');
    return checkbox && !checkbox.checked;
  });
  if (!row) {
    return null;
  }

  const checkbox = row.querySelector('input[type="checkbox"]');
  const link = row.querySelector("a[href]");
  const title = (link?.innerText || link?.textContent || row.innerText || "").trim();
  return {
    index: allRows.indexOf(row),
    checkboxName: checkbox.name || "",
    title,
    text: (row.innerText || row.textContent || "").trim(),
  };
}

function quickFilterNeedleFromTitle(title) {
  const fallback = String(title || "").trim().slice(0, 24);
  const token = String(title || "")
    .split(/[\s._()[\]{}+\-]+/)
    .find((part) => part.length >= 6 && !/^\d+$/.test(part));
  return token || fallback;
}

async function clickFirstSelectableResult(page) {
  const result = await page.evaluate(firstSelectableResultScript);
  if (!result) {
    return null;
  }

  await page
    .locator("[role='gridcell'], tr")
    .nth(result.index)
    .locator('input[type="checkbox"]')
    .first()
    .click({ force: true });
  return result;
}

function scrollSearchResultsScript() {
  const firstRow = document.querySelector("[role='gridcell']");
  let current = firstRow && firstRow.parentElement;
  while (current && current !== document.body) {
    if (current.scrollHeight > current.clientHeight + 120) {
      current.scrollTop = Math.min(
        current.scrollHeight - current.clientHeight,
        current.scrollTop + Math.max(500, current.clientHeight)
      );
      return { scrolled: true, target: current.className || current.tagName };
    }
    current = current.parentElement;
  }

  const fallback = document.scrollingElement || document.documentElement;
  fallback.scrollTop = Math.min(
    fallback.scrollHeight - fallback.clientHeight,
    fallback.scrollTop + Math.max(500, fallback.clientHeight)
  );
  return { scrolled: true, target: "document" };
}

async function runSearch(page) {
  const queryInput = page.locator('input[name="searchQuery"]');
  const searchButton = page.locator('button[class*="SearchFooter-searchButton"]').first();
  await queryInput.waitFor({ state: "visible", timeout: 30000 });
  await searchButton.waitFor({ state: "visible", timeout: 30000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const searchResponse = page
      .waitForResponse(
        (response) => response.url().includes("/api/v1/search"),
        { timeout: 90000 }
      )
      .catch(() => null);
    const searchRequest = page
      .waitForRequest(
        (request) => request.url().includes("/api/v1/search"),
        { timeout: 3000 }
      )
      .catch(() => null);

    await queryInput.fill("");
    await queryInput.fill(QUERY);

    if (!(await searchRequest)) {
      await page.waitForFunction(
        () => {
          const button = document.querySelector('button[class*="SearchFooter-searchButton"]');
          return button && !button.disabled;
        },
        null,
        { timeout: 90000 }
      );
      await searchButton.click();
    }

    if (await searchResponse) {
      return;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error("Prowlarr search request was not sent after clicking the real search button");
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  await context.route(`${SERVICE_ORIGIN}/api/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
      return;
    }

    const url = new URL(request.url());
    const payload = JSON.parse(request.postData() || "{}");

    if (url.pathname === "/api/filter") {
      const releases = (payload.releases || []).map((release) => ({
        ...release,
        _seenFilterFingerprint: fingerprintRelease(release),
      }));
      const hidden = releases.filter((release) =>
        hiddenFingerprints.has(release._seenFilterFingerprint)
      );
      const visible = releases.filter(
        (release) => !hiddenFingerprints.has(release._seenFilterFingerprint)
      );
      filterCalls.push({
        input: releases.length,
        visible: visible.length,
        hidden: hidden.length,
        hiddenStored: hiddenFingerprints.size,
      });
      await route.fulfill(
        jsonResponse({
          ok: true,
          total: releases.length,
          visible,
          hidden,
          hiddenCount: hidden.length,
        })
      );
      return;
    }

    if (url.pathname === "/api/hide") {
      const releases = payload.releases || [];
      hideCalls.push(
        releases.map((release) => ({
          title: release.title,
          indexer: release.indexer,
          fingerprint: release._seenFilterFingerprint || fingerprintRelease(release),
        }))
      );
      releases.forEach((release) => {
        hiddenFingerprints.add(
          release._seenFilterFingerprint || fingerprintRelease(release)
        );
      });
      await route.fulfill(jsonResponse({ ok: true, hiddenCount: releases.length }));
      return;
    }

    if (url.pathname === "/api/unhide") {
      const fingerprints = payload.fingerprints || [];
      fingerprints.forEach((fingerprint) => hiddenFingerprints.delete(fingerprint));
      await route.fulfill(jsonResponse({ ok: true, unhiddenCount: fingerprints.length }));
      return;
    }

    await route.fulfill(jsonResponse({ ok: true }));
  });

  await context.addInitScript({
    content: `
      window.localStorage.setItem("powerarrPlusServiceOrigin", "${SERVICE_ORIGIN}");
      ${userscript}
    `,
  });

  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (isTrackedRequestUrl(url)) {
      requests.push(`REQ ${request.method()} ${url}`);
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (isTrackedRequestUrl(url)) {
      requests.push(`RES ${response.status()} ${url}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (isTrackedRequestUrl(url)) {
      requests.push(`FAILED ${request.failure()?.errorText || ""} ${url}`);
    }
  });

  try {
    await page.goto(PROWLARR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await runSearch(page);
    await page.waitForFunction(
      () => document.querySelectorAll("[role='gridcell'] input[type='checkbox']").length > 1,
      null,
      { timeout: 90000 }
    );
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("结果"),
      null,
      { timeout: 30000 }
    );
    await page.waitForFunction(
      () => /已去重 [1-9]\d*/.test(
        document.querySelector(".powerarr-plus-status")?.textContent || ""
      ),
      null,
      { timeout: 30000 }
    );

    const injectedCheckboxes = await page.locator(".powerarr-plus-checkbox").count();
    const injectedCells = await page.locator(".powerarr-plus-cell").count();
    if (injectedCheckboxes !== 0 || injectedCells !== 0) {
      throw new Error(
        `expected native Prowlarr checkboxes only, got injectedCheckboxes=${injectedCheckboxes}, injectedCells=${injectedCells}`
      );
    }

    const beforeVisible = await page.evaluate(visibleResultCountScript);
    if (beforeVisible < 2) {
      throw new Error(`expected at least two visible real results, got ${beforeVisible}`);
    }
    const initialStatus = await page.locator(".powerarr-plus-status").textContent();
    const initialDedupeHidden = dedupeCountFromStatus(initialStatus);
    const initialVisibleCount = visibleCountFromStatus(initialStatus);
    if (initialDedupeHidden < 1) {
      throw new Error(`expected real search to hide duplicate groups, got status=${initialStatus}`);
    }
    const initialGapStats = await page.evaluate(virtualRowGapStatsScript);
    assertNoVirtualRowGaps(initialGapStats, "initial filtered results");

    const quickFilterProbe = await page.evaluate(firstSelectableResultScript);
    if (!quickFilterProbe) {
      throw new Error("expected a selectable result before quick filter probe");
    }
    const quickFilterNeedle = quickFilterNeedleFromTitle(quickFilterProbe.title);
    const searchRequestsBeforeQuickFilter = searchRequestCount(requests);
    const quickFilterInput = page.locator(".powerarr-plus-quick-filter");
    const slowNeedle = quickFilterNeedle.slice(0, Math.min(4, quickFilterNeedle.length));
    await quickFilterInput.fill("");
    await quickFilterInput.type(slowNeedle, { delay: 2000 });
    await page.waitForTimeout(500);
    const realSlowTypeUi = await page.evaluate(() => {
      const input = document.querySelector(".powerarr-plus-quick-filter");
      return {
        active: document.activeElement === input,
        selectionStart: input?.selectionStart,
        selectionEnd: input?.selectionEnd,
        valueLength: input?.value.length,
        value: input?.value,
        status: document.querySelector(".powerarr-plus-status")?.textContent || "",
      };
    });
    if (
      realSlowTypeUi.value !== slowNeedle ||
      !realSlowTypeUi.active ||
      realSlowTypeUi.selectionStart !== realSlowTypeUi.valueLength ||
      realSlowTypeUi.selectionEnd !== realSlowTypeUi.valueLength ||
      /快筛\s+\d+/.test(realSlowTypeUi.status)
    ) {
      throw new Error(
        `real quick filter slow typing should not apply before pressing filter, got ${JSON.stringify(realSlowTypeUi)}`
      );
    }
    await quickFilterInput.fill(quickFilterNeedle);
    await quickFilterInput.press("Enter");
    await page.waitForFunction(
      () => {
        const status = document.querySelector(".powerarr-plus-status")?.textContent || "";
        return /快筛\s+[1-9]\d*/.test(status) && /结果\s+[1-9]\d*\//.test(status);
      },
      null,
      { timeout: 30000 }
    );
    const quickFilterVisible = await page.evaluate(visibleResultCountScript);
    if (quickFilterVisible < 1 || quickFilterVisible > beforeVisible) {
      throw new Error(
        `quick filter should narrow visible real rows, before=${beforeVisible}, after=${quickFilterVisible}, needle=${quickFilterNeedle}`
      );
    }
    const searchRequestsAfterQuickFilter = searchRequestCount(requests);
    if (searchRequestsAfterQuickFilter !== searchRequestsBeforeQuickFilter) {
      throw new Error(
        `quick filter should not call the real Prowlarr search API: before=${searchRequestsBeforeQuickFilter}, after=${searchRequestsAfterQuickFilter}`
      );
    }
    await page.locator(".powerarr-plus-quick-filter").fill("");
    await page.getByRole("button", { name: "筛选" }).click();
    await page.waitForFunction(
      () => !/快筛\s+\d+/.test(
        document.querySelector(".powerarr-plus-status")?.textContent || ""
      ),
      null,
      { timeout: 30000 }
    );
    await page.waitForFunction(
      (minimumRows) =>
        Array.from(document.querySelectorAll("[role='gridcell'], tr")).filter((element) => {
          if (element.closest(".powerarr-plus-toolbar")) {
            return false;
          }
          const text = (element.innerText || element.textContent || "").trim();
          if (!text || !element.querySelector('input[type="checkbox"]')) {
            return false;
          }
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        }).length >= minimumRows,
      Math.min(beforeVisible, 2),
      { timeout: 30000 }
    );

    await page.locator('input[name="selectAll"]').click({ force: true });
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".powerarr-plus-status")?.textContent?.includes(`已选 ${expected}`),
      initialVisibleCount,
      { timeout: 30000 }
    );
    await waitForSelectedNativeVisual(page);
    await page.waitForTimeout(300);
    await page.locator('input[name="selectAll"]').click({ force: true });
    await page.waitForFunction(
      () =>
        document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 0") &&
        Array.from(document.querySelectorAll("[class*='CheckInput-input']")).every(
          (element) =>
            !(element instanceof HTMLElement) ||
            !Boolean(element.offsetParent) ||
            (!element.classList.contains("powerarr-plus-native-checked") &&
              !element.classList.contains("powerarr-plus-native-indeterminate"))
        ),
      null,
      { timeout: 30000 }
    );

    await page.evaluate(() => {
      window.__powerArrPlusSelectDebug = [];
      const record = (event) => {
        const target = event.target;
        window.__powerArrPlusSelectDebug.push({
          type: event.type,
          tagName: target?.tagName || "",
          name: target?.name || "",
          id: target?.id || "",
          checked: target?.checked === true,
          className: String(target?.className || ""),
        });
      };
      ["pointerdown", "mousedown", "click", "input", "change"].forEach((eventName) => {
        document.addEventListener(eventName, record, true);
      });
    });

    await page.locator('input[name="selectAll"]').click({ force: true });
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".powerarr-plus-status")?.textContent?.includes(`已选 ${expected}`),
      initialVisibleCount,
      { timeout: 30000 }
    );
    await waitForSelectedNativeVisual(page);
    await page.waitForTimeout(300);
    await page.locator('input[name="selectAll"]').click({ force: true });
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 0"),
      null,
      { timeout: 30000 }
    );

    const firstSelected = await clickFirstSelectableResult(page);
    if (!firstSelected) {
      throw new Error("expected a selectable first result before scroll");
    }
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 1"),
      null,
      { timeout: 30000 }
    );

    await page.evaluate(scrollSearchResultsScript);
    await page.waitForTimeout(1000);
    const secondSelected = await clickFirstSelectableResult(page);
    if (!secondSelected) {
      throw new Error("expected a selectable result after scrolling");
    }
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 2"),
      null,
      { timeout: 30000 }
    );

    const searchRequestsBeforeHide = searchRequestCount(requests);
    await page.getByRole("button", { name: "隐藏选中" }).click();
    await page.waitForFunction(
      () => /已隐藏 [1-9]\d* 条/.test(
        document.querySelector(".powerarr-plus-status")?.textContent || ""
      ),
      null,
      { timeout: 90000 }
    );
    await page.waitForFunction(
      (checkboxName) =>
        !Array.from(document.querySelectorAll('input[type="checkbox"]')).some(
          (input) => input.name === checkboxName && Boolean(input.offsetParent)
        ),
      secondSelected.checkboxName,
      { timeout: 30000 }
    );

    const searchRequestsAfterHide = searchRequestCount(requests);
    if (searchRequestsAfterHide !== searchRequestsBeforeHide) {
      throw new Error(
        `hide selected triggered a new Prowlarr search request: before=${searchRequestsBeforeHide}, after=${searchRequestsAfterHide}`
      );
    }
    const latestHideCall = hideCalls[hideCalls.length - 1] || [];
    if (latestHideCall.length < 2) {
      throw new Error(
        `expected hide selected across virtual scroll to include at least two releases, got ${JSON.stringify(latestHideCall)}`
      );
    }
    if (
      !latestHideCall.some((release) => release.title === firstSelected.title) ||
      !latestHideCall.some((release) => release.title === secondSelected.title)
    ) {
      throw new Error(
        `hide selected missed a scrolled selection: first=${JSON.stringify(firstSelected)}, second=${JSON.stringify(secondSelected)}, hide=${JSON.stringify(latestHideCall)}`
      );
    }
    const afterHideVisible = await page.evaluate(visibleResultCountScript);
    const hiddenDomRows = await page.locator(".powerarr-plus-hidden").count();
    if (hiddenDomRows !== 0) {
      throw new Error(`hide selected should not hide current DOM rows, got ${hiddenDomRows}`);
    }
    const afterHideGapStats = await page.evaluate(virtualRowGapStatsScript);
    assertNoVirtualRowGaps(afterHideGapStats, "after hiding one result");

    await page.goto(PROWLARR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await runSearch(page);
    await page.waitForFunction(
      () => /已过滤 [1-9]\d*/.test(
        document.querySelector(".powerarr-plus-status")?.textContent || ""
      ),
      null,
      { timeout: 90000 }
    );
    const searchRequestsAfterManualSearch = searchRequestCount(requests);
    if (searchRequestsAfterManualSearch <= searchRequestsAfterHide) {
      throw new Error(
        `expected the manual second search to call Prowlarr after hide: afterHide=${searchRequestsAfterHide}, afterManual=${searchRequestsAfterManualSearch}`
      );
    }
    const latestFilterCall = filterCalls[filterCalls.length - 1];
    if (!latestFilterCall || latestFilterCall.hidden < 1) {
      throw new Error(
        `expected second search to receive hidden rows from the filter service: ${JSON.stringify(latestFilterCall)}`
      );
    }
    const afterSecondSearchVisible = await page.evaluate(visibleResultCountScript);
    const afterSecondSearchGapStats = await page.evaluate(virtualRowGapStatsScript);
    assertNoVirtualRowGaps(afterSecondSearchGapStats, "second search results");

    await page.getByRole("button", { name: "取消本页已隐藏" }).click();
    await page.waitForFunction(
      () => /已取消本页已隐藏 [1-9]\d* 条/.test(
        document.querySelector(".powerarr-plus-status")?.textContent || ""
      ),
      null,
      { timeout: 30000 }
    );
    const searchRequestsAfterUnhide = searchRequestCount(requests);
    if (searchRequestsAfterUnhide !== searchRequestsAfterManualSearch) {
      throw new Error(
        `unhide current page triggered a new Prowlarr search request: before=${searchRequestsAfterManualSearch}, after=${searchRequestsAfterUnhide}`
      );
    }

    await page.goto(PROWLARR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await runSearch(page);
    await page.waitForFunction(
      () => /已过滤 0/.test(
        document.querySelector(".powerarr-plus-status")?.textContent || ""
      ),
      null,
      { timeout: 90000 }
    );
    const searchRequestsAfterUnhideSearch = searchRequestCount(requests);
    if (searchRequestsAfterUnhideSearch <= searchRequestsAfterUnhide) {
      throw new Error(
        `expected the manual post-unhide search to call Prowlarr again: before=${searchRequestsAfterUnhide}, after=${searchRequestsAfterUnhideSearch}`
      );
    }
    const afterUnhideFilterCall = filterCalls[filterCalls.length - 1];
    if (!afterUnhideFilterCall || afterUnhideFilterCall.hidden !== 0) {
      throw new Error(
        `expected current page unhide to restore hidden rows for this query: ${JSON.stringify(afterUnhideFilterCall)}`
      );
    }
    const afterUnhideSearchGapStats = await page.evaluate(virtualRowGapStatsScript);
    assertNoVirtualRowGaps(afterUnhideSearchGapStats, "post-unhide search results");

    const status = await page.locator(".powerarr-plus-status").textContent();
    console.log(
      JSON.stringify(
        {
          ok: true,
          beforeVisible,
          afterHideVisible,
          afterSecondSearchVisible,
          searchRequestsBeforeHide,
          searchRequestsAfterHide,
          searchRequestsAfterManualSearch,
          searchRequestsAfterUnhide,
          searchRequestsAfterUnhideSearch,
          firstSelected,
          secondSelected,
          latestHideCall,
          initialDedupeHidden,
          initialStatus,
          latestFilterCall,
          afterUnhideFilterCall,
          initialGapStats,
          afterHideGapStats,
          afterSecondSearchGapStats,
          afterUnhideSearchGapStats,
          status,
        },
        null,
        2
      )
    );
  } catch (error) {
    const status = await page
      .locator(".powerarr-plus-status")
      .textContent({ timeout: 1000 })
      .catch(() => null);
    const url = page.url();
    const title = await page.title().catch(() => null);
    const checkboxCount = await page
      .locator("input[type='checkbox']")
      .count()
      .catch(() => null);
    const formState = await page
      .evaluate(() => ({
        inputs: Array.from(document.querySelectorAll("input")).map((input, index) => ({
          index,
          name: input.name,
          type: input.type,
          value: input.value,
          placeholder: input.placeholder,
          checked: input.checked,
          indeterminate: input.indeterminate,
          visible: Boolean(input.offsetParent),
          powerarrPlusBound: input.dataset.powerarrPlusNativeBound || "",
        })),
        buttons: Array.from(document.querySelectorAll("button")).map((button, index) => ({
          index,
          text: (button.innerText || button.textContent || "").trim(),
          disabled: button.disabled,
          className: button.className,
          title: button.title,
          visible: Boolean(button.offsetParent),
        })),
      }))
      .catch(() => null);
    const selectDebug = await page
      .evaluate(() => window.__powerArrPlusSelectDebug || null)
      .catch(() => null);
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => "");
    console.error(
      JSON.stringify(
        {
          ok: false,
          url,
          title,
          status,
          checkboxCount,
          formState,
          selectDebug,
          requests,
          filterCalls,
          hideCalls,
          bodyExcerpt: bodyText.slice(0, 600),
        },
        null,
        2
      )
    );
    throw error;
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
