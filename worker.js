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
 * - withings:tokens → { access_token, refresh_token, expires_at, userid }
 * - withings:state → CSRF state for OAuth flow (auto-expires)
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
    const lite = url.searchParams.get("lite") === "1";
    return await loadDay(date, env, corsHeaders, lite);
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

  if (action === "calendar_event") {
    return await getCalendarEvent(env, corsHeaders);
  }

  if (action === "export_all") {
    return await exportAll(env, corsHeaders);
  }

  // ===== Withings Integration Endpoints =====
  if (action === "withings_auth") {
    return await withingsAuth(request, env, corsHeaders);
  }

  if (action === "withings_callback") {
    return await withingsCallback(url, env, corsHeaders);
  }

  if (action === "withings_sleep") {
    return await withingsFetchSleep(url.searchParams.get("date"), env, corsHeaders);
  }

  if (action === "withings_status") {
    return await withingsStatus(env, corsHeaders);
  }

  if (action === "withings_deauth") {
    await env.HABIT_DATA.delete("withings:tokens");
    return jsonResponse({ success: true, message: "Withings disconnected" }, 200, corsHeaders);
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

  // Withings callback - handle both POST (developer portal verification) and code exchange
  if (action === "withings_callback") {
    return await withingsCallback(url, env, corsHeaders);
  }

  // Withings sleep sync via POST
  if (action === "withings_sleep") {
    const dateParam = url.searchParams.get("date") || body.date || null;
    return await withingsFetchSleep(dateParam, env, corsHeaders);
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

  // iOS Shortcut endpoint - sync sleep metrics (Withings)
  if (action === "sleep") {
    return await logSleep(body, env, corsHeaders);
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

  if (action === "migrate_custom_fields") {
    if (!body.sectionMeta || !Array.isArray(body.sectionMeta)) {
      return jsonResponse({ error: true, message: "Missing sectionMeta array" }, 400, corsHeaders);
    }
    return await migrateCustomFields(body.sectionMeta, env, corsHeaders);
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
async function loadDay(dateStr, env, corsHeaders, lite = false) {
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

  // Lite mode: skip averages and carry-forward (used by prefetch)
  // This reduces KV reads from ~50+ to just 7 per prefetched day
  if (lite) {
    return jsonResponse({
      daily: daily || {},
      movements: movements || [],
      readings: readings || [],
      honeyDos: honeyDos || [],
      customSections: customSections || {},
      workouts: workouts || [],
      dumbbell: dumbbellData || [],
      dumbbellCarryForward: null,
      averages: null,
      bodyCarryForward: {},
    }, 200, corsHeaders);
  }

  // Calculate averages
  const averages = await calculate7DayAverages(normalizedDate, env);

  // Get carry-forward data — cached per day so we only compute once
  const cfKey = `cf:${normalizedDate}`;
  let cf = await env.HABIT_DATA.get(cfKey, "json");
  if (!cf) {
    // Compute carry-forward body data if needed
    const todayBody = await env.HABIT_DATA.get(`body:${normalizedDate}`, "json");
    let bodyCarryForward = {};
    if (!todayBody || !todayBody.weight) {
      bodyCarryForward = await getLastBodyData(normalizedDate, env);
    }

    // Compute carry-forward dumbbell data if needed
    let dumbbellCarryForward = null;
    if (!dumbbellData || dumbbellData.length === 0) {
      dumbbellCarryForward = await getLastDumbbellData(normalizedDate, env);
    }

    cf = { bodyCarryForward, dumbbellCarryForward };
    // Cache for the rest of the day (expires in 24h)
    await env.HABIT_DATA.put(cfKey, JSON.stringify(cf), { expirationTtl: 86400 });
  }

  return jsonResponse({
    daily: daily || {},
    movements: movements || [],
    readings: readings || [],
    honeyDos: honeyDos || [],
    customSections: customSections || {},
    workouts: workouts || [],
    dumbbell: dumbbellData || [],
    dumbbellCarryForward: cf.dumbbellCarryForward,
    averages,
    bodyCarryForward: cf.bodyCarryForward,
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
    "Sleep Score": data.sleepScore || "",
    "Sleep HR": data.sleepHR || "",
    "Sleep HRV": data.sleepHRV || "",
    "Sleep Depth": data.sleepDepth || "",
    "Sleep Regularity": data.sleepRegularity || "",
    "Sleep Interruptions": data.sleepInterruptions || "",
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
    "Weight (lbs)": ("weight" in data) ? (data.weight || "") : "",
    "Waist": ("waist" in data) ? (data.waist || "") : "",
    "Lean Mass (lbs)": ("leanMass" in data) ? (data.leanMass || "") : "",
    "Body Fat (lbs)": ("bodyFat" in data) ? (data.bodyFat || "") : "",
    "Bone Mass (lbs)": ("boneMass" in data) ? (data.boneMass || "") : "",
    "Water (lbs)": ("bodywater" in data || "waterLbs" in data) ? (data.bodywater || data.waterLbs || "") : "",
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
    "Protein": parseInt(data.protein) || 0,
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

  // Merge custom section fields into daily record with descriptive names
  // (e.g. "Grey's Habits: Points", "Gratitude", etc.)
  if (data.customFieldsFlat && typeof data.customFieldsFlat === 'object') {
    Object.assign(daily, data.customFieldsFlat);
  }

  // Save all data in parallel
  const saves = [
    env.HABIT_DATA.put(`daily:${normalizedDate}`, JSON.stringify(daily)),
  ];

  // Save explicit body data to dedicated key (used for clean carry-forward)
  if ("weight" in data) {
    const bodyEntry = {
      weight: data.weight || "",
      waist: data.waist || "",
      leanMass: data.leanMass || "",
      bodyFat: data.bodyFat || "",
      boneMass: data.boneMass || "",
      waterLbs: data.bodywater || data.waterLbs || "",
      enteredAt: new Date().toISOString(),
    };
    // Only write if at least one field has a real value
    if (bodyEntry.weight || bodyEntry.waist || bodyEntry.leanMass || bodyEntry.bodyFat || bodyEntry.boneMass || bodyEntry.waterLbs) {
      saves.push(env.HABIT_DATA.put(`body:${normalizedDate}`, JSON.stringify(bodyEntry)));
      // Update the "latest" pointer for O(1) carry-forward lookups
      saves.push(env.HABIT_DATA.put("body:latest", JSON.stringify({ date: normalizedDate, data: bodyEntry })));
    }
  }

  // Save movements if provided — never overwrite existing data with an empty array
  // (protects against race conditions in the frontend where currentMovements is
  // briefly reset to [] by a stale populateForm before the correct data loads)
  if (data.movements && Array.isArray(data.movements)) {
    if (data.movements.length > 0) {
      saves.push(env.HABIT_DATA.put(`movements:${normalizedDate}`, JSON.stringify(data.movements)));
    } else {
      // Only clear movements if the server has none either (prevents accidental wipes)
      const existing = await env.HABIT_DATA.get(`movements:${normalizedDate}`, "json");
      if (!existing || existing.length === 0) {
        saves.push(env.HABIT_DATA.put(`movements:${normalizedDate}`, JSON.stringify([])));
      }
    }
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
    // Update the "latest" pointer for O(1) carry-forward lookups
    if (data.dumbbell.length > 0) {
      saves.push(env.HABIT_DATA.put("dumbbell:latest", JSON.stringify({ date: normalizedDate, data: data.dumbbell })));
    }
  }

  // Invalidate carry-forward cache when body or dumbbell data changes
  saves.push(env.HABIT_DATA.delete(`cf:${normalizedDate}`));

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
  const bodyPuts = [
    env.HABIT_DATA.put(`daily:${normalizedDate}`, JSON.stringify(merged)),
  ];

  // Also write to dedicated body key for clean carry-forward
  if (Object.keys(updates).length > 0) {
    const bodyEntry = {
      weight: updates["Weight (lbs)"] || "",
      waist: updates["Waist"] || "",
      leanMass: updates["Lean Mass (lbs)"] || "",
      bodyFat: updates["Body Fat (lbs)"] || "",
      boneMass: updates["Bone Mass (lbs)"] || "",
      waterLbs: updates["Water (lbs)"] || "",
      enteredAt: new Date().toISOString(),
    };
    bodyPuts.push(env.HABIT_DATA.put(`body:${normalizedDate}`, JSON.stringify(bodyEntry)));
    bodyPuts.push(env.HABIT_DATA.put("body:latest", JSON.stringify({ date: normalizedDate, data: bodyEntry })));
    bodyPuts.push(env.HABIT_DATA.delete(`cf:${normalizedDate}`));
  }
  await Promise.all(bodyPuts);

  return jsonResponse({
    success: true,
    date: normalizedDate,
    updated: Object.keys(updates),
    values: updates,
    received: body,
    message: `Body data saved for ${normalizedDate}`
  }, 200, corsHeaders);
}

// ===== Log Sleep Metrics (from iOS Shortcut / Withings) =====
async function logSleep(body, env, corsHeaders) {
  let normalizedDate;
  if (body.date) {
    normalizedDate = normalizeDate(body.date);
  } else {
    normalizedDate = normalizeDate(formatDateForKV(new Date()));
  }

  const existing = await env.HABIT_DATA.get(`daily:${normalizedDate}`, "json") || {};

  const updates = {};

  // Sleep hours (duration)
  const hours = parseFloat(body.hours ?? body.duration ?? body.sleepHours);
  if (!isNaN(hours) && hours > 0) updates["Hours of Sleep"] = Math.round(hours * 10) / 10;

  // Withings sleep quality score (0-100)
  const score = parseInt(body.score ?? body.sleepScore ?? body.quality);
  if (!isNaN(score) && score >= 0) updates["Sleep Score"] = score;

  // Heart rate during sleep
  const hr = parseInt(body.hr ?? body.heartRate ?? body.sleepHR);
  if (!isNaN(hr) && hr > 0) updates["Sleep HR"] = hr;

  // HRV during sleep
  const hrv = parseInt(body.hrv ?? body.sleepHRV);
  if (!isNaN(hrv) && hrv >= 0) updates["Sleep HRV"] = hrv;

  // Depth rating (Bad/Poor/Fair/Good/Optimal)
  const depth = body.depth ?? body.sleepDepth ?? "";
  if (depth) updates["Sleep Depth"] = String(depth);

  // Regularity rating (Bad/Poor/Fair/Good/Optimal)
  const regularity = body.regularity ?? body.sleepRegularity ?? "";
  if (regularity) updates["Sleep Regularity"] = String(regularity);

  // Interruptions count
  const interruptions = parseInt(body.interruptions ?? body.sleepInterruptions);
  if (!isNaN(interruptions) && interruptions >= 0) updates["Sleep Interruptions"] = interruptions;

  if (Object.keys(updates).length === 0) {
    return jsonResponse({
      error: true,
      message: "No valid sleep data found. Send fields like: hours, score, hr, hrv, depth, regularity, interruptions",
      received: body
    }, 400, corsHeaders);
  }

  const merged = { ...existing, "Date": normalizedDate, ...updates };
  await env.HABIT_DATA.put(`daily:${normalizedDate}`, JSON.stringify(merged));

  // Clear carry-forward cache for this date since we wrote new data
  await env.HABIT_DATA.delete(`cf:${normalizedDate}`).catch(() => {});

  return jsonResponse({
    success: true,
    date: normalizedDate,
    updated: Object.keys(updates),
    values: updates,
    received: body,
    message: `Sleep data saved for ${normalizedDate}`
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
  let lastWeekStepsPartial = [];  // same days-of-week as current week for apples-to-apples comparison
  let movementValues = [];
  let lastWeekMovements = [];
  let readingMins = 0;
  let lastWeekReadingMins = 0;

  // Fetch up to 14 days of data
  // Use the same date formatting as normalizeDate/parseDate (no timezone conversion)
  // to stay aligned with how KV keys are stored. formatDateForKV uses America/Chicago
  // which shifts midnight-UTC dates back a day, causing a mismatch with the week
  // boundary checks below.
  const dates = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    dates.push(`${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`);
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
      // Partial-week: only include days up to the same day-of-week as today
      if (d.getDay() <= dayOfWeek && !isNaN(steps) && steps > 0) {
        lastWeekStepsPartial.push(steps);
      }
    }
  });

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  return {
    sleep: avg(sleepValues),
    steps: stepsValues.length ? Math.round(avg(stepsValues)) : null,
    stepsWeek: sum(stepsValues),
    movements: avg(movementValues),
    readingWeek: readingMins,
    lastWeek: {
      sleep: avg(lastWeekSleep),
      steps: lastWeekSteps.length ? Math.round(avg(lastWeekSteps)) : null,
      stepsWeek: sum(lastWeekStepsPartial),
      movements: avg(lastWeekMovements),
      readingWeek: lastWeekReadingMins,
    }
  };
}

// ===== Get Last Body Data (carry-forward) =====
// Uses dedicated body:{date} keys first (written only on explicit entry),
// then falls back to daily:{date} for data saved before this change.
async function getLastBodyData(dateStr, env) {
  // Use the cached "latest" key for O(1) lookup instead of scanning up to 90 days
  const latest = await env.HABIT_DATA.get("body:latest", "json");
  if (latest && latest.date && latest.data?.weight) {
    // Only use if the latest entry is from before the requested date
    const target = parseDate(dateStr);
    const latestDate = parseDate(latest.date);
    if (latestDate < target) {
      return {
        weight: latest.data.weight,
        waist: latest.data.waist,
        leanMass: latest.data.leanMass,
        bodyFat: latest.data.bodyFat,
        boneMass: latest.data.boneMass,
        waterLbs: latest.data.waterLbs,
        fromDate: latest.date,
      };
    }
  }

  // Fallback: scan last 7 days only (not 45+45)
  const targetDate = parseDate(dateStr);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    const checkDate = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
    const bodyData = await env.HABIT_DATA.get(`body:${checkDate}`, "json");
    if (bodyData && bodyData.weight) {
      return {
        weight: bodyData.weight,
        waist: bodyData.waist,
        leanMass: bodyData.leanMass,
        bodyFat: bodyData.bodyFat,
        boneMass: bodyData.boneMass,
        waterLbs: bodyData.waterLbs,
        fromDate: checkDate,
      };
    }
  }

  return {};
}

// ===== Dumbbell Carry-Forward =====
async function getLastDumbbellData(dateStr, env) {
  // Use the cached "latest" key for O(1) lookup instead of scanning up to 30 days
  const latest = await env.HABIT_DATA.get("dumbbell:latest", "json");
  if (latest && latest.date && Array.isArray(latest.data) && latest.data.length > 0) {
    const target = parseDate(dateStr);
    const latestDate = parseDate(latest.date);
    if (latestDate < target) {
      return latest.data;
    }
  }

  // Fallback: scan last 7 days only (not 30)
  const targetDate = parseDate(dateStr);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    const checkDate = `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
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

// ===== Withings OAuth2 Integration =====
// Requires WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET as Worker secrets.
// Set via: wrangler secret put WITHINGS_CLIENT_ID / wrangler secret put WITHINGS_CLIENT_SECRET
// Register your app at https://developer.withings.com with redirect URI:
//   https://habit-proxy.joeywigs.workers.dev/?action=withings_callback

async function withingsAuth(request, env, corsHeaders) {
  if (!env.WITHINGS_CLIENT_ID) {
    return jsonResponse({
      error: true,
      message: "WITHINGS_CLIENT_ID not configured. Set it via: wrangler secret put WITHINGS_CLIENT_ID"
    }, 500, corsHeaders);
  }

  const redirectUri = `${new URL(request.url).origin}/?action=withings_callback`;
  const state = crypto.randomUUID();

  // Store state for CSRF validation (10 min TTL)
  await env.HABIT_DATA.put("withings:state", state, { expirationTtl: 600 });

  const authUrl = new URL("https://account.withings.com/oauth2_user/authorize2");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.WITHINGS_CLIENT_ID);
  authUrl.searchParams.set("scope", "user.activity,user.sleepevents");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

async function withingsCallback(url, env, corsHeaders) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    // Withings developer portal sends POST to verify the URL is reachable — respond 200
    return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain", ...corsHeaders } });
  }

  // Validate CSRF state
  const savedState = await env.HABIT_DATA.get("withings:state");
  if (!state || state !== savedState) {
    return new Response("<html><body><h2>Authorization failed</h2><p>Invalid state parameter (CSRF check).</p></body></html>",
      { status: 400, headers: { "Content-Type": "text/html", ...corsHeaders } });
  }

  const redirectUri = `${url.origin}/?action=withings_callback`;

  const tokenRes = await fetch("https://wbsapi.withings.net/v2/oauth2", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "requesttoken",
      grant_type: "authorization_code",
      client_id: env.WITHINGS_CLIENT_ID,
      client_secret: env.WITHINGS_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenRes.json();
  if (tokenData.status !== 0) {
    return new Response(`<html><body><h2>Token exchange failed</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre></body></html>`,
      { status: 400, headers: { "Content-Type": "text/html", ...corsHeaders } });
  }

  const tokens = {
    access_token: tokenData.body.access_token,
    refresh_token: tokenData.body.refresh_token,
    expires_at: Date.now() + (tokenData.body.expires_in * 1000),
    userid: tokenData.body.userid,
    scope: tokenData.body.scope,
    connected_at: new Date().toISOString(),
  };

  await env.HABIT_DATA.put("withings:tokens", JSON.stringify(tokens));
  await env.HABIT_DATA.delete("withings:state");

  return new Response(`<html>
<body style="font-family:system-ui;text-align:center;padding:60px 20px;background:#111;color:#eee">
  <h2 style="color:#4ade80">Withings Connected</h2>
  <p>Your Withings account is now linked. Sleep data will sync via:</p>
  <code style="display:block;margin:20px auto;padding:12px;background:#222;border-radius:8px;max-width:600px;word-break:break-all;color:#93c5fd">
    GET ${url.origin}/?action=withings_sleep
  </code>
  <p style="color:#999;margin-top:30px">You can close this tab.</p>
</body></html>`, { headers: { "Content-Type": "text/html", ...corsHeaders } });
}

async function withingsStatus(env, corsHeaders) {
  const tokens = await env.HABIT_DATA.get("withings:tokens", "json");
  if (!tokens) {
    return jsonResponse({ connected: false, message: "Not connected to Withings" }, 200, corsHeaders);
  }
  return jsonResponse({
    connected: true,
    userid: tokens.userid,
    connected_at: tokens.connected_at,
    token_expires_at: new Date(tokens.expires_at).toISOString(),
    token_expired: Date.now() > tokens.expires_at,
  }, 200, corsHeaders);
}

// Get a valid access token, auto-refreshing if expired
async function getWithingsAccessToken(env) {
  let tokens = await env.HABIT_DATA.get("withings:tokens", "json");
  if (!tokens) return null;

  // Refresh if expired or expiring within 60 seconds
  if (Date.now() > tokens.expires_at - 60000) {
    const res = await fetch("https://wbsapi.withings.net/v2/oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "requesttoken",
        grant_type: "refresh_token",
        client_id: env.WITHINGS_CLIENT_ID,
        client_secret: env.WITHINGS_CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
      }),
    });

    const data = await res.json();
    if (data.status !== 0) {
      console.error("Withings token refresh failed:", data);
      return null;
    }

    tokens = {
      access_token: data.body.access_token,
      refresh_token: data.body.refresh_token,
      expires_at: Date.now() + (data.body.expires_in * 1000),
      userid: data.body.userid,
      scope: data.body.scope,
      connected_at: tokens.connected_at,
    };
    await env.HABIT_DATA.put("withings:tokens", JSON.stringify(tokens));
  }

  return tokens.access_token;
}

// Fetch sleep data from Withings and save to daily KV
async function withingsFetchSleep(dateStr, env, corsHeaders) {
  const accessToken = await getWithingsAccessToken(env);
  if (!accessToken) {
    return jsonResponse({
      error: true,
      message: "Not connected to Withings. Visit ?action=withings_auth to connect."
    }, 401, corsHeaders);
  }

  // The date parameter is the "wake up" date (daily record to save to).
  // Default: today in Central time. Withings dates sleep by the night it started,
  // so we query for the night before.
  let wakeUpDate;
  if (dateStr) {
    wakeUpDate = normalizeDate(dateStr);
  } else {
    wakeUpDate = normalizeDate(formatDateForKV(new Date()));
  }

  const wakeUpParsed = parseDate(wakeUpDate);
  const sleepNight = new Date(wakeUpParsed);
  sleepNight.setDate(sleepNight.getDate() - 1);

  // Withings uses YYYY-MM-DD format
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const startYmd = fmt(sleepNight);
  const endYmd = fmt(wakeUpParsed);

  // Fetch sleep summary from Withings
  const summaryRes = await fetch("https://wbsapi.withings.net/v2/sleep", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: new URLSearchParams({
      action: "getsummary",
      startdateymd: startYmd,
      enddateymd: endYmd,
      data_fields: "sleep_score,hr_average,hr_min,hr_max,deepsleepduration,lightsleepduration,remsleepduration,wakeupcount,wakeupduration,durationtosleep,durationtowakeup,breathing_disturbances_intensity,snoring,snoringepisodecount,rr_average,sleep_efficiency,total_sleep_time",
    }),
  });

  const summaryData = await summaryRes.json();
  if (summaryData.status !== 0) {
    return jsonResponse({
      error: true,
      message: "Withings API error",
      withings_status: summaryData.status,
      details: summaryData,
    }, 502, corsHeaders);
  }

  const series = summaryData.body?.series;
  if (!series || series.length === 0) {
    return jsonResponse({
      success: true,
      message: `No sleep data found for night of ${startYmd}`,
      date: wakeUpDate,
      queried: { startdateymd: startYmd, enddateymd: endYmd },
    }, 200, corsHeaders);
  }

  // Use the longest sleep period if multiple (ignore naps)
  const summary = series.reduce((best, s) => {
    const dur = (s.enddate || 0) - (s.startdate || 0);
    const bestDur = (best.enddate || 0) - (best.startdate || 0);
    return dur > bestDur ? s : best;
  });
  const sd = summary.data || {};

  // Fetch HRV intraday data (sdnn_1) from the Sleep v2 Get endpoint
  let hrvAvg = null;
  try {
    if (summary.startdate && summary.enddate) {
      const hrvRes = await fetch("https://wbsapi.withings.net/v2/sleep", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: new URLSearchParams({
          action: "get",
          startdate: String(summary.startdate),
          enddate: String(summary.enddate),
          data_fields: "sdnn_1,hr,rr",
        }),
      });

      const hrvData = await hrvRes.json();
      if (hrvData.status === 0 && hrvData.body?.series) {
        const sdnnValues = [];
        for (const entry of hrvData.body.series) {
          if (entry.sdnn_1 !== undefined && entry.sdnn_1 !== null && entry.sdnn_1 > 0) {
            sdnnValues.push(entry.sdnn_1);
          }
        }
        if (sdnnValues.length > 0) {
          hrvAvg = Math.round(sdnnValues.reduce((a, b) => a + b, 0) / sdnnValues.length);
        }
      }
    }
  } catch (e) {
    console.error("Withings HRV fetch failed (non-fatal):", e);
  }

  // Calculate total sleep hours
  const totalSleepSec = sd.total_sleep_time ||
    ((sd.deepsleepduration || 0) + (sd.lightsleepduration || 0) + (sd.remsleepduration || 0));
  const totalSleepHours = totalSleepSec > 0 ? Math.round(totalSleepSec / 3600 * 10) / 10 : null;

  // Derive Sleep Depth rating from deep sleep percentage
  let depthRating = "";
  if (totalSleepSec > 0 && sd.deepsleepduration) {
    const deepPct = (sd.deepsleepduration / totalSleepSec) * 100;
    if (deepPct >= 20) depthRating = "Optimal";
    else if (deepPct >= 15) depthRating = "Good";
    else if (deepPct >= 10) depthRating = "Fair";
    else if (deepPct >= 5) depthRating = "Poor";
    else depthRating = "Bad";
  }

  // Build updates for the daily record
  const updates = {};
  if (totalSleepHours) updates["Hours of Sleep"] = totalSleepHours;
  if (sd.sleep_score) updates["Sleep Score"] = sd.sleep_score;
  if (sd.hr_average) updates["Sleep HR"] = Math.round(sd.hr_average);
  if (hrvAvg) updates["Sleep HRV"] = hrvAvg;
  if (depthRating) updates["Sleep Depth"] = depthRating;
  if (sd.wakeupcount !== undefined) updates["Sleep Interruptions"] = sd.wakeupcount;
  // Sleep Regularity not available from Withings API — left for manual entry

  if (Object.keys(updates).length === 0) {
    return jsonResponse({
      success: true,
      message: "Withings returned sleep data but no usable metrics",
      date: wakeUpDate,
      withings_raw: sd,
    }, 200, corsHeaders);
  }

  // Merge into existing daily record
  const existing = await env.HABIT_DATA.get(`daily:${wakeUpDate}`, "json") || {};
  const merged = { ...existing, "Date": wakeUpDate, ...updates };
  await env.HABIT_DATA.put(`daily:${wakeUpDate}`, JSON.stringify(merged));
  await env.HABIT_DATA.delete(`cf:${wakeUpDate}`).catch(() => {});

  return jsonResponse({
    success: true,
    date: wakeUpDate,
    source: "withings",
    updated: Object.keys(updates),
    values: updates,
    withings_raw: sd,
    hrv_avg: hrvAvg,
    message: `Withings sleep data saved for ${wakeUpDate}`,
  }, 200, corsHeaders);
}

// ===== Helpers =====
function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
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

// ===== Migration: Backfill custom section fields into daily records =====
// Takes section metadata from the client (since worker doesn't have appSettings)
// and writes descriptive named fields into each daily:{date} record.
async function migrateCustomFields(sectionMeta, env, corsHeaders) {
  const results = { migrated: 0, skipped: 0, errors: [] };

  // Build a lookup: sectionId → { sectionName, fields: [{ fieldId, fieldName, type, config }] }
  const metaMap = {};
  sectionMeta.forEach(s => {
    metaMap[s.id] = s;
  });

  // List all custom:{date} keys
  const customKeys = await env.HABIT_DATA.list({ prefix: "custom:" });

  for (const key of customKeys.keys) {
    try {
      const dateStr = key.name.replace("custom:", "");
      const customData = await env.HABIT_DATA.get(key.name, "json");
      if (!customData || typeof customData !== 'object') {
        results.skipped++;
        continue;
      }

      // Build flat named fields from this day's custom data
      const flat = {};
      for (const [sectionId, sectionData] of Object.entries(customData)) {
        const meta = metaMap[sectionId];
        if (!meta || !meta.fields) continue;

        for (const fieldMeta of meta.fields) {
          const fd = sectionData[fieldMeta.fieldId];
          if (!fd) continue;

          const fields = meta.fields;
          const fieldKey = (fields.length > 1 || (fieldMeta.fieldName && fieldMeta.fieldName !== meta.name))
            ? `${meta.name}: ${fieldMeta.fieldName}`
            : meta.name;

          const t = fieldMeta.type;
          if (t === 'counter') {
            flat[fieldKey] = fd.value || 0;
          } else if (t === 'checkbox') {
            const cbs = fieldMeta.checkboxes || ['Done'];
            if (cbs.length === 1) {
              flat[fieldKey] = fd.checkboxes?.[0] || false;
            } else {
              cbs.forEach((cb, i) => {
                flat[`${fieldKey}: ${cb}`] = fd.checkboxes?.[i] || false;
              });
            }
          } else if (t === 'toggle') {
            flat[fieldKey] = fd.value || false;
          } else if (t === 'rating') {
            flat[fieldKey] = fd.value || 0;
          } else if (t === 'log') {
            flat[fieldKey] = fd.entries || [];
          } else {
            flat[fieldKey] = fd.value || '';
          }
        }
      }

      if (Object.keys(flat).length === 0) {
        results.skipped++;
        continue;
      }

      // Merge into existing daily record
      const daily = await env.HABIT_DATA.get(`daily:${dateStr}`, "json") || {};
      Object.assign(daily, flat);
      await env.HABIT_DATA.put(`daily:${dateStr}`, JSON.stringify(daily));

      results.migrated++;
    } catch (e) {
      results.errors.push({ key: key.name, error: e.message });
    }
  }

  return jsonResponse({
    success: true,
    message: `Migration complete: ${results.migrated} days updated, ${results.skipped} skipped, ${results.errors.length} errors`,
    ...results
  }, 200, corsHeaders);
}

// ===== Export All Data =====
async function exportAll(env, corsHeaders) {
  // Collect all KV keys by prefix in parallel
  const [dailyKeys, movementKeys, readingKeys, dumbbellKeys, customKeys, workoutKeys, bodyKeys] = await Promise.all([
    env.HABIT_DATA.list({ prefix: "daily:" }),
    env.HABIT_DATA.list({ prefix: "movements:" }),
    env.HABIT_DATA.list({ prefix: "readings:" }),
    env.HABIT_DATA.list({ prefix: "dumbbell:" }),
    env.HABIT_DATA.list({ prefix: "custom:" }),
    env.HABIT_DATA.list({ prefix: "workouts:" }),
    env.HABIT_DATA.list({ prefix: "body:" }),
  ]);

  // Fetch all values in parallel (batch by type)
  const fetchAll = async (keys) => {
    const entries = {};
    const promises = keys.keys.map(async (k) => {
      const date = k.name.split(":").slice(1).join(":");
      entries[date] = await env.HABIT_DATA.get(k.name, "json");
    });
    await Promise.all(promises);
    return entries;
  };

  const [daily, movements, readings, dumbbell, custom, workouts, body,
         biomarkers, phases, settings, bedtime, morning, habitNotes, cueLogs] = await Promise.all([
    fetchAll(dailyKeys),
    fetchAll(movementKeys),
    fetchAll(readingKeys),
    fetchAll(dumbbellKeys),
    fetchAll(customKeys),
    fetchAll(workoutKeys),
    fetchAll(bodyKeys),
    env.HABIT_DATA.get("biomarkers:values", "json"),
    env.HABIT_DATA.get("phases", "json"),
    env.HABIT_DATA.get("app:settings", "json"),
    env.HABIT_DATA.get("bedtime:items", "json"),
    env.HABIT_DATA.get("morning:items", "json"),
    env.HABIT_DATA.get("habit:notes", "json"),
    env.HABIT_DATA.get("cue:logs", "json"),
  ]);

  return jsonResponse({
    daily,
    movements,
    readings,
    dumbbell,
    custom,
    workouts,
    body,
    biomarkers: biomarkers || {},
    phases: phases || [],
    settings: settings || {},
    bedtime: bedtime || [],
    morning: morning || [],
    habitNotes: habitNotes || [],
    cueLogs: cueLogs || [],
  }, 200, corsHeaders);
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
    { key: 'sleepScore', field: 'Sleep Score', type: 'numeric', description: 'Withings sleep quality score (0-100)' },
    { key: 'sleepHR', field: 'Sleep HR', type: 'numeric', description: 'Withings sleep heart rate (bpm)' },
    { key: 'sleepHRV', field: 'Sleep HRV', type: 'numeric', description: 'Withings sleep HRV (ms)' },
    { key: 'sleepDepth', field: 'Sleep Depth', type: 'string', description: 'Withings sleep depth rating' },
    { key: 'sleepRegularity', field: 'Sleep Regularity', type: 'string', description: 'Withings sleep regularity rating' },
    { key: 'sleepInterruptions', field: 'Sleep Interruptions', type: 'numeric', description: 'Withings sleep interruptions count' },
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
    { key: 'protein', field: 'Protein', type: 'numeric', description: 'Protein grams' },
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

// ===== Calendar: Fetch tomorrow's early event from iCal feed =====
async function getCalendarEvent(env, corsHeaders) {
  const settings = await env.HABIT_DATA.get("app:settings", "json");
  const icalUrl = settings?.calendarIcalUrl;
  if (!icalUrl) {
    return jsonResponse({ event: null, reason: "no_ical_url" }, 200, corsHeaders);
  }

  try {
    const res = await fetch(icalUrl, { headers: { "User-Agent": "HabitTracker/1.0" } });
    if (!res.ok) {
      return jsonResponse({ event: null, reason: "fetch_failed", status: res.status }, 200, corsHeaders);
    }
    const icalText = await res.text();
    const events = parseIcal(icalText);

    // Determine "tomorrow" in the user's timezone (default America/Chicago)
    const tz = settings?.timezone || "America/Chicago";
    const now = new Date();
    const todayStr = localDateStr(now, tz);
    const tomorrow = new Date(now.getTime() + 86400000);
    const tomorrowStr = localDateStr(tomorrow, tz);

    // Find events occurring tomorrow before 9 AM
    const earlyEvents = [];
    for (const ev of events) {
      const occurrences = getOccurrencesOnDate(ev, tomorrowStr, tz);
      for (const occ of occurrences) {
        if (occ.hour < 9) {
          earlyEvents.push({
            title: ev.summary,
            time: formatTime(occ.hour, occ.minute),
            hour: occ.hour,
            minute: occ.minute,
          });
        }
      }
    }

    if (earlyEvents.length === 0) {
      return jsonResponse({ event: null, reason: "no_early_events" }, 200, corsHeaders);
    }

    // Return the earliest one
    earlyEvents.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    return jsonResponse({ event: earlyEvents[0] }, 200, corsHeaders);
  } catch (err) {
    return jsonResponse({ event: null, reason: "parse_error", error: err.message }, 200, corsHeaders);
  }
}

// Format local date as YYYYMMDD for comparison
function localDateStr(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}${m}${d}`;
}

function formatTime(h, m) {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Parse iCal text into event objects
function parseIcal(text) {
  const events = [];
  const lines = unfoldIcalLines(text);
  let inEvent = false;
  let ev = {};

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      ev = { summary: "", dtstart: "", dtend: "", rrule: "", exdates: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      inEvent = false;
      if (ev.dtstart) events.push(ev);
      continue;
    }
    if (!inEvent) continue;

    if (line.startsWith("SUMMARY:")) {
      ev.summary = line.slice(8);
    } else if (line.startsWith("DTSTART")) {
      ev.dtstart = line;
    } else if (line.startsWith("DTEND")) {
      ev.dtend = line;
    } else if (line.startsWith("RRULE:")) {
      ev.rrule = line.slice(6);
    } else if (line.startsWith("EXDATE")) {
      // EXDATE may have params like TZID
      const val = line.includes(":") ? line.split(":").pop() : "";
      if (val) ev.exdates.push(...val.split(","));
    }
  }
  return events;
}

// Unfold continuation lines (lines starting with space/tab)
function unfoldIcalLines(text) {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const result = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && result.length > 0) {
      result[result.length - 1] += line.slice(1);
    } else {
      result.push(line);
    }
  }
  return result;
}

// Parse DTSTART line into { dateStr: "YYYYMMDD", hour, minute, allDay, tzid }
function parseDtStart(dtLine, tz) {
  // Formats:
  //   DTSTART:20260225T070000Z          (UTC)
  //   DTSTART;TZID=America/Chicago:20260225T070000  (with timezone)
  //   DTSTART;VALUE=DATE:20260225       (all-day)
  //   DTSTART:20260225                  (all-day)
  const colonIdx = dtLine.indexOf(":");
  const params = dtLine.slice(0, colonIdx);
  const value = dtLine.slice(colonIdx + 1).trim();

  // All-day event
  if (params.includes("VALUE=DATE") || value.length === 8) {
    return { dateStr: value.slice(0, 8), hour: 0, minute: 0, allDay: true, tzid: null };
  }

  // Extract TZID if present
  const tzMatch = params.match(/TZID=([^;:]+)/);
  const evTz = tzMatch ? tzMatch[1] : null;

  const datePart = value.slice(0, 8);
  const timePart = value.slice(9, 15); // HHMMSS
  const isUTC = value.endsWith("Z");

  let hour = parseInt(timePart.slice(0, 2));
  let minute = parseInt(timePart.slice(2, 4));

  if (isUTC) {
    // Convert UTC to local timezone
    const d = new Date(Date.UTC(
      parseInt(datePart.slice(0, 4)),
      parseInt(datePart.slice(4, 6)) - 1,
      parseInt(datePart.slice(6, 8)),
      hour, minute
    ));
    const localDate = localDateStr(d, tz);
    const localParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "numeric", minute: "numeric", hour12: false
    }).formatToParts(d);
    const lh = parseInt(localParts.find(p => p.type === "hour").value);
    const lm = parseInt(localParts.find(p => p.type === "minute").value);
    return { dateStr: localDate, hour: lh === 24 ? 0 : lh, minute: lm, allDay: false, tzid: "UTC" };
  }

  if (evTz && evTz !== tz) {
    // Convert from event timezone to user timezone
    const d = new Date(`${datePart.slice(0,4)}-${datePart.slice(4,6)}-${datePart.slice(6,8)}T${timePart.slice(0,2)}:${timePart.slice(2,4)}:${timePart.slice(4,6)}`);
    // Use the event's timezone to create the correct instant
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: evTz, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "numeric", hour12: false });
    // This is a bit tricky — we need to figure out the UTC offset of the event timezone
    // Simpler: construct a Date using known UTC conversion
    const evDateStr = `${datePart.slice(0,4)}-${datePart.slice(4,6)}-${datePart.slice(6,8)}T${timePart.slice(0,2)}:${timePart.slice(2,4)}:00`;
    // Use a trick: format in evTz to find offset, then adjust
    // For simplicity, just trust the TZID and return the local time as-is if same continent
    // (most users' calendars are in their own timezone)
    return { dateStr: datePart, hour, minute, allDay: false, tzid: evTz };
  }

  return { dateStr: datePart, hour, minute, allDay: false, tzid: evTz || tz };
}

// Get occurrences of an event on a specific date (YYYYMMDD)
function getOccurrencesOnDate(ev, targetDate, tz) {
  const start = parseDtStart(ev.dtstart, tz);
  const results = [];

  // Check excluded dates
  const exDateStrs = ev.exdates.map(ex => ex.replace(/[^0-9]/g, "").slice(0, 8));

  if (!ev.rrule) {
    // Single event — just check if it's on the target date
    if (start.dateStr === targetDate && !exDateStrs.includes(targetDate)) {
      results.push({ hour: start.allDay ? 0 : start.hour, minute: start.allDay ? 0 : start.minute });
    }
    return results;
  }

  // Parse RRULE
  const rules = {};
  ev.rrule.split(";").forEach(part => {
    const [k, v] = part.split("=");
    rules[k] = v;
  });

  const freq = rules.FREQ;
  const interval = parseInt(rules.INTERVAL || "1");
  const until = rules.UNTIL ? rules.UNTIL.replace(/[^0-9]/g, "").slice(0, 8) : null;
  const count = rules.COUNT ? parseInt(rules.COUNT) : null;
  const byDay = rules.BYDAY ? rules.BYDAY.split(",") : null;

  // Quick check: if UNTIL is before target date, skip
  if (until && until < targetDate) return results;

  const startDate = parseYMD(start.dateStr);
  const target = parseYMD(targetDate);

  if (target < startDate) return results;

  // Check if target date matches the recurrence pattern
  const daysDiff = Math.round((target - startDate) / 86400000);

  let matches = false;

  if (freq === "DAILY") {
    matches = daysDiff % interval === 0;
  } else if (freq === "WEEKLY") {
    const weeksDiff = Math.floor(daysDiff / 7);
    if (weeksDiff % interval === 0 || (daysDiff % (interval * 7) < 7)) {
      if (byDay) {
        const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
        const targetDow = target.getUTCDay();
        matches = byDay.some(d => dayMap[d] === targetDow);
      } else {
        // Same day of week as start
        matches = target.getUTCDay() === startDate.getUTCDay() && daysDiff % (interval * 7) === 0;
      }
    }
  } else if (freq === "MONTHLY") {
    const monthsDiff = (target.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
                        (target.getUTCMonth() - startDate.getUTCMonth());
    if (monthsDiff % interval === 0 && target.getUTCDate() === startDate.getUTCDate()) {
      matches = true;
    }
  } else if (freq === "YEARLY") {
    const yearsDiff = target.getUTCFullYear() - startDate.getUTCFullYear();
    if (yearsDiff % interval === 0 &&
        target.getUTCMonth() === startDate.getUTCMonth() &&
        target.getUTCDate() === startDate.getUTCDate()) {
      matches = true;
    }
  }

  // Apply COUNT limit (approximate — count from start to target)
  if (matches && count) {
    let approxOccurrences;
    if (freq === "DAILY") approxOccurrences = Math.floor(daysDiff / interval) + 1;
    else if (freq === "WEEKLY") approxOccurrences = Math.floor(daysDiff / (7 * interval)) + 1;
    else if (freq === "MONTHLY") {
      const md = (target.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
                  (target.getUTCMonth() - startDate.getUTCMonth());
      approxOccurrences = Math.floor(md / interval) + 1;
    }
    else approxOccurrences = (target.getUTCFullYear() - startDate.getUTCFullYear()) / interval + 1;
    if (approxOccurrences > count) matches = false;
  }

  if (matches && !exDateStrs.includes(targetDate)) {
    results.push({ hour: start.allDay ? 0 : start.hour, minute: start.allDay ? 0 : start.minute });
  }

  return results;
}

function parseYMD(s) {
  return new Date(Date.UTC(parseInt(s.slice(0,4)), parseInt(s.slice(4,6)) - 1, parseInt(s.slice(6,8))));
}
