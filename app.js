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

function setCheckbox(id, valueFromSheet) {
  const cb = document.getElementById(id);
  if (!cb) return;

  cb.checked = toBool(valueFromSheet);
  syncCheckboxVisual(cb); // <-- applies/removes .checked class on wrapper
}

function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;

  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "y" || s === "1") return true;
    if (s === "false" || s === "no" || s === "n" || s === "0" || s === "") return false;
  }

  if (typeof v === "number") return v !== 0;

  // fallback
  return Boolean(v);
}

// ---------- helpers (keep if you don't already have them) ----------
function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;

  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "y" || s === "1") return true;
    if (s === "false" || s === "no" || s === "n" || s === "0" || s === "") return false;
  }

  if (typeof v === "number") return v !== 0;

  return Boolean(v);
}

function syncCheckboxVisual(cb) {
  const wrapper = cb.closest(".checkbox-field");
  if (!wrapper) return;
  wrapper.classList.toggle("checked", cb.checked);
}

function setCheckbox(id, valueFromSheet) {
  const cb = document.getElementById(id);
  if (!cb) return;
  cb.checked = toBool(valueFromSheet);
  syncCheckboxVisual(cb);
}

// ---------- FULL populateForm ----------
function populateForm(data) {
  // Reset simple inputs where possible (optional but nice)
  const form = document.getElementById("healthForm");
  if (form && typeof form.reset === "function") form.reset();

  // Clear checkbox visual state first
  document.querySelectorAll(".checkbox-field").forEach(w => w.classList.remove("checked"));

  // Reset state arrays if you use them globally
  if (typeof movements !== "undefined") movements = [];
  if (typeof readings !== "undefined") readings = [];
  if (typeof honeyDos !== "undefined") honeyDos = [];
  if (typeof currentAverages !== "undefined") currentAverages = null;

  const d = (data && data.daily) ? data.daily : null;

  // If there's no daily data for that date, still try to render lists + percentages
  if (!d) {
    // Water default
    if (typeof waterCount !== "undefined") waterCount = 0;
    if (document.getElementById("waterCount")) document.getElementById("waterCount").textContent = "0";

    // Lists from payload (might still exist)
    if (typeof movements !== "undefined") movements = (data?.movements || []).map(m => ({
      duration: m.duration ?? m["duration (min)"] ?? m["Duration"] ?? m["Duration (min)"],
      type: m.type ?? m["type"] ?? m["Type"]
    }));
    if (typeof readings !== "undefined") readings = (data?.readings || []).map(r => ({
      duration: r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"],
      book: r.book ?? r["book"] ?? r["Book"]
    }));
    if (typeof honeyDos !== "undefined") honeyDos = data?.honeyDos || [];

    // Text areas
    const reflectionsEl = document.getElementById("reflections");
    if (reflectionsEl) reflectionsEl.value = data?.reflections || "";
    const storiesEl = document.getElementById("stories");
    if (storiesEl) storiesEl.value = data?.stories || "";
    const carlyEl = document.getElementById("carly");
    if (carlyEl) carlyEl.value = data?.carly || "";

    // Render if functions exist
    if (typeof renderMovements === "function") renderMovements();
    if (typeof renderReadings === "function") renderReadings();
    if (typeof renderHoneyDos === "function") renderHoneyDos();
    if (typeof calculatePercentages === "function") calculatePercentages();
    if (typeof updateAverages === "function") updateAverages(data?.averages);
    if (typeof checkSectionCompletion === "function") checkSectionCompletion();

    // If you have the “load body data from previous day” behavior, do it
    if (typeof loadBodyDataFromPreviousDay === "function") loadBodyDataFromPreviousDay();

    // Finally: ensure checkbox visuals match checked state (all unchecked)
    document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(syncCheckboxVisual);
    return;
  }

  // -------------------
  // Sleep + Numbers
  // -------------------
  const sleepEl = document.getElementById("sleepHours");
  if (sleepEl) sleepEl.value = d["Hours of Sleep"] ?? "";

  const stepsEl = document.getElementById("steps");
  if (stepsEl) stepsEl.value = d["Steps"] ?? "";

  const fitnessEl = document.getElementById("fitnessScore");
  if (fitnessEl) fitnessEl.value = d["Fitness Score"] ?? "";

  const caloriesEl = document.getElementById("calories");
  if (caloriesEl) caloriesEl.value = d["Calories"] ?? "";

  const peakWattsEl = document.getElementById("peakWatts");
  if (peakWattsEl) peakWattsEl.value = d["Peak Watts"] ?? "";

  const wattSecondsEl = document.getElementById("wattSeconds");
  if (wattSecondsEl) wattSecondsEl.value = d["Watt Seconds"] ?? "";

  // -------------------
  // Checkboxes (normalize booleans)
  // -------------------
  // Grey
  setCheckbox("inhalerMorning", d["Grey's Inhaler Morning"] ?? d["Inhaler Morning"]);
  setCheckbox("inhalerEvening", d["Grey's Inhaler Evening"] ?? d["Inhaler Evening"]);
  setCheckbox("multiplication", d["5 min Multiplication"]);

  // Movement
  setCheckbox("rehit", d["REHIT 2x10"] ?? d["REHIT"]);
  const rehitCb = document.getElementById("rehit");
  const rehitFields = document.getElementById("rehitFields");
  if (rehitCb && rehitFields) rehitFields.style.display = rehitCb.checked ? "block" : "none";

  // Supplements
  setCheckbox("creatine", d["Creatine Chews"] ?? d["Creatine"]);
  setCheckbox("vitaminD", d["Vitamin D"]);
  setCheckbox("no2", d["NO2"]);
  setCheckbox("psyllium", d["Psyllium Husk"] ?? d["Psyllium"]);

  // Meals
  setCheckbox("breakfast", d["Breakfast"]);
  setCheckbox("lunch", d["Lunch"]);
  setCheckbox("dinner", d["Dinner"]);

  // Snacks & Alcohol
  setCheckbox("daySnacks", d["Healthy Day Snacks"] ?? d["Day Snacks"]);
  setCheckbox("nightSnacks", d["Healthy Night Snacks"] ?? d["Night Snacks"]);
  setCheckbox("noAlcohol", d["No Alcohol"]);

  // Meditation
  setCheckbox("meditation", d["Meditation"]);

  // -------------------
  // Water counter
  // -------------------
  const waterRaw = d["Water"];
  const parsedWater = parseInt(waterRaw, 10);
  if (typeof waterCount !== "undefined") waterCount = Number.isFinite(parsedWater) ? parsedWater : 0;

  if (typeof updateWaterDisplay === "function") {
    updateWaterDisplay();
  } else {
    const waterCountEl = document.getElementById("waterCount");
    if (waterCountEl) waterCountEl.textContent = String((typeof waterCount !== "undefined") ? waterCount : 0);
  }

  // -------------------
  // Body data
  // -------------------
  const weightEl = document.getElementById("weight");
  const leanMassEl = document.getElementById("leanMass");
  const bodyFatEl = document.getElementById("bodyFat");
  const boneMassEl = document.getElementById("boneMass");
  const waterBodyEl = document.getElementById("water");

  const weightVal = d["Weight (lbs)"] ?? d["Weight"];
  const leanVal = d["Lean Mass (lbs)"] ?? d["Lean Mass"];
  const fatVal = d["Body Fat (lbs)"] ?? d["Body Fat"];
  const boneVal = d["Bone Mass (lbs)"] ?? d["Bone Mass"];
  const waterBodyVal = d["Water (lbs)"] ?? d["Water"]; // note: this overlaps with the water counter, but matches your prior logic

  if (weightEl) weightEl.value = weightVal ?? "";
  if (leanMassEl) leanMassEl.value = leanVal ?? "";
  if (bodyFatEl) bodyFatEl.value = fatVal ?? "";
  if (boneMassEl) boneMassEl.value = boneVal ?? "";
  if (waterBodyEl) waterBodyEl.value = waterBodyVal ?? "";

  // If no body data exists for this date, optionally load from previous day
  if (!weightVal && typeof loadBodyDataFromPreviousDay === "function") {
    loadBodyDataFromPreviousDay();
  } else if (typeof calculatePercentages === "function") {
    calculatePercentages();
  }

  // -------------------
  // Movements / Readings / HoneyDos
  // -------------------
  if (typeof movements !== "undefined") {
    movements = (data.movements || []).map(m => ({
      duration: m.duration ?? m["duration (min)"] ?? m["Duration"] ?? m["Duration (min)"],
      type: m.type ?? m["Type"] ?? m["type"]
    }));
  }

  if (typeof readings !== "undefined") {
    readings = (data.readings || []).map(r => ({
      duration: r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"],
      book: r.book ?? r["Book"] ?? r["book"]
    }));

    // Keep lastBookTitle in sync if you use it
    if (typeof lastBookTitle !== "undefined" && readings.length > 0) {
      const last = readings[readings.length - 1];
      lastBookTitle = (last.book || "").trim();
    }
  }

  if (typeof honeyDos !== "undefined") {
    honeyDos = data.honeyDos || [];
  }

  // -------------------
  // Text areas
  // -------------------
  const reflectionsEl = document.getElementById("reflections");
  if (reflectionsEl) reflectionsEl.value = data.reflections || "";

  const storiesEl = document.getElementById("stories");
  if (storiesEl) storiesEl.value = data.stories || "";

  const carlyEl = document.getElementById("carly");
  if (carlyEl) carlyEl.value = data.carly || "";

  // -------------------
  // Render lists + update averages/completion
  // -------------------
  if (typeof renderMovements === "function") renderMovements();
  if (typeof renderReadings === "function") renderReadings();
  if (typeof renderHoneyDos === "function") renderHoneyDos();

  if (typeof updateAverages === "function") updateAverages(data.averages);

  if (typeof calculatePercentages === "function") calculatePercentages();
  if (typeof checkSectionCompletion === "function") checkSectionCompletion();

  // Final sweep: ensure visuals match checked state (covers any checkboxes not explicitly set)
  document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(syncCheckboxVisual);
}



