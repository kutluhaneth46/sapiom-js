/**
 * E2E tests verifying that the DirectoryPicker (session mode) is unaffected
 * by the Add workspace flow changes.
 *
 * Note: The FolderBrowser component (browse-first Open Folder) was superseded
 * by AddWorkspaceDialog.HaveProjectDoor (text input + detection) in the
 * main branch merge. The workspace add flow now goes through:
 *   + → Add menu (aw-door-have) → AddWorkspaceDialog → dir-picker-input
 *
 * Runs against `vite dev --port 5299` with VITE_MOCK=1.
 */
import { expect, test } from "@playwright/test";

test.describe("FolderBrowser — does not affect other DirectoryPicker callers", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("new-session modal (session mode) still uses DirectoryPicker, not FolderBrowser", async ({ page }) => {
    await page.getByTestId("add-workspace").click();
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
