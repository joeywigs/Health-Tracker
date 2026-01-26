/**********************************************
 * Habit Tracker - app.js (clean + consistent)
 *
 * GOALS (consistency-first):
 * ✅ Load fresh data when:
 *    - changing dates (prev/next)
 *    - returning to the app after idle time
 * ✅ Save data when:
 *    - blur (click out) of an input/textarea
 *    - collapsing a section
 *    - toggling a checkbox
 *    - clicking +/- water buttons
 * ✅ NEVER auto-reload after save (prevents “revert/disappear” anxiety)
 *
 * Notes:
 * - Removed cache/prefetch on purpose (stability > speed). Add later if desired.
 * - populateForm() does NOT call form.reset() (prevents wiping fields unexpectedly).
 **********************************************/

console.log("✅ app.js running", new Date().toISOString());
console.log("Look for most recent different values");
window.__APP_JS_OK__ = true;

// =====================================
// CONFIG
// =====================================
const API_URL = "https://habit-proxy.joeywigs.workers.dev/";

// Carry-forward body detection
const BODY_FIELDS = [
  { id: "weight", keys: ["Weight (lbs)", "Weight"] },
  { id: "waist", keys: ["Waist (in)", "Waist"] }, // supports either header
  { id: "leanMass", keys: ["Lean Mass (lbs)", "Lean Mass"] },
  { id: "bodyFat", keys: ["Body Fat (lbs)", "Body Fat"] },
  { id: "boneMass", keys: ["Bone Mass (lbs)", "Bone Mass"] },
  { id: "water", keys: ["Water (lbs)"] } // IMPORTANT: do NOT fall back to "Water" (hydration count)
];

const RELOAD_AFTER_IDLE_MS = 2 * 60 * 1000; // 2 min idle -> reload on return (tune)

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
let saveInFlight = false;
let pendingSave = false;

let lastUserActivityAt = Date.now();

let movements = [];
let readings = [];
let honeyDos = [];
let currentAverages = null;
let lastBookTitle = "";
let waterCount = 0;
let prevBodyForDelta = { weight: null, leanMass: null, bodyFat: null };


let autoSaveTimeout = null;

// =====================================
// BOOTSTRAP
// =====================================
document.addEventListener("DOMContentLoaded", async () => {
  console.log("Habit Tracker booting…");

  setupDateNav();
  setupCheckboxes();
  setupWaterButtons();
  setupInputSaveOnBlur();
  setupCollapsibleSectionsSaveOnCollapse();
  setupMovementUI();
  setupReadingUI(); // prompt-based by default; swap to modal version if you’ve added modal elements
  setupBloodPressureCalculator();

  // If you’ve added Biomarkers page wiring, this will wire it (only if elements exist)
  setupBiomarkersUIToggleSafe();

  updateDateDisplay();
  updatePhaseInfo();
  await loadDataForCurrentDate({ force: true });

  setupReloadOnReturnFromIdle();
});

const PHASE_START_DATE = new Date("2026-01-19T00:00:00");
const PHASE_LENGTH_DAYS = 21;

function updatePhaseInfo() {
  const start = new Date(PHASE_START_DATE);
  start.setHours(0, 0, 0, 0);

  const cur = new Date(currentDate);
  cur.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceStart = Math.floor((cur - start) / msPerDay);

  const safeDays = Math.max(0, daysSinceStart);
  const phase = Math.floor(safeDays / PHASE_LENGTH_DAYS) + 1;
  const dayInPhase = (safeDays % PHASE_LENGTH_DAYS) + 1;

  const phaseInfoEl = document.getElementById("phaseInfo");
  if (phaseInfoEl) phaseInfoEl.textContent = `Day ${dayInPhase} of ${PHASE_LENGTH_DAYS}`;

  const subtitleEl = document.querySelector(".subtitle");
  if (subtitleEl) subtitleEl.textContent = `Phase ${phase}`;

  const bar = document.getElementById("phaseProgressBar");
  if (bar) {
    const progress = (dayInPhase - 1) / PHASE_LENGTH_DAYS;
    bar.style.width = `${Math.round(progress * 100)}%`;
  }
}

// =====================================
// DATE + NAV
// =====================================
function formatDateForAPI(date = currentDate) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${m}/${d}/${y}`;
}

function updateDateDisplay() {
  const el = document.getElementById("dateDisplay");
  if (!el) return;
  el.textContent = currentDate.toDateString();
}

function setupDateNav() {
  const prev = document.getElementById("prevBtn");
  const next = document.getElementById("nextBtn");

  if (!prev || !next) {
    console.warn("Date nav buttons not found");
    return;
  }

  prev.addEventListener("click", async (e) => {
    e.preventDefault();
    await changeDate(-1);
  });

  next.addEventListener("click", async (e) => {
    e.preventDefault();
    await changeDate(1);
  });

  console.log("✅ Date nav wired");
}

async function changeDate(days) {
  // Save before navigating away (prevents losing entered data)
  await flushSaveNow("date_change");

  currentDate.setDate(currentDate.getDate() + days);
  updateDateDisplay();
  updatePhaseInfo();

  // Always load fresh when switching dates
  await loadDataForCurrentDate({ force: true });
}

// =====================================
// LOAD
// =====================================
async function loadDataForCurrentDate({ force = false } = {}) {
  const dateStr = formatDateForAPI(currentDate);
  console.log("Loading data for", dateStr, force ? "(force)" : "");

  try {
    const result = await apiGet("load", { date: dateStr });

    if (result?.error) {
      console.error("Backend error:", result.message);
      showStatus("Load failed", "error");
      return;
    }

    await populateForm(result);
    dataChanged = false;
    showStatus("Loaded", "success", 600);
  } catch (err) {
    console.error("Load failed:", err);
    showStatus("Load failed", "error");
  }
}

// =====================================
// SAVE
// =====================================
function markDirty() {
  dataChanged = true;
  lastUserActivityAt = Date.now();
}

function queueSaveSoon(reason = "debounced") {
  markDirty();

  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(() => {
    flushSaveNow(reason);
  }, 600);
}

async function flushSaveNow(reason = "flush") {
  if (!dataChanged) return;

  // If a save is already running, we’ll do one more pass after it finishes
  if (saveInFlight) {
    pendingSave = true;
    return;
  }

  saveInFlight = true;
  pendingSave = false;

  try {
    const payload = buildPayloadFromUI();
    showStatus("Saving…", "loading");

    const saveResult = await apiPost("save", { data: payload });

    if (saveResult?.error) {
      console.error("Save error:", saveResult.message);
      showStatus("Save failed", "error");
      return;
    }

    dataChanged = false;
    showStatus("Saved ✓", "success");
    // IMPORTANT: no reload here (prevents revert/disappear problems)

  } catch (err) {
    console.error("Save failed:", err);
    showStatus("Save failed", "error");
  } finally {
    saveInFlight = false;
    if (pendingSave) {
      pendingSave = false;
      await flushSaveNow("pending");
    }
  }
}

function buildPayloadFromUI() {
  return {
    date: formatDateForAPI(currentDate),

    // Daily numbers
    sleepHours: document.getElementById("sleepHours")?.value || "",
    steps: document.getElementById("steps")?.value || "",
    fitnessScore: document.getElementById("fitnessScore")?.value || "",
    calories: document.getElementById("calories")?.value || "",
    peakWatts: document.getElementById("peakWatts")?.value || "",
    wattSeconds: document.getElementById("wattSeconds")?.value || "",

    // Checkboxes
    inhalerMorning: !!document.getElementById("inhalerMorning")?.checked,
    inhalerEvening: !!document.getElementById("inhalerEvening")?.checked,
    multiplication: !!document.getElementById("multiplication")?.checked,
    rehit: !!document.getElementById("rehit")?.checked,

    creatine: !!document.getElementById("creatine")?.checked,
    vitaminD: !!document.getElementById("vitaminD")?.checked,
    no2: !!document.getElementById("no2")?.checked,
    psyllium: !!document.getElementById("psyllium")?.checked,

    breakfast: !!document.getElementById("breakfast")?.checked,
    lunch: !!document.getElementById("lunch")?.checked,
    dinner: !!document.getElementById("dinner")?.checked,

    daySnacks: !!document.getElementById("daySnacks")?.checked,
    nightSnacks: !!document.getElementById("nightSnacks")?.checked,
    noAlcohol: !!document.getElementById("noAlcohol")?.checked,

    meditation: !!document.getElementById("meditation")?.checked,

    // Water counter
    hydrationGood: waterCount,

    // Body
    weight: document.getElementById("weight")?.value || "",
    waist: document.getElementById("waist")?.value || "",
    leanMass: document.getElementById("leanMass")?.value || "",
    bodyFat: document.getElementById("bodyFat")?.value || "",
    boneMass: document.getElementById("boneMass")?.value || "",
    water: document.getElementById("water")?.value || "",

    // Blood Pressure
    systolic: document.getElementById("systolic")?.value || "",
    diastolic: document.getElementById("diastolic")?.value || "",
    heartRate: document.getElementById("heartRate")?.value || "",

    // Lists + text
    movements,
    readings,
    honeyDos,
    reflections: document.getElementById("reflections")?.value || "",
    stories: document.getElementById("stories")?.value || "",
    carly: document.getElementById("carly")?.value || ""
  };
}

// =====================================
// CHECKBOXES: normalize + visuals + click-anywhere
// =====================================
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

function setupCheckboxes() {
  document.querySelectorAll(".checkbox-field").forEach(wrapper => {
    const cb = wrapper.querySelector("input[type='checkbox']");
    if (!cb) return;

    syncCheckboxVisual(cb);

    cb.addEventListener("change", async () => {
      syncCheckboxVisual(cb);
      markDirty();
      await flushSaveNow(`checkbox:${cb.id}`);
    });

    wrapper.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "LABEL") return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  console.log("✅ Checkboxes wired");
}

// =====================================
// INPUTS: save on BLUR (click out)
// =====================================
function setupInputSaveOnBlur() {
  document.querySelectorAll("input, textarea").forEach(el => {
    if (el.type === "checkbox") return;

    el.addEventListener("input", () => {
      markDirty();

      // live-update body deltas while typing (only for these 3)
      if (el.id === "weight" || el.id === "leanMass" || el.id === "bodyFat") {
        updateBodyDeltasFromUI();
      }
    });

    el.addEventListener("blur", async () => {
      // ensure delta is correct after blur formatting
      if (el.id === "weight" || el.id === "leanMass" || el.id === "bodyFat") {
        updateBodyDeltasFromUI();
      }

      await flushSaveNow(`blur:${el.id || el.name || el.tagName}`);
    });
  });

  console.log("✅ Inputs wired (blur-save + delta updates)");
}


// =====================================
// COLLAPSIBLES: save when collapsing
// =====================================
function setupCollapsibleSectionsSaveOnCollapse() {
  document.querySelectorAll(".section-header.collapsible").forEach(header => {
    header.addEventListener("click", async () => {
      const wasCollapsed = header.classList.contains("collapsed");

      header.classList.toggle("collapsed");
      const content = header.nextElementSibling;
      if (content && content.classList.contains("section-content")) {
        content.classList.toggle("collapsed");
      }

      const nowCollapsed = header.classList.contains("collapsed");
      // If it was open and is now collapsed -> commit save
      if (!wasCollapsed && nowCollapsed) {
        await flushSaveNow(`collapse:${header.id || header.textContent || "section"}`);
      }
    });
  });

  console.log("✅ Collapsible sections wired (collapse-save)");
}

// =====================================
// WATER BUTTONS: save immediately
// =====================================
function updateWaterDisplay() {
  const waterCountEl = document.getElementById("waterCount");
  if (waterCountEl) waterCountEl.textContent = String(waterCount);
}

function setupWaterButtons() {
  const plus = document.getElementById("waterPlus");
  const minus = document.getElementById("waterMinus");
  if (!plus || !minus) return;

  plus.addEventListener("click", async (e) => {
    e.preventDefault();
    waterCount += 1;
    updateWaterDisplay();
    markDirty();
    await flushSaveNow("water_plus");
  });

  minus.addEventListener("click", async (e) => {
    e.preventDefault();
    waterCount = Math.max(0, waterCount - 1);
    updateWaterDisplay();
    markDirty();
    await flushSaveNow("water_minus");
  });

  console.log("✅ Water buttons wired");
}

// =====================================
// BLOOD PRESSURE CALCULATOR
// =====================================
function setupBloodPressureCalculator() {
  const systolicEl = document.getElementById("systolic");
  const diastolicEl = document.getElementById("diastolic");
  const bpStatusEl = document.getElementById("bpStatus");

  if (!systolicEl || !diastolicEl || !bpStatusEl) return;

  const calculateBPStatus = () => {
    const systolic = parseInt(systolicEl.value, 10);
    const diastolic = parseInt(diastolicEl.value, 10);

    if (!systolic || !diastolic) {
      bpStatusEl.textContent = "--";
      bpStatusEl.style.color = "#52b788";
      return;
    }

    let status = "";
    let color = "#52b788";

    if (systolic < 120 && diastolic < 80) {
      status = "Normal";
      color = "#52b788";
    } else if (systolic >= 120 && systolic <= 129 && diastolic < 80) {
      status = "Elevated";
      color = "#f4a261";
    } else if ((systolic >= 130 && systolic <= 139) || (diastolic >= 80 && diastolic <= 89)) {
      status = "Stage 1 High";
      color = "#e76f51";
    } else if (systolic >= 140 || diastolic >= 90) {
      status = "Stage 2 High";
      color = "#e63946";
    } else if (systolic > 180 || diastolic > 120) {
      status = "Crisis";
      color = "#d00000";
    }

    bpStatusEl.textContent = status;
    bpStatusEl.style.color = color;
  };

  systolicEl.addEventListener("input", calculateBPStatus);
  diastolicEl.addEventListener("input", calculateBPStatus);

  console.log("✅ Blood pressure calculator wired");
}

// =====================================
// BODY carry-forward helpers
// =====================================
function hasAnyBodyData(daily) {
  if (!daily) return false;
  return BODY_FIELDS.some(f => {
    const v = f.keys.reduce((acc, k) => acc ?? daily[k], undefined);
    return v !== undefined && v !== null && v !== "";
  });
}

async function getMostRecentBodyDaily(beforeDate, lookbackDays = 45) {
  const d = new Date(beforeDate);

  for (let i = 1; i <= lookbackDays; i++) {
    d.setDate(d.getDate() - 1);
    const dateStr = formatDateForAPI(d);

    const result = await apiGet("load", { date: dateStr });
    const daily = result?.daily;

    if (hasAnyBodyData(daily)) {
      console.log("⏩ Carry-forward body data from", dateStr);
      return daily;
    }
  }

  console.log("⏩ No prior body data found in lookback window");
  return null;
}

function applyBodyFieldsFromDaily(daily) {
  const source = daily || {};

  const weightVal = source["Weight (lbs)"] ?? source["Weight"];
  const waistVal = source["Waist (in)"] ?? source["Waist"];
  const leanVal = source["Lean Mass (lbs)"] ?? source["Lean Mass"];
  const fatVal = source["Body Fat (lbs)"] ?? source["Body Fat"];
  const boneVal = source["Bone Mass (lbs)"] ?? source["Bone Mass"];
  const waterBodyVal = source["Water (lbs)"]; // important

  const weightEl = document.getElementById("weight");
  const waistEl = document.getElementById("waist");
  const leanMassEl = document.getElementById("leanMass");
  const bodyFatEl = document.getElementById("bodyFat");
  const boneMassEl = document.getElementById("boneMass");
  const waterBodyEl = document.getElementById("water");

  if (weightEl) weightEl.value = weightVal ?? "";
  if (waistEl) waistEl.value = waistVal ?? "";
  if (leanMassEl) leanMassEl.value = leanVal ?? "";
  if (bodyFatEl) bodyFatEl.value = fatVal ?? "";
  if (boneMassEl) boneMassEl.value = boneVal ?? "";
  if (waterBodyEl) waterBodyEl.value = waterBodyVal ?? "";

  if (typeof calculatePercentages === "function") calculatePercentages();
}

// =====================================
// populateForm: set UI from sheet data
// =====================================
async function populateForm(data) {
  // Don’t reset the form; it can wipe fields and cause “disappearing” confusion.
  // Instead we explicitly set fields we care about.

  // clear checkbox visuals
  document.querySelectorAll(".checkbox-field").forEach(w => w.classList.remove("checked"));

  // reset state
  movements = [];
  readings = [];
  honeyDos = [];
  currentAverages = null;

  const d = data?.daily || null;

  // BODY CARRY-FORWARD:
  let bodySource = d;
  if (!hasAnyBodyData(d)) {
    bodySource = await getMostRecentBodyDaily(currentDate);
  }

  // Previous measurement (always from an earlier date, not today)
const prevDaily = await getMostRecentBodyDaily(currentDate);
prevBodyForDelta = {
  weight: parseNum(prevDaily?.["Weight (lbs)"] ?? prevDaily?.["Weight"]),
  leanMass: parseNum(prevDaily?.["Lean Mass (lbs)"] ?? prevDaily?.["Lean Mass"]),
  bodyFat: parseNum(prevDaily?.["Body Fat (lbs)"] ?? prevDaily?.["Body Fat"])
};



  updateAverages(data?.averages);

  // No daily data for this date
  if (!d) {
    waterCount = 0;
    updateWaterDisplay();

    movements = (data?.movements || []).map(m => ({
      duration: m.duration ?? m["duration (min)"] ?? m["Duration"] ?? m["Duration (min)"],
      type: m.type ?? m["type"] ?? m["Type"]
    }));
    renderMovements();

    readings = (data?.readings || []).map(r => ({
      duration: r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"],
      book: r.book ?? r["book"] ?? r["Book"]
    }));
    renderReadings();

    honeyDos = data?.honeyDos || [];
    if (typeof renderHoneyDos === "function") renderHoneyDos();

    const reflectionsEl = document.getElementById("reflections");
    if (reflectionsEl) reflectionsEl.value = data?.reflections || "";
    const storiesEl = document.getElementById("stories");
    if (storiesEl) storiesEl.value = data?.stories || "";
    const carlyEl = document.getElementById("carly");
    if (carlyEl) carlyEl.value = data?.carly || "";

    // Apply carried-forward body values
    applyBodyFieldsFromDaily(bodySource);
    
    // Set "previous" as the last time each metric was DIFFERENT (avoids 0 deltas from carry-forward)
    const curWeight = document.getElementById("weight")?.value;
    const curLean = document.getElementById("leanMass")?.value;
    const curFat = document.getElementById("bodyFat")?.value;

    const [prevW, prevL, prevF] = await Promise.all([
      getMostRecentDifferentBodyValue(currentDate, ["Weight (lbs)", "Weight"], curWeight),
      getMostRecentDifferentBodyValue(currentDate, ["Lean Mass (lbs)", "Lean Mass"], curLean),
      getMostRecentDifferentBodyValue(currentDate, ["Body Fat (lbs)", "Body Fat"], curFat)
]);

prevBodyForDelta = {
  weight: prevW?.value ?? null,
  leanMass: prevL?.value ?? null,
  bodyFat: prevF?.value ?? null
};

// (optional) if you want to show the date too later, keep prevW?.date etc.
updateBodyDeltasFromUI();

    updateBodyDeltasFromUI();
    


    // Clear blood pressure fields (no data for this date)
    const systolicEl = document.getElementById("systolic");
    if (systolicEl) systolicEl.value = "";
    const diastolicEl = document.getElementById("diastolic");
    if (diastolicEl) diastolicEl.value = "";
    const heartRateEl = document.getElementById("heartRate");
    if (heartRateEl) heartRateEl.value = "";

    const bpStatusEl = document.getElementById("bpStatus");
    if (bpStatusEl) {
      bpStatusEl.textContent = "--";
      bpStatusEl.style.color = "#52b788";
    }

    document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(syncCheckboxVisual);
    console.log("✅ populateForm ran (no daily)");
    return;
  }

  // Numbers
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

  // Checkboxes (sheet -> UI)
  setCheckbox("inhalerMorning", d["Grey's Inhaler Morning"] ?? d["Inhaler Morning"]);
  setCheckbox("inhalerEvening", d["Grey's Inhaler Evening"] ?? d["Inhaler Evening"]);
  setCheckbox("multiplication", d["5 min Multiplication"]);
  setCheckbox("rehit", d["REHIT 2x10"] ?? d["REHIT"]);

  setCheckbox("creatine", d["Creatine Chews"] ?? d["Creatine"]);
  setCheckbox("vitaminD", d["Vitamin D"]);
  setCheckbox("no2", d["NO2"]);
  setCheckbox("psyllium", d["Psyllium Husk"] ?? d["Psyllium"]);

  setCheckbox("breakfast", d["Breakfast"]);
  setCheckbox("lunch", d["Lunch"]);
  setCheckbox("dinner", d["Dinner"]);

  setCheckbox("daySnacks", d["Healthy Day Snacks"] ?? d["Day Snacks"]);
  setCheckbox("nightSnacks", d["Healthy Night Snacks"] ?? d["Night Snacks"]);
  setCheckbox("noAlcohol", d["No Alcohol"]);

  setCheckbox("meditation", d["Meditation"]);

  // Water counter (hydration)
  waterCount = parseInt(d["Water"], 10) || 0;
  updateWaterDisplay();

  // Body fields: use current day if present, else carry-forward source
  applyBodyFieldsFromDaily(bodySource);

  // Blood Pressure
  const systolicEl = document.getElementById("systolic");
  if (systolicEl) systolicEl.value = d["Systolic"] ?? "";

  const diastolicEl = document.getElementById("diastolic");
  if (diastolicEl) diastolicEl.value = d["Diastolic"] ?? "";

  const heartRateEl = document.getElementById("heartRate");
  // sheet header is "Heart Rate" (you already fixed this)
  if (heartRateEl) heartRateEl.value = d["Heart Rate"] ?? "";

  if (systolicEl?.value && diastolicEl?.value) {
    systolicEl.dispatchEvent(new Event("input"));
  }

  // Lists
  movements = (data?.movements || []).map(m => ({
    duration: m.duration ?? m["duration (min)"] ?? m["Duration"] ?? m["Duration (min)"],
    type: m.type ?? m["Type"] ?? m["type"]
  }));
  renderMovements();

  readings = (data?.readings || []).map(r => ({
    duration: r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"],
    book: r.book ?? r["Book"] ?? r["book"]
  }));
  if (readings.length > 0) lastBookTitle = String(readings[readings.length - 1].book || "");
  renderReadings();

  honeyDos = data?.honeyDos || [];
  if (typeof renderHoneyDos === "function") renderHoneyDos();

  // Textareas
  const reflectionsEl = document.getElementById("reflections");
  if (reflectionsEl) reflectionsEl.value = data?.reflections || "";

  const storiesEl = document.getElementById("stories");
  if (storiesEl) storiesEl.value = data?.stories || "";

  const carlyEl = document.getElementById("carly");
  if (carlyEl) carlyEl.value = data?.carly || "";

  // final sweep
  document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(syncCheckboxVisual);

  console.log("✅ populateForm ran");
}

// =====================================
// MOVEMENT UI
// =====================================
function setupMovementUI() {
  const btn = document.getElementById("addMovementBtn");
  if (!btn) {
    console.warn("addMovementBtn not found");
    return;
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    promptAddMovement();
  });

  console.log("✅ Movement UI wired");
}

function promptAddMovement() {
  const raw = prompt("Movement duration (minutes):");
  if (raw === null) return;

  const durationNum = parseInt(raw, 10);
  if (!Number.isFinite(durationNum) || durationNum <= 0) {
    alert("Please enter a valid number of minutes.");
    return;
  }

  const type = durationNum > 12 ? "Long" : "Short";
  movements.push({ duration: durationNum, type });

  renderMovements();
  queueSaveSoon("movement_add");
}

function removeMovement(index) {
  movements.splice(index, 1);
  renderMovements();
  queueSaveSoon("movement_remove");
}

function renderMovements() {
  const list = document.getElementById("movementList");
  if (!list) return;

  list.innerHTML = "";

  movements.forEach((m, idx) => {
    const duration = m.duration ?? "";
    const type = m.type ?? "";

    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${escapeHtml(duration)} min (${escapeHtml(type)})</span>
      <button type="button" class="btn btn-danger" data-idx="${idx}">×</button>
    `;

    item.querySelector("button").addEventListener("click", () => removeMovement(idx));
    list.appendChild(item);
  });

  if (typeof checkSectionCompletion === "function") checkSectionCompletion();
}

// =====================================
// READING UI (simple prompt version)
// If you have a modal version, you can replace this safely.
// =====================================
function setupReadingUI() {
  const btn = document.getElementById("addReadingBtn");
  if (!btn) {
    console.warn("addReadingBtn not found");
    return;
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    promptAddReading();
  });

  console.log("✅ Reading UI wired");
}

function promptAddReading() {
  const raw = prompt("Reading duration (minutes):");
  if (raw === null) return;

  const durationNum = parseInt(raw, 10);
  if (!Number.isFinite(durationNum) || durationNum <= 0) {
    alert("Please enter a valid number of minutes.");
    return;
  }

  let book = prompt("Book title (optional). Leave blank to use your last book:");
  if (book === null) return;
  book = String(book || "").trim();
  if (!book && lastBookTitle) book = lastBookTitle;
  if (book) lastBookTitle = book;

  readings.push({ duration: durationNum, book });

  renderReadings();
  queueSaveSoon("reading_add");
}

function removeReading(index) {
  readings.splice(index, 1);
  renderReadings();
  queueSaveSoon("reading_remove");
}

function renderReadings() {
  const list = document.getElementById("readingList");
  if (!list) return;

  list.innerHTML = "";

  readings.forEach((r, idx) => {
    const duration = r.duration ?? "";
    const book = r.book ?? "";

    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${escapeHtml(duration)} min${book ? ` — ${escapeHtml(book)}` : ""}</span>
      <button type="button" class="btn btn-danger" data-idx="${idx}">×</button>
    `;

    item.querySelector("button").addEventListener("click", () => removeReading(idx));
    list.appendChild(item);
  });

  if (typeof checkSectionCompletion === "function") checkSectionCompletion();
}

// =====================================
// AVERAGES (includes readingMinutes7d if you added it server-side)
// =====================================
function updateAverages(averages) {
  currentAverages = averages || null;

  const avgSleepEl = document.getElementById("avgSleep");
  const avgStepsEl = document.getElementById("avgSteps");
  const avgMovementsEl = document.getElementById("avgMovements");
  const rehitWeekEl = document.getElementById("rehitWeek");
  const avgReadingMinutesEl = document.getElementById("avgReadingMinutes");

  if (!averages) {
    if (avgSleepEl) avgSleepEl.textContent = "--";
    if (avgStepsEl) avgStepsEl.textContent = "--";
    if (avgMovementsEl) avgMovementsEl.textContent = "--";
    if (rehitWeekEl) rehitWeekEl.textContent = "--";
    if (avgReadingMinutesEl) avgReadingMinutesEl.textContent = "--";
    return;
  }

  if (avgSleepEl) {
    const v = averages.sleep;
    avgSleepEl.textContent = (v === null || v === undefined || v === "") ? "--" : Number(v).toFixed(2);
  }

  if (avgStepsEl) {
    const v = averages.steps;
    avgStepsEl.textContent = (v === null || v === undefined || v === "") ? "--" : Number(v).toLocaleString();
  }

  if (avgMovementsEl) {
    const v = averages.movements;
    const num = (v === null || v === undefined || v === "") ? null : Number(v);
    avgMovementsEl.textContent = (num === null || Number.isNaN(num)) ? "--" : num.toFixed(1);
  }

  if (rehitWeekEl) {
    const v = averages.rehitWeek;
    rehitWeekEl.textContent = (v === null || v === undefined || v === "") ? "--" : String(v);
  }

  if (avgReadingMinutesEl) {
    const v = averages.readingMinutes7d;
    avgReadingMinutesEl.textContent = (v === null || v === undefined || v === "") ? "--" : Number(v).toLocaleString();
  }
}

// =====================================
// Reload when returning after idle
// =====================================
function setupReloadOnReturnFromIdle() {
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") {
      // best-effort save if leaving
      await flushSaveNow("visibility_hide");
      return;
    }

    const idleFor = Date.now() - lastUserActivityAt;
    if (idleFor > RELOAD_AFTER_IDLE_MS) {
      await loadDataForCurrentDate({ force: true });
    }
  });

  window.addEventListener("focus", async () => {
    const idleFor = Date.now() - lastUserActivityAt;
    if (idleFor > RELOAD_AFTER_IDLE_MS) {
      await loadDataForCurrentDate({ force: true });
    }
  });
}

// =====================================
// Biomarkers toggle wiring (safe noop if not present)
// =====================================
function setupBiomarkersUIToggleSafe() {
  const btn = document.getElementById("biomarkersBtn");
  const page = document.getElementById("biomarkersPage");
  const form = document.getElementById("healthForm");
  if (!btn || !page || !form) return;

  btn.addEventListener("click", async () => {
    const open = page.style.display === "block";
    if (open) {
      page.style.display = "none";
      form.style.display = "block";
    } else {
      // Save before leaving habit page
      await flushSaveNow("open_biomarkers");
      form.style.display = "none";
      page.style.display = "block";

      // If you have loadBiomarkersMostRecent defined elsewhere, call it
      if (typeof loadBiomarkersMostRecent === "function") {
        await loadBiomarkersMostRecent();
      }
    }
  });
}

// =====================================
// Status message UI
// =====================================
function showStatus(msg, kind = "success", timeoutMs = 1500) {
  const el = document.getElementById("statusMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = `status-message ${kind}`;
  el.style.display = "block";
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => { el.style.display = "none"; }, timeoutMs);
}

// =====================================
// Utilities
// =====================================
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseNum(v) {
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function setDelta(elId, delta, isPositive) {
  const el = document.getElementById(elId);
  if (!el) return;

  if (delta === null || Math.abs(delta) < 0.0001) {
    el.style.display = "none";
    el.classList.remove("positive", "negative");
    el.innerHTML = "";
    return;
  }

  const abs = Math.round(Math.abs(delta) * 10) / 10; // 1 decimal
  const up = "▲";
  const down = "▼";

  const tri = delta > 0 ? up : down;

  el.classList.toggle("positive", isPositive);
  el.classList.toggle("negative", !isPositive);
  el.style.display = "inline-flex";
  el.innerHTML = `<span class="tri">${tri}</span><span class="val">${abs}</span>`;
}

function updateBodyDeltasFromUI() {
  console.log("prevBodyForDelta", prevBodyForDelta);
  console.log("cur", {
    weight: document.getElementById("weight")?.value,
    leanMass: document.getElementById("leanMass")?.value,
    bodyFat: document.getElementById("bodyFat")?.value
});

  
  const curWeight = parseNum(document.getElementById("weight")?.value);
  const curLean = parseNum(document.getElementById("leanMass")?.value);
  const curFat = parseNum(document.getElementById("bodyFat")?.value);

  const prevW = prevBodyForDelta.weight;
  const prevL = prevBodyForDelta.leanMass;
  const prevF = prevBodyForDelta.bodyFat;

  // Weight: decreasing is positive
  const dW = (curWeight !== null && prevW !== null) ? (curWeight - prevW) : null;
  setDelta("weightDelta", dW, dW !== null ? (dW < 0) : false);

  // Lean mass: increasing is positive
  const dL = (curLean !== null && prevL !== null) ? (curLean - prevL) : null;
  setDelta("leanMassDelta", dL, dL !== null ? (dL > 0) : false);

  // Body fat: decreasing is positive
  const dF = (curFat !== null && prevF !== null) ? (curFat - prevF) : null;
  setDelta("bodyFatDelta", dF, dF !== null ? (dF < 0) : false);
}

async function getMostRecentDifferentBodyValue(beforeDate, fieldKeys, currentValue, lookbackDays = 180) {
  const cur = parseNum(currentValue);
  if (cur === null) return null;

  const d = new Date(beforeDate);

  for (let i = 1; i <= lookbackDays; i++) {
    d.setDate(d.getDate() - 1);
    const dateStr = formatDateForAPI(d);

    const result = await apiGet("load", { date: dateStr });
    const daily = result?.daily;
    if (!daily) continue;

    const priorRaw = fieldKeys.reduce((acc, k) => acc ?? daily[k], undefined);
    const prior = parseNum(priorRaw);

    if (prior === null) continue;

    // Treat as "different" if not equal (small tolerance)
    if (Math.abs(prior - cur) > 0.0001) {
      return { value: prior, date: dateStr };
    }
  }

  return null;
}

