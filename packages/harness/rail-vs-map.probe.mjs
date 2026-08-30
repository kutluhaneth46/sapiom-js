import { chromium } from "@playwright/test";
const url = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
p.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.keyboard.press("Escape");
await p.waitForTimeout(400);

await p.locator('[data-testid^="project-select-"]').first().click();
await p.waitForTimeout(6000);

const mapLabels = await p.$$eval(".system-graph-group", (els) =>
  els.map((el) => el.getAttribute("data-group-label")),
);

// Switch the RAIL to the Group axis and read its rows.
await p.getByTestId("history-trigger").click();
await p.getByTestId("filing-group-by").selectOption("group");
await p.keyboard.press("Escape");
await p.waitForTimeout(2500);
const railLabels = await p.$$eval(
  '[data-testid^="group-row-"] .tree-row-label',
  (els) => els.map((el) => el.textContent.trim()),
);
const mapAfterAxis = await p.$$eval(".system-graph-group", (els) =>
  els.map((el) => el.getAttribute("data-group-label")),
);

console.log(JSON.stringify({ mapLabels, railLabels, mapAfterAxis, match: JSON.stringify(mapLabels) === JSON.stringify(railLabels) }, null, 1));
await p.screenshot({ path: "/tmp/shots-2983/real-rail-and-map.png" });
await b.close();
