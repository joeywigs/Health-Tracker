/**********************************************
 * Habit Tracker - app.js (clean + consistent)
 *
 * CONSISTENCY RULES:
 * ✅ Load data when:
 *    - you change dates (prev/next)
 *    - you return to the app after being idle
 *
 * ✅ Save data when:
 *    - you blur (click out) of an input/textarea
 *    - you collapse a section
 *    - you toggle a checkbox
 *    - you press water +/- buttons
 *    - you add/remove a movement or reading session
 *
 * 🚫 Never auto-reload immediately after saving (prevents “revert/disappear”)
 *
 * BODY DELTA INDICATORS:
 * - Weight: down is good (green ▼)
 * - Lean mass: up is good (green ▲)
 * - Body fat: down is good (green ▼)
 * - Previous baseline = last time that metric was DIFFERENT (not just yesterday’s carry-forward)
 * - Not shown for Water (lbs)
 *
 * NOTE: For indicators to render, index.html must include:
 *   <div class="delta-indicator" id="weightDelta"></div>
 *   <div class="delta-indicator" id="leanMassDelta"></div>
 *   <div class="delta-indicator" id="bodyFatDelta"></div>
 **********************************************/

console.log("✅ app.js running", new Date().toISOString());
window.__APP_JS_OK__ = true;

// =====================================
// CONFIG
// =====================================
const API_URL = "https://habit-proxy.joeywigs.workers.dev/";
const RELOAD_AFTER_IDLE_MS = 2 * 60 * 1000; // 2 min idle -> reload on return
const BODY_DIFF_LOOKBACK_DAYS = 365;        // how far back to find last different body measurement

// Body fields (carry-forward + detection)
const BODY_FIELDS = [
  { id: "weight", keys: ["Weight (lbs)", "Weight"] },
  { id: "waist", keys: ["Waist (in)", "Waist"] },
  { id: "leanMass", keys: ["Lean Mass (lbs)", "Lean Mass"] },
  { id: "bodyFat", keys: ["Body Fat (lbs)", "Body Fat"] },
  { id: "boneMass", keys: ["Bone Mass (lbs)", "Bone Mass"] },
  { id: "water", keys: ["Water (lbs)"] } // IMPORTANT: do NOT fall back to "Water" (hydration)
];

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
// STATE
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

// Body deltas
let prevBodyForDelta = { weight: null, leanMass: null, bodyFat: null };
let _deltaFetchToken = 0;

// =====================================
// BOOTSTRAP
// =====================================
document.addEventListener("DOMContentLoaded", async () => {
  setupDateNav();
  setupCheckboxes();
  setupWaterButtons();
  setupInputSaveOnBlur();
  setupCollapsibleSectionsSaveOnCollapse();
  setupMovementUI();
  setupReadingUI();
  setupBloodPressureCalculator();
  setupReloadOnReturnFromIdle();

  // Optional Biomarkers toggle wiring (no-op if elements absent)
  setupBiomarkersUIToggleSafe();

  updateDateDisplay();
  updatePhaseInfo();

  await loadDataForCurrentDate({ force: true });
});

// =====================================
// PHASE INFO
// =====================================
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
  if (!prev || !next) return;

  prev.addEventListener("click", async (e) => {
    e.preventDefault();
    await changeDate(-1);
  });

  next.addEventListener("click", async (e) => {
    e.preventDefault();
    await changeDate(1);
  });
}

async function changeDate(days) {
  await flushSaveNow("date_change");

  currentDate.setDate(currentDate.getDate() + days);
  updateDateDisplay();
  updatePhaseInfo();

  await loadDataForCurrentDate({ force: true });
}

// =====================================
// LOAD
// =====================================
async function loadDataForCurrentDate({ force = false } = {}) {
  const dateStr = formatDateForAPI(currentDate);
  try {
    showStatus("Loading…", "loading");

    const result = await apiGet("load", { date: dateStr });
    if (result?.error) {
      console.error("Load error:", result.message);
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

async function flushSaveNow(reason = "flush") {
  if (!dataChanged) return;

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

    // Hydration counter
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
// INPUTS: save on blur
// Also updates body delta indicators live for weight/leanMass/bodyFat
// =====================================
function setupInputSaveOnBlur() {
  document.querySelectorAll("input, textarea").forEach(el => {
    if (el.type === "checkbox") return;

    el.addEventListener("input", () => {
      markDirty();
      if (el.id === "weight" || el.id === "leanMass" || el.id === "bodyFat") {
        updateBodyDeltasFromUI();
      }
    });

    el.addEventListener("blur", async () => {
      if (el.id === "weight" || el.id === "leanMass" || el.id === "bodyFat") {
        updateBodyDeltasFromUI();
      }
      await flushSaveNow(`blur:${el.id || el.name || el.tagName}`);
    });
  });
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
      if (!wasCollapsed && nowCollapsed) {
        await flushSaveNow(`collapse:${header.id || header.textContent || "section"}`);
      }
    });
  });
}

// =====================================
// CHECKBOXES: save immediately on change
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
      status = "Normal"; color = "#52b788";
    } else if (systolic >= 120 && systolic <= 129 && diastolic < 80) {
      status = "Elevated"; color = "#f4a261";
    } else if ((systolic >= 130 && systolic <= 139) || (diastolic >= 80 && diastolic <= 89)) {
      status = "Stage 1 High"; color = "#e76f51";
    } else if (systolic >= 140 || diastolic >= 90) {
      status = "Stage 2 High"; color = "#e63946";
    } else if (systolic > 180 || diastolic > 120) {
      status = "Crisis"; color = "#d00000";
    }

    bpStatusEl.textContent = status;
    bpStatusEl.style.color = color;
  };

  systolicEl.addEventListener("input", calculateBPStatus);
  diastolicEl.addEventListener("input", calculateBPStatus);
}

// =====================================
// MOVEMENT UI
// =====================================
function setupMovementUI() {
  const btn = document.getElementById("addMovementBtn");
  if (!btn) return;

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    promptAddMovement();
  });
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
  markDirty();
  flushSaveNow("movement_add");
}

function removeMovement(index) {
  movements.splice(index, 1);
  renderMovements();
  markDirty();
  flushSaveNow("movement_remove");
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
// READING UI (prompt version)
// =====================================
function setupReadingUI() {
  const btn = document.getElementById("addReadingBtn");
  if (!btn) return;

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    promptAddReading();
  });
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
  markDirty();
  flushSaveNow("reading_add");
}

function removeReading(index) {
  readings.splice(index, 1);
  renderReadings();
  markDirty();
  flushSaveNow("reading_remove");
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
// AVERAGES (optional: readingMinutes7d if present)
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
// BODY carry-forward + DELTAS
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
      return daily;
    }
  }
  return null;
}

function applyBodyFieldsFromDaily(daily) {
  const source = daily || {};

  const weightVal = source["Weight (lbs)"] ?? source["Weight"];
  const waistVal = source["Waist (in)"] ?? source["Waist"];
  const leanVal = source["Lean Mass (lbs)"] ?? source["Lean Mass"];
  const fatVal = source["Body Fat (lbs)"] ?? source["Body Fat"];
  const boneVal = source["Bone Mass (lbs)"] ?? source["Bone Mass"];
  const waterBodyVal = source["Water (lbs)"]; // do NOT fall back to hydration

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
  const tri = delta > 0 ? "▲" : "▼";

  el.classList.toggle("positive", isPositive);
  el.classList.toggle("negative", !isPositive);
  el.style.display = "inline-flex";
  el.innerHTML = `<span class="tri">${tri}</span><span class="val">${abs}</span>`;
}

function updateBodyDeltasFromUI() {
  const curWeight = parseNum(document.getElementById("weight")?.value);
  const curLean = parseNum(document.getElementById("leanMass")?.value);
  const curFat = parseNum(document.getElementById("bodyFat")?.value);

  const prevW = prevBodyForDelta.weight;
  const prevL = prevBodyForDelta.leanMass;
  const prevF = prevBodyForDelta.bodyFat;

  const dW = (curWeight !== null && prevW !== null) ? (curWeight - prevW) : null;
  setDelta("weightDelta", dW, dW !== null ? (dW < 0) : false);

  const dL = (curLean !== null && prevL !== null) ? (curLean - prevL) : null;
  setDelta("leanMassDelta", dL, dL !== null ? (dL > 0) : false);

  const dF = (curFat !== null && prevF !== null) ? (curFat - prevF) : null;
  setDelta("bodyFatDelta", dF, dF !== null ? (dF < 0) : false);
}

// Find previous baseline = last time each metric was DIFFERENT (single pass: <= lookback API calls)
async function computePrevDifferentBodyBaselines_(beforeDate, currentVals, lookbackDays = BODY_DIFF_LOOKBACK_DAYS) {
  const remaining = new Set(["weight", "leanMass", "bodyFat"]);
  const out = { weight: null, leanMass: null, bodyFat: null };

  const curW = currentVals.weight;
  const curL = currentVals.leanMass;
  const curF = currentVals.bodyFat;

  const d = new Date(beforeDate);

  for (let i = 1; i <= lookbackDays; i++) {
    if (remaining.size === 0) break;

    d.setDate(d.getDate() - 1);
    const dateStr = formatDateForAPI(d);

    const result = await apiGet("load", { date: dateStr });
    const daily = result?.daily;
    if (!daily) continue;

    if (remaining.has("weight")) {
      const v = parseNum(daily["Weight (lbs)"] ?? daily["Weight"]);
      if (v !== null && curW !== null && Math.abs(v - curW) > 0.0001) {
        out.weight = v;
        remaining.delete("weight");
      }
    }

    if (remaining.has("leanMass")) {
      const v = parseNum(daily["Lean Mass (lbs)"] ?? daily["Lean Mass"]);
      if (v !== null && curL !== null && Math.abs(v - curL) > 0.0001) {
        out.leanMass = v;
        remaining.delete("leanMass");
      }
    }

    if (remaining.has("bodyFat")) {
      const v = parseNum(daily["Body Fat (lbs)"] ?? daily["Body Fat"]);
      if (v !== null && curF !== null && Math.abs(v - curF) > 0.0001) {
        out.bodyFat = v;
        remaining.delete("bodyFat");
      }
    }
  }

  return out;
}

// =====================================
// populateForm
// =====================================
async function populateForm(data) {
  // reset visuals
  document.querySelectorAll(".checkbox-field").forEach(w => w.classList.remove("checked"));

  // reset lists/state
  movements = [];
  readings = [];
  honeyDos = [];
  currentAverages = null;

  const d = data?.daily || null;

  // Determine body source (carry-forward if needed)
  let bodySource = d;
  if (!hasAnyBodyData(d)) {
    bodySource = await getMostRecentBodyDaily(currentDate);
  }

  // Update averages
  updateAverages(data?.averages);

  // Hydration
  waterCount = parseInt(d?.["Water"], 10) || 0;
  updateWaterDisplay();

  // Movements/Readings/HoneyDos
  movements = (data?.movements || []).map(m => ({
    duration: m.duration ?? m["duration (min)"] ?? m["Duration"] ?? m["Duration (min)"],
    type: m.type ?? m["Type"] ?? m["type"]
  }));

  readings = (data?.readings || []).map(r => ({
    duration: r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"],
    book: r.book ?? r["Book"] ?? r["book"]
  }));

  honeyDos = data?.honeyDos || [];

  if (readings.length > 0) lastBookTitle = String(readings[readings.length - 1].book || "");

  renderMovements();
  renderReadings();
  if (typeof renderHoneyDos === "function") renderHoneyDos();

  // Textareas
  const reflectionsEl = document.getElementById("reflections");
  if (reflectionsEl) reflectionsEl.value = data?.reflections || "";
  const storiesEl = document.getElementById("stories");
  if (storiesEl) storiesEl.value = data?.stories || "";
  const carlyEl = document.getElementById("carly");
  if (carlyEl) carlyEl.value = data?.carly || "";

  // Numbers
  const sleepEl = document.getElementById("sleepHours");
  if (sleepEl) sleepEl.value = d?.["Hours of Sleep"] ?? "";
  const stepsEl = document.getElementById("steps");
  if (stepsEl) stepsEl.value = d?.["Steps"] ?? "";
  const fitnessEl = document.getElementById("fitnessScore");
  if (fitnessEl) fitnessEl.value = d?.["Fitness Score"] ?? "";
  const caloriesEl = document.getElementById("calories");
  if (caloriesEl) caloriesEl.value = d?.["Calories"] ?? "";
  const peakWattsEl = document.getElementById("peakWatts");
  if (peakWattsEl) peakWattsEl.value = d?.["Peak Watts"] ?? "";
  const wattSecondsEl = document.getElementById("wattSeconds");
  if (wattSecondsEl) wattSecondsEl.value = d?.["Watt Seconds"] ?? "";

  // Checkboxes
  setCheckbox("inhalerMorning", d?.["Grey's Inhaler Morning"] ?? d?.["Inhaler Morning"]);
  setCheckbox("inhalerEvening", d?.["Grey's Inhaler Evening"] ?? d?.["Inhaler Evening"]);
  setCheckbox("multiplication", d?.["5 min Multiplication"]);
  setCheckbox("rehit", d?.["REHIT 2x10"] ?? d?.["REHIT"]);

  setCheckbox("creatine", d?.["Creatine Chews"] ?? d?.["Creatine"]);
  setCheckbox("vitaminD", d?.["Vitamin D"]);
  setCheckbox("no2", d?.["NO2"]);
  setCheckbox("psyllium", d?.["Psyllium Husk"] ?? d?.["Psyllium"]);

  setCheckbox("breakfast", d?.["Breakfast"]);
  setCheckbox("lunch", d?.["Lunch"]);
  setCheckbox("dinner", d?.["Dinner"]);

  setCheckbox("daySnacks", d?.["Healthy Day Snacks"] ?? d?.["Day Snacks"]);
  setCheckbox("nightSnacks", d?.["Healthy Night Snacks"] ?? d?.["Night Snacks"]);
  setCheckbox("noAlcohol", d?.["No Alcohol"]);

  setCheckbox("meditation", d?.["Meditation"]);

  // Body fields
  applyBodyFieldsFromDaily(bodySource);

  // BP fields
  const systolicEl = document.getElementById("systolic");
  if (systolicEl) systolicEl.value = d?.["Systolic"] ?? "";
  const diastolicEl = document.getElementById("diastolic");
  if (diastolicEl) diastolicEl.value = d?.["Diastolic"] ?? "";
  const heartRateEl = document.getElementById("heartRate");
  if (heartRateEl) heartRateEl.value = d?.["Heart Rate"] ?? "";

  if (systolicEl?.value && diastolicEl?.value) {
    systolicEl.dispatchEvent(new Event("input"));
  } else {
    const bpStatusEl = document.getElementById("bpStatus");
    if (bpStatusEl) {
      bpStatusEl.textContent = "--";
      bpStatusEl.style.color = "#52b788";
    }
  }

  // Final sweep checkbox visuals
  document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(syncCheckboxVisual);

  // ---- BODY DELTAS: baseline = last DIFFERENT values ----
  const token = ++_deltaFetchToken;

  const curVals = {
    weight: parseNum(document.getElementById("weight")?.value),
    leanMass: parseNum(document.getElementById("leanMass")?.value),
    bodyFat: parseNum(document.getElementById("bodyFat")?.value)
  };

  // Hide until baseline is known
  prevBodyForDelta = { weight: null, leanMass: null, bodyFat: null };
  updateBodyDeltasFromUI();

  // Compute baseline in background; then render if still on same load token
  (async () => {
    const baselines = await computePrevDifferentBodyBaselines_(currentDate, curVals);
    if (token !== _deltaFetchToken) return; // ignore stale async completion
    prevBodyForDelta = baselines;
    updateBodyDeltasFromUI();
  })();
}

// =====================================
// Reload when returning after idle
// =====================================
function setupReloadOnReturnFromIdle() {
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") {
      await flushSaveNow("visibility_hide");
      return;
    }
    const idleFor = Date.now() - lastUserActivityAt;
    if (idleFor > RELOAD_AFTER_IDLE_MS) {
      await flushSaveNow("idle_return_save");
      await loadDataForCurrentDate({ force: true });
    }
  });

  window.addEventListener("focus", async () => {
    const idleFor = Date.now() - lastUserActivityAt;
    if (idleFor > RELOAD_AFTER_IDLE_MS) {
      await flushSaveNow("focus_return_save");
      await loadDataForCurrentDate({ force: true });
    }
  });
}

// =====================================
// Biomarkers toggle wiring (safe no-op if not present)
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
      await flushSaveNow("open_biomarkers");
      form.style.display = "none";
      page.style.display = "block";
      if (typeof loadBiomarkersMostRecent === "function") {
        await loadBiomarkersMostRecent();
      }
    }
  });
}

// =====================================
// STATUS UI + utils
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

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
