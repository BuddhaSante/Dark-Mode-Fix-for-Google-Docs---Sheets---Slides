// DR Excluder — content script for Google Docs / Sheets / Slides
//
// Core idea: when Dark Reader is in Dynamic mode, it injects inline hooks
// (data-darkreader-inline-* attributes + --darkreader-inline-* CSS vars) and
// sometimes filter transforms that make the editor surface unreadable.
// We temporarily remove/override those hooks, but we record everything we touch
// so we can restore it when the extension is turned off (no refresh needed).

// -------- Storage keys --------

// Master exclusion toggle (backward compatible)
const KEY_MASTER = "dr_exclude_content_dynamic_v1";

// Master in-page toggle (backward compatible)
const KEY_OVERLAY_MASTER = "dr_show_overlay_v1"; // default: true

// Per-app exclusion toggles (default: true)
const KEY_DOCS_EXCLUDE = "dr_exclude_docs_v1";
const KEY_SHEETS_EXCLUDE = "dr_exclude_sheets_v1";
const KEY_SLIDES_EXCLUDE = "dr_exclude_slides_v1";

// Per-app in-page button toggles (default: true)
const KEY_DOCS_OVERLAY = "dr_overlay_docs_v1";
const KEY_SHEETS_OVERLAY = "dr_overlay_sheets_v1";
const KEY_SLIDES_OVERLAY = "dr_overlay_slides_v1";

// In-page button positioning
const KEY_POS_MODE = "dr_overlay_pos_mode_v1";      // "corner" | "custom"
const KEY_POS_CORNER = "dr_overlay_pos_corner_v1";  // "br" | "bl" | "tr" | "tl"
const KEY_POS_DOCS = "dr_overlay_pos_docs_v1";      // {x,y}
const KEY_POS_SHEETS = "dr_overlay_pos_sheets_v1";  // {x,y}
const KEY_POS_SLIDES = "dr_overlay_pos_slides_v1";  // {x,y}

// -------- DOM ids --------
const STYLE_ID = "dr-exclude-content-dynamic-style-v6";
const OVERLAY_ID = "dr-exclude-overlay-v2";

// -------- Helpers --------

function pathIsDocs() {
  return location.pathname.startsWith("/document/");
}
function pathIsSheets() {
  return location.pathname.startsWith("/spreadsheets/");
}
function pathIsSlides() {
  return location.pathname.startsWith("/presentation/");
}
function isEditorPage() {
  return pathIsDocs() || pathIsSheets() || pathIsSlides();
}

function getCurrentApp() {
  if (pathIsDocs()) return "docs";
  if (pathIsSheets()) return "sheets";
  if (pathIsSlides()) return "slides";
  return "other";
}

function isDarkReaderDynamicLike() {
  // Strict: only treat Dark Reader as active when it declares Dynamic mode on <html>.
  // This makes the popup indicator react immediately when DR is toggled off for the site.
  return document.documentElement.getAttribute("data-darkreader-mode") === "dynamic";
}

function boolOrDefault(v, dflt) {
  return typeof v === "boolean" ? v : dflt;
}

function ensureStyleEl() {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.documentElement.appendChild(el);
  }
  return el;
}

function setImportant(el, prop, value) {
  try {
    el.style.setProperty(prop, value, "important");
  } catch (_) {}
}

// -------- Patch/restore (fixes the "needs refresh" hang) --------

/**
 * We must restore everything we remove/override, otherwise Dark Reader may not
 * re-apply until refresh.
 */
// Element -> { attrs: {k:v}, styles: {k:{value,priority,had}} }
//
// Important nuance for the "hang on disable" bug:
// Dark Reader can update its inline hooks over time. If we only remember the
// *first* value we ever saw, restoring on disable can re-apply stale values
// and leave the editor in a visually stuck state until refresh.
//
// Strategy:
// - For Dark Reader inline hooks we *remove* (data-darkreader-inline-* and
//   --darkreader-inline-*), store the **latest** value we saw before removal.
// - For properties we *override* ourselves (e.g., canvas filter = none), store
//   the **first** value (the true baseline) so we can return to it.
const patched = new Map();

// For certain inline overrides (filters), a stale baseline is a common source of
// the "hang on disable" symptom. Track these more defensively.
const VOLATILE_OVERRIDE_PROPS = new Set(["filter", "-webkit-filter"]);

function ensurePatchRecord(el) {
  let rec = patched.get(el);
  if (!rec) {
    rec = { attrs: Object.create(null), styles: Object.create(null) };
    patched.set(el, rec);
  }
  return rec;
}

function recordStylePropFirst(el, prop) {
  const rec = ensurePatchRecord(el);
  if (rec.styles[prop]) return;
  const value = el.style.getPropertyValue(prop);
  const priority = el.style.getPropertyPriority(prop);
  const had = value !== "" || priority !== "";
  rec.styles[prop] = { value, priority, had };
}

function recordStylePropLast(el, prop) {
  const rec = ensurePatchRecord(el);
  const value = el.style.getPropertyValue(prop);
  const priority = el.style.getPropertyPriority(prop);
  const had = value !== "" || priority !== "";
  // Always overwrite with the latest value.
  rec.styles[prop] = { value, priority, had };
}

function patchRemoveAttr(el, name) {
  const v = el.getAttribute(name);
  if (v === null) return;
  const rec = ensurePatchRecord(el);
  // Always keep the latest value.
  rec.attrs[name] = v;
  el.removeAttribute(name);
}

function patchRemoveStyleProp(el, prop) {
  // Always keep the latest value (Dark Reader can update over time).
  recordStylePropLast(el, prop);
  try {
    el.style.removeProperty(prop);
  } catch (_) {}
}

function patchSetStyleImportant(el, prop, value) {
  // For most overrides we want the first-seen inline baseline. For filter
  // overrides we avoid capturing our own value as the baseline (which would
  // make disable appear "stuck").
  const rec = ensurePatchRecord(el);

  if (VOLATILE_OVERRIDE_PROPS.has(prop)) {
    const currValue = el.style.getPropertyValue(prop);
    const currPriority = el.style.getPropertyPriority(prop);
    const isAlreadyOurs = currValue.trim() === String(value).trim() && currPriority === "important";

    if (!isAlreadyOurs) {
      const had = currValue !== "" || currPriority !== "";
      rec.styles[prop] = { value: currValue, priority: currPriority, had };
    } else if (!rec.styles[prop]) {
      // If the element already has our override (e.g., cloned node), prefer
      // treating the baseline as "absent" so disable removes the override.
      rec.styles[prop] = { value: "", priority: "", had: false };
    }
  } else if (!rec.styles[prop]) {
    // First-seen inline baseline.
    const v = el.style.getPropertyValue(prop);
    const p = el.style.getPropertyPriority(prop);
    const had = v !== "" || p !== "";
    rec.styles[prop] = { value: v, priority: p, had };
  }

  setImportant(el, prop, value);
}


function restoreAllPatches({ clear = true } = {}) {
  if (!patched.size) return;

  for (const [el, rec] of patched) {
    // If the element is gone, skip.
    if (!(el instanceof Element)) continue;

    // Restore attributes
    for (const name of Object.keys(rec.attrs)) {
      try {
        el.setAttribute(name, rec.attrs[name]);
      } catch (_) {}
    }

    // Restore inline styles/vars
    for (const prop of Object.keys(rec.styles)) {
      const s = rec.styles[prop];
      try {
        if (!s.had) {
          el.style.removeProperty(prop);
        } else {
          // Restore with previous priority if any.
          el.style.setProperty(prop, s.value, s.priority || "");
        }
      } catch (_) {}
    }
  }

  if (clear) patched.clear();
}

// -------- Dark Reader hook stripping (with patch recording) --------

function stripDarkReaderInline(el) {
  if (!(el instanceof Element)) return;

  // Remove any data-darkreader-inline-* attributes (but record first).
  if (el.hasAttributes()) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-darkreader-inline-")) {
        patchRemoveAttr(el, attr.name);
      }
    }
  }

  // Remove any --darkreader-inline-* CSS vars from inline style (record first).
  if (el.style && el.style.length) {
    for (let i = el.style.length - 1; i >= 0; i--) {
      const prop = el.style[i];
      if (prop && prop.startsWith("--darkreader-inline-")) {
        patchRemoveStyleProp(el, prop);
      }
    }
  }
}

function stripDarkReaderInlineInRoot(root, { svgOnly = false } = {}) {
  if (!root || !(root instanceof Element)) return;

  if (svgOnly) {
    if (root.matches && (root.matches("svg") || root.matches("svg *"))) {
      stripDarkReaderInline(root);
    }
    const svgs = root.querySelectorAll("svg, svg *");
    for (const el of svgs) stripDarkReaderInline(el);
    return;
  }

  stripDarkReaderInline(root);

  const selectorParts = [
    "[data-darkreader-inline-fill]",
    "[data-darkreader-inline-stroke]",
    "[data-darkreader-inline-bgcolor]",
    "[data-darkreader-inline-bgimage]",
    "[data-darkreader-inline-border-top]",
    "[data-darkreader-inline-border-right]",
    "[data-darkreader-inline-border-bottom]",
    "[data-darkreader-inline-border-left]",
    "[style*='--darkreader-inline-']",
  ];
  const nodes = root.querySelectorAll(selectorParts.join(","));
  for (const el of nodes) stripDarkReaderInline(el);
}

function clearCanvasFilters(root) {
  if (!root) return;
  if (root instanceof HTMLCanvasElement) {
    patchSetStyleImportant(root, "filter", "none");
    patchSetStyleImportant(root, "-webkit-filter", "none");
    return;
  }
  const canvases = root.querySelectorAll("canvas");
  for (const c of canvases) {
    patchSetStyleImportant(c, "filter", "none");
    patchSetStyleImportant(c, "-webkit-filter", "none");
  }
}

function applySlidesThumbInversion(filmRoot, invertEnabled) {
  if (!filmRoot) return;

  const svgs = filmRoot.querySelectorAll("svg");
  for (const svg of svgs) {
    const looksLikeSlide = !!svg.querySelector("[id^='editor-p']");
    if (!looksLikeSlide) continue;

    if (invertEnabled) {
      patchSetStyleImportant(svg, "filter", "invert(1) hue-rotate(180deg)");
      patchSetStyleImportant(svg, "-webkit-filter", "invert(1) hue-rotate(180deg)");
    }
  }
}

// -------- Mutation watcher --------

function watchMutations(
  root,
  isStillEnabled,
  { svgOnly = false, alsoCanvas = false, watchAttributes = false, onMutations = null } = {}
) {
  if (!root) return null;

  let cleaning = false;

  const obs = new MutationObserver((mutations) => {
    if (!isStillEnabled()) return;
    if (cleaning) return;

    cleaning = true;
    try {
      for (const m of mutations) {
        if (!isStillEnabled()) break;

        if (m.type === "childList") {
          for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;

            if (svgOnly) {
              if (n.matches("svg") || n.querySelector("svg")) {
                stripDarkReaderInlineInRoot(n, { svgOnly: true });
              }
            } else {
              stripDarkReaderInlineInRoot(n, { svgOnly: false });
            }

            if (alsoCanvas) clearCanvasFilters(n);
          }
          continue;
        }

        if (m.type === "attributes" && watchAttributes) {
          const t = m.target;
          if (!(t instanceof Element)) continue;
          const an = m.attributeName || "";
          if (an === "style" || an.startsWith("data-darkreader-inline-")) {
            if (svgOnly) {
              const isSvg =
                t.namespaceURI === "http://www.w3.org/2000/svg" ||
                (t.closest && t.closest("svg"));
              if (isSvg) stripDarkReaderInline(t);
            } else {
              stripDarkReaderInline(t);
            }
            if (alsoCanvas && t instanceof HTMLCanvasElement) clearCanvasFilters(t);
          }
        }
      }

      if (typeof onMutations === "function") {
        onMutations(mutations);
      }
    } finally {
      cleaning = false;
    }
  });

  obs.observe(root, {
    subtree: true,
    childList: true,
    attributes: !!watchAttributes,
  });

  return obs;
}

let observers = [];
function disconnectAll() {
  for (const o of observers) {
    try {
      o.disconnect();
    } catch (_) {}
  }
  observers = [];
}

// -------- App-specific fixes --------

function buildCSS(excludeEnabled) {
  if (!excludeEnabled) return "";
  return `
html[data-darkreader-mode="dynamic"] #docs-editor .kix-page-paginated canvas.kix-canvas-tile-content {
  filter: none !important;
  -webkit-filter: none !important;
}
html[data-darkreader-mode="dynamic"] #docs-editor .kix-page-paginated {
  filter: none !important;
  -webkit-filter: none !important;
}
`;
}

function applyDocsFix(isStillEnabled) {
  const fix = () => {
    if (!isStillEnabled()) return;
    const root = document.getElementById("docs-editor");
    if (!root) return;

    const canvases = root.querySelectorAll(
      ".kix-page-paginated canvas.kix-canvas-tile-content"
    );
    for (const c of canvases) {
      patchSetStyleImportant(c, "filter", "none");
      patchSetStyleImportant(c, "-webkit-filter", "none");
    }
    const pages = root.querySelectorAll(".kix-page-paginated");
    for (const p of pages) {
      patchSetStyleImportant(p, "filter", "none");
      patchSetStyleImportant(p, "-webkit-filter", "none");
    }
  };

  fix();

  const root = document.getElementById("docs-editor") || document.body;
  const obs = new MutationObserver(() => fix());
  obs.observe(root, { subtree: true, childList: true });
  observers.push(obs);
}

function findSheetsRoots() {
  const roots = [];
  roots.push(...document.querySelectorAll("[id$='-grid-table-container']"));
  if (roots.length) return roots;

  const maybe =
    document.querySelector(".grid-scrollable-wrapper") ||
    document.querySelector(".grid-table-container") ||
    document.querySelector(".grid4-inner-container");
  if (maybe) roots.push(maybe);
  return roots;
}

function applySheetsFix(isStillEnabled) {
  const roots = findSheetsRoots();
  if (!roots.length) return;

  for (const root of roots) {
    if (!isStillEnabled()) return;

    stripDarkReaderInlineInRoot(root, { svgOnly: false });
    clearCanvasFilters(root);

    const obs = watchMutations(root, isStillEnabled, {
      svgOnly: false,
      alsoCanvas: true,
      watchAttributes: true,
    });
    if (obs) observers.push(obs);
  }
}

function findSlidesStageRoot() {
  return (
    document.getElementById("pages") ||
    document.querySelector("#workspace #pages") ||
    document.querySelector("#workspace [id='pages']")
  );
}

function findSlidesFilmstripRoot() {
  const selectors = [
    "#filmstrip",
    "[id*='filmstrip']",
    ".punch-filmstrip",
    ".punch-filmstrip-scroll",
    ".punch-filmstrip-container",
    ".punch-filmstrip-view",
    ".filmstrip",
    ".filmstrip-view",
    "#slide-filmstrip",
    "[aria-label='Slides']",
    "[aria-label*='Slides']",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && (el.querySelector("svg") || el.matches("svg"))) return el;
  }
  return null;
}

function applySlidesFix(isStillEnabled, { invertThumbs } = { invertThumbs: true }) {
  const stage = findSlidesStageRoot();
  if (stage) {
    stripDarkReaderInlineInRoot(stage, { svgOnly: false });

    const obsStage = watchMutations(stage, isStillEnabled, {
      svgOnly: false,
      alsoCanvas: false,
      watchAttributes: true,
    });
    if (obsStage) observers.push(obsStage);
  }

  const film = findSlidesFilmstripRoot();
  if (film) {
    stripDarkReaderInlineInRoot(film, { svgOnly: true });
    applySlidesThumbInversion(film, !!invertThumbs);

    const obsFilm = watchMutations(film, isStillEnabled, {
      svgOnly: true,
      alsoCanvas: false,
      watchAttributes: true,
      onMutations: () => applySlidesThumbInversion(film, !!invertThumbs),
    });
    if (obsFilm) observers.push(obsFilm);
  }
}

// -------- State --------

let currentMasterEnabled = false;
let currentOverlayMasterEnabled = true;

let currentDocsEnabled = true;
let currentSheetsEnabled = true;
let currentSlidesEnabled = true;

let currentDocsOverlayEnabled = true;
let currentSheetsOverlayEnabled = true;
let currentSlidesOverlayEnabled = true;

let currentPosMode = "corner";
let currentPosCorner = "br";
let currentPosDocs = null;   // {x,y}
let currentPosSheets = null; // {x,y}
let currentPosSlides = null; // {x,y}

function getCurrentAppExcludeEnabled() {
  if (pathIsDocs()) return currentDocsEnabled;
  if (pathIsSheets()) return currentSheetsEnabled;
  if (pathIsSlides()) return currentSlidesEnabled;
  return true;
}

function getEffectiveExcludeEnabled() {
  return currentMasterEnabled && getCurrentAppExcludeEnabled();
}

function getCurrentAppOverlayEnabled() {
  if (pathIsDocs()) return currentDocsOverlayEnabled;
  if (pathIsSheets()) return currentSheetsOverlayEnabled;
  if (pathIsSlides()) return currentSlidesOverlayEnabled;
  return false;
}

function shouldShowOverlay() {
  return currentOverlayMasterEnabled && getCurrentAppOverlayEnabled();
}

function getCurrentAppExcludeKey() {
  if (pathIsDocs()) return KEY_DOCS_EXCLUDE;
  if (pathIsSheets()) return KEY_SHEETS_EXCLUDE;
  if (pathIsSlides()) return KEY_SLIDES_EXCLUDE;
  return null;
}

function getCurrentAppIconFile() {
  if (pathIsDocs()) return "docs_icon.png";
  if (pathIsSheets()) return "sheets_icon.png";
  if (pathIsSlides()) return "slides_icon.png";
  return "docs_icon.png";
}

function getCurrentAppPosKey() {
  if (pathIsDocs()) return KEY_POS_DOCS;
  if (pathIsSheets()) return KEY_POS_SHEETS;
  if (pathIsSlides()) return KEY_POS_SLIDES;
  return null;
}

function getStoredCustomPosForCurrentApp() {
  if (pathIsDocs()) return currentPosDocs;
  if (pathIsSheets()) return currentPosSheets;
  if (pathIsSlides()) return currentPosSlides;
  return null;
}

// -------- In-page overlay (floating button) --------

function removeOverlay() {
  const existing = document.getElementById(OVERLAY_ID);
  if (!existing) return;
  try {
    if (typeof existing.__drExcludeCleanup === "function") existing.__drExcludeCleanup();
  } catch (_) {}
  existing.remove();
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// -------- Color / surface helpers (for in-page toggle styling) --------
function parseRgba(cssColor) {
  if (!cssColor || typeof cssColor !== "string") return null;
  const m = cssColor.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(",").map((p) => p.trim());
  if (parts.length < 3) return null;
  const r = Number(parts[0]);
  const g = Number(parts[1]);
  const b = Number(parts[2]);
  const a = parts.length >= 4 ? Number(parts[3]) : 1;
  if (![r, g, b, a].every((n) => Number.isFinite(n))) return null;
  return { r, g, b, a };
}

function srgbToLinear(v255) {
  const v = v255 / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function getOpaqueBgColor(el, maxHops = 8) {
  let cur = el;
  for (let i = 0; i < maxHops && cur; i++) {
    try {
      const c = parseRgba(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0.05) return c;
    } catch (_) {}
    cur = cur.parentElement;
  }
  // Fallbacks
  try {
    const body = document.body && parseRgba(getComputedStyle(document.body).backgroundColor);
    if (body && body.a > 0.05) return body;
  } catch (_) {}
  try {
    const html = parseRgba(getComputedStyle(document.documentElement).backgroundColor);
    if (html && html.a > 0.05) return html;
  } catch (_) {}
  return { r: 18, g: 18, b: 18, a: 1 };
}

function surfaceModeFromColor(c) {
  // Threshold tuned so mid-grays still count as "dark" (prevents white styling in dark chrome).
  const lum = relativeLuminance(c);
  return lum > 0.62 ? "light" : "dark";
}

function getSurfaceModeUnderPoint(x, y) {
  const host = document.getElementById(OVERLAY_ID);
  let el = null;

  // Temporarily make the overlay non-hit-testable so we can sample what's behind it.
  if (host) {
    const prev = host.style.pointerEvents;
    host.style.pointerEvents = "none";
    try {
      el = document.elementFromPoint(x, y);
    } catch (_) {}
    host.style.pointerEvents = prev;
  } else {
    try {
      el = document.elementFromPoint(x, y);
    } catch (_) {}
  }

  if (!el) return "dark";
  const c = getOpaqueBgColor(el);
  return surfaceModeFromColor(c);
}

function getOverlaySurfaceMode(wrapEl) {
  try {
    const r = wrapEl.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return getSurfaceModeUnderPoint(x, y);
  } catch (_) {
    // Last-resort heuristic
    const c = getOpaqueBgColor(document.body || document.documentElement);
    return surfaceModeFromColor(c);
  }
}

// Normalizes DOMRect-like objects into a plain rect with stable width/height.
// Some Slides containers report odd/partial rects during load/transform.
function normalizeRect(r) {
  if (!r) return null;
  const left = Number.isFinite(r.left) ? r.left : 0;
  const top = Number.isFinite(r.top) ? r.top : 0;
  const right = Number.isFinite(r.right)
    ? r.right
    : left + (Number.isFinite(r.width) ? r.width : 0);
  const bottom = Number.isFinite(r.bottom)
    ? r.bottom
    : top + (Number.isFinite(r.height) ? r.height : 0);
  const width = Number.isFinite(r.width) ? r.width : Math.max(0, right - left);
  const height = Number.isFinite(r.height) ? r.height : Math.max(0, bottom - top);
  return { left, top, right, bottom, width, height };
}


function isElementVisibleForPanel(el) {
  try {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const op = parseFloat(cs.opacity || "1");
    if (!Number.isFinite(op) || op <= 0.05) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function looksLikeRightSidePanel(el, r) {
  if (!el || !r) return false;
  if (!isElementVisibleForPanel(el)) return false;

  const tag = (el.tagName || "").toUpperCase();
  if (tag === "HTML" || tag === "BODY") return false;

  // Must hug the right edge and be panel-ish.
  if (r.right < window.innerWidth - 1) return false;
  if (r.width < 220 || r.height < 240) return false;

  // Must live on the right half.
  if (r.left < window.innerWidth * 0.45) return false;
  if (r.width > window.innerWidth * 0.70) return false;

  // Ignore our own overlay.
  try {
    if (el.id === OVERLAY_ID) return false;
    if (el.closest && el.closest(`#${OVERLAY_ID}`)) return false;
  } catch (_) {}

  return true;
}

function findRightSidePanelRect() {
  const x = Math.max(0, window.innerWidth - 6);
  const ys = [
    120,
    Math.round(window.innerHeight * 0.5),
    Math.max(120, window.innerHeight - 160),
  ];

  let best = null;

  for (const y of ys) {
    let el = null;
    try {
      el = document.elementFromPoint(x, y);
    } catch (_) {
      el = null;
    }
    if (!(el instanceof Element)) continue;

    let cur = el;
    let candidate = null;
    for (let i = 0; i < 10 && cur && cur instanceof Element; i++) {
      const r = normalizeRect(cur.getBoundingClientRect());
      if (looksLikeRightSidePanel(cur, r)) candidate = r;
      cur = cur.parentElement;
    }

    if (candidate) {
      if (!best || candidate.width > best.width) best = candidate;
    }
  }

  return best;
}

function adjustSafeRectForRightPanel(r) {
  const panel = findRightSidePanelRect();
  if (!panel) return r;

  const PAD = 10;
  const right = Math.min(r.right, panel.left - PAD);
  if (right <= r.left + 140) return r;

  return {
    ...r,
    right,
    width: Math.max(0, right - r.left),
  };
}

/**
 * Positioning is clamped into a "safe" rect anchored to the editor surface,
 * not the full viewport. This pulls the button inward and reduces collisions
 * with browser extensions that also live in the viewport corners.
 */
function getOverlaySafeRect() {
  let base = null;

  // Docs: the editor surface.
  if (pathIsDocs()) {
    const el =
      document.querySelector("#docs-editor .kix-appview-editor") ||
      document.querySelector("#docs-editor") ||
      null;
    if (el) base = normalizeRect(el.getBoundingClientRect());
  }

  // Sheets: the grid container.
  if (!base && pathIsSheets()) {
    const roots = findSheetsRoots();
    if (roots && roots.length) base = normalizeRect(roots[0].getBoundingClientRect());
  }

  // Slides: stage/pages area.
  if (!base && pathIsSlides()) {
    const candidates = [
      findSlidesStageRoot(),
      document.querySelector("#workspace"),
      document.querySelector("#editor") || document.body,
    ].filter(Boolean);

    let best = null;
    for (const el of candidates) {
      const r = normalizeRect(el.getBoundingClientRect());
      if (!r) continue;
      if (!best || r.height > best.height) best = r;
    }

    if (best) base = best;
  }

  // Fallback: viewport.
  if (!base) {
    base = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  // If a right-side panel overlays the viewport edge (Docs side panel, etc.),
  // shrink the safe rect so the button stays visible.
  return adjustSafeRectForRightPanel(base);
}

function applyOverlayPosition(wrap, { mode, corner, custom } = {}) {
  const BTN = 52;
  const MARGIN = 10;

  const r = getOverlaySafeRect();
  const minX = r.left + MARGIN;
  const minY = r.top + MARGIN;
  const maxX = r.right - BTN - MARGIN;
  const maxY = r.bottom - BTN - MARGIN;

  // If the safe rect is invalid (rare, but possible during initial load),
  // fall back to viewport bounds.
  const safeMinX = Number.isFinite(minX) ? minX : MARGIN;
  const safeMinY = Number.isFinite(minY) ? minY : MARGIN;
  const safeMaxX = Number.isFinite(maxX) ? maxX : window.innerWidth - BTN - MARGIN;
  const safeMaxY = Number.isFinite(maxY) ? maxY : window.innerHeight - BTN - MARGIN;

  // If the safe rect is too small (max < min), fall back per-axis to viewport.
  const axisMinX = safeMaxX >= safeMinX ? safeMinX : MARGIN;
  const axisMaxX = safeMaxX >= safeMinX ? safeMaxX : window.innerWidth - BTN - MARGIN;
  const axisMinY = safeMaxY >= safeMinY ? safeMinY : MARGIN;
  const axisMaxY = safeMaxY >= safeMinY ? safeMaxY : window.innerHeight - BTN - MARGIN;

  const clampX = (x) => clamp(x, axisMinX, axisMaxX);
  const clampY = (y) => clamp(y, axisMinY, axisMaxY);

  // Always set explicit left/top. (Simplifies clamping + drag.)
  wrap.style.right = "auto";
  wrap.style.bottom = "auto";

  // --- Custom/drag mode ---
  if (mode === "custom" && custom && typeof custom.x === "number" && typeof custom.y === "number") {
    wrap.style.left = `${clampX(custom.x)}px`;
    wrap.style.top = `${clampY(custom.y)}px`;
    return;
  }

  // --- Corner presets (inward + vertical tweaks) ---
  // Pull in more on X; bottom presets are lower on screen (smaller bottom inset);
  // top presets are pushed down a bit.
  const INSET_X = 84;
  const INSET_TOP = 54;
  // Slides: lift the default bottom presets a bit so the button doesn't overlap
  // the speaker notes bar.
  const INSET_BOTTOM = pathIsSlides() ? 76 : 44;

  const c = corner || "br";
  if (c === "br") {
    wrap.style.left = `${clampX(r.right - BTN - INSET_X)}px`;
    wrap.style.top = `${clampY(r.bottom - BTN - INSET_BOTTOM)}px`;
  } else if (c === "bl") {
    wrap.style.left = `${clampX(r.left + INSET_X)}px`;
    wrap.style.top = `${clampY(r.bottom - BTN - INSET_BOTTOM)}px`;
  } else if (c === "tr") {
    wrap.style.left = `${clampX(r.right - BTN - INSET_X)}px`;
    wrap.style.top = `${clampY(r.top + INSET_TOP)}px`;
  } else {
    // tl
    wrap.style.left = `${clampX(r.left + INSET_X)}px`;
    wrap.style.top = `${clampY(r.top + INSET_TOP)}px`;
  }
}

function createOverlay() {
  if (!isEditorPage()) return;
  if (window.top !== window) return; // only top frame

  removeOverlay();

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  // Prevent Dark Reader (and other dark mode tools that respect this hint)
  // from rewriting our button styles inside the shadow DOM.
  host.setAttribute("data-darkreader-ignore", "");
  host.setAttribute("data-no-darkreader", "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
:host{all: initial;}
.wrap{
  position: fixed;
  z-index: 2147483647;
  font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
  /* Start hidden to avoid a brief focus/outline flash during first paint. */
  opacity: 0;
  transition: opacity .12s ease;
}
.fab{
  width: 52px;
  height: 52px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.12);
  /* Frosted-glass look, clipped to the button only (no halo). */
  background: rgba(18,18,18,.55);
  -webkit-backdrop-filter: blur(10px) saturate(120%);
  backdrop-filter: blur(10px) saturate(120%);
  /* Thin outline that reads on both light and dark backgrounds. */
  box-shadow:
    0 0 0 1px rgba(255,255,255,.14),
    0 0 0 2px rgba(0,0,0,.20);
  display: grid;
  place-items: center;
  padding: 0;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
  -webkit-tap-highlight-color: transparent;
  transition: transform .10s ease, background .18s ease, border-color .18s ease, opacity .18s ease;
  touch-action: none;
}
.fab:focus, .fab:focus-visible{outline:none}
.fab[data-dragging="true"]{cursor: grabbing}
.fab:hover{
  border-color: rgba(255,255,255,.22);
  box-shadow:
    0 0 0 1px rgba(255,255,255,.18),
    0 0 0 2px rgba(0,0,0,.26);
  transform: translateY(-1px)
}
.fab:active{transform: translateY(0) scale(.98)}
.fab[data-on="true"]{
  /* Subtle 'on' state: keep the button monochrome; the icon stays colored. */
  background: rgba(255,255,255,.14);
  border-color: rgba(255,255,255,.22);
  box-shadow:
    0 0 0 1px rgba(255,255,255,.18),
    0 0 0 2px rgba(0,0,0,.22);
}

.fab[data-surface="light"]{
  /* Light surfaces: reduce the "heavy" look (less halo, less dark fill). */
  background: rgba(255,255,255,.62);
  border-color: rgba(0,0,0,.14);
  box-shadow: 0 0 0 1px rgba(0,0,0,.10);
}
.fab[data-surface="light"]:hover{
  border-color: rgba(0,0,0,.20);
  box-shadow: 0 0 0 1px rgba(0,0,0,.14);
}
.fab[data-surface="light"][data-on="true"]{
  /* On state on white: slightly darker outline so it doesn't get too faint. */
  background: rgba(255,255,255,.40);
  border-color: rgba(0,0,0,.22);
  box-shadow: 0 0 0 1px rgba(0,0,0,.16);
}
.fab[data-disabled="true"]{opacity: .55}
.icon{
  width: 28px;
  height: 28px;
  display:block;
  /* Keep the app icon in full color. */
  filter: none;
  opacity: .92;
}
.fab[data-on="true"] .icon{opacity: .98;}
`;

  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.setAttribute("data-darkreader-ignore", "");
  wrap.setAttribute("data-no-darkreader", "");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fab";
  btn.setAttribute("aria-label", "Toggle content exclusion for this editor");
  btn.setAttribute("data-darkreader-ignore", "");
  btn.setAttribute("data-no-darkreader", "");

  const img = document.createElement("img");
  img.className = "icon";
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.setAttribute("data-darkreader-ignore", "");
  img.setAttribute("data-no-darkreader", "");
  img.src = chrome.runtime.getURL(getCurrentAppIconFile());
  btn.appendChild(img);

  wrap.appendChild(btn);
  shadow.appendChild(style);
  shadow.appendChild(wrap);

  // Defensive: if Dark Reader races and injects inline hooks into the shadow DOM,
  // scrub them immediately and once again on the next frame.
  const scrubOverlay = () => {
    try {
      stripDarkReaderInline(host);
      stripDarkReaderInline(wrap);
      stripDarkReaderInline(btn);
      stripDarkReaderInline(img);
    } catch (_) {}
  };
  scrubOverlay();
  try { requestAnimationFrame(scrubOverlay); } catch (_) {}

  // Initial position.
  applyOverlayPosition(wrap, {
    mode: currentPosMode,
    corner: currentPosCorner,
    custom: getStoredCustomPosForCurrentApp(),
  });

  // Drag support
  let pointerId = null;
  let startX = 0,
    startY = 0,
    startLeft = 0,
    startTop = 0;
  let didDrag = false;

  const beginDragIfNeeded = () => {
    // Convert from corner positioning to explicit left/top on first drag.
    const rect = wrap.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    wrap.style.left = `${startLeft}px`;
    wrap.style.top = `${startTop}px`;
    wrap.style.right = "auto";
    wrap.style.bottom = "auto";
  };

  btn.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      // Prevent text selection / focus-jumps while dragging.
      e.preventDefault();
      pointerId = e.pointerId;
      btn.setPointerCapture(pointerId);
      startX = e.clientX;
      startY = e.clientY;
      didDrag = false;
      btn.dataset.dragging = "false";
    },
    { passive: false }
  );

  btn.addEventListener(
    "pointermove",
    (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!didDrag && Math.hypot(dx, dy) < 4) return;

      if (!didDrag) {
        didDrag = true;
        beginDragIfNeeded();
        btn.dataset.dragging = "true";
      }

      // Clamp inside the editor surface, not the full viewport.
      const BTN = 52;
      const MARGIN = 10;
      const r = getOverlaySafeRect();
      let minX = Number.isFinite(r.left) ? r.left + MARGIN : MARGIN;
      let minY = Number.isFinite(r.top) ? r.top + MARGIN : MARGIN;
      let maxX = Number.isFinite(r.right) ? r.right - BTN - MARGIN : window.innerWidth - BTN - MARGIN;
      let maxY = Number.isFinite(r.bottom) ? r.bottom - BTN - MARGIN : window.innerHeight - BTN - MARGIN;

      // If the safe rect is too small on an axis, fall back to viewport bounds
      // for that axis (prevents vertical drag from feeling "locked" in Slides).
      if (maxX < minX) {
        minX = MARGIN;
        maxX = window.innerWidth - BTN - MARGIN;
      }
      if (maxY < minY) {
        minY = MARGIN;
        maxY = window.innerHeight - BTN - MARGIN;
      }

      const x = clamp(startLeft + dx, minX, maxX);
      const y = clamp(startTop + dy, minY, maxY);
      wrap.style.left = `${x}px`;
      wrap.style.top = `${y}px`;
    },
    { passive: false }
  );

  btn.addEventListener(
    "pointerup",
    async (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      e.preventDefault();
      try {
        btn.releasePointerCapture(pointerId);
      } catch (_) {}
      pointerId = null;
      btn.dataset.dragging = "false";

      if (!didDrag) return;

      // Persist custom position for this app and switch mode to custom.
      const rect = wrap.getBoundingClientRect();
      const appPosKey = getCurrentAppPosKey();
      if (!appPosKey) return;

      const payload = {
        [KEY_POS_MODE]: "custom",
        [appPosKey]: { x: rect.left, y: rect.top },
      };
      await chrome.storage.sync.set(payload);
    },
    { passive: false }
  );

  // Click: toggle exclusion (skip if a drag just happened)
  btn.addEventListener("click", async (e) => {
    // If pointermove turned this into a drag, ignore the click.
    if (didDrag) {
      didDrag = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const appKey = getCurrentAppExcludeKey();
    if (!appKey) return;

    // If master is off, treat a click as "turn on master + this app".
    if (!currentMasterEnabled) {
      await chrome.storage.sync.set({
        [KEY_MASTER]: true,
        [appKey]: true,
      });
      return;
    }

    const currentApp = getCurrentAppExcludeEnabled();
    await chrome.storage.sync.set({ [appKey]: !currentApp });
  });

  const sync = ({ reposition = true } = {}) => {
    // When not actively dragging, keep the button pinned to the current
    // preset/custom location (clamped into the editor surface).
    if (reposition && btn.dataset.dragging !== "true") {
      applyOverlayPosition(wrap, {
        mode: currentPosMode,
        corner: currentPosCorner,
        custom: getStoredCustomPosForCurrentApp(),
      });
    }

    const effective = getEffectiveExcludeEnabled();
    btn.dataset.on = effective ? "true" : "false";
    btn.dataset.disabled = !currentMasterEnabled ? "true" : "false";
    btn.dataset.surface = getOverlaySurfaceMode(wrap);

    const wanted = chrome.runtime.getURL(getCurrentAppIconFile());
    if (img.src !== wanted) img.src = wanted;

    if (!isDarkReaderDynamicLike()) {
      btn.title = "Dark Reader Dynamic not detected";
    } else if (!currentMasterEnabled) {
      btn.title = "Exclusion is off (master switch)";
    } else {
      btn.title = effective
        ? "Excluding content (click to turn off)"
        : "Not excluding (click to turn on)";
    }
  };

  host.__drExcludeSync = sync;

  // Keep the overlay pinned even when Docs side panels open/close (often no window resize).
  let lastLayoutSig = "";
  const layoutSig = () => {
    const r = getOverlaySafeRect();
    return `${Math.round(r.left)}|${Math.round(r.top)}|${Math.round(r.right)}|${Math.round(r.bottom)}|${currentPosMode}|${currentPosCorner}`;
  };

  const checkLayout = () => {
    if (btn.dataset.dragging === "true") return;
    // Keep surface styling in sync with whatever UI is behind the button.
    try {
      const s = getOverlaySurfaceMode(wrap);
      if (btn.dataset.surface !== s) btn.dataset.surface = s;
    } catch (_) {}
    const sig = layoutSig();
    if (sig !== lastLayoutSig) {
      lastLayoutSig = sig;
      sync({ reposition: true });
    }
  };

  // Re-clamp on resize (e.g., window resize / zoom).
  const onResize = () => sync({ reposition: true });
  window.addEventListener("resize", onResize, { passive: true });

  // Light periodic watcher (no-op unless layout changes).
  checkLayout();
  const layoutTimer = setInterval(checkLayout, 350);

  host.__drExcludeCleanup = () => {
    window.removeEventListener("resize", onResize);
    try { clearInterval(layoutTimer); } catch (_) {}
  };

  document.documentElement.appendChild(host);
  // One last scrub after insertion (some tools race via MutationObserver).
  scrubOverlay();
  try {
    requestAnimationFrame(() => {
      scrubOverlay();
      try { wrap.style.opacity = "1"; } catch (_) {}
    });
  } catch (_) {
    try { wrap.style.opacity = "1"; } catch (_) {}
  }

  sync();
}


function syncOverlayIfPresent() {
  if (window.top !== window) return;
  const host = document.getElementById(OVERLAY_ID);
  if (!host) return;
  try {
    if (typeof host.__drExcludeSync === "function") host.__drExcludeSync();
  } catch (_) {}
}

function updateOverlayVisibility() {
  if (window.top !== window) return;
  const exists = !!document.getElementById(OVERLAY_ID);

  if (shouldShowOverlay()) {
    // Create only if missing; otherwise update in-place to avoid flicker.
    if (!exists) createOverlay();
    else syncOverlayIfPresent();
    return;
  }

  if (exists) removeOverlay();
}

// -------- Apply logic --------

// Disable-time restore can be racy: editors/DR may mutate right as we toggle.
// We run a short multi-pass restore + cleanup to avoid "needs refresh" hang.
let lastActive = false;
let disableRaf = 0;
let disableTimer1 = 0;
let disableTimer2 = 0;

function cancelDisableRestoreSequence() {
  try { if (disableRaf) cancelAnimationFrame(disableRaf); } catch (_) {}
  try { if (disableTimer1) clearTimeout(disableTimer1); } catch (_) {}
  try { if (disableTimer2) clearTimeout(disableTimer2); } catch (_) {}
  disableRaf = 0;
  disableTimer1 = 0;
  disableTimer2 = 0;
}

function bumpDarkReaderDynamic() {
  // Some DR Dynamic builds react to DOM/attr churn; this harmless bump can help
  // it re-evaluate quickly after we stop stripping hooks.
  if (!isDarkReaderDynamicLike()) return;
  try {
    const html = document.documentElement;
    const key = "data-dr-excluder-bump";
    const val = String(Date.now());
    html.setAttribute(key, val);
    // Remove on next tick.
    setTimeout(() => {
      try {
        if (html.getAttribute(key) === val) html.removeAttribute(key);
      } catch (_) {}
    }, 0);
  } catch (_) {}
}

function removeInlinePropIf(el, prop, predicate) {
  try {
    if (!el || !(el instanceof Element)) return;
    const v = (el.style.getPropertyValue(prop) || "").trim();
    if (!v) return;
    const pr = el.style.getPropertyPriority(prop) || "";
    if (predicate(v, pr)) el.style.removeProperty(prop);
  } catch (_) {}
}

function cleanupDisableLeftovers() {
  // Remove the specific inline overrides we apply, in case elements were cloned
  // or swapped and never made it into the patch map.
  const isNone = (v) => v.toLowerCase() === "none";
  const isInvertThumb = (v) => v.toLowerCase().includes("invert(") && v.toLowerCase().includes("hue-rotate");

  if (pathIsDocs()) {
    const root = document.getElementById("docs-editor");
    if (root) {
      const nodes = root.querySelectorAll(".kix-page-paginated, .kix-page-paginated canvas.kix-canvas-tile-content");
      for (const el of nodes) {
        removeInlinePropIf(el, "filter", (v, pr) => isNone(v) && pr === "important");
        removeInlinePropIf(el, "-webkit-filter", (v, pr) => isNone(v) && pr === "important");
      }
    }
  }

  if (pathIsSheets()) {
    const roots = findSheetsRoots();
    for (const r of roots) {
      const canvases = r.querySelectorAll("canvas");
      for (const c of canvases) {
        removeInlinePropIf(c, "filter", (v, pr) => isNone(v) && pr === "important");
        removeInlinePropIf(c, "-webkit-filter", (v, pr) => isNone(v) && pr === "important");
      }
    }
  }

  if (pathIsSlides()) {
    const film = findSlidesFilmstripRoot();
    if (film) {
      const svgs = film.querySelectorAll("svg");
      for (const svg of svgs) {
        removeInlinePropIf(svg, "filter", (v, pr) => isInvertThumb(v) && pr === "important");
        removeInlinePropIf(svg, "-webkit-filter", (v, pr) => isInvertThumb(v) && pr === "important");
      }
    }
  }
}

function runDisableRestoreSequence() {
  cancelDisableRestoreSequence();

  // Pass 1: immediate restore + cleanup.
  restoreAllPatches({ clear: false });
  cleanupDisableLeftovers();
  bumpDarkReaderDynamic();

  // Pass 2: next frame (catches same-tick mutation batches).
  disableRaf = requestAnimationFrame(() => {
    restoreAllPatches({ clear: false });
    cleanupDisableLeftovers();
  });

  // Pass 3: short settle window, then final clear.
  disableTimer1 = setTimeout(() => {
    restoreAllPatches({ clear: false });
    cleanupDisableLeftovers();
  }, 60);

  disableTimer2 = setTimeout(() => {
    restoreAllPatches({ clear: true });
    cleanupDisableLeftovers();
  }, 140);
}

function applyAll() {
  // Stop observers first.
  disconnectAll();

  const style = ensureStyleEl();
  const effective = getEffectiveExcludeEnabled();
  const dynamicLike = isDarkReaderDynamicLike();
  const active = effective && dynamicLike;

  // Only inject our CSS rules while actively excluding.
  style.textContent = buildCSS(active);

  // If not active (master off, per-app off, or DR not in Dynamic-like mode),
  // restore + cleanup to avoid the "needs refresh" hang.
  if (!active) {
    if (lastActive) runDisableRestoreSequence();
    else restoreAllPatches();
    lastActive = false;
    return;
  }

  cancelDisableRestoreSequence();
  lastActive = true;

  const stillEnabled = () => getEffectiveExcludeEnabled() && isDarkReaderDynamicLike();

  if (pathIsDocs()) applyDocsFix(stillEnabled);
  if (pathIsSheets()) applySheetsFix(stillEnabled);
  if (pathIsSlides()) applySlidesFix(stillEnabled, { invertThumbs: true });

  // Boot watchers (elements can appear after initial load)
  if (pathIsSheets()) {
    const boot = new MutationObserver(() => {
      if (!stillEnabled()) return;
      if (findSheetsRoots().length) {
        try {
          boot.disconnect();
        } catch (_) {}
        observers = observers.filter((o) => o !== boot);
        applySheetsFix(stillEnabled);
      }
    });
    boot.observe(document.documentElement, { subtree: true, childList: true });
    observers.push(boot);
  }

  if (pathIsSlides()) {
    const boot = new MutationObserver(() => {
      if (!stillEnabled()) return;
      const stage = findSlidesStageRoot();
      const film = findSlidesFilmstripRoot();
      if (stage || film) {
        try {
          boot.disconnect();
        } catch (_) {}
        observers = observers.filter((o) => o !== boot);
        applySlidesFix(stillEnabled, { invertThumbs: true });
      }
    });
    boot.observe(document.documentElement, { subtree: true, childList: true });
    observers.push(boot);
  }
}

async function loadStateAndApply() {
  const data = await chrome.storage.sync.get([
    KEY_MASTER,
    KEY_OVERLAY_MASTER,
    KEY_DOCS_EXCLUDE,
    KEY_SHEETS_EXCLUDE,
    KEY_SLIDES_EXCLUDE,
    KEY_DOCS_OVERLAY,
    KEY_SHEETS_OVERLAY,
    KEY_SLIDES_OVERLAY,
    KEY_POS_MODE,
    KEY_POS_CORNER,
    KEY_POS_DOCS,
    KEY_POS_SHEETS,
    KEY_POS_SLIDES,
  ]);

  currentMasterEnabled = boolOrDefault(data[KEY_MASTER], false);
  currentOverlayMasterEnabled = boolOrDefault(data[KEY_OVERLAY_MASTER], true);

  currentDocsEnabled = boolOrDefault(data[KEY_DOCS_EXCLUDE], true);
  currentSheetsEnabled = boolOrDefault(data[KEY_SHEETS_EXCLUDE], true);
  currentSlidesEnabled = boolOrDefault(data[KEY_SLIDES_EXCLUDE], true);

  currentDocsOverlayEnabled = boolOrDefault(data[KEY_DOCS_OVERLAY], true);
  currentSheetsOverlayEnabled = boolOrDefault(data[KEY_SHEETS_OVERLAY], true);
  currentSlidesOverlayEnabled = boolOrDefault(data[KEY_SLIDES_OVERLAY], true);

  currentPosMode = typeof data[KEY_POS_MODE] === "string" ? data[KEY_POS_MODE] : "corner";
  currentPosCorner = typeof data[KEY_POS_CORNER] === "string" ? data[KEY_POS_CORNER] : "br";
  currentPosDocs = data[KEY_POS_DOCS] && typeof data[KEY_POS_DOCS] === "object" ? data[KEY_POS_DOCS] : null;
  currentPosSheets = data[KEY_POS_SHEETS] && typeof data[KEY_POS_SHEETS] === "object" ? data[KEY_POS_SHEETS] : null;
  currentPosSlides = data[KEY_POS_SLIDES] && typeof data[KEY_POS_SLIDES] === "object" ? data[KEY_POS_SLIDES] : null;

  updateOverlayVisibility();

  applyAll();
  syncOverlayIfPresent();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;

  let touched = false;
  const readBool = (k, d) => (changes[k] ? boolOrDefault(changes[k].newValue, d) : undefined);

  if (changes[KEY_MASTER]) {
    currentMasterEnabled = readBool(KEY_MASTER, false);
    touched = true;
  }
  if (changes[KEY_OVERLAY_MASTER]) {
    currentOverlayMasterEnabled = readBool(KEY_OVERLAY_MASTER, true);
    touched = true;
  }

  if (changes[KEY_DOCS_EXCLUDE]) {
    currentDocsEnabled = readBool(KEY_DOCS_EXCLUDE, true);
    touched = true;
  }
  if (changes[KEY_SHEETS_EXCLUDE]) {
    currentSheetsEnabled = readBool(KEY_SHEETS_EXCLUDE, true);
    touched = true;
  }
  if (changes[KEY_SLIDES_EXCLUDE]) {
    currentSlidesEnabled = readBool(KEY_SLIDES_EXCLUDE, true);
    touched = true;
  }

  if (changes[KEY_DOCS_OVERLAY]) {
    currentDocsOverlayEnabled = readBool(KEY_DOCS_OVERLAY, true);
    touched = true;
  }
  if (changes[KEY_SHEETS_OVERLAY]) {
    currentSheetsOverlayEnabled = readBool(KEY_SHEETS_OVERLAY, true);
    touched = true;
  }
  if (changes[KEY_SLIDES_OVERLAY]) {
    currentSlidesOverlayEnabled = readBool(KEY_SLIDES_OVERLAY, true);
    touched = true;
  }

  if (changes[KEY_POS_MODE]) {
    currentPosMode = typeof changes[KEY_POS_MODE].newValue === "string" ? changes[KEY_POS_MODE].newValue : "corner";
    touched = true;
  }
  if (changes[KEY_POS_CORNER]) {
    currentPosCorner = typeof changes[KEY_POS_CORNER].newValue === "string" ? changes[KEY_POS_CORNER].newValue : "br";
    touched = true;
  }
  if (changes[KEY_POS_DOCS]) {
    currentPosDocs = changes[KEY_POS_DOCS].newValue && typeof changes[KEY_POS_DOCS].newValue === "object" ? changes[KEY_POS_DOCS].newValue : null;
    touched = true;
  }
  if (changes[KEY_POS_SHEETS]) {
    currentPosSheets = changes[KEY_POS_SHEETS].newValue && typeof changes[KEY_POS_SHEETS].newValue === "object" ? changes[KEY_POS_SHEETS].newValue : null;
    touched = true;
  }
  if (changes[KEY_POS_SLIDES]) {
    currentPosSlides = changes[KEY_POS_SLIDES].newValue && typeof changes[KEY_POS_SLIDES].newValue === "object" ? changes[KEY_POS_SLIDES].newValue : null;
    touched = true;
  }

  if (touched) {
    updateOverlayVisibility();
    applyAll();
    syncOverlayIfPresent();
  }
});

// Popup status support
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "DR_EXCLUDER_GET_STATUS") {
    sendResponse({
      app: getCurrentApp(),
      dynamic: isDarkReaderDynamicLike(),
      master: currentMasterEnabled,
    });
  }
});

loadStateAndApply();
