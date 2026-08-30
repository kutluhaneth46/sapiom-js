import { chromium } from "@playwright/test";
const url = process.argv[2];
const shot = process.argv[3];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
p.on("console", (m) => { if (m.type() === "error") console.log("CONSOLEERR", m.text()); });
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForTimeout(2000);

// A first-run help overlay covers the rail; dismiss it.
await p.keyboard.press("Escape");
await p.waitForTimeout(500);

// Select the project row in the rail so the map altitude is on.
const project = p.locator('[data-testid^="project-select-"]').first();
if (await project.count()) await project.click();
await p.waitForTimeout(6000);

const data = await p.evaluate(() => {
  const subject = document.querySelector(".system-graph-subject");
  const groups = [...document.querySelectorAll(".system-graph-group")].map((el) => ({
    label: el.getAttribute("data-group-label"),
    nodes: Number(el.getAttribute("data-group-nodes")),
    box: { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) },
  }));
  const nodes = [...document.querySelectorAll(".system-graph-node")].map((el) => ({
    key: el.getAttribute("data-agent-key"),
    x: parseFloat(el.style.left), y: parseFloat(el.style.top),
  }));
  return {
    hasMap: !!document.querySelector('[data-testid="workspace-graph-view"]'),
    subject: subject ? { w: subject.style.width, h: subject.style.height } : null,
    groups,
    nodeCount: nodes.length,
    distinctX: new Set(nodes.map((n) => n.x)).size,
    distinctY: new Set(nodes.map((n) => n.y)).size,
    warning: document.querySelector('[data-testid="system-graph-warning"]')?.textContent ?? null,
  };
});
console.log(JSON.stringify(data, null, 1));
if (shot) await p.screenshot({ path: shot });
await b.close();
