// =====================================
// CONFIG
// =====================================
const API_URL = "const API_URL = "https://script.google.com/macros/s/AKfycbwtzL8uj0geM3HmBIUScEhT_OAyi0I25Unbt4SsC0kfDbtonrGvmdzARdW7iuURg2D5sg/exec";
const API_KEY = "Q8xF3N9KpZ7J2WmC4A6YBVeH5R0TqLDSU1nXgE";

// =====================================
// API HELPERS
// =====================================
async function apiGet(action, params = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("key", API_KEY);

  Object.entries(params).forEach(([k, v]) =>
    url.searchParams.set(k, v)
  );

  const res = await fetch(url.toString(), { method: "GET" });
  return await res.json();
}

async function apiPost(action, payload = {}) {
  const body = new URLSearchParams();
  body.set("action", action);
  body.set("key", API_KEY);
  body.set("payload", JSON.stringify(payload));

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString()
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
  updateDateDisplay();
  loadDataForCurrentDate();
});

// =====================================
// CORE FUNCTIONS (YOU WILL EXPAND THESE)
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
    const result = await apiGet("load", { date: dateStr });

    if (result?.error) {
      console.error("Backend error:", result.message);
      return;
    }

    console.log("Data loaded:", result);
    // 👇 NEXT STEP: call populateForm(result)
  } catch (err) {
    console.error("Load failed:", err);
  }
}

async function saveData(payload) {
  try {
    const result = await apiPost("save", { data: payload });

    if (result?.error) {
      console.error("Save error:", result.message);
      return;
    }

    console.log("Saved successfully");
    dataChanged = false;
  } catch (err) {
    console.error("Save failed:", err);
  }
}

// =====================================
// UI PLACEHOLDERS (WIRE YOUR EXISTING CODE HERE)
// =====================================
function updateDateDisplay() {
  const el = document.getElementById("dateDisplay");
  if (!el) return;

  el.textContent = currentDate.toDateString();
}

