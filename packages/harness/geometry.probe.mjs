import { chromium } from "@playwright/test";
const [url, shot, fit] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
await p.keyboard.press("Escape");
await p.waitForTimeout(400);
await p.locator('[data-testid^="project-select-"]').first().click();
await p.waitForTimeout(7000);
if (fit === "fit") {
  await p.getByTestId("system-graph-fit").click();
  await p.waitForTimeout(700);
}

const report = await p.evaluate(() => {
  const num = (v) => parseFloat(v);
  const groups = [...document.querySelectorAll(".system-graph-group")].map((el) => ({
    id: el.getAttribute("data-group-id"),
    label: el.getAttribute("data-group-label"),
    count: Number(el.getAttribute("data-group-nodes")),
    x: num(el.style.left), y: num(el.style.top),
    w: num(el.style.width), h: num(el.style.height),
    // measured, not declared: what the browser actually laid out
    rect: el.getBoundingClientRect().toJSON(),
    labelText: el.querySelector(".system-graph-group-label")?.textContent ?? null,
    bg: getComputedStyle(el).backgroundColor,
    border: getComputedStyle(el).borderTopColor,
  }));
  const nodes = [...document.querySelectorAll(".system-graph-node")].map((el) => ({
    key: el.getAttribute("data-agent-key"),
    x: num(el.style.left), y: num(el.style.top),
    w: num(el.style.width), h: num(el.style.height),
    rect: el.getBoundingClientRect().toJSON(),
  }));
  const inside = (g, n) =>
    n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h;
  const homeless = nodes.filter((n) => !groups.some((g) => inside(g, n)));
  const doubled = nodes.filter((n) => groups.filter((g) => inside(g, n)).length > 1);
  const overlapping = [];
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], c = groups[j];
      if (!(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y))
        overlapping.push([a.label, c.label]);
    }
  const counted = groups.reduce((s, g) => s + nodes.filter((n) => inside(g, n)).length, 0);
  const subject = document.querySelector(".system-graph-subject");
  const viewport = document.querySelector(".system-graph-viewport").getBoundingClientRect();
  // Nothing may overflow the pane horizontally.
  const overflowRight = Math.max(0, ...groups.map((g) => g.rect.x + g.rect.width - viewport.right));
  return {
    subject: { w: num(subject.style.width), h: num(subject.style.height) },
    groupCount: groups.length,
    nodeCount: nodes.length,
    countedInsideContainers: counted,
    homeless: homeless.map((n) => n.key),
    doubled: doubled.map((n) => n.key),
    overlappingContainers: overlapping,
    labelsRendered: groups.map((g) => g.labelText),
    declaredCounts: groups.map((g) => [g.label, g.count]),
    firstContainerStyle: groups[0] ? { bg: groups[0].bg, border: groups[0].border } : null,
    overflowRightPx: Math.round(overflowRight),
    distinctRows: new Set(groups.map((g) => g.y)).size,
    distinctCols: new Set(groups.map((g) => g.x)).size,
  };
});
console.log(JSON.stringify(report, null, 1));
if (shot) await p.screenshot({ path: shot });
await b.close();
