import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const test = base.extend({
  journal: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "company-journal-browser-"));
    await fs.mkdir(path.join(directory, "logs"));
    await fs.mkdir(path.join(directory, "memories"));
    const start = Date.now() - 30 * 60 * 1000;
    const cycles = [1, 2, 3].map((number) => ({
      schema_version: 1, kind: "cycle_usage", project: "projects/journal-fixture", cycle_id: `cycle-000${number}-fixture`,
      cycle_number: number, engine: "codex", model: "gpt-6-astra",
      started_at: new Date(start + number * 60000).toISOString(),
      ended_at: new Date(start + number * 60000 + 30000).toISOString(),
      status: "completed", exit_code: 0,
      usage: { input_tokens: number === 2 ? null : 80, output_tokens: number === 2 ? null : 20,
        total_tokens: number === 2 ? null : 100, status: number === 2 ? "unavailable" : "reported" },
      cost_usd: null, cost_usd_status: "unavailable",
    }));
    await fs.writeFile(path.join(directory, "logs", "usage.jsonl"), cycles.map(JSON.stringify).join("\n") + "\n");
    for (const cycle of cycles) {
      await fs.writeFile(path.join(directory, "logs", `${cycle.cycle_id}.context.json`), JSON.stringify({
        version: 1, cycleId: cycle.cycle_id, project: "projects/journal-fixture",
        recordedAt: cycle.started_at, source: "runtime_context",
      }));
      await fs.writeFile(path.join(directory, "logs", `${cycle.cycle_id}.json`), JSON.stringify({
        result: `**第 ${cycle.cycle_number} 轮工作已完成。**\n\n本轮记录：保留历史并核对结果。`,
      }));
      await fs.writeFile(path.join(directory, "logs", `${cycle.cycle_id}.log`), `Fixture log ${cycle.cycle_number}\n<unsafe-is-text>\n`);
    }
    await fs.writeFile(path.join(directory, "memories", "consensus.md"), [
      "# Auto Company Consensus", "## Current Phase", "Validating", "## What We Did This Cycle",
      "- 已完成当前轮次验证。", "- <img src=x onerror=window.journalInjected=true>",
      "## Active Projects", "- Journal Fixture：本地预览", "## Next Action", "等待用户检查新界面。",
      "## Company State", "- Product: Journal Fixture，本地工作记录预览", "",
    ].join("\n"));
    await fs.mkdir(path.join(directory, "projects/journal-fixture"), { recursive: true });
    await fs.writeFile(path.join(directory, "projects/journal-fixture/.auto-company-project.json"), JSON.stringify({
      version: 1, project: "projects/journal-fixture", displayName: "Journal Fixture", description: "Local journal fixture",
      recordedAt: new Date().toISOString(), source: "project_metadata",
    }));
    await fs.writeFile(path.join(directory, ".auto-company.local"), "ACTIVE_PROJECT=projects/journal-fixture\nAUTO_COMPANY_LANGUAGE=zh-CN\n");
    await fs.writeFile(path.join(directory, ".auto-loop-state"), "STATUS=stopped\nENGINE=codex\nMODEL=gpt-6-astra\nLOOP_COUNT=3\n");
    const deliveryText = "# Browser fixture delivery\nThis document stays read-only.\n";
    const deliveryPath = "projects/journal-fixture/DELIVERY.md";
    await fs.writeFile(path.join(directory, deliveryPath), deliveryText);
    await fs.mkdir(path.join(directory, "logs/artifacts"), { recursive: true });
    const recordedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, "logs/artifacts/delivery.json"), JSON.stringify({
      version: 1, id: "a".repeat(32), kind: "document", project: "projects/journal-fixture",
      cycleId: cycles.at(-1).cycle_id, recordedAt, modifiedAt: recordedAt, source: "runner",
      path: deliveryPath, sha256: createHash("sha256").update(deliveryText).digest("hex"),
    }));
    // Exercise the optional backup route without relying on private local files
    // or keeping a second production dashboard in the repository.
    const legacyDirectory = path.join(directory, "legacy-backup");
    await fs.mkdir(legacyDirectory);
    await fs.writeFile(path.join(legacyDirectory, "index.html"),
      '<!doctype html><title>Saved dashboard backup</title><h1>Saved dashboard backup</h1><pre id="archive"></pre><script src="/app.js"></script>');
    await fs.writeFile(path.join(legacyDirectory, "app.js"),
      'fetch("/api/status").then(response => response.json()).then(data => { document.getElementById("archive").textContent = data.consensusHead; });');
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.env.AUTO_COMPANY_BROWSER_PYTHON || process.env.PYTHON
      || (process.platform === "win32" ? "python" : "python3"), [
      path.join(repository, "dashboard", "journal_server.py"), "--port", String(port), "--repo", directory,
      "--legacy-dir", legacyDirectory,
    ], { cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Journal exited: ${output}`);
        try { ready = (await fetch(`${url}/api/journal`)).ok; } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error(`Journal startup timed out: ${output}`);
      await use({ url, directory });
    } finally {
      child.kill();
      if (child.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
          || !path.basename(directory).startsWith("company-journal-browser-")) {
        throw new Error("Refusing cleanup outside the browser fixture directory");
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
});

test("journal renders source history and never treats a report as live telemetry", async ({ page, journal }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator("#cycleNumber")).toContainText("03");
  await expect(page.locator("#cycleTitle")).toContainText("第 3 轮工作已完成");
  await expect(page.locator("body")).not.toContainText("等待用户检查新界面");
  await expect(page.locator("#projectSidebar > section")).toHaveCount(2);
  const snapshot = await (await page.request.get(`${journal.url}/api/journal`)).json();
  expect(snapshot.consensus).not.toHaveProperty("nextAction");
  await expect(page.locator("body")).toContainText(/只读|预览/);
  await expect(page.locator("body")).not.toContainText("本轮执行中");
  await expect(page.locator("#startButton")).toBeDisabled();
  await expect(page.locator("#stopButton")).toBeDisabled();
  await page.locator("#settingsButton").click();
  await expect(page.locator("#languageSelect")).toBeDisabled();
  await page.locator("#closeSettingsButton").click();
  expect(await page.evaluate(() => window.journalInjected)).toBeUndefined();
  expect(errors).toEqual([]);
});

test("history stays open after refresh and its log belongs to the selected cycle", async ({ page, journal }) => {
  await page.goto(`${journal.url}/journal`);
  const row = page.locator("#historyList details").first();
  await row.locator(":scope > summary").click();
  await expect(row).toHaveAttribute("open", "");
  await page.locator("#refreshButton").click();
  await expect(row).toHaveAttribute("open", "");
  await page.locator("#tab-logs").click();
  await page.locator("#logSelect").selectOption("cycle-0001-fixture");
  await expect(page.locator("#logText")).toContainText("Fixture log 1");
  await expect(page.locator("#logText")).not.toContainText("Fixture log 3");
});

test("usage preserves unknown coverage and artifacts open through the real server", async ({ page, journal }) => {
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator("#cycleNumber")).toContainText("03");
  await page.locator("#tab-usage").click();
  await expect(page.locator("body")).toContainText(/部分|未知|不完整/);
  await page.locator("#tab-work").click();
  const delivery = page.locator('#projectSidebar a[href="/api/journal/document?path=projects%2Fjournal-fixture%2FDELIVERY.md"]');
  await expect(delivery.first()).toBeVisible();
  const response = await page.request.get(new URL(await delivery.first().getAttribute("href"), journal.url).href);
  expect(response.ok()).toBeTruthy();
  expect(await response.text()).toContain("Browser fixture delivery");
  const write = await page.request.post(`${journal.url}/api/action/start`, { data: {} });
  expect(write.status()).toBe(403);
});

test("failed refresh remains visible and recovers without losing the journal", async ({ page, journal }) => {
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator("#cycleNumber")).toContainText("03");
  await page.route("**/api/journal", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Unavailable" }),
  }));
  await page.locator("#refreshButton").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.unroute("**/api/journal");
  await page.locator("#refreshButton").click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.locator("#cycleNumber")).toContainText("03");
});

test("narrow layout and settings remain usable by keyboard", async ({ page, journal }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator("#cycleNumber")).toContainText("03");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.locator("#settingsButton").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator("#settingsButton")).toBeFocused();
});

test("an explicitly supplied backup is served and reads the same archive", async ({ page, journal }) => {
  await page.goto(`${journal.url}/legacy`);
  await expect(page.getByRole("heading", { name: "Saved dashboard backup" })).toBeVisible();
  await expect(page.locator("#archive")).toContainText("Journal Fixture");
  expect((await page.request.get(`${journal.url}/legacy/assets/app.js`)).status()).toBe(200);
  await page.goto(journal.url);
  await expect(page.locator("#cycleNumber")).toContainText("03");
});

test("empty archive follows English preference and remains navigable", async ({ page, journal }) => {
  await fs.writeFile(path.join(journal.directory, "logs", "usage.jsonl"), "");
  await fs.writeFile(path.join(journal.directory, ".auto-company.local"), "AUTO_COMPANY_LANGUAGE=en\n");
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "No cycle records yet" })).toBeVisible();
  await page.locator("#tab-logs").click();
  await expect(page.locator("#logSelect option")).toHaveCount(1);
  await expect(page.locator("#logSelect")).toHaveValue("runtime");
  await expect(page.locator("#logStatus")).toContainText(/empty|no log/i);
  await page.locator("#tab-usage").click();
  await expect(page.locator("#usageSummary")).toContainText("no usage records");
});

test("failed latest cycle never inherits an earlier consensus as its results", async ({ page, journal }) => {
  await fs.appendFile(path.join(journal.directory, "logs", "usage.jsonl"), JSON.stringify({
    schema_version: 1, kind: "cycle_usage", project: "projects/journal-fixture", cycle_id: "cycle-0004-failed",
    cycle_number: 4, started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    status: "failed", exit_code: 1, engine: "codex", model: "gpt-6-astra", usage: {},
  }) + "\n");
  await fs.writeFile(path.join(journal.directory, "logs/cycle-0004-failed.context.json"), JSON.stringify({
    version: 1, cycleId: "cycle-0004-failed", project: "projects/journal-fixture",
    recordedAt: new Date().toISOString(), source: "runtime_context",
  }));
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator("#cycleNumber")).toContainText("04");
  await expect(page.locator("#currentCycle")).toContainText("执行失败");
  await expect(page.locator("#currentCycle")).not.toContainText("已完成当前轮次验证");
});


test("cycle timeline preserves disclosures, keyboard focus and selected logs across changed data", async ({ page, journal }) => {
  await page.goto(`${journal.url}/journal`);
  const summary = page.locator("#historyList > details > summary").first();
  await summary.click();
  await summary.focus();
  const latest = path.join(journal.directory, "logs/cycle-0003-fixture.json");
  await fs.writeFile(latest, JSON.stringify({ result: "Changed report after refresh" }));
  await page.evaluate(() => document.getElementById("refreshButton").click());
  await expect(page.locator("#cycleTitle")).toHaveText("Changed report after refresh");
  await expect(page.locator("#historyList > details").first()).toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
  await expect(page.locator(".current-cycle")).toHaveAttribute("aria-current", "step");
  expect(await page.locator(".current-column").evaluate((node) => getComputedStyle(node, "::before").width)).toBe("1px");
  await page.locator("#tab-logs").click();
  await page.locator("#logSelect").selectOption("cycle-0001-fixture");
  await fs.writeFile(latest, JSON.stringify({ result: "Another changed report" }));
  await page.locator("#refreshButton").click();
  await expect(page.locator("#logSelect")).toHaveValue("cycle-0001-fixture");
  await expect(page.locator("#logText")).toContainText("Fixture log 1");
});

test("typed checks and exact commands retain unknowns, provenance and narrow bilingual layout", async ({ page, journal }) => {
  const data = await (await page.request.get(`${journal.url}/api/journal`)).json();
  const current = data.cycles[0];
  current.checkStatus = "completed";
  current.latestCheck = { id: "check-fixture", cycleId: current.id, state: "completed", available: false,
    source: "runner", adapter: "junit", reportStatus: "fresh", freshness: "fresh", exitCode: 1,
    tests: { tests: 12, failures: 2, errors: 1, skipped: 3 }, recordedAt: data.generatedAt,
    command: ["python", "test_" + "long".repeat(80) + ".py"] };
  const command = "node --test " + "long/path/".repeat(40);
  current.events = [
    { kind: "files", observedAt: data.generatedAt, paths: ["older.txt"] },
    { kind: "command", phase: "started", itemId: "test", observedAt: data.generatedAt, command },
    { kind: "files", observedAt: data.generatedAt, paths: ["recent.txt"] },
    { kind: "command", phase: "completed", itemId: "test", observedAt: data.generatedAt, command, exitCode: 1 },
    { kind: "turn.completed", observedAt: data.generatedAt },
    { kind: "process.exited", observedAt: data.generatedAt },
  ];
  data.artifacts = [{ kind: "preview", state: "stopped", evidenceStatus: "stale", available: false }];
  let language = "en";
  await page.route("**/api/journal", (route) => route.fulfill({ json: { ...data, language, languageState: null } }));
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator("#currentCycle .recent-checks")).toContainText("Check failed");
  await expect(page.locator("#currentCycle .check-counts")).toHaveText("Passed6Failed2Errors1Skipped3Total12");
  await expect(page.locator("#currentCycle .observed-events")).toContainText("Command finished");
  await expect(page.locator("#currentCycle .event-list > li")).toHaveCount(3);
  await expect(page.locator("#currentCycle .event-command")).toHaveCount(1);
  await expect(page.locator("#projectSidebar")).toContainText("Preview ended");
  await expect(page.locator("#projectSidebar")).not.toContainText("File changed or missing");
  await page.locator("#currentCycle .event-command > summary").click();
  await expect(page.locator("#currentCycle .event-command pre")).toHaveText(command);
  await page.locator("#currentCycle .recent-checks .source-disclosure > summary").click();
  await expect(page.locator("#currentCycle .recent-checks")).toContainText(current.id);
  for (const locale of ["en", "zh-CN"]) {
    language = locale;
    await page.locator("#refreshButton").click();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
  }
  current.latestCheck = null;
  current.checkStatus = "unregistered";
  await page.locator("#refreshButton").click();
  await expect(page.locator("#currentCycle .recent-checks")).toContainText("暂无已登记检查");
  await expect(page.locator("#currentCycle .check-counts")).toHaveCount(0);
});

test("running elapsed freezes on disconnect and rejects older snapshots", async ({ page, journal }) => {
  const data = await (await page.request.get(`${journal.url}/api/journal`)).json();
  data.readOnly = false;
  data.runtime = { ...data.runtime, available: true, processState: "running", state: "running", elapsedReliable: true, elapsedSeconds: 60 };
  data.cycles[0] = { ...data.cycles[0], active: true, status: "running", endedAt: null };
  data.language = "en"; data.languageState = null;
  await page.route("**/api/journal", (route) => route.fulfill({ json: data }));
  await page.goto(`${journal.url}/journal`);
  await expect(page.locator(".live-elapsed")).toContainText("Running for 1m");
  await page.locator("#autoRefresh").uncheck();
  await page.unroute("**/api/journal");
  await page.route("**/api/journal", (route) => route.fulfill({ status: 503, json: { ok: false } }));
  await page.locator("#refreshButton").click();
  await expect(page.locator("#connectionError")).toBeVisible();
  await expect(page.locator(".live-elapsed")).toHaveCount(0);
  await expect(page.locator("#refreshStatus")).toContainText("Last updated");
  await page.unroute("**/api/journal");
  await page.route("**/api/journal", (route) => route.fulfill({ json: { ...data,
    generatedAt: new Date(Date.parse(data.generatedAt) - 1000).toISOString(), cycles: [] } }));
  await page.locator("#refreshButton").click();
  await expect(page.locator("#cycleNumber")).toHaveText("03");
  await expect(page.locator("#connectionError")).toBeVisible();
});
