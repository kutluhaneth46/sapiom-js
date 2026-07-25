/**
 * E2E tests for the browse-first Open Folder flow (FolderBrowser component).
 *
 * Covers:
 *  - Favorites are shown and navigate to the target directory.
 *  - Breadcrumb segments navigate to ancestor directories.
 *  - Folder-list items drill into subdirectories.
 *  - "Open this folder" confirms the current browsePath and connects.
 *  - Secondary "or type a path" input works.
 *  - The new-session (session mode) DirectoryPicker is unaffected.
 *  - The command-palette DirectoryPicker is unaffected.
 *
 * Runs against `vite dev --port 5299` with VITE_MOCK=1.
 */
import { expect, test } from "@playwright/test";

/** Opens the "Add project" FolderBrowser modal via the + menu → Open Folder. */
async function openFolderBrowserModal(page: import("@playwright/test").Page): Promise<import("@playwright/test").Locator> {
  await page.getByTestId("add-workspace").click();
  await expect(page.getByTestId("add-project-menu")).toBeVisible();
  await page.getByTestId("add-project-open-folder").click();
  await expect(page.getByTestId("add-project-menu")).not.toBeVisible();
  const modal = page.getByRole("dialog", { name: "Add project" });
  await expect(modal).toBeVisible();
  // Wait for the listing to load.
  await expect(modal.getByTestId("folder-browser-listing")).toBeVisible({ timeout: 3000 });
  return modal;
}

test.describe("FolderBrowser — Open Folder (workspace mode)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("favorites row is visible and navigates to Home (~)", async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    // "Home" favorite should be visible once the mock probing resolves.
    const homeBtn = modal.getByTestId("folder-browser-fav-home");
    await expect(homeBtn).toBeVisible({ timeout: 3000 });

    await homeBtn.click();

    // After navigating to Home, breadcrumbs should show the home path.
    // In mock mode ~ → /Users/demo, so we expect a "demo" breadcrumb segment.
    await expect(modal.getByTestId("folder-browser-crumb-demo")).toBeVisible({ timeout: 3000 });
  });

  test("Desktop favorite navigates correctly", async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    const desktopBtn = modal.getByTestId("folder-browser-fav-desktop");
    await expect(desktopBtn).toBeVisible({ timeout: 3000 });

    await desktopBtn.click();

    // Breadcrumb should now show "Desktop".
    await expect(modal.getByTestId("folder-browser-crumb-Desktop")).toBeVisible({ timeout: 3000 });
  });

  test("breadcrumb ancestor segment navigates to that ancestor", async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    // The modal starts at /Users/demo/acme-app. The breadcrumbs should show:
    // / > Users > demo > acme-app
    // Clicking "demo" navigates up to /Users/demo.
    await expect(modal.getByTestId("folder-browser-crumb-demo")).toBeVisible({ timeout: 3000 });
    await modal.getByTestId("folder-browser-crumb-demo").click();

    // After navigating to /Users/demo, the listing shows its children.
    await expect(modal.getByTestId("folder-browser-item-scratch")).toBeVisible({ timeout: 3000 });
    await expect(modal.getByTestId("folder-browser-item-acme-app")).toBeVisible({ timeout: 1000 });
  });

  test("clicking a folder item drills into it", async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    // Start at /Users/demo/acme-app — which has leasing, src, docs.
    await expect(modal.getByTestId("folder-browser-item-leasing")).toBeVisible({ timeout: 3000 });

    await modal.getByTestId("folder-browser-item-leasing").click();

    // Should now be at /Users/demo/acme-app/leasing.
    await expect(modal.getByTestId("folder-browser-crumb-leasing")).toBeVisible({ timeout: 3000 });
  });

  test('"Open this folder" confirms the current browsePath and connects', async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    // Navigate up to /Users/demo then click scratch.
    await modal.getByTestId("folder-browser-up").click();
    await expect(modal.getByTestId("folder-browser-item-scratch")).toBeVisible({ timeout: 3000 });
    await modal.getByTestId("folder-browser-item-scratch").click();

    // Wait until the breadcrumb confirms we're at scratch (listing resolved).
    await expect(modal.getByTestId("folder-browser-crumb-scratch")).toBeVisible({ timeout: 3000 });

    // "Open this folder" is the primary CTA.
    const openBtn = modal.getByTestId("folder-browser-open");
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    // Modal closes, scratch joins the rail.
    await expect(modal).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId("workflow-scratch")).toBeVisible({ timeout: 5000 });
  });

  test('"or type a path" secondary input navigates when Enter is pressed', async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    // Reveal the type-a-path input.
    const toggle = modal.getByTestId("folder-browser-type-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();

    const typeInput = modal.getByTestId("folder-browser-type-input");
    await expect(typeInput).toBeVisible();
    await typeInput.fill("/Users/demo/rfq-workflows");
    await typeInput.press("Enter");

    // Should now browse /Users/demo/rfq-workflows.
    await expect(modal.getByTestId("folder-browser-crumb-rfq-workflows")).toBeVisible({ timeout: 3000 });
    await expect(modal.getByTestId("folder-browser-item-src")).toBeVisible({ timeout: 3000 });
  });

  test('"or type a path" Go button navigates to typed path', async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    await modal.getByTestId("folder-browser-type-toggle").click();
    const typeInput = modal.getByTestId("folder-browser-type-input");
    await typeInput.fill("/Users/demo/onboarding-flow");
    await modal.getByTestId("folder-browser-type-go").click();

    await expect(modal.getByTestId("folder-browser-crumb-onboarding-flow")).toBeVisible({ timeout: 3000 });
  });

  test("recents chips are shown and navigate", async ({ page }) => {
    const modal = await openFolderBrowserModal(page);

    // Mock settings include 3 recent dirs: acme-app, rfq-workflows, onboarding-flow.
    // Check for rfq-workflows recent chip.
    const rfqChip = modal.getByTestId("folder-browser-recent-rfq-workflows");
    await expect(rfqChip).toBeVisible({ timeout: 3000 });

    await rfqChip.click();
    await expect(modal.getByTestId("folder-browser-crumb-rfq-workflows")).toBeVisible({ timeout: 3000 });
  });
});

test.describe("FolderBrowser — does not affect other DirectoryPicker callers", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("new-session modal (session mode) still uses DirectoryPicker, not FolderBrowser", async ({ page }) => {
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("new-session-btn").click();
    const modal = page.locator(".modal-new-session");
    await expect(modal).toBeVisible();

    // DirectoryPicker's text input must be present.
    await expect(modal.getByTestId("dir-picker-input")).toBeVisible();
    // FolderBrowser's primary CTA must NOT be present.
    await expect(modal.getByTestId("folder-browser-open")).toHaveCount(0);
  });

  test("command-palette path mode is unaffected", async ({ page }) => {
    await page.getByTestId("palette-trigger").click();
    const palette = page.getByTestId("command-palette-list");
    await expect(palette).toBeVisible();

    // Type a path — the palette handles it with its own inline path mode.
    await page.getByTestId("command-palette-input").fill("/Users/demo");
    // The palette should still show directory items, not a FolderBrowser.
    await expect(page.getByTestId("folder-browser-listing")).toHaveCount(0);
  });
});
