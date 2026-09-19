"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
let playwright;
for (const location of ["../../scripts/media/package.json", "./package.json"]) {
  try { playwright = createRequire(path.resolve(__dirname, location))("playwright"); break; }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
}

async function inspect(page, html, fileUrl) {
  if (fileUrl) await page.goto(fileUrl);
  else await page.setContent(html);
  return page.evaluate(() => ({
    title: document.title,
    headIcons: document.head.querySelectorAll('link[rel~="icon"]').length,
    bodyIcons: document.body.querySelectorAll('link[rel~="icon"]').length,
    body: document.body.innerHTML,
    href: document.head.querySelector('link[rel~="icon"]')?.getAttribute("href") || null,
    absoluteHref: document.head.querySelector('link[rel~="icon"]')?.href || null,
  }));
}

(async () => {
  const rows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const browser = await playwright.chromium.launch({ headless: true });
  const observations = [];
  try {
    for (const row of rows) {
      const page = await browser.newPage();
      const before = await inspect(page, row.before);
      const after = await inspect(page, row.after, row.fileUrl);
      const resolved = await page.evaluate(({ href, fileUrl, deploymentUrl }) => href ? {
        resolvedFile: new URL(href, fileUrl).href,
        resolvedDeployment: new URL(href, deploymentUrl).href,
      } : {}, { href: after.href, fileUrl: row.fileUrl, deploymentUrl: row.deploymentUrl });
      observations.push({ name: row.name, before, after, reference: row.reference, canonicalUrl: row.canonicalUrl, ...resolved });
      await page.close();
    }
  } finally { await browser.close(); }
  process.stdout.write(JSON.stringify(observations));
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
