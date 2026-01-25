/**********************************************
 * Habit Tracker - app.js (clean)
 * - Uses Cloudflare Worker proxy (no API key in browser)
 * - Loads data for selected date
 * - Populates UI (including checkbox highlighting from sheet data)
 * - Saves on changes (debounced)
 * - Date navigation prev/next
 * - Water +/- wired
 * - Body data carry-forward: shows last known body metrics when missing
 **********************************************/

console.log("✅ app.js running", new Date().toISOString());
window.__APP_JS_OK__ = true;

// =====================================
// CONFIG
// =====================================
const API_URL = "https://habit-proxy.joeywigs.workers.dev/";

// Body fields (for carry-forward + detection)
const BODY_FIELDS = [
  { id: "weight", keys: ["Weight (lbs)", "Weight"] },
  { id: "waist", keys: ["Waist (inches)", "Waist"] },
  { id: "systolic", keys: ["Systolic", "Systolic BP"] },
  { id: "diastolic", keys: ["Diastolic", "Diastolic BP"] },
  { id: "leanMass", keys: ["Lean Mass (lbs)", "Lean Mass"] },
  { id: "bodyFat", keys: ["Body Fat (lbs)", "Body Fat"] },
  { id: "boneMass", keys: ["Bone Mass (lbs)", "Bone Mass"] },
  { id: "water", keys: ["Water (lbs)", "Water"] }
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
// APP STATE
// =====================================
let currentDate = new Date();
let dataChanged = false;

let movements = [];
let readings = [];
let honeyDos = [];
let currentAverages = null;
let lastBookTitle = "";
let waterCount = 0;

let autoSaveTimeout = null;

const PREFETCH_RANGE = 3;
const CACHE_MAX_DAYS = 21;
const dayCache = new Map();

// =====================================
// BOOTSTRAP
// =====================================
document.addEventListener("DOMContentLoaded", () => {
  console.log("Habit Tracker booting…");

  setupDateNav();
  setupCheckboxes();
  setupWaterButtons();
  setupInputAutosave();
  setupCollapsibleSections();
  setupMovementUI();
  setupReadingUI();
  setupREHITToggle();

  updateDateDisplay();
  updatePhaseInfo();
  loadDataForCurrentDate();
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
  updateDateDisplay();
  updatePhaseInfo();
  loadDataForCurrentDate();
}

// =====================================
// LOAD / SAVE
// =====================================
async function loadDataForCurrentDate() {
  const dateStr = formatDateForAPI(currentDate);
  console.log("Loading data for", dateStr);

  const cached = cacheGet(dateStr);
  if (cached && !cached?.error) {
    await populateForm(cached);
    prefetchAround(currentDate);
    return;
  }

  try {
    const result = await fetchDay(currentDate);

    if (result?.error) {
      console.error("Backend error:", result.message);
      return;
    }

    await populateForm(result);
    prefetchAround(currentDate);

    dataChanged = false;
  } catch (err) {
    console.error("Load failed:", err);
  }
}

async function saveData(payload) {
  try {
    const saveResult = await apiPost("save", { data: payload });

    if (saveResult?.error) {
      console.error("Save error:", saveResult.message);
      return;
    }

    console.log("💾 Saved successfully", saveResult);
    dataChanged = false;

    if ("sleepHours" in payload) {
      markSleepSaved();
    }

    // Invalidate cache for current date so next load gets fresh data
    const dateStr = formatDateForAPI(currentDate);
    dayCache.delete(dateStr);

    // Fetch fresh averages without full UI reload
    const freshData = await fetchDay(currentDate);
    if (freshData?.averages) {
      updateAverages(freshData.averages);
    }

  } catch (err) {
    console.error("Save failed:", err);
  }
}

function triggerSaveSoon() {
  console.log("💾 triggerSaveSoon fired");
  dataChanged = true;

  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    const payload = buildPayloadFromUI();
    await saveData(payload);
  }, 1500);
}

function buildPayloadFromUI() {
  return {
    date: formatDateForAPI(currentDate),

    sleepHours: document.getElementById("sleepHours")?.value || "",
    steps: document.getElementById("steps")?.value || "",
    fitnessScore: document.getElementById("fitnessScore")?.value || "",
    calories: document.getElementById("calories")?.value || "",
    peakWatts: document.getElementById("peakWatts")?.value || "",
    wattSeconds: document.getElementById("wattSeconds")?.value || "",

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

    hydrationGood: waterCount,

    weight: document.getElementById("weight")?.value || "",
    waist: document.getElementById("waist")?.value || "",
    systolic: document.getElementById("systolic")?.value || "",
    diastolic: document.getElementById("diastolic")?.value || "",
    leanMass: document.getElementById("leanMass")?.value || "",
    bodyFat: document.getElementById("bodyFat")?.value || "",
    boneMass: document.getElementById("boneMass")?.value || "",
    water: document.getElementById("water")?.value || "",

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

    cb.addEventListener("change", () => {
      syncCheckboxVisual(cb);
      triggerSaveSoon();
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
// REHIT TOGGLE
// =====================================
function setupREHITToggle() {
  const rehitCb = document.getElementById("rehit");
  const rehitFields = document.getElementById("rehitFields");
  
  if (!rehitCb || !rehitFields) return;

  rehitCb.addEventListener("change", () => {
    rehitFields.style.display = rehitCb.checked ? "block" : "none";
  });

  console.log("✅ REHIT toggle wired");
}

function updateREHITFieldsVisibility() {
  const rehitCb = document.getElementById("rehit");
  const rehitFields = document.getElementById("rehitFields");
  
  if (rehitCb && rehitFields) {
    rehitFields.style.display = rehitCb.checked ? "block" : "none";
  }
}

// =====================================
// WATER BUTTONS
// =====================================
function updateWaterDisplay() {
  const waterCountEl = document.getElementById("waterCount");
  if (waterCountEl) waterCountEl.textContent = String(waterCount);
}

function setupWaterButtons() {
  const plus = document.getElementById("waterPlus");
  const minus = document.getElementById("waterMinus");
  if (!plus || !minus) return;

  plus.addEventListener("click", (e) => {
    e.preventDefault();
    waterCount += 1;
    updateWaterDisplay();
    triggerSaveSoon();
  });

  minus.addEventListener("click", (e) => {
    e.preventDefault();
    waterCount = Math.max(0, waterCount - 1);
    updateWaterDisplay();
    triggerSaveSoon();
  });

  console.log("✅ Water buttons wired");
}

// =====================================
// INPUT AUTOSAVE
// =====================================
function setupInputAutosave() {
  document.querySelectorAll("input, textarea").forEach(el => {
    if (el.type === "checkbox") return;
    el.addEventListener("change", triggerSaveSoon);
    if (el.tagName === "TEXTAREA") el.addEventListener("input", triggerSaveSoon);
  });

  console.log("✅ Input autosave wired");
}

// =====================================
// BODY carry-forward helpers
// =====================================
function hasAnyBodyData(daily) {
  if (!daily) return false;
  return BODY_FIELDS.some(f => {
    const v = daily[f.keys[0]] ?? daily[f.keys[1]];
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
  const waistVal = source["Waist (inches)"] ?? source["Waist"];
  const systolicVal = source["Systolic"] ?? source["Systolic BP"];
  const diastolicVal = source["Diastolic"] ?? source["Diastolic BP"];
  const leanVal = source["Lean Mass (lbs)"] ?? source["Lean Mass"];
  const fatVal = source["Body Fat (lbs)"] ?? source["Body Fat"];
  const boneVal = source["Bone Mass (lbs)"] ?? source["Bone Mass"];
  const waterBodyVal = source["Water (lbs)"] ?? source["Water"];

  const weightEl = document.getElementById("weight");
  const waistEl = document.getElementById("waist");
  const systolicEl = document.getElementById("systolic");
  const diastolicEl = document.getElementById("diastolic");
  const leanMassEl = document.getElementById("leanMass");
  const bodyFatEl = document.getElementById("bodyFat");
  const boneMassEl = document.getElementById("boneMass");
  const waterBodyEl = document.getElementById("water");

  if (weightEl) weightEl.value = weightVal ?? "";
  if (waistEl) waistEl.value = waistVal ?? "";
  if (systolicEl) systolicEl.value = systolicVal ?? "";
  if (diastolicEl) diastolicEl.value = diastolicVal ?? "";
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
  console.log("📝 populateForm START", { hasDaily: !!data?.daily });
  
  // Reset state
  movements = [];
  readings = [];
  honeyDos = [];
  currentAverages = null;

  const d = data?.daily || null;

  // BODY CARRY-FORWARD
  let bodySource = d;
  if (!hasAnyBodyData(d)) {
    bodySource = await getMostRecentBodyDaily(currentDate);
  }

  // Update averages first
  updateAverages(data?.averages);

  // No daily data for this date
  if (!d) {
    // Reset form inputs
    const form = document.getElementById("healthForm");
    if (form && typeof form.reset === "function") form.reset();
    
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
    renderHoneyDos();

    const reflectionsEl = document.getElementById("reflections");
    if (reflectionsEl) reflectionsEl.value = data?.reflections || "";
    const storiesEl = document.getElementById("stories");
    if (storiesEl) storiesEl.value = data?.stories || "";
    const carlyEl = document.getElementById("carly");
    if (carlyEl) carlyEl.value = data?.carly || "";

    applyBodyFieldsFromDaily(bodySource);

    // Sync all checkbox visuals after setting values
    document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(cb => {
      syncCheckboxVisual(cb);
    });

    console.log("✅ populateForm END (no daily)");
    return;
  }

  // Reset form inputs BEFORE setting checkbox values
  const form = document.getElementById("healthForm");
  if (form && typeof form.reset === "function") form.reset();

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

  // Checkboxes (sheet -> UI) - log what we're setting
  console.log("Setting checkboxes:", {
    inhalerMorning: d["Grey's Inhaler Morning"] ?? d["Inhaler Morning"],
    inhalerEvening: d["Grey's Inhaler Evening"] ?? d["Inhaler Evening"],
    multiplication: d["5 min Multiplication"],
    rehit: d["REHIT 2x10"] ?? d["REHIT"]
  });
  
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

  // Water counter
  waterCount = parseInt(d["Water"], 10) || 0;
  updateWaterDisplay();

  // Body fields
  applyBodyFieldsFromDaily(bodySource);

  // Lists
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

  // Textareas
  const reflectionsEl = document.getElementById("reflections");
  if (reflectionsEl) reflectionsEl.value = data?.reflections || "";

  const storiesEl = document.getElementById("stories");
  if (storiesEl) storiesEl.value = data?.stories || "";

  const carlyEl = document.getElementById("carly");
  if (carlyEl) carlyEl.value = data?.carly || "";

  // Renders
  if (typeof renderMovements === "function") renderMovements();
  if (typeof renderReadings === "function") renderReadings();
  if (typeof renderHoneyDos === "function") renderHoneyDos();

  // Update REHIT fields visibility based on checkbox state
  updateREHITFieldsVisibility();

  // Final: Sync all checkbox visuals - use a small delay to ensure DOM has settled
  setTimeout(() => {
    console.log("🎨 Final checkbox visual sync");
    document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(cb => {
      console.log(`  ${cb.id}: checked=${cb.checked}`);
      syncCheckboxVisual(cb);
    });
  }, 0);

  console.log("✅ populateForm END");
}

function setupCollapsibleSections() {
  document.querySelectorAll(".section-header.collapsible").forEach(header => {
    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      const content = header.nextElementSibling;
      if (content && content.classList.contains("section-content")) {
        content.classList.toggle("collapsed");
      }
    });
  });

  console.log("✅ Collapsible sections wired");
}

function addDays(date, deltaDays) {
  const d = new Date(date);
  d.setDate(d.getDate() + deltaDays);
  return d;
}

function cacheSet(key, value) {
  dayCache.set(key, { value, ts: Date.now() });

  if (dayCache.size > CACHE_MAX_DAYS) {
    const oldestKey = [...dayCache.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldestKey) dayCache.delete(oldestKey);
  }
}

function cacheGet(key) {
  const hit = dayCache.get(key);
  if (!hit) return null;
  hit.ts = Date.now();
  return hit.value;
}

async function fetchDay(dateObj) {
  const dateStr = formatDateForAPI(dateObj);
  const cached = cacheGet(dateStr);
  if (cached) return cached;

  const result = await apiGet("load", { date: dateStr });
  cacheSet(dateStr, result);
  return result;
}

function prefetchAround(dateObj) {
  for (let delta = -PREFETCH_RANGE; delta <= PREFETCH_RANGE; delta++) {
    if (delta === 0) continue;
    const d = addDays(dateObj, delta);
    const key = formatDateForAPI(d);
    if (cacheGet(key)) continue;

    fetchDay(d).catch(() => {});
  }
}

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
  triggerSaveSoon();
}

function removeMovement(index) {
  movements.splice(index, 1);
  renderMovements();
  triggerSaveSoon();
}

function renderMovements() {
  const list = document.getElementById("movementList");
  if (!list) return;

  list.innerHTML = "";

  movements.forEach((m, idx) => {
    const duration = m.duration ?? m["duration (min)"] ?? m["Duration"] ?? m["Duration (min)"];
    const type = m.type ?? m["Type"] ?? m["type"] ?? "";

    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${duration} min (${type})</span>
      <button type="button" class="btn btn-danger" data-idx="${idx}">×</button>
    `;

    item.querySelector("button").addEventListener("click", () => removeMovement(idx));
    list.appendChild(item);
  });
}

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
  const duration = prompt("Reading duration (minutes):");
  if (!duration || isNaN(duration)) return;

  const book = prompt("Book title:", lastBookTitle);
  if (!book || book.trim() === "") return;

  lastBookTitle = book.trim();
  readings.push({ duration: parseInt(duration), book: lastBookTitle });
  renderReadings();
  triggerSaveSoon();
}

function removeReading(index) {
  readings.splice(index, 1);
  renderReadings();
  triggerSaveSoon();
}

function renderReadings() {
  const list = document.getElementById("readingList");
  if (!list) return;

  list.innerHTML = "";

  readings.forEach((r, idx) => {
    const duration = r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"];
    const book = r.book ?? r["Book"];

    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${duration} min - ${book}</span>
      <button type="button" class="btn btn-danger" data-idx="${idx}">×</button>
    `;

    item.querySelector("button").addEventListener("click", () => removeReading(idx));
    list.appendChild(item);
  });
}

function renderHoneyDos() {
  const list = document.getElementById("honeyDoList");
  if (!list) return;

  list.innerHTML = "";

  honeyDos.forEach((h, idx) => {
    const task = h.task ?? h["Task"];
    const completed = h.completed ?? h["Completed"];

    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <input type="checkbox" ${completed ? "checked" : ""} style="width: 48px; height: 48px; margin-right: 20px;">
      <span class="item-text" style="${completed ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${task}</span>
      <button type="button" class="btn btn-danger" data-idx="${idx}">×</button>
    `;

    const cb = item.querySelector("input[type='checkbox']");
    cb.addEventListener("change", () => {
      honeyDos[idx].completed = cb.checked;
      renderHoneyDos();
      triggerSaveSoon();
    });

    item.querySelector(".btn-danger").addEventListener("click", () => {
      honeyDos.splice(idx, 1);
      renderHoneyDos();
      triggerSaveSoon();
    });

    list.appendChild(item);
  });
}

function updateAverages(averages) {
  currentAverages = averages || null;

  const avgSleepEl = document.getElementById("avgSleep");
  const avgStepsEl = document.getElementById("avgSteps");
  const avgMovementsEl = document.getElementById("avgMovements");
  const rehitWeekEl = document.getElementById("rehitWeek");

  if (!averages) {
    if (avgSleepEl) avgSleepEl.textContent = "--";
    if (avgStepsEl) avgStepsEl.textContent = "--";
    if (avgMovementsEl) avgMovementsEl.textContent = "--";
    if (rehitWeekEl) rehitWeekEl.textContent = "--";
    return;
  }

  if (avgSleepEl) {
    const v = averages.sleep;
    avgSleepEl.textContent = (v === null || v === undefined || v === "")
      ? "--"
      : Number(v).toFixed(2);
  }

  if (avgStepsEl) {
    const v = averages.steps;
    avgStepsEl.textContent = (v === null || v === undefined || v === "")
      ? "--"
      : Number(v).toLocaleString();
  }

  if (avgMovementsEl) {
    const v = averages.movements;
    const num = (v === null || v === undefined || v === "") ? null : Number(v);
    avgMovementsEl.textContent = (num === null || Number.isNaN(num))
      ? "--"
      : num.toFixed(1);
  }

  if (rehitWeekEl) {
    const v = averages.rehitWeek;
    rehitWeekEl.textContent = (v === null || v === undefined || v === "")
      ? "--"
      : String(v);
  }
}

function markSleepSaved() {
  const el = document.getElementById("sleepHours");
  if (!el) return;

  el.classList.add("saved");

  setTimeout(() => {
    el.classList.remove("saved");
  }, 3000);
}

function calculatePercentages() {
  const weight = parseFloat(document.getElementById("weight")?.value) || 0;

  if (weight > 0) {
    const leanMass = parseFloat(document.getElementById("leanMass")?.value) || 0;
    const bodyFat = parseFloat(document.getElementById("bodyFat")?.value) || 0;
    const boneMass = parseFloat(document.getElementById("boneMass")?.value) || 0;
    const water = parseFloat(document.getElementById("water")?.value) || 0;

    const leanPercent = document.getElementById("leanMassPercent");
    const fatPercent = document.getElementById("bodyFatPercent");
    const bonePercent = document.getElementById("boneMassPercent");
    const waterPercent = document.getElementById("waterPercent");

    if (leanPercent) leanPercent.textContent = leanMass > 0 ? ((leanMass / weight) * 100).toFixed(1) : "--";
    if (fatPercent) fatPercent.textContent = bodyFat > 0 ? ((bodyFat / weight) * 100).toFixed(1) : "--";
    if (bonePercent) bonePercent.textContent = boneMass > 0 ? ((boneMass / weight) * 100).toFixed(1) : "--";
    if (waterPercent) waterPercent.textContent = water > 0 ? ((water / weight) * 100).toFixed(1) : "--";
  } else {
    const leanPercent = document.getElementById("leanMassPercent");
    const fatPercent = document.getElementById("bodyFatPercent");
    const bonePercent = document.getElementById("boneMassPercent");
    const waterPercent = document.getElementById("waterPercent");

    if (leanPercent) leanPercent.textContent = "--";
    if (fatPercent) fatPercent.textContent = "--";
    if (bonePercent) bonePercent.textContent = "--";
    if (waterPercent) waterPercent.textContent = "--";
  }
}

// Setup body calculations on input
document.addEventListener("DOMContentLoaded", () => {
  const bodyFields = ["weight", "waist", "systolic", "diastolic", "leanMass", "bodyFat", "boneMass", "water"];
  bodyFields.forEach(id => {
    const field = document.getElementById(id);
    if (field) {
      field.addEventListener("input", calculatePercentages);
    }
  });
});
