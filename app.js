/**********************************************
 * Habit Tracker - app.js (clean)
 * - Uses Cloudflare Worker proxy (no API key in browser)
 * - Loads data for selected date
 * - Populates UI (including checkbox highlighting from sheet data)
 * - Saves on changes (debounced)
 * - Date navigation prev/next
 * - Agua +/- wired
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
// Keys include: worker column names, fallback names, and buildPayloadFromUI key names
const BODY_FIELDS = [
  { id: "weight", keys: ["Weight (lbs)", "Weight", "weight"] },
  { id: "waist", keys: ["Waist (in)", "Waist", "waist"] },
  { id: "leanMass", keys: ["Lean Mass (lbs)", "Lean Mass", "leanMass"] },
  { id: "bodyFat", keys: ["Body Fat (lbs)", "Body Fat", "bodyFat"] },
  { id: "boneMass", keys: ["Bone Mass (lbs)", "Bone Mass", "boneMass"] },
  { id: "bodywater", keys: ["Water (lbs)", "bodywater", "waterLbs"] }
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
// OFFLINE SUPPORT (IndexedDB)
// =====================================
const DB_NAME = 'habits-offline';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pendingSaves')) {
        db.createObjectStore('pendingSaves', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('dayCache')) {
        db.createObjectStore('dayCache', { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueOfflineSave(payload) {
  try {
    const db = await openDB();
    const tx = db.transaction('pendingSaves', 'readwrite');
    tx.objectStore('pendingSaves').add({ payload, timestamp: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
    console.log('📴 Save queued offline');
  } catch (e) {
    console.error('Failed to queue offline save:', e);
  }
}

async function flushOfflineQueue() {
  try {
    const db = await openDB();
    const tx = db.transaction('pendingSaves', 'readonly');
    const store = tx.objectStore('pendingSaves');
    const items = await new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    db.close();

    if (items.length === 0) return;

    console.log(`🔄 Flushing ${items.length} offline saves...`);
    let flushed = 0;

    for (const item of items) {
      try {
        const result = await apiPost("save", { data: item.payload });
        if (!result?.error) {
          const db2 = await openDB();
          const tx2 = db2.transaction('pendingSaves', 'readwrite');
          tx2.objectStore('pendingSaves').delete(item.id);
          await new Promise((res, rej) => { tx2.oncomplete = res; tx2.onerror = rej; });
          db2.close();
          flushed++;
        }
      } catch (e) {
        console.warn('Offline flush failed for item, will retry later:', e);
        break;
      }
    }

    if (flushed > 0) {
      if (typeof showToast === 'function') showToast(`Synced ${flushed} offline save${flushed > 1 ? 's' : ''}`, 'success');
      // Re-save the current form state so the backend reflects what the user sees.
      // Old queued saves may have overwritten newer data on the backend.
      // Don't reload — the UI already has the correct state from the initial load.
      const currentPayload = buildPayloadFromUI();
      await saveData(currentPayload);
    }
  } catch (e) {
    console.error('Flush offline queue failed:', e);
  }
}

async function cacheDayLocally(dateStr, data) {
  try {
    const db = await openDB();
    const tx = db.transaction('dayCache', 'readwrite');
    tx.objectStore('dayCache').put({ date: dateStr, data, timestamp: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) { /* silent */ }
}

async function getCachedDay(dateStr) {
  try {
    const db = await openDB();
    const tx = db.transaction('dayCache', 'readonly');
    const result = await new Promise((res, rej) => {
      const req = tx.objectStore('dayCache').get(dateStr);
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    db.close();
    return result?.data || null;
  } catch (e) {
    return null;
  }
}

// Flush queue when coming back online
window.addEventListener('online', () => {
  console.log('🌐 Back online, flushing queue...');
  flushOfflineQueue();
});

// =====================================
// APP STATE
// =====================================
let currentDate = new Date();
let dataChanged = false;

let readings = [];
let honeyDos = [];
let currentAverages = null;
let lastBookTitle = localStorage.getItem('lastBookTitle') || "";
let aguaCount = 0;

// Track which daily goals have been celebrated today (reset on date change)
let dailyGoalsAchieved = {
  water: false,
  steps: false,
  movement: false,
  meals: false,
  cleanEating: false
};

let autoSaveTimeout = null;

const PREFETCH_RANGE = 3;          // how many days ahead/behind to prefetch
const CACHE_MAX_DAYS = 21;         // cap memory (tweak as you like)
const dayCache = new Map();        // key: "M/D/YY" -> loadResult


// =====================================
// BOOTSTRAP
// =====================================
document.addEventListener("DOMContentLoaded", async () => {
  console.log("Habit Tracker booting…");

  // Load phases early so getGoalTarget works correctly
  try { await loadPhases(); console.log("phases loaded"); } catch(e) { console.error("loadPhases failed:", e); }

  try { setupDateNav(); console.log("1 ok"); } catch(e) { console.error("setupDateNav failed:", e); }
  try { setupCheckboxes(); console.log("2 ok"); } catch(e) { console.error("setupCheckboxes failed:", e); }
  try { setupRehitMutualExclusion(); console.log("3 ok"); } catch(e) { console.error("setupRehitMutualExclusion failed:", e); }
  try { setupAguaButtons(); console.log("4 ok"); } catch(e) { console.error("setupAguaButtons failed:", e); }
  try { setupInputAutosave(); console.log("5 ok"); } catch(e) { console.error("setupInputAutosave failed:", e); }
  try { setupCollapsibleSections(); console.log("6 ok"); } catch(e) { console.error("setupCollapsibleSections failed:", e); }
  try { setupMovementUI(); console.log("7 ok"); } catch(e) { console.error("setupMovementUI failed:", e); }
  try { setupReadingUI(); console.log("8 ok"); } catch(e) { console.error("setupReadingUI failed:", e); }
  try { setupBloodPressureCalculator(); console.log("9 ok"); } catch(e) { console.error("setupBloodPressureCalculator failed:", e); }
  try { setupSwipeNavigation(); console.log("10 ok"); } catch(e) { console.error("setupSwipeNavigation failed:", e); }
  try { setupPullToRefresh(); console.log("11 ok"); } catch(e) { console.error("setupPullToRefresh failed:", e); }
  try { setupWeeklyReminders(); console.log("12 ok"); } catch(e) { console.error("setupWeeklyReminders failed:", e); }
  try { setupWeeklySummaryButton(); console.log("13 ok"); } catch(e) { console.error("setupWeeklySummaryButton failed:", e); }
  try { setupPhaseComparison(); console.log("13b ok"); } catch(e) { console.error("setupPhaseComparison failed:", e); }
  try { setupChartsPage(); console.log("14 ok"); } catch(e) { console.error("setupChartsPage failed:", e); }
  try { setupChartRangeToggle(); console.log("15 ok"); } catch(e) { console.error("setupChartRangeToggle failed:", e); }
  try { setupBiomarkersPage(); console.log("16 ok"); } catch(e) { console.error("setupBiomarkersPage failed:", e); }
  try { setupStickyHeader(); console.log("17 ok"); } catch(e) { console.error("setupStickyHeader failed:", e); }
  try { setupQuickLog(); console.log("18 ok"); } catch(e) { console.error("setupQuickLog failed:", e); }
  try { setupDopamineBoosts(); console.log("19 ok"); } catch(e) { console.error("setupDopamineBoosts failed:", e); }

  try { updateDateDisplay(); console.log("20 ok"); } catch(e) { console.error("updateDateDisplay failed:", e); }
  try { updatePhaseInfo(); console.log("21 ok"); } catch(e) { console.error("updatePhaseInfo failed:", e); }

  // IMPORTANT: await loadDataForCurrentDate so the form is fully populated
  // before flushOfflineQueue runs — otherwise buildPayloadFromUI reads
  // unchecked checkboxes and saves stale data to the backend/cache.
  try { await loadDataForCurrentDate(); console.log("22 ok"); } catch(e) { console.error("loadDataForCurrentDate failed:", e); }

  // Lock past days to prevent accidental edits
  try { updateDayLock(); } catch(e) { console.error("updateDayLock failed:", e); }

  // Re-check weigh-in reminder now that weight field is populated with loaded data
  try { updateWeighReminder(); } catch(e) { console.error("updateWeighReminder post-load failed:", e); }

  // Flush any queued offline saves AFTER the form is populated
  if (navigator.onLine) {
    flushOfflineQueue().catch(e => console.warn('Offline flush on boot failed:', e));
  }
});

function updatePhaseInfo() {
  const phase = getCurrentPhase();
  if (!phase) {
    // Fallback if phases haven't loaded yet
    const phaseInfoEl = document.getElementById("phaseInfo");
    if (phaseInfoEl) phaseInfoEl.textContent = "Loading...";
    return;
  }

  const phaseStart = parseDataDate(phase.start);
  const cur = new Date(currentDate);
  cur.setHours(0, 0, 0, 0);

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceStart = Math.floor((cur - phaseStart) / msPerDay);
  const dayInPhase = Math.max(1, Math.min(phase.length, daysSinceStart + 1));

  const phaseInfoEl = document.getElementById("phaseInfo");
  if (phaseInfoEl) phaseInfoEl.textContent = `Day ${dayInPhase} of ${phase.length}`;

  // Update subtitle with phase name
  const subtitleEl = document.querySelector(".subtitle");
  if (subtitleEl) subtitleEl.textContent = phase.name;

  // Progress bar width
  const bar = document.getElementById("phaseProgressBar");
  if (bar) {
    const progress = (dayInPhase - 1) / phase.length;
    bar.style.width = `${Math.round(progress * 100)}%`;
  }

  // Check if we need to prompt for new phase
  checkPhaseTransition();
}

// Check if phase is ending soon and prompt for new phase setup
function checkPhaseTransition() {
  const upcoming = getUpcomingPhaseNeeded();
  if (upcoming) {
    showPhaseTransitionBanner(upcoming);
  } else {
    hidePhaseTransitionBanner();
  }
}

function showPhaseTransitionBanner(upcoming) {
  let banner = document.getElementById('phaseTransitionBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'phaseTransitionBanner';
    banner.className = 'phase-transition-banner';
    document.body.appendChild(banner);
  }

  const daysText = upcoming.daysRemaining === 1 ? '1 day' : `${upcoming.daysRemaining} days`;
  banner.innerHTML = `
    <div class="phase-banner-content">
      <span>${upcoming.currentPhase.name} ends in ${daysText}!</span>
      <button onclick="openNewPhaseModal()">Plan Phase ${upcoming.nextPhaseId}</button>
    </div>
  `;
  banner.style.display = 'block';
}

function hidePhaseTransitionBanner() {
  const banner = document.getElementById('phaseTransitionBanner');
  if (banner) banner.style.display = 'none';
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
  // Flush any pending autosave for the current date before switching
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = null;
    const payload = buildPayloadFromUI();
    saveData(payload);
  }

  currentDate.setDate(currentDate.getDate() + days);
  updateDateDisplay();
  updatePhaseInfo?.(); // if you have it

  // show instantly if cached, else it will fetch
  loadDataForCurrentDate();
  updateWeighReminder();
  updateWeeklySummaryButton();
  updateDayLock();
}

// =====================================
// DAY LOCK - Prevent accidental edits on past days
// =====================================
let dayUnlocked = false;

function isPastDay() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const viewing = new Date(currentDate);
  viewing.setHours(0, 0, 0, 0);
  return viewing < today;
}

function updateDayLock() {
  const body = document.body;
  if (isPastDay() && !dayUnlocked) {
    body.classList.add('day-locked');
  } else {
    body.classList.remove('day-locked');
  }
}

window.unlockDay = function() {
  dayUnlocked = true;
  document.body.classList.remove('day-locked');
  // Reset unlock flag when navigating away
  setTimeout(() => { dayUnlocked = false; }, 100);
};

// Migration: Convert legacy movements to morning/afternoon format
window.migrateMovements = async function() {
  try {
    const result = await apiPost('migrate_movements');
    console.log('Migration complete:', result);
    alert(`Migration complete!\n\nMigrated: ${result.migrated} days\nSkipped: ${result.skipped} days\nErrors: ${result.errors?.length || 0}\n\nCheck console for details.`);
    if (result.details && result.details.length > 0) {
      console.table(result.details);
    }
    if (result.errors && result.errors.length > 0) {
      console.warn('Migration errors:', result.errors);
    }
    return result;
  } catch (err) {
    console.error('Migration failed:', err);
    alert('Migration failed: ' + err.message);
    throw err;
  }
};

// Data Audit: Scan all historical data for inconsistencies
window.auditData = async function() {
  try {
    console.log('Starting data audit...');
    const audit = await apiPost('audit_data');

    // Check for error response
    if (audit.error) {
      console.error('Audit error:', audit.message);
      alert('Audit failed: ' + audit.message);
      return;
    }

    // Debug: log raw response if structure seems wrong
    if (!audit.dateRange) {
      console.log('Raw audit response:', audit);
      alert('Audit returned unexpected data. Check console.');
      return audit;
    }

    // Print summary
    console.log('\n========== DATA AUDIT REPORT ==========\n');
    console.log(`Total days with data: ${audit.totalDays}`);
    console.log(`Date range: ${audit.dateRange?.earliest || 'none'} to ${audit.dateRange?.latest || 'none'}`);

    // Issues summary
    if (audit.issues.length > 0) {
      console.log(`\n⚠️  ISSUES FOUND: ${audit.issues.length}`);
      console.table(audit.issues.map(i => ({
        Type: i.type,
        Habit: i.habit || '-',
        Message: i.message,
        'Days Affected': i.daysAffected || '-'
      })));
    } else {
      console.log('\n✅ No issues found!');
    }

    // Habits summary
    console.log('\n📊 HABITS SUMMARY:');
    const habitsSummary = Object.entries(audit.habits).map(([key, h]) => ({
      Habit: key,
      Description: h.description,
      'Days With Data': h.daysWithData,
      'Days Without': h.daysWithoutData,
      'Coverage %': audit.totalDays > 0 ? Math.round(h.daysWithData / audit.totalDays * 100) + '%' : '0%',
      'Unique Values': Object.keys(h.uniqueValues).length,
      'Value Types': Object.keys(h.valueTypes).join(', ') || 'none'
    }));
    console.table(habitsSummary);

    // Detailed value breakdown for each habit
    console.log('\n📋 DETAILED VALUE BREAKDOWN:');
    Object.entries(audit.habits).forEach(([key, h]) => {
      if (h.daysWithData > 0) {
        console.log(`\n${h.description} (${key}):`);
        const valueRows = Object.entries(h.uniqueValues).map(([val, info]) => ({
          Value: val.length > 50 ? val.substring(0, 50) + '...' : val,
          Count: info.count,
          Type: info.type,
          'Sample Dates': info.sampleDates.join(', ')
        }));
        console.table(valueRows);
      }
    });

    // Readings array info
    if (audit.readingsArray.daysWithReadings > 0) {
      console.log('\n📖 READINGS ARRAY:');
      console.log(`  Days with readings: ${audit.readingsArray.daysWithReadings}`);
      console.log(`  Total reading entries: ${audit.readingsArray.totalEntries}`);
      console.log(`  Unique books: ${audit.readingsArray.uniqueBooks.length}`);
      console.log(`  Books: ${audit.readingsArray.uniqueBooks.join(', ')}`);
      console.log(`  Duration field formats:`, audit.readingsArray.durationFormats);
      if (audit.readingsArray.samples.length > 0) {
        console.log('  Samples:', audit.readingsArray.samples);
      }
    }

    // Movements array info
    if (audit.movementsArray.daysWithMovements > 0) {
      console.log('\n🚶 MOVEMENTS ARRAY:');
      console.log(`  Days with movements: ${audit.movementsArray.daysWithMovements}`);
      console.log(`  Total movement entries: ${audit.movementsArray.totalEntries}`);
      console.log(`  Movement types:`, audit.movementsArray.movementTypes);
      console.log(`  Duration formats:`, audit.movementsArray.durationFormats);
      if (audit.movementsArray.samples.length > 0) {
        console.log('  Samples:', audit.movementsArray.samples);
      }
    }

    console.log('\n========== END AUDIT REPORT ==========\n');

    // Show alert summary
    const issueCount = audit.issues.length;
    alert(`Data Audit Complete!\n\n` +
      `📅 ${audit.totalDays} days of data\n` +
      `📆 ${audit.dateRange.earliest} to ${audit.dateRange.latest}\n` +
      `${issueCount > 0 ? `⚠️ ${issueCount} issues found` : '✅ No issues found'}\n\n` +
      `Check console for detailed report.`);

    return audit;
  } catch (err) {
    console.error('Audit failed:', err);
    alert('Audit failed: ' + err.message);
    throw err;
  }
};

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
    
    if (pullDistance > 150 && window.scrollY === 0) {
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

  // Auto-dismiss weigh-in banner when a NEW weight is entered on Monday
  const weightEl = document.getElementById("weight");
  if (weightEl) {
    weightEl.addEventListener("input", () => {
      const val = parseFloat(weightEl.value);
      const carried = parseFloat(window._loadedWeight || 0);
      if (val > 0 && val !== carried) {
        const dateStr = formatDateForAPI(currentDate);
        sessionStorage.setItem("weighReminderDismissed", dateStr);
        hideWeighReminder();
      }
    });
  }

  // Movement reminders are scheduled later, after data loads
  // (see loadDataForCurrentDate completion in DOMContentLoaded)

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

  // Don't show if user already dismissed it this session
  const dateStr = formatDateForAPI(currentDate);
  if (sessionStorage.getItem("weighReminderDismissed") === dateStr) {
    hideWeighReminder();
    return;
  }

  // Don't show if user has entered a NEW weight (different from carry-forward)
  const weightEl = document.getElementById("weight");
  const currentWeight = parseFloat(weightEl?.value || 0);
  const carriedWeight = parseFloat(window._loadedWeight || 0);
  if (currentWeight > 0 && currentWeight !== carriedWeight) {
    hideWeighReminder();
    return;
  }

  showWeighReminder();
}

function showWeighReminder() {
  let card = document.getElementById("weighReminder");
  if (!card) {
    card = document.createElement("div");
    card.id = "weighReminder";
    card.className = "reminder-card";
    card.innerHTML = `
      <button class="reminder-close" onclick="sessionStorage.setItem('weighReminderDismissed', '${formatDateForAPI(currentDate)}'); document.getElementById('weighReminder').remove()">✕</button>
      <div class="reminder-icon">⚖️</div>
      <div class="reminder-title">Weigh-in Monday!</div>
      <div class="reminder-sub">Don't forget to log your body measurements.</div>
    `;

    const header = document.querySelector(".header");
    if (header) {
      header.parentNode.insertBefore(card, header.nextSibling);
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
      if (range === 'all') {
        currentSummaryPhaseId = null;
        // Hide phase selector for All Time view
        const selector = document.getElementById('phaseSelector');
        if (selector) selector.style.display = 'none';
      } else {
        // Show phase selector for phase view
        const selector = document.getElementById('phaseSelector');
        if (selector) selector.style.display = 'block';
        currentSummaryPhaseId = parseInt(selector?.value) || getCurrentPhase()?.id;
      }

      if (chartDataCache && chartDataCache.length > 0) {
        renderSummaryPage(chartDataCache, range === 'all' ? 'all' : 'phase');
      }
    });
  });

  // Setup phase selector
  const phaseSelector = document.getElementById('phaseSelector');
  if (phaseSelector) {
    phaseSelector.addEventListener('change', () => {
      currentSummaryPhaseId = parseInt(phaseSelector.value);
      if (chartDataCache && chartDataCache.length > 0) {
        renderSummaryPage(chartDataCache, 'phase');
      }
    });
  }

  console.log("✅ Weekly summary wired");
}

// Populate the phase selector dropdown
function populatePhaseSelector() {
  const selector = document.getElementById('phaseSelector');
  if (!selector || !phasesData.length) return;

  const currentPhase = getCurrentPhase();
  selector.innerHTML = phasesData.map(p =>
    `<option value="${p.id}" ${p.id === currentPhase?.id ? 'selected' : ''}>${p.name}</option>`
  ).join('');

  currentSummaryPhaseId = currentPhase?.id;
}

// Setup phase comparison feature
function setupPhaseComparison() {
  const compareBtn = document.getElementById('comparePhaseBtn');
  const closeBtn = document.getElementById('closeComparisonBtn');
  const section = document.getElementById('phaseComparisonSection');
  const select1 = document.getElementById('comparePhase1');
  const select2 = document.getElementById('comparePhase2');

  if (compareBtn) {
    compareBtn.addEventListener('click', () => {
      if (phasesData.length < 2) {
        showToast('Need at least 2 phases to compare');
        return;
      }
      populateComparisonSelectors();
      section.style.display = 'block';
      renderPhaseComparison();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      section.style.display = 'none';
    });
  }

  if (select1) {
    select1.addEventListener('change', renderPhaseComparison);
  }
  if (select2) {
    select2.addEventListener('change', renderPhaseComparison);
  }
}

function populateComparisonSelectors() {
  const select1 = document.getElementById('comparePhase1');
  const select2 = document.getElementById('comparePhase2');
  if (!select1 || !select2 || !phasesData.length) return;

  const options = phasesData.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  select1.innerHTML = options;
  select2.innerHTML = options;

  // Default: compare previous phase to current phase
  if (phasesData.length >= 2) {
    select1.value = phasesData[phasesData.length - 2].id; // Previous
    select2.value = phasesData[phasesData.length - 1].id; // Current
  }
}

function renderPhaseComparison() {
  const container = document.getElementById('phaseComparisonContent');
  const phase1Id = parseInt(document.getElementById('comparePhase1')?.value);
  const phase2Id = parseInt(document.getElementById('comparePhase2')?.value);

  if (!container || !phase1Id || !phase2Id) return;

  const phase1 = getPhaseById(phase1Id);
  const phase2 = getPhaseById(phase2Id);

  if (!phase1 || !phase2 || !chartDataCache) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted)">No data available</div>';
    return;
  }

  // Get filtered data and stats for each phase
  const data1 = getFilteredData(chartDataCache, 'phase', phase1Id);
  const data2 = getFilteredData(chartDataCache, 'phase', phase2Id);
  const stats1 = calculateGoalStats(data1, 'phase', phase1Id);
  const stats2 = calculateGoalStats(data2, 'phase', phase2Id);

  // Build comparison rows
  const goals = [
    { key: 'sleep', name: 'Sleep', icon: '🌙' },
    { key: 'agua', name: 'Water', icon: '💧' },
    { key: 'steps', name: 'Steps', icon: '👟' },
    { key: 'rehit', name: 'REHIT', icon: '🚴' },
    { key: 'movement', name: 'Movement', icon: '🚶' },
    { key: 'reading', name: 'Reading', icon: '📖' },
    { key: 'meals', name: 'Meals', icon: '🍽️' },
    { key: 'supps', name: 'Supplements', icon: '💊' },
    { key: 'noAlcohol', name: 'No Alcohol', icon: '🚫🍺' }
  ];

  let html = `
    <div class="comparison-grid">
      <div class="comparison-row header">
        <div>Goal</div>
        <div style="text-align:center">${phase1.name}</div>
        <div style="text-align:center">${phase2.name}</div>
        <div style="text-align:center">Change</div>
      </div>
  `;

  goals.forEach(goal => {
    const s1 = stats1[goal.key];
    const s2 = stats2[goal.key];
    if (!s1 || !s2) return;

    const pct1 = s1.pct || 0;
    const pct2 = s2.pct || 0;
    const diff = pct2 - pct1;

    let changeClass = 'neutral';
    let changeText = '—';
    if (diff > 0) {
      changeClass = 'positive';
      changeText = `+${diff}%`;
    } else if (diff < 0) {
      changeClass = 'negative';
      changeText = `${diff}%`;
    }

    // Show target changes if different
    const target1 = phase1.goals?.[goal.key]?.target;
    const target2 = phase2.goals?.[goal.key]?.target;
    const targetChanged = target1 !== target2 && target1 !== undefined && target2 !== undefined;
    const targetNote = targetChanged ? `<div class="comparison-goal-target">Target: ${target1} → ${target2}</div>` : '';

    html += `
      <div class="comparison-row">
        <div>
          <span class="comparison-goal-name">${goal.icon} ${goal.name}</span>
          ${targetNote}
        </div>
        <div class="comparison-value">${pct1}%</div>
        <div class="comparison-value">${pct2}%</div>
        <div class="comparison-change ${changeClass}">${changeText}</div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

// Render phase goals for the selected phase
function renderPhaseGoals(phaseId = null) {
  const container = document.getElementById('phaseGoalsContent');
  const section = document.getElementById('phaseGoalsSection');
  if (!container) return;

  const phase = phaseId ? getPhaseById(phaseId) : getCurrentPhase();
  if (!phase || !phase.goals) {
    if (section) section.style.display = 'none';
    return;
  }

  if (section) section.style.display = 'block';

  const goalConfig = [
    { key: 'sleep', name: 'Sleep', icon: '🌙', format: (t) => `${t}+ hrs/night` },
    { key: 'agua', name: 'Water', icon: '💧', format: (t) => `${t}+ glasses/day` },
    { key: 'steps', name: 'Steps', icon: '👟', format: (t) => `${t.toLocaleString()}+/day` },
    { key: 'rehit', name: 'REHIT', icon: '🚴', format: (t) => `${t}x/week` },
    { key: 'movement', name: 'Movement', icon: '🚶', format: (t) => `${t}+ breaks/day` },
    { key: 'reading', name: 'Reading', icon: '📖', format: (t) => `${t}+ min/week` },
    { key: 'meals', name: 'Meals', icon: '🍽️', format: (t) => `${t}+ healthy/day` },
    { key: 'supps', name: 'Supplements', icon: '💊', format: (t) => `All ${t} daily` },
    { key: 'noAlcohol', name: 'No Alcohol', icon: '🚫🍺', format: (t) => t ? 'Daily' : 'Not tracked' },
    { key: 'meditation', name: 'Meditation', icon: '🧘', format: (t) => t ? 'Daily' : 'Not tracked' },
    { key: 'snacks', name: 'Healthy Snacks', icon: '🥗', format: (t) => `${t}x/day` }
  ];

  let html = '';
  goalConfig.forEach(g => {
    const goal = phase.goals[g.key];
    if (!goal) return;

    const targetDisplay = g.format(goal.target);
    html += `
      <div class="phase-goal-card">
        <span class="goal-icon">${g.icon}</span>
        <div class="goal-details">
          <div class="goal-name">${g.name}</div>
          <div class="goal-target">${targetDisplay}</div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html || '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted)">No goals defined</div>';
}

// Toggle phase goals visibility
function togglePhaseGoals() {
  const content = document.getElementById('phaseGoalsContent');
  const toggle = document.getElementById('phaseGoalsToggle');
  if (!content || !toggle) return;

  const isHidden = content.style.display === 'none';
  content.style.display = isHidden ? 'grid' : 'none';
  toggle.textContent = isHidden ? '▼' : '▶';
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

  // Populate phase selector dropdown
  populatePhaseSelector();

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
  
  // Load phase progress
  loadPhaseProgress();
  
  // If chart data not cached, fetch it now
  if (!chartDataCache || chartDataCache.length === 0) {
    document.getElementById("summaryOverview").innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">Loading data...</div>';
    chartDataCache = await fetchChartData(null, true);
  }
  
  // Now render with the data
  if (chartDataCache && chartDataCache.length > 0) {
    renderSummaryPage(chartDataCache, 'phase');
  } else {
    document.getElementById("summaryOverview").innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">No data available</div>';
  }
}

// Summary page state
let currentSummaryRange = 'phase';
let currentSummaryPhaseId = null; // Which phase to show in summary

// Legacy fallback constants (used if phases haven't loaded yet)
const PHASE_START = new Date("2026-01-19");
const PHASE_LENGTH = 21;

// Default Phase 1 configuration (always available as fallback)
const DEFAULT_PHASE_1 = {
  id: 1,
  name: "Phase 1",
  start: "1/19/26",
  length: 21,
  goals: {
    sleep: { target: 7, unit: "hrs", type: "daily", description: "Hours of sleep" },
    agua: { target: 6, unit: "glasses", type: "daily", description: "Glasses of water" },
    steps: { target: 5000, unit: "steps", type: "daily", description: "Daily steps" },
    rehit: { target: 3, unit: "sessions", type: "weekly", description: "REHIT sessions per week" },
    reading: { target: 60, unit: "min", type: "weekly", description: "Reading minutes per week" },
    movement: { target: 2, unit: "breaks", type: "daily", description: "Movement breaks" },
    meals: { target: 2, unit: "meals", type: "daily", description: "Healthy meals" },
    supps: { target: 4, unit: "supps", type: "daily", description: "All 4 supplements" },
    noAlcohol: { target: true, unit: "bool", type: "daily", description: "No alcohol" },
    meditation: { target: true, unit: "bool", type: "daily", description: "Daily meditation" },
    snacks: { target: 2, unit: "checks", type: "daily", description: "Healthy snacks (day + night)" }
  }
};

// Phases system - initialized with Phase 1 so UI works immediately
let phasesData = [DEFAULT_PHASE_1];

// Load phases from API (falls back to DEFAULT_PHASE_1 already in phasesData)
async function loadPhases() {
  try {
    const resp = await fetch(`${API_URL}?action=phases_load`);
    const data = await resp.json();
    if (data.phases && Array.isArray(data.phases) && data.phases.length > 0) {
      phasesData = data.phases;
      console.log('Loaded phases from API:', phasesData.length);
    } else {
      console.log('Using default Phase 1 (API returned empty)');
    }
  } catch (err) {
    console.error('Failed to load phases from API, using default Phase 1:', err);
  }
}

// Save phases to API
async function savePhases() {
  try {
    const resp = await fetch(`${API_URL}?action=phases_save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phases: phasesData })
    });
    const data = await resp.json();
    return data.success;
  } catch (err) {
    console.error('Failed to save phases:', err);
    return false;
  }
}

// Get current phase based on a date (defaults to today)
function getCurrentPhase(forDate = new Date()) {
  if (!phasesData.length) return null;

  const checkDate = new Date(forDate);
  checkDate.setHours(0, 0, 0, 0);

  // Find which phase this date falls into
  for (let i = phasesData.length - 1; i >= 0; i--) {
    const phase = phasesData[i];
    const phaseStart = parseDataDate(phase.start);
    const phaseEnd = new Date(phaseStart);
    phaseEnd.setDate(phaseStart.getDate() + phase.length - 1);

    if (checkDate >= phaseStart && checkDate <= phaseEnd) {
      return phase;
    }
  }

  // If date is after all phases, return the last phase
  const lastPhase = phasesData[phasesData.length - 1];
  const lastPhaseStart = parseDataDate(lastPhase.start);
  if (checkDate > lastPhaseStart) {
    return lastPhase;
  }

  // If date is before all phases, return the first phase
  return phasesData[0];
}

// Get a phase by ID
function getPhaseById(id) {
  return phasesData.find(p => p.id === id) || null;
}

// Get the next phase that needs to be created (if current phase is ending soon)
function getUpcomingPhaseNeeded() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const currentPhase = getCurrentPhase();
  if (!currentPhase) return null;

  const phaseStart = parseDataDate(currentPhase.start);
  const phaseEnd = new Date(phaseStart);
  phaseEnd.setDate(phaseStart.getDate() + currentPhase.length - 1);

  const daysRemaining = Math.ceil((phaseEnd - today) / (1000 * 60 * 60 * 24));

  // Check if next phase already exists
  const nextPhaseId = currentPhase.id + 1;
  const nextPhaseExists = phasesData.some(p => p.id === nextPhaseId);

  // If 3 or fewer days remaining and next phase doesn't exist, prompt for new phase
  if (daysRemaining <= 3 && !nextPhaseExists) {
    return {
      nextPhaseId,
      daysRemaining,
      currentPhase
    };
  }

  return null;
}

// Open modal to create a new phase
async function openNewPhaseModal(fromPhaseId = null) {
  const currentPhase = fromPhaseId ? getPhaseById(fromPhaseId) : getCurrentPhase();
  if (!currentPhase) return;

  const nextPhaseId = currentPhase.id + 1;
  const phaseStart = parseDataDate(currentPhase.start);
  const nextStart = new Date(phaseStart);
  nextStart.setDate(phaseStart.getDate() + currentPhase.length);
  const nextStartStr = `${nextStart.getMonth() + 1}/${nextStart.getDate()}/${String(nextStart.getFullYear()).slice(-2)}`;

  // Ensure chart data is loaded before calculating stats
  if (!chartDataCache || chartDataCache.length === 0) {
    console.log('Phase modal: Loading chart data...');
    chartDataCache = await fetchChartData(null, true);
  }

  // Calculate current phase stats for each goal
  const filteredData = chartDataCache ? getFilteredData(chartDataCache, 'phase', currentPhase.id) : [];
  const stats = filteredData.length > 0 ? calculateGoalStats(filteredData, 'phase', currentPhase.id) : {};

  console.log('Phase modal - filteredData length:', filteredData.length, 'stats keys:', Object.keys(stats));

  // Build phase performance review HTML
  let performanceHtml = '<div class="phase-performance-review">';
  performanceHtml += `<h3 style="margin:0 0 16px;font-size:15px;color:var(--text);">${currentPhase.name} Performance</h3>`;

  // Show message if no data
  if (filteredData.length === 0) {
    performanceHtml += `<p style="color:var(--text-muted);font-size:13px;margin:0;">No tracking data available for this phase yet.</p>`;
  }

  // Sleep stats
  if (stats.sleep) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Sleep</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.sleep.daysMet}/${stats.sleep.totalDays}</span> days achieved goal
          <span class="stat-pct">(${stats.sleep.pct}%)</span>
          <br><span class="stat-avg">Avg: ${stats.sleep.avg} hrs/night</span>
        </div>
      </div>`;
  }

  // Water stats
  if (stats.agua) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Water</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.agua.daysMet}/${stats.agua.totalDays}</span> days achieved goal
          <span class="stat-pct">(${stats.agua.pct}%)</span>
          <br><span class="stat-avg">Avg: ${stats.agua.avg} glasses/day</span>
        </div>
      </div>`;
  }

  // Steps stats
  if (stats.steps) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Steps</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.steps.daysMet}/${stats.steps.totalDays}</span> days achieved goal
          <span class="stat-pct">(${stats.steps.pct}%)</span>
          <br><span class="stat-avg">Avg: ${stats.steps.avg.toLocaleString()} steps/day</span>
        </div>
      </div>`;
  }

  // REHIT stats
  if (stats.rehit) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">REHIT</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.rehit.weeksMet}/${stats.rehit.totalWeeks}</span> weeks achieved goal
          <span class="stat-pct">(${stats.rehit.pct}%)</span>
          <br><span class="stat-avg">2x10: ${stats.rehit.total2x10} sessions (${stats.rehit.avg2x10}/wk)</span>
          <br><span class="stat-avg">3x10: ${stats.rehit.total3x10} sessions (${stats.rehit.avg3x10}/wk)</span>
        </div>
      </div>`;
  }

  // Reading stats
  if (stats.reading) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Reading</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.reading.weeksMet}/${stats.reading.totalWeeks}</span> weeks achieved goal
          <br><span class="stat-avg">Total: ${stats.reading.total} min | Avg: ${stats.reading.avg} min/week</span>
        </div>
      </div>`;
  }

  // Movement stats
  if (stats.movement) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Movement</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.movement.daysMet}/${stats.movement.totalDays}</span> days achieved goal
          <span class="stat-pct">(${stats.movement.pct}%)</span>
          <br><span class="stat-avg">Avg: ${stats.movement.avg} breaks/day</span>
        </div>
      </div>`;
  }

  // Meals stats
  if (stats.meals) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Healthy Meals</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.meals.daysMet}/${stats.meals.totalDays}</span> days achieved goal
          <span class="stat-pct">(${stats.meals.pct}%)</span>
        </div>
      </div>`;
  }

  // Meditation stats
  if (stats.meditation) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Meditation</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.meditation.daysMet}/${stats.meditation.totalDays}</span> days achieved goal
          <span class="stat-pct">(${stats.meditation.pct}%)</span>
        </div>
      </div>`;
  }

  // Snacks stats
  if (stats.snacks) {
    performanceHtml += `
      <div class="phase-stat-row">
        <div class="phase-stat-label">Healthy Snacks</div>
        <div class="phase-stat-details">
          <span class="stat-highlight">${stats.snacks.daysMet}/${stats.snacks.totalDays}</span> days achieved goal
          <span class="stat-pct">(${stats.snacks.pct}%)</span>
        </div>
      </div>`;
  }

  performanceHtml += '</div>';

  // Build goals input HTML
  let goalsHtml = '';
  const goalKeys = Object.keys(currentPhase.goals || {});

  goalKeys.forEach(key => {
    const goal = currentPhase.goals[key];
    const stat = stats[key];
    const currentTarget = goal.target;
    const pct = stat?.pct || 0;

    // Smart suggestion logic
    let suggestion = currentTarget;
    let suggestionText = '';
    if (typeof currentTarget === 'number') {
      if (pct >= 90) {
        suggestion = key === 'steps' ? currentTarget + 500 : currentTarget + 1;
        suggestionText = `<span class="suggestion-good">Great job at ${pct}%! Consider increasing.</span>`;
      } else if (pct >= 70) {
        suggestionText = `<span class="suggestion-ok">Good progress at ${pct}%. Keep building.</span>`;
      } else if (pct > 0) {
        suggestionText = `<span class="suggestion-work">At ${pct}%. Stay here or adjust down.</span>`;
      }
    }

    const inputType = typeof currentTarget === 'boolean' ? 'checkbox' : 'number';
    const inputValue = typeof currentTarget === 'boolean'
      ? (currentTarget ? 'checked' : '')
      : `value="${suggestion}"`;

    goalsHtml += `
      <div class="phase-goal-row">
        <div class="phase-goal-info">
          <span class="phase-goal-name">${goal.description || key}</span>
          <span class="phase-goal-current">Current: ${currentTarget}${goal.unit !== 'bool' ? ' ' + goal.unit : ''}</span>
          ${suggestionText}
        </div>
        <div class="phase-goal-input">
          ${inputType === 'checkbox'
            ? `<input type="checkbox" id="newPhaseGoal_${key}" ${inputValue}>`
            : `<input type="number" id="newPhaseGoal_${key}" ${inputValue} min="0" step="${key === 'steps' ? 500 : 1}">`
          }
          ${goal.unit !== 'bool' ? `<span class="phase-goal-unit">${goal.unit}</span>` : ''}
        </div>
      </div>
    `;
  });

  // Create modal
  let modal = document.getElementById('newPhaseModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'newPhaseModal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal-content phase-modal">
      <div class="modal-header">
        <h2>Plan Phase ${nextPhaseId}</h2>
        <button class="modal-close" onclick="closeNewPhaseModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="phase-modal-info">
          <p>Review your ${currentPhase.name} performance and set goals for Phase ${nextPhaseId}.</p>
          <p class="phase-dates">Starts: ${nextStartStr} (${currentPhase.length} days)</p>
        </div>
        ${performanceHtml}
        <h3 style="margin:20px 0 12px;font-size:15px;color:var(--text);">Set Phase ${nextPhaseId} Goals</h3>
        <div class="phase-goals-list">
          ${goalsHtml}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="closeNewPhaseModal()">Cancel</button>
        <button class="btn-primary" onclick="saveNewPhase(${nextPhaseId}, '${nextStartStr}', ${currentPhase.length})">Create Phase ${nextPhaseId}</button>
      </div>
    </div>
  `;

  modal.style.display = 'flex';
}

function closeNewPhaseModal() {
  const modal = document.getElementById('newPhaseModal');
  if (modal) modal.style.display = 'none';
}

async function saveNewPhase(phaseId, startDate, length) {
  const currentPhase = getCurrentPhase();
  if (!currentPhase) return;

  // Build new phase goals from form inputs
  const newGoals = {};
  const goalKeys = Object.keys(currentPhase.goals || {});

  goalKeys.forEach(key => {
    const input = document.getElementById(`newPhaseGoal_${key}`);
    const currentGoal = currentPhase.goals[key];

    if (input) {
      let target;
      if (input.type === 'checkbox') {
        target = input.checked;
      } else {
        target = parseFloat(input.value) || currentGoal.target;
      }

      newGoals[key] = {
        ...currentGoal,
        target
      };
    } else {
      newGoals[key] = { ...currentGoal };
    }
  });

  // Create new phase object
  const newPhase = {
    id: phaseId,
    name: `Phase ${phaseId}`,
    start: startDate,
    length: length,
    goals: newGoals
  };

  // Add to phases and save
  phasesData.push(newPhase);
  const success = await savePhases();

  if (success) {
    closeNewPhaseModal();
    hidePhaseTransitionBanner();
    updatePhaseInfo();
    showToast(`Phase ${phaseId} created!`);
  } else {
    showToast('Failed to save phase. Please try again.');
    // Remove the phase we just added since save failed
    phasesData.pop();
  }
}

// Goals configuration
// Goal targets — now reads from current phase goals first
function getGoalTarget(key, phaseId = null) {
  // If specific phase requested, use that phase's goals
  const phase = phaseId ? getPhaseById(phaseId) : getCurrentPhase();
  if (phase && phase.goals && phase.goals[key]) {
    return phase.goals[key].target;
  }

  // Fallback to appSettings
  if (typeof appSettings !== 'undefined') {
    if (key === 'sleep' && appSettings.sleepGoal) return appSettings.sleepGoal;
    if (key === 'agua' && appSettings.aguaGoal) return appSettings.aguaGoal;
    if (key === 'steps' && appSettings.stepsGoal) return appSettings.stepsGoal;
    if (key === 'movement' && appSettings.movementGoal) return appSettings.movementGoal;
    if (key === 'meals' && appSettings.mealsGoal) return appSettings.mealsGoal;
    if (key === 'rehit' && appSettings.rehitGoal) return appSettings.rehitGoal;
    if (key === 'reading' && appSettings.readingGoal) return appSettings.readingGoal;
    if (key === 'meditation' && appSettings.meditationGoal) return appSettings.meditationGoal;
  }
  return GOALS[key]?.target;
}

const GOALS = {
  sleep: { name: "Sleep", icon: "🌙", target: 7, unit: "hrs", type: "daily-avg" },
  agua: { name: "Water", icon: "💧", target: 6, unit: "glasses", type: "daily" },
  supps: { name: "Supplements", icon: "💊", target: 4, unit: "of 4", type: "daily-all" },
  rehit: { name: "REHIT", icon: "🚴", target: 3, unit: "sessions", type: "weekly" },
  steps: { name: "Steps", icon: "👟", target: 5000, unit: "steps", type: "daily-avg" },
  movement: { name: "Movement", icon: "🚶", target: 2, unit: "breaks", type: "daily-avg" },
  reading: { name: "Reading", icon: "📖", target: 60, unit: "min", type: "weekly" }
};

function getFilteredData(data, range, phaseId = null) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (range === 'phase' || typeof range === 'number') {
    // If range is a number, treat it as a phase ID
    const targetPhaseId = typeof range === 'number' ? range : (phaseId || getCurrentPhase()?.id);
    const phase = getPhaseById(targetPhaseId);

    if (phase) {
      const phaseStart = parseDataDate(phase.start);
      const phaseEnd = new Date(phaseStart);
      phaseEnd.setDate(phaseStart.getDate() + phase.length - 1);
      return data.filter(d => {
        const date = parseDataDate(d.date);
        return date >= phaseStart && date <= Math.min(phaseEnd, today);
      });
    }

    // Fallback to legacy constants if no phase found
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

function calculateGoalStats(data, range, phaseId = null) {
  const stats = {};
  const totalDaysLogged = data.length;

  // Get the phase for goal targets
  const targetPhaseId = phaseId || currentSummaryPhaseId;
  const phase = targetPhaseId ? getPhaseById(targetPhaseId) : getCurrentPhase();

  // Calculate elapsed days based on range
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let elapsedDays, elapsedWeeks;

  if (range === 'phase' && phase) {
    const phaseStart = parseDataDate(phase.start);
    const phaseEnd = new Date(phaseStart);
    phaseEnd.setDate(phaseStart.getDate() + phase.length - 1);
    const effectiveEnd = phaseEnd < today ? phaseEnd : today;
    elapsedDays = Math.max(1, Math.floor((effectiveEnd - phaseStart) / (1000 * 60 * 60 * 24)) + 1);
    elapsedWeeks = Math.max(1, Math.ceil(elapsedDays / 7));
  } else if (range === 'phase') {
    // Fallback to legacy constants
    const phaseStart = new Date(PHASE_START);
    phaseStart.setHours(0, 0, 0, 0);
    elapsedDays = Math.min(PHASE_LENGTH, Math.max(1, Math.floor((today - phaseStart) / (1000 * 60 * 60 * 24)) + 1));
    elapsedWeeks = Math.max(1, Math.ceil(elapsedDays / 7));
  } else {
    // All time - use first data point to today
    if (data.length > 0) {
      const dates = data.map(d => parseDataDate(d.date)).sort((a, b) => a - b);
      const firstDate = dates[0];
      elapsedDays = Math.max(1, Math.floor((today - firstDate) / (1000 * 60 * 60 * 24)) + 1);
      elapsedWeeks = Math.max(1, Math.ceil(elapsedDays / 7));
    } else {
      elapsedDays = 1;
      elapsedWeeks = 1;
    }
  }

  // Helper to get goal target for this specific phase
  const getTarget = (key) => getGoalTarget(key, targetPhaseId);

  // Sleep: goal is 7+ hours
  const sleepTarget = getTarget('sleep');
  const sleepValues = data.map(d => parseFloat(d.daily["Hours of Sleep"])).filter(v => !isNaN(v) && v > 0);
  const sleepDaysMet = sleepValues.filter(v => v >= sleepTarget).length;
  stats.sleep = {
    pct: elapsedDays > 0 ? Math.round((sleepDaysMet / elapsedDays) * 100) : 0,
    daysMet: sleepDaysMet,
    totalDays: elapsedDays,
    avg: sleepValues.length > 0 ? (sleepValues.reduce((a,b) => a+b, 0) / sleepValues.length).toFixed(1) : 0,
    detail: `${sleepDaysMet}/${elapsedDays} days ${sleepTarget}+ hrs`,
    target: sleepTarget
  };

  // Agua: goal is 6+ glasses per day
  const aguaTarget = getTarget('agua');
  const waterValues = data.map(d => parseInt(d.daily["agua"] ?? d.daily["Water"] ?? d.daily["Water (glasses)"] ?? d.daily["hydrationGood"])).filter(v => !isNaN(v));
  const waterDaysMet = waterValues.filter(v => v >= aguaTarget).length;
  stats.agua = {
    pct: elapsedDays > 0 ? Math.round((waterDaysMet / elapsedDays) * 100) : 0,
    daysMet: waterDaysMet,
    totalDays: elapsedDays,
    avg: waterValues.length > 0 ? (waterValues.reduce((a,b) => a+b, 0) / waterValues.length).toFixed(1) : 0,
    detail: `${waterDaysMet}/${elapsedDays} days at ${aguaTarget}+`,
    target: aguaTarget
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
    pct: elapsedDays > 0 ? Math.round((suppsDaysMet / elapsedDays) * 100) : 0,
    detail: `${suppsDaysMet}/${elapsedDays} days all 4`
  };

  // REHIT: split into 2x10 and 3x10 sessions per week
  const rehitTarget = getTarget('rehit');
  // Group REHIT sessions by week, tracking 2x10 and 3x10 separately
  const weeklyRehit2x10 = {};
  const weeklyRehit3x10 = {};
  let total2x10 = 0;
  let total3x10 = 0;
  data.forEach(d => {
    const rehitVal = d.daily["REHIT 2x10"];
    if (rehitVal && rehitVal !== "") {
      const date = parseDataDate(d.date);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = `${weekStart.getMonth()+1}/${weekStart.getDate()}/${weekStart.getFullYear()}`;

      if (rehitVal === "3x10") {
        weeklyRehit3x10[weekKey] = (weeklyRehit3x10[weekKey] || 0) + 1;
        total3x10++;
      } else {
        // "2x10", true, or "TRUE" all count as 2x10
        weeklyRehit2x10[weekKey] = (weeklyRehit2x10[weekKey] || 0) + 1;
        total2x10++;
      }
    }
  });
  const rehitCount = total2x10 + total3x10;
  // Calculate weeks where combined sessions met goal
  const allWeeks = new Set([...Object.keys(weeklyRehit2x10), ...Object.keys(weeklyRehit3x10)]);
  let rehitWeeksMet = 0;
  allWeeks.forEach(weekKey => {
    const weekTotal = (weeklyRehit2x10[weekKey] || 0) + (weeklyRehit3x10[weekKey] || 0);
    if (weekTotal >= rehitTarget) rehitWeeksMet++;
  });
  const rehitPerWeek = elapsedWeeks > 0 ? rehitCount / elapsedWeeks : 0;
  const avg2x10PerWeek = elapsedWeeks > 0 ? total2x10 / elapsedWeeks : 0;
  const avg3x10PerWeek = elapsedWeeks > 0 ? total3x10 / elapsedWeeks : 0;
  stats.rehit = {
    pct: elapsedWeeks > 0 ? Math.round((rehitWeeksMet / elapsedWeeks) * 100) : 0,
    weeksMet: rehitWeeksMet,
    totalWeeks: elapsedWeeks,
    total: rehitCount,
    total2x10: total2x10,
    total3x10: total3x10,
    avg: rehitPerWeek.toFixed(1),
    avg2x10: avg2x10PerWeek.toFixed(1),
    avg3x10: avg3x10PerWeek.toFixed(1),
    detail: `${rehitCount} sessions (${rehitPerWeek.toFixed(1)}/wk)`,
    target: rehitTarget
  };

  // Steps: daily average
  const stepsTarget = getTarget('steps');
  const stepsValues = data.map(d => parseInt(d.daily["Steps"])).filter(v => !isNaN(v) && v > 0);
  const avgSteps = stepsValues.length > 0 ? stepsValues.reduce((a,b) => a+b, 0) / stepsValues.length : 0;
  const stepsDaysMet = stepsValues.filter(v => v >= stepsTarget).length;
  stats.steps = {
    pct: elapsedDays > 0 ? Math.round((stepsDaysMet / elapsedDays) * 100) : 0,
    daysMet: stepsDaysMet,
    totalDays: elapsedDays,
    avg: Math.round(avgSteps),
    detail: `${Math.round(avgSteps).toLocaleString()} avg steps`,
    target: stepsTarget
  };

  // Movement: days with 2+ movement breaks
  const movementTarget = getTarget('movement');
  let movementDaysMet = 0;
  let totalMovementBreaks = 0;
  data.forEach(d => {
    let breakCount = 0;
    // Count from morning/afternoon movement fields
    if (d.daily["Morning Movement Type"] && d.daily["Morning Movement Type"] !== "") breakCount++;
    if (d.daily["Afternoon Movement Type"] && d.daily["Afternoon Movement Type"] !== "") breakCount++;
    // Also check legacy Movements field
    const movements = d.daily["Movements"];
    if (movements && typeof movements === 'string') {
      breakCount += movements.split(',').filter(m => m.trim()).length;
    } else if (Array.isArray(movements)) {
      breakCount += movements.length;
    }
    totalMovementBreaks += breakCount;
    if (breakCount >= movementTarget) movementDaysMet++;
  });
  const avgMovementPerDay = elapsedDays > 0 ? totalMovementBreaks / elapsedDays : 0;
  stats.movement = {
    pct: elapsedDays > 0 ? Math.round((movementDaysMet / elapsedDays) * 100) : 0,
    daysMet: movementDaysMet,
    totalDays: elapsedDays,
    avg: avgMovementPerDay.toFixed(1),
    detail: `${movementDaysMet}/${elapsedDays} days ${movementTarget}+ breaks`,
    target: movementTarget
  };

  // Reading: weeks with target minutes
  // Calculate from readings array (list of {book, duration} objects)
  const readingTarget = getTarget('reading');
  const weeklyReading = {};
  data.forEach(d => {
    const date = parseDataDate(d.date);
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    const weekKey = `${weekStart.getMonth()+1}/${weekStart.getDate()}/${weekStart.getFullYear()}`;

    // Sum up reading minutes from the readings array
    let dayMins = 0;
    if (d.readings && Array.isArray(d.readings)) {
      d.readings.forEach(r => {
        const mins = parseInt(r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"]) || 0;
        dayMins += mins;
      });
    }
    // Also check the daily field as fallback
    if (dayMins === 0) {
      dayMins = parseInt(d.daily["Reading Minutes"]) || 0;
    }
    weeklyReading[weekKey] = (weeklyReading[weekKey] || 0) + dayMins;
  });
  const weeksWithReading = Object.values(weeklyReading).filter(mins => mins >= readingTarget).length;
  const totalReadingMins = Object.values(weeklyReading).reduce((a,b) => a+b, 0);
  const avgReadingPerWeek = elapsedWeeks > 0 ? totalReadingMins / elapsedWeeks : 0;
  stats.reading = {
    pct: elapsedWeeks > 0 ? Math.round((weeksWithReading / elapsedWeeks) * 100) : 0,
    weeksMet: weeksWithReading,
    totalWeeks: elapsedWeeks,
    total: totalReadingMins,
    avg: Math.round(avgReadingPerWeek),
    detail: `${weeksWithReading}/${elapsedWeeks} weeks ${readingTarget}+ min`,
    target: readingTarget
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
    const daySnacksOk = daySnacks === true || daySnacks === "TRUE" || daySnacks === "true";
    const nightSnacksOk = nightSnacks === true || nightSnacks === "TRUE" || nightSnacks === "true";
    // Count days where both day AND night snacks were healthy
    if (daySnacksOk && nightSnacksOk) healthySnacksDays++;
  });
  stats.meals = {
    pct: elapsedDays > 0 ? Math.round((goodMealsDays / elapsedDays) * 100) : 0,
    daysMet: goodMealsDays,
    totalDays: elapsedDays,
    detail: `${goodMealsDays}/${elapsedDays} days 2+ meals`
  };
  stats.snacks = {
    pct: elapsedDays > 0 ? Math.round((healthySnacksDays / elapsedDays) * 100) : 0,
    daysMet: healthySnacksDays,
    totalDays: elapsedDays,
    detail: `${healthySnacksDays}/${elapsedDays} days healthy snacks`
  };

  // No Alcohol
  let noAlcoholDays = 0;
  data.forEach(d => {
    const noAlc = d.daily["No Alcohol"];
    if (noAlc === true || noAlc === "TRUE" || noAlc === "true") noAlcoholDays++;
  });
  stats.noAlcohol = {
    pct: elapsedDays > 0 ? Math.round((noAlcoholDays / elapsedDays) * 100) : 0,
    detail: `${noAlcoholDays}/${elapsedDays} days`
  };
  
  // Mindfulness (meditation)
  let meditationDays = 0;
  data.forEach(d => {
    const med = d.daily["Meditation"] || d.daily["Meditated"];
    if (med === true || med === "TRUE" || med === "true") meditationDays++;
  });
  stats.meditation = {
    pct: elapsedDays > 0 ? Math.round((meditationDays / elapsedDays) * 100) : 0,
    daysMet: meditationDays,
    totalDays: elapsedDays,
    detail: `${meditationDays}/${elapsedDays} days`
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
  stats.inhalerAM = { pct: elapsedDays > 0 ? Math.round((inhalerMorningDays / elapsedDays) * 100) : 0, detail: `${inhalerMorningDays}/${elapsedDays} days` };
  stats.inhalerPM = { pct: elapsedDays > 0 ? Math.round((inhalerEveningDays / elapsedDays) * 100) : 0, detail: `${inhalerEveningDays}/${elapsedDays} days` };
  stats.math = { pct: elapsedDays > 0 ? Math.round((mathDays / elapsedDays) * 100) : 0, detail: `${mathDays}/${elapsedDays} days` };

  // Writing (reflections, stories, carly)
  let reflectionsDays = 0, storiesDays = 0, carlyDays = 0;
  data.forEach(d => {
    if (d.daily["Reflections"] && d.daily["Reflections"].trim() !== "") reflectionsDays++;
    if (d.daily["Grey & Sloane Story"] && d.daily["Grey & Sloane Story"].trim() !== "") storiesDays++;
    if (d.daily["Carly"] && d.daily["Carly"].trim() !== "") carlyDays++;
  });
  stats.reflections = { pct: elapsedDays > 0 ? Math.round((reflectionsDays / elapsedDays) * 100) : 0, detail: `${reflectionsDays}/${elapsedDays} days` };
  stats.stories = { pct: elapsedDays > 0 ? Math.round((storiesDays / elapsedDays) * 100) : 0, detail: `${storiesDays}/${elapsedDays} days` };
  stats.carly = { pct: elapsedDays > 0 ? Math.round((carlyDays / elapsedDays) * 100) : 0, detail: `${carlyDays}/${elapsedDays} days` };

  return stats;
}

function renderSummaryPage(data, range) {
  currentSummaryRange = range;
  const phaseId = range === 'phase' ? currentSummaryPhaseId : null;
  const filteredData = getFilteredData(data, range, phaseId);
  const stats = calculateGoalStats(filteredData, range, phaseId);

  // Overview stats
  renderSummaryOverview(filteredData, stats, range, data, phaseId);

  // Habit grid (always shows last 7 days from all data)
  renderHabitGrid(data);

  // Phase goals (show targets for selected phase)
  if (range === 'phase') {
    renderPhaseGoals(phaseId);
    document.getElementById('phaseGoalsSection')?.style.setProperty('display', 'block');
  } else {
    document.getElementById('phaseGoalsSection')?.style.setProperty('display', 'none');
  }

  // REHIT Calendar
  renderSummaryRehitCalendar(data, range, phaseId);

  // Goal performance
  renderGoalPerformance(stats);

  // Category stats
  renderHealthGoals(stats);
  renderNutritionStats(stats);
  renderMindfulnessStats(stats);
  renderKidsHabitsStats(stats);
  renderWritingStats(stats);
}

function renderSummaryOverview(data, stats, range, allData, phaseId = null) {
  const container = document.getElementById('summaryOverview');
  if (!container) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get the selected phase or current phase
  const phase = phaseId ? getPhaseById(phaseId) : getCurrentPhase();

  let phaseStart, phaseLength, phaseName;
  if (phase) {
    phaseStart = parseDataDate(phase.start);
    phaseLength = phase.length;
    phaseName = phase.name;
  } else {
    phaseStart = new Date(PHASE_START);
    phaseLength = PHASE_LENGTH;
    phaseName = 'Phase 1';
  }
  phaseStart.setHours(0, 0, 0, 0);

  const phaseEnd = new Date(phaseStart);
  phaseEnd.setDate(phaseStart.getDate() + phaseLength - 1);

  // Calculate days for this phase
  const isPhaseComplete = today > phaseEnd;
  const effectiveEnd = isPhaseComplete ? phaseEnd : today;
  const daysIntoPhase = Math.max(0, Math.floor((effectiveEnd - phaseStart) / (1000 * 60 * 60 * 24)) + 1);
  const daysRemaining = Math.max(0, phaseLength - daysIntoPhase);
  const elapsedDays = range === 'phase' ? Math.min(daysIntoPhase, phaseLength) : daysIntoPhase;
  const totalDaysLogged = data.length;
  const currentStreak = calculateCurrentStreak();
  const pctLogged = elapsedDays > 0 ? Math.round((totalDaysLogged / elapsedDays) * 100) : 0;

  // Show different content based on whether viewing current or past phase
  const statusText = isPhaseComplete ? 'Complete!' : (daysRemaining > 0 ? daysRemaining + ' remaining' : 'Complete!');

  container.innerHTML = `
    <div class="summary-stat full-width">
      <div class="summary-stat-value">🔥 ${currentStreak}-day streak</div>
      <div class="summary-stat-label">${pctLogged}% of days logged</div>
    </div>
  `;
}

function renderHabitGrid(allData) {
  const container = document.getElementById('habitGridContainer');
  if (!container) return;

  // Define habits to show in grid
  // Each habit has hasAny (did anything) and metGoal (met the target)
  const HABITS = [
    { key: 'sleep', icon: '🌙', name: 'Sleep', targetKey: 'sleep',
      hasAny: (d) => { const v = parseFloat(d.daily["Hours of Sleep"]); return !isNaN(v) && v > 0; },
      metGoal: (d, target) => parseFloat(d.daily["Hours of Sleep"]) >= target
    },
    { key: 'agua', icon: '💧', name: 'Water', targetKey: 'agua',
      hasAny: (d) => { const v = parseInt(d.daily["agua"] ?? d.daily["Water"] ?? d.daily["Water (glasses)"]); return !isNaN(v) && v > 0; },
      metGoal: (d, target) => parseInt(d.daily["agua"] ?? d.daily["Water"] ?? d.daily["Water (glasses)"]) >= target
    },
    { key: 'steps', icon: '👟', name: 'Steps', targetKey: 'steps',
      hasAny: (d) => { const v = parseInt(d.daily["Steps"]); return !isNaN(v) && v > 0; },
      metGoal: (d, target) => parseInt(d.daily["Steps"]) >= target
    },
    { key: 'rehit', icon: '🚴', name: 'REHIT',
      hasAny: (d) => { const v = d.daily["REHIT 2x10"]; return v && v !== ""; },
      metGoal: (d) => { const v = d.daily["REHIT 2x10"]; return v && v !== ""; }
    },
    { key: 'movement', icon: '🚶', name: 'Movement', targetKey: 'movement',
      hasAny: (d) => {
        if (d.daily["Morning Movement Type"] && d.daily["Morning Movement Type"] !== "") return true;
        if (d.daily["Afternoon Movement Type"] && d.daily["Afternoon Movement Type"] !== "") return true;
        const movements = d.daily["Movements"];
        if (movements && typeof movements === 'string' && movements.split(',').filter(m => m.trim()).length > 0) return true;
        if (Array.isArray(movements) && movements.length > 0) return true;
        return false;
      },
      metGoal: (d, target) => {
        let breakCount = 0;
        if (d.daily["Morning Movement Type"] && d.daily["Morning Movement Type"] !== "") breakCount++;
        if (d.daily["Afternoon Movement Type"] && d.daily["Afternoon Movement Type"] !== "") breakCount++;
        const movements = d.daily["Movements"];
        if (movements && typeof movements === 'string') breakCount += movements.split(',').filter(m => m.trim()).length;
        else if (Array.isArray(movements)) breakCount += movements.length;
        return breakCount >= target;
      }
    },
    { key: 'supps', icon: '💊', name: 'Supps',
      hasAny: (d) => {
        const creatine = d.daily["Creatine Chews"] || d.daily["Creatine"];
        const vitD = d.daily["Vitamin D"];
        const no2 = d.daily["NO2"];
        const psyllium = d.daily["Psyllium Husk"] || d.daily["Psyllium"];
        return [creatine, vitD, no2, psyllium].some(v => v === true || v === "TRUE" || v === "true");
      },
      metGoal: (d) => {
        const creatine = d.daily["Creatine Chews"] || d.daily["Creatine"];
        const vitD = d.daily["Vitamin D"];
        const no2 = d.daily["NO2"];
        const psyllium = d.daily["Psyllium Husk"] || d.daily["Psyllium"];
        return [creatine, vitD, no2, psyllium].filter(v => v === true || v === "TRUE" || v === "true").length === 4;
      }
    },
    { key: 'meals', icon: '🍽️', name: 'Meals',
      hasAny: (d) => {
        const breakfast = d.daily["Breakfast"] === true || d.daily["Breakfast"] === "TRUE";
        const lunch = d.daily["Lunch"] === true || d.daily["Lunch"] === "TRUE";
        const dinner = d.daily["Dinner"] === true || d.daily["Dinner"] === "TRUE";
        return breakfast || lunch || dinner;
      },
      metGoal: (d) => {
        const breakfast = d.daily["Breakfast"] === true || d.daily["Breakfast"] === "TRUE";
        const lunch = d.daily["Lunch"] === true || d.daily["Lunch"] === "TRUE";
        const dinner = d.daily["Dinner"] === true || d.daily["Dinner"] === "TRUE";
        return [breakfast, lunch, dinner].filter(Boolean).length >= 2;
      }
    },
    { key: 'reading', icon: '📖', name: 'Reading',
      hasAny: (d) => {
        let mins = 0;
        if (d.readings && Array.isArray(d.readings)) {
          d.readings.forEach(r => { mins += parseInt(r.duration ?? r["duration (min)"] ?? 0) || 0; });
        }
        if (mins === 0) mins = parseInt(d.daily["Reading Minutes"]) || 0;
        return mins > 0;
      },
      metGoal: (d) => {
        let mins = 0;
        if (d.readings && Array.isArray(d.readings)) {
          d.readings.forEach(r => { mins += parseInt(r.duration ?? r["duration (min)"] ?? 0) || 0; });
        }
        if (mins === 0) mins = parseInt(d.daily["Reading Minutes"]) || 0;
        return mins > 0;
      }
    },
    { key: 'noAlcohol', icon: '🚫', name: 'No Alcohol',
      hasAny: (d) => { const v = d.daily["No Alcohol"]; return v === true || v === "TRUE" || v === "true"; },
      metGoal: (d) => { const v = d.daily["No Alcohol"]; return v === true || v === "TRUE" || v === "true"; }
    },
    { key: 'meditation', icon: '🧘', name: 'Meditation',
      hasAny: (d) => { const v = d.daily["Meditation"] || d.daily["Meditated"]; return v === true || v === "TRUE" || v === "true"; },
      metGoal: (d) => { const v = d.daily["Meditation"] || d.daily["Meditated"]; return v === true || v === "TRUE" || v === "true"; }
    },
  ];

  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  // Helper to format date as M/D/YY (matching data format)
  const toDateKey = (d) => `${d.getMonth()+1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;

  // Get last 7 days
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build date map from all data
  const dataMap = {};
  allData.forEach(d => { dataMap[d.date] = d; });

  // Get last 7 days dates
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const dateStr = toDateKey(date);
    days.push({ date, dateStr, data: dataMap[dateStr] || null, isToday: i === 0 });
  }

  // Helper to get target for a habit
  const getTarget = (key) => typeof getGoalTarget === 'function' ? getGoalTarget(key) :
    ({ sleep: 7, agua: 6, steps: 5000, movement: 2 }[key] || 1);

  // Calculate streaks per habit (counting backwards from yesterday)
  const streaks = {};
  HABITS.forEach(h => {
    let streak = 0;
    for (let i = days.length - 2; i >= 0; i--) {
      const d = days[i].data;
      if (d && h.metGoal(d, h.targetKey ? getTarget(h.targetKey) : null)) streak++;
      else break;
    }
    streaks[h.key] = streak;
  });

  // Find habits missed yesterday (for "never miss twice" banner)
  const yesterday = days[days.length - 2];
  const missedYesterday = HABITS.filter(h => {
    if (!yesterday.data) return true;
    return !h.metGoal(yesterday.data, h.targetKey ? getTarget(h.targetKey) : null);
  });

  // Calculate daily completion percentages
  const dailyPcts = days.map(day => {
    if (day.isToday || !day.data) return null;
    const done = HABITS.filter(h => h.metGoal(day.data, h.targetKey ? getTarget(h.targetKey) : null)).length;
    return Math.round((done / HABITS.length) * 100);
  });

  // Build HTML
  let html = '';

  // "Never Miss Twice" Banner (if habits were missed yesterday)
  if (missedYesterday.length > 0 && missedYesterday.length < HABITS.length) {
    html += `
      <div class="habit-grid-banner">
        <div class="banner-header">
          <div class="banner-title">⚡ Don't break the chain</div>
          <div class="banner-subtitle">You missed ${missedYesterday.length} habit${missedYesterday.length > 1 ? 's' : ''} yesterday</div>
        </div>
        <div class="banner-habits">
          ${missedYesterday.slice(0, 3).map(h => `
            <div class="banner-habit">
              <span class="banner-habit-icon">${h.icon}</span>
              <span class="banner-habit-name">${h.name}</span>
              ${streaks[h.key] > 0 ? `<span class="banner-streak-note">Had ${streaks[h.key]}-day streak</span>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Date range header
  const startDate = days[0].date;
  const endDate = days[6].date;
  const dateRangeStr = `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  html += `<div class="habit-grid-header">
    <span class="habit-grid-title">Last 7 Days</span>
    <span class="habit-grid-dates">${dateRangeStr}</span>
  </div>`;

  // Day labels row
  html += `<div class="habit-grid-row habit-grid-labels">
    <div class="habit-grid-name"></div>
    ${days.map(d => `<div class="habit-grid-day-label ${d.isToday ? 'today' : ''}">${d.isToday ? 'today' : DAY_LABELS[d.date.getDay()]}</div>`).join('')}
  </div>`;

  // Habit rows
  HABITS.forEach(h => {
    html += `<div class="habit-grid-row">
      <div class="habit-grid-name">
        <span class="habit-grid-icon">${h.icon}</span>
        <span class="habit-grid-label">${h.name}</span>
        ${streaks[h.key] >= 3 ? `<span class="habit-streak-pill">🔥${streaks[h.key]}</span>` : ''}
      </div>
      ${days.map(d => {
        let cellClass = 'habit-grid-cell';
        if (d.isToday) {
          cellClass += ' today';
        } else if (!d.data) {
          cellClass += ' no-data';
        } else if (h.metGoal(d.data, h.targetKey ? getTarget(h.targetKey) : null)) {
          cellClass += ' goal-met';
        } else if (h.hasAny(d.data)) {
          cellClass += ' partial';
        } else {
          cellClass += ' miss';
        }
        return `<div class="${cellClass}"></div>`;
      }).join('')}
    </div>`;
  });

  // Daily completion percentage row
  html += `<div class="habit-grid-row habit-grid-pct-row">
    <div class="habit-grid-name"><span class="habit-grid-label" style="color:var(--text-muted)">Daily %</span></div>
    ${dailyPcts.map((pct, i) => {
      if (pct === null) return `<div class="habit-grid-pct">—</div>`;
      const color = pct >= 80 ? 'var(--accent-green)' : pct >= 50 ? 'var(--accent-orange)' : 'var(--accent-pink)';
      return `<div class="habit-grid-pct">
        <span style="color:${color}">${pct}%</span>
        <div class="habit-pct-bar"><div class="habit-pct-fill" style="width:${pct}%;background:${color}"></div></div>
      </div>`;
    }).join('')}
  </div>`;

  // Legend
  html += `<div class="habit-grid-legend">
    <div class="legend-item"><div class="legend-cell goal-met"></div><span>Goal Met</span></div>
    <div class="legend-item"><div class="legend-cell partial"></div><span>Partial</span></div>
    <div class="legend-item"><div class="legend-cell miss"></div><span>Missed</span></div>
    <div class="legend-item"><div class="legend-cell today"></div><span>Today</span></div>
  </div>`;

  container.innerHTML = html;
}

function renderSummaryRehitCalendar(data, range, phaseId = null) {
  const container = document.getElementById('summaryRehitCalendar');
  if (!container) return;

  // Build rehit data map from filtered data for the selected range
  const filteredData = getFilteredData(data, range, phaseId);
  const rehitMap = {};
  filteredData.forEach(d => {
    const val = d.daily["REHIT 2x10"];
    if (val === "2x10" || val === true || val === "TRUE") {
      rehitMap[d.date] = "2x10";
    } else if (val === "3x10") {
      rehitMap[d.date] = "3x10";
    }
  });

  if (range === 7) {
    // Show last 7 days (matching the data filter)
    renderLast7DaysCalendar(container, rehitMap);
  } else if (range === 'phase') {
    // Show phase weeks only - starting from the first week of the phase
    const phase = phaseId ? getPhaseById(phaseId) : getCurrentPhase();
    const phaseStart = phase ? parseDataDate(phase.start) : new Date(PHASE_START);
    const phaseLength = phase ? phase.length : PHASE_LENGTH;
    renderPhaseCalendar(container, rehitMap, phaseStart, phaseLength);
  } else {
    // Show 30 days
    renderMonthCalendar(container, rehitMap, new Date());
  }
}

function renderLast7DaysCalendar(container, rehitMap) {
  const today = new Date();
  const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(-2)}`;

  // Get weekday names for the last 7 days
  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  let weekdaysHtml = '<div class="rehit-cal-weekdays">';
  let daysHtml = '<div class="rehit-cal-days">';

  for (let i = 6; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const dateStr = `${day.getMonth() + 1}/${day.getDate()}/${String(day.getFullYear()).slice(-2)}`;
    const rehitVal = rehitMap[dateStr];
    const isToday = i === 0;

    weekdaysHtml += `<div class="rehit-cal-weekday">${dayNames[day.getDay()]}</div>`;

    let classes = "rehit-cal-day";
    if (isToday) classes += " today";
    if (rehitVal) {
      classes += " has-rehit";
      if (rehitVal === "2x10") classes += " rehit-2x10";
      if (rehitVal === "3x10") classes += " rehit-3x10";
    }

    daysHtml += `<div class="${classes}">${day.getDate()}</div>`;
  }

  weekdaysHtml += '</div>';
  daysHtml += '</div>';

  container.innerHTML = `
    ${weekdaysHtml}
    ${daysHtml}
    <div class="rehit-cal-legend">
      <div class="rehit-cal-legend-item"><div class="rehit-cal-legend-dot dot-2x10"></div><span>2×10</span></div>
      <div class="rehit-cal-legend-item"><div class="rehit-cal-legend-dot dot-3x10"></div><span>3×10</span></div>
    </div>
  `;
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

function renderPhaseCalendar(container, rehitMap, phaseStart, phaseLength) {
  const today = new Date();
  const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(-2)}`;

  const phaseEnd = new Date(phaseStart);
  phaseEnd.setDate(phaseStart.getDate() + phaseLength - 1);

  // Find the Sunday at the start of the week containing phaseStart
  const calStart = new Date(phaseStart);
  calStart.setDate(calStart.getDate() - calStart.getDay());

  // Show exactly N weeks based on phase length (e.g. 21 days = 3 weeks)
  const numWeeks = Math.ceil(phaseLength / 7);
  const calEnd = new Date(calStart);
  calEnd.setDate(calStart.getDate() + (numWeeks * 7) - 1);

  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  // Build title from phase date range
  const startMonth = monthNames[calStart.getMonth()];
  const endMonth = monthNames[calEnd.getMonth()];
  const title = startMonth === endMonth
    ? `${startMonth} ${calStart.getFullYear()}`
    : `${startMonth} – ${endMonth} ${calEnd.getFullYear()}`;

  let html = `
    <div class="rehit-cal-header">
      <div class="rehit-cal-title">${title}</div>
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

  // Iterate day by day from calStart to calEnd
  const cursor = new Date(calStart);
  while (cursor <= calEnd) {
    const dateStr = `${cursor.getMonth() + 1}/${cursor.getDate()}/${String(cursor.getFullYear()).slice(-2)}`;
    const isInPhase = cursor >= phaseStart && cursor <= phaseEnd;
    const isToday = dateStr === todayStr;
    const rehitVal = rehitMap[dateStr];

    let classes = "rehit-cal-day";
    if (!isInPhase) {
      classes += " other-month";
    } else {
      if (isToday) classes += " today";
      if (rehitVal) {
        classes += " has-rehit";
        if (rehitVal === "2x10") classes += " rehit-2x10";
        if (rehitVal === "3x10") classes += " rehit-3x10";
      }
    }

    html += `<div class="${classes}">${cursor.getDate()}</div>`;
    cursor.setDate(cursor.getDate() + 1);
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
    { key: 'agua', ...GOALS.agua, ...stats.agua },
    { key: 'supps', name: 'Supplements', icon: '💊', ...stats.supps },
    { key: 'rehit', ...GOALS.rehit, ...stats.rehit },
    { key: 'steps', ...GOALS.steps, ...stats.steps },
    { key: 'movement', ...GOALS.movement, ...stats.movement },
    { key: 'reading', ...GOALS.reading, ...stats.reading },
    { key: 'meals', name: 'Meals', icon: '🍽️', ...stats.meals },
    { key: 'snacks', name: 'Snacks', icon: '🥗', ...stats.snacks },
    { key: 'noAlcohol', name: 'No Alcohol', icon: '🚫🍺', ...stats.noAlcohol }
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
    ${renderGoalStatCard('Water', '💧', stats.agua.pct, stats.agua.detail)}
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
    ${renderGoalStatCard('No Alcohol', '🚫🍺', stats.noAlcohol.pct, stats.noAlcohol.detail)}
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
    // Update section titles with streak badges
    if (typeof updateSectionStreaks === 'function') updateSectionStreaks();
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
          readings: result?.readings || [],
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
    // Update section titles with streak badges
    if (typeof updateSectionStreaks === 'function') updateSectionStreaks();
  }
  
  // Update range buttons to show data availability
  updateRangeButtonsAvailability();
  
  if (allData.length === 0) {
    console.log("No data to chart");
    return;
  }
  
  // Filter by selected range
  const dataPoints = filterChartDataByRange(allData, currentChartRange);
  
  // Render each chart
  try {
    renderWeightChart(dataPoints);
    renderSleepChart(dataPoints);
    renderStepsChart(dataPoints);
    renderMovementChart(dataPoints);
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

let weightChart, sleepChart, stepsChart, movementChart, rehitChart, bodyCompChart, peakWattsChart;
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
        legend: { display: true, labels: { color: colors.text } }
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
          title: { display: true, text: 'Weight (lbs)', color: colors.text }
        },
        y1: {
          type: 'linear',
          position: 'right',
          ticks: { color: colors.text },
          grid: { display: false },
          title: { display: true, text: 'Waist (in)', color: colors.text }
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
          labels: { color: colors.text }
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
          title: { display: true, text: 'Hours', color: colors.text }
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
          title: { display: true, text: 'Steps', color: colors.text }
        }
      }
    }
  });
}

function renderMovementChart(dataPoints) {
  try {
    const canvas = document.getElementById("movementChart");
    if (!canvas) {
      console.log('Movement chart: canvas not found');
      return;
    }

  const ctx = canvas.getContext("2d");
  const colors = getChartColors();

  if (movementChart) movementChart.destroy();

  const labels = dataPoints.map(d => d.date);

  // Count movement breaks per day from both new and legacy formats
  const movements = dataPoints.map(d => {
    let count = 0;

    // Check new morning/afternoon format
    if (d.daily && d.daily["Morning Movement Type"] && d.daily["Morning Movement Type"] !== "") count++;
    if (d.daily && d.daily["Afternoon Movement Type"] && d.daily["Afternoon Movement Type"] !== "") count++;

    // Also check legacy Movements field (if no new format data)
    if (count === 0 && d.daily && d.daily["Movements"]) {
      const legacy = d.daily["Movements"];
      if (typeof legacy === 'string' && legacy.trim()) {
        count = legacy.split(',').filter(m => m.trim()).length;
      } else if (Array.isArray(legacy)) {
        count = legacy.length;
      }
    }

    return count > 0 ? count : null;
  });

  console.log('Movement chart data:', movements.filter(m => m !== null).length, 'days with data');

  // Calculate average
  const validMovements = movements.filter(m => m !== null && m > 0);
  const avgMovements = validMovements.length > 0
    ? validMovements.reduce((a, b) => a + b, 0) / validMovements.length
    : null;

  // Create average line
  const avgLine = avgMovements ? labels.map(() => avgMovements) : [];

  // Create goal line (2 breaks per day)
  const goalLine = labels.map(() => 2);

  movementChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Movement Breaks',
          data: movements,
          backgroundColor: '#52b788',
          borderColor: '#52b788',
          borderWidth: 1,
          order: 3
        },
        {
          label: `Average (${avgMovements ? avgMovements.toFixed(1) : '--'})`,
          data: avgLine,
          type: 'line',
          borderColor: '#e0e0e0',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
          order: 1
        },
        {
          label: 'Goal (2/day)',
          data: goalLine,
          type: 'line',
          borderColor: '#ff9f1c',
          borderWidth: 2,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          labels: { color: colors.text }
        }
      },
      scales: {
        x: {
          ticks: { color: colors.text, maxRotation: 45, minRotation: 45 },
          grid: { color: colors.grid }
        },
        y: {
          beginAtZero: true,
          max: 5,
          ticks: {
            color: colors.text,
            stepSize: 1
          },
          grid: { color: colors.grid },
          title: { display: true, text: 'Breaks', color: colors.text }
        }
      }
    }
  });
  } catch (err) {
    console.error('Error rendering movement chart:', err);
  }
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
            color: colors.text,
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
  const leanMassPct = dataPoints.map(d => {
    const lean = parseFloat(d.daily["Lean Mass (lbs)"]);
    const weight = parseFloat(d.daily["Weight (lbs)"]);
    if (!isNaN(lean) && !isNaN(weight) && weight > 0) {
      return parseFloat(((lean / weight) * 100).toFixed(1));
    }
    return null;
  });

  bodyCompChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Lean Mass %',
          data: leanMassPct,
          borderColor: '#52b788',
          backgroundColor: 'rgba(82, 183, 136, 0.1)',
          tension: 0.3,
          fill: true,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.parsed.y?.toFixed(1) + '%';
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
          ticks: {
            color: colors.text,
            callback: function(value) {
              return value?.toFixed(1) + '%';
            }
          },
          grid: { color: colors.grid },
          title: { display: true, text: 'Lean Mass %', color: colors.text }
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
          label: 'Pulse (bpm)',
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
        legend: { display: true, labels: { color: colors.text } }
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
          title: { display: true, text: 'Blood Pressure (mmHg)', color: colors.text },
          min: 60,
          max: 160
        },
        y1: {
          type: 'linear',
          position: 'right',
          ticks: { color: colors.text },
          grid: { display: false },
          title: { display: true, text: 'Pulse (bpm)', color: colors.text },
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
  
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  const dateStr = cur.toLocaleDateString('en-US', options);
  if (cur.getTime() === today.getTime()) {
    stickyDate.textContent = "Today - " + dateStr;
  } else {
    stickyDate.textContent = dateStr;
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
    case "agua":
      await quickLogAgua();
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
  window.openMovementModal();
}

async function quickLogAgua() {
  // Sync from DOM first (inline handlers may have changed it)
  const waterEl = document.getElementById("aguaCount");
  aguaCount = waterEl ? (parseInt(waterEl.textContent) || 0) : aguaCount;
  aguaCount++;
  if (waterEl) waterEl.textContent = aguaCount;

  triggerSaveSoon();
  showQuickConfirmation(`✓ Water: ${aguaCount} glasses`);

  // Check for water goal achievement
  checkWaterGoal();
}

async function quickLogReading() {
  window.openReadingModal();
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

// Dopamine reward messages for goal achievements
const GOAL_REWARDS = {
  water: {
    emoji: '💧',
    title: 'Hydration Goal!',
    messages: [
      'Your cells are celebrating!',
      'Hydration hero status unlocked!',
      'Your kidneys thank you!',
      'Peak hydration achieved!',
      'Water warrior mode activated!'
    ]
  },
  steps: {
    emoji: '👟',
    title: 'Step Goal Crushed!',
    messages: [
      'Your feet are champions!',
      'Every step counts - and you counted them all!',
      'Walking your way to greatness!',
      'Movement milestone achieved!',
      'Steps on steps on steps!'
    ]
  },
  movement: {
    emoji: '🚶',
    title: 'Movement Breaks Done!',
    messages: [
      'Your body says thank you!',
      'Breaks make breakthroughs!',
      'Sedentary? Not today!',
      'Movement master unlocked!',
      'Your joints are doing a happy dance!'
    ]
  },
  meals: {
    emoji: '🍽️',
    title: 'Meals On Point!',
    messages: [
      'Fueling your success!',
      'Nutrition game strong!',
      'Eating like a champion!',
      'Your metabolism approves!',
      'Proper fuel, proper you!'
    ]
  },
  cleanEating: {
    emoji: '🌟',
    title: 'Clean Eating Champion!',
    messages: [
      'Healthy snacks + no alcohol = unstoppable!',
      'Your body is thriving!',
      'Clean fuel, clear mind!',
      'Nourishment goals crushed!',
      'Tomorrow you will thank today you!'
    ]
  }
};

function getRandomMessage(goalKey) {
  const messages = GOAL_REWARDS[goalKey]?.messages || ['Great job!'];
  return messages[Math.floor(Math.random() * messages.length)];
}

function resetDailyGoalsAchieved() {
  dailyGoalsAchieved = {
    water: false,
    steps: false,
    movement: false,
    meals: false,
    cleanEating: false
  };
}

function isViewingToday() {
  const today = new Date();
  return currentDate.toDateString() === today.toDateString();
}

function celebrateGoalAchievement(goalKey) {
  if (dailyGoalsAchieved[goalKey]) return; // Already celebrated today
  if (!isViewingToday()) return; // Only celebrate when viewing today

  const reward = GOAL_REWARDS[goalKey];
  if (!reward) return;

  dailyGoalsAchieved[goalKey] = true;

  // Haptic feedback - celebratory double-pulse pattern
  if (navigator.vibrate) {
    navigator.vibrate([50, 50, 100]); // short, pause, longer
  }

  // Small delay to let the UI update first
  setTimeout(() => {
    showMilestone(reward.emoji, reward.title, getRandomMessage(goalKey));
  }, 300);
}

function checkWaterGoal() {
  const target = getGoalTarget('agua');
  if (aguaCount >= target && !dailyGoalsAchieved.water) {
    celebrateGoalAchievement('water');
  }
}

function checkStepsGoal() {
  const stepsInput = document.getElementById('steps');
  const steps = parseInt(stepsInput?.value) || 0;
  const target = getGoalTarget('steps');
  if (steps >= target && !dailyGoalsAchieved.steps) {
    celebrateGoalAchievement('steps');
  }
}

function checkMovementGoal() {
  // Count morning and afternoon movement breaks
  let breakCount = 0;

  const morningType = document.getElementById('morningMovementType')?.value;
  const afternoonType = document.getElementById('afternoonMovementType')?.value;

  if (morningType && morningType !== '') breakCount++;
  if (afternoonType && afternoonType !== '') breakCount++;

  const target = getGoalTarget('movement');
  if (breakCount >= target && !dailyGoalsAchieved.movement) {
    celebrateGoalAchievement('movement');
  }
}

function checkMealsGoal() {
  const breakfast = document.getElementById('breakfast')?.checked || false;
  const lunch = document.getElementById('lunch')?.checked || false;
  const dinner = document.getElementById('dinner')?.checked || false;

  const mealsCount = [breakfast, lunch, dinner].filter(Boolean).length;

  if (mealsCount >= 2 && !dailyGoalsAchieved.meals) {
    celebrateGoalAchievement('meals');
  }
}

function checkCleanEatingGoal() {
  const daySnacks = document.getElementById('daySnacks')?.checked || false;
  const nightSnacks = document.getElementById('nightSnacks')?.checked || false;
  const noAlcohol = document.getElementById('noAlcohol')?.checked || false;

  if (daySnacks && nightSnacks && noAlcohol && !dailyGoalsAchieved.cleanEating) {
    celebrateGoalAchievement('cleanEating');
  }
}

function checkAllDailyGoals() {
  checkWaterGoal();
  checkStepsGoal();
  checkMovementGoal();
  checkMealsGoal();
  checkCleanEatingGoal();
}

function setupDopamineBoosts() {
  // Add confetti to all checkboxes (including mini-supp checkboxes for meals/snacks/alcohol)
  document.querySelectorAll('.checkbox-field input[type="checkbox"], .mini-supp input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        createConfetti(e.target);
        updateCompletionRing();
        checkForMilestones();

        // Check for daily goal achievements based on which checkbox changed
        const id = e.target.id;
        if (id === 'breakfast' || id === 'lunch' || id === 'dinner') {
          checkMealsGoal();
        } else if (id === 'daySnacks' || id === 'nightSnacks' || id === 'noAlcohol') {
          checkCleanEatingGoal();
        }
      } else {
        updateCompletionRing();
      }
    });
  });

  // Track number inputs for personal bests and goal achievements
  document.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('change', () => {
      checkPersonalBest(input);

      // Check for steps goal achievement
      if (input.id === 'steps') {
        checkStepsGoal();
      }
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
  const sortedData = [...chartDataCache].sort((a, b) => parseDataDate(b.date) - parseDataDate(a.date));

  for (const d of sortedData) {
    const hasData = d.daily["Hours of Sleep"] || d.daily["Steps"];
    if (hasData) streak++;
    else break;
  }

  return streak;
}

// Calculate streak for a specific goal (daily goals)
function calculateDailyGoalStreak(goalChecker) {
  if (!chartDataCache || chartDataCache.length === 0) return 0;

  let streak = 0;
  const sortedData = [...chartDataCache].sort((a, b) => {
    const dateA = parseDataDate(a.date);
    const dateB = parseDataDate(b.date);
    return dateB - dateA;
  });

  for (const d of sortedData) {
    if (goalChecker(d)) streak++;
    else break;
  }

  return streak;
}

// Calculate streak for weekly goals
function calculateWeeklyGoalStreak(goalChecker) {
  if (!chartDataCache || chartDataCache.length === 0) return 0;

  // Group data by week (Sun-Sat)
  const weeklyData = {};
  chartDataCache.forEach(d => {
    const date = parseDataDate(d.date);
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    const weekKey = `${weekStart.getFullYear()}-${weekStart.getMonth()}-${weekStart.getDate()}`;
    if (!weeklyData[weekKey]) weeklyData[weekKey] = [];
    weeklyData[weekKey].push(d);
  });

  // Sort weeks from most recent
  const sortedWeeks = Object.entries(weeklyData)
    .sort((a, b) => {
      const [aKey] = a;
      const [bKey] = b;
      const [aY, aM, aD] = aKey.split('-').map(Number);
      const [bY, bM, bD] = bKey.split('-').map(Number);
      return new Date(bY, bM, bD) - new Date(aY, aM, aD);
    });

  let streak = 0;
  for (const [, weekData] of sortedWeeks) {
    if (goalChecker(weekData)) streak++;
    else break;
  }

  return streak;
}

// Goal checker functions
const goalCheckers = {
  water: (d) => {
    const water = parseInt(d.daily["agua"] ?? d.daily["Water"] ?? d.daily["Water (glasses)"] ?? 0);
    return water >= 6;
  },
  movement: (d) => {
    let breaks = 0;
    if (d.daily["Morning Movement Type"] && d.daily["Morning Movement Type"] !== "") breaks++;
    if (d.daily["Afternoon Movement Type"] && d.daily["Afternoon Movement Type"] !== "") breaks++;
    return breaks >= 2;
  },
  meals: (d) => {
    const breakfast = d.daily["Breakfast"] === true || d.daily["Breakfast"] === "TRUE";
    const lunch = d.daily["Lunch"] === true || d.daily["Lunch"] === "TRUE";
    const dinner = d.daily["Dinner"] === true || d.daily["Dinner"] === "TRUE";
    return [breakfast, lunch, dinner].filter(Boolean).length >= 2;
  },
  cleanEating: (d) => {
    const daySnacks = d.daily["Healthy Day Snacks"] || d.daily["Day Snacks"];
    const nightSnacks = d.daily["Healthy Night Snacks"] || d.daily["Night Snacks"];
    const noAlc = d.daily["No Alcohol"];
    return (daySnacks === true || daySnacks === "TRUE") &&
           (nightSnacks === true || nightSnacks === "TRUE") &&
           (noAlc === true || noAlc === "TRUE");
  },
  steps: (d) => {
    const steps = parseInt(d.daily["Steps"] || 0);
    return steps >= 5000;
  },
  // Weekly goal checkers take an array of days in that week
  reading: (weekData) => {
    let totalMins = 0;
    weekData.forEach(d => {
      totalMins += parseInt(d.daily["Reading Minutes"] || 0);
    });
    return totalMins >= 60;
  },
  rehit: (weekData) => {
    let sessions = 0;
    weekData.forEach(d => {
      if (d.daily["REHIT 2x10"] && d.daily["REHIT 2x10"] !== "") sessions++;
    });
    return sessions >= 3;
  }
};

// Update section titles with streak badges
function updateSectionStreaks() {
  if (!chartDataCache || chartDataCache.length === 0) return;

  // Daily goals - show streak if 3+ days
  const dailyGoals = [
    { id: 'hydrationSection', checker: goalCheckers.water, name: 'Water' },
    { id: 'movementSection', checker: goalCheckers.movement, name: 'Movement' },
    { id: 'mealsSection', checker: goalCheckers.meals, name: 'Meals' },
    { id: 'stepsSection', checker: goalCheckers.steps, name: 'Steps' }
  ];

  dailyGoals.forEach(goal => {
    const streak = calculateDailyGoalStreak(goal.checker);
    const section = document.getElementById(goal.id);
    if (section && streak >= 3) {
      const nameEl = section.querySelector('.sec-name');
      if (nameEl && !nameEl.querySelector('.streak-badge')) {
        nameEl.innerHTML = `${goal.name} <span class="streak-badge">🔥 ${streak}-day streak</span>`;
      }
    }
  });

  // Weekly goals - show streak if 3+ weeks
  const weeklyGoals = [
    { id: 'mentalHabitsSection', checker: goalCheckers.reading, name: 'Reading' },
    { id: 'fitnessSection', checker: goalCheckers.rehit, name: 'Fitness' }
  ];

  weeklyGoals.forEach(goal => {
    const streak = calculateWeeklyGoalStreak(goal.checker);
    const section = document.getElementById(goal.id);
    if (section && streak >= 3) {
      const nameEl = section.querySelector('.sec-name');
      if (nameEl && !nameEl.querySelector('.streak-badge')) {
        const currentName = nameEl.textContent.split(' ')[0]; // Keep original name
        nameEl.innerHTML = `${currentName} <span class="streak-badge">🔥 ${streak}-week streak</span>`;
      }
    }
  });
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
  const subtitle = document.getElementById("biomarkersSubtitle");
  let apiDef = [], apiValues = [], apiDate = null;

  try {
    console.log("Loading biomarkers...");
    const result = await apiGet("biomarkers_load", { _t: Date.now() });
    console.log("Biomarkers result:", result);

    if (!result?.error) {
      apiDef = result.definition || [];
      apiValues = result.latestValues || [];
      apiDate = result.latestDate || null;
    }
  } catch (err) {
    console.error("Failed to load biomarkers from API:", err);
  }

  // Update subtitle: use API date if available, otherwise fall back to history
  if (subtitle) {
    if (apiDate) {
      const d = new Date(apiDate);
      subtitle.textContent = `Most recent: ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else if (BIOMARKER_HISTORY_DATES && BIOMARKER_HISTORY_DATES.length > 0) {
      subtitle.textContent = `Most recent: ${BIOMARKER_HISTORY_DATES[0]}`;
    } else {
      subtitle.textContent = "No data yet";
    }
  }

  renderBiomarkersTable(apiDef, apiValues);
}

// Biomarker definitions organized by category
const BIOMARKER_DEFS = [
  { cat: "Metabolic Health", icon: "🔬", markers: [
    { name: "Fasting Glucose", range: "70–110 mg/dL", low: 70, high: 110, unit: "mg/dL", desc: "Measures blood sugar at a single moment after fasting; helps detect early dysregulation before diabetes develops" },
    { name: "HbA1c", range: "4.4–6.4 %", low: 4.4, high: 6.4, unit: "%", desc: "Reflects average blood sugar over the prior ~3 months; key marker for long-term glucose exposure and diabetes risk" },
    { name: "Fasting Insulin", range: "2–10 µIU/mL", low: 2, high: 10, unit: "µIU/mL", desc: "Shows how hard the body must work to keep glucose normal; elevated levels signal insulin resistance years before diabetes" },
    { name: "eAG", range: "<117 mg/dL", low: 70, high: 117, unit: "mg/dL", desc: "Estimated average glucose translated from HbA1c into daily-life units; useful for intuitive understanding of A1c" }
  ]},
  { cat: "Kidney Function", icon: "🫘", markers: [
    { name: "BUN", range: "5–25 mg/dL", low: 5, high: 25, unit: "mg/dL", desc: "Measures nitrogen waste in blood; influenced by kidney function, hydration, and protein intake" },
    { name: "Creatinine", range: "0.60–1.30 mg/dL", low: 0.60, high: 1.30, unit: "mg/dL", desc: "Primary marker of kidney filtration; higher levels suggest reduced kidney clearance or high muscle mass" },
    { name: "eGFR", range: "≥60 mL/min/1.73m²", low: 60, high: 120, unit: "mL/min", desc: "Calculated estimate of overall kidney filtering capacity; tracks kidney health over time" }
  ]},
  { cat: "Electrolytes & Minerals", icon: "⚡", markers: [
    { name: "Sodium", range: "135–146 mmol/L", low: 135, high: 146, unit: "mmol/L", desc: "Regulates fluid balance, blood pressure, and nerve signaling; tightly controlled by kidneys and hormones" },
    { name: "Potassium", range: "3.5–5.0 mmol/L", low: 3.5, high: 5.0, unit: "mmol/L", desc: "Essential for heart rhythm and muscle contraction; abnormalities can affect cardiac stability" },
    { name: "Chloride", range: "96–112 mmol/L", low: 96, high: 112, unit: "mmol/L", desc: "Works with sodium to maintain fluid balance and acid-base equilibrium" },
    { name: "CO2 (Bicarbonate)", range: "21–32 mmol/L", low: 21, high: 32, unit: "mmol/L", desc: "Reflects acid-base balance and metabolic function; low levels may suggest metabolic stress" },
    { name: "Calcium", range: "8.5–10.7 mg/dL", low: 8.5, high: 10.7, unit: "mg/dL", desc: "Important for bone strength, muscle contraction, nerve transmission, and hormone signaling" }
  ]},
  { cat: "Liver Function", icon: "🫁", markers: [
    { name: "ALT (SGPT)", range: "≤45 U/L", low: 0, high: 45, unit: "U/L", desc: "Most liver-specific enzyme; elevations suggest liver inflammation or fat-related liver stress" },
    { name: "AST (SGOT)", range: "8–42 U/L", low: 8, high: 42, unit: "U/L", desc: "Found in liver and muscle; helps interpret liver results in context of exercise or injury" },
    { name: "Alkaline Phosphatase", range: "39–139 IU/L", low: 39, high: 139, unit: "IU/L", desc: "Linked to bile flow and bone turnover; elevations may indicate liver or bone conditions" },
    { name: "Total Bilirubin", range: "0.3–1.2 mg/dL", low: 0.3, high: 1.2, unit: "mg/dL", desc: "Measures liver processing of red blood cells; mild elevations can be benign or genetic" },
    { name: "GGT", range: "9–48 U/L", low: 9, high: 48, unit: "U/L", desc: "Early and sensitive marker of liver stress, alcohol sensitivity, and cardiometabolic risk" }
  ]},
  { cat: "Proteins & Nutrition", icon: "🥩", markers: [
    { name: "Total Protein", range: "6.0–8.3 g/dL", low: 6.0, high: 8.3, unit: "g/dL", desc: "Measures total circulating proteins involved in immunity, transport, and nutrition" },
    { name: "Albumin", range: "3.5–5.0 g/dL", low: 3.5, high: 5.0, unit: "g/dL", desc: "Key blood protein reflecting liver function, nutritional status, and systemic inflammation" }
  ]},
  { cat: "Lipid & Lipoproteins", icon: "❤️", markers: [
    { name: "Total Cholesterol", range: "120–200 mg/dL", low: 120, high: 200, unit: "mg/dL", desc: "Overall cholesterol burden; limited alone but useful for trend tracking" },
    { name: "Triglycerides", range: "50–150 mg/dL", low: 50, high: 150, unit: "mg/dL", desc: "Reflects fat metabolism and insulin sensitivity; often elevated in metabolic dysfunction" },
    { name: "HDL-C", range: "40–72 mg/dL", low: 40, high: 72, unit: "mg/dL", desc: "Involved in cholesterol transport away from arteries; higher levels generally protective" },
    { name: "LDL-C", range: "62–129 mg/dL", low: 62, high: 129, unit: "mg/dL", desc: "Traditional cholesterol marker associated with plaque formation; incomplete without particle data" },
    { name: "Chol/HDL Ratio", range: "≤4.9", low: 0, high: 4.9, unit: "", desc: "Total cholesterol divided by HDL; lower ratios indicate better cardiovascular risk profile" },
    { name: "Apolipoprotein B", range: "<90 mg/dL", low: 30, high: 90, unit: "mg/dL", desc: "Counts total atherogenic particles that cause plaque; strongest single lipid predictor of heart disease" },
    { name: "Lipoprotein(a)", range: "<30 mg/dL", low: 0, high: 30, unit: "mg/dL", desc: "Genetically determined LDL-like particle; major inherited risk factor for premature heart disease" }
  ]},
  { cat: "Inflammation & Vascular Risk", icon: "🔥", markers: [
    { name: "hsCRP", range: "0.1–0.9 mg/L", low: 0.1, high: 0.9, unit: "mg/L", desc: "Measures chronic low-grade inflammation that contributes to atherosclerosis and heart events" },
    { name: "Homocysteine", range: "5–15 µmol/L", low: 5, high: 15, unit: "µmol/L", desc: "Amino acid linked to endothelial damage and vascular risk when elevated" }
  ]},
  { cat: "Complete Blood Count", icon: "🩸", markers: [
    { name: "WBC", range: "4.6–12.4 K/cmm", low: 4.6, high: 12.4, unit: "K/cmm", desc: "White blood cell count; measures immune cells that fight infection and disease" },
    { name: "RBC", range: "3.98–5.64 M/cmm", low: 3.98, high: 5.64, unit: "M/cmm", desc: "Red blood cell count; measures cells that carry oxygen throughout the body" },
    { name: "Hemoglobin", range: "12.8–17.4 g/dL", low: 12.8, high: 17.4, unit: "g/dL", desc: "Oxygen-carrying protein in red blood cells; low levels indicate anemia" },
    { name: "Hematocrit", range: "36.6–49.4 %", low: 36.6, high: 49.4, unit: "%", desc: "Percentage of blood volume made up of red blood cells; reflects hydration and oxygen capacity" },
    { name: "MCV", range: "78.9–101.0 fL", low: 78.9, high: 101.0, unit: "fL", desc: "Mean corpuscular volume; average size of red blood cells; helps classify types of anemia" },
    { name: "MCHC", range: "32.0–36.2 g/dL", low: 32.0, high: 36.2, unit: "g/dL", desc: "Mean corpuscular hemoglobin concentration; average hemoglobin concentration in red blood cells" },
    { name: "RDW", range: "12.2–16.4 %", low: 12.2, high: 16.4, unit: "%", desc: "Red cell distribution width; measures variation in red blood cell size; high values may indicate nutritional deficiencies" },
    { name: "Platelets", range: "150–440 K/cmm", low: 150, high: 440, unit: "K/cmm", desc: "Cell fragments essential for blood clotting; abnormal levels affect bleeding and clot risk" },
    { name: "MPV", range: "9.04–12.79 fL", low: 9.04, high: 12.79, unit: "fL", desc: "Mean platelet volume; average size of platelets; may indicate platelet production rate" },
    { name: "nRBCs", range: "0 /100", low: 0, high: 0, unit: "/100", desc: "Nucleated red blood cells; immature red cells normally absent in adults; presence may indicate bone marrow stress or blood disorders" },
    { name: "Ferritin", range: "30–400 ng/mL", low: 30, high: 400, unit: "ng/mL", desc: "Reflects iron storage; high levels may indicate inflammation or excess iron" }
  ]},
  { cat: "White Cell Differential", icon: "🔬", markers: [
    { name: "Neutrophils %", range: "39–83 %", low: 39, high: 83, unit: "%", desc: "Most abundant white blood cells; first responders to bacterial infections" },
    { name: "Lymphocytes %", range: "11–45 %", low: 11, high: 45, unit: "%", desc: "Immune cells including T and B cells; key for viral defense and antibody production" },
    { name: "Monocytes %", range: "5–12 %", low: 5, high: 12, unit: "%", desc: "Large white blood cells that become macrophages; help clean up infections and dead cells" },
    { name: "Eosinophils %", range: "0–10 %", low: 0, high: 10, unit: "%", desc: "White blood cells involved in allergic responses and parasitic infections" },
    { name: "Basophils %", range: "0–2 %", low: 0, high: 2, unit: "%", desc: "Rarest white blood cells; involved in allergic reactions and inflammation" },
    { name: "Absolute Neutrophils", range: "1.8–8.6 K/cmm", low: 1.8, high: 8.6, unit: "K/cmm", desc: "Absolute count of neutrophils; more precise than percentage for assessing infection risk" },
    { name: "Absolute Lymphocytes", range: "0.8–3.5 K/cmm", low: 0.8, high: 3.5, unit: "K/cmm", desc: "Absolute count of lymphocytes; important for immune function assessment" },
    { name: "Absolute Monocytes", range: "0.3–1.0 K/cmm", low: 0.3, high: 1.0, unit: "K/cmm", desc: "Absolute count of monocytes; elevated in chronic infections and inflammatory conditions" },
    { name: "Absolute Eosinophils", range: "0.0–0.7 K/cmm", low: 0.0, high: 0.7, unit: "K/cmm", desc: "Absolute count of eosinophils; elevated in allergies, asthma, and parasitic infections" },
    { name: "Absolute Basophils", range: "0.0–0.1 K/cmm", low: 0.0, high: 0.1, unit: "K/cmm", desc: "Absolute count of basophils; rarely elevated outside of specific blood disorders" },
    { name: "IG %", range: "0–1 %", low: 0, high: 1, unit: "%", desc: "Immature granulocytes percentage; early-stage white blood cells; elevated levels may indicate infection or bone marrow response" },
    { name: "IG ABS", range: "0.0–0.1 K/cmm", low: 0.0, high: 0.1, unit: "K/cmm", desc: "Absolute count of immature granulocytes; useful marker for early detection of infection or inflammation" }
  ]},
  { cat: "Hormones & Endocrine", icon: "⚙️", markers: [
    { name: "TSH", range: "0.35–5.00 µIU/mL", low: 0.35, high: 5.00, unit: "µIU/mL", desc: "Thyroid stimulating hormone; regulates metabolism, energy, and body temperature; primary screening test for thyroid function" },
    { name: "Total Testosterone", range: "300–1000 ng/dL", low: 300, high: 1000, unit: "ng/dL", desc: "Measures overall testosterone production; baseline helps detect age-related decline" },
    { name: "SHBG", range: "10–57 nmol/L", low: 10, high: 57, unit: "nmol/L", desc: "Binding protein that controls how much testosterone is biologically available" },
    { name: "Free Testosterone", range: "5–20 ng/dL", low: 5, high: 20, unit: "ng/dL", desc: "Active fraction of testosterone that affects energy, muscle, mood, and metabolism" },
    { name: "Estradiol (E2)", range: "10–40 pg/mL", low: 10, high: 40, unit: "pg/mL", desc: "Primary estrogen in men; affects fat distribution, cardiovascular risk, and libido" },
    { name: "Cortisol (AM)", range: "6–23 µg/dL", low: 6, high: 23, unit: "µg/dL", desc: "Main stress hormone; abnormal levels can affect sleep, blood pressure, and metabolism" },
    { name: "DHEA-S", range: "80–560 µg/dL", low: 80, high: 560, unit: "µg/dL", desc: "Adrenal hormone associated with stress resilience, immune health, and aging trajectory" }
  ]},
  { cat: "Vitamins & Longevity", icon: "☀️", markers: [
    { name: "Vitamin D (25-OH)", range: "30–96 ng/mL", low: 30, high: 96, unit: "ng/mL", desc: "Regulates calcium absorption, immune function, and mood; deficiency is common and linked to many chronic diseases" }
  ]}
];

// Historical biomarker data (dates newest → oldest)
const BIOMARKER_HISTORY_DATES = ["2/3/26", "11/11/24", "12/19/22", "8/9/21", "12/2/15", "5/2/14"];
const BIOMARKER_HISTORY = {
  // Metabolic Health
  "Fasting Glucose":      [89, 104, 105, 102, 95, 81],
  "HbA1c":                [5.2, null, 4.9, null, null, null],
  "Fasting Insulin":      [null, null, null, null, null, null],
  "eAG":                  [103, null, 94, null, null, null],
  // Kidney Function
  "BUN":                  [18, 17, 13, 19, 21, 14],
  "Creatinine":           [1.21, 1.1, 1, 1.11, 1.14, 0.97],
  "eGFR":                 [76, 85, null, 83, null, null],
  // Electrolytes
  "Sodium":               [141, 141, 141, 140, 138, 138],
  "Potassium":            [4.1, 4.4, 4.4, 4.8, 4.5, 4.2],
  "Chloride":             [105, 109, 109, 106, 105, 103],
  "CO2 (Bicarbonate)":    [22, 24, 26, 25, 26, 27],
  "Calcium":              [9.7, 9.6, 9.9, 10.5, 10, 9.2],
  // Liver Function
  "ALT (SGPT)":           [24, 20, 16, 26, 20, 17],
  "AST (SGOT)":           [23, 19, 19, 21, 23, 19],
  "Alkaline Phosphatase": [58, 51, 43, 54, 52, 42],
  "Total Bilirubin":      [0.5, 0.5, 0.7, 0.6, 1.1, 0.7],
  "GGT":                  [null, null, null, null, null, null],
  // Proteins
  "Total Protein":        [8.1, 7.6, 7.7, 8.4, 8, 7.2],
  "Albumin":              [5.1, 4.6, 4.6, 4.8, 4.9, 4.4],
  // Lipids
  "Total Cholesterol":    [163, 169, 181, 193, 185, null],
  "Triglycerides":        [70, 120, 73, 133, 51, null],
  "HDL-C":                [54, 50, 53, 54, 59, null],
  "LDL-C":                [95, 95, 113, 112, 116, null],
  "Chol/HDL Ratio":       [3.0, null, null, null, null, null],
  "Apolipoprotein B":     [null, null, null, null, null, null],
  "Lipoprotein(a)":       [null, null, null, null, null, null],
  // Inflammation
  "hsCRP":                [null, 1.6, null, null, null, null],
  "Homocysteine":         [null, null, null, null, null, null],
  // Complete Blood Count
  "WBC":                  [6.4, null, null, null, null, null],
  "RBC":                  [5.36, null, null, null, null, null],
  "Hemoglobin":           [16.5, null, null, null, null, null],
  "Hematocrit":           [48.5, null, null, null, null, null],
  "MCV":                  [90.5, null, null, null, null, null],
  "MCHC":                 [34.1, null, null, null, null, null],
  "RDW":                  [12.8, null, null, null, null, null],
  "Platelets":            [259, null, null, null, null, null],
  "MPV":                  [8.4, null, null, null, null, null],
  "nRBCs":                [0, null, null, null, null, null],
  "Ferritin":             [null, null, null, null, null, null],
  // White Cell Differential
  "Neutrophils %":        [50, null, null, null, null, null],
  "Lymphocytes %":        [40, null, null, null, null, null],
  "Monocytes %":          [7, null, null, null, null, null],
  "Eosinophils %":        [2, null, null, null, null, null],
  "Basophils %":          [1, null, null, null, null, null],
  "Absolute Neutrophils": [3.2, null, null, null, null, null],
  "Absolute Lymphocytes": [2.6, null, null, null, null, null],
  "Absolute Monocytes":   [0.5, null, null, null, null, null],
  "Absolute Eosinophils": [0.1, null, null, null, null, null],
  "Absolute Basophils":   [0.1, null, null, null, null, null],
  "IG %":                 [0, null, null, null, null, null],
  "IG ABS":               [0, null, null, null, null, null],
  // Hormones
  "TSH":                  [0.86, null, null, null, null, null],
  "Total Testosterone":   [null, null, null, 585, null, null],
  "SHBG":                 [null, null, null, 32, null, null],
  "Free Testosterone":    [null, null, null, 134.4, null, null],
  "Estradiol (E2)":       [null, null, null, null, null, null],
  "Cortisol (AM)":        [null, null, null, null, null, null],
  "DHEA-S":               [null, null, null, null, null, null],
  // Vitamins
  "Vitamin D (25-OH)":    [39.1, null, null, null, null, null]
};

function renderBiomarkersTable(definition, latestValues) {
  const table = document.getElementById("biomarkersTable");
  if (!table) return;

  // Build a lookup from API values by biomarker name
  const valueLookup = {};
  if (definition && latestValues) {
    definition.forEach((item, idx) => {
      valueLookup[item.biomarker] = latestValues[idx] || '';
    });
  }

  // Fall back to hardcoded history for any marker not in API lookup
  for (const [name, values] of Object.entries(BIOMARKER_HISTORY)) {
    if (!valueLookup[name]) {
      // Find first non-null value (most recent)
      const latest = values.find(v => v != null);
      if (latest != null) valueLookup[name] = String(latest);
    }
  }

  table.innerHTML = "";
  let inputIdx = 0;

  BIOMARKER_DEFS.forEach(cat => {
    const catDiv = document.createElement("div");
    catDiv.className = "bio-category";

    let markersHTML = '';
    cat.markers.forEach(m => {
      const prev = valueLookup[m.name] || '';
      const prevNum = parseFloat(prev);
      const hasPrev = prev !== '' && !isNaN(prevNum);

      // Calculate bar percentages and bubble position
      const barRange = m.high - m.low;
      const barPadding = barRange * 0.3; // 30% padding on each side
      const barMin = Math.max(0, m.low - barPadding);
      const barMax = m.high + barPadding;
      const barTotal = barMax - barMin;
      const lowPct = ((m.low - barMin) / barTotal) * 100;
      const normalPct = ((m.high - m.low) / barTotal) * 100;

      let bubbleHTML = '';
      if (hasPrev) {
        const clampedVal = Math.max(barMin, Math.min(barMax, prevNum));
        const bubblePct = ((clampedVal - barMin) / barTotal) * 100;
        const inRange = prevNum >= m.low && prevNum <= m.high;
        const rangeClass = inRange ? 'in-range' : 'out-range';
        bubbleHTML = `<div class="bio-bubble-wrap" style="left:${bubblePct}%"><div class="bio-bubble ${rangeClass}">${prev}</div><div class="bio-bubble-arrow"></div></div>`;
      }

      // Check if most recent date has a value (first element in history array)
      const historyArr = BIOMARKER_HISTORY[m.name] || [];
      const mostRecentValue = historyArr[0];
      const hasRecentData = mostRecentValue != null;

      markersHTML += `
        <div class="bio-card${!hasRecentData ? ' no-data' : ''}">
          <div class="bio-card-top">
            <div class="bio-name" data-marker="${m.name}">${m.name}</div>
            ${!hasRecentData ? '<span class="bio-no-data-badge">No Data</span>' : ''}
          </div>
          <div class="bio-range-text">Normal: ${m.range}</div>
          <div class="bio-desc">${m.desc}</div>
          <div style="position:relative;margin-bottom:2px;padding-top:${hasPrev ? '30' : '0'}px">
            <div class="bio-bar-wrap">
              <div class="bio-bar-low" style="width:${lowPct}%"></div>
              <div class="bio-bar-normal" style="width:${normalPct}%"></div>
              <div class="bio-bar-high"></div>
              ${bubbleHTML}
            </div>
          </div>
          <div class="bio-bar-labels"><span class="bio-bar-label">${m.low}</span><span class="bio-bar-label">${m.high}</span></div>
          <div class="bio-input-row">
            <span class="bio-input-label">New result:</span>
            <input type="text" inputmode="decimal" class="bio-input biomarker-input" data-index="${inputIdx}" data-name="${m.name}" placeholder="${hasPrev ? prev : '—'}">
          </div>
        </div>`;
      inputIdx++;
    });

    catDiv.innerHTML = `
      <div class="bio-cat-header">
        <span class="bio-cat-icon">${cat.icon}</span>
        <span class="bio-cat-name">${cat.cat}</span>
        <span class="bio-cat-toggle">▼</span>
      </div>
      <div class="bio-cat-body">${markersHTML}</div>`;

    table.appendChild(catDiv);
  });

  // Wire category collapse toggles
  table.querySelectorAll('.bio-cat-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
      header.nextElementSibling.classList.toggle('collapsed');
    });
  });

  // Wire biomarker name clicks to open history chart
  table.querySelectorAll('.bio-name').forEach(el => {
    el.addEventListener('click', () => {
      openBioHistory(el.dataset.marker);
    });
  });

  // Setup submit button
  const submitBtn = document.getElementById("biomarkersSubmitBtn");
  if (submitBtn) {
    submitBtn.onclick = saveBiomarkers;
  }

  // Setup export button
  const exportBtn = document.getElementById("biomarkersExportBtn");
  if (exportBtn) {
    exportBtn.onclick = exportBiomarkersCSV;
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

// Export biomarkers to CSV
function exportBiomarkersCSV() {
  const mostRecentDate = BIOMARKER_HISTORY_DATES[0] || "unknown";

  // Abbreviation mappings for common biomarkers
  const abbreviations = {
    "Fasting Glucose": "Gluc",
    "HbA1c": "A1c",
    "Fasting Insulin": "Insulin",
    "eAG": "eAG",
    "BUN": "BUN",
    "Creatinine": "Creat",
    "eGFR": "eGFR",
    "Sodium": "Na",
    "Potassium": "K",
    "Chloride": "Cl",
    "CO2 (Bicarbonate)": "CO2",
    "Calcium": "Ca",
    "ALT (SGPT)": "ALT",
    "AST (SGOT)": "AST",
    "Alkaline Phosphatase": "ALP",
    "Total Bilirubin": "T Bili",
    "GGT": "GGT",
    "Total Protein": "TP",
    "Albumin": "Alb",
    "Total Cholesterol": "Chol",
    "Triglycerides": "Trig",
    "HDL-C": "HDL",
    "LDL-C": "LDL",
    "Chol/HDL Ratio": "Chol/HDL",
    "Apolipoprotein B": "ApoB",
    "Lipoprotein(a)": "Lp(a)",
    "hsCRP": "hsCRP",
    "Homocysteine": "Hcy",
    "WBC": "WBC",
    "RBC": "RBC",
    "Hemoglobin": "Hgb",
    "Hematocrit": "Hct",
    "MCV": "MCV",
    "MCHC": "MCHC",
    "RDW": "RDW",
    "Platelets": "Plt",
    "MPV": "MPV",
    "nRBCs": "nRBCs",
    "Ferritin": "Ferr",
    "Neutrophils %": "Neut %",
    "Lymphocytes %": "Lymph %",
    "Monocytes %": "Mono %",
    "Eosinophils %": "Eos %",
    "Basophils %": "Baso %",
    "Absolute Neutrophils": "ANC",
    "Absolute Lymphocytes": "ALC",
    "Absolute Monocytes": "AMC",
    "Absolute Eosinophils": "AEC",
    "Absolute Basophils": "ABC",
    "IG %": "IG %",
    "IG ABS": "IG ABS",
    "TSH": "TSH",
    "Total Testosterone": "Total T",
    "SHBG": "SHBG",
    "Free Testosterone": "Free T",
    "Estradiol (E2)": "E2",
    "Cortisol (AM)": "Cortisol",
    "DHEA-S": "DHEA-S",
    "Vitamin D (25-OH)": "Vit D"
  };

  // Build CSV rows
  const rows = [["Abbreviation", "Full Name", "Category", "Value", "Unit", "Reference Range"]];

  BIOMARKER_DEFS.forEach(cat => {
    cat.markers.forEach(m => {
      const history = BIOMARKER_HISTORY[m.name] || [];
      const latestValue = history[0];
      const abbrev = abbreviations[m.name] || m.name;

      // Only include if there's a value
      if (latestValue != null) {
        rows.push([
          abbrev,
          m.name,
          cat.cat,
          latestValue,
          m.unit,
          m.range
        ]);
      }
    });
  });

  // Convert to CSV string
  const csvContent = rows.map(row =>
    row.map(cell => {
      // Escape quotes and wrap in quotes if contains comma or quote
      const str = String(cell);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\n');

  // Create and download file
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `biomarkers_${mostRecentDate.replace(/\//g, '-')}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Biomarker history chart
let bioHistoryChart = null;

function openBioHistory(markerName) {
  // Find marker definition
  let markerDef = null;
  for (const cat of BIOMARKER_DEFS) {
    markerDef = cat.markers.find(m => m.name === markerName);
    if (markerDef) break;
  }
  if (!markerDef) return;

  const history = BIOMARKER_HISTORY[markerName] || [];
  const dates = BIOMARKER_HISTORY_DATES;

  // Build data points (reverse to chronological order oldest → newest)
  const dataPoints = [];
  for (let i = dates.length - 1; i >= 0; i--) {
    if (history[i] != null) {
      dataPoints.push({ date: dates[i], value: history[i] });
    }
  }

  // Update modal header
  document.getElementById('bioHistoryTitle').textContent = markerName;
  document.getElementById('bioHistoryRange').textContent = 'Normal: ' + markerDef.range;

  // Render chart
  const canvas = document.getElementById('bioHistoryChart');
  const ctx = canvas.getContext('2d');
  const colors = getChartColors();

  if (bioHistoryChart) bioHistoryChart.destroy();

  if (dataPoints.length >= 2) {
    canvas.style.display = 'block';
    bioHistoryChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dataPoints.map(d => d.date),
        datasets: [{
          label: markerName,
          data: dataPoints.map(d => d.value),
          borderColor: '#6dd5ed',
          backgroundColor: 'rgba(109, 213, 237, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointBackgroundColor: dataPoints.map(d =>
            (d.value >= markerDef.low && d.value <= markerDef.high) ? '#52b788' : '#d4a017'
          ),
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          annotation: undefined
        },
        scales: {
          x: {
            ticks: { color: colors.text, maxRotation: 45, minRotation: 45, font: { size: 11 } },
            grid: { color: colors.grid }
          },
          y: {
            ticks: { color: colors.text, font: { size: 11 } },
            grid: { color: colors.grid }
          }
        }
      }
    });

    // Draw normal range band as a box annotation (manual approach via plugin)
    const yScale = bioHistoryChart.scales.y;
    if (yScale) {
      const origDraw = bioHistoryChart.draw.bind(bioHistoryChart);
      // We'll use the afterDraw hook instead
    }
  } else {
    canvas.style.display = 'none';
    if (bioHistoryChart) { bioHistoryChart.destroy(); bioHistoryChart = null; }
  }

  // Render history table (newest first)
  const tableEl = document.getElementById('bioHistoryTable');
  let tableHTML = '';
  for (let i = 0; i < dates.length; i++) {
    if (history[i] != null) {
      const inRange = history[i] >= markerDef.low && history[i] <= markerDef.high;
      tableHTML += `<div class="bio-history-row">
        <span class="bio-history-date">${dates[i]}</span>
        <span class="bio-history-val ${inRange ? 'in-range' : 'out-range'}">${history[i]} ${markerDef.unit}</span>
      </div>`;
    }
  }
  if (!tableHTML) tableHTML = '<div style="text-align:center;color:var(--text-muted);padding:12px;font-size:13px">No historical data</div>';
  tableEl.innerHTML = tableHTML;

  // Show modal
  document.getElementById('bioHistoryModal').classList.add('show');
}

window.closeBioHistory = function() {
  document.getElementById('bioHistoryModal').classList.remove('show');
  if (bioHistoryChart) { bioHistoryChart.destroy(); bioHistoryChart = null; }
};

// Click outside to close
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('bioHistoryModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeBioHistory();
    });
  }
});

// =====================================
// LOAD / SAVE
// =====================================
async function loadDataForCurrentDate(options = {}) {
  const dateStr = formatDateForAPI(currentDate);
  console.log("Loading data for", dateStr);

  // Reset daily goals celebration tracking when loading new date
  resetDailyGoalsAchieved();

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
  // Debug: log movement data being saved
  console.log("Saving movement data:", {
    morningType: payload.morningMovementType,
    morningDuration: payload.morningMovementDuration,
    afternoonType: payload.afternoonMovementType,
    afternoonDuration: payload.afternoonMovementDuration
  });

  // Cache locally wrapped in the format populateForm expects
  // readings, honeyDos, reflections, stories, carly, customSections go at top level
  const wrappedPayload = {
    daily: { ...payload },
    date: payload.date,
    readings: payload.readings || [],
    honeyDos: payload.honeyDos || [],
    reflections: payload.reflections || "",
    stories: payload.stories || "",
    carly: payload.carly || "",
    customSections: payload.customSections || {}
  };
  cacheDayLocally(payload.date, wrappedPayload);
  cacheSet(formatDateForAPI(currentDate), wrappedPayload);

  try {
    const saveResult = await apiPost("save", { data: payload });

    if (saveResult?.error) {
      console.error("Save error:", saveResult.message);
      await queueOfflineSave(payload);
      if (typeof showToast === 'function') showToast('Saved offline — will sync later', 'info');
      dataChanged = false;
      return;
    }

    console.log("💾 Saved successfully", saveResult);
    dataChanged = false;

    // Show success toast
    if (typeof showToast === 'function') showToast('Saved ✓', 'success');

    if ("sleepHours" in payload) {
      markSleepSaved();
    }

    // Don't force-reload after save — the UI already has the correct state.
    // Reloading would re-read API data with potentially different column names
    // and overwrite the UI, zeroing out fields like agua.

  } catch (err) {
    console.error("Save failed, queuing offline:", err);
    await queueOfflineSave(payload);
    if (typeof showToast === 'function') showToast('Saved offline — will sync later', 'info');
    dataChanged = false;
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

    // Agua (hydration glasses) - read from DOM to stay in sync with inline handlers
    agua: parseInt(document.getElementById("aguaCount")?.textContent) || 0,

    // Body
    weight: document.getElementById("weight")?.value || "",
    waist: document.getElementById("waist")?.value || "",
    leanMass: document.getElementById("leanMass")?.value || "",
    bodyFat: document.getElementById("bodyFat")?.value || "",
    boneMass: document.getElementById("boneMass")?.value || "",
    bodywater: document.getElementById("bodywater")?.value || "",

    // Blood Pressure
    systolic: document.getElementById("systolic")?.value || "",
    diastolic: document.getElementById("diastolic")?.value || "",
    heartRate: document.getElementById("heartRate")?.value || "",

    // Movement breaks (morning/afternoon)
    morningMovementType: document.getElementById("morningMovementType")?.value || "",
    morningMovementDuration: document.getElementById("morningMovementDuration")?.value || "",
    afternoonMovementType: document.getElementById("afternoonMovementType")?.value || "",
    afternoonMovementDuration: document.getElementById("afternoonMovementDuration")?.value || "",

    // Lists + text
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
    if (typeof window.updateRehitDots === 'function') window.updateRehitDots();
  });

  rehit3.addEventListener("change", () => {
    if (rehit3.checked && rehit2.checked) {
      rehit2.checked = false;
      syncCheckboxVisual(rehit2);
    }
    toggleRehitFields();
    if (typeof window.updateRehitDots === 'function') window.updateRehitDots();
  });
  
  // Initial state
  toggleRehitFields();
  
  console.log("✅ REHIT mutual exclusion wired");
}

// =====================================
// AGUA BUTTONS
// =====================================
function updateAguaDisplay() {
  const aguaCountEl = document.getElementById("aguaCount");
  if (aguaCountEl) aguaCountEl.textContent = String(aguaCount);
}

function setupAguaButtons() {
  // Agua buttons use inline onclick → window.handleAguaPlus/Minus
  // defined in an inline <script> in index.html (before the buttons).
  // Sync aguaCount from DOM in case it was changed before app.js loaded.
  const el = document.getElementById("aguaCount");
  if (el) aguaCount = parseInt(el.textContent) || 0;
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
  return BODY_FIELDS.some(f =>
    f.keys.some(k => {
      const v = daily[k];
      return v !== undefined && v !== null && v !== "";
    })
  );
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

  const weightVal = source["Weight (lbs)"] ?? source["Weight"] ?? source["weight"];
  const waistVal = source["Waist (in)"] ?? source["Waist"] ?? source["waist"];
  const leanVal = source["Lean Mass (lbs)"] ?? source["Lean Mass"] ?? source["leanMass"];
  const fatVal = source["Body Fat (lbs)"] ?? source["Body Fat"] ?? source["bodyFat"];
  const boneVal = source["Bone Mass (lbs)"] ?? source["Bone Mass"] ?? source["boneMass"];
  const bodywaterVal = source["Water (lbs)"] ?? source["bodywater"];

  const weightEl = document.getElementById("weight");
  const waistEl = document.getElementById("waist");
  const leanMassEl = document.getElementById("leanMass");
  const bodyFatEl = document.getElementById("bodyFat");
  const boneMassEl = document.getElementById("boneMass");
  const bodywaterEl = document.getElementById("bodywater");

  if (weightEl) weightEl.value = weightVal ?? "";
  if (waistEl) waistEl.value = waistVal ?? "";
  if (leanMassEl) leanMassEl.value = leanVal ?? "";
  if (bodyFatEl) bodyFatEl.value = fatVal ?? "";
  if (boneMassEl) boneMassEl.value = boneVal ?? "";
  if (bodywaterEl) bodywaterEl.value = bodywaterVal ?? "";

  // Track the loaded weight so weigh-in reminder can detect a NEW entry
  window._loadedWeight = weightVal ?? "";

  calculatePercentages();
}

function calculatePercentages() {
  const weight = parseFloat(document.getElementById("weight")?.value);
  if (!weight || weight <= 0) return;

  const fields = [
    { input: "leanMass", display: "leanMassPercent" },
    { input: "bodyFat", display: "bodyFatPercent" },
    { input: "boneMass", display: "boneMassPercent" },
    { input: "bodywater", display: "bodywaterPercent" }
  ];

  fields.forEach(({ input, display }) => {
    const val = parseFloat(document.getElementById(input)?.value);
    const el = document.getElementById(display);
    if (el) {
      el.textContent = (!isNaN(val) && val > 0) ? ((val / weight) * 100).toFixed(1) + '%' : '--';
    }
  });
}

// Wire up live percentage calculation on body input changes
['weight', 'leanMass', 'bodyFat', 'boneMass', 'bodywater'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', calculatePercentages);
});

// =====================================
// populateForm: set UI from sheet data
// =====================================
async function populateForm(data) {
  // NOTE: form.reset() was intentionally removed — every field is explicitly
  // set below, and reset() caused a race condition where checkboxes were
  // briefly cleared before the async body-carry-forward resolved, letting
  // syncAllChips() see them as unchecked and remove the chip .on class.

  // reset state
  readings = [];
  honeyDos = [];
  currentAverages = null;

  const d = data?.daily || null;

  // BODY CARRY-FORWARD:
  // if daily is missing OR daily exists but body is blank => carry forward
  // Prefer the worker's pre-calculated bodyCarryForward to avoid expensive API calls
  let bodySource = d;
  if (!hasAnyBodyData(d)) {
    const cf = data?.bodyCarryForward;
    if (cf && Object.keys(cf).length > 0) {
      bodySource = {
        "Weight (lbs)": cf.weight,
        "Waist": cf.waist,
        "Lean Mass (lbs)": cf.leanMass,
        "Body Fat (lbs)": cf.bodyFat,
        "Bone Mass (lbs)": cf.boneMass,
        "Water (lbs)": cf.waterLbs,
      };
    } else {
      bodySource = await getMostRecentBodyDaily(currentDate);
    }
  }

  updateAverages(data?.averages);

  // No daily data for this date
  if (!d) {
    aguaCount = 0;
    updateAguaDisplay();

    // Clear movement fields
    const morningTypeEl = document.getElementById("morningMovementType");
    const morningDurationEl = document.getElementById("morningMovementDuration");
    const afternoonTypeEl = document.getElementById("afternoonMovementType");
    const afternoonDurationEl = document.getElementById("afternoonMovementDuration");
    if (morningTypeEl) morningTypeEl.value = "";
    if (morningDurationEl) morningDurationEl.value = "";
    if (afternoonTypeEl) afternoonTypeEl.value = "";
    if (afternoonDurationEl) afternoonDurationEl.value = "";

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

  // Numbers (API column names ?? payload key names)
  const sleepEl = document.getElementById("sleepHours");
  if (sleepEl) sleepEl.value = d["Hours of Sleep"] ?? d["sleepHours"] ?? "";

  const stepsEl = document.getElementById("steps");
  if (stepsEl) stepsEl.value = d["Steps"] ?? d["steps"] ?? "";

  const fitnessEl = document.getElementById("fitnessScore");
  if (fitnessEl) fitnessEl.value = d["Fitness Score"] ?? d["fitnessScore"] ?? "";

  const caloriesEl = document.getElementById("calories");
  if (caloriesEl) caloriesEl.value = d["Calories"] ?? d["calories"] ?? "";

  const peakWattsEl = document.getElementById("peakWatts");
  if (peakWattsEl) peakWattsEl.value = d["Peak Watts"] ?? d["peakWatts"] ?? "";

  const wattSecondsEl = document.getElementById("wattSeconds");
  if (wattSecondsEl) wattSecondsEl.value = d["Watt Seconds"] ?? d["Watt-Seconds"] ?? d["wattSeconds"] ?? "";

  // Checkboxes (API column names ?? payload key names)
  setCheckbox("inhalerMorning", d["Grey's Inhaler Morning"] ?? d["Inhaler Morning"] ?? d["inhalerMorning"]);
  setCheckbox("inhalerEvening", d["Grey's Inhaler Evening"] ?? d["Inhaler Evening"] ?? d["inhalerEvening"]);
  setCheckbox("multiplication", d["5 min Multiplication"] ?? d["multiplication"]);

  // REHIT: check the right one based on value
  const rehitVal = d["REHIT 2x10"] ?? d["REHIT"] ?? d["rehit"] ?? "";
  setCheckbox("rehit2", rehitVal === "2x10" || rehitVal === true || rehitVal === "TRUE");
  setCheckbox("rehit3", rehitVal === "3x10");

  // Show REHIT fields if either is checked
  const rehitFields = document.getElementById("rehitFields");
  if (rehitFields) {
    const showRehit = rehitVal === "2x10" || rehitVal === "3x10" || rehitVal === true || rehitVal === "TRUE";
    rehitFields.style.display = showRehit ? "block" : "none";
  }

  setCheckbox("creatine", d["Creatine Chews"] ?? d["Creatine"] ?? d["creatine"]);
  setCheckbox("vitaminD", d["Vitamin D"] ?? d["vitaminD"]);
  setCheckbox("no2", d["NO2"] ?? d["no2"]);
  setCheckbox("psyllium", d["Psyllium Husk"] ?? d["Psyllium"] ?? d["psyllium"]);

  setCheckbox("breakfast", d["Breakfast"] ?? d["breakfast"]);
  setCheckbox("lunch", d["Lunch"] ?? d["lunch"]);
  setCheckbox("dinner", d["Dinner"] ?? d["dinner"]);

  setCheckbox("daySnacks", d["Healthy Day Snacks"] ?? d["Day Snacks"] ?? d["daySnacks"]);
  setCheckbox("nightSnacks", d["Healthy Night Snacks"] ?? d["Night Snacks"] ?? d["nightSnacks"]);
  setCheckbox("noAlcohol", d["No Alcohol"] ?? d["noAlcohol"]);

  setCheckbox("meditation", d["Meditation"] ?? d["meditation"]);

  // Agua counter
  aguaCount = parseInt(d["agua"] ?? d["Water"] ?? d["Water (glasses)"] ?? d["hydrationGood"], 10) || 0;
  updateAguaDisplay();

  // Body fields: use current day if present, else carry-forward source
  applyBodyFieldsFromDaily(bodySource);

  // Blood Pressure - load from current day's data
  const systolicEl = document.getElementById("systolic");
  if (systolicEl) systolicEl.value = d["Systolic"] ?? d["systolic"] ?? "";

  const diastolicEl = document.getElementById("diastolic");
  if (diastolicEl) diastolicEl.value = d["Diastolic"] ?? d["diastolic"] ?? "";

  const heartRateEl = document.getElementById("heartRate");
  if (heartRateEl) heartRateEl.value = d["Heart Rate"] ?? d["heartRate"] ?? "";

  // Trigger BP status calculation
  if (systolicEl?.value && diastolicEl?.value) {
    systolicEl.dispatchEvent(new Event("input"));
  }

  // Movement breaks (morning/afternoon) - read from daily data with server field names
  const morningTypeEl = document.getElementById("morningMovementType");
  const morningDurationEl = document.getElementById("morningMovementDuration");
  const afternoonTypeEl = document.getElementById("afternoonMovementType");
  const afternoonDurationEl = document.getElementById("afternoonMovementDuration");

  // Debug: log what we're loading
  console.log("Loading movement data:", {
    morningType: d?.["Morning Movement Type"],
    morningDuration: d?.["Morning Movement Duration"],
    afternoonType: d?.["Afternoon Movement Type"],
    afternoonDuration: d?.["Afternoon Movement Duration"],
    fullDaily: d
  });

  if (morningTypeEl) morningTypeEl.value = d?.["Morning Movement Type"] ?? d?.morningMovementType ?? "";
  if (morningDurationEl) morningDurationEl.value = d?.["Morning Movement Duration"] ?? d?.morningMovementDuration ?? "";
  if (afternoonTypeEl) afternoonTypeEl.value = d?.["Afternoon Movement Type"] ?? d?.afternoonMovementType ?? "";
  if (afternoonDurationEl) afternoonDurationEl.value = d?.["Afternoon Movement Duration"] ?? d?.afternoonMovementDuration ?? "";

  // Lists
  readings = (data?.readings || []).map(r => ({
    duration: r.duration ?? r["duration (min)"] ?? r["Duration"] ?? r["Duration (min)"],
    book: r.book ?? r["Book"] ?? r["book"]
  }));

  honeyDos = data?.honeyDos || [];

  if (readings.length > 0) {
    lastBookTitle = String(readings[readings.length - 1].book || "");
    localStorage.setItem('lastBookTitle', lastBookTitle);
  }

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

  try {
    const result = await apiGet("load", { date: dateStr });
    cacheSet(dateStr, result);
    // Also persist to IndexedDB for offline access
    if (result && !result.error) cacheDayLocally(dateStr, result);
    return result;
  } catch (err) {
    console.warn('Fetch failed, trying offline cache for', dateStr);
    const offlineData = await getCachedDay(dateStr);
    if (offlineData) {
      if (typeof showToast === 'function') showToast('Loaded from offline cache', 'info');
      return offlineData;
    }
    throw err;
  }
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
  // Movement inputs are now inline - wire up change handlers
  ['morningMovementType', 'morningMovementDuration', 'afternoonMovementType', 'afternoonMovementDuration'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        triggerSaveSoon();
        // Check for movement goal achievement when movement type changes
        if (id === 'morningMovementType' || id === 'afternoonMovementType') {
          checkMovementGoal();
        }
      });
    }
  });
  console.log("✅ Movement UI wired");
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
  window.openReadingModal();
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
    const time = r.time ?? r["time"] ?? "";

    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <span class="item-text">${duration} min — ${book}${time ? ' <span class="item-time">' + time + '</span>' : ''}</span>
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
