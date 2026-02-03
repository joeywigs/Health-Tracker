/**
 * Habit Tracker - Cloudflare Worker with KV Storage
 *
 * KV Structure:
 * - daily:{date} → { daily data for that date }
 * - movements:{date} → [ array of movements ]
 * - readings:{date} → [ array of readings ]
 * - biomarkers:definition → [ biomarker definitions ]
 * - biomarkers:values → { date: [...values], date2: [...values] }
 * - meta:lastWeekAverages → { cached averages }
 */

export default {
  async fetch(request, env) {
    const allowed = new Set([
      "https://joeywigs.github.io",
      "https://zxc-group1.gitlab.io",
      "http://localhost:3000"
    ]);
    const reqOrigin = request.headers.get("Origin");
    const origin = allowed.has(reqOrigin) ? reqOrigin : "https://zxc-group1.gitlab.io";

    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Check for KV binding
    if (!env.HABIT_DATA) {
      return jsonResponse({ error: true, message: "KV not configured" }, 500, corsHeaders);
    }

    try {
      if (request.method === "GET") {
        return await handleGet(request, env, corsHeaders);
      } else if (request.method === "POST") {
        return await handlePost(request, env, corsHeaders);
      } else {
        return jsonResponse({ error: true, message: "Method not allowed" }, 405, corsHeaders);
      }
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: true, message: err?.message || String(err) }, 500, corsHeaders);
    }
  },
};

// ===== GET Handlers =====
async function handleGet(request, env, corsHeaders) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action")?.toLowerCase() || "";

  if (action === "ping") {
    return jsonResponse({ ok: true, ts: new Date().toISOString(), storage: "kv" }, 200, corsHeaders);
  }

  if (action === "load") {
    const date = url.searchParams.get("date");
    if (!date) {
      return jsonResponse({ error: true, message: "Missing date" }, 400, corsHeaders);
    }
    return await loadDay(date, env, corsHeaders);
  }

  if (action === "biomarkers_load") {
    return await loadBiomarkers(env, corsHeaders);
  }

  return jsonResponse({ error: true, message: `Unknown action: ${action}` }, 400, corsHeaders);
}

// ===== POST Handlers =====
async function handlePost(request, env, corsHeaders) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));

  // Check action in URL params first, then body
  const action = (url.searchParams.get("action") || body.action || "").toLowerCase();

  if (action === "ping") {
    return jsonResponse({ ok: true, ts: new Date().toISOString(), via: "post" }, 200, corsHeaders);
  }

  if (action === "save") {
    if (!body.data) {
      return jsonResponse({ error: true, message: "Missing data" }, 400, corsHeaders);
    }
    return await saveDay(body.data, env, corsHeaders);
  }

  // iOS Shortcut endpoint - update just steps for today
  if (action === "steps") {
    const steps = body.steps;
    if (steps === undefined || steps === null) {
      return jsonResponse({ error: true, message: "Missing steps value", received: body }, 400, corsHeaders);
    }
    return await updateSteps(steps, body.date, env, corsHeaders);
  }

  if (action === "biomarkers_save") {
    if (!body.date || !body.values) {
      return jsonResponse({ error: true, message: "Missing date or values" }, 400, corsHeaders);
    }
    return await saveBiomarkers(body.date, body.values, env, corsHeaders);
  }

  return jsonResponse({ error: true, message: `Unknown action: ${action}`, received: body }, 400, corsHeaders);
}

// ===== Load Day =====
async function loadDay(dateStr, env, corsHeaders) {
  const normalizedDate = normalizeDate(dateStr);

  // Fetch all data for this day in parallel
  const [daily, movements, readings, honeyDos, customSections] = await Promise.all([
    env.HABIT_DATA.get(`daily:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`movements:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`readings:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`honeyDos:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`custom:${normalizedDate}`, "json"),
  ]);

  // Calculate averages
  const averages = await calculate7DayAverages(normalizedDate, env);

  // Get carry-forward body data if needed
  let bodyCarryForward = {};
  if (!daily || !daily["Weight (lbs)"]) {
    bodyCarryForward = await getLastBodyData(normalizedDate, env);
  }

  return jsonResponse({
    daily: daily || {},
    movements: movements || [],
    readings: readings || [],
    honeyDos: honeyDos || [],
    customSections: customSections || {},
    averages,
    bodyCarryForward,
  }, 200, corsHeaders);
}

// ===== Save Day =====
async function saveDay(data, env, corsHeaders) {
  const dateStr = data.date;
  if (!dateStr) {
    return jsonResponse({ error: true, message: "Missing date in data" }, 400, corsHeaders);
  }

  const normalizedDate = normalizeDate(dateStr);

  // Build daily data object
  const daily = {
    "Date": normalizedDate,
    "Hours of Sleep": data.sleepHours || "",
    "Grey's Inhaler Morning": data.inhalerMorning || false,
    "Grey's Inhaler Evening": data.inhalerEvening || false,
    "5 min Multiplication": data.multiplication || false,
    "Steps": data.steps || "",
    "REHIT 2x10": data.rehit || "",
    "Fitness Score": data.fitnessScore || "",
    "Peak Watts": data.peakWatts || "",
    "Watt Seconds": data.wattSeconds || "",
    "Calories": data.calories || "",
    "Water": data.agua ?? data.hydrationGood ?? data.water ?? 0,
    "Weight (lbs)": data.weight || "",
    "Waist": data.waist || "",
    "Lean Mass (lbs)": data.leanMass || "",
    "Body Fat (lbs)": data.bodyFat || "",
    "Bone Mass (lbs)": data.boneMass || "",
    "Water (lbs)": data.bodywater || data.waterLbs || "",
    "Systolic": data.systolic || "",
    "Diastolic": data.diastolic || "",
    "Heart Rate": data.heartRate || "",
    // Supplements
    "Creatine Chews": data.creatine || false,
    "Vitamin D": data.vitaminD || false,
    "NO2": data.no2 || false,
    "Psyllium Husk": data.psyllium || data.psylliumHusk || false,
    // Nutrition
    "Breakfast": data.breakfast || false,
    "Lunch": data.lunch || false,
    "Dinner": data.dinner || false,
    "Healthy Day Snacks": data.daySnacks || data.healthyDaySnacks || false,
    "Healthy Night Snacks": data.nightSnacks || data.healthyNightSnacks || false,
    "No Alcohol": data.noAlcohol || false,
    // Other
    "Meditation": data.meditation || false,
    "Reflections": data.reflections || "",
    "Stories": data.stories || "",
    "Carly": data.carly || "",
  };

  // Save all data in parallel
  const saves = [
    env.HABIT_DATA.put(`daily:${normalizedDate}`, JSON.stringify(daily)),
  ];

  // Save movements if provided
  if (data.movements && Array.isArray(data.movements)) {
    saves.push(env.HABIT_DATA.put(`movements:${normalizedDate}`, JSON.stringify(data.movements)));
  }

  // Save readings if provided
  if (data.readings && Array.isArray(data.readings)) {
    saves.push(env.HABIT_DATA.put(`readings:${normalizedDate}`, JSON.stringify(data.readings)));
  }

  // Save honeyDos if provided
  if (data.honeyDos && Array.isArray(data.honeyDos)) {
    saves.push(env.HABIT_DATA.put(`honeyDos:${normalizedDate}`, JSON.stringify(data.honeyDos)));
  }

  // Save custom sections if provided
  if (data.customSections && typeof data.customSections === 'object') {
    saves.push(env.HABIT_DATA.put(`custom:${normalizedDate}`, JSON.stringify(data.customSections)));
  }

  await Promise.all(saves);

  return jsonResponse({ success: true, date: normalizedDate }, 200, corsHeaders);
}

// ===== Update Steps (for iOS Shortcut) =====
async function updateSteps(steps, dateStr, env, corsHeaders) {
  // Use provided date or today
  const normalizedDate = dateStr ? normalizeDate(dateStr) : normalizeDate(formatDateForKV(new Date()));

  // Get existing daily data
  let daily = await env.HABIT_DATA.get(`daily:${normalizedDate}`, "json") || {};

  // Update just the steps field
  daily["Date"] = normalizedDate;
  daily["Steps"] = parseInt(steps, 10) || 0;

  // Save back
  await env.HABIT_DATA.put(`daily:${normalizedDate}`, JSON.stringify(daily));

  return jsonResponse({
    success: true,
    date: normalizedDate,
    steps: daily["Steps"],
    message: `Updated steps to ${daily["Steps"]} for ${normalizedDate}`
  }, 200, corsHeaders);
}

// ===== Calculate 7-Day Averages =====
async function calculate7DayAverages(dateStr, env) {
  const targetDate = parseDate(dateStr);
  targetDate.setHours(0, 0, 0, 0); // Normalize to midnight

  // Get week boundaries (Sun-Sat)
  const dayOfWeek = targetDate.getDay();
  const weekStart = new Date(targetDate);
  weekStart.setDate(targetDate.getDate() - dayOfWeek);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  // Last week boundaries
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(weekStart.getDate() - 7);
  lastWeekStart.setHours(0, 0, 0, 0);

  const lastWeekEnd = new Date(weekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
  lastWeekEnd.setHours(23, 59, 59, 999);

  // Collect data for this week and last week
  let sleepValues = [];
  let stepsValues = [];
  let rehitCount = 0;

  let lastWeekSleep = [];
  let lastWeekSteps = [];
  let lastWeekRehit = 0;

  // Fetch up to 14 days of data
  const dates = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    dates.push(normalizeDate(formatDateForKV(d)));
  }

  const dailyData = await Promise.all(
    dates.map(d => env.HABIT_DATA.get(`daily:${d}`, "json"))
  );

  dailyData.forEach((data, i) => {
    if (!data) return;

    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    d.setHours(12, 0, 0, 0); // Use noon to avoid any edge cases

    const isThisWeek = d >= weekStart && d <= weekEnd;
    const isLastWeek = d >= lastWeekStart && d <= lastWeekEnd;

    const sleep = parseFloat(data["Hours of Sleep"]);
    const steps = parseInt(data["Steps"], 10);
    const rehit = data["REHIT 2x10"];

    if (isThisWeek) {
      if (!isNaN(sleep) && sleep > 0) sleepValues.push(sleep);
      if (!isNaN(steps) && steps > 0) stepsValues.push(steps);
      // Exclude today (i===0) from rehitCount — the frontend adds today's
      // REHIT status separately so dots update instantly on checkbox toggle.
      if (i > 0 && rehit && rehit !== "") rehitCount++;
    }

    if (isLastWeek) {
      if (!isNaN(sleep) && sleep > 0) lastWeekSleep.push(sleep);
      if (!isNaN(steps) && steps > 0) lastWeekSteps.push(steps);
      if (rehit && rehit !== "") lastWeekRehit++;
    }
  });

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    sleep: avg(sleepValues),
    steps: stepsValues.length ? Math.round(avg(stepsValues)) : null,
    movements: null, // TODO: calculate from movements data
    rehitWeek: rehitCount,
    lastWeek: {
      sleep: avg(lastWeekSleep),
      steps: lastWeekSteps.length ? Math.round(avg(lastWeekSteps)) : null,
      movements: null,
      rehitWeek: lastWeekRehit,
    }
  };
}

// ===== Get Last Body Data (carry-forward) =====
async function getLastBodyData(dateStr, env) {
  const targetDate = parseDate(dateStr);

  // Look back up to 45 days
  for (let i = 1; i <= 45; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    const checkDate = normalizeDate(formatDateForKV(d));

    const data = await env.HABIT_DATA.get(`daily:${checkDate}`, "json");

    if (data && data["Weight (lbs)"]) {
      return {
        weight: data["Weight (lbs)"],
        waist: data["Waist"],
        leanMass: data["Lean Mass (lbs)"],
        bodyFat: data["Body Fat (lbs)"],
        boneMass: data["Bone Mass (lbs)"],
        waterLbs: data["Water (lbs)"],
        fromDate: checkDate,
      };
    }
  }

  return {};
}

// ===== Biomarkers =====
async function loadBiomarkers(env, corsHeaders) {
  const [definition, valuesData] = await Promise.all([
    env.HABIT_DATA.get("biomarkers:definition", "json"),
    env.HABIT_DATA.get("biomarkers:values", "json"),
  ]);

  // Get latest values
  let latestDate = "";
  let latestValues = [];

  if (valuesData) {
    const dates = Object.keys(valuesData).sort((a, b) => new Date(b) - new Date(a));
    if (dates.length > 0) {
      latestDate = dates[0];
      latestValues = valuesData[latestDate] || [];
    }
  }

  return jsonResponse({
    definition: definition || [],
    latestDate,
    latestValues,
  }, 200, corsHeaders);
}

async function saveBiomarkers(dateStr, values, env, corsHeaders) {
  // Get existing values
  let valuesData = await env.HABIT_DATA.get("biomarkers:values", "json") || {};

  // Add new values
  valuesData[dateStr] = values;

  await env.HABIT_DATA.put("biomarkers:values", JSON.stringify(valuesData));

  return jsonResponse({ success: true, date: dateStr }, 200, corsHeaders);
}

// ===== Helpers =====
function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeDate(dateStr) {
  // Convert various formats to M/D/YY
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

function parseDate(dateStr) {
  // Handle M/D/YY format
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    let year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;
    return new Date(year, parseInt(parts[0], 10) - 1, parseInt(parts[1], 10));
  }
  return new Date(dateStr);
}

function formatDateForKV(date) {
  // Use America/Chicago timezone (Central Time) to get the correct local date
  const options = { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric' };
  const localDate = new Date(date.toLocaleString('en-US', options));
  return `${localDate.getMonth() + 1}/${localDate.getDate()}/${String(localDate.getFullYear()).slice(-2)}`;
}
