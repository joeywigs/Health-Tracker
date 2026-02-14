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
 * - bedtime:items → [ array of bedtime routine items ]
 * - workouts:{date} → [ array of workouts for that date ]
 * - phases → [ array of phase configurations ]
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

  if (action === "bedtime_items_load") {
    return await loadBedtimeItems(env, corsHeaders);
  }

  if (action === "morning_items_load") {
    return await loadMorningItems(env, corsHeaders);
  }

  if (action === "habit_notes_load") {
    return await loadHabitNotes(env, corsHeaders);
  }

  if (action === "cue_logs_load") {
    return await loadCueLogs(env, corsHeaders);
  }

  if (action === "phases_load") {
    return await loadPhases(env, corsHeaders);
  }

  if (action === "habit_stacks_load") {
    return await loadHabitStacks(env, corsHeaders);
  }

  if (action === "settings_load") {
    return await loadSettings(env, corsHeaders);
  }


  // iOS Shortcut may send steps as GET
  if (action === "steps") {
    // Accept steps from ?steps=, ?value=, or ?count= query params
    const steps = url.searchParams.get("steps") ?? url.searchParams.get("value") ?? url.searchParams.get("count");
    if (steps === null || steps === undefined) {
      // Show all params received so user can debug their Shortcut
      const params = {};
      for (const [k, v] of url.searchParams.entries()) params[k] = v;
      return jsonResponse({ error: true, message: "Missing steps value. Send as ?action=steps&steps=12345", received: params }, 400, corsHeaders);
    }
    return await updateSteps(steps, url.searchParams.get("date"), env, corsHeaders);
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

  // iOS Shortcut endpoint - sync workout data
  if (action === "workout") {
    if (!body.workouts || !Array.isArray(body.workouts)) {
      return jsonResponse({ error: true, message: "Missing workouts array", received: body }, 400, corsHeaders);
    }
    return await syncWorkouts(body.workouts, body.date, env, corsHeaders);
  }


  // iOS Shortcut endpoint - sync body composition data
  if (action === "body") {
    return await logBody(body, env, corsHeaders);
  }

  if (action === "biomarkers_save") {
    if (!body.date || !body.values) {
      return jsonResponse({ error: true, message: "Missing date or values" }, 400, corsHeaders);
    }
    return await saveBiomarkers(body.date, body.values, env, corsHeaders);
  }

  if (action === "bedtime_items_save") {
    if (!body.items || !Array.isArray(body.items)) {
      return jsonResponse({ error: true, message: "Missing items array" }, 400, corsHeaders);
    }
    return await saveBedtimeItems(body.items, env, corsHeaders);
  }

  if (action === "morning_items_save") {
    if (!body.items || !Array.isArray(body.items)) {
      return jsonResponse({ error: true, message: "Missing items array" }, 400, corsHeaders);
    }
    return await saveMorningItems(body.items, env, corsHeaders);
  }

  if (action === "habit_notes_save") {
    if (!body.notes || !Array.isArray(body.notes)) {
      return jsonResponse({ error: true, message: "Missing notes array" }, 400, corsHeaders);
    }
    return await saveHabitNotes(body.notes, env, corsHeaders);
  }

  if (action === "cue_log_save") {
    if (!body.cueData) {
      return jsonResponse({ error: true, message: "Missing cueData" }, 400, corsHeaders);
    }
    return await saveCueLog(body.cueData, env, corsHeaders);
  }

  if (action === "phases_save") {
    if (!body.phases || !Array.isArray(body.phases)) {
      return jsonResponse({ error: true, message: "Missing phases array" }, 400, corsHeaders);
    }
    return await savePhases(body.phases, env, corsHeaders);
  }

  if (action === "migrate_movements") {
    return await migrateMovements(env, corsHeaders);
  }

  if (action === "audit_data") {
    return await auditData(env, corsHeaders);
  }

  if (action === "habit_stacks_save") {
    if (!body.stacks || !Array.isArray(body.stacks)) {
      return jsonResponse({ error: true, message: "Missing stacks array" }, 400, corsHeaders);
    }
    return await saveHabitStacks(body.stacks, env, corsHeaders);
  }

  if (action === "settings_save") {
    if (!body.settings || typeof body.settings !== 'object') {
      return jsonResponse({ error: true, message: "Missing settings object" }, 400, corsHeaders);
    }
    return await saveSettings(body.settings, env, corsHeaders);
  }

  return jsonResponse({ error: true, message: `Unknown action: ${action}`, received: body }, 400, corsHeaders);
}

// ===== Load Day =====
async function loadDay(dateStr, env, corsHeaders) {
  const normalizedDate = normalizeDate(dateStr);

  // Fetch all data for this day in parallel
  const [daily, movements, readings, honeyDos, customSections, workouts, dumbbellData] = await Promise.all([
    env.HABIT_DATA.get(`daily:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`movements:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`readings:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`honeyDos:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`custom:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`workouts:${normalizedDate}`, "json"),
    env.HABIT_DATA.get(`dumbbell:${normalizedDate}`, "json"),
  ]);

  // Calculate averages
  const averages = await calculate7DayAverages(normalizedDate, env);

  // Get carry-forward body data if needed
  let bodyCarryForward = {};
  if (!daily || !daily["Weight (lbs)"]) {
    bodyCarryForward = await getLastBodyData(normalizedDate, env);
  }

  // Get carry-forward dumbbell data if needed
  let dumbbellCarryForward = null;
  if (!dumbbellData || dumbbellData.length === 0) {
    dumbbellCarryForward = await getLastDumbbellData(normalizedDate, env);
  }

  return jsonResponse({
    daily: daily || {},
    movements: movements || [],
    readings: readings || [],
    honeyDos: honeyDos || [],
    customSections: customSections || {},
    workouts: workouts || [],
    dumbbell: dumbbellData || [],
    dumbbellCarryForward,
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

  // Read existing daily data so we merge rather than replace.
  // This preserves fields set by iOS Shortcuts (e.g. movement breaks)
  // that the web UI may not have loaded yet.
  const existing = await env.HABIT_DATA.get(`daily:${normalizedDate}`, "json") || {};

  // Purge zero values from body fields — zeros are never valid body measurements
  // and can get stuck in a loop (shortcut test → "0" string → autosave preserves it)
  ["Weight (lbs)", "Waist", "Lean Mass (lbs)", "Body Fat (lbs)", "Bone Mass (lbs)", "Water (lbs)"].forEach(k => {
    if (existing[k] === 0 || existing[k] === "0") delete existing[k];
  });

  // Build daily data object from the incoming payload
  const daily = {
    ...existing,
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
    "Weight (lbs)": ("weight" in data) ? (data.weight || "") : (existing["Weight (lbs)"] || ""),
    "Waist": ("waist" in data) ? (data.waist || "") : (existing["Waist"] || ""),
    "Lean Mass (lbs)": ("leanMass" in data) ? (data.leanMass || "") : (existing["Lean Mass (lbs)"] || ""),
    "Body Fat (lbs)": ("bodyFat" in data) ? (data.bodyFat || "") : (existing["Body Fat (lbs)"] || ""),
    "Bone Mass (lbs)": ("boneMass" in data) ? (data.boneMass || "") : (existing["Bone Mass (lbs)"] || ""),
    "Water (lbs)": ("bodywater" in data || "waterLbs" in data) ? (data.bodywater || data.waterLbs || "") : (existing["Water (lbs)"] || ""),
    "Systolic": data.systolic || existing["Systolic"] || "",
    "Diastolic": data.diastolic || existing["Diastolic"] || "",
    "Heart Rate": data.heartRate || existing["Heart Rate"] || "",
    // Supplements
    "Creatine Chews": data.creatine || false,
    "Vitamin D": data.vitaminD || false,
    "NO2": data.no2 || false,
    "Psyllium Husk": data.psyllium || data.psylliumHusk || false,
    "Zinc": data.zinc || false,
    "Prebiotic": data.prebiotic || false,
    // Nutrition
    "Breakfast": data.breakfast || false,
    "Lunch": data.lunch || false,
    "Dinner": data.dinner || false,
    "Healthy Day Snacks": data.daySnacks || data.healthyDaySnacks || false,
    "Healthy Night Snacks": data.nightSnacks || data.healthyNightSnacks || false,
    "No Alcohol": data.noAlcohol || false,
    // Other
    "Meditation": data.meditation || false,
    "Email Sprints": parseInt(data.emailSprints) || 0,
    "Reflections": data.reflections || "",
    "Stories": data.stories || "",
    "Carly": data.carly || "",
    // Grooming (Friday)
    "Grooming Haircut": data.groomingHaircut || false,
    "Grooming Beard Trim": data.groomingBeardTrim || false,
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

  // Save dumbbell exercises if provided
  if (data.dumbbell && Array.isArray(data.dumbbell)) {
    saves.push(env.HABIT_DATA.put(`dumbbell:${normalizedDate}`, JSON.stringify(data.dumbbell)));
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

// ===== Sync Workouts (for iOS Shortcut) =====
async function syncWorkouts(workouts, dateStr, env, corsHeaders) {
  // Use provided date or today
  const normalizedDate = dateStr ? normalizeDate(dateStr) : normalizeDate(formatDateForKV(new Date()));

  // Get existing workouts for this date
  let existing = await env.HABIT_DATA.get(`workouts:${normalizedDate}`, "json") || [];

  let skipped = 0;

  for (const workout of workouts) {
    // Parse startTime - Apple Shortcuts may send various formats
    let parsedStart = null;
    const rawStart = workout.startTime || workout.start;
    if (rawStart) {
      let d = new Date(rawStart);
      if (isNaN(d.getTime())) {
        const cleaned = String(rawStart).replace(/\s+at\s+/i, " ");
        d = new Date(cleaned);
      }
      if (!isNaN(d.getTime())) {
        parsedStart = d;
      }
    }
    if (!parsedStart) {
      parsedStart = new Date();
    }

    // Normalize workout data
    const normalized = {
      type: workout.type || workout.workoutType || 'Unknown',
      duration: workout.duration || workout.durationMinutes || 0,
      calories: workout.calories || workout.activeCalories || 0,
      startTime: parsedStart.toISOString(),
      endTime: workout.endTime || workout.end || null,
      distance: workout.distance || null,
      avgHeartRate: workout.avgHeartRate || workout.heartRate || null,
    };

    // Dedup: exact startTime match OR same type+duration within 5-minute window
    const alreadyExists = existing.some(w => {
      if (w.startTime === normalized.startTime) return true;
      if (w.type === normalized.type && w.duration === normalized.duration && w.startTime) {
        const timeDiff = Math.abs(new Date(w.startTime).getTime() - parsedStart.getTime());
        if (timeDiff < 5 * 60 * 1000) return true;
      }
      return false;
    });

    if (alreadyExists) {
      skipped++;
      continue;
    }

    existing.push(normalized);
  }

  // Sort by start time (newest first)
  existing.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  // Save back
  await env.HABIT_DATA.put(`workouts:${normalizedDate}`, JSON.stringify(existing));

  return jsonResponse({
    success: true,
    date: normalizedDate,
    workoutCount: existing.length,
    workouts: existing,
    skipped,
    message: `Synced ${workouts.length - skipped} new workout(s) for ${normalizedDate}, ${skipped} duplicate(s) skipped`
  }, 200, corsHeaders);
}


// ===== Log Body Composition (from iOS Shortcut) =====
async function logBody(body, env, corsHeaders) {
  let normalizedDate;
  if (body.date) {
    normalizedDate = normalizeDate(body.date);
  } else {
    normalizedDate = normalizeDate(formatDateForKV(new Date()));
  }

  // Read existing daily data and merge body fields
  const existing = await env.HABIT_DATA.get(`daily:${normalizedDate}`, "json") || {};

  const val = (a, b, c) => {
    const v = a ?? b ?? c;
    if (v === undefined || v === null || v === "") return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : Math.round(n * 10) / 10;
  };

  const weight = val(body.Weight, body.weight);
  const leanMass = val(body.LeanMass, body.leanMass);
  const fatMass = val(body.FatMass, body.fatMass, body.bodyFat);
  const boneMass = val(body.BoneMass, body.boneMass);
  const bodyWater = val(body.BodyWater, body.bodyWater, body.waterLbs);
  const bodyFatPct = val(body.BodyFatPercentage, body.bodyFatPercentage);
  const waist = val(body.Waist, body.waist);

  // Calculate FatMass from Weight and BodyFatPercentage if not provided directly
  const calculatedFatMass = (!fatMass && weight && bodyFatPct)
    ? Math.round(weight * bodyFatPct / 100 * 10) / 10
    : null;

  // Only update fields that have real positive values (0 is never valid for body data)
  const updates = {};
  if (weight) updates["Weight (lbs)"] = weight;
  if (leanMass) updates["Lean Mass (lbs)"] = leanMass;
  if (fatMass) updates["Body Fat (lbs)"] = fatMass;
  else if (calculatedFatMass) updates["Body Fat (lbs)"] = calculatedFatMass;
  if (boneMass) updates["Bone Mass (lbs)"] = boneMass;
  if (bodyWater) updates["Water (lbs)"] = bodyWater;
  if (waist) updates["Waist"] = waist;

  const merged = { ...existing, "Date": normalizedDate, ...updates };
  await env.HABIT_DATA.put(`daily:${normalizedDate}`, JSON.stringify(merged));

  return jsonResponse({
    success: true,
    date: normalizedDate,
    updated: Object.keys(updates),
    values: updates,
    received: body,
    message: `Body data saved for ${normalizedDate}`
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

  let lastWeekSleep = [];
  let lastWeekSteps = [];
  let movementValues = [];
  let lastWeekMovements = [];
  let readingMins = 0;
  let lastWeekReadingMins = 0;

  // Fetch up to 14 days of data
  const dates = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    dates.push(normalizeDate(formatDateForKV(d)));
  }

  const [dailyData, movementsData, readingsData] = await Promise.all([
    Promise.all(dates.map(d => env.HABIT_DATA.get(`daily:${d}`, "json"))),
    Promise.all(dates.map(d => env.HABIT_DATA.get(`movements:${d}`, "json"))),
    Promise.all(dates.map(d => env.HABIT_DATA.get(`readings:${d}`, "json"))),
  ]);

  dailyData.forEach((data, i) => {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    d.setHours(12, 0, 0, 0);

    const isThisWeek = d >= weekStart && d <= weekEnd;
    const isLastWeek = d >= lastWeekStart && d <= lastWeekEnd;

    const sleep = data ? parseFloat(data["Hours of Sleep"]) : NaN;
    const steps = data ? parseInt(data["Steps"], 10) : NaN;

    // Sum movement duration in minutes: new array format first, fall back to old daily fields
    const movArr = movementsData[i];
    let movMinutes = 0;
    if (movArr && Array.isArray(movArr) && movArr.length > 0) {
      movMinutes = movArr.reduce((sum, m) => sum + (parseFloat(m.duration) || 0), 0);
    } else if (data) {
      if (data["Morning Movement Duration"]) movMinutes += parseInt(data["Morning Movement Duration"]) || 0;
      if (data["Afternoon Movement Duration"]) movMinutes += parseInt(data["Afternoon Movement Duration"]) || 0;
    }

    // Sum reading minutes from readings array
    const rdArr = readingsData[i];
    let rdMins = 0;
    if (rdArr && Array.isArray(rdArr)) {
      rdMins = rdArr.reduce((sum, r) => sum + (parseInt(r.duration || r["duration (min)"] || r["Duration"] || 0) || 0), 0);
    }

    if (isThisWeek) {
      if (!isNaN(sleep) && sleep > 0) sleepValues.push(sleep);
      if (!isNaN(steps) && steps > 0) stepsValues.push(steps);
      movementValues.push(movMinutes);
      readingMins += rdMins;
    }

    if (isLastWeek) {
      if (!isNaN(sleep) && sleep > 0) lastWeekSleep.push(sleep);
      if (!isNaN(steps) && steps > 0) lastWeekSteps.push(steps);
      lastWeekMovements.push(movMinutes);
      lastWeekReadingMins += rdMins;
    }
  });

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    sleep: avg(sleepValues),
    steps: stepsValues.length ? Math.round(avg(stepsValues)) : null,
    movements: avg(movementValues),
    readingWeek: readingMins,
    lastWeek: {
      sleep: avg(lastWeekSleep),
      steps: lastWeekSteps.length ? Math.round(avg(lastWeekSteps)) : null,
      movements: avg(lastWeekMovements),
      readingWeek: lastWeekReadingMins,
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

// ===== Dumbbell Carry-Forward =====
async function getLastDumbbellData(dateStr, env) {
  const targetDate = parseDate(dateStr);

  // Look back up to 30 days for most recent dumbbell data
  for (let i = 1; i <= 30; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    const checkDate = normalizeDate(formatDateForKV(d));

    const data = await env.HABIT_DATA.get(`dumbbell:${checkDate}`, "json");
    if (data && Array.isArray(data) && data.length > 0) {
      return data;
    }
  }

  return null;
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

// ===== Bedtime Routine Items =====
async function loadBedtimeItems(env, corsHeaders) {
  const items = await env.HABIT_DATA.get("bedtime:items", "json");

  // Return default items if none exist
  const defaultItems = [
    { id: 1, name: "Brush Teeth", order: 0 },
    { id: 2, name: "Pick Clothes", order: 1 },
    { id: 3, name: "Computer", order: 2 },
    { id: 4, name: "Supplements", order: 3 },
    { id: 5, name: "Water", order: 4 }
  ];

  return jsonResponse({
    items: items || defaultItems
  }, 200, corsHeaders);
}

async function saveBedtimeItems(items, env, corsHeaders) {
  await env.HABIT_DATA.put("bedtime:items", JSON.stringify(items));
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// ===== Morning Routine Items =====
async function loadMorningItems(env, corsHeaders) {
  const items = await env.HABIT_DATA.get("morning:items", "json");

  const defaultItems = [
    { id: 1, name: "Pulse", type: "pulse", order: 0 },
    { id: 2, name: "Blood Pressure", type: "bloodPressure", order: 1 },
    { id: 3, name: "Supps", type: "supps", order: 2 },
    { id: 4, name: "Water", type: "water", order: 3 },
    { id: 5, name: "REHIT Ride", type: "rehit", order: 4 },
    { id: 6, name: "Fitness Metrics", type: "fitnessMetrics", order: 5 },
    { id: 7, name: "Meditated", type: "meditated", order: 6 }
  ];

  return jsonResponse({
    items: items || defaultItems
  }, 200, corsHeaders);
}

async function saveMorningItems(items, env, corsHeaders) {
  await env.HABIT_DATA.put("morning:items", JSON.stringify(items));
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// ===== Habit Notes =====
async function loadHabitNotes(env, corsHeaders) {
  const notes = await env.HABIT_DATA.get("habit:notes", "json");
  return jsonResponse({
    notes: notes || []
  }, 200, corsHeaders);
}

async function saveHabitNotes(notes, env, corsHeaders) {
  await env.HABIT_DATA.put("habit:notes", JSON.stringify(notes));
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// ===== Habit Stacks =====
async function loadHabitStacks(env, corsHeaders) {
  const stacks = await env.HABIT_DATA.get("habit:stacks", "json");
  return jsonResponse({
    stacks: stacks || []
  }, 200, corsHeaders);
}

async function saveHabitStacks(stacks, env, corsHeaders) {
  await env.HABIT_DATA.put("habit:stacks", JSON.stringify(stacks));
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// ===== App Settings =====
async function loadSettings(env, corsHeaders) {
  const settings = await env.HABIT_DATA.get("app:settings", "json");
  return jsonResponse({
    settings: settings || null
  }, 200, corsHeaders);
}

async function saveSettings(settings, env, corsHeaders) {
  await env.HABIT_DATA.put("app:settings", JSON.stringify(settings));
  return jsonResponse({ success: true }, 200, corsHeaders);
}

// ===== Cue Logs =====
async function loadCueLogs(env, corsHeaders) {
  const logs = await env.HABIT_DATA.get("cue:logs", "json");
  return jsonResponse({
    logs: logs || []
  }, 200, corsHeaders);
}

async function saveCueLog(cueData, env, corsHeaders) {
  // Get existing logs
  let logs = await env.HABIT_DATA.get("cue:logs", "json") || [];

  // Add new log entry
  logs.push(cueData);

  // Keep only the last 500 entries to prevent unbounded growth
  if (logs.length > 500) {
    logs = logs.slice(-500);
  }

  await env.HABIT_DATA.put("cue:logs", JSON.stringify(logs));
  return jsonResponse({ success: true, count: logs.length }, 200, corsHeaders);
}

// ===== Phases =====
async function loadPhases(env, corsHeaders) {
  const phases = await env.HABIT_DATA.get("phases", "json");

  // Return default Phase 1 if no phases exist
  const defaultPhases = [
    {
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
        supps: { target: 6, unit: "supps", type: "daily", description: "All 6 supplements" },
        noAlcohol: { target: true, unit: "bool", type: "daily", description: "No alcohol" },
        meditation: { target: true, unit: "bool", type: "daily", description: "Daily meditation" },
        snacks: { target: 2, unit: "checks", type: "daily", description: "Healthy snacks (day + night)" }
      }
    }
  ];

  return jsonResponse({
    phases: phases || defaultPhases
  }, 200, corsHeaders);
}

async function savePhases(phases, env, corsHeaders) {
  await env.HABIT_DATA.put("phases", JSON.stringify(phases));
  return jsonResponse({ success: true, count: phases.length }, 200, corsHeaders);
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

// ===== Migration: Convert legacy movements to morning/afternoon format =====
async function migrateMovements(env, corsHeaders) {
  const results = { migrated: 0, skipped: 0, errors: [], details: [] };

  // List all keys with movements: prefix
  const movementKeys = await env.HABIT_DATA.list({ prefix: "movements:" });

  for (const key of movementKeys.keys) {
    try {
      const dateStr = key.name.replace("movements:", "");

      // Get the movements array for this day
      const movements = await env.HABIT_DATA.get(key.name, "json");

      // Get the daily data for this day
      let daily = await env.HABIT_DATA.get(`daily:${dateStr}`, "json") || {};

      // Skip if already has morning/afternoon data
      if (daily["Morning Movement Type"] || daily["Afternoon Movement Type"]) {
        results.skipped++;
        continue;
      }

      // Check if there's legacy movements data to migrate
      let movementsToMigrate = [];

      // First check the movements array (separate storage)
      if (movements && Array.isArray(movements) && movements.length > 0) {
        movementsToMigrate = movements;
      }
      // Also check legacy "Movements" field in daily data
      else if (daily["Movements"]) {
        const legacyMovements = daily["Movements"];
        if (typeof legacyMovements === 'string' && legacyMovements.trim()) {
          // Parse comma-separated string like "Walk,Stretch"
          movementsToMigrate = legacyMovements.split(',').map(m => ({ type: m.trim(), duration: "" }));
        } else if (Array.isArray(legacyMovements)) {
          movementsToMigrate = legacyMovements.map(m => {
            if (typeof m === 'string') return { type: m, duration: "" };
            return m;
          });
        }
      }

      if (movementsToMigrate.length === 0) {
        results.skipped++;
        continue;
      }

      // Migrate: first movement -> morning, second -> afternoon
      const morning = movementsToMigrate[0];
      const afternoon = movementsToMigrate[1];

      if (morning) {
        daily["Morning Movement Type"] = morning.type || "";
        daily["Morning Movement Duration"] = morning.duration || "";
      }
      if (afternoon) {
        daily["Afternoon Movement Type"] = afternoon.type || "";
        daily["Afternoon Movement Duration"] = afternoon.duration || "";
      }

      // Save updated daily data
      await env.HABIT_DATA.put(`daily:${dateStr}`, JSON.stringify(daily));

      results.migrated++;
      results.details.push({
        date: dateStr,
        morning: morning ? `${morning.type} (${morning.duration || 'no duration'})` : null,
        afternoon: afternoon ? `${afternoon.type} (${afternoon.duration || 'no duration'})` : null
      });

    } catch (err) {
      results.errors.push({ key: key.name, error: err.message });
    }
  }

  // Also check daily: keys for legacy Movements field that wasn't in movements: storage
  const dailyKeys = await env.HABIT_DATA.list({ prefix: "daily:" });

  for (const key of dailyKeys.keys) {
    try {
      const dateStr = key.name.replace("daily:", "");
      let daily = await env.HABIT_DATA.get(key.name, "json");

      if (!daily) continue;

      // Skip if already has morning/afternoon data
      if (daily["Morning Movement Type"] || daily["Afternoon Movement Type"]) {
        continue;
      }

      // Check for legacy "Movements" field
      if (!daily["Movements"]) continue;

      const legacyMovements = daily["Movements"];
      let movementsToMigrate = [];

      if (typeof legacyMovements === 'string' && legacyMovements.trim()) {
        movementsToMigrate = legacyMovements.split(',').map(m => ({ type: m.trim(), duration: "" }));
      } else if (Array.isArray(legacyMovements)) {
        movementsToMigrate = legacyMovements.map(m => {
          if (typeof m === 'string') return { type: m, duration: "" };
          return m;
        });
      }

      if (movementsToMigrate.length === 0) continue;

      // Migrate
      const morning = movementsToMigrate[0];
      const afternoon = movementsToMigrate[1];

      if (morning) {
        daily["Morning Movement Type"] = morning.type || "";
        daily["Morning Movement Duration"] = morning.duration || "";
      }
      if (afternoon) {
        daily["Afternoon Movement Type"] = afternoon.type || "";
        daily["Afternoon Movement Duration"] = afternoon.duration || "";
      }

      await env.HABIT_DATA.put(key.name, JSON.stringify(daily));

      results.migrated++;
      results.details.push({
        date: dateStr,
        morning: morning ? `${morning.type} (${morning.duration || 'no duration'})` : null,
        afternoon: afternoon ? `${afternoon.type} (${afternoon.duration || 'no duration'})` : null,
        source: 'legacy_field'
      });

    } catch (err) {
      results.errors.push({ key: key.name, error: err.message });
    }
  }

  return jsonResponse(results, 200, corsHeaders);
}

// ===== Data Audit: Scan all data for inconsistencies =====
async function auditData(env, corsHeaders) {
  try {
    const audit = {
      totalDays: 0,
      dateRange: { earliest: null, latest: null },
      habits: {},
      issues: [],
      rawSamples: {}
    };

  // Define habits to audit with their expected formats
  const habitsToAudit = [
    { key: 'sleep', field: 'Hours of Sleep', type: 'numeric', description: 'Sleep hours' },
    { key: 'agua', fields: ['agua', 'Water', 'Water (glasses)', 'hydrationGood'], type: 'numeric', description: 'Water glasses' },
    { key: 'steps', field: 'Steps', type: 'numeric', description: 'Daily steps' },
    { key: 'rehit', field: 'REHIT 2x10', type: 'mixed', description: 'REHIT sessions' },
    { key: 'movementMorningType', field: 'Morning Movement Type', type: 'string', description: 'Morning movement type' },
    { key: 'movementMorningDuration', field: 'Morning Movement Duration', type: 'mixed', description: 'Morning movement duration' },
    { key: 'movementAfternoonType', field: 'Afternoon Movement Type', type: 'string', description: 'Afternoon movement type' },
    { key: 'movementAfternoonDuration', field: 'Afternoon Movement Duration', type: 'mixed', description: 'Afternoon movement duration' },
    { key: 'movementsLegacy', field: 'Movements', type: 'legacy', description: 'Legacy movements field' },
    { key: 'creatine', fields: ['Creatine Chews', 'Creatine'], type: 'boolean', description: 'Creatine supplement' },
    { key: 'vitaminD', field: 'Vitamin D', type: 'boolean', description: 'Vitamin D supplement' },
    { key: 'no2', field: 'NO2', type: 'boolean', description: 'NO2 supplement' },
    { key: 'psyllium', fields: ['Psyllium Husk', 'Psyllium'], type: 'boolean', description: 'Psyllium supplement' },
    { key: 'zinc', field: 'Zinc', type: 'boolean', description: 'Zinc supplement' },
    { key: 'prebiotic', field: 'Prebiotic', type: 'boolean', description: 'Prebiotic supplement' },
    { key: 'breakfast', field: 'Breakfast', type: 'boolean', description: 'Healthy breakfast' },
    { key: 'lunch', field: 'Lunch', type: 'boolean', description: 'Healthy lunch' },
    { key: 'dinner', field: 'Dinner', type: 'boolean', description: 'Healthy dinner' },
    { key: 'daySnacks', fields: ['Healthy Day Snacks', 'Day Snacks'], type: 'boolean', description: 'Healthy day snacks' },
    { key: 'nightSnacks', fields: ['Healthy Night Snacks', 'Night Snacks'], type: 'boolean', description: 'Healthy night snacks' },
    { key: 'noAlcohol', field: 'No Alcohol', type: 'boolean', description: 'No alcohol' },
    { key: 'meditation', fields: ['Meditation', 'Meditated'], type: 'boolean', description: 'Meditation' },
    { key: 'readingMinutes', field: 'Reading Minutes', type: 'numeric', description: 'Reading minutes (legacy field)' },
  ];

  // Initialize audit structure for each habit
  habitsToAudit.forEach(h => {
    audit.habits[h.key] = {
      description: h.description,
      field: h.field || h.fields.join(' | '),
      expectedType: h.type,
      daysWithData: 0,
      daysWithoutData: 0,
      uniqueValues: {},
      valueTypes: {},
      samples: []
    };
  });

  // Also track readings array separately
  audit.readingsArray = {
    daysWithReadings: 0,
    totalEntries: 0,
    uniqueBooks: new Set(),
    durationFormats: {},
    samples: []
  };

  // Also track movements array separately
  audit.movementsArray = {
    daysWithMovements: 0,
    totalEntries: 0,
    movementTypes: {},
    durationFormats: {},
    samples: []
  };

  // List all daily keys
  const dailyKeys = await env.HABIT_DATA.list({ prefix: "daily:" });
  audit.totalDays = dailyKeys.keys.length;

  // Process each day
  for (const key of dailyKeys.keys) {
    try {
      const dateStr = key.name.replace("daily:", "");
      const daily = await env.HABIT_DATA.get(key.name, "json");

      if (!daily) continue;

      // Track date range
      if (!audit.dateRange.earliest || dateStr < audit.dateRange.earliest) {
        audit.dateRange.earliest = dateStr;
      }
      if (!audit.dateRange.latest || dateStr > audit.dateRange.latest) {
        audit.dateRange.latest = dateStr;
      }

      // Audit each habit
      habitsToAudit.forEach(h => {
        const habitAudit = audit.habits[h.key];
        let value = null;

        // Get value (handle multiple field names)
        if (h.fields) {
          for (const f of h.fields) {
            if (daily[f] !== undefined && daily[f] !== null && daily[f] !== "") {
              value = daily[f];
              break;
            }
          }
        } else {
          value = daily[h.field];
        }

        // Track if data exists
        if (value !== undefined && value !== null && value !== "") {
          habitAudit.daysWithData++;

          // Track value type
          const valueType = typeof value;
          habitAudit.valueTypes[valueType] = (habitAudit.valueTypes[valueType] || 0) + 1;

          // Track unique values (stringify for objects/arrays)
          const valueKey = typeof value === 'object' ? JSON.stringify(value) : String(value);
          if (!habitAudit.uniqueValues[valueKey]) {
            habitAudit.uniqueValues[valueKey] = { count: 0, type: valueType, sampleDates: [] };
          }
          habitAudit.uniqueValues[valueKey].count++;
          if (habitAudit.uniqueValues[valueKey].sampleDates.length < 3) {
            habitAudit.uniqueValues[valueKey].sampleDates.push(dateStr);
          }

          // Keep some samples
          if (habitAudit.samples.length < 5) {
            habitAudit.samples.push({ date: dateStr, value });
          }
        } else {
          habitAudit.daysWithoutData++;
        }
      });

      // Check for readings array
      const readings = await env.HABIT_DATA.get(`readings:${dateStr}`, "json");
      if (readings && Array.isArray(readings) && readings.length > 0) {
        audit.readingsArray.daysWithReadings++;
        audit.readingsArray.totalEntries += readings.length;
        readings.forEach(r => {
          if (r.book) audit.readingsArray.uniqueBooks.add(r.book);
          // Track duration field format
          const durationKeys = Object.keys(r).filter(k => k.toLowerCase().includes('duration'));
          durationKeys.forEach(dk => {
            audit.readingsArray.durationFormats[dk] = (audit.readingsArray.durationFormats[dk] || 0) + 1;
          });
        });
        if (audit.readingsArray.samples.length < 5) {
          audit.readingsArray.samples.push({ date: dateStr, readings });
        }
      }

      // Check for movements array
      const movements = await env.HABIT_DATA.get(`movements:${dateStr}`, "json");
      if (movements && Array.isArray(movements) && movements.length > 0) {
        audit.movementsArray.daysWithMovements++;
        audit.movementsArray.totalEntries += movements.length;
        movements.forEach(m => {
          if (m.type) {
            audit.movementsArray.movementTypes[m.type] = (audit.movementsArray.movementTypes[m.type] || 0) + 1;
          }
          // Track duration format
          if (m.duration !== undefined) {
            const durType = typeof m.duration;
            audit.movementsArray.durationFormats[durType] = (audit.movementsArray.durationFormats[durType] || 0) + 1;
          }
        });
        if (audit.movementsArray.samples.length < 5) {
          audit.movementsArray.samples.push({ date: dateStr, movements });
        }
      }

    } catch (err) {
      audit.issues.push({ type: 'error', date: key.name, message: err.message });
    }
  }

  // Convert Set to array for JSON
  audit.readingsArray.uniqueBooks = Array.from(audit.readingsArray.uniqueBooks);

  // Analyze for issues
  habitsToAudit.forEach(h => {
    const habitAudit = audit.habits[h.key];

    // Flag if multiple value types found for typed fields
    const typeCount = Object.keys(habitAudit.valueTypes).length;
    if (typeCount > 1 && h.type !== 'mixed' && h.type !== 'legacy') {
      audit.issues.push({
        type: 'mixed_types',
        habit: h.key,
        description: h.description,
        message: `Found ${typeCount} different value types: ${Object.keys(habitAudit.valueTypes).join(', ')}`,
        types: habitAudit.valueTypes
      });
    }

    // Flag legacy data that might need migration
    if (h.key === 'movementsLegacy' && habitAudit.daysWithData > 0) {
      audit.issues.push({
        type: 'legacy_data',
        habit: h.key,
        description: h.description,
        message: `Found ${habitAudit.daysWithData} days with legacy Movements field - may need migration`,
        daysAffected: habitAudit.daysWithData
      });
    }

    // Flag REHIT values that might be ambiguous
    if (h.key === 'rehit') {
      const trueCount = (habitAudit.uniqueValues['true']?.count || 0) + (habitAudit.uniqueValues['TRUE']?.count || 0);
      if (trueCount > 0) {
        audit.issues.push({
          type: 'ambiguous_data',
          habit: h.key,
          description: h.description,
          message: `Found ${trueCount} REHIT entries with "true/TRUE" - these are counted as 2x10. Verify this is correct.`,
          daysAffected: trueCount
        });
      }
    }
  });

  // Flag if movements array has data but morning/afternoon fields are empty
  if (audit.movementsArray.daysWithMovements > 0) {
    const morningDays = audit.habits.movementMorningType.daysWithData;
    const afternoonDays = audit.habits.movementAfternoonType.daysWithData;
    if (audit.movementsArray.daysWithMovements > Math.max(morningDays, afternoonDays)) {
      audit.issues.push({
        type: 'unmigrated_data',
        habit: 'movements',
        message: `Found ${audit.movementsArray.daysWithMovements} days with movements array but only ${morningDays} days with Morning Movement Type. Consider running migration.`,
        daysAffected: audit.movementsArray.daysWithMovements - morningDays
      });
    }
  }

    return jsonResponse(audit, 200, corsHeaders);
  } catch (err) {
    console.error('Audit error:', err);
    return jsonResponse({ error: true, message: err.message, stack: err.stack }, 500, corsHeaders);
  }
}
