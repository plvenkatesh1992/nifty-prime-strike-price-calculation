const axios = require('axios');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { drawLinesOnDhan } = require('./dhan-draw');

// ===========================================================================
// CONFIGURATION (Adjust settings here anytime)
// ===========================================================================
const CONFIG = {
  // Telegram Bot Credentials
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8890589244:AAFAogU5cSJV2Ag0P6Zc2FRUntms_3cXZf8',
  // ALLOWED_CHAT_ID: process.env.ALLOWED_CHAT_ID || '5881579500',
  // Allow both your personal DM and your Telegram Group IDs (comma-separated)
  ALLOWED_CHAT_IDS: (process.env.ALLOWED_CHAT_IDS || '5881579500,-1001234567890').split(',').map((id) => id.trim()),

  // Commands Configuration
  COMMANDS: {
    LEVELS: '/levels',
    LINES: '/lines',
    STATUS: '/status',
    START: '/start',
    HELP: '/help',
  },

  // Strike Range Configuration (e.g., 4 above + 4 below + base = 9 total)
  STRIKES_RANGE: {
    ABOVE: 4, // Number of strikes above the base strike
    BELOW: 4, // Number of strikes below the base strike
    STEP: 100, // Distance between strikes
  },

  // Weekday Time Window Gate (24-hour format)
  // Allowed between START_TIME (evening) and END_TIME (morning)
  TIME_WINDOW: {
    START_HOUR: 20, // 8:00 PM (20)
    START_MINUTE: 30, // :30 -> 8:30 PM
    END_HOUR: 8, // 8:00 AM (8)
    END_MINUTE: 59, // :59 -> 8:59 AM
  },
};
// ===========================================================================

const PANE = '#derivatives-tabs-tabpane-historical-data';
const TG_API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;
const DATA_DIR = path.join(__dirname, 'nifty-strike-prices');

// Dropdown positions inside the Historical Data pane
const DD = { INSTRUMENT: 0, YEAR: 1, EXPIRY: 2, OPTION_TYPE: 3, STRIKE: 4 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Time & Trading Session Gate
// ---------------------------------------------------------------------------

function isAllowedExecutionTime() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday

  // Weekends allowed anytime
  if (day === 0 || day === 6) {
    return { allowed: true };
  }

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const currentMinutes = hours * 60 + minutes;

  const morningLimit = CONFIG.TIME_WINDOW.END_HOUR * 60 + CONFIG.TIME_WINDOW.END_MINUTE;
  const eveningLimit = CONFIG.TIME_WINDOW.START_HOUR * 60 + CONFIG.TIME_WINDOW.START_MINUTE;

  const formatTime = (h, m) => {
    const period = h >= 12 ? 'PM' : 'AM';
    const displayH = h % 12 || 12;
    return `${displayH}:${String(m).padStart(2, '0')} ${period}`;
  };

  const startStr = formatTime(CONFIG.TIME_WINDOW.START_HOUR, CONFIG.TIME_WINDOW.START_MINUTE);
  const endStr = formatTime(CONFIG.TIME_WINDOW.END_HOUR, CONFIG.TIME_WINDOW.END_MINUTE);

  // If between morningLimit and eveningLimit on weekdays, block execution
  if (currentMinutes >= morningLimit && currentMinutes < eveningLimit) {
    return {
      allowed: false,
      reason: `⏳ Requests are only processed between ${startStr} and ${endStr} on weekdays (after settlement prices finalize).`,
      windowStr: `Closed ⛔ (${endStr} - ${startStr})`,
    };
  }

  return {
    allowed: true,
    windowStr: `Open ✅ (${startStr} - ${endStr})`,
  };
}

// ---------------------------------------------------------------------------
// Date Formatter & Cache File Handlers
// ---------------------------------------------------------------------------

function normalizeDateToDDMMYYYY(dateStr) {
  if (!dateStr) return null;
  const clean = dateStr.trim();
  const m = clean.match(/^(\d{1,2})[-\s/]([A-Za-z]{3}|\d{1,2})[-\s/](\d{4})$/);
  if (!m) return null;

  const day = m[1].padStart(2, '0');
  const year = m[3];
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  let month;
  if (isNaN(m[2])) {
    const idx = months.indexOf(m[2].toLowerCase());
    if (idx === -1) return null;
    month = String(idx + 1).padStart(2, '0');
  } else {
    month = m[2].padStart(2, '0');
  }

  return `${day}-${month}-${year}`;
}

function getExpectedSettlementDateDDMMYYYY() {
  const now = new Date();
  const day = now.getDay();
  const hours = now.getHours();
  const minutes = now.getMinutes();

  let target = new Date(now);
  const morningLimit = CONFIG.TIME_WINDOW.END_HOUR * 60 + CONFIG.TIME_WINDOW.END_MINUTE;

  if (day >= 1 && day <= 5 && hours * 60 + minutes < morningLimit) {
    target.setDate(target.getDate() - 1);
  } else if (day === 0) {
    target.setDate(target.getDate() - 2);
  } else if (day === 6) {
    target.setDate(target.getDate() - 1);
  }

  if (target.getDay() === 0) target.setDate(target.getDate() - 2);
  if (target.getDay() === 6) target.setDate(target.getDate() - 1);

  const d = String(target.getDate()).padStart(2, '0');
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const y = target.getFullYear();
  return `${d}-${m}-${y}`;
}

function getCachedLevelsForDate(formattedDate) {
  if (!fs.existsSync(DATA_DIR)) return null;
  const filePath = path.join(DATA_DIR, `${formattedDate}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (e) {
      console.error('Cache read error:', e.message);
    }
  }
  return null;
}

function getLatestSavedLevelsFile() {
  if (!fs.existsSync(DATA_DIR)) return null;
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) return null;

  files.sort((a, b) => {
    const statA = fs.statSync(path.join(DATA_DIR, a)).mtimeMs;
    const statB = fs.statSync(path.join(DATA_DIR, b)).mtimeMs;
    return statB - statA;
  });

  const latestFile = path.join(DATA_DIR, files[0]);
  try {
    const content = fs.readFileSync(latestFile, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.error('Failed reading latest file:', e.message);
    return null;
  }
}

function saveLevelsToJson(tableRows, spotPrice, expiryDate, settlementDateStr) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const normalizedDate = normalizeDateToDDMMYYYY(settlementDateStr) || getExpectedSettlementDateDDMMYYYY();
  const filePath = path.join(DATA_DIR, `${normalizedDate}.json`);

  const outputData = {
    symbol: 'NIFTY',
    settlementDate: settlementDateStr,
    normalizedDate: normalizedDate,
    spotPrice: spotPrice,
    expiryDate: expiryDate,
    savedAt: new Date().toISOString(),
    levels: tableRows.map((r) => ({
      strike: r.Strike,
      callSettlementPrice: r['Call Strike - Settlement Price'],
      putSettlementPrice: r['Put Strike - Settlement Price'],
      total: r.Total,
      primeLevel: r['Prime Level'],
    })),
  };

  fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2), 'utf-8');
  console.log(`💾 Saved verified settlement data to: ${filePath}`);
  return normalizedDate;
}

// ---------------------------------------------------------------------------
// Lines Calculation & Formatting Logic
// ---------------------------------------------------------------------------

function calculateColorLevels(spotPrice, levelsData) {
  const step = CONFIG.STRIKES_RANGE.STEP;
  const callStrike = Math.floor(spotPrice / step) * step;
  const putStrike = callStrike + step;

  const allCallPrices = levelsData
    .map((item) => item.callSettlementPrice)
    .filter((p) => typeof p === 'number' && !isNaN(p));

  const allPutPrices = levelsData
    .map((item) => item.putSettlementPrice)
    .filter((p) => typeof p === 'number' && !isNaN(p));

  const callRow = levelsData.find((item) => item.strike === callStrike);
  const putRow = levelsData.find((item) => item.strike === putStrike);

  if (!callRow || !putRow) {
    throw new Error(`Strike data not found for Call (${callStrike}) or Put (${putStrike}) in the saved dataset.`);
  }

  const getBlackLine = (greenPrice, oppositePool) => {
    const lowerValues = oppositePool.filter((p) => p < greenPrice).sort((a, b) => b - a);
    return lowerValues.length > 0 ? lowerValues[0] : 'N/A';
  };

  const getBlueLines = (greenPrice, oppositePool) => {
    const higherValues = oppositePool.filter((p) => p > greenPrice).sort((a, b) => a - b);
    const targets = higherValues.slice(0, 3);
    while (targets.length < 3) {
      targets.push('N/A');
    }
    return targets;
  };

  const callGreen = callRow.callSettlementPrice;
  const callOrange = callRow.primeLevel;
  const callBlack = getBlackLine(callGreen, allPutPrices);
  const callBlue = getBlueLines(callGreen, allPutPrices);

  const putGreen = putRow.putSettlementPrice;
  const putOrange = putRow.primeLevel;
  const putBlack = getBlackLine(putGreen, allCallPrices);
  const putBlue = getBlueLines(putGreen, allCallPrices);

  return {
    call: {
      strike: callStrike,
      greenLine: callGreen,
      orangeLine: callOrange,
      blackLine: callBlack,
      blueLines: callBlue,
    },
    put: {
      strike: putStrike,
      greenLine: putGreen,
      orangeLine: putOrange,
      blackLine: putBlack,
      blueLines: putBlue,
    },
  };
}

function formatColorLevelsTelegramMessage(data, spotPrice, expiryDate, tradeDate = null) {
  const { call, put } = data;

  const formatTargets = (targets) => {
    return targets.map((val, idx) => `<b>T${idx + 1}:</b> <code>${val}</code>`).join('  |  ');
  };

  let message = `🎯 <b><u>NIFTY CALL/PUT KEY LEVELS ANALYSIS</u></b>\n\n`;

  if (tradeDate) {
    message += `📅 <b>Trade Date:</b> ${tradeDate}\n`;
  }
  message += `🔹 <b>Spot Price:</b> ${spotPrice}\n`;
  message += `🔹 <b>Target Expiry:</b> ${expiryDate}\n\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // CALL SECTION
  message += `🟢 <b><u>CALL SIDE (${call.strike} CE)</u></b>\n`;
  message += `• <b>Green Line (Entry):</b> <code>${call.greenLine}</code>\n`;
  message += `• <b>Orange Line (Prime):</b> <code>${call.orangeLine}</code>\n`;
  message += `• <b>Black Line (Stop/Support):</b> <code>${call.blackLine}</code>\n`;
  message += `• <b>Blue Lines (Targets):</b>\n`;
  message += `  └ ${formatTargets(call.blueLines)}\n\n`;

  // SECTION DIVIDER
  message += `╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\n`;

  // PUT SECTION
  message += `🔴 <b><u>PUT SIDE (${put.strike} PE)</u></b>\n`;
  message += `• <b>Green Line (Entry):</b> <code>${put.greenLine}</code>\n`;
  message += `• <b>Orange Line (Prime):</b> <code>${put.orangeLine}</code>\n`;
  message += `• <b>Black Line (Stop/Support):</b> <code>${put.blackLine}</code>\n`;
  message += `• <b>Blue Lines (Targets):</b>\n`;
  message += `  └ ${formatTargets(put.blueLines)}`;

  return message;
}

// ---------------------------------------------------------------------------
// Pine Script Generator (Indicator Mode with Dynamic Target Skipping)
// ---------------------------------------------------------------------------

function generateSidePineScript(sideType, strike, sideData, tradeDate) {
  const sanitizeVal = (v) => (v === 'N/A' || v === null || isNaN(v) ? null : Number(v).toFixed(1));

  const green = sanitizeVal(sideData.greenLine);
  const orange = sanitizeVal(sideData.orangeLine);
  const black = sanitizeVal(sideData.blackLine);

  let script = `//@version=5\n`;
  script += `indicator("NIFTY ${sideType} ${strike} - ${tradeDate || 'Levels'}", overlay=true)\n\n`;

  // Base Levels
  if (green !== null) {
    script += `greenVal  = ${green}\n`;
    script += `plot(greenVal,  title="Entry",        color=color.green,  linewidth=2, style=plot.style_linebr)\n`;
  }
  if (orange !== null) {
    script += `orangeVal = ${orange}\n`;
    script += `plot(orangeVal, title="Prime",       color=color.orange, linewidth=2, style=plot.style_linebr)\n`;
  }
  if (black !== null) {
    script += `blackVal  = ${black}\n`;
    script += `plot(blackVal,  title="Support/Stop", color=color.gray,   linewidth=2, style=plot.style_linebr)\n`;
  }

  // Targets: Only declare and plot if available (skip 'N/A')
  if (Array.isArray(sideData.blueLines)) {
    sideData.blueLines.forEach((targetVal, idx) => {
      const sanitizedTarget = sanitizeVal(targetVal);
      if (sanitizedTarget !== null) {
        const tName = `t${idx + 1}Val`;
        const tTitle = `T${idx + 1}`;
        script += `${tName.padEnd(9, ' ')} = ${sanitizedTarget}\n`;
        script += `plot(${tName},     title="${tTitle}",              color=color.blue,   linewidth=1, style=plot.style_linebr)\n`;
      }
    });
  }

  return script.trim();
}

// ---------------------------------------------------------------------------
// Strike / Date Helpers
// ---------------------------------------------------------------------------

function getStrikeList(spotPrice) {
  const { ABOVE, BELOW, STEP } = CONFIG.STRIKES_RANGE;
  const baseStrike = Math.floor(spotPrice / STEP) * STEP;
  const strikes = [];

  for (let i = -BELOW; i <= ABOVE; i++) {
    strikes.push(baseStrike + i * STEP);
  }
  return { baseStrike, strikes };
}

// "08-Oct-2026" / "08-10-2026" -> timestamp (0 if it cannot be parsed)
function parseDateStr(str) {
  if (!str) return 0;
  const m = String(str).trim().match(/^(\d{1,2})[-\s/]([A-Za-z]{3}|\d{1,2})[-\s/](\d{4})$/);
  if (!m) return 0;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const day = parseInt(m[1], 10);
  const mon = isNaN(m[2]) ? months.indexOf(m[2].toLowerCase()) : parseInt(m[2], 10) - 1;
  const year = parseInt(m[3], 10);
  if (mon < 0) return 0;
  return new Date(year, mon, day).getTime();
}

// ---------------------------------------------------------------------------
// Network tracking: lets us wait until NSE has really finished loading data
// ---------------------------------------------------------------------------

// Background calls that fire all the time and must not count as "data loading"
const IGNORE_API = /marketStatus|allIndices|chart-databyindex|ticker|live-analysis|liveAnalysis/i;

function trackNetwork(page) {
  const net = { pending: 0, started: 0, lastActivity: Date.now() };
  const counts = (req) =>
    ['xhr', 'fetch'].includes(req.resourceType()) && req.url().includes('/api/') && !IGNORE_API.test(req.url());

  page.on('request', (req) => {
    if (counts(req)) {
      net.pending++;
      net.started++;
      net.lastActivity = Date.now();
    }
  });
  const done = (req) => {
    if (counts(req)) {
      net.pending = Math.max(0, net.pending - 1);
      net.lastActivity = Date.now();
    }
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return net;
}

// After a dropdown change: wait for the page to start its request(s), then for them to finish.
async function waitForDataLoaded(net, startedBefore, { timeoutMs = 15000, quietMs = 600, startWaitMs = 1500 } = {}) {
  const startDeadline = Date.now() + startWaitMs;
  while (net.started === startedBefore && Date.now() < startDeadline) await sleep(100);

  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (net.pending === 0 && Date.now() - net.lastActivity >= quietMs) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dropdown helpers
// ---------------------------------------------------------------------------

// Sets a <select> value (React friendly). Returns true only if the option exists and was applied.
async function setReactSelect(page, selectLocator, val) {
  const applied = await selectLocator.evaluate((el, value) => {
    const exists = Array.from(el.options).some((o) => o.value === value);
    if (!exists) return false;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === value;
  }, val);
  await page.waitForTimeout(300);
  return applied;
}

// Select a value, then wait until the data requests it triggered have finished
async function selectAndWait(page, net, selectLocator, val) {
  const mark = net.started;
  const applied = await setReactSelect(page, selectLocator, val);
  if (applied) await waitForDataLoaded(net, mark);
  return applied;
}

// Re-apply a value if the page changed/reset it behind our back. Returns true if it had to.
async function reapplyIfChanged(page, net, selectLocator, val) {
  const current = await selectLocator.evaluate((el) => el.value);
  if (current === val) return false;
  await selectAndWait(page, net, selectLocator, val);
  return true;
}

// Waits until a dropdown's option list is non-empty and has stopped changing
async function waitForDropdownSettled(selectLocator, { stableReads = 3, intervalMs = 400, timeoutMs = 10000 } = {}) {
  const end = Date.now() + timeoutMs;
  let lastSig = null;
  let stable = 0;
  while (Date.now() < end) {
    const sig = await selectLocator.evaluate((el) =>
      Array.from(el.options)
        .map((o) => o.value)
        .join('|')
    );
    if (sig && sig === lastSig) {
      stable++;
      if (stable >= stableReads) return true;
    } else {
      stable = 0;
      lastSig = sig;
    }
    await sleep(intervalMs);
  }
  return false;
}

// Waits for the strike to be in the dropdown (numeric match) and returns the REAL option value
async function waitForStrikeOption(selectLocator, strike, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await selectLocator.evaluate((el, target) => {
      const opt = Array.from(el.options).find((o) => parseFloat((o.value || '').replace(/,/g, '')) === target);
      return opt ? opt.value : null;
    }, strike);
    if (found) return found;
    await sleep(400);
  }
  return null;
}

async function countOptions(selectLocator) {
  return selectLocator.evaluate((el) => Array.from(el.options).filter((o) => o.value).length);
}

// ---------------------------------------------------------------------------
// Table reading & validation
// ---------------------------------------------------------------------------

// Returns ALL table rows matching BOTH the strike and option type (with date + expiry)
async function readMatchingRows(page, strike, optType) {
  return page.evaluate(
    ({ strike, optType, PANE }) => {
      const pane = document.querySelector(PANE);
      const table = pane && pane.querySelector('table');
      if (!table) return [];

      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.innerText.trim().toUpperCase());
      const find = (test, fallback) => {
        const i = headers.findIndex(test);
        return i === -1 ? fallback : i;
      };
      const dateIdx = find((h) => h === 'DATE', 0);
      const expiryIdx = find((h) => h.includes('EXPIRY'), 1);
      const typeIdx = find((h) => h.includes('OPTION TYPE'), 2);
      const strikeIdx = find((h) => h.includes('STRIKE'), 3);
      const settleIdx = find((h) => h.includes('SETTLE'), 9);

      const matches = [];
      for (const row of table.querySelectorAll('tbody tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length <= settleIdx) continue;

        const s = parseFloat((cells[strikeIdx].innerText || '').replace(/,/g, ''));
        const t = (cells[typeIdx].innerText || '').trim().toUpperCase();
        const typeOk = !t || t.startsWith(optType[0]); // 'C' for CE, 'P' for PE
        if (s !== strike || !typeOk) continue;

        matches.push({
          date: (cells[dateIdx].innerText || '').trim(),
          expiry: (cells[expiryIdx].innerText || '').trim(),
          price: parseFloat((cells[settleIdx].innerText || '').replace(/,/g, '')),
        });
      }
      return matches;
    },
    { strike, optType, PANE }
  );
}

// Newest-dated row whose settlement looks sane (>= 90% of intrinsic value)
function pickBestRow(rows, intrinsic) {
  const sorted = rows
    .filter((r) => !isNaN(r.price))
    .map((r, i) => ({ ...r, ts: parseDateStr(r.date), i }))
    .sort((a, b) => b.ts - a.ts || a.i - b.i);
  return sorted.find((r) => r.price >= intrinsic * 0.9) || null;
}

// Backup path: call the NSE API the page uses, from inside the page (cookies included)
async function fetchViaApi(page, { expiry, year, strike, optType }) {
  return page.evaluate(
    async ({ expiry, year, strike, optType }) => {
      const fmt = (d) =>
        `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
      const to = new Date();
      const from = new Date();
      from.setMonth(from.getMonth() - 1);
      const url =
        `/api/historicalOR/foCPV?from=${fmt(from)}&to=${fmt(to)}` +
        `&instrumentType=OPTIDX&symbol=NIFTY&year=${year}&expiryDate=${expiry}` +
        `&optionType=${optType}&strikePrice=${strike}`;
      try {
        const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!res.ok) return { error: `HTTP ${res.status}`, rows: [] };
        const json = await res.json();
        const data = Array.isArray(json) ? json : json.data || [];
        const rows = data.map((r) => {
          const keys = Object.keys(r);
          const settleKey = keys.find((k) => /SETTLE/i.test(k));
          const dateKey = keys.find((k) => /TIMESTAMP/i.test(k)) || keys.find((k) => /^(FH_)?DATE$/i.test(k));
          return { date: dateKey ? String(r[dateKey]) : '', price: settleKey ? parseFloat(r[settleKey]) : NaN };
        });
        return { rows };
      } catch (e) {
        return { error: String(e), rows: [] };
      }
    },
    { expiry, year, strike, optType }
  );
}

// ---------------------------------------------------------------------------
// Step 1: load every dropdown IN ORDER, waiting for each one's data to arrive
// ---------------------------------------------------------------------------

async function loadFilters(page, net, dropdowns, year) {
  // Instrument type -> (year list loads)
  console.log('Setting Instrument Type: Index Options (OPTIDX)...');
  if (!(await selectAndWait(page, net, dropdowns.nth(DD.INSTRUMENT), 'OPTIDX'))) {
    throw new Error('Instrument type OPTIDX is not available in the dropdown.');
  }
  await waitForDropdownSettled(dropdowns.nth(DD.YEAR), { timeoutMs: 8000 });

  // Year -> (expiry list loads)
  console.log(`Setting Year: ${year}...`);
  if (!(await selectAndWait(page, net, dropdowns.nth(DD.YEAR), year))) {
    throw new Error(`Year ${year} is not available in the dropdown.`);
  }
  await waitForDropdownSettled(dropdowns.nth(DD.EXPIRY), { timeoutMs: 10000 });
  console.log(`  Expiry dropdown loaded: ${await countOptions(dropdowns.nth(DD.EXPIRY))} options`);

  // Upcoming expiry
  const upcomingExpiryDate = await dropdowns.nth(DD.EXPIRY).evaluate((selectEl) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const validList = Array.from(selectEl.options)
      .filter((opt) => opt.value && !opt.disabled)
      .map((opt) => {
        const parts = opt.value.split('-'); // e.g. ["13", "Oct", "2026"]
        if (parts.length === 3) {
          const d = new Date(`${parts[1]} ${parts[0]}, ${parts[2]}`);
          return { val: opt.value, date: d };
        }
        return null;
      })
      .filter((item) => item && !isNaN(item.date.getTime()) && item.date >= today)
      .sort((a, b) => a.date - b.date);

    return validList.length > 0 ? validList[0].val : null;
  });

  if (!upcomingExpiryDate) throw new Error('Could not find an upcoming expiry date in the dropdown.');

  // Expiry -> (option type + strike lists load)
  console.log(`Setting Expiry Date: ${upcomingExpiryDate}...`);
  if (!(await selectAndWait(page, net, dropdowns.nth(DD.EXPIRY), upcomingExpiryDate))) {
    throw new Error(`Expiry ${upcomingExpiryDate} could not be selected.`);
  }
  await waitForDropdownSettled(dropdowns.nth(DD.OPTION_TYPE), { timeoutMs: 8000 });

  // Option type -> (strike list loads)
  console.log('Setting Option Type: CE...');
  if (!(await selectAndWait(page, net, dropdowns.nth(DD.OPTION_TYPE), 'CE'))) {
    throw new Error('Option type CE is not available in the dropdown.');
  }
  await waitForDropdownSettled(dropdowns.nth(DD.STRIKE), { timeoutMs: 10000 });
  console.log(`  Strike dropdown loaded: ${await countOptions(dropdowns.nth(DD.STRIKE))} options`);

  return upcomingExpiryDate;
}

// ---------------------------------------------------------------------------
// Step 2: for ONE strike + option type: select, wait for data, read, verify
// ---------------------------------------------------------------------------

async function loadContract(page, net, dropdowns, ctx, strike, optType) {
  const { spot, expiry } = ctx;
  const expiryTs = parseDateStr(expiry);
  const intrinsic = optType === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const strikeDd = dropdowns.nth(DD.STRIKE);
  const typeDd = dropdowns.nth(DD.OPTION_TYPE);

  // 1) Strike list must be final, then change the strike and wait for its data
  await waitForDropdownSettled(strikeDd, { timeoutMs: 8000 });
  let strikeValue = await waitForStrikeOption(strikeDd, strike);
  if (!strikeValue) {
    console.warn(`\n  [warn] ${strike} ${optType}: strike not in dropdown`);
    return null;
  }
  await selectAndWait(page, net, strikeDd, strikeValue);

  // 2) Select Call/Put and wait for its data
  await selectAndWait(page, net, typeDd, optType);

  // 3) Changing the option type can rebuild the strike list and reset the strike - re-check
  await waitForDropdownSettled(strikeDd, { timeoutMs: 6000 });
  const afterType = await waitForStrikeOption(strikeDd, strike);
  if (afterType) strikeValue = afterType;
  await reapplyIfChanged(page, net, strikeDd, strikeValue);

  // 4) Wait for the table to show THIS contract (strike + type + expiry), same price twice in a row
  let prevPrice = null;
  for (let i = 0; i < 24; i++) {
    await sleep(500);

    const typeChanged = await reapplyIfChanged(page, net, typeDd, optType);
    const strikeChanged = await reapplyIfChanged(page, net, strikeDd, strikeValue);
    if (typeChanged || strikeChanged) {
      prevPrice = null;
      continue;
    }

    const allRows = await readMatchingRows(page, strike, optType);
    // Ignore rows that belong to a different expiry (stale table from an earlier selection)
    const rows = allRows.filter((r) => {
      const ts = parseDateStr(r.expiry);
      return !ts || ts === expiryTs;
    });
    if (!rows.length) {
      prevPrice = null;
      continue;
    }

    const best = pickBestRow(rows, intrinsic);
    if (!best) {
      console.warn(
        `\n  [warn] ${strike} ${optType}: no row >= intrinsic (${intrinsic.toFixed(0)}). ` +
          `Rows: ${rows
            .slice(0, 3)
            .map((r) => `${r.date}=${r.price}`)
            .join(', ')}`
      );
      return null;
    }

    if (prevPrice !== null && prevPrice === best.price) {
      return { price: Math.round(best.price), tradeDate: best.date };
    }
    prevPrice = best.price;
  }

  console.warn(`\n  [warn] ${strike} ${optType}: table never settled on this contract`);
  return null;
}

// Retries a contract (flipping the option type in between to force a reload), then API backup
async function fetchSettlement(page, net, dropdowns, ctx, strike, optType) {
  const otherType = optType === 'CE' ? 'PE' : 'CE';

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      console.warn(`  [retry] ${strike} ${optType} attempt ${attempt}/3`);
      await selectAndWait(page, net, dropdowns.nth(DD.OPTION_TYPE), otherType);
    }
    const result = await loadContract(page, net, dropdowns, ctx, strike, optType);
    if (result) return result;
  }

  // Backup: NSE API from inside the page
  const intrinsic = optType === 'CE' ? Math.max(ctx.spot - strike, 0) : Math.max(strike - ctx.spot, 0);
  const api = await fetchViaApi(page, { expiry: ctx.expiry, year: ctx.year, strike, optType });
  const apiBest = pickBestRow(api.rows, intrinsic);
  if (apiBest) {
    console.warn(`  [info] API backup used for ${strike} ${optType}: ${apiBest.price} (${apiBest.date})`);
    return { price: Math.round(apiBest.price), tradeDate: apiBest.date };
  }

  return { price: null, tradeDate: null };
}

async function getAccurateSpotPrice(page) {
  const niftyCard = page.locator('div.index_val:has(a[href*="NIFTY%2050"])');
  await niftyCard.waitFor({ state: 'visible', timeout: 15000 });

  const indexValueLocator = niftyCard.locator('.index_value');

  await page.waitForFunction(
    (el) => {
      if (!el) return false;
      const txt = (el.innerText || '').replace(/,/g, '').trim();
      return /\d{5}/.test(txt);
    },
    await indexValueLocator.elementHandle(),
    { timeout: 15000 }
  );

  const rawText = await indexValueLocator.innerText();
  const match = rawText.replace(/,/g, '').match(/\d{5}(?:\.\d+)?/);

  if (match) return parseFloat(match[0]);
  throw new Error(`Failed to parse NIFTY 50 spot price from text: "${rawText}"`);
}

// ---------------------------------------------------------------------------
// Telegram API Wrapper
// ---------------------------------------------------------------------------

async function sendMessage(chatId, text) {
  try {
    const res = await axios.post(`${TG_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
    return res.data.result;
  } catch (e) {
    console.error('Send error:', e.response?.data || e.message);
  }
}

async function editMessage(chatId, messageId, text) {
  try {
    await axios.post(`${TG_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    });
  } catch (e) {}
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(`${TG_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (e) {}
}

function formatTableMessage(tableRows, spotPrice, expiryDate, settlementDate, isCached = false) {
  const pad = (val, len, alignRight = false) => {
    const s = String(val);
    return alignRight ? s.padStart(len, ' ') : s.padEnd(len, ' ');
  };

  let message = `📊 <b><u>NIFTY Prime & Settlement Levels</u></b>`;
  if (isCached) {
    message += ` <i>(Cached)</i>`;
  }
  message += `\n\n📅 <b>Trade Date:</b> ${settlementDate || 'N/A'}\n`;
  message += `🔹 <b>Spot Price:</b> ${spotPrice}\n`;
  message += `🔹 <b>Target Expiry:</b> ${expiryDate}\n\n`;
  message += `<pre>`;
  message += `${pad('Strike', 6)} | ${pad('CALL', 4, true)} | ${pad('PUT', 4, true)} | ${pad('Total', 5, true)} | ${pad('Prime', 5, true)}\n`;
  message += `-----------------------------------------\n`;

  tableRows.forEach((r) => {
    const strike = pad(r.Strike, 6);
    const call = pad(r['Call Strike - Settlement Price'], 4, true);
    const put = pad(r['Put Strike - Settlement Price'], 4, true);
    const total = pad(r.Total, 5, true);
    const prime = pad(r['Prime Level'], 5, true);
    message += `${strike} | ${call} | ${put} | ${total} | ${prime}\n`;
  });

  message += `</pre>`;
  return message;
}

// ---------------------------------------------------------------------------
// Automation Task Runner: /levels
// ---------------------------------------------------------------------------

let isRunning = false;

async function executeLevelsTask(chatId, manualSpot = null, forceRefresh = false) {
  const timeCheck = isAllowedExecutionTime();
  if (!timeCheck.allowed) {
    return sendMessage(chatId, timeCheck.reason);
  }

  if (!manualSpot && !forceRefresh) {
    const expectedDate = getExpectedSettlementDateDDMMYYYY();
    const cachedData = getCachedLevelsForDate(expectedDate);

    if (cachedData && cachedData.levels && cachedData.levels.length > 0) {
      console.log(`⚡ Serving request instantly from local file (${expectedDate}.json)...`);

      const mappedRows = cachedData.levels.map((lvl) => ({
        Strike: lvl.strike,
        'Call Strike - Settlement Price': lvl.callSettlementPrice,
        'Put Strike - Settlement Price': lvl.putSettlementPrice,
        Total: lvl.total,
        'Prime Level': lvl.primeLevel,
      }));

      const cachedResponse = formatTableMessage(
        mappedRows,
        cachedData.spotPrice,
        cachedData.expiryDate,
        cachedData.settlementDate || expectedDate,
        true
      );
      return sendMessage(chatId, cachedResponse);
    }
  }

  if (isRunning) {
    return sendMessage(chatId, '⚠️ An extraction task is already running. Please wait for it to finish.');
  }

  isRunning = true;
  const statusMsg = await sendMessage(chatId, '⏳ <i>Opening NSE session & fetching metadata...</i>');

  const currentYear = String(new Date().getFullYear());

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const net = trackNetwork(page);

  try {
    console.log('Navigating directly to NIFTY Derivatives page...');
    await page.goto('https://www.nseindia.com/get-quote/derivatives/NIFTY/NIFTY-50', {
      waitUntil: 'load',
      timeout: 60000,
    });

    let spotPrice = manualSpot;
    if (!spotPrice) {
      console.log('Extracting live NIFTY 50 Spot Price...');
      spotPrice = await getAccurateSpotPrice(page);
    }
    console.log(`Using Spot Price: ${spotPrice}`);

    const { strikes } = getStrikeList(spotPrice);
    console.log(`Processing strikes: ${strikes.join(', ')}\n`);

    console.log('Switching to Historical Data tab...');
    const histTab = page.locator('#derivatives-tabs-tab-historical-data');
    await histTab.waitFor({ state: 'visible', timeout: 15000 });
    const tabMark = net.started;
    await histTab.click();
    await waitForDataLoaded(net, tabMark);
    await page.locator(`${PANE} select.custom-select`).first().waitFor({ state: 'attached', timeout: 15000 });

    // Ensure date range is active by clicking 1M button
    const oneMonthBtn = page.locator(`${PANE} button:has-text("1M"), ${PANE} div:has-text("1M")`).first();
    if ((await oneMonthBtn.count()) > 0) {
      const rangeMark = net.started;
      await oneMonthBtn.click().catch(() => {});
      await waitForDataLoaded(net, rangeMark);
    }

    const dropdowns = page.locator(`${PANE} .custom-select-wrapper select.custom-select`);

    // ---- STEP 1: load all dropdown values once, in order, waiting for each ----
    const upcomingExpiryDate = await loadFilters(page, net, dropdowns, currentYear);

    if (statusMsg) {
      await editMessage(
        chatId,
        statusMsg.message_id,
        `🎯 <b>Spot:</b> ${spotPrice} | <b>Expiry:</b> ${upcomingExpiryDate}\n⏳ <i>Calculating ${strikes.length} strike levels...</i>`
      );
    }

    // ---- STEP 2: strike by strike -> Call, then Put, waiting for data each time ----
    const ctx = { spot: spotPrice, expiry: upcomingExpiryDate, year: currentYear };
    const results = [];

    for (const strike of strikes) {
      console.log(`Processing strike ${strike}...`);
      const call = await fetchSettlement(page, net, dropdowns, ctx, strike, 'CE');
      const put = await fetchSettlement(page, net, dropdowns, ctx, strike, 'PE');
      results.push({ strike, call, put });
      console.log(`  ${strike} -> CALL: ${call.price} (${call.tradeDate}) | PUT: ${put.price} (${put.tradeDate})`);
    }

    // ---- STEP 3: consistency check - every value must come from the same (latest) trade date ----
    const allDates = results
      .flatMap((r) => [r.call, r.put])
      .filter((x) => x.price !== null)
      .map((x) => parseDateStr(x.tradeDate));
    const maxTs = allDates.length ? Math.max(...allDates) : 0;

    if (maxTs > 0) {
      for (const r of results) {
        for (const [side, optType] of [
          ['call', 'CE'],
          ['put', 'PE'],
        ]) {
          const cur = r[side];
          if (cur.price !== null && parseDateStr(cur.tradeDate) < maxTs) {
            console.warn(`  [recheck] ${r.strike} ${optType}: date ${cur.tradeDate} is older than the latest, re-fetching...`);
            const again = await fetchSettlement(page, net, dropdowns, ctx, r.strike, optType);
            if (again.price !== null && parseDateStr(again.tradeDate) >= parseDateStr(cur.tradeDate)) {
              r[side] = again;
            }
          }
        }
      }
    }

    // ---- STEP 4: never save or send incomplete data ----
    const missing = [];
    results.forEach((r) => {
      if (r.call.price === null) missing.push(`${r.strike} CE`);
      if (r.put.price === null) missing.push(`${r.strike} PE`);
    });
    if (missing.length) {
      throw new Error(`Could not verify settlement price for: ${missing.join(', ')}. Nothing was saved. Please try /levels force again.`);
    }

    const tableRows = results.map((r) => {
      const total = r.call.price + r.put.price;
      return {
        Strike: r.strike,
        'Call Strike - Settlement Price': r.call.price,
        'Put Strike - Settlement Price': r.put.price,
        Total: total,
        'Prime Level': Math.round(total / 2),
      };
    });
    tableRows.sort((a, b) => b.Strike - a.Strike);

    const detectedSettlementDate = results.map((r) => r.call.tradeDate || r.put.tradeDate).find(Boolean);
    const finalDateStr = detectedSettlementDate || getExpectedSettlementDateDDMMYYYY();
    saveLevelsToJson(tableRows, spotPrice, upcomingExpiryDate, finalDateStr);

    const responseText = formatTableMessage(tableRows, spotPrice, upcomingExpiryDate, finalDateStr, false);
    await sendMessage(chatId, responseText);
    if (statusMsg) await deleteMessage(chatId, statusMsg.message_id);
  } catch (error) {
    console.error('Execution error:', error);
    await sendMessage(chatId, `❌ <b>Error:</b> ${error.message}`);
  } finally {
    isRunning = false;
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Automation Task Runner: /lines <spot>
// ---------------------------------------------------------------------------

let isDrawing = false;

async function drawOnDhanAndReport(chatId, expiryDate, linesData) {
  if (isDrawing) {
    return sendMessage(chatId, '⚠️ Already drawing lines on Dhan. Please wait for it to finish.');
  }
  isDrawing = true;
  await sendMessage(chatId, '🖍️ <i>Opening Dhan charts (NIFTY 50 | Call | Put) to draw the lines...</i>');
  try {
    const result = await drawLinesOnDhan({
      expiry: expiryDate,
      call: linesData.call,
      put: linesData.put,
      notify: (text) => sendMessage(chatId, text),
    });
    await sendMessage(chatId, result.summary);
  } catch (error) {
    console.error('Dhan drawing error:', error);
    await sendMessage(
      chatId,
      `❌ <b>Dhan drawing failed:</b> ${String(error.message).replace(/</g, '&lt;')}\n` +
        `<i>Screenshot and UI map saved in the dhan-debug folder.</i>`
    );
  } finally {
    isDrawing = false;
  }
}

async function executeLinesTask(chatId, spotInput) {
  const linesCmd = CONFIG.COMMANDS.LINES;

  if (!spotInput || isNaN(spotInput)) {
    const usageMessage =
      `⚠️ <b>Missing Spot Price</b>\n\n` +
      `Please provide the spot price in the following format:\n` +
      `👉 <code>${linesCmd} &lt;spot_price&gt;</code>\n\n` +
      `<b>Example:</b>\n` +
      `• <code>${linesCmd} 22523</code>\n` +
      `• <code>${linesCmd} 22590</code>`;
    return sendMessage(chatId, usageMessage);
  }

  const cachedJson = getLatestSavedLevelsFile();

  if (!cachedJson || !cachedJson.levels || !cachedJson.levels.length) {
    return sendMessage(
      chatId,
      `⚠️ No settlement data found on disk.\nPlease run <code>${CONFIG.COMMANDS.LEVELS}</code> first to fetch and save the latest data.`
    );
  }

  try {
    const linesData = calculateColorLevels(spotInput, cachedJson.levels);
    const tradeDate = cachedJson.settlementDate || cachedJson.normalizedDate;

    // 1. Send the analysis summary table
    const summaryMsg = formatColorLevelsTelegramMessage(linesData, spotInput, cachedJson.expiryDate, tradeDate);
    await sendMessage(chatId, summaryMsg);

    // 2. Send dedicated CALL Pine Script message
    const callPineCode = generateSidePineScript('CE', linesData.call.strike, linesData.call, tradeDate);
    const callPineMsg =
      `🟢 <b><u>Pine Script: CALL (${linesData.call.strike} CE)</u></b>\n` +
      `<i>Tap to copy and paste into TradingView Pine Editor:</i>\n\n` +
      `<pre><code class="language-pinescript">${callPineCode}</code></pre>`;
    await sendMessage(chatId, callPineMsg);

    // 3. Send dedicated PUT Pine Script message
    const putPineCode = generateSidePineScript('PE', linesData.put.strike, linesData.put, tradeDate);
    const putPineMsg =
      `🔴 <b><u>Pine Script: PUT (${linesData.put.strike} PE)</u></b>\n` +
      `<i>Tap to copy and paste into TradingView Pine Editor:</i>\n\n` +
      `<pre><code class="language-pinescript">${putPineCode}</code></pre>`;
    await sendMessage(chatId, putPineMsg);

    // 4. Open Dhan and draw the lines on the Call / Put charts
    await drawOnDhanAndReport(chatId, cachedJson.expiryDate, linesData);
  } catch (error) {
    console.error('Lines calculation error:', error);
    await sendMessage(chatId, `❌ <b>Error:</b> ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Native Long-Polling Loop
// ---------------------------------------------------------------------------

let lastUpdateId = 0;

async function pollUpdates() {
  try {
    const res = await axios.get(`${TG_API}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 25 },
      timeout: 30000,
    });

    const updates = res.data?.result || [];
    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      // const chatId = String(msg.chat.id);
      // const text = msg.text.trim();
      // if (chatId !== CONFIG.ALLOWED_CHAT_ID) {
      //   await sendMessage(chatId, '⛔ Unauthorized access.');
      //   continue;
      // }

      const chatId = String(msg.chat.id);
      // Strip @BotUsername if someone clicks a command from the group menu (e.g., /levels@my_bot -> /levels)
      const text = msg.text.trim().replace(/^(\/\w+)@\w+/, '$1');

      if (!CONFIG.ALLOWED_CHAT_IDS.includes(chatId)) {
        console.log(`⚠️ Blocked unauthorized Chat ID: ${chatId} (Chat Title: ${msg.chat.title || 'Private'})`);
        await sendMessage(
          chatId,
          `⛔ <b>Unauthorized access.</b>\nChat ID: <code>${chatId}</code>`
        );
        continue;
      }

      const { LEVELS, LINES, STATUS, START, HELP } = CONFIG.COMMANDS;

      if (text.startsWith(START) || text.startsWith(HELP)) {
        const helpText =
          `👋 <b>Welcome to NSE Prime Levels Bot</b>\n\n` +
          `Commands:\n` +
          `• <code>${LEVELS}</code> - Fetch or get cached settlement levels\n` +
          `• <code>${LEVELS} force</code> - Force Playwright refresh from NSE\n` +
          `• <code>${LINES} &lt;spot&gt;</code> - Compute Call/Put color lines & Pine Scripts (e.g. <code>${LINES} 22523</code>)\n` +
          `• <code>${STATUS}</code> - Check bot health & active file`;
        await sendMessage(chatId, helpText);
      } else if (text.startsWith(STATUS)) {
        const expectedDate = getExpectedSettlementDateDDMMYYYY();
        const cached = getCachedLevelsForDate(expectedDate);
        const cacheInfo = cached ? `Available (${expectedDate}.json)` : `Not found (${expectedDate}.json)`;
        const timeGate = isAllowedExecutionTime();
        await sendMessage(
          chatId,
          `🟢 <b>Bot Status:</b>\n` +
            `• State: ${isRunning ? 'Busy (Processing)' : 'Idle'}\n` +
            `• Active Window: ${timeGate.windowStr}\n` +
            `• File: ${cacheInfo}`
        );
      } else if (text.startsWith(LEVELS)) {
        const parts = text.split(/\s+/);
        let manualSpot = null;
        let forceRefresh = false;

        if (parts.length > 1) {
          if (parts[1].toLowerCase() === 'force') {
            forceRefresh = true;
          } else if (!isNaN(parseFloat(parts[1]))) {
            manualSpot = parseFloat(parts[1]);
          }
        }
        executeLevelsTask(chatId, manualSpot, forceRefresh);
      } else if (text.startsWith(LINES)) {
        const parts = text.split(/\s+/);
        let spotVal = null;
        if (parts.length > 1 && !isNaN(parseFloat(parts[1]))) {
          spotVal = parseFloat(parts[1]);
        }
        executeLinesTask(chatId, spotVal);
      }
    }
  } catch (e) {
    if (e.code !== 'ECONNABORTED') {
      console.error('Polling error:', e.message);
    }
    await sleep(2000);
  }

  setImmediate(pollUpdates);
}

console.log('🤖 Bot long-polling started. Listening for commands on Telegram...');
pollUpdates();
