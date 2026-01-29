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

console.log("✅ app.js running - Biomarkers restored", new Date().toISOString());
console.log("******* Added Waist & Blood Pressure ******");
window.__APP_JS_OK__ = true;

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

  setupDateNav();
  setupCheckboxes();
  setupRehitMutualExclusion();
  setupWaterButtons();
  setupInputAutosave();
  setupCollapsibleSections();
  setupMovementUI();
  setupReadingUI();
  setupBloodPressureCalculator();
  setupSwipeNavigation();
  setupPullToRefresh();
  setupWeeklyReminders();
  setupWeeklySummaryButton();
  setupChartsPage();
  setupBiomarkersPage();

  updateDateDisplay();
  updatePhaseInfo();
  loadDataForCurrentDate();
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
  updateWeeklySummaryButton();
  console.log("✅ Weekly summary button wired");
}

function updateWeeklySummaryButton() {
  const today = new Date(currentDate);
  const dayOfWeek = today.getDay(); // 0 = Sunday
  
  let summaryBtn = document.getElementById("weeklySummaryBtn");
  
  // Only show on Sundays
  if (dayOfWeek === 0) {
    if (!summaryBtn) {
      summaryBtn = document.createElement("button");
      summaryBtn.id = "weeklySummaryBtn";
      summaryBtn.className = "btn btn-primary";
      summaryBtn.textContent = "📊 View Week Summary";
      summaryBtn.style.marginBottom = "20px";
      summaryBtn.addEventListener("click", showWeeklySummary);
      
      const form = document.getElementById("healthForm");
      if (form) {
        form.parentNode.insertBefore(summaryBtn, form);
      }
    }
  } else {
    if (summaryBtn) summaryBtn.remove();
  }
}

async function showWeeklySummary() {
  // Calculate the week: Sunday to Saturday
  const sunday = new Date(currentDate);
  sunday.setDate(sunday.getDate() - sunday.getDay()); // Go back to Sunday
  
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);
  
  alert(`Weekly Summary\n${formatDateForAPI(sunday)} to ${formatDateForAPI(saturday)}\n\nComing soon with detailed stats!`);
  
  // TODO: Implement full weekly summary modal with charts
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
  
  // Scroll to top
  window.scrollTo(0, 0);
}

async function loadAndRenderCharts() {
  // Fetch last 30 days of data
  const days = 30;
  const dataPoints = [];
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = formatDateForAPI(date);
    
    try {
      const result = await apiGet("load", { date: dateStr });
      dataPoints.push({
        date: dateStr,
        daily: result?.daily || {},
        averages: result?.averages || {}
      });
    } catch (err) {
      console.error(`Failed to load ${dateStr}:`, err);
    }
  }
  
  // Render each chart
  renderWeightChart(dataPoints);
  renderSleepChart(dataPoints);
  renderStepsChart(dataPoints);
  renderRehitChart(dataPoints);
  renderBodyCompositionChart(dataPoints);
  renderBloodPressureChart(dataPoints);
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
  
  sleepChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Hours of Sleep',
        data: sleep,
        backgroundColor: '#a393eb',
        borderColor: '#a393eb',
        borderWidth: 1
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

async function showBiomarkersPage() {
  const mainPage = document.getElementById("healthForm");
  const chartsPage = document.getElementById("chartsPage");
  const bioPage = document.getElementById("biomarkersPage");
  
  if (mainPage) mainPage.style.display = "none";
  if (chartsPage) chartsPage.style.display = "none";
  if (bioPage) bioPage.style.display = "block";
  
  window.scrollTo(0, 0);
  
  // Load biomarkers data
  await loadBiomarkers();
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
    const result = await apiGet("biomarkers_load", {});
    
    if (result?.error) {
      alert("Error loading biomarkers: " + result.message);
      return;
    }
    
    const subtitle = document.getElementById("biomarkersSubtitle");
    if (subtitle) {
      subtitle.textContent = result.latestDate ? `Most recent: ${result.latestDate}` : "No data yet";
    }
    
    renderBiomarkersTable(result.definition || [], result.latestValues || []);
    
  } catch (err) {
    console.error("Failed to load biomarkers:", err);
    alert("Failed to load biomarkers");
  }
}

function renderBiomarkersTable(definition, latestValues) {
  const table = document.getElementById("biomarkersTable");
  if (!table) return;
  
  table.innerHTML = "";
  
  definition.forEach((item, idx) => {
    const div = document.createElement("div");
    div.style.marginBottom = "16px";
    div.innerHTML = `
      <label class="field-label">${item.biomarker} (${item.units})</label>
      <div style="font-size: 14px; color: #999; margin-bottom: 4px;">Optimal: ${item.optimal}</div>
      <input type="text" class="input-field biomarker-input" data-index="${idx}" 
             placeholder="Enter value" value="${latestValues[idx] || ''}">
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
// REHIT Mutual Exclusion
// =====================================
function setupRehitMutualExclusion() {
  const rehit2 = document.getElementById("rehit2");
  const rehit3 = document.getElementById("rehit3");
  
  if (!rehit2 || !rehit3) return;
  
  rehit2.addEventListener("change", () => {
    if (rehit2.checked && rehit3.checked) {
      rehit3.checked = false;
      syncCheckboxVisual(rehit3);
    }
  });
  
  rehit3.addEventListener("change", () => {
    if (rehit3.checked && rehit2.checked) {
      rehit2.checked = false;
      syncCheckboxVisual(rehit2);
    }
  });
  
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
