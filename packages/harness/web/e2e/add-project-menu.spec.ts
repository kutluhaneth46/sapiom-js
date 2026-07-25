/**
 * E2E tests for the Workspace "+" add-project menu:
 *  - The "+" opens the menu with exactly "Open Folder" and "Connect to GitHub".
 *  - "Open Folder" closes the menu and opens the existing NewSessionModal
 *    (workspace mode).
 *  - "Connect to GitHub" opens the Device Flow panel (primary path in mock mode).
 *    The URL-paste form (ConnectGitHubForm) remains as a fallback view accessed
 *    via the Device Flow's "unconfigured" state — not as the direct click target.
 *
 * Runs against `vite dev` with VITE_MOCK=1 — no server, no real git clone.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test.describe("add-project menu", () => {
  test('clicking "+" opens a menu with exactly two items: Open Folder and Connect to GitHub', async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    const menu = page.getByTestId("add-project-menu");
    await expect(menu).toBeVisible();

    // The menu must have exactly these two items and nothing else.
    const openFolderBtn = page.getByTestId("add-project-open-folder");
    const connectGitHubBtn = page.getByTestId("add-project-connect-github");
    await expect(openFolderBtn).toBeVisible();
    await expect(connectGitHubBtn).toBeVisible();

    // Verify there are no other action items in the menu items container.
    const menuItems = page.getByTestId("add-project-menu-items").locator(".add-project-menu-item");
    await expect(menuItems).toHaveCount(2);
  });

  test('"Open Folder" closes the menu and opens the folder connect modal', async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    await expect(page.getByTestId("add-project-menu")).toBeVisible();

    await page.getByTestId("add-project-open-folder").click();

    // Menu closes.
    await expect(page.getByTestId("add-project-menu")).not.toBeVisible();

    // The "Add project" modal (workspace mode, role=dialog) is open.
    const modal = page.getByRole("dialog", { name: "Add project" });
    await expect(modal).toBeVisible();
  });

  test('"Connect to GitHub" shows the Device Flow panel inside the menu', async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();

    // The Device Flow panel is the primary view — not the URL-paste form.
    await expect(page.getByTestId("github-device-connect")).toBeVisible();
    // The status check completes quickly in mock mode → "Connect GitHub" button.
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });
  });

  test("Connect to GitHub: Device Flow → authorized → browse → clone adds repo to rail", async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();
    await expect(page.getByTestId("github-device-start")).toBeVisible({ timeout: 5000 });

    // Start device flow.
    await page.getByTestId("github-device-start").click();
    await expect(page.getByTestId("github-device-code")).toBeVisible({ timeout: 5000 });

    // Simulate user clicking the GitHub link → mock poll completes → authorized.
    await page.getByTestId("github-device-link").click();
    await expect(page.getByTestId("github-device-connected")).toBeVisible({ timeout: 5000 });

    // Browse repos.
    await page.getByTestId("github-device-browse").click();
    await expect(page.getByTestId("github-repo-list")).toBeVisible({ timeout: 5000 });

    // Pick "my-agent" repo.
    await page.getByTestId("github-repo-item-my-agent").click();

    // Menu closes and repo appears in rail.
    await expect(page.getByTestId("add-project-menu")).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator(".rail-tree")).toContainText("my-agent", { timeout: 5000 });
  });

  test("Connect to GitHub: unconfigured state shows fallback hint", async ({
    page,
  }) => {
    // Navigate with the mockError flag so githubStatus returns configured=false.
    await page.goto("/?seed=0&mockError=githubNotConfigured");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();

    // The Device Flow panel shows the unconfigured hint.
    await expect(page.getByTestId("github-device-unconfigured")).toBeVisible({ timeout: 5000 });
  });

  test("Back button in the Device Flow panel returns to the menu items", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();
    await expect(page.getByTestId("github-device-connect")).toBeVisible({ timeout: 5000 });

    // Click the Back/ArrowLeft button (aria-label "Back to menu").
    await page.getByRole("button", { name: "Back to menu" }).click();

    // Menu items are visible again.
    await expect(page.getByTestId("add-project-menu-items")).toBeVisible();
    await expect(page.getByTestId("github-device-connect")).not.toBeVisible();
  });

  test("Escape or outside click dismisses the menu", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
    await expect(page.getByTestId("add-project-menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("add-project-menu")).not.toBeVisible();
  });
});
