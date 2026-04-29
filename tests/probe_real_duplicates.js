const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(playwrightModule);

const PROWLARR_URL = process.env.PROWLARR_URL || "http://localhost:9696/search";
const QUERY =
  process.env.PROWLARR_QUERY || "Vaxxed.From.Cover-Up.to.Catastrophe.2016";
const SHOW_GUIDS = process.env.SHOW_GUIDS === "1";

async function runSearch(page) {
  const queryInput = page.locator('input[name="searchQuery"]');
  const searchButton = page.locator('button[class*="SearchFooter-searchButton"]').first();
  await queryInput.waitFor({ state: "visible", timeout: 30000 });
  await searchButton.waitFor({ state: "visible", timeout: 30000 });

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/v1/search"),
    { timeout: 120000 }
  );
  const requestPromise = page
    .waitForRequest(
      (request) => request.url().includes("/api/v1/search"),
      { timeout: 3000 }
    )
    .catch(() => null);

  await queryInput.fill("");
  await queryInput.fill(QUERY);

  if (!(await requestPromise)) {
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

  return responsePromise;
}

function exactTitle(value) {
  return String(value || "").normalize("NFC").trim();
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function keyFor(release, fields) {
  return fields.map((field) => {
    if (field === "title") {
      return exactTitle(release.title || release.sortTitle);
    }
    return String(release[field] ?? "").trim();
  }).join("\u001f");
}

function groupsFor(releases, fields, predicate = () => true) {
  const groups = new Map();
  for (const release of releases) {
    if (!predicate(release)) {
      continue;
    }
    const key = keyFor(release, fields);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(release);
  }
  return Array.from(groups.values()).filter((group) => group.length > 1);
}

function summarizeGroup(group) {
  const summary = {
    title: group[0].title || group[0].sortTitle,
    size: group[0].size,
    files: group[0].files,
    grabs: group.map((release) => release.grabs ?? null),
    indexers: group.map((release) => release.indexer),
    ages: group.map((release) => release.age ?? null),
  };
  if (SHOW_GUIDS) {
    summary.guids = group.map((release) => release.guid || null);
  }
  return summary;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(PROWLARR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    const response = await runSearch(page);
    const releases = await response.json();
    const keys = Array.from(
      releases.reduce((set, release) => {
        Object.keys(release).forEach((key) => set.add(key));
        return set;
      }, new Set())
    ).sort();

    const protocolCounts = releases.reduce((counts, release) => {
      const protocol = String(release.protocol || "");
      counts[protocol] = (counts[protocol] || 0) + 1;
      return counts;
    }, {});
    const nzbReleases = releases.filter(
      (release) => ["nzb", "usenet"].includes(String(release.protocol || "").toLowerCase())
    );
    const missingFiles = nzbReleases.filter((release) => !hasValue(release.files));
    const strictGroups = groupsFor(
      nzbReleases,
      ["title", "size", "files"],
      (release) => hasValue(release.title || release.sortTitle) &&
        hasValue(release.size) &&
        hasValue(release.files)
    );
    const titleSizeGroups = groupsFor(
      nzbReleases,
      ["title", "size"],
      (release) => hasValue(release.title || release.sortTitle) && hasValue(release.size)
    );
    const titleOnlyGroups = groupsFor(
      nzbReleases,
      ["title"],
      (release) => hasValue(release.title || release.sortTitle)
    );

    console.log(JSON.stringify({
      total: releases.length,
      nzb: nzbReleases.length,
      fields: keys,
      protocols: protocolCounts,
      files: {
        missing: missingFiles.length,
        sampleValues: Array.from(new Set(nzbReleases.map((release) => release.files))).slice(0, 20),
      },
      strict: {
        groups: strictGroups.length,
        hiddenWouldBe: strictGroups.reduce((count, group) => count + group.length - 1, 0),
        samples: strictGroups.slice(0, 5).map(summarizeGroup),
      },
      titleSize: {
        groups: titleSizeGroups.length,
        hiddenWouldBe: titleSizeGroups.reduce((count, group) => count + group.length - 1, 0),
        samples: titleSizeGroups.slice(0, 8).map(summarizeGroup),
      },
      titleOnly: {
        groups: titleOnlyGroups.length,
        hiddenWouldBe: titleOnlyGroups.reduce((count, group) => count + group.length - 1, 0),
        samples: titleOnlyGroups.slice(0, 8).map(summarizeGroup),
      },
    }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
