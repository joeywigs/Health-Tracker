/**********************************************
 * Habit Tracker - app.js (clean)
 * - Uses Cloudflare Worker proxy (no API key in browser)
 * - Loads data for selected date
 * - Populates UI (including checkbox highlighting from sheet data)
 * - Saves on changes (debounced)
 * - Date navigation prev/next
 * - Water +/- wired
 * - Body data carry-forward: shows last known body metrics when missing
 * - Blood pressure tracking with status indicator
 **********************************************/

console.log("app.js running - No bottom nav", new Date().toISOString());
window.__APP_JS_OK__ = true;

// Show errors on screen
window.onerror = function(msg, url, line) {
  document.body.insertAdjacentHTML('afterbegin', 
    '<div style="background:red;color:white;padding:20px;font-size:16px;position:fixed;top:0;left:0;right:0;z-index:99999;">' +
    'ERROR: ' + msg + ' (Line ' + line + ')' +
    '</div>');
};

// =====================================
// CONFIG
// =====================================
const API_URL = "https://habit-proxy.joeywigs.workers.dev/";

// Body fields (for carry-forward + detection)
const BODY_FIELDS = [
  { id: "weight", keys: ["Weight (lbs)", "Weight"] },
  { id: "waist", keys: ["Waist (in)", "Waist"] },
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

const PREFETCH_RANGE = 3;          // how many days ahead/behind to prefetch
const CACHE_MAX_DAYS = 21;         // cap memory (tweak as you like)
const dayCache = new Map();        // key: "M/D/YY" -> loadResult


// =====================================
// BOOTSTRAP
// =====================================
document.addEventListener("DOMContentLoaded", () => {
  console.log("Habit Tracker booting…");

  try { setupDateNav(); console.log("1 ok"); } catch(e) { console.error("setupDateNav failed:", e); }
  try { setupCheckboxes(); console.log("2 ok"); } catch(e) { console.error("setupCheckboxes failed:", e); }
  try { setupRehitMutualExclusion(); console.log("3 ok"); } catch(e) { console.error("setupRehitMutualExclusion failed:", e); }
  try { setupWaterButtons(); console.log("4 ok"); } catch(e) { console.error("setupWaterButtons failed:", e); }
  try { setupInputAutosave(); console.log("5 ok"); } catch(e) { console.error("setupInputAutosave failed:", e); }
  try { setupCollapsibleSections(); console.log("6 ok"); } catch(e) { console.error("setupCollapsibleSections failed:", e); }
  try { setupMovementUI(); console.log("7 ok"); } catch(e) { console.error("setupMovementUI failed:", e); }
  try { setupReadingUI(); console.log("8 ok"); } catch(e) { console.error("setupReadingUI failed:", e); }
  try { setupBloodPressureCalculator(); console.log("9 ok"); } catch(e) { console.error("setupBloodPressureCalculator failed:", e); }
  try { setupSwipeNavigation(); console.log("10 ok"); } catch(e) { console.error("setupSwipeNavigation failed:", e); }
  try { setupPullToRefresh(); console.log("11 ok"); } catch(e) { console.error("setupPullToRefresh failed:", e); }
  try { setupWeeklyReminders(); console.log("12 ok"); } catch(e) { console.error("setupWeeklyReminders failed:", e); }
  try { setupWeeklySummaryButton(); console.log("13 ok"); } catch(e) { console.error("setupWeeklySummaryButton failed:", e); }
  try { setupChartsPage(); console.log("14 ok"); } catch(e) { console.error("setupChartsPage failed:", e); }
  try { setupChartRangeToggle(); console.log("15 ok"); } catch(e) { console.error("setupChartRangeToggle failed:", e); }
  try { setupBiomarkersPage(); console.log("16 ok"); } catch(e) { console.error("setupBiomarkersPage failed:", e); }
  try { setupStickyHeader(); console.log("17 ok"); } catch(e) { console.error("setupStickyHeader failed:", e); }
  try { setupQuickLog(); console.log("18 ok"); } catch(e) { console.error("setupQuickLog failed:", e); }
  try { setupDopamineBoosts(); console.log("19 ok"); } catch(e) { console.error("setupDopamineBoosts failed:", e); }

  try { updateDateDisplay(); console.log("20 ok"); } catch(e) { console.error("updateDateDisplay failed:", e); }
  try { updatePhaseInfo(); console.log("21 ok"); } catch(e) { console.error("updatePhaseInfo failed:", e); }
  try { loadDataForCurrentDate(); console.log("22 ok"); } catch(e) { console.error("loadDataForCurrentDate failed:", e); }
});

const PHASE_START_DATE = new Date("2026-01-19T00:00:00"); // Phase 1 start (local)
const PHASE_LENGTH_DAYS = 21;

function updatePhaseInfo() {
  const start = new Date(PHASE_START_DATE);
  start.setHours(0, 0, 0, 0);

  const cur = new Date(currentDate);
  cur.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceStart = Math.floor((cur - start) / msPerDay);

  // If before start date, treat as Phase 0 / Day 0
  const safeDays = Math.max(0, daysSinceStart);
  const phase = Math.floor(safeDays / PHASE_LENGTH_DAYS) + 1;
  const dayInPhase = (safeDays % PHASE_LENGTH_DAYS) + 1;

  const phaseInfoEl = document.getElementById("phaseInfo");
  if (phaseInfoEl) phaseInfoEl.textContent = `Day ${dayInPhase} of ${PHASE_LENGTH_DAYS}`;

  // Update subtitle "Phase X"
  const subtitleEl = document.querySelector(".subtitle");
  if (subtitleEl) subtitleEl.textContent = `Phase ${phase}`;

  // Progress bar width
  const bar = document.getElementById("phaseProgressBar");
  if (bar) {
    const progress = (dayInPhase - 1) / PHASE_LENGTH_DAYS; // 0..(20/21)
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
  
  // Also update sticky header
  updateStickyDate();
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
  updatePhaseInfo?.(); // if you have it

  // show instantly if cached, else it will fetch
  loadDataForCurrentDate();
  updateWeighReminder();
  updateWeeklySummaryButton();
}

// =====================================
// SWIPE NAVIGATION
// =====================================
function setupSwipeNavigation() {
  let touchStartX = 0;
  let touchEndX = 0;
  
  const minSwipeDistance = 50;
  
  document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });
  
  document.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });
  
  function handleSwipe() {
    const swipeDistance = touchEndX - touchStartX;
    
    if (Math.abs(swipeDistance) < minSwipeDistance) return;
    
    // Swipe right = previous day
    if (swipeDistance > 0) {
      changeDate(-1);
    }
    // Swipe left = next day  
    else {
      changeDate(1);
    }
  }
  
  console.log("✅ Swipe navigation wired");
}

// =====================================
// PULL TO REFRESH
// =====================================
function setupPullToRefresh() {
  let touchStartY = 0;
  let pulling = false;
  
  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0) {
      touchStartY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });
  
  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    
    const touchY = e.touches[0].clientY;
    const pullDistance = touchY - touchStartY;
    
    if (pullDistance > 100 && window.scrollY === 0) {
      pulling = false;
      loadDataForCurrentDate({ force: true });
      
      // Visual feedback
      const statusMsg = document.getElementById("statusMessage");
      if (statusMsg) {
        statusMsg.textContent = "Refreshing...";
        statusMsg.className = "status-message loading";
        statusMsg.style.display = "block";
        setTimeout(() => {
          statusMsg.style.display = "none";
        }, 1500);
      }
    }
  }, { passive: true });
  
  document.addEventListener('touchend', () => {
    pulling = false;
  }, { passive: true });
  
  console.log("✅ Pull-to-refresh wired");
}

// =====================================
// WEEKLY REMINDERS
// =====================================
function setupWeeklyReminders() {
  updateWeighReminder();
  console.log("✅ Weekly reminders wired");
}

function updateWeighReminder() {
  const today = new Date(currentDate);
  const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday
  
  // Only show on Mondays
  if (dayOfWeek !== 1) {
    hideWeighReminder();
    return;
  }
  
  // Check if body measurements exist for today
  const dateStr = formatDateForAPI(currentDate);
  apiGet("load", { date: dateStr }).then(result => {
    const daily = result?.daily;
    const hasBodyData = daily && (daily["Weight (lbs)"] || daily["Waist"]);
    
    if (!hasBodyData) {
      showWeighReminder();
    } else {
      hideWeighReminder();
    }
  }).catch(() => {
    // If error, don't show reminder
    hideWeighReminder();
  });
}

function showWeighReminder() {
  let banner = document.getElementById("weighReminder");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "weighReminder";
    banner.className = "reminder-banner";
    banner.innerHTML = `
      <span>📊 Weigh-in Monday! Don't forget to log your body measurements.</span>
      <button onclick="document.getElementById('weighReminder').remove()">✕</button>
    `;
    
    const header = document.querySelector(".header");
    if (header) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    }
  }
}

function hideWeighReminder() {
  const banner = document.getElementById("weighReminder");
  if (banner) banner.remove();
}

// =====================================
// WEEKLY SUMMARY
// =====================================
function setupWeeklySummaryButton() {
  // Remove the old Sunday-only button logic
  const oldBtn = document.getElementById("weeklySummaryBtn");
  if (oldBtn) oldBtn.remove();
  
  // Setup the header link
  const summaryLink = document.getElementById("weeklySummaryLink");
  const summaryCloseBtn = document.getElementById("summaryCloseBtn");
  
  if (summaryLink) {
    summaryLink.addEventListener("click", (e) => {
      e.preventDefault();
      showWeeklySummaryPage();
    });
  }
  
  if (summaryCloseBtn) {
    summaryCloseBtn.addEventListener("click", hideWeeklySummaryPage);
  }
  
  // Setup range buttons
  document.querySelectorAll('.summary-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.summary-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const range = btn.dataset.range;
      const rangeValue = range === 'phase' ? 'phase' : range === 'all' ? 'all' : 7;
      
      if (chartDataCache && chartDataCache.length > 0) {
        renderSummaryPage(chartDataCache, rangeValue);
      }
    });
  });
  
  console.log("✅ Weekly summary wired");
}

function updateWeeklySummaryButton() {
  // No longer needed - link is always visible
}

async function showWeeklySummaryPage() {
  const mainPage = document.getElementById("healthForm");
  const chartsPage = document.getElementById("chartsPage");
  const bioPage = document.getElementById("biomarkersPage");
  const summaryPage = document.getElementById("weeklySummaryPage");
  const settingsPage = document.getElementById("settingsPage");
  const fab = document.getElementById("quickLogFab");
  
  if (mainPage) mainPage.style.display = "none";
  if (chartsPage) chartsPage.style.display = "none";
  if (bioPage) bioPage.style.display = "none";
  if (settingsPage) settingsPage.style.display = "none";
  if (summaryPage) summaryPage.style.display = "block";
  if (fab) fab.style.display = "none";
  
  window.scrollTo(0, 0);
  
  await loadWeeklySummary();
}

function hideWeeklySummaryPage() {
  const mainPage = document.getElementById("healthForm");
  const summaryPage = document.getElementById("weeklySummaryPage");
  const fab = document.getElementById("quickLogFab");
  
  if (summaryPage) summaryPage.style.display = "none";
  if (mainPage) mainPage.style.display = "block";
  if (fab) fab.style.display = "block";
  
  window.scrollTo(0, 0);
}

async function loadWeeklySummary() {
  // Calculate week boundaries (Sun-Sat)
  const today = new Date();
  const currentDay = today.getDay();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - currentDay);
  weekStart.setHours(0, 0, 0, 0);
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  
  // Update subtitle
  const subtitle = document.getElementById("summarySubtitle");
  if (subtitle) {
    const startStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endStr = weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    subtitle.textContent = `${startStr} - ${endStr}`;
  }
  
  // Load phase progress
  loadPhaseProgress();
  
  // If chart data not cached, fetch it now
  if (!chartDataCache || chartDataCache.length === 0) {
    document.getElementById("summaryOverview").innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">Loading data...</div>';
    chartDataCache = await fetchChartData(null, true);
  }
  
  // Now render with the data
  if (chartDataCache && chartDataCache.length > 0) {
    renderSummaryPage(chartDataCache, 7);
  } else {
    document.getElementById("summaryOverview").innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">No data available</div>';
  }
}

// Summary page state
let currentSummaryRange = 7;
const PHASE_START = new Date("2026-01-19");
const PHASE_LENGTH = 21;

// Goals configuration
const GOALS = {
  sleep: { name: "Sleep", icon: "🌙", target: 7, unit: "hrs", type: "daily-avg" },
  water: { name: "Water", icon: "💧", target: 6, unit: "glasses", type: "daily" },
  supps: { name: "Supplements", icon: "💊", target: 4, unit: "of 4", type: "daily-all" },
  rehit: { name: "REHIT", icon: "🚴", target: 3, unit: "sessions", type: "weekly" },
  steps: { name: "Steps", icon: "👟", target: 5000, unit: "steps", type: "daily-avg" },
  movement: { name: "Movement", icon: "🚶", target: 2, unit: "breaks", type: "daily-avg" },
  reading: { name: "Reading", icon: "📖", target: 60, unit: "min", type: "weekly" }
};

function getFilteredData(data, range) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  if (range === 7) {
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 6);
    return data.filter(d => {
      const date = parseDataDate(d.date);
      return date >= weekStart && date <= today;
    });
  } else if (range === 'phase') {
    const phaseStart = new Date(PHASE_START);
    phaseStart.setHours(0, 0, 0, 0);
    const phaseEnd = new Date(phaseStart);
    phaseEnd.setDate(phaseStart.getDate() + PHASE_LENGTH - 1);
    return data.filter(d => {
      const date = parseDataDate(d.date);
      return date >= phaseStart && date <= Math.min(phaseEnd, today);
    });
  } else {
    // All time
    return data;
  }
}

function parseDataDate(dateStr) {
  // Parse M/D/YY format
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const month = parseInt(parts[0]) - 1;
    const day = parseInt(parts[1]);
    const year = 2000 + parseInt(parts[2]);
    return new Date(year, month, day);
  }
  return new Date(dateStr);
}

function calculateGoalStats(data, range) {
  const stats = {};
  const totalDays = data.length;
  
  // Sleep: goal is 7+ hours
  const sleepValues = data.map(d => parseFloat(d.daily["Hours of Sleep"])).filter(v => !isNaN(v) && v > 0);
  const sleepDaysMet = sleepValues.filter(v => v >= GOALS.sleep.target).length;
  stats.sleep = {
    pct: totalDays > 0 ? Math.round((sleepDaysMet / totalDays) * 100) : 0,
    avg: sleepValues.length > 0 ? (sleepValues.reduce((a,b) => a+b, 0) / sleepValues.length).toFixed(1) : 0,
    detail: `${sleepValues.length > 0 ? (sleepValues.reduce((a,b) => a+b, 0) / sleepValues.length).toFixed(1) : '--'} avg hrs`
  };
  
  // Water: goal is 6 glasses
  const waterValues = data.map(d => parseInt(d.daily["Water"])).filter(v => !isNaN(v));
  const waterDaysMet = waterValues.filter(v => v >= GOALS.water.target).length;
  stats.water = {
    pct: totalDays > 0 ? Math.round((waterDaysMet / totalDays) * 100) : 0,
    avg: waterValues.length > 0 ? (waterValues.reduce((a,b) => a+b, 0) / waterValues.length).toFixed(1) : 0,
    detail: `${waterDaysMet}/${totalDays} days at 6+`
  };
  
  // Supps: all 4 each day
  let suppsDaysMet = 0;
  data.forEach(d => {
    const creatine = d.daily["Creatine Chews"] || d.daily["Creatine"];
    const vitD = d.daily["Vitamin D"];
    const no2 = d.daily["NO2"];
    const psyllium = d.daily["Psyllium Husk"] || d.daily["Psyllium"];
    const allFour = [creatine, vitD, no2, psyllium].filter(v => v === true || v === "TRUE" || v === "true").length;
    if (allFour === 4) suppsDaysMet++;
  });
  stats.supps = {
    pct: totalDays > 0 ? Math.round((suppsDaysMet / totalDays) * 100) : 0,
    detail: `${suppsDaysMet}/${totalDays} days all 4`
  };
  
  // REHIT: 3 sessions per week
  const weeks = Math.max(1, Math.ceil(totalDays / 7));
  const rehitCount = data.filter(d => d.daily["REHIT 2x10"] && d.daily["REHIT 2x10"] !== "").length;
  const rehitPerWeek = rehitCount / weeks;
  stats.rehit = {
    pct: Math.min(100, Math.round((rehitPerWeek / GOALS.rehit.target) * 100)),
    total: rehitCount,
    detail: `${rehitCount} sessions (${rehitPerWeek.toFixed(1)}/wk)`
  };
  
  // Steps: 5000 per day average
  const stepsValues = data.map(d => parseInt(d.daily["Steps"])).filter(v => !isNaN(v) && v > 0);
  const avgSteps = stepsValues.length > 0 ? stepsValues.reduce((a,b) => a+b, 0) / stepsValues.length : 0;
  const stepsDaysMet = stepsValues.filter(v => v >= GOALS.steps.target).length;
  stats.steps = {
    pct: Math.min(100, Math.round((avgSteps / GOALS.steps.target) * 100)),
    avg: Math.round(avgSteps),
    detail: `${Math.round(avgSteps).toLocaleString()} avg steps`
  };
  
  // Movement: 2 breaks per day average
  let totalMovements = 0;
  data.forEach(d => {
    // Count movement breaks from Movements field
    const movements = d.daily["Movements"];
    if (movements && typeof movements === 'string') {
      totalMovements += movements.split(',').filter(m => m.trim()).length;
    } else if (Array.isArray(movements)) {
      totalMovements += movements.length;
    }
  });
  const avgMovements = totalDays > 0 ? totalMovements / totalDays : 0;
  stats.movement = {
    pct: Math.min(100, Math.round((avgMovements / GOALS.movement.target) * 100)),
    avg: avgMovements.toFixed(1),
    detail: `${avgMovements.toFixed(1)} avg/day`
  };
  
  // Reading: 60 min per week
  let totalReadingMins = 0;
  data.forEach(d => {
    const mins = parseInt(d.daily["Reading Minutes"]) || 0;
    totalReadingMins += mins;
  });
  const readingPerWeek = weeks > 0 ? totalReadingMins / weeks : 0;
  stats.reading = {
    pct: Math.min(100, Math.round((readingPerWeek / GOALS.reading.target) * 100)),
    total: totalReadingMins,
    detail: `${totalReadingMins} min total`
  };
  
  // Nutrition stats
  let goodMealsDays = 0;
  let healthySnacksDays = 0;
  data.forEach(d => {
    const breakfast = d.daily["Breakfast"] === true || d.daily["Breakfast"] === "TRUE";
    const lunch = d.daily["Lunch"] === true || d.daily["Lunch"] === "TRUE";
    const dinner = d.daily["Dinner"] === true || d.daily["Dinner"] === "TRUE";
    const mealsCount = [breakfast, lunch, dinner].filter(Boolean).length;
    if (mealsCount >= 2) goodMealsDays++;
    
    const daySnacks = d.daily["Healthy Day Snacks"] || d.daily["Day Snacks"];
    const nightSnacks = d.daily["Healthy Night Snacks"] || d.daily["Night Snacks"];
    const snacksHealthy = [daySnacks, nightSnacks].filter(v => v === true || v === "TRUE").length;
    if (snacksHealthy >= 2) healthySnacksDays++;
  });
  stats.meals = {
    pct: totalDays > 0 ? Math.round((goodMealsDays / totalDays) * 100) : 0,
    detail: `${goodMealsDays}/${totalDays} days 2+ meals`
  };
  stats.snacks = {
    pct: totalDays > 0 ? Math.round((healthySnacksDays / totalDays) * 100) : 0,
    detail: `${healthySnacksDays}/${totalDays} days healthy`
  };
  
  // Mindfulness (meditation)
  let meditationDays = 0;
  data.forEach(d => {
    const med = d.daily["Meditation"] || d.daily["Meditated"];
    if (med === true || med === "TRUE" || med === "true") meditationDays++;
  });
  stats.meditation = {
    pct: totalDays > 0 ? Math.round((meditationDays / totalDays) * 100) : 0,
    detail: `${meditationDays}/${totalDays} days`
  };
  
  // Kid's habits
  let inhalerMorningDays = 0, inhalerEveningDays = 0, mathDays = 0;
  data.forEach(d => {
    if (d.daily["Grey's Inhaler Morning"] === true || d.daily["Inhaler Morning"] === true || 
        d.daily["Grey's Inhaler Morning"] === "TRUE" || d.daily["Inhaler Morning"] === "TRUE") inhalerMorningDays++;
    if (d.daily["Grey's Inhaler Evening"] === true || d.daily["Inhaler Evening"] === true ||
        d.daily["Grey's Inhaler Evening"] === "TRUE" || d.daily["Inhaler Evening"] === "TRUE") inhalerEveningDays++;
    if (d.daily["5 min Multiplication"] === true || d.daily["5 min Multiplication"] === "TRUE") mathDays++;
  });
  stats.inhalerAM = { pct: totalDays > 0 ? Math.round((inhalerMorningDays / totalDays) * 100) : 0, detail: `${inhalerMorningDays}/${totalDays} days` };
  stats.inhalerPM = { pct: totalDays > 0 ? Math.round((inhalerEveningDays / totalDays) * 100) : 0, detail: `${inhalerEveningDays}/${totalDays} days` };
  stats.math = { pct: totalDays > 0 ? Math.round((mathDays / totalDays) * 100) : 0, detail: `${mathDays}/${totalDays} days` };
  
  // Writing (reflections, stories, carly)
  let reflectionsDays = 0, storiesDays = 0, carlyDays = 0;
  data.forEach(d => {
    if (d.daily["Reflections"] && d.daily["Reflections"].trim() !== "") reflectionsDays++;
    if (d.daily["Grey & Sloane Story"] && d.daily["Grey & Sloane Story"].trim() !== "") storiesDays++;
    if (d.daily["Carly"] && d.daily["Carly"].trim() !== "") carlyDays++;
  });
  stats.reflections = { pct: totalDays > 0 ? Math.round((reflectionsDays / totalDays) * 100) : 0, detail: `${reflectionsDays}/${totalDays} days` };
  stats.stories = { pct: totalDays > 0 ? Math.round((storiesDays / totalDays) * 100) : 0, detail: `${storiesDays}/${totalDays} days` };
  stats.carly = { pct: totalDays > 0 ? Math.round((carlyDays / totalDays) * 100) : 0, detail: `${carlyDays}/${totalDays} days` };
  
  return stats;
}

function renderSummaryPage(data, range) {
  currentSummaryRange = range;
  const filteredData = getFilteredData(data, range);
  const stats = calculateGoalStats(filteredData, range);
  
  // Update subtitle
  const subtitle = document.getElementById('summarySubtitle');
  if (subtitle) {
    if (range === 7) subtitle.textContent = '7 Days';
    else if (range === 'phase') subtitle.textContent = 'Phase 1';
    else subtitle.textContent = 'All Time';
  }
  
  // Overview stats
  renderSummaryOverview(filteredData, stats, range);
  
  // REHIT Calendar
  renderSummaryRehitCalendar(data, range);
  
  // Goal performance
  renderGoalPerformance(stats);
  
  // Category stats
  renderHealthGoals(stats);
  renderNutritionStats(stats);
  renderMindfulnessStats(stats);
  renderKidsHabitsStats(stats);
  renderWritingStats(stats);
}

function renderSummaryOverview(data, stats, range) {
  const container = document.getElementById('summaryOverview');
  if (!container) return;
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const phaseStart = new Date(PHASE_START);
  phaseStart.setHours(0, 0, 0, 0);
  
  const daysIntoPhase = Math.max(0, Math.floor((today - phaseStart) / (1000 * 60 * 60 * 24)) + 1);
  const daysRemaining = Math.max(0, PHASE_LENGTH - daysIntoPhase);
  const totalDaysLogged = data.length;
  
  // Calculate percent complete (days with 90%+ goals)
  let daysComplete = 0;
  data.forEach(d => {
    // Count goals met: sleep 7+, water 6+, 4 supps, steps 5000+
    let goalsMet = 0;
    const totalGoals = 4;
    
    const sleep = parseFloat(d.daily["Hours of Sleep"]);
    if (!isNaN(sleep) && sleep >= 7) goalsMet++;
    
    const water = parseInt(d.daily["Water"]);
    if (!isNaN(water) && water >= 6) goalsMet++;
    
    const creatine = d.daily["Creatine Chews"] || d.daily["Creatine"];
    const vitD = d.daily["Vitamin D"];
    const no2 = d.daily["NO2"];
    const psyllium = d.daily["Psyllium Husk"] || d.daily["Psyllium"];
    const allSupps = [creatine, vitD, no2, psyllium].filter(v => v === true || v === "TRUE").length === 4;
    if (allSupps) goalsMet++;
    
    const steps = parseInt(d.daily["Steps"]);
    if (!isNaN(steps) && steps >= 5000) goalsMet++;
    
    if (goalsMet / totalGoals >= 0.9) daysComplete++;
  });
  
  const pctComplete = totalDaysLogged > 0 ? Math.round((daysComplete / totalDaysLogged) * 100) : 0;
  
  container.innerHTML = `
    <div class="summary-stat">
      <div class="summary-stat-value">${totalDaysLogged}</div>
      <div class="summary-stat-label">Days Logged</div>
    </div>
    <div class="summary-stat">
      <div class="summary-stat-value">${pctComplete}%</div>
      <div class="summary-stat-label">Days Complete</div>
      <div class="summary-stat-sub">90%+ goals met</div>
    </div>
    <div class="summary-stat">
      <div class="summary-stat-value">${Math.min(daysIntoPhase, PHASE_LENGTH)}</div>
      <div class="summary-stat-label">Days into Phase</div>
      <div class="summary-stat-sub">${daysRemaining > 0 ? daysRemaining + ' remaining' : 'Complete!'}</div>
    </div>
    <div class="summary-stat">
      <div class="summary-stat-value">${stats.rehit.total}</div>
      <div class="summary-stat-label">REHIT Sessions</div>
    </div>
  `;
}

function renderSummaryRehitCalendar(data, range) {
  const container = document.getElementById('summaryRehitCalendar');
  if (!container) return;
  
  // Build rehit data map
  const rehitMap = {};
  data.forEach(d => {
    const val = d.daily["REHIT 2x10"];
    if (val === "2x10" || val === true || val === "TRUE") {
      rehitMap[d.date] = "2x10";
    } else if (val === "3x10") {
      rehitMap[d.date] = "3x10";
    }
  });
  
  if (range === 7) {
    // Show just this week
    renderWeekCalendar(container, rehitMap);
  } else if (range === 'phase') {
    // Show phase month(s)
    renderMonthCalendar(container, rehitMap, new Date(PHASE_START));
  } else {
    // Show 30 days
    renderMonthCalendar(container, rehitMap, new Date());
  }
}

function renderWeekCalendar(container, rehitMap) {
  const today = new Date();
  const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(-2)}`;
  
  // Get start of week (Sunday)
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  
  let html = `
    <div class="rehit-cal-weekdays">
      <div class="rehit-cal-weekday">S</div>
      <div class="rehit-cal-weekday">M</div>
      <div class="rehit-cal-weekday">T</div>
      <div class="rehit-cal-weekday">W</div>
      <div class="rehit-cal-weekday">T</div>
      <div class="rehit-cal-weekday">F</div>
      <div class="rehit-cal-weekday">S</div>
    </div>
    <div class="rehit-cal-days">
  `;
  
  for (let i = 0; i < 7; i++) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    const dateStr = `${day.getMonth() + 1}/${day.getDate()}/${String(day.getFullYear()).slice(-2)}`;
    const rehitVal = rehitMap[dateStr];
    const isToday = dateStr === todayStr;
    
    let classes = "rehit-cal-day";
    if (isToday) classes += " today";
    if (rehitVal) {
      classes += " has-rehit";
      if (rehitVal === "2x10") classes += " rehit-2x10";
      if (rehitVal === "3x10") classes += " rehit-3x10";
    }
    
    html += `<div class="${classes}">${day.getDate()}</div>`;
  }
  
  html += `
    </div>
    <div class="rehit-cal-legend">
      <div class="rehit-cal-legend-item"><div class="rehit-cal-legend-dot dot-2x10"></div><span>2×10</span></div>
      <div class="rehit-cal-legend-item"><div class="rehit-cal-legend-dot dot-3x10"></div><span>3×10</span></div>
    </div>
  `;
  
  container.innerHTML = html;
}

function renderMonthCalendar(container, rehitMap, startDate) {
  const year = startDate.getFullYear();
  const month = startDate.getMonth();
  
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  
  const today = new Date();
  const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(-2)}`;
  
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDay = firstDay.getDay();
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  
  let html = `
    <div class="rehit-cal-header">
      <div class="rehit-cal-title">${monthNames[month]} ${year}</div>
    </div>
    <div class="rehit-cal-weekdays">
      <div class="rehit-cal-weekday">S</div>
      <div class="rehit-cal-weekday">M</div>
      <div class="rehit-cal-weekday">T</div>
      <div class="rehit-cal-weekday">W</div>
      <div class="rehit-cal-weekday">T</div>
      <div class="rehit-cal-weekday">F</div>
      <div class="rehit-cal-weekday">S</div>
    </div>
    <div class="rehit-cal-days">
  `;
  
  // Previous month days
  for (let i = startingDay - 1; i >= 0; i--) {
    html += `<div class="rehit-cal-day other-month">${prevMonthLastDay - i}</div>`;
  }
  
  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${month + 1}/${day}/${String(year).slice(-2)}`;
    const rehitVal = rehitMap[dateStr];
    const isToday = dateStr === todayStr;
    
    let classes = "rehit-cal-day";
    if (isToday) classes += " today";
    if (rehitVal) {
      classes += " has-rehit";
      if (rehitVal === "2x10") classes += " rehit-2x10";
      if (rehitVal === "3x10") classes += " rehit-3x10";
    }
    
    html += `<div class="${classes}">${day}</div>`;
  }
  
  // Next month days
  const totalCells = startingDay + daysInMonth;
  const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remainingCells; i++) {
    html += `<div class="rehit-cal-day other-month">${i}</div>`;
  }
  
  html += `
    </div>
    <div class="rehit-cal-legend">
      <div class="rehit-cal-legend-item"><div class="rehit-cal-legend-dot dot-2x10"></div><span>2×10</span></div>
      <div class="rehit-cal-legend-item"><div class="rehit-cal-legend-dot dot-3x10"></div><span>3×10</span></div>
    </div>
  `;
  
  container.innerHTML = html;
}

function renderGoalPerformance(stats) {
  const doingWell = document.getElementById('goalsDoingWell');
  const needsWork = document.getElementById('goalsNeedWork');
  if (!doingWell || !needsWork) return;
  
  const goals = [
    { key: 'sleep', ...GOALS.sleep, ...stats.sleep },
    { key: 'water', ...GOALS.water, ...stats.water },
    { key: 'supps', ...GOALS.supps, name: 'Supplements', icon: '💊' },
    { key: 'rehit', ...GOALS.rehit, ...stats.rehit },
    { key: 'steps', ...GOALS.steps, ...stats.steps },
    { key: 'movement', ...GOALS.movement, ...stats.movement },
    { key: 'reading', ...GOALS.reading, ...stats.reading }
  ];
  
  const sorted = goals.sort((a, b) => b.pct - a.pct);
  const good = sorted.filter(g => g.pct >= 70);
  const work = sorted.filter(g => g.pct < 70);
  
  doingWell.innerHTML = good.length > 0 ? good.map(g => `
    <div class="goal-badge">
      <span class="goal-badge-icon">${g.icon}</span>
      <span class="goal-badge-text">${g.name}</span>
      <span class="goal-badge-pct">${g.pct}%</span>
    </div>
  `).join('') : '<div style="color: var(--text-muted); font-size: 13px;">Keep working on your goals!</div>';
  
  needsWork.innerHTML = work.length > 0 ? work.map(g => `
    <div class="goal-badge" style="border-color: var(--accent-pink);">
      <span class="goal-badge-icon">${g.icon}</span>
      <span class="goal-badge-text">${g.name}</span>
      <span class="goal-badge-pct" style="color: var(--accent-pink);">${g.pct}%</span>
    </div>
  `).join('') : '<div style="color: var(--text-muted); font-size: 13px;">Great job on all goals! 🎉</div>';
}

function renderGoalStatCard(name, icon, pct, detail, color = null) {
  const pctClass = pct >= 80 ? 'good' : pct >= 50 ? 'ok' : 'needs-work';
  const barColor = pct >= 80 ? 'var(--accent-teal)' : pct >= 50 ? 'var(--accent-orange)' : 'var(--accent-pink)';
  
  return `
    <div class="goal-stat-card">
      <div class="goal-stat-header">
        <span class="goal-stat-name">${icon} ${name}</span>
        <span class="goal-stat-pct ${pctClass}">${pct}%</span>
      </div>
      <div class="goal-stat-bar">
        <div class="goal-stat-bar-fill" style="width: ${pct}%; background: ${barColor};"></div>
      </div>
      <div class="goal-stat-detail">${detail}</div>
    </div>
  `;
}

function renderHealthGoals(stats) {
  const container = document.getElementById('healthGoalsStats');
  if (!container) return;
  
  container.innerHTML = `
    ${renderGoalStatCard('Sleep', '🌙', stats.sleep.pct, stats.sleep.detail)}
    ${renderGoalStatCard('Water', '💧', stats.water.pct, stats.water.detail)}
    ${renderGoalStatCard('Supps', '💊', stats.supps.pct, stats.supps.detail)}
    ${renderGoalStatCard('REHIT', '🚴', stats.rehit.pct, stats.rehit.detail)}
    ${renderGoalStatCard('Steps', '👟', stats.steps.pct, stats.steps.detail)}
    ${renderGoalStatCard('Movement', '🚶', stats.movement.pct, stats.movement.detail)}
    ${renderGoalStatCard('Reading', '📖', stats.reading.pct, stats.reading.detail)}
  `;
}

function renderNutritionStats(stats) {
  const container = document.getElementById('nutritionStats');
  if (!container) return;
  
  container.innerHTML = `
    ${renderGoalStatCard('Meals', '🍽️', stats.meals.pct, stats.meals.detail)}
    ${renderGoalStatCard('Snacks', '🥗', stats.snacks.pct, stats.snacks.detail)}
  `;
}

function renderMindfulnessStats(stats) {
  const container = document.getElementById('mindfulnessStats');
  if (!container) return;
  
  container.innerHTML = `
    <div class="goal-stat-card" style="grid-column: 1 / -1;">
      <div class="goal-stat-header">
        <span class="goal-stat-name">🧘 Meditation</span>
        <span style="font-size: 12px; color: var(--text-muted);">No goal - tracking only</span>
      </div>
      <div class="goal-stat-detail">${stats.meditation.detail}</div>
    </div>
  `;
}

function renderKidsHabitsStats(stats) {
  const container = document.getElementById('kidsHabitsStats');
  if (!container) return;
  
  container.innerHTML = `
    ${renderGoalStatCard('Inhaler AM', '💨', stats.inhalerAM.pct, stats.inhalerAM.detail)}
    ${renderGoalStatCard('Inhaler PM', '💨', stats.inhalerPM.pct, stats.inhalerPM.detail)}
    ${renderGoalStatCard('Math', '🔢', stats.math.pct, stats.math.detail)}
  `;
}

function renderWritingStats(stats) {
  const container = document.getElementById('writingStats');
  if (!container) return;
  
  container.innerHTML = `
    ${renderGoalStatCard('Reflections', '✍️', stats.reflections.pct, stats.reflections.detail)}
    ${renderGoalStatCard('Stories', '📝', stats.stories.pct, stats.stories.detail)}
    ${renderGoalStatCard('Carly', '💛', stats.carly.pct, stats.carly.detail)}
  `;
}

function loadPhaseProgress() {
  const phaseStart = new Date("2026-01-19");
  phaseStart.setHours(0, 0, 0, 0);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const daysComplete = Math.floor((today - phaseStart) / (1000 * 60 * 60 * 24)) + 1;
  const totalDays = 21;
  const daysRemaining = Math.max(0, totalDays - daysComplete);
  const progressPercent = Math.min(100, (daysComplete / totalDays) * 100);
  
  const barEl = document.getElementById("phaseProgressBar");
  if (barEl) barEl.style.width = `${progressPercent}%`;
}

// =====================================
// CHARTS PAGE
// =====================================
function setupChartsPage() {
  const chartsBtn = document.getElementById("chartsBtn");
  const chartsCloseBtn = document.getElementById("chartsCloseBtn");
  
  if (chartsBtn) {
    chartsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showChartsPage();
    });
  }
  
  if (chartsCloseBtn) {
    chartsCloseBtn.addEventListener("click", hideChartsPage);
  }
  
  console.log("✅ Charts page wired");
}

async function showChartsPage() {
  const mainPage = document.getElementById("healthForm");
  const chartsPage = document.getElementById("chartsPage");
  const bioPage = document.getElementById("biomarkersPage");
  const summaryPage = document.getElementById("weeklySummaryPage");
  const settingsPage = document.getElementById("settingsPage");
  const fab = document.getElementById("quickLogFab");
  
  if (mainPage) mainPage.style.display = "none";
  if (bioPage) bioPage.style.display = "none";
  if (summaryPage) summaryPage.style.display = "none";
  if (settingsPage) settingsPage.style.display = "none";
  if (chartsPage) chartsPage.style.display = "block";
  if (fab) fab.style.display = "none";
  
  // Scroll to top
  window.scrollTo(0, 0);
  
  // Show loading state
  const subtitle = chartsPage.querySelector(".subtitle");
  if (subtitle) subtitle.textContent = "Loading data...";
  
  // Load data and render charts
  try {
    await loadAndRenderCharts();
    if (subtitle) subtitle.textContent = "Last 30 Days";
  } catch (err) {
    console.error("Charts error:", err);
    if (subtitle) subtitle.textContent = "Error loading charts";
  }
}

function hideChartsPage() {
  const mainPage = document.getElementById("healthForm");
  const chartsPage = document.getElementById("chartsPage");
  const fab = document.getElementById("quickLogFab");
  
  if (chartsPage) chartsPage.style.display = "none";
  if (mainPage) mainPage.style.display = "block";
  if (fab) fab.style.display = "block";
  
  window.scrollTo(0, 0);
}

// Store prefetched chart data
let chartDataCache = null;
let chartDataLoading = false;
let currentChartRange = 7; // Default to 7 days

async function prefetchChartData() {
  if (chartDataCache || chartDataLoading) return;
  
  chartDataLoading = true;
  console.log("📊 Prefetching chart data in background...");
  
  try {
    chartDataCache = await fetchChartData(null, true); // silent mode for background
    console.log(`📊 Prefetched ${chartDataCache.length} days of chart data`);
  } catch (err) {
    console.error("Prefetch failed:", err);
  }
  
  chartDataLoading = false;
}

function updateChartProgress(current, total, message) {
  const bar = document.getElementById("chartLoadingBar");
  const fill = document.getElementById("chartProgressFill");
  const text = document.getElementById("chartProgressText");
  
  if (bar) bar.style.display = "block";
  if (fill) fill.style.width = `${(current / total) * 100}%`;
  if (text) text.textContent = message || `Loading day ${current} of ${total}...`;
}

function hideChartProgress() {
  const bar = document.getElementById("chartLoadingBar");
  if (bar) bar.style.display = "none";
}

async function fetchChartData(maxDays = null, silent = false) {
  const dataPoints = [];
  let emptyDaysInARow = 0;
  const maxEmptyDays = 2; // Stop after 2 consecutive empty days
  const absoluteMax = maxDays || 365;
  
  // Never go before this date
  const startDate = new Date("2026-01-19");
  startDate.setHours(0, 0, 0, 0);
  
  // Calculate how many days since start for progress display
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalPossibleDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24)) + 1;
  const progressMax = maxDays ? Math.min(maxDays, totalPossibleDays) : totalPossibleDays;
  
  for (let i = 0; i < absoluteMax; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    
    // Stop if we've gone before the start date
    if (date < startDate) {
      console.log(`📊 Reached start date limit (1/19/2026)`);
      break;
    }
    
    const dateStr = formatDateForAPI(date);
    
    if (!silent) {
      updateChartProgress(i + 1, progressMax, `Loading day ${i + 1} of ${progressMax}...`);
    }
    
    try {
      // Small delay between requests to avoid rate limiting
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      const result = await apiGet("load", { date: dateStr });
      
      // Check for error responses
      if (result?.error) {
        console.error(`Error loading ${dateStr}:`, result.message);
        emptyDaysInARow++;
        if (emptyDaysInARow >= maxEmptyDays) break;
        continue;
      }
      
      const daily = result?.daily;
      
      // Check if this day has any meaningful data (more robust check)
      const hasData = daily && Object.keys(daily).length > 0 && (
        (daily["Hours of Sleep"] && daily["Hours of Sleep"] !== "") ||
        (daily["Steps"] && daily["Steps"] !== "" && daily["Steps"] !== 0) ||
        (daily["Weight (lbs)"] && daily["Weight (lbs)"] !== "") ||
        (daily["REHIT 2x10"] && daily["REHIT 2x10"] !== "")
      );
      
      if (hasData) {
        emptyDaysInARow = 0;
        dataPoints.push({
          date: dateStr,
          daily: daily || {},
          averages: result?.averages || {}
        });
      } else {
        emptyDaysInARow++;
        console.log(`📊 Empty day ${emptyDaysInARow}/${maxEmptyDays}: ${dateStr}`);
        if (emptyDaysInARow >= maxEmptyDays) {
          console.log(`📊 Stopping - ${maxEmptyDays} empty days in a row`);
          break;
        }
      }
    } catch (err) {
      console.error(`Failed to load ${dateStr}:`, err);
      emptyDaysInARow++;
      if (emptyDaysInARow >= maxEmptyDays) break;
    }
  }
  
  if (!silent) {
    hideChartProgress();
  }
  
  // Reverse so oldest is first (for charts)
  return dataPoints.reverse();
}

function filterChartDataByRange(allData, range) {
  if (range === 'all' || !range) return allData;
  
  const days = parseInt(range, 10);
  if (isNaN(days)) return allData;
  
  // Return only the last N days
  return allData.slice(-days);
}

async function loadAndRenderCharts() {
  // Check if Chart.js is loaded
  if (typeof Chart === 'undefined') {
    console.error("Chart.js not loaded yet");
    alert("Charts are still loading. Please try again in a moment.");
    return;
  }
  
  // Use cached data if available, otherwise fetch
  let allData;
  if (chartDataCache && chartDataCache.length > 0) {
    allData = chartDataCache;
    console.log(`📊 Using cached chart data (${allData.length} days)`);
  } else {
    allData = await fetchChartData();
    chartDataCache = allData;
  }
  
  // Update range buttons to show data availability
  updateRangeButtonsAvailability();
  
  if (allData.length === 0) {
    console.log("No data to chart");
    const subtitle = document.getElementById("chartsSubtitle");
    if (subtitle) subtitle.textContent = "No data available";
    return;
  }
  
  // Filter by selected range
  const dataPoints = filterChartDataByRange(allData, currentChartRange);
  
  // Update subtitle
  const subtitle = document.getElementById("chartsSubtitle");
  if (subtitle) {
    if (currentChartRange === 'all') {
      subtitle.textContent = `All Time (${dataPoints.length} days)`;
    } else {
      subtitle.textContent = `Last ${currentChartRange} Days (${dataPoints.length} with data)`;
    }
  }
  
  // Render each chart
  try {
    renderWeightChart(dataPoints);
    renderSleepChart(dataPoints);
    renderStepsChart(dataPoints);
    renderRehitChart(dataPoints);
    renderPeakWattsChart(dataPoints);
    renderBodyCompositionChart(dataPoints);
    renderBloodPressureChart(dataPoints);
  } catch (err) {
    console.error("Error rendering charts:", err);
  }
}

function setupChartRangeToggle() {
  const buttons = document.querySelectorAll('.range-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Update active state
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Update range and re-render
      currentChartRange = btn.dataset.range;
      loadAndRenderCharts();
    });
  });
}

function updateRangeButtonsAvailability() {
  if (!chartDataCache) return;
  
  const totalDays = chartDataCache.length;
  const btn30 = document.querySelector('.range-btn[data-range="30"]');
  const btnAll = document.querySelector('.range-btn[data-range="all"]');
  
  // Update button labels to show available data
  if (btn30) {
    if (totalDays < 30) {
      btn30.textContent = `30 Days (${totalDays})`;
      btn30.style.opacity = '0.5';
    } else {
      btn30.textContent = '30 Days';
      btn30.style.opacity = '1';
    }
  }
  
  if (btnAll) {
    btnAll.textContent = `All (${totalDays})`;
  }
}

let weightChart, sleepChart, stepsChart, rehitChart, bodyCompChart, peakWattsChart;
let rehitCalendarMonth = new Date(); // Track current month for calendar

// Helper to get chart colors based on theme
function getChartColors() {
  const isDayMode = document.body.classList.contains('day-mode');
  return {
    text: isDayMode ? '#374151' : '#999',
    grid: isDayMode ? '#e5e7eb' : '#3a3a3a',
    background: isDayMode ? 'rgba(0,0,0,0.05)' : '#2a2a2a'
  };
}

function renderWeightChart(dataPoints) {
  const canvas = document.getElementById("weightChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  const colors = getChartColors();
  
  // Destroy existing chart
  if (weightChart) weightChart.destroy();
  
  const labels = dataPoints.map(d => d.date);
  const weights = dataPoints.map(d => parseFloat(d.daily["Weight (lbs)"]) || null);
  const waists = dataPoints.map(d => parseFloat(d.daily["Waist"]) || null);
  
  weightChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Weight (lbs)',
          data: weights,
          borderColor: '#06ffa5',
          backgroundColor: 'rgba(6, 255, 165, 0.1)',
          tension: 0.3,
          spanGaps: true
        },
        {
          label: 'Waist (in)',
          data: waists,
          borderColor: '#4d9de0',
          backgroundColor: 'rgba(77, 157, 224, 0.1)',
          tension: 0.3,
          spanGaps: true,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, labels: { color: '#e0e0e0' } }
      },
      scales: {
        x: { 
          ticks: { color: colors.text, maxRotation: 45, minRotation: 45 },
          grid: { color: colors.grid }
        },
        y: {
          type: 'linear',
          position: 'left',
          ticks: { color: colors.text },
          grid: { color: colors.grid },
          title: { display: true, text: 'Weight (lbs)', color: '#999' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          ticks: { color: colors.text },
          grid: { display: false },
          title: { display: true, text: 'Waist (in)', color: '#999' }
        }
      }
    }
  });
}

function renderSleepChart(dataPoints) {
  const canvas = document.getElementById("sleepChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  const colors = getChartColors();
  
  if (sleepChart) sleepChart.destroy();
  
  const labels = dataPoints.map(d => d.date);
  const sleep = dataPoints.map(d => parseFloat(d.daily["Hours of Sleep"]) || null);
  
  // Calculate average (excluding nulls)
  const validSleep = sleep.filter(s => s !== null && !isNaN(s));
  const avgSleep = validSleep.length > 0 
    ? validSleep.reduce((a, b) => a + b, 0) / validSleep.length 
    : null;
  
  // Create average line data (same value for all points)
  const avgLine = avgSleep ? labels.map(() => avgSleep) : [];
  
  sleepChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Hours of Sleep',
          data: sleep,
          backgroundColor: '#a393eb',
          borderColor: '#a393eb',
          borderWidth: 1,
          order: 2
        },
        {
          label: `Average (${avgSleep ? avgSleep.toFixed(1) : '--'}h)`,
          data: avgLine,
          type: 'line',
          borderColor: '#e0e0e0',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { 
          display: true,
          labels: { color: '#e0e0e0' }
        }
      },
      scales: {
        x: { 
          ticks: { color: colors.text, maxRotation: 45, minRotation: 45 },
          grid: { color: colors.grid }
        },
        y: {
          beginAtZero: true,
          max: 12,
          ticks: { color: colors.text },
          grid: { color: colors.grid },
          title: { display: true, text: 'Hours', color: '#999' }
        }
      }
    }
  });
}

function renderStepsChart(dataPoints) {
  const canvas = document.getElementById("stepsChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  const colors = getChartColors();
  
  if (stepsChart) stepsChart.destroy();
  
  const labels = dataPoints.map(d => d.date);
  const steps = dataPoints.map(d => parseInt(d.daily["Steps"]) || null);
  
  stepsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Daily Steps',
        data: steps,
        borderColor: '#4d9de0',
        backgroundColor: 'rgba(77, 157, 224, 0.1)',
        tension: 0.3,
        fill: true,
        spanGaps: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { 
          ticks: { color: colors.text, maxRotation: 45, minRotation: 45 },
          grid: { color: colors.grid }
        },
        y: {
          beginAtZero: true,
          ticks: { color: colors.text },
          grid: { color: colors.grid },
          title: { display: true, text: 'Steps', color: '#999' }
        }
      }
    }
  });
}

// Store REHIT data globally for calendar
let rehitDataMap = {};

function renderRehitChart(dataPoints) {
  // Build a map of date -> rehit value for calendar lookup
  rehitDataMap = {};
  dataPoints.forEach(d => {
    const val = d.daily["REHIT 2x10"];
    if (val === "2x10" || val === true || val === "TRUE") {
      rehitDataMap[d.date] = "2x10";
    } else if (val === "3x10") {
      rehitDataMap[d.date] = "3x10";
    }
  });
  
  // Render the calendar
  renderRehitCalendar();
}

function renderRehitCalendar() {
  const container = document.getElementById("rehitCalendar");
  if (!container) return;
  
  const year = rehitCalendarMonth.getFullYear();
  const month = rehitCalendarMonth.getMonth();
  
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  
  const today = new Date();
  // Format today as M/D/YY to match API format
  const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(-2)}`;
  
  // Get first day of month and number of days
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDay = firstDay.getDay(); // 0 = Sunday
  
  // Get days from previous month to fill first week
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  
  let html = `
    <div class="rehit-cal-header">
      <div class="rehit-cal-title">${monthNames[month]} ${year}</div>
      <div class="rehit-cal-nav">
        <button type="button" onclick="navigateRehitCalendar(-1)">‹</button>
        <button type="button" onclick="navigateRehitCalendar(1)">›</button>
      </div>
    </div>
    <div class="rehit-cal-weekdays">
      <div class="rehit-cal-weekday">S</div>
      <div class="rehit-cal-weekday">M</div>
      <div class="rehit-cal-weekday">T</div>
      <div class="rehit-cal-weekday">W</div>
      <div class="rehit-cal-weekday">T</div>
      <div class="rehit-cal-weekday">F</div>
      <div class="rehit-cal-weekday">S</div>
    </div>
    <div class="rehit-cal-days">
  `;
  
  // Previous month days
  for (let i = startingDay - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i;
    html += `<div class="rehit-cal-day other-month">${day}</div>`;
  }
  
  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    // Format as M/D/YY to match API format
    const dateStr = `${month + 1}/${day}/${String(year).slice(-2)}`;
    const rehitVal = rehitDataMap[dateStr];
    const isToday = dateStr === todayStr;
    
    let classes = "rehit-cal-day";
    if (isToday) classes += " today";
    if (rehitVal) {
      classes += " has-rehit";
      if (rehitVal === "2x10") classes += " rehit-2x10";
      if (rehitVal === "3x10") classes += " rehit-3x10";
    }
    
    html += `<div class="${classes}">${day}</div>`;
  }
  
  // Next month days to fill last week
  const totalCells = startingDay + daysInMonth;
  const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remainingCells; i++) {
    html += `<div class="rehit-cal-day other-month">${i}</div>`;
  }
  
  html += `
    </div>
    <div class="rehit-cal-legend">
      <div class="rehit-cal-legend-item">
        <div class="rehit-cal-legend-dot dot-2x10"></div>
        <span>2×10</span>
      </div>
      <div class="rehit-cal-legend-item">
        <div class="rehit-cal-legend-dot dot-3x10"></div>
        <span>3×10</span>
      </div>
    </div>
  `;
  
  container.innerHTML = html;
}

function navigateRehitCalendar(direction) {
  rehitCalendarMonth.setMonth(rehitCalendarMonth.getMonth() + direction);
  renderRehitCalendar();
}

// Make it globally available
window.navigateRehitCalendar = navigateRehitCalendar;

function renderPeakWattsChart(dataPoints) {
  const canvas = document.getElementById("peakWattsChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  const colors = getChartColors();
  
  if (peakWattsChart) peakWattsChart.destroy();
  
  // Filter to only days with peak watts data
  const filteredData = dataPoints.filter(d => {
    const watts = parseFloat(d.daily["Peak Watts"]);
    return !isNaN(watts) && watts > 0;
  });
  
  if (filteredData.length === 0) {
    // No data - show empty state
    canvas.style.display = 'none';
    return;
  }
  
  canvas.style.display = 'block';
  
  const labels = filteredData.map(d => d.date);
  const watts = filteredData.map(d => parseFloat(d.daily["Peak Watts"]));
  
  // Calculate trend line
  const avgWatts = watts.reduce((a, b) => a + b, 0) / watts.length;
  
  peakWattsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Peak Watts',
        data: watts,
        borderColor: '#ff6b9d',
        backgroundColor: 'rgba(255, 107, 157, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#ff6b9d',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.parsed.y} watts`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: colors.text, maxRotation: 45, minRotation: 45 },
          grid: { color: colors.grid }
        },
        y: {
          beginAtZero: false,
          ticks: { 
            color: '#999',
            callback: function(value) {
              return value + 'W';
            }
          },
          grid: { color: colors.grid }
        }
      }
    }
  });
}

function renderBodyCompositionChart(dataPoints) {
  const canvas = document.getElementById("bodyCompChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  const colors = getChartColors();
  
  if (bodyCompChart) bodyCompChart.destroy();
  
  const labels = dataPoints.map(d => d.date);
  const leanMass = dataPoints.map(d => parseFloat(d.daily["Lean Mass (lbs)"]) || null);
  const bodyFat = dataPoints.map(d => parseFloat(d.daily["Body Fat (lbs)"]) || null);
  
  bodyCompChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Lean Mass (lbs)',
          data: leanMass,
          borderColor: '#52b788',
          backgroundColor: 'rgba(82, 183, 136, 0.1)',
          tension: 0.3,
          spanGaps: true
        },
        {
          label: 'Body Fat (lbs)',
          data: bodyFat,
          borderColor: '#e63946',
          backgroundColor: 'rgba(230, 57, 70, 0.1)',
          tension: 0.3,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, labels: { color: '#e0e0e0' } }
      },
      scales: {
        x: { 
          ticks: { color: colors.text, maxRotation: 45, minRotation: 45 },
          grid: { color: colors.grid }
        },
        y: {
          ticks: { color: colors.text },
          grid: { color: colors.grid },
          title: { display: true, text: 'Pounds', color: '#999' }
        }
      }
    }
  });
}

let bpChart;

function renderBloodPressureChart(dataPoints) {
  const canvas = document.getElementById("bpChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  const colors = getChartColors();
  
  if (bpChart) bpChart.destroy();
  
  const labels = dataPoints.map(d => d.date);
  const systolic = dataPoints.map(d => parseInt(d.daily["Systolic"]) || null);
  const diastolic = dataPoints.map(d => parseInt(d.daily["Diastolic"]) || null);
  const heartRate = dataPoints.map(d => parseInt(d.daily["Heart Rate"]) || null);
  
  bpChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Systolic (mmHg)',
          data: systolic,
          borderColor: '#ff006e',
          backgroundColor: 'rgba(255, 0, 110, 0.1)',
          tension: 0.3,
          spanGaps: true
        },
        {
          label: 'Diastolic (mmHg)',
          data: diastolic,
          borderColor: '#4d9de0',
          backgroundColor: 'rgba(77, 157, 224, 0.1)',
          tension: 0.3,
          spanGaps: true
        },
        {
          label: 'Heart Rate (bpm)',
          data: heartRate,
          borderColor: '#52b788',
          backgroundColor: 'rgba(82, 183, 136, 0.1)',
          tension: 0.3,
          spanGaps: true,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: true, labels: { color: '#e0e0e0' } }
      },
      scales: {
        x: { 
          ticks: { color: colors.text, maxRotation: 45, minRotation: 45 },
          grid: { color: colors.grid }
        },
        y: {
          type: 'linear',
          position: 'left',
          ticks: { color: colors.text },
          grid: { color: colors.grid },
          title: { display: true, text: 'Blood Pressure (mmHg)', color: '#999' },
          min: 60,
          max: 160
        },
        y1: {
          type: 'linear',
          position: 'right',
          ticks: { color: colors.text },
          grid: { display: false },
          title: { display: true, text: 'Heart Rate (bpm)', color: '#999' },
          min: 50,
          max: 100
        }
      }
    }
  });
}

// =====================================
// BIOMARKERS PAGE
// =====================================
function setupBiomarkersPage() {
  const bioBtn = document.getElementById("biomarkersBtn");
  const bioCloseBtn = document.getElementById("biomarkersCloseBtn");
  
  if (bioBtn) {
    bioBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showBiomarkersPage();
    });
  }
  
  if (bioCloseBtn) {
    bioCloseBtn.addEventListener("click", hideBiomarkersPage);
  }
  
  console.log("✅ Biomarkers page wired");
}

// =====================================
// STICKY HEADER
// =====================================
function setupStickyHeader() {
  const stickyBar = document.getElementById("stickyDateBar");
  const stickyPrev = document.getElementById("stickyPrevBtn");
  const stickyNext = document.getElementById("stickyNextBtn");
  
  if (!stickyBar) {
    console.warn("Sticky bar not found");
    return;
  }
  
  // Wire up sticky nav buttons
  if (stickyPrev) {
    stickyPrev.addEventListener("click", () => changeDate(-1));
  }
  if (stickyNext) {
    stickyNext.addEventListener("click", () => changeDate(1));
  }
  
  // Handle scroll to show/hide sticky bar
  window.addEventListener("scroll", () => {
    const scrollY = window.scrollY;
    
    // Show sticky bar when scrolled past 150px
    if (scrollY > 150) {
      stickyBar.classList.add("visible");
    } else {
      stickyBar.classList.remove("visible");
    }
  }, { passive: true });
  
  console.log("✅ Sticky header wired");
}

function updateStickyDate() {
  const stickyDate = document.getElementById("stickyDateDisplay");
  if (!stickyDate) return;
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const cur = new Date(currentDate);
  cur.setHours(0, 0, 0, 0);
  
  if (cur.getTime() === today.getTime()) {
    stickyDate.textContent = "Today";
  } else {
    const options = { weekday: 'short', month: 'short', day: 'numeric' };
    stickyDate.textContent = cur.toLocaleDateString('en-US', options);
  }
}

// =====================================
// QUICK LOG FAB
// =====================================
function setupQuickLog() {
  const fab = document.getElementById("quickLogFab");
  const menu = document.getElementById("quickLogMenu");
  
  if (!fab || !menu) {
    console.warn("Quick log elements not found");
    return;
  }
  
  let isOpen = false;
  
  fab.addEventListener("click", () => {
    isOpen = !isOpen;
    fab.classList.toggle("open", isOpen);
    fab.textContent = isOpen ? "✕" : "+";
    menu.classList.toggle("open", isOpen);
  });
  
  // Close menu when clicking outside
  document.addEventListener("click", (e) => {
    if (isOpen && !fab.contains(e.target) && !menu.contains(e.target)) {
      isOpen = false;
      fab.classList.remove("open");
      fab.textContent = "+";
      menu.classList.remove("open");
    }
  });
  
  // Handle quick log actions
  menu.querySelectorAll(".quick-log-item").forEach(item => {
    item.addEventListener("click", async (e) => {
      const action = item.dataset.action;
      await handleQuickLog(action, item);
    });
  });
  
  console.log("✅ Quick log wired");
}

function showBiomarkersPage() {
  const mainPage = document.getElementById("healthForm");
  const chartsPage = document.getElementById("chartsPage");
  const bioPage = document.getElementById("biomarkersPage");
  const summaryPage = document.getElementById("weeklySummaryPage");
  const settingsPage = document.getElementById("settingsPage");
  const fab = document.getElementById("quickLogFab");
  
  if (mainPage) mainPage.style.display = "none";
  if (chartsPage) chartsPage.style.display = "none";
  if (summaryPage) summaryPage.style.display = "none";
  if (settingsPage) settingsPage.style.display = "none";
  if (bioPage) bioPage.style.display = "block";
  if (fab) fab.style.display = "none";
  
  window.scrollTo(0, 0);
  loadBiomarkers();
}

async function handleQuickLog(action, buttonEl) {
  // Visual feedback
  buttonEl.classList.add("success");
  setTimeout(() => buttonEl.classList.remove("success"), 500);
  
  switch (action) {
    case "movement":
      await quickLogMovement();
      break;
    case "water":
      await quickLogWater();
      break;
    case "reading":
      await quickLogReading();
      break;
    case "rehit":
      await quickLogRehit();
      break;
  }
  
  // Close the menu after action
  const fab = document.getElementById("quickLogFab");
  const menu = document.getElementById("quickLogMenu");
  fab.classList.remove("open");
  fab.textContent = "+";
  menu.classList.remove("open");
}

async function quickLogMovement() {
  // Prompt for movement type and duration
  const types = ["Walk", "Carol Bike Free Ride", "Stretch", "Stairs", "Exercise", "Other"];
  const typeChoice = prompt(`Movement type:\n1. Walk\n2. Carol Bike Free Ride\n3. Stretch\n4. Stairs\n5. Exercise\n6. Other\n\nEnter number (1-6):`);
  
  if (!typeChoice) return;
  
  const typeIndex = parseInt(typeChoice, 10) - 1;
  if (typeIndex < 0 || typeIndex >= types.length) {
    alert("Invalid choice");
    return;
  }
  
  const duration = prompt("Duration in minutes:", "10");
  if (!duration) return;
  
  const mins = parseInt(duration, 10);
  if (isNaN(mins) || mins <= 0) {
    alert("Please enter a valid number of minutes");
    return;
  }
  
  // Add to movements array and save
  movements.push({ duration: mins, type: types[typeIndex] });
  renderMovements();
  triggerSaveSoon();
  
  // Show confirmation
  showQuickConfirmation(`✓ Logged ${mins} min ${types[typeIndex]}`);
}

async function quickLogWater() {
  // Increment water count
  waterCount++;
  const waterEl = document.getElementById("waterCount");
  if (waterEl) waterEl.textContent = waterCount;
  
  triggerSaveSoon();
  showQuickConfirmation(`✓ Water: ${waterCount} glasses`);
}

async function quickLogReading() {
  const duration = prompt("Reading duration (minutes):", "15");
  if (!duration) return;
  
  const mins = parseInt(duration, 10);
  if (isNaN(mins) || mins <= 0) {
    alert("Please enter a valid number of minutes");
    return;
  }
  
  const book = prompt("Book title:", lastBookTitle);
  if (book === null) return;
  
  const bookTitle = book.trim() || lastBookTitle;
  
  readings.push({ duration: mins, book: bookTitle });
  lastBookTitle = bookTitle;
  renderReadings();
  triggerSaveSoon();
  
  showQuickConfirmation(`✓ Logged ${mins} min reading`);
}

async function quickLogRehit() {
  const choice = prompt("REHIT type:\n1. 2x10\n2. 3x10\n\nEnter number:");
  
  if (!choice) return;
  
  const rehit2 = document.getElementById("rehit2");
  const rehit3 = document.getElementById("rehit3");
  
  if (choice === "1" && rehit2) {
    rehit2.checked = true;
    if (rehit3) rehit3.checked = false;
    syncCheckboxVisual(rehit2);
    if (rehit3) syncCheckboxVisual(rehit3);
    triggerSaveSoon();
    showQuickConfirmation("✓ REHIT 2x10 logged");
  } else if (choice === "2" && rehit3) {
    rehit3.checked = true;
    if (rehit2) rehit2.checked = false;
    syncCheckboxVisual(rehit3);
    if (rehit2) syncCheckboxVisual(rehit2);
    triggerSaveSoon();
    showQuickConfirmation("✓ REHIT 3x10 logged");
  } else {
    alert("Invalid choice");
  }
}

function showQuickConfirmation(message) {
  // Create a toast notification
  const toast = document.createElement("div");
  toast.style.cssText = `
    position: fixed;
    bottom: 100px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, #52b788 0%, #40916c 100%);
    color: #fff;
    padding: 12px 24px;
    border-radius: 50px;
    font-size: 16px;
    font-weight: 600;
    box-shadow: 0 4px 20px rgba(82, 183, 136, 0.4);
    z-index: 1001;
    animation: toast-in 0.3s ease, toast-out 0.3s ease 1.7s forwards;
  `;
  toast.textContent = message;
  
  // Add animation keyframes if not already present
  if (!document.getElementById("toast-styles")) {
    const style = document.createElement("style");
    style.id = "toast-styles";
    style.textContent = `
      @keyframes toast-in {
        from { opacity: 0; transform: translateX(-50%) translateY(20px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes toast-out {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(toast);
  
  // Remove after animation
  setTimeout(() => toast.remove(), 2000);
}

// =====================================
// DOPAMINE BOOSTS
// =====================================
let lastCompletionCount = 0;
let personalBests = {};

function setupDopamineBoosts() {
  // Add confetti to all checkboxes
  document.querySelectorAll('.checkbox-field input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        createConfetti(e.target);
        updateCompletionRing();
        checkForMilestones();
      } else {
        updateCompletionRing();
      }
    });
  });
  
  // Track number inputs for personal bests
  document.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('change', () => {
      checkPersonalBest(input);
    });
  });
  
  // Initial completion ring update
  setTimeout(updateCompletionRing, 500);
  
  console.log("✅ Dopamine boosts wired");
}

function createConfetti(element) {
  const rect = element.getBoundingClientRect();
  const container = document.createElement('div');
  container.className = 'confetti-container';
  container.style.left = rect.left + rect.width / 2 + 'px';
  container.style.top = rect.top + rect.height / 2 + 'px';
  document.body.appendChild(container);
  
  const colors = ['#52b788', '#ff9f1c', '#4d9de0', '#a393eb', '#ff006e', '#ffd700'];
  
  for (let i = 0; i < 12; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    
    const angle = (i / 12) * Math.PI * 2;
    const distance = 30 + Math.random() * 30;
    confetti.style.setProperty('--tx', `${Math.cos(angle) * distance}px`);
    confetti.style.setProperty('--ty', `${Math.sin(angle) * distance}px`);
    
    container.appendChild(confetti);
  }
  
  setTimeout(() => container.remove(), 600);
}

function updateCompletionRing() {
  const allCheckboxes = document.querySelectorAll('#healthForm .checkbox-field input[type="checkbox"]');
  
  // Exclude Grey's inhaler checkboxes and multiplication
  const checkboxes = Array.from(allCheckboxes).filter(cb => 
    cb.id !== 'inhalerMorning' && cb.id !== 'inhalerEvening' && cb.id !== 'multiplication'
  );
  
  const total = checkboxes.length;
  const checked = checkboxes.filter(cb => cb.checked).length;
  
  const progress = document.getElementById('completionProgress');
  const number = document.getElementById('completionNumber');
  
  if (progress && number) {
    const circumference = 2 * Math.PI * 32; // r=32
    const offset = circumference - (checked / total) * circumference;
    progress.style.strokeDashoffset = offset;
    
    // Animate number change
    if (checked !== lastCompletionCount) {
      number.classList.add('bumping');
      setTimeout(() => number.classList.remove('bumping'), 300);
    }
    
    number.textContent = checked;
    lastCompletionCount = checked;
    
    // Check for all complete
    if (checked === total && total > 0) {
      showMilestone('🌟', 'All Habits Complete!', 'You crushed it today!');
    }
  }
}

function checkForMilestones() {
  // Check streak milestones
  const streakCount = calculateCurrentStreak();
  
  if (streakCount === 7) {
    setTimeout(() => showMilestone('🔥', '7 Day Streak!', 'One week of consistency!'), 500);
  } else if (streakCount === 14) {
    setTimeout(() => showMilestone('🔥🔥', '14 Day Streak!', 'Two weeks strong!'), 500);
  } else if (streakCount === 21) {
    setTimeout(() => showMilestone('🏆', '21 Day Streak!', 'Habit officially formed!'), 500);
  }
}

function calculateCurrentStreak() {
  // Simple streak calculation from cached chart data
  if (!chartDataCache || chartDataCache.length === 0) return 0;
  
  let streak = 0;
  const sortedData = [...chartDataCache].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  for (const d of sortedData) {
    const hasData = d.daily["Hours of Sleep"] || d.daily["Steps"];
    if (hasData) streak++;
    else break;
  }
  
  return streak;
}

function checkPersonalBest(input) {
  const id = input.id;
  const value = parseFloat(input.value);
  
  if (isNaN(value) || value <= 0) return;
  
  // Check against chart data for personal bests
  if (!chartDataCache || chartDataCache.length === 0) return;
  
  let fieldKey = null;
  let isHigherBetter = true;
  
  if (id === 'steps') {
    fieldKey = 'Steps';
    isHigherBetter = true;
  } else if (id === 'sleepHours') {
    fieldKey = 'Hours of Sleep';
    isHigherBetter = true;
  }
  
  if (!fieldKey) return;
  
  const allValues = chartDataCache
    .map(d => parseFloat(d.daily[fieldKey]))
    .filter(v => !isNaN(v) && v > 0);
  
  if (allValues.length === 0) return;
  
  const currentBest = isHigherBetter ? Math.max(...allValues) : Math.min(...allValues);
  
  if ((isHigherBetter && value > currentBest) || (!isHigherBetter && value < currentBest)) {
    // Personal best!
    input.classList.add('personal-best');
    setTimeout(() => input.classList.remove('personal-best'), 3000);
    
    showMilestone('🏅', 'Personal Best!', `New ${fieldKey.toLowerCase()} record: ${value.toLocaleString()}`);
  }
}

function showMilestone(emoji, title, subtitle) {
  const overlay = document.getElementById('milestoneOverlay');
  const emojiEl = document.getElementById('milestoneEmoji');
  const titleEl = document.getElementById('milestoneTitle');
  const subtitleEl = document.getElementById('milestoneSubtitle');
  
  if (overlay && emojiEl && titleEl && subtitleEl) {
    emojiEl.textContent = emoji;
    titleEl.textContent = title;
    subtitleEl.textContent = subtitle;
    overlay.classList.add('show');
    
    // Create celebration confetti
    createCelebrationConfetti();
  }
}

function closeMilestone() {
  const overlay = document.getElementById('milestoneOverlay');
  if (overlay) {
    overlay.classList.remove('show');
  }
}

function createCelebrationConfetti() {
  const colors = ['#52b788', '#ff9f1c', '#4d9de0', '#a393eb', '#ff006e', '#ffd700'];
  
  for (let i = 0; i < 50; i++) {
    setTimeout(() => {
      const confetti = document.createElement('div');
      confetti.style.cssText = `
        position: fixed;
        width: ${8 + Math.random() * 8}px;
        height: ${8 + Math.random() * 8}px;
        background: ${colors[Math.floor(Math.random() * colors.length)]};
        left: ${Math.random() * 100}vw;
        top: -20px;
        border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
        z-index: 2001;
        animation: confetti-fall ${2 + Math.random() * 2}s linear forwards;
      `;
      
      if (!document.getElementById('confetti-fall-style')) {
        const style = document.createElement('style');
        style.id = 'confetti-fall-style';
        style.textContent = `
          @keyframes confetti-fall {
            0% { transform: translateY(0) rotate(0deg); opacity: 1; }
            100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
          }
        `;
        document.head.appendChild(style);
      }
      
      document.body.appendChild(confetti);
      setTimeout(() => confetti.remove(), 4000);
    }, i * 30);
  }
}

function hideBiomarkersPage() {
  const mainPage = document.getElementById("healthForm");
  const bioPage = document.getElementById("biomarkersPage");
  const fab = document.getElementById("quickLogFab");
  
  if (bioPage) bioPage.style.display = "none";
  if (mainPage) mainPage.style.display = "block";
  if (fab) fab.style.display = "block";
  
  window.scrollTo(0, 0);
}

async function loadBiomarkers() {
  try {
    console.log("Loading biomarkers...");
    // Add timestamp to bust any caching
    const result = await apiGet("biomarkers_load", { _t: Date.now() });
    console.log("Biomarkers result:", result);
    
    if (result?.error) {
      console.error("Biomarkers error:", result);
      const subtitle = document.getElementById("biomarkersSubtitle");
      if (subtitle) {
        // Check if it's an "unknown action" error - means the backend doesn't support it
        if (result.message && result.message.includes("Unknown action")) {
          subtitle.textContent = "⚠️ Backend needs update - biomarkers_load not supported";
        } else {
          subtitle.textContent = "Error: " + result.message;
        }
      }
      return;
    }
    
    const subtitle = document.getElementById("biomarkersSubtitle");
    if (subtitle) {
      if (result.latestDate) {
        // Format the date nicely: "Jan 25, 2026"
        const d = new Date(result.latestDate);
        const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        subtitle.textContent = `Most recent: ${formatted}`;
      } else {
        subtitle.textContent = "No data yet";
      }
    }
    
    renderBiomarkersTable(result.definition || [], result.latestValues || []);
    
  } catch (err) {
    console.error("Failed to load biomarkers:", err);
    const subtitle = document.getElementById("biomarkersSubtitle");
    if (subtitle) subtitle.textContent = "Failed to connect";
  }
}

function renderBiomarkersTable(definition, latestValues) {
  const table = document.getElementById("biomarkersTable");
  if (!table) return;
  
  table.innerHTML = "";
  
  definition.forEach((item, idx) => {
    const prevValue = latestValues[idx] || '';
    const div = document.createElement("div");
    div.style.marginBottom = "16px";
    div.innerHTML = `
      <label class="field-label">${item.biomarker} (${item.units})</label>
      <div style="font-size: 14px; color: #999; margin-bottom: 4px;">
        Optimal: ${item.optimal}${prevValue ? ` • Previous: <span style="color: #4d9de0;">${prevValue}</span>` : ''}
      </div>
      <input type="text" class="input-field biomarker-input" data-index="${idx}" 
             placeholder="${prevValue ? 'Enter new value' : 'Enter value'}" value="">
    `;
    table.appendChild(div);
  });
  
  // Setup submit button
  const submitBtn = document.getElementById("biomarkersSubmitBtn");
  if (submitBtn) {
    submitBtn.onclick = saveBiomarkers;
  }
}

async function saveBiomarkers() {
  const dateInput = document.getElementById("biomarkersDate");
  const dateStr = dateInput?.value?.trim();
  
  if (!dateStr) {
    alert("Please enter a lab date");
    return;
  }
  
  const inputs = document.querySelectorAll(".biomarker-input");
  const values = Array.from(inputs).map(inp => inp.value.trim());
  
  try {
    const result = await apiPost("biomarkers_save", {
      date: dateStr,
      values: values
    });
    
    if (result?.error) {
      alert("Error saving: " + result.message);
      return;
    }
    
    const status = document.getElementById("biomarkersSaveStatus");
    if (status) {
      status.textContent = "✅ Saved successfully!";
      status.style.color = "#52b788";
      setTimeout(() => {
        status.textContent = "";
      }, 3000);
    }
    
    // Reload to show new data
    await loadBiomarkers();
    
  } catch (err) {
    console.error("Save failed:", err);
    alert("Failed to save biomarkers");
  }
}

// =====================================
// LOAD / SAVE
// =====================================
async function loadDataForCurrentDate(options = {}) {
  const dateStr = formatDateForAPI(currentDate);
  console.log("Loading data for", dateStr);

  // Show loading if not cached
  const cached = cacheGet(dateStr);
  if (!cached || options.force) {
    if (typeof showLoading === 'function') showLoading();
  }

  // 1) If cached and not forcing, show instantly
  if (cached && !cached?.error && !options.force) {
    await populateForm(cached);
    prefetchAround(currentDate);
    if (typeof hideLoading === 'function') hideLoading();
    
    // Start chart data loading in background if not already loaded
    if (!chartDataCache && !chartDataLoading) {
      setTimeout(() => prefetchChartData(), 100);
    }
    return;
  }

  // 2) Otherwise fetch (or force fetch), then show
  try {
    const result = await fetchDay(currentDate, options.force);

    if (result?.error) {
      console.error("Backend error:", result.message);
      if (typeof hideLoading === 'function') hideLoading();
      if (typeof showToast === 'function') showToast('Failed to load', 'error');
      return;
    }

    await populateForm(result);
    if (typeof hideLoading === 'function') hideLoading();

    // 3) Prefetch neighbors so next/prev is fast
    prefetchAround(currentDate);
    
    // 4) Start chart data loading in background if not already loaded
    if (!chartDataCache && !chartDataLoading) {
      setTimeout(() => prefetchChartData(), 100);
    }

    dataChanged = false;
  } catch (err) {
    console.error("Load failed:", err);
    if (typeof hideLoading === 'function') hideLoading();
    if (typeof showToast === 'function') showToast('Load failed', 'error');
  }
}

async function saveData(payload) {
  try {
    const saveResult = await apiPost("save", { data: payload });

    if (saveResult?.error) {
      console.error("Save error:", saveResult.message);
      if (typeof showToast === 'function') showToast('Save failed', 'error');
      return;
    }

    console.log("💾 Saved successfully", saveResult);
    dataChanged = false;
    
    // Show success toast
    if (typeof showToast === 'function') showToast('Saved ✓', 'success');

    if ("sleepHours" in payload) {
      markSleepSaved();
    }

    // Force reload from server to get fresh data including averages
    await loadDataForCurrentDate({ force: true });

  } catch (err) {
    console.error("Save failed:", err);
    if (typeof showToast === 'function') showToast('Save failed', 'error');
  }
}

function triggerSaveSoon() {
  console.log("💾 triggerSaveSoon fired");
  dataChanged = true;

  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTimeout(async () => {
    const payload = buildPayloadFromUI();
    await saveData(payload);
  }, 800);
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
    
    // REHIT: send "2x10", "3x10", or ""
    rehit: document.getElementById("rehit2")?.checked ? "2x10" : 
           document.getElementById("rehit3")?.checked ? "3x10" : "",

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
    waterLbs: document.getElementById("water")?.value || "",

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
    carly: document.getElementById("carly")?.value || "",
    
    // Custom sections data - collect from UI first
    customSections: typeof window.collectCustomSectionsData === 'function' 
      ? window.collectCustomSectionsData() 
      : (window.customSectionData || {})
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
  // Check for old checkbox-field wrapper
  const wrapper = cb.closest(".checkbox-field");
  if (wrapper) {
    wrapper.classList.toggle("checked", cb.checked);
  }
  
  // Check for chip wrapper
  const chip = cb.closest(".chip");
  if (chip) {
    chip.classList.toggle("on", cb.checked);
  }
  
  // mini-supp doesn't need class toggle - CSS :has() handles it
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

    // initial state
    syncCheckboxVisual(cb);

    cb.addEventListener("change", () => {
      syncCheckboxVisual(cb);
      triggerSaveSoon();
    });

    // click anywhere except the input/label toggles
    wrapper.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "LABEL") return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  console.log("✅ Checkboxes wired");
}

// =====================================
// REHIT Mutual Exclusion + Fields Toggle
// =====================================
function setupRehitMutualExclusion() {
  const rehit2 = document.getElementById("rehit2");
  const rehit3 = document.getElementById("rehit3");
  const rehitFields = document.getElementById("rehitFields");
  
  if (!rehit2 || !rehit3) return;
  
  // Function to show/hide REHIT metric fields
  function toggleRehitFields() {
    if (rehitFields) {
      const showFields = rehit2.checked || rehit3.checked;
      rehitFields.style.display = showFields ? "block" : "none";
    }
  }
  
  rehit2.addEventListener("change", () => {
    if (rehit2.checked && rehit3.checked) {
      rehit3.checked = false;
      syncCheckboxVisual(rehit3);
    }
    toggleRehitFields();
  });
  
  rehit3.addEventListener("change", () => {
    if (rehit3.checked && rehit2.checked) {
      rehit2.checked = false;
      syncCheckboxVisual(rehit2);
    }
    toggleRehitFields();
  });
  
  // Initial state
  toggleRehitFields();
  
  console.log("✅ REHIT mutual exclusion wired");
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
    if (el.type === "checkbox") return; // handled separately
    
    if (el.tagName === "TEXTAREA") {
      // Textareas only save on blur to avoid interrupting typing
      el.addEventListener("blur", triggerSaveSoon);
    } else {
      el.addEventListener("change", triggerSaveSoon);
    }
  });

  console.log("✅ Input autosave wired");
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
    const systolic = parseInt(systolicEl.value);
    const diastolic = parseInt(diastolicEl.value);

    if (!systolic || !diastolic) {
      bpStatusEl.textContent = "--";
      bpStatusEl.style.color = "#52b788";
      return;
    }

    let status = "";
    let color = "#52b788"; // green

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
  const waistVal = source["Waist (in)"] ?? source["Waist"];
  const leanVal = source["Lean Mass (lbs)"] ?? source["Lean Mass"];
  const fatVal = source["Body Fat (lbs)"] ?? source["Body Fat"];
  const boneVal = source["Bone Mass (lbs)"] ?? source["Bone Mass"];
  const waterBodyVal = source["Water (lbs)"] ?? source["Water"];

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
  const form = document.getElementById("healthForm");
  if (form && typeof form.reset === "function") form.reset();

  // clear checkbox visuals
  document.querySelectorAll(".checkbox-field").forEach(w => w.classList.remove("checked"));

  // reset state
  movements = [];
  readings = [];
  honeyDos = [];
  currentAverages = null;

  const d = data?.daily || null;

  // BODY CARRY-FORWARD:
  // if daily is missing OR daily exists but body is blank => carry forward
  let bodySource = d;
  if (!hasAnyBodyData(d)) {
    bodySource = await getMostRecentBodyDaily(currentDate);
  }

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

    const reflectionsEl = document.getElementById("reflections");
    if (reflectionsEl) reflectionsEl.value = data?.reflections || "";
    const storiesEl = document.getElementById("stories");
    if (storiesEl) storiesEl.value = data?.stories || "";
    const carlyEl = document.getElementById("carly");
    if (carlyEl) carlyEl.value = data?.carly || "";

    // Apply carried-forward body values (even if no row exists)
    applyBodyFieldsFromDaily(bodySource);

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
  if (wattSecondsEl) wattSecondsEl.value = d["Watt Seconds"] ?? d["Watt-Seconds"] ?? "";

  // Checkboxes (sheet -> UI)
  setCheckbox("inhalerMorning", d["Grey's Inhaler Morning"] ?? d["Inhaler Morning"]);
  setCheckbox("inhalerEvening", d["Grey's Inhaler Evening"] ?? d["Inhaler Evening"]);
  setCheckbox("multiplication", d["5 min Multiplication"]);
  
  // REHIT: check the right one based on value
  const rehitVal = d["REHIT 2x10"] ?? d["REHIT"] ?? "";
  setCheckbox("rehit2", rehitVal === "2x10" || rehitVal === true || rehitVal === "TRUE");
  setCheckbox("rehit3", rehitVal === "3x10");
  
  // Show REHIT fields if either is checked
  const rehitFields = document.getElementById("rehitFields");
  if (rehitFields) {
    const showRehit = rehitVal === "2x10" || rehitVal === "3x10" || rehitVal === true || rehitVal === "TRUE";
    rehitFields.style.display = showRehit ? "block" : "none";
  }

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
  waterCount = parseInt(d["Water (glasses)"] ?? d["Water"], 10) || 0;
  updateWaterDisplay();

  // Body fields: use current day if present, else carry-forward source
  applyBodyFieldsFromDaily(bodySource);

  // Blood Pressure - load from current day's data
  const systolicEl = document.getElementById("systolic");
  if (systolicEl) systolicEl.value = d["Systolic"] ?? "";

  const diastolicEl = document.getElementById("diastolic");
  if (diastolicEl) diastolicEl.value = d["Diastolic"] ?? "";

  const heartRateEl = document.getElementById("heartRate");
  if (heartRateEl) heartRateEl.value = d["Heart Rate"] ?? "";

  // Trigger BP status calculation
  if (systolicEl?.value && diastolicEl?.value) {
    systolicEl.dispatchEvent(new Event("input"));
  }

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

  // Load custom sections data
  if (typeof window.loadCustomSectionsData === 'function') {
    window.loadCustomSectionsData(data?.customSections || {});
  } else {
    window.customSectionData = data?.customSections || {};
  }

  // Optional renders/averages/completion
  if (typeof updateAverages === "function") updateAverages(data?.averages);
  if (typeof renderMovements === "function") renderMovements();
  if (typeof renderReadings === "function") renderReadings();
  if (typeof renderHoneyDos === "function") renderHoneyDos();
  if (typeof checkSectionCompletion === "function") checkSectionCompletion();

  // final sweep
  document.querySelectorAll(".checkbox-field input[type='checkbox']").forEach(syncCheckboxVisual);

  console.log("✅ populateForm ran");
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

  // simple LRU-ish eviction
  if (dayCache.size > CACHE_MAX_DAYS) {
    const oldestKey = [...dayCache.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldestKey) dayCache.delete(oldestKey);
  }
}

function cacheGet(key) {
  const hit = dayCache.get(key);
  if (!hit) return null;
  // bump recency
  hit.ts = Date.now();
  return hit.value;
}

async function fetchDay(dateObj, force = false) {
  const dateStr = formatDateForAPI(dateObj);
  const cached = cacheGet(dateStr);
  if (cached && !force) return cached;

  const result = await apiGet("load", { date: dateStr });
  cacheSet(dateStr, result);
  return result;
}

function prefetchAround(dateObj) {
  // fire-and-forget prefetch
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
  // First ask for movement type
  const types = ["Walk", "Carol Bike Free Ride", "Stretch", "Stairs", "Exercise", "Other"];
  const typeChoice = prompt(`Movement type:\n1. Walk\n2. Carol Bike Free Ride\n3. Stretch\n4. Stairs\n5. Exercise\n6. Other\n\nEnter number (1-6):`);
  
  if (!typeChoice) return;
  
  const typeIndex = parseInt(typeChoice, 10) - 1;
  if (typeIndex < 0 || typeIndex >= types.length) {
    alert("Invalid choice. Please enter 1-6.");
    return;
  }
  
  // Then ask for duration
  const raw = prompt("Duration (minutes):", "10");
  if (raw === null) return;

  const durationNum = parseInt(raw, 10);
  if (!Number.isFinite(durationNum) || durationNum <= 0) {
    alert("Please enter a valid number of minutes.");
    return;
  }

  movements.push({ duration: durationNum, type: types[typeIndex] });

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

  // If you have completion logic, call it safely
  if (typeof checkSectionCompletion === "function") checkSectionCompletion();
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
  const durationRaw = prompt("Reading duration (minutes):");
  if (durationRaw === null) return;

  const duration = parseInt(durationRaw, 10);
  if (!Number.isFinite(duration) || duration <= 0) {
    alert("Please enter a valid number of minutes.");
    return;
  }

  const book = prompt("Book title:", lastBookTitle);
  if (book === null) return;

  const bookTitle = book.trim() || lastBookTitle;
  
  readings.push({ duration, book: bookTitle });
  lastBookTitle = bookTitle;

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
    const book = r.book ?? r["Book"] ?? r["book"] ?? "";

    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${duration} min — ${book}</span>
      <button type="button" class="btn btn-danger" data-idx="${idx}">×</button>
    `;

    item.querySelector("button").addEventListener("click", () => removeReading(idx));
    list.appendChild(item);
  });

  // If you have completion logic, call it safely
  if (typeof checkSectionCompletion === "function") checkSectionCompletion();
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

  // Helper function to format comparison
  const formatComparison = (current, last, decimals = 0) => {
    if (current === null || current === undefined || last === null || last === undefined) {
      return "";
    }
    const diff = current - last;
    if (Math.abs(diff) < 0.01) return " (same)";
    
    const sign = diff > 0 ? "↑" : "↓";
    const color = diff > 0 ? "#52b788" : "#e63946";
    const formatted = decimals > 0 ? diff.toFixed(decimals) : Math.round(diff);
    return ` <span style="color: ${color}">${sign} ${Math.abs(formatted)}</span>`;
  };

  // Sleep: show 2 decimals with comparison
  if (avgSleepEl) {
    const v = averages.sleep;
    const lastV = averages.lastWeek?.sleep;
    const display = (v === null || v === undefined || v === "") ? "--" : Number(v).toFixed(2);
    const comparison = formatComparison(v, lastV, 2);
    avgSleepEl.innerHTML = display + comparison;
  }

  // Steps: show whole number w/ commas with comparison
  if (avgStepsEl) {
    const v = averages.steps;
    const lastV = averages.lastWeek?.steps;
    const display = (v === null || v === undefined || v === "") ? "--" : Number(v).toLocaleString();
    const comparison = formatComparison(v, lastV, 0);
    avgStepsEl.innerHTML = display + comparison;
  }

  // Movements per day with comparison
  if (avgMovementsEl) {
    const v = averages.movements;
    const lastV = averages.lastWeek?.movements;
    const num = (v === null || v === undefined || v === "") ? null : Number(v);
    const lastNum = (lastV === null || lastV === undefined || lastV === "") ? null : Number(lastV);
    const display = (num === null || Number.isNaN(num)) ? "--" : num.toFixed(1);
    const comparison = formatComparison(num, lastNum, 1);
    avgMovementsEl.innerHTML = display + comparison;
  }

  // REHIT sessions this week with comparison
  if (rehitWeekEl) {
    const v = averages.rehitWeek;
    const lastV = averages.lastWeek?.rehitWeek;
    const display = (v === null || v === undefined || v === "") ? "--" : String(v);
    const comparison = formatComparison(v, lastV, 0);
    rehitWeekEl.innerHTML = display + comparison;
  }
}

function markSleepSaved() {
  const el = document.getElementById("sleepHours");
  if (!el) return;

  el.classList.add("saved");

  // Optional: remove after a few seconds
  setTimeout(() => {
    el.classList.remove("saved");
  }, 3000);
}
