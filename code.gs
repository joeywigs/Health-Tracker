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
