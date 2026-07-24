import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { interceptMockTrack } from "./lib/api.js";
// Shared design-system layers first (tokens → primitives), then app styles.
// Composed here via JS imports rather than CSS @import so vite doesn't re-parse
// styles.css with a stricter (nesting-unaware) pass. Same files are shipped to
// the desktop onboarding window — single source of truth.
import "./theme-tokens.css";
import "./primitives.css";
import "./styles.css";

// In mock mode, intercept /api/track calls so Playwright tests can assert
// that track() events fire without a real server. No-op in real mode.
interceptMockTrack();

// The shell is viewport-locked (html/body overflow:hidden) — page scroll is
// never legitimate. overflow:hidden stops user scrolling but NOT the
// browser's internal scroll-focused-element-into-view (e.g. xterm's hidden
// helper textarea deep in scrollback), which moves scroll position
// programmatically. Snap back whenever anything manages to move it.
window.addEventListener(
  "scroll",
  () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  },
  { passive: true },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
