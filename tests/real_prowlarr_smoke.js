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
    if (!text || !text.includes("Vaxxed")) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }).length;
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
        { timeout: 30000 }
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
      releases.forEach((release) => {
        hiddenFingerprints.add(
          release._seenFilterFingerprint || fingerprintRelease(release)
        );
      });
      await route.fulfill(jsonResponse({ ok: true, hiddenCount: releases.length }));
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
    if (url.includes("/api/v1/search") || url.includes("/api/filter") || url.includes("/api/hide")) {
      requests.push(`REQ ${request.method()} ${url}`);
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/v1/search") || url.includes("/api/filter") || url.includes("/api/hide")) {
      requests.push(`RES ${response.status()} ${url}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.includes("/api/v1/search") || url.includes("/api/filter") || url.includes("/api/hide")) {
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

    await page.locator("[role='gridcell'] [class*='CheckInput-input']").first().click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 1"),
      null,
      { timeout: 30000 }
    );

    await page.getByRole("button", { name: "隐藏选中" }).click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已隐藏 1"),
      null,
      { timeout: 30000 }
    );

    const afterHideVisible = await page.evaluate(visibleResultCountScript);
    if (afterHideVisible !== beforeVisible - 1) {
      throw new Error(
        `expected hiding one result to leave ${beforeVisible - 1} visible results, got ${afterHideVisible}`
      );
    }

    await page.goto(PROWLARR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await runSearch(page);
    await page.waitForFunction(
      () => /已过滤 [1-9]\d*/.test(
        document.querySelector(".powerarr-plus-status")?.textContent || ""
      ),
      null,
      { timeout: 90000 }
    );
    const afterSecondSearchVisible = await page.evaluate(visibleResultCountScript);
    if (afterSecondSearchVisible !== beforeVisible - 1) {
      throw new Error(
        `expected second search to keep ${beforeVisible - 1} visible results, got ${afterSecondSearchVisible}`
      );
    }

    const status = await page.locator(".powerarr-plus-status").textContent();
    console.log(
      JSON.stringify(
        {
          ok: true,
          beforeVisible,
          afterHideVisible,
          afterSecondSearchVisible,
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
          visible: Boolean(input.offsetParent),
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
          requests,
          filterCalls,
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
