document.documentElement.insertAdjacentHTML(
  "afterbegin",
  "<div style='position:fixed;top:8px;left:8px;z-index:99999;background:#000;color:#0f0;padding:6px 8px;border-radius:8px;font:12px/1.2 -apple-system,system-ui'>app.js loaded</div>"
);


/**********************************************
 * Habit Tracker - app.js (clean + consistent)
 *
 * LOAD:
 *  - when changing dates (prev/next)
 *  - when returning after idle time
 *
 * SAVE:
 *  - blur of input/textarea
 *  - collapsing a section
 *  - checkbox toggle
 *  - water +/- buttons
 *  - add/remove movement or reading
 *
 * NO auto-reload after save (prevents “revert/disappear”)
 *
 * BODY DELTAS:
 *  - Weight: down is good (green ▼)
 *  - Lean mass: up is good (green ▲)
 *  - Body fat: down is good (green ▼)
 *  - Baseline = last time value was DIFFERENT (not carry-forward)
 *  - No deltas for Water (lbs)
 **********************************************/

console.log("✅ app.js running v1", new Date().toISOString());
window.__APP_JS_OK__ = true;

// =====================================
// CONFIG
// =====================================
const API_URL = "https://habit-proxy.joeywigs.workers.dev/";
const RELOAD_AFTER_IDLE_MS = 2 * 60 * 1000; // 2 minutes
const BODY_DIFF_LOOKBACK_DAYS = 365;

// Body fields (carry-forward)
const BODY_FIELDS = [
  { id: "weight", keys: ["Weight (lbs)", "Weight"] },
  { id: "waist", keys: ["Waist (in)", "Waist"] }, // supports either
  { id: "leanMass", keys: ["Lean Mass (lbs)", "Lean Mass"] },
  { id: "bodyFat", keys: ["Body Fat (lbs)", "Body Fat"] },
  { id: "boneMass", keys: ["Bone Mass (lbs)", "Bone Mass"] },
  { id: "water", keys: ["Water (lbs)"] } // IMPORTANT: do NOT fall back to hydration "Water"
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
let lastBookTitle = "";

let waterCount = 0;

// Body deltas baseline (previous different)
let prevBodyForDelta = { weight: null, leanMass: null, bodyFat: null };
let _deltaFetchToken = 0;

// =====================================
// BOOTSTRAP
// =====================================
document.addEventListener("DOMContentLoaded", async () => {
  setupDateNav();
  setupCheckboxes();
  setupRehitChoice(); // mutual exclusivity between rehit2/rehit3
  setupWaterButtons();
  setupInputSaveOnBlur();
  setupCollapsibleSectionsSaveOnCollapse();
  setupMovementUI();
  setupReadingUI();
  setupBloodPressureCalculator();
  setupReloadOnReturnFromIdle();

  // optional biomarkers toggle (no-op if not present)
  setupBiomarkersUIToggleSafe();

  updateDateDisplay();
  updatePhaseInfo?.();

  await loadDataForCurrentDate({ force: true });
});

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
  if (el) el.textContent = currentDate.toDateString();
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
  updatePhaseInfo?.();

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
    // IMPORTANT: no reload here

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
  // REHIT: store a string in the existing "REHIT 2x10" column
  const rehitVal =
    document.getElementById("rehit3")?.checked ? "3x10" :
    document.getElementById("rehit2")?.checked ? "2x10" :
    "";

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

    // store string
    rehit: rehitVal,

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

    // BP
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
// INPUTS: save on BLUR
// also update body delta indicators live
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
// CHECKBOXES (general): save immediately
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
// REHIT mutual exclusivity
// =====================================
function setupRehitChoice() {
  const rehit2 = document.getElementById("rehit2");
  const rehit3 = document.getElementById("rehit3");
  if (!rehit2 || !rehit3) return;

  const enforce = (changed) => {
    if (changed === rehit2 && rehit2.checked) {
      rehit3.checked = false;
      syncCheckboxVisual(rehit3);
    }
    if (changed === rehit3 && rehit3.checked) {
      rehit2.checked = false;
      syncCheckboxVisual(rehit2);
    }
  };

  rehit2.addEventListener("change", () => enforce(rehit2));
  rehit3.addEventListener("change", () => enforce(rehit3));
}

// =====================================
// WATER +/- : save immediately
// =====================================
function updateWaterDisplay() {
  const el = document.getElementById("waterCount");
  if (el) el.textContent = String(waterCount);
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
// BP status calculator (UI only)
// =====================================
function setupBloodPressureCalculator() {
  const systolicEl = document.getElementById("systolic");
  const diastolicEl = document.getElementById("diastolic");
  const bpStatusEl = document.getElementById("bpStatus");
  if (!systolicEl || !diastolicEl || !bpStatusEl) return;

  const calc = () => {
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

  systolicEl.addEventListener("input", calc);
  diastolicEl.addEventListener("input", calc);
}

// =====================================
// Movement UI
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
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${escapeHtml(m.duration)} min (${escapeHtml(m.type)})</span>
      <button type="button" class="btn btn-danger">×</button>
    `;
    item.querySelector("button").addEventListener("click", () => removeMovement(idx));
    list.appendChild(item);
  });
}

// =====================================
// Reading UI (prompt version)
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
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${escapeHtml(r.duration)} min${r.book ? ` — ${escapeHtml(r.book)}` : ""}</span>
      <button type="button" class="btn btn-danger">×</button>
    `;
    item.querySelector("button").addEventListener("click", () => removeReading(idx));
    list.appendChild(item);
  });
}

// =====================================
// Body carry-forward + deltas
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
    if (hasAnyBodyData(daily)) return daily;
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

  if (document.getElementById("weight")) document.getElementById("weight").value = weightVal ?? "";
  if (document.getElementById("waist")) document.getElementById("waist").value = waistVal ?? "";
  if (document.getElementById("leanMass")) document.getElementById("leanMass").value = leanVal ?? "";
  if (document.getElementById("bodyFat")) document.getElementById("bodyFat").value = fatVal ?? "";
  if (document.getElementById("boneMass")) document.getElementById("boneMass").value = boneVal ?? "";
  if (document.getElementById("water")) document.getElementById("water").value = waterBodyVal ?? "";
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

  const abs = Math.round(Math.abs(delta) * 10) / 10;
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

  // Weight: down is good
  const dW = (curWeight !== null && prevW !== null) ? (curWeight - prevW) : null;
  setDelta("weightDelta", dW, dW !== null ? (dW < 0) : false);

  // Lean mass: up is good
  const dL = (curLean !== null && prevL !== null) ? (curLean - prevL) : null;
  setDelta("leanMassDelta", dL, dL !== null ? (dL > 0) : false);

  // Body fat: down is good
  const dF = (curFat !== null && prevF !== null) ? (curFat - prevF) : null;
  setDelta("bodyFatDelta", dF, dF !== null ? (dF < 0) : false);
}

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
  // reset checkbox visuals
  document.querySelectorAll(".checkbox-field").forEach(w => w.classList.remove("checked"));

  const d = data?.daily || null;

  // Carry-forward body if missing
  let bodySource = d;
  if (!hasAnyBodyData(d)) {
    bodySource = await getMostRecentBodyDaily(currentDate);
  }

  // Water counter
  waterCount = parseInt(d?.["Water"], 10) || 0;
  updateWaterDisplay();

  // Numbers
  if (document.getElementById("sleepHours")) document.getElementById("sleepHours").value = d?.["Hours of Sleep"] ?? "";
  if (document.getElementById("steps")) document.getElementById("steps").value = d?.["Steps"] ?? "";
  if (document.getElementById("fitnessScore")) document.getElementById("fitnessScore").value = d?.["Fitness Score"] ?? "";
  if (document.getElementById("calories")) document.getElementById("calories").value = d?.["Calories"] ?? "";
  if (document.getElementById("peakWatts")) document.getElementById("peakWatts").value = d?.["Peak Watts"] ?? "";
  if (document.getElementById("wattSeconds")) document.getElementById("wattSeconds").value = d?.["Watt Seconds"] ?? "";

  // Checkboxes
  setCheckbox("inhalerMorning", d?.["Grey's Inhaler Morning"]);
  setCheckbox("inhalerEvening", d?.["Grey's Inhaler Evening"]);
  setCheckbox("multiplication", d?.["5 min Multiplication"]);

  // REHIT: set 2x10 or 3x10 from the same column
  const rv = String(d?.["REHIT 2x10"] ?? "").trim();
  setCheckbox("rehit2", rv === "2x10");
  setCheckbox("rehit3", rv === "3x10");

  setCheckbox("creatine", d?.["Creatine Chews"]);
  setCheckbox("vitaminD", d?.["Vitamin D"]);
  setCheckbox("no2", d?.["NO2"]);
  setCheckbox("psyllium", d?.["Psyllium Husk"]);

  setCheckbox("breakfast", d?.["Breakfast"]);
  setCheckbox("lunch", d?.["Lunch"]);
  setCheckbox("dinner", d?.["Dinner"]);

  setCheckbox("daySnacks", d?.["Healthy Day Snacks"]);
  setCheckbox("nightSnacks", d?.["Healthy Night Snacks"]);
  setCheckbox("noAlcohol", d?.["No Alcohol"]);
  setCheckbox("meditation", d?.["Meditation"]);

  // Lists
  movements = (data?.movements || []).map(m => ({
    duration: m.duration ?? m["duration (min)"] ?? m["Duration (min)"] ?? m["Duration"],
    type: m.type ?? m["type"] ?? m["Type"]
  }));
  renderMovements();

  readings = (data?.readings || []).map(r => ({
    duration: r.duration ?? r["duration (min)"] ?? r["Duration (min)"] ?? r["Duration"],
    book: r.book ?? r["book"] ?? r["Book"]
  }));
  if (readings.length > 0) lastBookTitle = String(readings[readings.length - 1].book || "");
  renderReadings();

  honeyDos = data?.honeyDos || [];

  // Textareas
  if (document.getElementById("reflections")) document.getElementById("reflections").value = data?.reflections || "";
  if (document.getElementById("stories")) document.getElementById("stories").value = data?.stories || "";
  if (document.getElementById("carly")) document.getElementById("carly").value = data?.carly || "";

  // Body fields
  applyBodyFieldsFromDaily(bodySource);

  // BP
  if (document.getElementById("systolic")) document.getElementById("systolic").value = d?.["Systolic"] ?? "";
  if (document.getElementById("diastolic")) document.getElementById("diastolic").value = d?.["Diastolic"] ?? "";
  if (document.getElementById("heartRate")) document.getElementById("heartRate").value = d?.["Heart Rate"] ?? "";

  // Update checkbox visuals
  document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(syncCheckboxVisual);

  // BODY DELTAS: compute baseline in background (ignore stale requests)
  const token = ++_deltaFetchToken;

  const curVals = {
    weight: parseNum(document.getElementById("weight")?.value),
    leanMass: parseNum(document.getElementById("leanMass")?.value),
    bodyFat: parseNum(document.getElementById("bodyFat")?.value)
  };

  prevBodyForDelta = { weight: null, leanMass: null, bodyFat: null };
  updateBodyDeltasFromUI();

  (async () => {
    const baselines = await computePrevDifferentBodyBaselines_(currentDate, curVals);
    if (token !== _deltaFetchToken) return;
    prevBodyForDelta = baselines;
    updateBodyDeltasFromUI();
  })();
}

// =====================================
// Reload on return after idle
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
// Biomarkers toggle (safe no-op)
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
      if (typeof loadBiomarkersMostRecent === "function") await loadBiomarkersMostRecent();
    }
  });
}

// =====================================
// Status UI + utils
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
