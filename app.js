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

console.log("✅ app.js running - Worker KV", new Date().toISOString());
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
  
  if (mainPage) mainPage.style.display = "none";
  if (chartsPage) chartsPage.style.display = "none";
  if (bioPage) bioPage.style.display = "none";
  if (summaryPage) summaryPage.style.display = "block";
  
  window.scrollTo(0, 0);
  
  await loadWeeklySummary();
}

function hideWeeklySummaryPage() {
  const mainPage = document.getElementById("healthForm");
  const summaryPage = document.getElementById("weeklySummaryPage");
  
  if (summaryPage) summaryPage.style.display = "none";
  if (mainPage) mainPage.style.display = "block";
  
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
    document.getElementById("weeklyStats").innerHTML = '<div style="color: #999;">Loading data...</div>';
    chartDataCache = await fetchChartData(null, true);
  }
  
  // Now render with the data
  if (chartDataCache && chartDataCache.length > 0) {
    renderWeeklyStats(chartDataCache);
    renderStreaks(chartDataCache);
    renderWins(chartDataCache);
    renderWeekComparison(chartDataCache);
  } else {
    document.getElementById("weeklyStats").innerHTML = '<div style="color: #999;">No data available</div>';
  }
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
  
  const daysEl = document.getElementById("phaseDaysComplete");
  const barEl = document.getElementById("phaseProgressBar");
  const remainingEl = document.getElementById("phaseDaysRemaining");
  
  if (daysEl) daysEl.textContent = Math.min(daysComplete, totalDays);
  if (barEl) barEl.style.width = `${progressPercent}%`;
  if (remainingEl) {
    if (daysRemaining > 0) {
      remainingEl.textContent = `${daysRemaining} days remaining`;
    } else {
      remainingEl.textContent = "Phase complete! 🎉";
      remainingEl.style.color = "#52b788";
    }
  }
}

function renderWeeklyStats(data) {
  const statsEl = document.getElementById("weeklyStats");
  if (!statsEl) return;
  
  // Get this week's data
  const today = new Date();
  const currentDay = today.getDay();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - currentDay);
  weekStart.setHours(0, 0, 0, 0);
  
  const thisWeekData = data.filter(d => {
    const date = new Date(d.date);
    return date >= weekStart;
  });
  
  // Calculate stats
  const sleepValues = thisWeekData.map(d => parseFloat(d.daily["Hours of Sleep"])).filter(v => !isNaN(v) && v > 0);
  const stepsValues = thisWeekData.map(d => parseInt(d.daily["Steps"])).filter(v => !isNaN(v) && v > 0);
  const rehitCount = thisWeekData.filter(d => d.daily["REHIT 2x10"] && d.daily["REHIT 2x10"] !== "").length;
  
  const avgSleep = sleepValues.length ? (sleepValues.reduce((a,b) => a+b, 0) / sleepValues.length).toFixed(1) : "--";
  const avgSteps = stepsValues.length ? Math.round(stepsValues.reduce((a,b) => a+b, 0) / stepsValues.length).toLocaleString() : "--";
  const daysLogged = thisWeekData.length;
  
  statsEl.innerHTML = `
    <div style="background: #2a2a2a; padding: 16px; border-radius: 12px; text-align: center;">
      <div style="font-size: 32px; font-weight: bold; color: #a393eb;">${avgSleep}</div>
      <div style="font-size: 14px; color: #999;">Avg Sleep (hrs)</div>
    </div>
    <div style="background: #2a2a2a; padding: 16px; border-radius: 12px; text-align: center;">
      <div style="font-size: 32px; font-weight: bold; color: #4d9de0;">${avgSteps}</div>
      <div style="font-size: 14px; color: #999;">Avg Steps</div>
    </div>
    <div style="background: #2a2a2a; padding: 16px; border-radius: 12px; text-align: center;">
      <div style="font-size: 32px; font-weight: bold; color: #52b788;">${rehitCount}</div>
      <div style="font-size: 14px; color: #999;">REHIT Sessions</div>
    </div>
    <div style="background: #2a2a2a; padding: 16px; border-radius: 12px; text-align: center;">
      <div style="font-size: 32px; font-weight: bold; color: #e0e0e0;">${daysLogged}/7</div>
      <div style="font-size: 14px; color: #999;">Days Logged</div>
    </div>
  `;
}

function renderStreaks(data) {
  const streaksEl = document.getElementById("streaksDisplay");
  if (!streaksEl) return;
  
  // Calculate streaks (consecutive days with data)
  let currentStreak = 0;
  const sortedData = [...data].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  for (let i = 0; i < sortedData.length; i++) {
    const d = sortedData[i];
    const hasData = d.daily["Hours of Sleep"] || d.daily["Steps"];
    if (hasData) {
      currentStreak++;
    } else {
      break;
    }
  }
  
  // Calculate REHIT streak
  let rehitStreak = 0;
  // Count consecutive weeks with at least 2 REHIT sessions
  // (simplified for now)
  
  streaksEl.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: #2a2a2a; border-radius: 12px; margin-bottom: 8px;">
      <div style="font-size: 32px;">🔥</div>
      <div>
        <div style="font-size: 24px; font-weight: bold; color: #ff6b35;">${currentStreak} days</div>
        <div style="font-size: 14px; color: #999;">Logging streak</div>
      </div>
    </div>
  `;
}

function renderWins(data) {
  const winsEl = document.getElementById("winsDisplay");
  if (!winsEl) return;
  
  const wins = [];
  
  // Get this week's data
  const today = new Date();
  const currentDay = today.getDay();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - currentDay);
  weekStart.setHours(0, 0, 0, 0);
  
  const thisWeekData = data.filter(d => {
    const date = new Date(d.date);
    return date >= weekStart;
  });
  
  // Check for wins
  const sleepValues = thisWeekData.map(d => parseFloat(d.daily["Hours of Sleep"])).filter(v => !isNaN(v) && v > 0);
  const avgSleep = sleepValues.length ? sleepValues.reduce((a,b) => a+b, 0) / sleepValues.length : 0;
  
  if (avgSleep >= 7) wins.push("🌙 Averaged 7+ hours of sleep");
  
  const rehitCount = thisWeekData.filter(d => d.daily["REHIT 2x10"] && d.daily["REHIT 2x10"] !== "").length;
  if (rehitCount >= 3) wins.push("💪 Hit 3+ REHIT sessions");
  if (rehitCount >= 2) wins.push("🚴 Got in 2+ REHIT sessions");
  
  if (thisWeekData.length >= 5) wins.push("📝 Logged 5+ days this week");
  if (thisWeekData.length === 7) wins.push("⭐ Perfect week of logging!");
  
  const stepsValues = thisWeekData.map(d => parseInt(d.daily["Steps"])).filter(v => !isNaN(v) && v > 0);
  const avgSteps = stepsValues.length ? stepsValues.reduce((a,b) => a+b, 0) / stepsValues.length : 0;
  if (avgSteps >= 10000) wins.push("👟 Averaged 10k+ steps");
  if (avgSteps >= 7500) wins.push("🚶 Averaged 7.5k+ steps");
  
  if (wins.length === 0) {
    wins.push("Keep going! You're building great habits.");
  }
  
  winsEl.innerHTML = wins.slice(0, 4).map(w => `
    <div style="padding: 8px 0; border-bottom: 1px solid #3a3a3a;">${w}</div>
  `).join('');
}

function renderWeekComparison(data) {
  const compEl = document.getElementById("weekComparisonDisplay");
  if (!compEl) return;
  
  // Get this week and last week data
  const today = new Date();
  const currentDay = today.getDay();
  
  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(today.getDate() - currentDay);
  thisWeekStart.setHours(0, 0, 0, 0);
  
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(thisWeekStart.getDate() - 7);
  
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setDate(thisWeekStart.getDate() - 1);
  
  const thisWeekData = data.filter(d => new Date(d.date) >= thisWeekStart);
  const lastWeekData = data.filter(d => {
    const date = new Date(d.date);
    return date >= lastWeekStart && date <= lastWeekEnd;
  });
  
  // Calculate comparisons
  const thisWeekSleep = thisWeekData.map(d => parseFloat(d.daily["Hours of Sleep"])).filter(v => !isNaN(v) && v > 0);
  const lastWeekSleep = lastWeekData.map(d => parseFloat(d.daily["Hours of Sleep"])).filter(v => !isNaN(v) && v > 0);
  
  const thisAvgSleep = thisWeekSleep.length ? thisWeekSleep.reduce((a,b) => a+b, 0) / thisWeekSleep.length : null;
  const lastAvgSleep = lastWeekSleep.length ? lastWeekSleep.reduce((a,b) => a+b, 0) / lastWeekSleep.length : null;
  
  const thisWeekSteps = thisWeekData.map(d => parseInt(d.daily["Steps"])).filter(v => !isNaN(v) && v > 0);
  const lastWeekSteps = lastWeekData.map(d => parseInt(d.daily["Steps"])).filter(v => !isNaN(v) && v > 0);
  
  const thisAvgSteps = thisWeekSteps.length ? thisWeekSteps.reduce((a,b) => a+b, 0) / thisWeekSteps.length : null;
  const lastAvgSteps = lastWeekSteps.length ? lastWeekSteps.reduce((a,b) => a+b, 0) / lastWeekSteps.length : null;
  
  const formatDiff = (current, last, unit, decimals = 0) => {
    if (current === null || last === null) return '<span style="color: #999;">--</span>';
    const diff = current - last;
    const sign = diff >= 0 ? "↑" : "↓";
    const color = diff >= 0 ? "#52b788" : "#e63946";
    const formatted = decimals > 0 ? Math.abs(diff).toFixed(decimals) : Math.round(Math.abs(diff)).toLocaleString();
    return `<span style="color: ${color}">${sign} ${formatted}${unit}</span>`;
  };
  
  compEl.innerHTML = `
    <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #3a3a3a;">
      <span>Sleep</span>
      ${formatDiff(thisAvgSleep, lastAvgSleep, 'h', 1)}
    </div>
    <div style="display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #3a3a3a;">
      <span>Steps</span>
      ${formatDiff(thisAvgSteps, lastAvgSteps, '')}
    </div>
  `;
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
  
  if (mainPage) mainPage.style.display = "none";
  if (chartsPage) chartsPage.style.display = "block";
  
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
  
  if (chartsPage) chartsPage.style.display = "none";
  if (mainPage) mainPage.style.display = "block";
  
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

let weightChart, sleepChart, stepsChart, rehitChart, bodyCompChart;

function renderWeightChart(dataPoints) {
  const canvas = document.getElementById("weightChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  
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
          ticks: { color: '#999', maxRotation: 45, minRotation: 45 },
          grid: { color: '#3a3a3a' }
        },
        y: {
          type: 'linear',
          position: 'left',
          ticks: { color: '#999' },
          grid: { color: '#3a3a3a' },
          title: { display: true, text: 'Weight (lbs)', color: '#999' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          ticks: { color: '#999' },
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
          ticks: { color: '#999', maxRotation: 45, minRotation: 45 },
          grid: { color: '#3a3a3a' }
        },
        y: {
          beginAtZero: true,
          max: 12,
          ticks: { color: '#999' },
          grid: { color: '#3a3a3a' },
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
          ticks: { color: '#999', maxRotation: 45, minRotation: 45 },
          grid: { color: '#3a3a3a' }
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#999' },
          grid: { color: '#3a3a3a' },
          title: { display: true, text: 'Steps', color: '#999' }
        }
      }
    }
  });
}

function renderRehitChart(dataPoints) {
  const canvas = document.getElementById("rehitChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  
  if (rehitChart) rehitChart.destroy();
  
  const labels = dataPoints.map(d => d.date);
  const rehitData = dataPoints.map(d => {
    const val = d.daily["REHIT 2x10"];
    if (val === "2x10") return 1;
    if (val === "3x10") return 2;
    return 0;
  });
  
  rehitChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'REHIT Sessions',
        data: rehitData,
        backgroundColor: rehitData.map(v => {
          if (v === 2) return '#52b788';
          if (v === 1) return '#4d9de0';
          return '#3a3a3a';
        }),
        borderWidth: 0
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
          ticks: { color: '#999', maxRotation: 45, minRotation: 45 },
          grid: { color: '#3a3a3a' }
        },
        y: {
          beginAtZero: true,
          max: 2,
          ticks: { 
            color: '#999',
            stepSize: 1,
            callback: function(value) {
              if (value === 0) return 'None';
              if (value === 1) return '2x10';
              if (value === 2) return '3x10';
              return value;
            }
          },
          grid: { color: '#3a3a3a' }
        }
      }
    }
  });
}

function renderBodyCompositionChart(dataPoints) {
  const canvas = document.getElementById("bodyCompChart");
  if (!canvas) return;
  
  const ctx = canvas.getContext("2d");
  
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
          ticks: { color: '#999', maxRotation: 45, minRotation: 45 },
          grid: { color: '#3a3a3a' }
        },
        y: {
          ticks: { color: '#999' },
          grid: { color: '#3a3a3a' },
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
          ticks: { color: '#999', maxRotation: 45, minRotation: 45 },
          grid: { color: '#3a3a3a' }
        },
        y: {
          type: 'linear',
          position: 'left',
          ticks: { color: '#999' },
          grid: { color: '#3a3a3a' },
          title: { display: true, text: 'Blood Pressure (mmHg)', color: '#999' },
          min: 60,
          max: 160
        },
        y1: {
          type: 'linear',
          position: 'right',
          ticks: { color: '#999' },
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
  
  if (mainPage) mainPage.style.display = "none";
  if (chartsPage) chartsPage.style.display = "none";
  if (bioPage) bioPage.style.display = "block";
  
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
  const types = ["Walk", "Stretch", "Stairs", "Exercise", "Other"];
  const typeChoice = prompt(`Movement type:\n1. Walk\n2. Stretch\n3. Stairs\n4. Exercise\n5. Other\n\nEnter number (1-5):`);
  
  if (!typeChoice) return;
  
  const typeIndex = parseInt(typeChoice, 10) - 1;
  if (typeIndex < 0 || typeIndex >= types.length) {
    alert("Invalid choice");
    return;
  }
  
  const duration = prompt("Duration in minutes:", "5");
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
  
  if (bioPage) bioPage.style.display = "none";
  if (mainPage) mainPage.style.display = "block";
  
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

  // 1) If cached and not forcing, show instantly
  const cached = cacheGet(dateStr);
  if (cached && !cached?.error && !options.force) {
    await populateForm(cached);
    prefetchAround(currentDate);
    
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
      return;
    }

    await populateForm(result);

    // 3) Prefetch neighbors so next/prev is fast
    prefetchAround(currentDate);
    
    // 4) Start chart data loading in background if not already loaded
    if (!chartDataCache && !chartDataLoading) {
      setTimeout(() => prefetchChartData(), 100);
    }

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

    // Force reload from server to get fresh data including averages
    await loadDataForCurrentDate({ force: true });

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
    el.addEventListener("change", triggerSaveSoon);
    if (el.tagName === "TEXTAREA") el.addEventListener("input", triggerSaveSoon);
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
  if (wattSecondsEl) wattSecondsEl.value = d["Watt Seconds"] ?? "";

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
