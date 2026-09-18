import { test, expect } from "./fixtures.js";

test("opens the real dashboard and refreshes through visible controls", async ({ page }) => {
  await expect(page).toHaveTitle("Auto Company Control Deck");
  await expect(page.locator("#consensusText")).toContainText("Browser smoke consensus");
  await expect(page.locator("#rawText")).toBeHidden();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.locator("#rawText")).toContainText(/State=stopped|Loop: NOT RUNNING/);
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.locator("#rawText")).toBeHidden();
  const status = page.waitForResponse((response) => response.url().endsWith("/api/status"));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await status).status()).toBe(200);
  await expect(page.locator("#loopState")).toHaveText("STOPPED");
});

test("saves shared language through HTTP and retains it after reload", async ({ page, dashboard }) => {
  await page.getByRole("combobox", { name: "Company language", exact: true }).selectOption("zh-CN");
  await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  const response = await page.request.get(`${dashboard.url}/api/language`);
  expect(await response.json()).toMatchObject({
    language: "zh-CN", nextLanguage: "zh-CN", source: "saved", locked: false, pending: false,
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "公司语言", exact: true })).toHaveValue("zh-CN");
});

test.describe("an active product", () => {
  test.use({ scenario: "active-product" });

  test("keeps the current language while saving the next product preference", async ({ page, dashboard }) => {
    const before = await (await page.request.get(`${dashboard.url}/api/language`)).json();
    expect(before).toMatchObject({ language: "en", nextLanguage: "en", locked: true });
    await page.getByRole("combobox", { name: "Company language", exact: true }).selectOption("zh-CN");
    await expect(page.locator("#languageHint")).toHaveText("This product uses English. The next product will use 中文.");
    await expect(page.locator("#languageStatus")).toHaveText("Saved. The change takes effect when a new product cycle begins.");
    await expect(page.getByRole("heading", { name: "Control Deck", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator("#languageHint")).toHaveText("This product uses English. The next product will use 中文.");
    await expect(page.getByRole("combobox", { name: "Company language", exact: true })).toHaveValue("zh-CN");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const after = await (await page.request.get(`${dashboard.url}/api/language`)).json();
    expect(after).toMatchObject({
      language: "en", nextLanguage: "zh-CN", locked: true, pending: true, productId: before.productId,
    });
  });
});

test.describe("server errors", () => {
  test.use({ scenario: "save-failure" });

  test("shows language and action failures without claiming success", async ({ page }) => {
    const save = page.waitForResponse((response) => response.url().endsWith("/api/language")
      && response.request().method() === "POST");
    await page.getByRole("combobox", { name: "Company language", exact: true }).selectOption("zh-CN");
    expect((await save).status()).toBe(500);
    await expect(page.locator("#languageStatus")).toHaveText("Could not confirm the saved language. Refresh to check the current setting.");
    await expect(page.getByRole("combobox", { name: "Company language", exact: true })).toHaveValue("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const dialog = page.waitForEvent("dialog");
    const click = page.getByRole("button", { name: "Start", exact: true }).click();
    const failure = await dialog;
    expect(failure.message()).toContain("Start failed");
    expect(failure.message()).toContain("Host actions are disabled in browser smoke tests.");
    await failure.accept();
    await click;
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
    await expect(page.locator("#loopState")).toHaveText("STOPPED");
  });
});

test("shows a failed status request and recovers on refresh", async ({ page }) => {
  // Only this failure is injected at the transport boundary; normal requests
  // above and after recovery go to the real Python HTTP server.
  await page.route("**/api/status", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "Smoke test unavailable" }),
  }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#loopState")).toHaveText("UNAVAILABLE");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.locator("#rawText")).toContainText("Request failed (HTTP 503)");
  await page.unroute("**/api/status");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#loopState")).toHaveText("STOPPED");
  await expect(page.locator("#rawText")).toContainText(/State=stopped|Loop: NOT RUNNING/);
});
