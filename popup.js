const KEY_MASTER = "dr_exclude_content_dynamic_v1";
const KEY_OVERLAY_MASTER = "dr_show_overlay_v1";

// Per-app exclusion toggles (default: true)
const KEY_DOCS_EXCLUDE = "dr_exclude_docs_v1";
const KEY_SHEETS_EXCLUDE = "dr_exclude_sheets_v1";
const KEY_SLIDES_EXCLUDE = "dr_exclude_slides_v1";

// Per-app in-page toggles (default: true)
const KEY_DOCS_OVERLAY = "dr_overlay_docs_v1";
const KEY_SHEETS_OVERLAY = "dr_overlay_sheets_v1";
const KEY_SLIDES_OVERLAY = "dr_overlay_slides_v1";

// Position
const KEY_POS_MODE = "dr_overlay_pos_mode_v1";     // "corner" | "custom"
const KEY_POS_CORNER = "dr_overlay_pos_corner_v1"; // br/bl/tr/tl

// UI mapping for the position dropdown.
const POS_LABELS = {
  br: "Bottom right",
  bl: "Bottom left",
  tr: "Top right",
  tl: "Top left",
  custom: "Custom (drag)",
};

function boolOrDefault(v, dflt) {
  return typeof v === "boolean" ? v : dflt;
}

async function getState() {
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
  ]);

  const posMode = typeof data[KEY_POS_MODE] === "string" ? data[KEY_POS_MODE] : "corner";
  const posCorner = typeof data[KEY_POS_CORNER] === "string" ? data[KEY_POS_CORNER] : "br";

  return {
    master: boolOrDefault(data[KEY_MASTER], false),
    overlayMaster: boolOrDefault(data[KEY_OVERLAY_MASTER], true),
    docs: boolOrDefault(data[KEY_DOCS_EXCLUDE], true),
    sheets: boolOrDefault(data[KEY_SHEETS_EXCLUDE], true),
    slides: boolOrDefault(data[KEY_SLIDES_EXCLUDE], true),
    ovDocs: boolOrDefault(data[KEY_DOCS_OVERLAY], true),
    ovSheets: boolOrDefault(data[KEY_SHEETS_OVERLAY], true),
    ovSlides: boolOrDefault(data[KEY_SLIDES_OVERLAY], true),
    posMode,
    posCorner,
  };
}

async function setKeys(patch) {
  await chrome.storage.sync.set(patch);
}

function setAppBtn(btn, on) {
  btn.dataset.on = on ? "true" : "false";
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function getContentStatus() {
  const tabId = await getActiveTabId();
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "DR_EXCLUDER_GET_STATUS" });
  } catch (_) {
    return null;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const els = {
    dot: document.getElementById("statusDot"),
    master: document.getElementById("toggleExclude"),
    overlay: document.getElementById("toggleOverlay"),
    pill: document.getElementById("modePill"),

    // Custom position dropdown
    posDropdown: document.getElementById("posDropdown"),
    posBtn: document.getElementById("posBtn"),
    posMenu: document.getElementById("posMenu"),
    posLabel: document.getElementById("posLabel"),

    appDocs: document.getElementById("appDocs"),
    appSheets: document.getElementById("appSheets"),
    appSlides: document.getElementById("appSlides"),

    ovDocs: document.getElementById("ovDocs"),
    ovSheets: document.getElementById("ovSheets"),
    ovSlides: document.getElementById("ovSlides"),
  };

  const state = await getState();

  // Init
  els.master.checked = state.master;
  els.overlay.checked = state.overlayMaster;
  setAppBtn(els.appDocs, state.docs);
  setAppBtn(els.appSheets, state.sheets);
  setAppBtn(els.appSlides, state.slides);
  setAppBtn(els.ovDocs, state.ovDocs);
  setAppBtn(els.ovSheets, state.ovSheets);
  setAppBtn(els.ovSlides, state.ovSlides);

  // --- Position dropdown init ---
  const getCurrentPosValue = () => {
    if (state.posMode === "custom") return "custom";
    return ["br", "bl", "tr", "tl"].includes(state.posCorner) ? state.posCorner : "br";
  };

  let currentPosValue = getCurrentPosValue();

  const renderPosDropdown = () => {
    els.posLabel.textContent = POS_LABELS[currentPosValue] || POS_LABELS.br;
    const opts = els.posMenu.querySelectorAll(".ddOpt");
    for (const opt of opts) {
      const v = opt.getAttribute("data-value");
      const selected = v === currentPosValue;
      opt.setAttribute("aria-selected", selected ? "true" : "false");
    }
  };

  renderPosDropdown();

  const refreshDisabled = () => {
    const excludeDisabled = !els.master.checked;
    els.appDocs.disabled = excludeDisabled;
    els.appSheets.disabled = excludeDisabled;
    els.appSlides.disabled = excludeDisabled;

    const overlayDisabled = !els.overlay.checked;
    els.ovDocs.disabled = overlayDisabled;
    els.ovSheets.disabled = overlayDisabled;
    els.ovSlides.disabled = overlayDisabled;
    els.posBtn.disabled = overlayDisabled;
  };

  refreshDisabled();

  // Master exclusion
  els.master.addEventListener("change", async () => {
    await setKeys({ [KEY_MASTER]: !!els.master.checked });
    refreshDisabled();
    // Dot reflects 'active' best-effort (master on + dynamic detected)
    await updateStatusUI(els);
  });

  // Master overlay
  els.overlay.addEventListener("change", async () => {
    await setKeys({ [KEY_OVERLAY_MASTER]: !!els.overlay.checked });
    refreshDisabled();
  });

  // Per-app toggles
  const bindAppToggle = (btn, key, masterEl) => {
    btn.addEventListener("click", async () => {
      if (!masterEl.checked) return;
      const next = !(btn.dataset.on === "true");
      setAppBtn(btn, next);
      await setKeys({ [key]: next });
    });
  };

  bindAppToggle(els.appDocs, KEY_DOCS_EXCLUDE, els.master);
  bindAppToggle(els.appSheets, KEY_SHEETS_EXCLUDE, els.master);
  bindAppToggle(els.appSlides, KEY_SLIDES_EXCLUDE, els.master);

  bindAppToggle(els.ovDocs, KEY_DOCS_OVERLAY, els.overlay);
  bindAppToggle(els.ovSheets, KEY_SHEETS_OVERLAY, els.overlay);
  bindAppToggle(els.ovSlides, KEY_SLIDES_OVERLAY, els.overlay);

  // --- Position dropdown interactions ---
  let menuOpen = false;

  const closeMenu = () => {
    if (!menuOpen) return;
    menuOpen = false;
    els.posMenu.hidden = true;
    els.posBtn.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    if (menuOpen) return;
    menuOpen = true;
    els.posMenu.hidden = false;
    els.posBtn.setAttribute("aria-expanded", "true");
    // Focus the selected option for keyboard navigation.
    const selected = els.posMenu.querySelector(".ddOpt[aria-selected='true']") || els.posMenu.querySelector(".ddOpt");
    selected?.focus?.();
  };

  els.posBtn.addEventListener("click", () => {
    if (els.posBtn.disabled) return;
    if (menuOpen) closeMenu();
    else openMenu();
  });

  // Close on outside click.
  document.addEventListener("click", (e) => {
    if (!menuOpen) return;
    if (els.posDropdown.contains(e.target)) return;
    closeMenu();
  });

  // Escape closes.
  document.addEventListener("keydown", (e) => {
    if (!menuOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      els.posBtn.focus();
    }
  });

  // Option selection + keyboard navigation.
  els.posMenu.addEventListener("keydown", (e) => {
    const opts = Array.from(els.posMenu.querySelectorAll(".ddOpt"));
    const idx = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      opts[Math.min(opts.length - 1, Math.max(0, idx + 1))]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      opts[Math.max(0, idx - 1)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      opts[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      opts[opts.length - 1]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      document.activeElement?.click?.();
    }
  });

  els.posMenu.querySelectorAll(".ddOpt").forEach((opt) => {
    opt.addEventListener("click", async () => {
      const v = opt.getAttribute("data-value") || "br";
      currentPosValue = v;
      renderPosDropdown();
      closeMenu();
      els.posBtn.focus();

      if (v === "custom") {
        await setKeys({ [KEY_POS_MODE]: "custom" });
        return;
      }

      await setKeys({
        [KEY_POS_MODE]: "corner",
        [KEY_POS_CORNER]: v,
      });
    });
  });

  // Status pill (best-effort)
  async function updateStatusUI(elsRef) {
    const status = await getContentStatus();

    // reset state classes
    elsRef.pill.classList.remove("good", "bad");

    if (!status) {
      elsRef.pill.textContent = "Dynamic: unknown";
      elsRef.dot.classList.remove("good");
      return;
    }

    if (status.dynamic) {
      elsRef.pill.classList.add("good");
      elsRef.pill.textContent = "Dynamic: detected";
    } else {
      elsRef.pill.classList.add("bad");
      elsRef.pill.textContent = "Dynamic: not detected";
    }

    // Dot shows 'extension active' when master is on and Dynamic is detected.
    if (status.dynamic && elsRef.master.checked) elsRef.dot.classList.add("good");
    else elsRef.dot.classList.remove("good");
  }

  await updateStatusUI(els);

  // Keep the status pill reactive while the popup is open.
  // (Example: user toggles Dark Reader on/off for the current site.)
  const pollMs = 500;
  const pollId = setInterval(() => {
    updateStatusUI(els);
  }, pollMs);

  const stopPoll = () => {
    try { clearInterval(pollId); } catch (_) {}
  };

  window.addEventListener("unload", stopPoll);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateStatusUI(els);
  });
});
