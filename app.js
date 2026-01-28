/**************************************
 * Habit Tracker - code.gs (clean)
 *
 * Routes:
 * - GET  ?action=load&date=M/D/YY&key=...
 * - POST { action:"save", key:"...", data:{...} }
 * - GET  ?action=biomarkers_load&key=...
 * - POST { action:"biomarkers_save", key:"...", date:"M/D/YY", values:[...] }
 *
 * REHIT stored in "REHIT 2x10" column as:
 * - "2x10" / "3x10" / ""  (backwards compatible with TRUE)
 *
 * Averages returned:
 * - rehitWeek (2x10 + 3x10)
 * - rehit3Week (3x10 only)
 * - readingMinutes7d (rolling)
 **************************************/

const SPREADSHEET_ID = "1L4tbpsUv5amXWYNBLHLcsVueD289THc8a5ys9reSd98";

// Optional helper to set Script Properties once (put your real key and run once)
function setApiKeyOnce() {
  PropertiesService.getScriptProperties().setProperty("API_KEY", "PUT_YOUR_REAL_KEY_HERE");
}

function doGet(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const action = String(p.action || "").toLowerCase();
    assertKey_(p.key);

    if (action === "ping") return json_({ ok: true, ts: new Date().toISOString() });

    if (action === "load") {
      const dateStr = String(p.date || "").trim();
      if (!dateStr) return json_({ error: true, message: "Missing date" });
      return json_(loadDataForDate(dateStr));
    }

    if (action === "biomarkers_load") {
      return json_(loadBiomarkers_());
    }

    return json_({ error: true, message: `Unknown action: ${action}` });
  } catch (err) {
    return json_({ error: true, message: err && err.message ? err.message : String(err) });
  }
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw);

    assertKey_(body.key);

    const action = String(body.action || "").toLowerCase();

    if (action === "save") {
      if (!body.data) return json_({ error: true, message: "Missing data" });
      return json_(saveDataForDate(body.data));
    }

    if (action === "biomarkers_save") {
      if (!body.date) return json_({ error: true, message: "Missing date" });
      if (!body.values) return json_({ error: true, message: "Missing values" });
      return json_(saveBiomarkers_(String(body.date), body.values));
    }

    if (action === "ping") return json_({ ok: true, ts: new Date().toISOString(), via: "post" });

    return json_({ error: true, message: `Unknown action: ${action}` });
  } catch (err) {
    return json_({ error: true, message: err && err.message ? err.message : String(err) });
  }
}

// =========================
// Auth + JSON
// =========================
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function assertKey_(providedKey) {
  const storedKey = PropertiesService.getScriptProperties().getProperty("API_KEY");
  if (!storedKey) throw new Error("API key not set. Run setApiKeyOnce().");
  if (!providedKey || String(providedKey) !== String(storedKey)) throw new Error("Unauthorized");
}

// =========================
// Daily headers (match your sheet)
// =========================
function DAILY_HEADERS_() {
  return [
    "Date",
    "Hours of Sleep",
    "Grey's Inhaler Morning",
    "Grey's Inhaler Evening",
    "5 min Multiplication",
    "REHIT 2x10",
    "Fitness Score",
    "Calories",
    "Peak Watts",
    "Watt Seconds",
    "Steps",
    "Creatine Chews",
    "Vitamin D",
    "NO2",
    "Psyllium Husk",
    "Breakfast",
    "Lunch",
    "Dinner",
    "Healthy Day Snacks",
    "Healthy Night Snacks",
    "No Alcohol",
    "Water",
    "Weight (lbs)",
    "Waist",
    "Lean Mass (lbs)",
    "Lean Mass %",
    "Body Fat (lbs)",
    "Body Fat %",
    "Bone Mass (lbs)",
    "Bone Mass %",
    "Water (lbs)",
    "Water %",
    "Systolic",
    "Diastolic",
    "Heart Rate",
    "Meditation"
  ];
}

// =========================
// LOAD
// =========================
function loadDataForDate(dateStr) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    const dailySheet = getOrCreateSheet(ss, "Daily Data", DAILY_HEADERS_());
    const daily = findRowByDate(dailySheet, dateStr);

    const movementSheet = getOrCreateSheet(ss, "Movement Log", ["Date", "Duration (min)", "Type"]);
    const movements = getItemsByDate(movementSheet, dateStr);

    const readingSheet = getOrCreateSheet(ss, "Reading Log", ["Date", "Duration (min)", "Book"]);
    const readings = getItemsByDate(readingSheet, dateStr);

    const honeyDoSheet = getOrCreateSheet(ss, "Honey-Dos", ["ID", "Created", "Due", "Task", "Completed", "Completed Date"]);
    const honeyDos = getHoneyDos_(honeyDoSheet, dateStr);

    const reflectionsSheet = getOrCreateSheet(ss, "Reflections", ["Date", "Text"]);
    const reflections = findRowByDate(reflectionsSheet, dateStr);

    const storiesSheet = getOrCreateSheet(ss, "Grey & Sloane", ["Date", "Text"]);
    const stories = findRowByDate(storiesSheet, dateStr);

    const carlySheet = getOrCreateSheet(ss, "Carly", ["Date", "Text"]);
    const carly = findRowByDate(carlySheet, dateStr);

    return {
      daily,
      movements,
      readings,
      honeyDos,
      reflections: reflections ? (reflections["Text"] || "") : "",
      stories: stories ? (stories["Text"] || "") : "",
      carly: carly ? (carly["Text"] || "") : "",
      averages: calculate7DayAverages(dateStr)
    };
  } catch (err) {
    return { error: true, message: err.message, stack: err.stack };
  }
}

// =========================
// SAVE
// =========================
function saveDataForDate(data) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const dateStr = String(data.date || "").trim();
    if (!dateStr) throw new Error("Missing required field: date");

    const dailySheet = getOrCreateSheet(ss, "Daily Data", DAILY_HEADERS_());

    // Backward compatibility: if old app sent boolean true, treat as "2x10"
    let rehitVal = data.rehit;
    if (rehitVal === true || rehitVal === "TRUE" || rehitVal === "true") rehitVal = "2x10";

    const rowNumber = saveOrUpdateRow(dailySheet, dateStr, [
      dateStr,
      data.sleepHours || "",
      data.inhalerMorning || false,
      data.inhalerEvening || false,
      data.multiplication || false,
      rehitVal || "",
      data.fitnessScore || "",
      data.calories || "",
      data.peakWatts || "",
      data.wattSeconds || "",
      data.steps || "",
      data.creatine || false,
      data.vitaminD || false,
      data.no2 || false,
      data.psyllium || false,
      data.breakfast || false,
      data.lunch || false,
      data.dinner || false,
      data.daySnacks || false,
      data.nightSnacks || false,
      data.noAlcohol || false,
      data.hydrationGood || 0,
      data.weight || "",
      data.waist || "",
      data.leanMass || "",
      "", // Lean Mass % formula
      data.bodyFat || "",
      "", // Body Fat % formula
      data.boneMass || "",
      "", // Bone Mass % formula
      data.water || "",
      "", // Water % formula
      data.systolic || "",
      data.diastolic || "",
      data.heartRate || "",
      data.meditation || false
    ]);

    applyBodyPercentFormulas_(dailySheet, rowNumber);

    // Movements (replace all for date)
    const movementSheet = getOrCreateSheet(ss, "Movement Log", ["Date", "Duration (min)", "Type"]);
    deleteRowsByDate(movementSheet, dateStr);
    if (Array.isArray(data.movements)) {
      data.movements.forEach(m => movementSheet.appendRow([dateStr, m.duration || "", m.type || ""]));
    }

    // Readings (replace all for date)
    const readingSheet = getOrCreateSheet(ss, "Reading Log", ["Date", "Duration (min)", "Book"]);
    deleteRowsByDate(readingSheet, dateStr);
    if (Array.isArray(data.readings)) {
      data.readings.forEach(r => readingSheet.appendRow([dateStr, r.duration || "", r.book || ""]));
    }

    // Honey-dos upsert by ID
    const honeyDoSheet = getOrCreateSheet(ss, "Honey-Dos", ["ID", "Created", "Due", "Task", "Completed", "Completed Date"]);
    if (Array.isArray(data.honeyDos)) {
      const existing = honeyDoSheet.getDataRange().getValues();

      data.honeyDos.forEach(h => {
        const id = h.id || Utilities.getUuid();
        const created = h.created || dateStr;
        const due = h.due || "";
        const task = h.task || "";
        const completed = !!h.completed;
        const completedDate = completed ? dateStr : "";

        let foundRow = -1;
        for (let i = 1; i < existing.length; i++) {
          if (existing[i][0] === id) { foundRow = i + 1; break; }
        }

        const rowVals = [id, created, due, task, completed, completedDate];
        if (foundRow > 0) honeyDoSheet.getRange(foundRow, 1, 1, 6).setValues([rowVals]);
        else honeyDoSheet.appendRow(rowVals);
      });
    }

    // Reflections / Stories / Carly
    const reflectionsSheet = getOrCreateSheet(ss, "Reflections", ["Date", "Text"]);
    saveOrUpdateRow(reflectionsSheet, dateStr, [dateStr, data.reflections || ""]);

    const storiesSheet = getOrCreateSheet(ss, "Grey & Sloane", ["Date", "Text"]);
    saveOrUpdateRow(storiesSheet, dateStr, [dateStr, data.stories || ""]);

    const carlySheet = getOrCreateSheet(ss, "Carly", ["Date", "Text"]);
    saveOrUpdateRow(carlySheet, dateStr, [dateStr, data.carly || ""]);

    return { success: true };
  } catch (err) {
    return { error: true, message: err.message, stack: err.stack };
  }
}

// =========================
// Averages (Sun->Sat week for REHIT + sleep/steps, rolling for reading)
// =========================
function calculate7DayAverages(dateStr) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const dailySheet = ss.getSheetByName("Daily Data");
  const movementSheet = ss.getSheetByName("Movement Log");
  const readingSheet = ss.getSheetByName("Reading Log");

  if (!dailySheet) {
    return { sleep: null, steps: null, movements: null, rehitWeek: 0, rehit3Week: 0, readingMinutes7d: 0 };
  }

  const data = dailySheet.getDataRange().getValues();
  const headers = data[0];

  const dateCol = headers.indexOf("Date");
  const sleepCol = headers.indexOf("Hours of Sleep");
  const stepsCol = headers.indexOf("Steps");
  const rehitCol = headers.indexOf("REHIT 2x10");

  const targetDate = new Date(dateStr + " 12:00:00");

  // Week boundaries Sun->Sat
  const currentDay = targetDate.getDay(); // 0=Sun
  const weekStart = new Date(targetDate);
  weekStart.setDate(targetDate.getDate() - currentDay);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  // Rolling 7 days
  const start7d = new Date(targetDate);
  start7d.setDate(targetDate.getDate() - 6);
  start7d.setHours(0, 0, 0, 0);

  const end7d = new Date(targetDate);
  end7d.setHours(23, 59, 59, 999);

  let sleepValues = [];
  let stepsValues = [];
  let rehitThisWeek = 0;
  let rehit3ThisWeek = 0;

  for (let i = 1; i < data.length; i++) {
    const rowDate = new Date(formatDate(data[i][dateCol]) + " 12:00:00");

    if (rowDate >= weekStart && rowDate <= weekEnd) {
      const sleep = parseFloat(data[i][sleepCol]);
      const steps = parseInt(data[i][stepsCol], 10);
      const rehit = data[i][rehitCol];

      if (!isNaN(sleep) && sleep > 0) sleepValues.push(sleep);
      if (!isNaN(steps) && steps > 0) stepsValues.push(steps);

      const rv = String(rehit ?? "").trim().toLowerCase();
      const isOldTrue = (rv === "true");
      const is2 = (rv === "2x10");
      const is3 = (rv === "3x10");

      if (isOldTrue || is2 || is3) rehitThisWeek++;
      if (is3) rehit3ThisWeek++;
    }
  }

  // Movements/day (week-to-date)
  let movementCounts = {};
  if (movementSheet) {
    const mData = movementSheet.getDataRange().getValues();
    const mHeaders = mData[0];
    const mDateCol = mHeaders.indexOf("Date");

    for (let i = 1; i < mData.length; i++) {
      const rowDate = new Date(formatDate(mData[i][mDateCol]) + " 12:00:00");
      if (rowDate >= weekStart && rowDate <= weekEnd) {
        const key = formatDate(mData[i][mDateCol]);
        movementCounts[key] = (movementCounts[key] || 0) + 1;
      }
    }
  }

  const totalMovements = Object.values(movementCounts).reduce((a, b) => a + b, 0);
  const daysInWeekSoFar = Math.min(currentDay + 1, 7);
  const avgMovements = daysInWeekSoFar > 0 ? (totalMovements / daysInWeekSoFar).toFixed(1) : null;

  const avgSleep = sleepValues.length ? sleepValues.reduce((a, b) => a + b, 0) / sleepValues.length : null;
  const avgSteps = stepsValues.length ? Math.round(stepsValues.reduce((a, b) => a + b, 0) / stepsValues.length) : null;

  // Reading minutes rolling 7 days
  let readingMinutes7d = 0;
  if (readingSheet) {
    const rData = readingSheet.getDataRange().getValues();
    const rHeaders = rData[0];
    const rDateCol = rHeaders.indexOf("Date");
    const rDurCol = rHeaders.indexOf("Duration (min)");

    for (let i = 1; i < rData.length; i++) {
      const rowDate = new Date(formatDate(rData[i][rDateCol]) + " 12:00:00");
      if (rowDate >= start7d && rowDate <= end7d) {
        const mins = parseFloat(rData[i][rDurCol]);
        if (!isNaN(mins) && mins > 0) readingMinutes7d += mins;
      }
    }
  }

  return {
    sleep: avgSleep,
    steps: avgSteps,
    movements: avgMovements,
    rehitWeek: rehitThisWeek,
    rehit3Week: rehit3ThisWeek,
    readingMinutes7d: Math.round(readingMinutes7d)
  };
}

// =========================
// Sheet helpers
// =========================
function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function findRowByDate(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return null;

  const headers = data[0];

  for (let i = 1; i < data.length; i++) {
    const rowDate = formatDate(data[i][0]);
    if (rowDate === dateStr) {
      const obj = {};
      headers.forEach((h, idx) => {
        if (h !== "Date") obj[h] = data[i][idx];
      });
      return obj;
    }
  }
  return null;
}

function getItemsByDate(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const headers = data[0];
  const items = [];

  for (let i = 1; i < data.length; i++) {
    const rowDate = formatDate(data[i][0]);
    if (rowDate === dateStr) {
      const obj = {};
      headers.forEach((h, idx) => {
        if (h !== "Date") obj[h.toLowerCase()] = data[i][idx];
      });
      items.push(obj);
    }
  }
  return items;
}

function deleteRowsByDate(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    const rowDate = formatDate(data[i][0]);
    if (rowDate === dateStr) sheet.deleteRow(i + 1);
  }
}

// Returns row number written
function saveOrUpdateRow(sheet, dateStr, values) {
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const rowDate = formatDate(data[i][0]);
    if (rowDate === dateStr) {
      const rowNumber = i + 1;
      sheet.getRange(rowNumber, 1, 1, values.length).setValues([values]);
      return rowNumber;
    }
  }

  sheet.appendRow(values);
  return sheet.getLastRow();
}

// Noon-safe date normalization
function formatDate(date) {
  if (!date) return "";

  if (typeof date === "string") {
    const s = date.trim();
    if (s.includes("/")) {
      const parts = s.split("/");
      if (parts.length === 3) {
        const m = String(parseInt(parts[0], 10));
        const d = String(parseInt(parts[1], 10));
        let y = parts[2].trim();
        if (y.length === 4) y = y.slice(-2);
        return `${m}/${d}/${y}`;
      }
      return s;
    }

    const dObj = new Date(s);
    if (!isNaN(dObj.getTime())) {
      dObj.setHours(12, 0, 0, 0);
      return `${dObj.getMonth() + 1}/${dObj.getDate()}/${String(dObj.getFullYear()).slice(-2)}`;
    }
    return s;
  }

  if (date instanceof Date) {
    const dObj = new Date(date);
    dObj.setHours(12, 0, 0, 0);
    return `${dObj.getMonth() + 1}/${dObj.getDate()}/${String(dObj.getFullYear()).slice(-2)}`;
  }

  const dObj = new Date(date);
  if (!isNaN(dObj.getTime())) {
    dObj.setHours(12, 0, 0, 0);
    return `${dObj.getMonth() + 1}/${dObj.getDate()}/${String(dObj.getFullYear()).slice(-2)}`;
  }
  return String(date);
}

// Apply body % formulas for the saved row
function applyBodyPercentFormulas_(dailySheet, rowNumber) {
  const headers = dailySheet.getRange(1, 1, 1, dailySheet.getLastColumn()).getValues()[0];
  const col = (name) => headers.indexOf(name) + 1;

  const weightCol = col("Weight (lbs)");
  const leanCol = col("Lean Mass (lbs)");
  const leanPctCol = col("Lean Mass %");
  const fatCol = col("Body Fat (lbs)");
  const fatPctCol = col("Body Fat %");
  const boneCol = col("Bone Mass (lbs)");
  const bonePctCol = col("Bone Mass %");
  const waterCol = col("Water (lbs)");
  const waterPctCol = col("Water %");

  const required = [weightCol, leanCol, leanPctCol, fatCol, fatPctCol, boneCol, bonePctCol, waterCol, waterPctCol];
  if (required.some(c => !c || c < 1)) return;

  const mkPct = (massCol) => `=IFERROR(RC${massCol}/RC${weightCol},"")`;

  dailySheet.getRange(rowNumber, leanPctCol).setFormulaR1C1(mkPct(leanCol));
  dailySheet.getRange(rowNumber, fatPctCol).setFormulaR1C1(mkPct(fatCol));
  dailySheet.getRange(rowNumber, bonePctCol).setFormulaR1C1(mkPct(boneCol));
  dailySheet.getRange(rowNumber, waterPctCol).setFormulaR1C1(mkPct(waterCol));

  dailySheet.getRange(rowNumber, leanPctCol).setNumberFormat("0.0%");
  dailySheet.getRange(rowNumber, fatPctCol).setNumberFormat("0.0%");
  dailySheet.getRange(rowNumber, bonePctCol).setNumberFormat("0.0%");
  dailySheet.getRange(rowNumber, waterPctCol).setNumberFormat("0.0%");
}

// Honey-dos (returns active + completed today)
function getHoneyDos_(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const headers = data[0];
  const hasIdColumn = headers[0] === "ID";
  const items = [];

  if (!hasIdColumn) return items;

  for (let i = 1; i < data.length; i++) {
    const taskId = data[i][0];
    const createdDate = data[i][1] ? formatDate(data[i][1]) : "";
    const dueDate = data[i][2] ? formatDate(data[i][2]) : "";
    const task = data[i][3];
    const completed = data[i][4];
    const completedDate = data[i][5] ? formatDate(data[i][5]) : "";

    if (!createdDate || createdDate.includes("NaN") || !task) continue;

    if (!completed || completedDate === dateStr) {
      items.push({
        id: taskId,
        created: createdDate,
        due: dueDate,
        task: task,
        completed: completed === true || completed === "TRUE" || completed === "true"
      });
    }
  }

  return items;
}

// =========================
// Biomarkers
// =========================
function getOrCreateBiomarkersSheet_(ss) {
  const name = "Biomarkers";
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, 4).setValues([["Category", "Biomarker", "Optimal Range", "Units"]]);
    sheet.getRange(1, 1, 1, 4).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function loadBiomarkers_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateBiomarkersSheet_(ss);

  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();

  const defRange = sheet.getRange(2, 1, Math.max(0, lastRow - 1), 4).getValues();
  const definition = defRange
    .filter(r => r[0] || r[1] || r[2] || r[3])
    .map(r => ({ category: r[0], biomarker: r[1], optimal: r[2], units: r[3] }));

  let latestCol = 0;
  let latestDate = "";

  if (lastCol >= 5) {
    const headerRow = sheet.getRange(1, 5, 1, lastCol - 4).getValues()[0];
    for (let i = headerRow.length - 1; i >= 0; i--) {
      const v = headerRow[i];
      if (v !== "" && v != null) {
        latestCol = 5 + i;
        latestDate = String(v);
        break;
      }
    }
  }

  let latestValues = [];
  if (latestCol && definition.length) {
    latestValues = sheet.getRange(2, latestCol, definition.length, 1).getValues().map(r => r[0]);
  }

  return { definition, latestDate, latestValues };
}

function saveBiomarkers_(dateStr, values) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = getOrCreateBiomarkersSheet_(ss);

  const def = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues()
    .filter(r => r[0] || r[1] || r[2] || r[3]);

  const n = def.length;
  if (!n) throw new Error("Biomarkers sheet has no definition rows.");

  const newCol = sheet.getLastColumn() + 1;
  sheet.getRange(1, newCol).setValue(dateStr);

  const out = [];
  for (let i = 0; i < n; i++) out.push([values?.[i] ?? ""]);
  sheet.getRange(2, newCol, n, 1).setValues(out);

  return { success: true, date: dateStr, col: newCol };
}
