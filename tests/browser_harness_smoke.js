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

    await page.getByRole("button", { name: "隐藏选中" }).click();
    await page.waitForFunction(
      () => document.querySelector(".powerarr-plus-status")?.textContent?.includes("已隐藏 2"),
      null,
      { timeout: 30000 }
    );

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

    const status = await page.locator(".powerarr-plus-status").textContent();
    console.log(
      JSON.stringify(
        {
          ok: true,
          beforeVisible,
          afterSecondSearchVisible,
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
