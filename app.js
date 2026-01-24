console.log("✅ app.js running", new Date().toISOString());
window.__APP_JS_OK__ = true;

// =====================================
// CONFIG
// =====================================
const API_URL = "https://habit-proxy.joeywigs.workers.dev/";
// NOTE: With the Cloudflare Worker proxy, you do NOT need API_KEY in the browser.

// =====================================
// API HELPERS
// =====================================
async function apiGet(action, params = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), { method: "GET" });
  return await res.json();
}

async function apiPost(action, payload = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload })
  });
  return await res.json();
}

// =====================================
// APP STATE
// =====================================
let currentDate = new Date();
let dataChanged = false;

// =====================================
// APP BOOTSTRAP
// =====================================
document.addEventListener("DOMContentLoaded", () => {
  console.log("Habit Tracker booting…");
  setupDateNav();
  setupCheckboxes();
  updateDateDisplay();
  loadDataForCurrentDate();
});

// =====================================
// CORE FUNCTIONS
// =====================================
function formatDateForAPI(date = currentDate) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${m}/${d}/${y}`;
}

async function loadDataForCurrentDate() {
  const dateStr = formatDateForAPI();
  console.log("Loading data for", dateStr);

  try {
    const loadResult = await apiGet("load", { date: dateStr });

    if (loadResult?.error) {
      console.error("Backend error:", loadResult.message);
      return;
    }

    console.log("Data loaded:", loadResult);
    populateForm(loadResult);   // ✅ use it here
  } catch (err) {
    console.error("Load failed:", err);
  }
}


function populateForm(data) {
  // Minimal proof-of-life mapping
  const d = data?.daily || {};

  // Sleep
  const sleepEl = document.getElementById("sleepHours");
  if (sleepEl) sleepEl.value = d["Hours of Sleep"] ?? "";

  // Steps
  const stepsEl = document.getElementById("steps");
  if (stepsEl) stepsEl.value = d["Steps"] ?? "";

  // Water counter (if you have it)
  if (typeof d["Water"] !== "undefined") {
    window.waterCount = parseInt(d["Water"], 10) || 0;
    const waterCountEl = document.getElementById("waterCount");
    if (waterCountEl) waterCountEl.textContent = String(window.waterCount);

  // After all checkbox values are set
  document
  .querySelectorAll(".checkbox-field input[type='checkbox']")
  .forEach(syncCheckboxVisual);
  }

  console.log("✅ populateForm ran");
}


async function saveData(payload) {
  try {
    const saveResult = await apiPost("save", { data: payload });

    if (saveResult?.error) {
      console.error("Save error:", saveResult.message);
      return;
    }

    console.log("Saved successfully", saveResult);
    dataChanged = false;
  } catch (err) {
    console.error("Save failed:", err);
  }
}

// =====================================
// UI PLACEHOLDERS
// =====================================
function updateDateDisplay() {
  const el = document.getElementById("dateDisplay");
  if (!el) return;

  el.textContent = currentDate.toDateString();
}

function changeDate(days) {
  currentDate.setDate(currentDate.getDate() + days);
  updateDateDisplay();
  loadDataForCurrentDate();
}

// =====================================
// Setup the Date Nav Buttons
// =====================================

function setupDateNav() {
  const prev = document.getElementById("prevBtn");
  const next = document.getElementById("nextBtn");

  if (!prev || !next) {
    console.warn("Date nav buttons not found");
    return;
  }

  prev.addEventListener("click", (e) => {
    e.preventDefault();
    changeDate(-1);
  });

  next.addEventListener("click", (e) => {
    e.preventDefault();
    changeDate(1);
  });

  console.log("✅ Date nav wired");
}

function changeDate(days) {
  currentDate.setDate(currentDate.getDate() + days);
  console.log("✅ Changed date to", formatDateForAPI(currentDate));
  updateDateDisplay();
  loadDataForCurrentDate();
}

function syncCheckboxVisual(cb) {
  const wrapper = cb.closest(".checkbox-field");
  if (!wrapper) return;
  wrapper.classList.toggle("checked", cb.checked);
}

function setupCheckboxes() {
  document.querySelectorAll(".checkbox-field").forEach(wrapper => {
    const cb = wrapper.querySelector("input[type='checkbox']");
    if (!cb) return;

    // Set initial visual state
    syncCheckboxVisual(cb);

    // Toggle when checkbox changes
    cb.addEventListener("change", () => {
      syncCheckboxVisual(cb);
      dataChanged = true;
    });

    // Click anywhere on the wrapper toggles the checkbox
    wrapper.addEventListener("click", (e) => {
      // If they clicked the actual checkbox or label, let default behavior happen
      if (e.target.tagName === "INPUT" || e.target.tagName === "LABEL") return;

      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

