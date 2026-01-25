// Replace this with your actual Google Sheets ID
const SPREADSHEET_ID = '1L4tbpsUv5amXWYNBLHLcsVueD289THc8a5ys9reSd98';

/**************************************
 * OPTION A API ROUTER (Apps Script)
 * - GET  /exec?action=ping&key=...
 * - GET  /exec?action=load&date=M/D/YY&key=...
 * - POST /exec  { action:"save", key:"...", data:{...} }
 **************************************/

/**
 * Run ONCE to set your API key in Script Properties.
 * After running, you can leave it here or delete it.
 */
function setApiKeyOnce() {
  PropertiesService.getScriptProperties().setProperty(
    "API_KEY",
    "Q8xF3N9KpZ7J2WmC4A6YBVeH5R0TqLDSU1nXgE"
  );
}

/**
 * GET router
 */
function doGet(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const action = String(p.action || "").toLowerCase();

    // Auth
    assertKey_(p.key);

    // Routes
    if (action === "ping") {
      return json_({
        ok: true,
        ts: new Date().toISOString(),
        version: "api-router-v1"
      });
    }

    if (action === "load") {
      const dateStr = String(p.date || "").trim();
      if (!dateStr) return json_({ error: true, message: "Missing required parameter: date" });

      // Your existing function
      const data = loadDataForDate(dateStr);
      return json_(data);
    }

    if (action === "save") {
      const payloadStr = String(p.payload || "");
      if (!payloadStr) return json_({ error: true, message: "Missing payload" });
      const payload = JSON.parse(payloadStr);
      if (!payload.data) return json_({ error: true, message: "Missing data" });
      return json_(saveDataForDate(payload.data));
    }

    return json_({ error: true, message: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    return json_({
      error: true,
      message: err && err.message ? err.message : String(err)
    });
  }
}

/**
 * POST router
 */
function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw);

    // IMPORTANT: key is in JSON body (not e.parameter)
    assertKey_(body.key);

    const action = String(body.action || "").toLowerCase();

    if (action === "save") {
      if (!body.data) return json_({ error: true, message: "Missing required field: data" });
      return json_(saveDataForDate(body.data));
    }

    if (action === "ping") {
      return json_({ ok: true, ts: new Date().toISOString(), via: "post" });
    }

    return json_({ error: true, message: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    return json_({ error: true, message: err && err.message ? err.message : String(err) });
  }
}



/**
 * Helpers
 */
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function assertKey_(providedKey) {
  const storedKey = PropertiesService.getScriptProperties().getProperty("API_KEY");
  if (!storedKey) throw new Error("API key not set. Run setApiKeyOnce() in Apps Script.");
  if (!providedKey || String(providedKey) !== String(storedKey)) throw new Error("Unauthorized");
}



// TEST FUNCTION: Simple connection test
function testConnection() {
  return {
    status: 'success',
    message: 'Connection working!',
    timestamp: new Date().toString()
  };
}

// TEST FUNCTION: Run this to see what dates are in your spreadsheet
function testListDates() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('Daily Data');
  
  if (!sheet) {
    Logger.log('No Daily Data sheet found');
    return;
  }
  
  const data = sheet.getDataRange().getValues();
  Logger.log('Total rows: ' + data.length);
  Logger.log('Headers: ' + data[0].join(', '));
  Logger.log('\nDates in spreadsheet:');
  
  for (let i = 1; i < data.length; i++) {
    const originalDate = data[i][0];
    const formattedDate = formatDate(originalDate);
    Logger.log('Row ' + i + ': Original="' + originalDate + '" Formatted="' + formattedDate + '"');
  }
}

// Load data for a specific date
function loadDataForDate(dateStr) {
  try {
    Logger.log('=== loadDataForDate START ===');
    Logger.log('Loading data for date: ' + dateStr);
    Logger.log('SPREADSHEET_ID: ' + SPREADSHEET_ID);
    
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    Logger.log('Spreadsheet opened successfully');
    
    // Load main daily data
    const dailySheet = getOrCreateSheet(ss, 'Daily Data', [
      'Date', 'Hours of Sleep',
      'Grey\'s Inhaler Morning', 'Grey\'s Inhaler Evening', '5 min Multiplication',
      'REHIT 2x10', 'Fitness Score', 'Calories', 'Peak Watts', 'Watt Seconds', 'Steps',
      'Creatine Chews', 'Vitamin D', 'NO2', 'Psyllium Husk',
      'Breakfast', 'Lunch', 'Dinner', 'Healthy Day Snacks', 'Healthy Night Snacks', 'No Alcohol',
      'Water',
      'Weight (lbs)', 'Lean Mass (lbs)', 'Lean Mass %', 'Body Fat (lbs)', 'Body Fat %', 'Bone Mass (lbs)', 'Bone Mass %', 'Water (lbs)', 'Water %',
      'Meditation'
    ]);
    
    Logger.log('Daily Data sheet ready');
    const dailyData = findRowByDate(dailySheet, dateStr);
    Logger.log('Daily data found: ' + (dailyData ? 'Yes' : 'No'));
    
    // Load movements
    const movementSheet = getOrCreateSheet(ss, 'Movement Log', ['Date', 'Duration (min)', 'Type']);
    const movements = getItemsByDate(movementSheet, dateStr);
    Logger.log('Movements found: ' + movements.length);
    
    // Load reading sessions
    const readingSheet = getOrCreateSheet(ss, 'Reading Log', ['Date', 'Duration (min)', 'Book']);
    const readings = getItemsByDate(readingSheet, dateStr);
    Logger.log('Readings found: ' + readings.length);
    
    // Load honey-do's (includes uncompleted tasks from previous dates)
    const honeyDoSheet = getOrCreateSheet(ss, 'Honey-Dos', ['ID', 'Created', 'Due', 'Task', 'Completed', 'Completed Date']);
    let honeyDos = [];
    try {
      honeyDos = getHoneyDos_(honeyDoSheet, dateStr);
      Logger.log('Honey-dos found: ' + honeyDos.length);
    } catch (err) {
      Logger.log('ERROR loading honey-dos: ' + err.toString());
      // Return empty array on error so rest of data can load
      honeyDos = [];
    }
    
    // Load reflections
    const reflectionsSheet = getOrCreateSheet(ss, 'Reflections', ['Date', 'Text']);
    const reflections = findRowByDate(reflectionsSheet, dateStr);
    
    // Load Grey & Sloane stories
    const storiesSheet = getOrCreateSheet(ss, 'Grey & Sloane', ['Date', 'Text']);
    const stories = findRowByDate(storiesSheet, dateStr);
    
    // Load Carly notes
    const carlySheet = getOrCreateSheet(ss, 'Carly', ['Date', 'Text']);
    const carly = findRowByDate(carlySheet, dateStr);
    
    const result = {
      daily: dailyData,
      movements: movements,
      readings: readings,
      honeyDos: honeyDos,
      reflections: reflections ? reflections['Text'] : '',
      stories: stories ? stories['Text'] : '',
      carly: carly ? carly['Text'] : '',
      averages: calculate7DayAverages(dateStr)
    };
    
    Logger.log('=== loadDataForDate END - Returning result ===');
    Logger.log('Daily data present: ' + (dailyData ? 'Yes' : 'No'));
    Logger.log('Movements count: ' + movements.length);
    Logger.log('Readings count: ' + readings.length);
    Logger.log('Honey-dos count: ' + honeyDos.length);
    Logger.log('About to stringify result...');
    
    try {
      const jsonStr = JSON.stringify(result);
      Logger.log('Result stringified successfully, length: ' + jsonStr.length);
    } catch (stringifyErr) {
      Logger.log('ERROR stringifying result: ' + stringifyErr.toString());
      // Return simplified version without the problematic data
      return {
        daily: dailyData,
        movements: movements,
        readings: readings,
        honeyDos: [],
        reflections: reflections ? reflections['Text'] : '',
        stories: stories ? stories['Text'] : '',
        carly: carly ? carly['Text'] : '',
        averages: calculate7DayAverages(dateStr)
      };
    }
    
    return result;
  } catch (err) {
    Logger.log('ERROR in loadDataForDate: ' + err.toString());
    Logger.log('Stack trace: ' + err.stack);
    // Return error info instead of throwing
    return {
      error: true,
      message: err.message,
      stack: err.stack,
      toString: err.toString()
    };
  }
}

// Calculate 7-day averages for sleep and steps
function calculate7DayAverages(dateStr) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const dailySheet = ss.getSheetByName('Daily Data');
  const movementSheet = ss.getSheetByName('Movement Log');

  if (!dailySheet) {
    return { sleep: null, steps: null, movements: null, rehitWeek: 0 };
  }

  const data = dailySheet.getDataRange().getValues();
  const headers = data[0];

  const dateCol = headers.indexOf('Date');
  const sleepCol = headers.indexOf('Hours of Sleep');
  const stepsCol = headers.indexOf('Steps');
  const rehitCol = headers.indexOf('REHIT 2x10');

  const targetDate = new Date(dateStr + ' 12:00:00');

  // ---- WEEK BOUNDARIES (Sunday → Saturday) ----
  const currentDay = targetDate.getDay(); // 0 = Sunday
  const weekStart = new Date(targetDate);
  weekStart.setDate(targetDate.getDate() - currentDay);
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  let sleepValues = [];
  let stepsValues = [];
  let rehitThisWeek = 0;

  // ---- DAILY DATA (Sleep, Steps, REHIT) ----
  for (let i = 1; i < data.length; i++) {
    const rowDate = new Date(formatDate(data[i][dateCol]) + ' 12:00:00');

    if (rowDate >= weekStart && rowDate <= weekEnd) {
      const sleep = parseFloat(data[i][sleepCol]);
      const steps = parseInt(data[i][stepsCol]);
      const rehit = data[i][rehitCol];

      if (!isNaN(sleep) && sleep > 0) sleepValues.push(sleep);
      if (!isNaN(steps) && steps > 0) stepsValues.push(steps);

      if (rehit === true || rehit === 'TRUE' || rehit === 'true') {
        rehitThisWeek++;
      }
    }
  }

  // ---- MOVEMENTS PER DAY (week-to-date) ----
  let movementCounts = {};
  if (movementSheet) {
    const movementData = movementSheet.getDataRange().getValues();
    const movementHeaders = movementData[0];
    const movementDateCol = movementHeaders.indexOf('Date');

    for (let i = 1; i < movementData.length; i++) {
      const rowDate = new Date(formatDate(movementData[i][movementDateCol]) + ' 12:00:00');

      if (rowDate >= weekStart && rowDate <= weekEnd) {
        const key = formatDate(movementData[i][movementDateCol]);
        movementCounts[key] = (movementCounts[key] || 0) + 1;
      }
    }
  }

  const totalMovements = Object.values(movementCounts).reduce((a, b) => a + b, 0);
  const daysInWeekSoFar = Math.min(currentDay + 1, 7);
  const avgMovements = daysInWeekSoFar > 0
    ? (totalMovements / daysInWeekSoFar).toFixed(1)
    : null;

  const avgSleep = sleepValues.length
    ? sleepValues.reduce((a, b) => a + b, 0) / sleepValues.length
    : null;

  const avgSteps = stepsValues.length
    ? Math.round(stepsValues.reduce((a, b) => a + b, 0) / stepsValues.length)
    : null;

  return {
    sleep: avgSleep,
    steps: avgSteps,
    movements: avgMovements,
    rehitWeek: rehitThisWeek
  };
}


// Save all data for a specific date
function saveDataForDate(data) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const dateStr = data.date;
    
    // Save main daily data
    const dailySheet = getOrCreateSheet(ss, 'Daily Data', [
      'Date', 'Hours of Sleep',
      'Grey\'s Inhaler Morning', 'Grey\'s Inhaler Evening', '5 min Multiplication',
      'REHIT 2x10', 'Fitness Score', 'Calories', 'Peak Watts', 'Watt Seconds', 'Steps',
      'Creatine Chews', 'Vitamin D', 'NO2', 'Psyllium Husk',
      'Breakfast', 'Lunch', 'Dinner', 'Healthy Day Snacks', 'Healthy Night Snacks', 'No Alcohol',
      'Water',
      'Weight (lbs)', 'Lean Mass (lbs)', 'Lean Mass %', 'Body Fat (lbs)', 'Body Fat %', 'Bone Mass (lbs)', 'Bone Mass %', 'Water (lbs)', 'Water %',
      'Meditation'
    ]);
    
    saveOrUpdateRow(dailySheet, dateStr, [
      dateStr,
      data.sleepHours || '',
      data.inhalerMorning || false,
      data.inhalerEvening || false,
      data.multiplication || false,
      data.rehit || false,
      data.fitnessScore || '',
      data.calories || '',
      data.peakWatts || '',
      data.wattSeconds || '',
      data.steps || '',
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
      data.weight || '',
      data.leanMass || '',
      '', // Lean Mass % - calculated, don't save
      data.bodyFat || '',
      '', // Body Fat % - calculated, don't save
      data.boneMass || '',
      '', // Bone Mass % - calculated, don't save
      data.water || '',
      '', // Water % - calculated, don't save
      data.meditation || false
    ]);
    
    // Save movements (replace all for this date)
    const movementSheet = getOrCreateSheet(ss, 'Movement Log', ['Date', 'Duration (min)', 'Type']);
    Logger.log('Saving movements - count: ' + (data.movements ? data.movements.length : 0));
    if (data.movements && data.movements.length > 0) {
      Logger.log('Movements data: ' + JSON.stringify(data.movements));
    }
    deleteRowsByDate(movementSheet, dateStr);
    if (data.movements && data.movements.length > 0) {
      data.movements.forEach(m => {
        Logger.log('Appending movement: date=' + dateStr + ', duration=' + m.duration + ', type=' + m.type);
        const lastRow = movementSheet.getLastRow();
        movementSheet.getRange(lastRow + 1, 1, 1, 3).setValues([[dateStr, m.duration || '', m.type || '']]);
      });
    }
    
    // Save reading sessions (replace all for this date)
    const readingSheet = getOrCreateSheet(ss, 'Reading Log', ['Date', 'Duration (min)', 'Book']);
    Logger.log('Saving readings - count: ' + (data.readings ? data.readings.length : 0));
    if (data.readings && data.readings.length > 0) {
      Logger.log('Readings data: ' + JSON.stringify(data.readings));
    }
    deleteRowsByDate(readingSheet, dateStr);
    if (data.readings && data.readings.length > 0) {
      data.readings.forEach(r => {
        Logger.log('Appending reading: date=' + dateStr + ', duration=' + r.duration + ', book=' + r.book);
        const lastRow = readingSheet.getLastRow();
        readingSheet.getRange(lastRow + 1, 1, 1, 3).setValues([[dateStr, r.duration || '', r.book || '']]);
      });
    }
    
    // Save honey-dos with Created and Due dates
    const honeyDoSheet = getOrCreateSheet(ss, 'Honey-Dos', ['ID', 'Created', 'Due', 'Task', 'Completed', 'Completed Date']);
    
    if (data.honeyDos && data.honeyDos.length > 0) {
      data.honeyDos.forEach(h => {
        // Generate or use existing ID
        const taskId = h.id || Utilities.getUuid();
        const createdDate = h.created || dateStr;
        const dueDate = h.due || '';
        const completedDate = h.completed ? dateStr : '';
        
        // Check if task already exists (by ID)
        const existingData = honeyDoSheet.getDataRange().getValues();
        let found = false;
        for (let i = 1; i < existingData.length; i++) {
          if (existingData[i][0] === taskId) {
            // Update existing task
            honeyDoSheet.getRange(i + 1, 1, 1, 6).setValues([[
              taskId, createdDate, dueDate, h.task, h.completed || false, completedDate
            ]]);
            found = true;
            break;
          }
        }
        
        // If not found, add new task
        if (!found) {
          honeyDoSheet.appendRow([taskId, createdDate, dueDate, h.task, h.completed || false, completedDate]);
        }
      });
    }
    
    // Save reflections
    const reflectionsSheet = getOrCreateSheet(ss, 'Reflections', ['Date', 'Text']);
    saveOrUpdateRow(reflectionsSheet, dateStr, [dateStr, data.reflections || '']);
    
    // Save Grey & Sloane stories
    const storiesSheet = getOrCreateSheet(ss, 'Grey & Sloane', ['Date', 'Text']);
    saveOrUpdateRow(storiesSheet, dateStr, [dateStr, data.stories || '']);
    
    // Save Carly notes
    const carlySheet = getOrCreateSheet(ss, 'Carly', ['Date', 'Text']);
    saveOrUpdateRow(carlySheet, dateStr, [dateStr, data.carly || '']);
    
    return { success: true };
  } catch (err) {
    throw new Error('Error saving data: ' + err.message);
  }
}

// Helper: Get or create a sheet with headers
function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

// Helper: Find a row by date and return as object
function findRowByDate(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    Logger.log('No data rows in sheet');
    return null;
  }
  
  const headers = data[0];
  Logger.log('Looking for date: "' + dateStr + '"');
  
  for (let i = 1; i < data.length; i++) {
    const rowDate = formatDate(data[i][0]);
    Logger.log('Row ' + i + ' date: "' + rowDate + '" (original: "' + data[i][0] + '")');
    if (rowDate === dateStr) {
      Logger.log('MATCH FOUND at row ' + i);
      const obj = {};
      headers.forEach((header, idx) => {
        // Skip the Date column - it causes serialization issues
        if (header !== 'Date') {
          obj[header] = data[i][idx];
        }
      });
      return obj;
    }
  }
  Logger.log('No match found for date: ' + dateStr);
  return null;
}

// Helper: Get honey-dos for a date (includes uncompleted from previous dates)
function getHoneyDos_(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const headers = data[0];
  const items = [];
  
  // Check if this is the new format (has ID column) or old format (has Date column)
  const hasIdColumn = headers[0] === 'ID';
  
  if (hasIdColumn) {
    // New format: ID, Created, Due, Task, Completed, Completed Date
    for (let i = 1; i < data.length; i++) {
      const taskId = data[i][0];
      const createdDate = data[i][1] ? formatDate(data[i][1]) : '';
      const dueDate = data[i][2] ? formatDate(data[i][2]) : '';
      const task = data[i][3];
      const completed = data[i][4];
      const completedDate = data[i][5] ? formatDate(data[i][5]) : '';
      
      // Skip invalid entries (NaN dates, empty dates, or missing/invalid task)
      if (!createdDate || createdDate.includes('NaN') || !task || typeof task !== 'string' || task.length === 0) {
        Logger.log('Skipping invalid honey-do at row ' + i + ': created=' + createdDate + ', task=' + task);
        continue;
      }
      
      // Include if: not completed yet OR completed today
      if (!completed || completedDate === dateStr) {
        items.push({
          id: taskId,
          created: createdDate,
          due: dueDate,
          task: task,
          completed: completed === true || completed === 'TRUE'
        });
      }
    }
  } else {
    // Old format: Date, Task, Completed - convert to new format
    for (let i = 1; i < data.length; i++) {
      const rowDate = formatDate(data[i][0]);
      const task = data[i][1];
      const completed = data[i][2];
      
      // Include incomplete tasks or tasks from today
      if (!completed || rowDate === dateStr) {
        items.push({
          id: Utilities.getUuid(),
          created: rowDate,
          due: '',
          task: task,
          completed: completed === true || completed === 'TRUE'
        });
      }
    }
  }
  
  return items;
}

// Helper: Check if date1 is before or equal to date2
function isDateBeforeOrEqual(date1Str, date2Str) {
  const d1 = new Date(date1Str);
  const d2 = new Date(date2Str);
  return d1 <= d2;
}

// Helper: Get all items for a specific date
function getItemsByDate(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    Logger.log('Sheet ' + sheet.getName() + ' has no data rows');
    return [];
  }
  
  const headers = data[0];
  const items = [];
  
  Logger.log('Searching ' + sheet.getName() + ' for date: "' + dateStr + '"');
  
  for (let i = 1; i < data.length; i++) {
    const rowDate = formatDate(data[i][0]);
    Logger.log('  Row ' + i + ' formatted date: "' + rowDate + '" vs search: "' + dateStr + '"');
    if (rowDate === dateStr) {
      Logger.log('  MATCH FOUND!');
      const obj = {};
      headers.forEach((header, idx) => {
        if (header !== 'Date') {
          obj[header.toLowerCase()] = data[i][idx];
        }
      });
      items.push(obj);
    }
  }
  
  Logger.log('Found ' + items.length + ' items in ' + sheet.getName());
  return items;
}

// Helper: Save or update a row by date
function saveOrUpdateRow(sheet, dateStr, values) {
  const data = sheet.getDataRange().getValues();
  
  // Find existing row
  for (let i = 1; i < data.length; i++) {
    const rowDate = formatDate(data[i][0]);
    if (rowDate === dateStr) {
      sheet.getRange(i + 1, 1, 1, values.length).setValues([values]);
      return;
    }
  }
  
  // No existing row, append
  sheet.appendRow(values);
}

// Helper: Delete all rows for a specific date
function deleteRowsByDate(sheet, dateStr) {
  const data = sheet.getDataRange().getValues();
  
  // Delete from bottom to top to avoid index shifting
  for (let i = data.length - 1; i >= 1; i--) {
    const rowDate = formatDate(data[i][0]);
    if (rowDate === dateStr) {
      sheet.deleteRow(i + 1);
    }
  }
}

// Helper: Format date consistently as M/D/YY
function formatDate(date) {
  if (!date) return '';
  
  let d;
  if (date instanceof Date) {
    // Date object from spreadsheet - use it directly
    d = new Date(date);
  } else if (typeof date === 'string') {
    // String date - parse it carefully
    if (date.includes('/')) {
      // Already in M/D/YY format, return as-is
      return date;
    }
    // ISO format or other
    d = new Date(date + 'T12:00:00');
  } else {
    return String(date);
  }
  
  // Use UTC methods to avoid timezone shifts
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const year = String(d.getFullYear()).slice(-2);
  
  const formatted = `${month}/${day}/${year}`;
  Logger.log('formatDate: input=' + date + ' output=' + formatted);
  return formatted;
}

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

console.log("✅ app.js running v4", new Date().toISOString());
console.log("******* Sleep Changes ******");
console.log("Instant Days", new Date().toISOString());
window.__APP_JS_OK__ = true;

// =====================================
// CONFIG
// =====================================
const API_URL = "https://habit-proxy.joeywigs.workers.dev/";

// Body fields (for carry-forward + detection)
const BODY_FIELDS = [
  { id: "weight", keys: ["Weight (lbs)", "Weight"] },
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
  setupWaterButtons();
  setupInputAutosave();
  setupCollapsibleSections();   // ✅ add this
  setupMovementUI();


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
}

// =====================================
// LOAD / SAVE
// =====================================
async function loadDataForCurrentDate() {
  const dateStr = formatDateForAPI(currentDate);
  console.log("Loading data for", dateStr);

  // 1) If cached, show instantly
  const cached = cacheGet(dateStr);
  if (cached && !cached?.error) {
    await populateForm(cached);
    prefetchAround(currentDate);
    return;
  }

  // 2) Otherwise fetch, then show
  try {
    const result = await fetchDay(currentDate);

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
      await loadDataForCurrentDate({ force: true });
}

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

    // Water counter
    hydrationGood: waterCount,

    // Body
    weight: document.getElementById("weight")?.value || "",
    leanMass: document.getElementById("leanMass")?.value || "",
    bodyFat: document.getElementById("bodyFat")?.value || "",
    boneMass: document.getElementById("boneMass")?.value || "",
    water: document.getElementById("water")?.value || "",

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

  updateAverages(data?.averages);
  }

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

    honeyDos = data?.honeyDos || [];

    const reflectionsEl = document.getElementById("reflections");
    if (reflectionsEl) reflectionsEl.value = data?.reflections || "";
    const storiesEl = document.getElementById("stories");
    if (storiesEl) storiesEl.value = data?.stories || "";
    const carlyEl = document.getElementById("carly");
    if (carlyEl) carlyEl.value = data?.carly || "";

    // Apply carried-forward body values (even if no row exists)
    applyBodyFieldsFromDaily(bodySource);

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

  // Body fields: use current day if present, else carry-forward source
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

async function fetchDay(dateObj) {
  const dateStr = formatDateForAPI(dateObj);
  const cached = cacheGet(dateStr);
  if (cached) return cached;

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

  // Sleep: show 2 decimals
  if (avgSleepEl) {
    const v = averages.sleep;
    avgSleepEl.textContent = (v === null || v === undefined || v === "")
      ? "--"
      : Number(v).toFixed(2);
  }

  // Steps: show whole number w/ commas
  if (avgStepsEl) {
    const v = averages.steps;
    avgStepsEl.textContent = (v === null || v === undefined || v === "")
      ? "--"
      : Number(v).toLocaleString();
  }

  // Movements per day: your backend returns a string like "0.7"
  if (avgMovementsEl) {
    const v = averages.movements;
    const num = (v === null || v === undefined || v === "") ? null : Number(v);
    avgMovementsEl.textContent = (num === null || Number.isNaN(num))
      ? "--"
      : num.toFixed(1);
  }

  // REHIT sessions this week
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

  // Optional: remove after a few seconds
  setTimeout(() => {
    el.classList.remove("saved");
  }, 3000);
}
