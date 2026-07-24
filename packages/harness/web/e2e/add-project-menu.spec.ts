/**
 * E2E tests for the Workspace "+" add-project menu:
 *  - The "+" opens the menu with exactly "Open Folder" and "Connect to GitHub".
 *  - "Open Folder" closes the menu and opens the existing NewSessionModal
 *    (workspace mode).
 *  - "Connect to GitHub" opens the URL form; a successful mock clone adds
 *    the repo to the Workspace rail (MockApi.connectGitHub is already wired).
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

  test('"Connect to GitHub" shows the URL form inside the menu', async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();

    // Menu items list is replaced by the form.
    await expect(page.getByTestId("connect-github-form")).toBeVisible();
    await expect(page.getByTestId("github-repo-url")).toBeVisible();
    await expect(page.getByTestId("connect-github-submit")).toBeVisible();
  });

  test("Connect to GitHub form: inline URL validation error for non-GitHub URL", async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();

    await page.getByTestId("github-repo-url").fill("https://gitlab.com/owner/repo");
    // Validation error appears inline.
    await expect(page.getByTestId("github-url-error")).toBeVisible();
    // Submit button stays enabled (text says Connect), but submitting would
    // show a client-side error.
  });

  test("Connect to GitHub: a successful mock clone adds the repo to the Workspace rail", async ({
    page,
  }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();

    await page.getByTestId("github-repo-url").fill("https://github.com/owner/my-test-repo");

    await page.getByTestId("connect-github-submit").click();

    // The form closes and the menu dismisses on success.
    await expect(page.getByTestId("add-project-menu")).not.toBeVisible();

    // The cloned repo name should appear in the workspace rail.
    // MockApi derives the name from the URL ("my-test-repo") and registers it.
    await expect(page.locator(".rail-tree")).toContainText("my-test-repo");
  });

  test("Connect to GitHub: error from mock is surfaced in the form", async ({
    page,
  }) => {
    // Navigate with the mockError flag so MockApi.connectGitHub rejects.
    await page.goto("/?seed=0&mockError=connectGitHub");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();

    await page.getByTestId("github-repo-url").fill("https://github.com/owner/repo");
    await page.getByTestId("connect-github-submit").click();

    // Error is shown in the form; menu stays open.
    await expect(page.getByTestId("connect-github-error")).toBeVisible();
    await expect(page.getByTestId("connect-github-form")).toBeVisible();
  });

  test("Back button in the form returns to the menu items", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
    await page.getByTestId("add-project-connect-github").click();
    await expect(page.getByTestId("connect-github-form")).toBeVisible();

    // Click the Back/ArrowLeft button (aria-label "Back to menu").
    await page.getByRole("button", { name: "Back to menu" }).click();

    // Menu items are visible again.
    await expect(page.getByTestId("add-project-menu-items")).toBeVisible();
    await expect(page.getByTestId("connect-github-form")).not.toBeVisible();
  });

  test("Escape or outside click dismisses the menu", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
    await expect(page.getByTestId("add-project-menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("add-project-menu")).not.toBeVisible();
  });
});
