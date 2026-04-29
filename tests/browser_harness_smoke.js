const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(playwrightModule);

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";

function contentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  return "application/octet-stream";
}

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${HOST}`);
    const decodedPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const target = path.resolve(ROOT, decodedPath || "tests/browser_harness.html");

    if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(target, (error, body) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, { "Content-Type": contentType(target) });
      response.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function visibleHarnessRowsScript() {
  return Array.from(document.querySelectorAll("#results [role='gridcell']")).filter(
    (element) => {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    }
  ).length;
}

(async () => {
  const server = await startStaticServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(
      `http://${HOST}:${port}/tests/browser_harness.html`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );

    await page.getByRole("button", { name: "搜索" }).click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已去重 1"),
      null,
      { timeout: 30000 }
    );

    const injectedCheckboxes = await page.locator(".powerarr-plus-checkbox").count();
    const injectedCells = await page.locator(".powerarr-plus-cell").count();
    if (injectedCheckboxes !== 0 || injectedCells !== 0) {
      throw new Error(
        `expected native checkboxes only, got injectedCheckboxes=${injectedCheckboxes}, injectedCells=${injectedCells}`
      );
    }

    const beforeVisible = await page.evaluate(visibleHarnessRowsScript);
    if (beforeVisible !== 4) {
      throw new Error(`expected 4 visible deduped rows, got ${beforeVisible}`);
    }

    await page.locator("#selectAll").click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 4"),
      null,
      { timeout: 30000 }
    );
    await page.locator("#selectAll").click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 0"),
      null,
      { timeout: 30000 }
    );

    await page
      .locator("#results [role='gridcell']", { hasText: "Digital Carnage" })
      .locator("input[type='checkbox']")
      .first()
      .click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 1"),
      null,
      { timeout: 30000 }
    );

    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#results [role='gridcell']"));
      const row = rows.find((candidate) =>
        (candidate.innerText || candidate.textContent || "").includes("Digital Carnage")
      );
      if (!row) {
        throw new Error("expected a Digital Carnage row to simulate virtual row reuse");
      }

      const checkbox = row.querySelector("input[type='checkbox']");
      if (!checkbox || !checkbox.checked) {
        throw new Error("expected the Digital Carnage row to be selected before reuse");
      }

      const cells = Array.from(row.children);
      checkbox.checked = false;
      cells[1].innerHTML = '<span class="protocol">nzb</span>';
      cells[2].textContent = "582 days";
      cells[3].innerHTML =
        '<a href="#">Vaxxed.From.Cover-Up.to.Catastrophe.2016.1080p.AMZN.WEBRip.DDP2.0.x264-SiGMA</a>';
      cells[4].textContent = "SceneNZBs";
      cells[5].textContent = "4.7 GiB";
      cells[6].textContent = "0";
      cells[7].textContent = "";
      cells[8].innerHTML = '<span class="category">Movies/HD</span>';
    });
    await page.waitForTimeout(500);
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 1"),
      null,
      { timeout: 30000 }
    );

    await page.getByRole("button", { name: "隐藏选中" }).click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已隐藏 2 条，下次搜索时隐藏"),
      null,
      { timeout: 30000 }
    );
    const lastHideRequest = await page.evaluate(() => {
      const requests = window.__powerArrPlusHarness?.hideRequests || [];
      return requests[requests.length - 1] || [];
    });
    if (
      !lastHideRequest.some((release) => release.indexer === "Digital Carnage") ||
      lastHideRequest.some((release) => release.indexer === "SceneNZBs")
    ) {
      throw new Error(
        `expected virtual row reuse to preserve the originally selected Digital Carnage release, got ${JSON.stringify(lastHideRequest)}`
      );
    }
    const afterHideVisible = await page.evaluate(visibleHarnessRowsScript);
    if (afterHideVisible !== beforeVisible) {
      throw new Error(
        `expected hide selected to keep current rows until the next search, got ${afterHideVisible}`
      );
    }

    await page.getByRole("button", { name: "搜索" }).click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已过滤 2"),
      null,
      { timeout: 30000 }
    );

    const afterSecondSearchVisible = await page.evaluate(visibleHarnessRowsScript);
    if (afterSecondSearchVisible !== 3) {
      throw new Error(
        `expected 3 visible rows after hiding duplicate group, got ${afterSecondSearchVisible}`
      );
    }

    await page.getByRole("button", { name: "取消本页已隐藏" }).click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已取消本页已隐藏 2 条"),
      null,
      { timeout: 30000 }
    );
    const afterUnhideVisible = await page.evaluate(visibleHarnessRowsScript);
    if (afterUnhideVisible !== afterSecondSearchVisible) {
      throw new Error(
        `expected unhide to keep current rows until the next search, got ${afterUnhideVisible}`
      );
    }

    await page.getByRole("button", { name: "搜索" }).click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已过滤 0"),
      null,
      { timeout: 30000 }
    );
    const afterUnhideSearchVisible = await page.evaluate(visibleHarnessRowsScript);
    if (afterUnhideSearchVisible !== 4) {
      throw new Error(
        `expected 4 visible rows after unhiding current page, got ${afterUnhideSearchVisible}`
      );
    }

    await page.locator("#selectAll").click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已选 4"),
      null,
      { timeout: 30000 }
    );
    await page.getByRole("button", { name: "隐藏选中" }).click();
    await page.waitForTimeout(1000);
    const statusAfterSelectAllHide = await page.locator(".powerarr-plus-status").textContent();
    if (!/已隐藏 [1-9]\d* 条，下次搜索时隐藏/.test(statusAfterSelectAllHide || "")) {
      throw new Error(`expected select-all hide to succeed, got status=${statusAfterSelectAllHide}`);
    }
    const selectAllHideRequest = await page.evaluate(() => {
      const requests = window.__powerArrPlusHarness?.hideRequests || [];
      return requests[requests.length - 1] || [];
    });
    if (selectAllHideRequest.length < 4) {
      throw new Error(
        `expected select-all hide to include the full visible result set, got ${JSON.stringify(selectAllHideRequest)}`
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
          afterUnhideVisible,
          afterUnhideSearchVisible,
          status,
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
