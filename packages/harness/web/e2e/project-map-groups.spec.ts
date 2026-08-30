/**
 * SAP-2983 — the project map draws the groups the rail already has.
 *
 * The unit tests pin the two pure halves: `lib/system-graph-groups.test.ts`
 * decides which node belongs to which container, `lib/system-graph-layout.test.ts`
 * decides where the container goes. Neither can see the thing the ticket is
 * about — that the map READS the rail's arrangement at all, and that the two
 * surfaces agree on screen. A layout rule is not proven by a unit test, and a
 * map drawing a second opinion of the same groups would pass every one of them.
 *
 * `?mockFixtures=deep` is the fixture with a real group axis: `MOCK_LAUNCH_EDGES`
 * produces a three-member component (gateway), a two-member one (mailer), an
 * edge to an agent this install lacks, and agents no edge reaches — plus
 * `MOCK_POLSIA_GRAPH_EDGES`, whose connectors run BETWEEN those groups, which is
 * the cross-container case.
 *
 * Every assertion here was mutation-tested; what each mutation was, and which
 * assertion caught it, is on the PR.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** The container labels the map draws, in DOM order. */
const mapContainers = (page: Page): Promise<(string | null)[]> =>
  page
    .locator(".system-graph-group")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-group-label")),
    );

/** The group rows the RAIL draws for polsia, in DOM order. */
const railGroups = (page: Page): Promise<string[]> =>
  page
    .getByTestId("workspace-group-polsia")
    .locator('[data-testid^="group-row-"] .tree-row-label')
    .allInnerTexts();

/** Switch the rail to the Group axis and wait for it to be editable. */
async function openGroupAxis(page: Page): Promise<void> {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("filing-group-by").selectOption("group");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("group-create-polsia")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=deep");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("project-select-polsia").click();
  await expect(page.getByTestId("workspace-graph-view")).toBeVisible();
  await expect(page.locator(".system-graph-group").first()).toBeVisible();
});

test("one labelled container per group, named exactly as the rail names it", async ({
  page,
}) => {
  // The whole ticket. Two names for one group is the failure it prevents, and
  // it is only visible with both surfaces on screen at once.
  await expect(page.locator(".system-graph-group")).toHaveCount(3);
  expect(await mapContainers(page)).toEqual(["gateway", "mailer", "Ungrouped"]);

  await openGroupAxis(page);
  expect(await railGroups(page)).toEqual(await mapContainers(page));
});

test("every card sits inside exactly one container, measured", async ({
  page,
}) => {
  /* GEOMETRY, not counts. A container assertion that still passes when the
     cards are drawn outside their boxes is worthless — and the boxes are
     absolutely positioned siblings of the cards, not their DOM parents, so
     "inside" is a claim only measurement can settle. */
  const placement = await page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const groups = [...document.querySelectorAll(".system-graph-group")].map(
      (el) => ({ label: el.getAttribute("data-group-label"), rect: box(el) }),
    );
    const contains = (outer: DOMRect, inner: DOMRect) =>
      inner.left >= outer.left - 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.bottom <= outer.bottom + 0.5;
    return [...document.querySelectorAll(".system-graph-node")].map((el) => ({
      key: el.getAttribute("data-agent-key"),
      in: groups
        .filter((group) => contains(group.rect, box(el)))
        .map((group) => group.label),
    }));
  });

  expect(placement.length).toBeGreaterThan(0);
  for (const card of placement) {
    expect(card.in, `${card.key} is in exactly one container`).toHaveLength(1);
  }
  expect(
    placement.filter((card) => card.in[0] === "gateway").map((c) => c.key).sort(),
  ).toEqual(["ads-worker", "gateway", "queue"]);
  expect(
    placement.filter((card) => card.in[0] === "mailer").map((c) => c.key).sort(),
  ).toEqual(["mailer", "sender"]);
});

test("containers do not overlap, and none is drawn outside the map's own bounds", async ({
  page,
}) => {
  /* The subject box IS the layout's bounds, and the viewport's fit, its zoom
     floor and its "did the stored view still show anything" check all read
     them. A container drawn outside them is a container Fit cannot bring on
     screen — and it is invisible to any assertion that only counts boxes,
     which is how a row overflowing its rail by 17px shipped. */
  const measured = await page.evaluate(() => {
    const rects = [...document.querySelectorAll(".system-graph-group")].map(
      (el) => el.getBoundingClientRect(),
    );
    const overlaps: string[] = [];
    for (let left = 0; left < rects.length; left += 1) {
      for (let right = left + 1; right < rects.length; right += 1) {
        const a = rects[left]!;
        const b = rects[right]!;
        if (
          !(
            a.right <= b.left ||
            b.right <= a.left ||
            a.bottom <= b.top ||
            b.bottom <= a.top
          )
        ) {
          overlaps.push(`${left}/${right}`);
        }
      }
    }
    const subject = document
      .querySelector(".system-graph-subject")!
      .getBoundingClientRect();
    const escaping = rects.filter(
      (rect) =>
        rect.left < subject.left - 0.5 ||
        rect.top < subject.top - 0.5 ||
        rect.right > subject.right + 0.5 ||
        rect.bottom > subject.bottom + 0.5,
    ).length;
    return { count: rects.length, overlaps, escaping };
  });
  expect(measured.count).toBe(3);
  expect(measured.overlaps).toEqual([]);
  expect(measured.escaping).toBe(0);
});

test("a rail edit moves the map, with no reload", async ({ page }) => {
  /* The rail and the map are two views of ONE arrangement. Two copies of the
     state is exactly how they come to disagree: the file is the only shared
     medium and nothing re-reads it, so an edit in the rail would leave the map
     drawing what it read on mount. */
  await openGroupAxis(page);
  expect(await mapContainers(page)).toContain("gateway");

  await page.getByTestId("group-rename-gateway").click();
  await page.getByTestId("group-rename-input").fill("Ingest");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => mapContainers(page))
    .toEqual(["Ingest", "mailer", "Ungrouped"]);
  expect(await railGroups(page)).toEqual(await mapContainers(page));
});

test("an edge whose ends the user split across groups is still drawn", async ({
  page,
}) => {
  /* Pull one member out of a detected system and the connector between the
     halves is still real. Dropping it would make the map claim two systems
     never touch, which is the one thing an edge is for. */
  await openGroupAxis(page);
  const before = await page
    .locator('[data-testid^="system-graph-edge-"]')
    .count();
  expect(before).toBeGreaterThan(0);

  // `queue` leaves every group — the drop-on-Ungrouped gesture, applied
  // through the rail's own delete of the group that holds it.
  await page.getByTestId("group-delete-mailer").click();
  await expect.poll(() => mapContainers(page)).toEqual(["gateway", "Ungrouped"]);

  const after = await page
    .locator('[data-testid^="system-graph-edge-"]')
    .count();
  expect(after).toBe(before);
  await expect(page.locator(".system-graph-edge.is-cross-group")).not.toHaveCount(
    0,
  );
});
