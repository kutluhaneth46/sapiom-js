import { chromium } from "@playwright/test";
const [url] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.keyboard.press("Escape");
await p.waitForTimeout(400);
await p.locator('[data-testid^="project-select-"]').first().click();
await p.waitForTimeout(7000);
const read = async (tag) => {
  const r = await p.evaluate(() => {
    const zoom = document.querySelector('[data-testid="system-graph-zoom-reset"]').textContent;
    const el = document.querySelector(".system-graph-group-label");
    const node = document.querySelector(".system-graph-node-label");
    return {
      zoom,
      groupLabelPx: el ? +el.getBoundingClientRect().height.toFixed(2) : null,
      groupLabelWidthPx: el ? +el.getBoundingClientRect().width.toFixed(2) : null,
      nodeLabelPx: node ? +node.getBoundingClientRect().height.toFixed(2) : null,
    };
  });
  console.log(tag, JSON.stringify(r));
};
await read("arrival ");
await p.getByTestId("system-graph-fit").click();
await p.waitForTimeout(600);
await read("fitted  ");
await b.close();
