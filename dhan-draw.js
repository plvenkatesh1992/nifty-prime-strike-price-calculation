'use strict';

/**
 * Opens Dhan's TradingView charts (tv.dhan.co), builds a 3-column layout
 * (NIFTY 50 | Call option | Put option) and draws the calculated horizontal lines
 * on the Call and Put charts.
 *
 * Design rules:
 *  - Every step is VERIFIED (pane count, symbol shown in the pane, line price) instead of assumed.
 *  - If an automatic step cannot be completed, the bot asks you on Telegram to do that one step
 *    by hand, waits for it, and continues.
 *  - On any failure a screenshot + a map of the page's buttons is saved in ./dhan-debug so the
 *    selectors can be tuned quickly.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ===========================================================================
// SETTINGS
// ===========================================================================
const DHAN = {
  URL: process.env.DHAN_URL || 'https://tv.dhan.co/',
  // Playwright cannot reuse your normal Chrome login, so it keeps its own profile folder.
  // Log in to Dhan ONCE in the window it opens; the login is remembered after that.
  PROFILE_DIR: path.join(__dirname, 'dhan-profile'),
  // Optional: attach to a Chrome you started yourself with --remote-debugging-port=9222
  CDP_URL: process.env.DHAN_CDP_URL || '',
  DEBUG_DIR: path.join(__dirname, 'dhan-debug'),
  MANUAL_WAIT_MS: 90000, // how long to wait when a step has to be done by hand
  // TradingView palette colours (so the nearest swatch is an exact match)
  COLORS: {
    green: '#4CAF50',
    orange: '#FF9800',
    black: '#787B86', // grey like in the Pine script (pure black is invisible on dark charts)
    blue: '#2962FF',
  },
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_FILE = path.join(DHAN.DEBUG_DIR, 'last-run.log');
const log = (...a) => {
  const line = `[dhan] ${a.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(DHAN.DEBUG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch (e) {}
};

async function waitFor(fn, timeoutMs, intervalMs = 400) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      /* keep waiting */
    }
    await sleep(intervalMs);
  }
  return null;
}

// ===========================================================================
// Symbols & levels
// ===========================================================================

// "13-Oct-2026" -> { dd: '13', mon: 'OCT', yyyy: '2026' }
function parseExpiry(expiry) {
  const m = String(expiry || '').trim().match(/^(\d{1,2})[-\s/]([A-Za-z]{3}|\d{1,2})[-\s/](\d{4})$/);
  if (!m) return null;
  const mon = isNaN(m[2]) ? m[2].toUpperCase() : MONTHS[parseInt(m[2], 10) - 1];
  return { dd: m[1].padStart(2, '0'), mon, yyyy: m[3] };
}

function optionQueries(expiry, strike, optType) {
  const e = parseExpiry(expiry);
  if (!e) throw new Error(`Cannot understand expiry "${expiry}"`);
  const word = optType === 'CE' ? 'CALL' : 'PUT';
  return [
    `NIFTY ${e.dd} ${e.mon} ${strike} ${word}`,
    `NIFTY ${e.dd} ${e.mon} ${e.yyyy} ${strike} ${word}`,
    `NIFTY ${strike} ${word} ${e.dd} ${e.mon}`,
  ];
}

function optionPaneVerifier(strike, optType) {
  const side = optType === 'CE' ? /\b(CE|CALL)\b/i : /\b(PE|PUT)\b/i;
  return (text) => text.includes(String(strike)) && side.test(text);
}

function optionRowMatcher(expiry, strike, optType) {
  const e = parseExpiry(expiry);
  const side = optType === 'CE' ? /\b(CE|CALL)\b/i : /\b(PE|PUT)\b/i;
  return (text) =>
    text.includes(String(strike)) && side.test(text) && (!e || text.toUpperCase().includes(e.mon));
}

// Turns {greenLine, orangeLine, blackLine, blueLines[]} into drawable levels (skips N/A)
function buildLevels(side) {
  const out = [];
  const add = (label, val, color) => {
    const n = Number(val);
    if (val === 'N/A' || val === null || val === undefined || !isFinite(n)) return;
    out.push({ label, price: n, color });
  };
  add('Entry', side.greenLine, DHAN.COLORS.green);
  add('Prime', side.orangeLine, DHAN.COLORS.orange);
  add('Support/Stop', side.blackLine, DHAN.COLORS.black);
  (side.blueLines || []).forEach((v, i) => add(`T${i + 1}`, v, DHAN.COLORS.blue));
  return out;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// ===========================================================================
// Browser session (reused between /lines commands)
// ===========================================================================
let session = null;

async function getPage() {
  if (session && !session.page.isClosed()) return session.page;

  if (DHAN.CDP_URL) {
    const browser = await chromium.connectOverCDP(DHAN.CDP_URL);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();
    session = { browser, context, page };
  } else {
    const context = await chromium.launchPersistentContext(DHAN.PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--start-maximized'],
    });
    const page = context.pages()[0] || (await context.newPage());
    session = { context, page };
  }
  return session.page;
}

// The chart panes can live in an iframe, so look through every frame
async function findChartFrame(page, timeoutMs) {
  return waitFor(async () => {
    for (const f of page.frames()) {
      const n = await f.locator('.chart-container').count().catch(() => 0);
      if (n > 0) return f;
    }
    return null;
  }, timeoutMs, 600);
}

async function getPanes(frame) {
  const loc = frame.locator('.chart-container');
  const n = await loc.count();
  const items = [];
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width > 150 && box.height > 150) items.push({ el, box });
  }
  items.sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y);
  return items;
}

function isThreeColumns(panes) {
  if (panes.length !== 3) return false;
  const xs = panes.map((p) => p.box.x);
  const minW = Math.min(...panes.map((p) => p.box.width));
  return Math.max(...xs) - Math.min(...xs) > minW * 1.2; // side by side, not stacked
}

async function paneText(frame, index) {
  const panes = await getPanes(frame);
  if (!panes[index]) return '';
  return (await panes[index].el.innerText().catch(() => '')) || '';
}

// ===========================================================================
// Debug helpers
// ===========================================================================
async function dumpDebug(page, tag) {
  try {
    fs.mkdirSync(DHAN.DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DHAN.DEBUG_DIR, `${stamp}-${tag}`);
    await page.screenshot({ path: `${base}.png` }).catch(() => {});
    const map = [];
    for (const f of page.frames()) {
      const items = await f
        .evaluate(() =>
          Array.from(document.querySelectorAll('[data-name],[aria-label],[title],[id^="header-toolbar"],[role="menuitem"],[role="option"]'))
            .slice(0, 500)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              dataName: el.getAttribute('data-name') || undefined,
              aria: el.getAttribute('aria-label') || undefined,
              title: el.getAttribute('title') || undefined,
              role: el.getAttribute('role') || undefined,
              text: (el.innerText || '').trim().slice(0, 40) || undefined,
            }))
        )
        .catch(() => []);
      map.push({ frame: f.url(), items });
    }
    fs.writeFileSync(`${base}-ui-map.json`, JSON.stringify(map, null, 2));
    log(`debug files saved: ${base}.png / -ui-map.json`);
  } catch (e) {
    log('could not save debug files:', e.message);
  }
}

// ===========================================================================
// Step 1: open Dhan (log in once if needed)
// ===========================================================================
async function openDhan(notify) {
  const page = await getPage();
  if (!/tv\.dhan\.co/i.test(page.url())) {
    await page.goto(DHAN.URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  let frame = await findChartFrame(page, 25000);
  if (!frame) {
    await notify(
      '🔐 Dhan charts did not load. If the login page is showing, please log in to Dhan in the browser window I opened ' +
        '(I will wait up to 3 minutes). This is needed only once; the login is remembered.'
    );
    frame = await findChartFrame(page, 180000);
  }
  if (!frame) throw new Error('Dhan charts did not load (not logged in, or the page layout changed).');
  await sleep(1500);
  return page;
}

// ===========================================================================
// Step 2: 3-column layout
// ===========================================================================
const LAYOUT_BUTTONS = [
  '[data-name*="layout" i]',
  'button[aria-label*="layout" i]',
  'button[title*="layout" i]',
  '[id*="layout" i][role="button"]',
];

async function openLayoutMenu(page) {
  for (const c of [page, ...page.frames()]) {
    for (const sel of LAYOUT_BUTTONS) {
      const loc = c.locator(sel);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 6); i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 2000 }).catch(() => {});
          await sleep(500);
          return true;
        }
      }
    }
  }
  return false;
}

async function layoutMenuCandidates(page) {
  const out = [];
  for (const c of [page, ...page.frames()]) {
    const loc = c.locator('[role="menuitem"], [role="option"], [role="menuitemradio"]');
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const label =
        (await el.getAttribute('aria-label').catch(() => '')) ||
        (await el.getAttribute('title').catch(() => '')) ||
        (await el.innerText().catch(() => '')) ||
        '';
      if (/(^|\D)3(\D|$)|three/i.test(label)) out.push({ el, label });
    }
  }
  return out;
}

async function ensureThreeColumns(page, notify) {
  let frame = await findChartFrame(page, 10000);
  if (isThreeColumns(await getPanes(frame))) return;

  log('Trying to switch to a 3-column layout...');
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await openLayoutMenu(page))) break;
    const candidates = await layoutMenuCandidates(page);
    if (!candidates[attempt]) {
      await page.keyboard.press('Escape').catch(() => {});
      break;
    }
    log(`  trying layout option: "${candidates[attempt].label}"`);
    await candidates[attempt].el.click({ timeout: 2000 }).catch(() => {});
    await sleep(1500);
    frame = await findChartFrame(page, 8000);
    if (frame && isThreeColumns(await getPanes(frame))) {
      log('  3-column layout is active');
      return;
    }
  }

  await dumpDebug(page, 'layout');
  await notify(
    '🧩 I could not pick the 3-column layout automatically. Please choose a layout with <b>3 charts side by side</b> ' +
      'in Dhan (layout button in the top toolbar). I will continue as soon as I see it (waiting up to 90 seconds).'
  );
  const ok = await waitFor(async () => {
    const f = await findChartFrame(page, 1000);
    return f && isThreeColumns(await getPanes(f));
  }, DHAN.MANUAL_WAIT_MS, 1000);
  if (!ok) throw new Error('3-column layout was not set (needs 3 charts side by side).');
}

// ===========================================================================
// Step 3: symbol per pane
// ===========================================================================
async function openSymbolSearch(page) {
  const sels = ['#header-toolbar-symbol-search', '[data-name="header-toolbar-symbol-search"]', 'button[aria-label*="Symbol Search" i]'];
  for (const c of [page, ...page.frames()]) {
    for (const sel of sels) {
      const el = c.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 2000 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

async function findSearchInput(page) {
  return waitFor(async () => {
    for (const c of [page, ...page.frames()]) {
      const loc = c.locator('input[data-role="search"], [data-name="symbol-search-items-dialog"] input, input[placeholder*="earch" i]');
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) return { ctx: c, input: loc.nth(i) };
      }
    }
    return null;
  }, 4000, 300);
}

// Sets the symbol of pane `index`, verifying the pane really shows it afterwards
async function setPaneSymbol(page, index, { queries, rowMatcher, verify, label }, notify) {
  for (const query of queries) {
    const frame = await findChartFrame(page, 8000);
    const panes = await getPanes(frame);
    if (!panes[index]) throw new Error(`Pane ${index + 1} not found`);

    // make this pane the active chart
    const b = panes[index].box;
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await sleep(300);

    if (!(await openSymbolSearch(page))) {
      await page.keyboard.type(query.slice(0, 1)); // typing a letter on a chart opens search too
    }
    const found = await findSearchInput(page);
    if (!found) {
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }

    await found.input.fill('');
    await found.input.fill(query);
    await sleep(1500);

    const rows = found.ctx.locator('[data-role="list-item"]');
    const n = await rows.count().catch(() => 0);
    let clicked = false;
    for (let i = 0; i < Math.min(n, 15); i++) {
      const text = (await rows.nth(i).innerText().catch(() => '')) || '';
      if (rowMatcher(text)) {
        await rows.nth(i).click({ timeout: 2000 }).catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      log(`  "${query}": no matching search result (${n} rows)`);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
      continue;
    }

    const ok = await waitFor(async () => {
      const f = await findChartFrame(page, 2000);
      return verify(await paneText(f, index));
    }, 8000, 500);
    if (ok) {
      log(`  pane ${index + 1} now shows ${label}`);
      return;
    }
  }

  await dumpDebug(page, `symbol-pane${index + 1}`);
  await notify(
    `🔎 I could not set <b>${label}</b> on chart ${index + 1} (left to right) automatically. Please set it by hand ` +
      `(click that chart, search the symbol). Waiting up to 90 seconds...`
  );
  const ok = await waitFor(async () => {
    const f = await findChartFrame(page, 1000);
    return verify(await paneText(f, index));
  }, DHAN.MANUAL_WAIT_MS, 1000);
  if (!ok) throw new Error(`Chart ${index + 1} does not show ${label}.`);
}

// ===========================================================================
// Step 4: draw horizontal lines
// ===========================================================================

// ---- 4a. Preferred: TradingView widget API, if the page exposes the widget object ----
async function findWidget(page) {
  for (const f of page.frames()) {
    const name = await f
      .evaluate(() => {
        for (const k of Object.getOwnPropertyNames(window)) {
          try {
            const v = window[k];
            if (v && typeof v === 'object' && typeof v.activeChart === 'function' && typeof v.chart === 'function') return k;
          } catch (e) {}
        }
        return null;
      })
      .catch(() => null);
    if (name) return { frame: f, name };
  }
  return null;
}

// NOTE: everything sent into page.evaluate must be plain data (no closures / functions).
async function drawViaApi(widget, { strike, optType }, levels) {
  try {
    return await widget.frame.evaluate(
      async ({ name, strike, optType, levels }) => {
        const w = window[name];
        const wantSide = optType === 'CE' ? /CE|CALL/i : /PE|PUT/i;
        const count = typeof w.chartsCount === 'function' ? w.chartsCount() : 3;
        const seen = [];
        for (let i = 0; i < count; i++) {
          let c;
          try {
            c = w.chart(i);
          } catch (e) {
            continue;
          }
          const ext = typeof c.symbolExt === 'function' ? c.symbolExt() || {} : {};
          const text = [c.symbol && c.symbol(), ext.symbol, ext.full_name, ext.description, ext.name, ext.ticker]
            .filter(Boolean)
            .join(' ');
          seen.push(`#${i}: ${text}`);
          if (!text.includes(String(strike)) || !wantSide.test(text)) continue;

          let drawn = 0;
          const errors = [];
          for (const lv of levels) {
            try {
              await c.createShape(
                { time: Math.floor(Date.now() / 1000), price: lv.price },
                {
                  shape: 'horizontal_line',
                  lock: false,
                  zOrder: 'top',
                  text: lv.label,
                  overrides: { linecolor: lv.color, linewidth: 2, showLabel: true, textcolor: lv.color },
                }
              );
              drawn++;
            } catch (e) {
              errors.push(String((e && e.message) || e));
            }
          }
          return { drawn, seen, errors };
        }
        return { drawn: 0, seen, errors: ['no chart in the widget matched this symbol'] };
      },
      { name: widget.name, strike, optType, levels }
    );
  } catch (e) {
    return { drawn: 0, seen: [], errors: [`evaluate failed: ${e.message}`] };
  }
}

// ---- 4b. Fallback: drive the drawing tool and its settings dialog ----

// Finds the open drawing-settings dialog by its "Coordinates" tab and tags it, so later steps
// stay inside that dialog. Returns a Locator for it, or null.
async function locateSettingsDialog(page, timeoutMs = 3500) {
  return waitFor(async () => {
    for (const c of [page, ...page.frames()]) {
      const found = await c
        .evaluate(() => {
          document.querySelectorAll('[data-bot-dialog]').forEach((e) => e.removeAttribute('data-bot-dialog'));
          const leaves = Array.from(document.querySelectorAll('*')).filter(
            (e) => e.children.length === 0 && (e.textContent || '').trim() === 'Coordinates' && e.getBoundingClientRect().width > 0
          );
          for (const leaf of leaves) {
            let p = leaf;
            for (let i = 0; i < 14; i++) {
              p = p.parentElement;
              if (!p) break;
              if (p.querySelector('input') && /Style/.test(p.innerText || '')) {
                p.setAttribute('data-bot-dialog', '1');
                return true;
              }
            }
          }
          return false;
        })
        .catch(() => false);
      if (found) return c.locator('[data-bot-dialog="1"]').first();
    }
    return null;
  }, timeoutMs, 250);
}

// Tags the "Price" input of the Coordinates tab
async function tagPriceInput(dialog) {
  return dialog
    .evaluate((root) => {
      root.querySelectorAll('[data-bot-price]').forEach((e) => e.removeAttribute('data-bot-price'));
      const labels = Array.from(root.querySelectorAll('*')).filter((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Price');
      for (const l of labels) {
        let p = l;
        for (let i = 0; i < 6; i++) {
          p = p.parentElement;
          if (!p) break;
          const inp = p.querySelector('input');
          if (inp) {
            inp.setAttribute('data-bot-price', '1');
            return true;
          }
        }
      }
      const first = Array.from(root.querySelectorAll('input')).find((i) => /^-?[\d,]*\.?\d+$/.test(i.value));
      if (first) {
        first.setAttribute('data-bot-price', '1');
        return true;
      }
      return false;
    })
    .catch(() => false);
}

async function visibleColorCells(page) {
  const all = [];
  for (const c of [page, ...page.frames()]) {
    const cells = await c
      .evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.width > 34 || r.height < 8 || r.height > 34) continue;
          const bg = getComputedStyle(el).backgroundColor;
          if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
          const m = bg.match(/\d+/g);
          if (!m || m.length < 3) continue;
          out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, rgb: m.slice(0, 3).map(Number) });
        }
        return out;
      })
      .catch(() => []);
    all.push(...cells);
  }
  return all;
}

// Best effort only: the price is already set when this runs, so a failure here never loses the line
async function setLineColor(page, dialog, hex) {
  try {
    await dialog.getByText('Style', { exact: true }).first().click({ timeout: 1500 });
    await sleep(300);
    const before = await visibleColorCells(page);
    const key = (c) => `${Math.round(c.x)}:${Math.round(c.y)}:${c.rgb.join(',')}`;
    const beforeKeys = new Set(before.map(key));
    const box = await dialog.boundingBox();
    const inDialog = before.filter((c) => box && c.x >= box.x && c.x <= box.x + box.width && c.y >= box.y && c.y <= box.y + box.height);
    if (!inDialog[0]) return false;
    await page.mouse.click(inDialog[0].x, inDialog[0].y);
    await sleep(500);

    const fresh = (await visibleColorCells(page)).filter((c) => !beforeKeys.has(key(c)));
    if (!fresh.length) return false;
    const want = hexToRgb(hex);
    let best = null;
    for (const c of fresh) {
      const d = Math.hypot(c.rgb[0] - want[0], c.rgb[1] - want[1], c.rgb[2] - want[2]);
      if (!best || d < best.d) best = { c, d };
    }
    if (!best || best.d > 110) return false;
    await page.mouse.click(best.c.x, best.c.y);
    await sleep(400);
    // click the dialog title area to close any palette popup that is still open (NOT Escape: that cancels the dialog)
    if (box) await page.mouse.click(box.x + 24, box.y + 16);
    await sleep(200);
    return true;
  } catch (e) {
    return false;
  }
}

async function openLineSettings(page, x, y) {
  await page.mouse.dblclick(x, y);
  let dialog = await locateSettingsDialog(page, 2500);
  if (dialog) return { dialog, via: 'double-click' };

  // fallback: right-click -> Settings...
  await page.mouse.click(x, y, { button: 'right' });
  await sleep(500);
  for (const c of [page, ...page.frames()]) {
    const item = c.getByText(/^\s*Settings/i).first();
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: 1500 }).catch(() => {});
      break;
    }
  }
  dialog = await locateSettingsDialog(page, 2500);
  if (dialog) return { dialog, via: 'right-click' };
  await page.keyboard.press('Escape').catch(() => {});
  return null;
}

const num = (s) => parseFloat(String(s || '').replace(/,/g, ''));

// Returns { ok: true } or { ok: false, stage, detail }
// Estimates where a price sits on screen from (y, price) pairs we have observed on this pane
function predictY(pairs, price) {
  if (pairs.length < 2) return null;
  const a = pairs[0];
  const b = pairs.find((p) => Math.abs(p.price - a.price) > 0.5 && Math.abs(p.y - a.y) > 5);
  if (!b) return null;
  return a.y + ((price - a.price) * (b.y - a.y)) / (b.price - a.price);
}

async function drawLineUI(page, paneIndex, level, usedPrices, pairs = []) {
  let fail = { stage: 'start', detail: '' };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const frame = await findChartFrame(page, 5000);
      const panes = await getPanes(frame);
      const pane = panes[paneIndex];
      if (!pane) {
        fail = { stage: 'pane-missing', detail: `pane ${paneIndex + 1} not found` };
        continue;
      }
      const b = pane.box;
      const x = Math.round(b.x + b.width * 0.5);
      // pick a spot at least 18px away from lines we already placed (their screen position is estimated)
      const busyYs = usedPrices.map((p) => predictY(pairs, p)).filter((v) => v !== null);
      let y = Math.round(b.y + b.height * (0.25 + 0.12 * attempt));
      for (let k = 0; k < 14 && busyYs.some((by) => Math.abs(by - y) < 18); k++) {
        y = Math.round(b.y + b.height * (0.2 + 0.05 * ((k + attempt * 3) % 14)));
      }

      // 1. activate the chart
      await page.mouse.move(x, y);
      await page.mouse.click(x, y);
      await sleep(250);

      // 2. create the line (Alt+H draws it at the cursor; if it only arms the tool, the click places it)
      await page.mouse.move(x, y);
      await page.keyboard.press('Alt+h');
      await sleep(500);
      await page.mouse.click(x, y);
      await sleep(400);

      // 3. open its settings
      const opened = await openLineSettings(page, x, y);
      if (!opened) {
        fail = { stage: 'open-settings', detail: 'settings dialog did not open (hotkey Alt+H may not create a line here)' };
        log(`    attempt ${attempt + 1}: ${fail.detail}`);
        if (attempt === 0) await dumpDebug(page, 'draw-no-dialog');
        continue;
      }
      const dialog = opened.dialog;
      log(`    attempt ${attempt + 1}: settings opened via ${opened.via}`);

      // 4. Coordinates tab -> Price input
      await dialog.getByText('Coordinates', { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
      await sleep(300);
      if (!(await tagPriceInput(dialog))) {
        fail = { stage: 'price-input', detail: 'Price input not found in the Coordinates tab' };
        log(`    attempt ${attempt + 1}: ${fail.detail}`);
        if (attempt === 0) await dumpDebug(page, 'draw-no-price-input');
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(300);
        continue;
      }
      const input = dialog.locator('[data-bot-price="1"]').first();

      // 5. make sure this is a NEW line, not one we already positioned
      const current = num(await input.inputValue().catch(() => ''));
      if (isFinite(current) && !usedPrices.some((p) => Math.abs(p - current) < 0.01)) pairs.push({ y, price: current });
      if (usedPrices.some((p) => Math.abs(p - current) < 0.01)) {
        fail = { stage: 'wrong-line', detail: `opened an existing line at ${current}` };
        log(`    attempt ${attempt + 1}: ${fail.detail}, trying another spot`);
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(300);
        continue;
      }

      // 6. set the price and confirm it stuck
      await input.click({ timeout: 1500 }).catch(() => {});
      await input.fill(String(level.price));
      await input.press('Tab').catch(() => {});
      await sleep(300);
      let confirmed = num(await input.inputValue().catch(() => ''));
      if (Math.abs(confirmed - level.price) > 0.01) {
        await input.click().catch(() => {});
        await page.keyboard.press('Control+A');
        await page.keyboard.type(String(level.price), { delay: 30 });
        await page.keyboard.press('Tab');
        await sleep(300);
        confirmed = num(await input.inputValue().catch(() => ''));
      }
      if (Math.abs(confirmed - level.price) > 0.01) {
        fail = { stage: 'set-price', detail: `price box shows ${confirmed}, wanted ${level.price}` };
        log(`    attempt ${attempt + 1}: ${fail.detail}`);
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(300);
        continue;
      }

      // 7. colour (best effort)
      const colored = await setLineColor(page, dialog, level.color);
      if (!colored) log(`    (colour not set for ${level.label}; default colour kept)`);

      // 8. confirm the dialog
      const okBtn = dialog.locator('button[name="submit"], button:has-text("Ok")').first();
      await okBtn.click({ timeout: 2000 }).catch(async () => {
        await page.keyboard.press('Enter').catch(() => {});
      });
      await sleep(500);
      return { ok: true };
    } catch (e) {
      fail = { stage: fail.stage || 'exception', detail: e.message.split('\n')[0] };
      log(`    attempt ${attempt + 1}: exception ${fail.detail}`);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
    }
  }
  return { ok: false, ...fail };
}

// ===========================================================================
// Public entry point
// ===========================================================================
async function drawLinesOnDhan({ expiry, call, put, notify }) {
  try {
    fs.mkdirSync(DHAN.DEBUG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, '');
  } catch (e) {}

  const say = async (t) => {
    try {
      await notify(t);
    } catch (e) {}
  };

  const page = await openDhan(say);

  try {
    // ---- layout ----
    await ensureThreeColumns(page, say);

    // ---- symbols (left to right: index, call, put) ----
    log('Setting symbols...');
    await setPaneSymbol(
      page,
      0,
      {
        queries: ['NIFTY 50', 'NIFTY'],
        rowMatcher: (t) => /NIFTY\s*50\b/i.test(t) && !/\b(FUT|CE|PE|CALL|PUT)\b/i.test(t),
        verify: (t) => /NIFTY\s*50\b/i.test(t),
        label: 'NIFTY 50 index',
      },
      say
    );
    await setPaneSymbol(
      page,
      1,
      {
        queries: optionQueries(expiry, call.strike, 'CE'),
        rowMatcher: optionRowMatcher(expiry, call.strike, 'CE'),
        verify: optionPaneVerifier(call.strike, 'CE'),
        label: `NIFTY ${expiry} ${call.strike} CALL`,
      },
      say
    );
    await setPaneSymbol(
      page,
      2,
      {
        queries: optionQueries(expiry, put.strike, 'PE'),
        rowMatcher: optionRowMatcher(expiry, put.strike, 'PE'),
        verify: optionPaneVerifier(put.strike, 'PE'),
        label: `NIFTY ${expiry} ${put.strike} PUT`,
      },
      say
    );

    // If "Sync in Layout -> Symbol" is ON, the last symbol overwrote the others. Detect it.
    {
      const f = await findChartFrame(page, 5000);
      const t0 = await paneText(f, 0);
      const t1 = await paneText(f, 1);
      if (!/NIFTY\s*50\b/i.test(t0) || !optionPaneVerifier(call.strike, 'CE')(t1)) {
        await dumpDebug(page, 'sync');
        throw new Error(
          'The charts changed each other\'s symbol. Turn OFF "Sync in layout -> Symbol" in Dhan\'s layout menu and run /lines again.'
        );
      }
    }

    // ---- lines ----
    const plan = [
      { pane: 1, name: 'Call', strike: call.strike, optType: 'CE', levels: buildLevels(call) },
      { pane: 2, name: 'Put', strike: put.strike, optType: 'PE', levels: buildLevels(put) },
    ];

    const widget = await findWidget(page);
    log(widget ? `TradingView widget found (window.${widget.name})` : 'TradingView widget not exposed on the page - will use the UI');

    const report = [];
    let allDrawn = true;
    for (const side of plan) {
      let drawn = 0;
      let note = '';

      // preferred: widget API
      if (widget) {
        const res = await drawViaApi(widget, side, side.levels);
        log(`  API ${side.name}: drawn=${res.drawn} | charts=${JSON.stringify(res.seen)} | errors=${JSON.stringify(res.errors)}`);
        drawn = res.drawn;
        if (!drawn) note = `API: ${(res.errors[0] || 'nothing drawn').slice(0, 90)}`;
      }

      // fallback: drive the UI (only when the API drew nothing, so no duplicates)
      if (drawn === 0) {
        log(`  Drawing ${side.levels.length} ${side.name} lines through the UI...`);
        const used = [];
        const pairs = [];
        let firstFail = null;
        for (const lv of side.levels) {
          log(`  ${side.name}: ${lv.label} @ ${lv.price}`);
          const r = await drawLineUI(page, side.pane, lv, used, pairs);
          if (r.ok) {
            used.push(lv.price);
            drawn++;
          } else {
            log(`  ${side.name}: FAILED ${lv.label} @ ${lv.price} at stage "${r.stage}": ${r.detail}`);
            if (!firstFail) firstFail = r;
          }
        }
        note = firstFail ? `failed at "${firstFail.stage}": ${firstFail.detail}` : '';
      }

      if (drawn < side.levels.length) allDrawn = false;
      report.push(`${side.name} ${side.strike}: ${drawn}/${side.levels.length} lines${note ? ` (${note})` : ''}`);
    }

    if (!allDrawn) await dumpDebug(page, 'lines-partial');
    const detail = report.join('\n');
    return {
      summary: allDrawn
        ? `✅ Dhan charts ready.\n${detail}`
        : `⚠️ Some lines could not be drawn.\n${detail}\n<i>Details: dhan-debug/last-run.log and the screenshots in dhan-debug</i>`,
    };
  } catch (e) {
    await dumpDebug(page, 'error');
    throw e;
  }
}

module.exports = {
  drawLinesOnDhan,
  _test: { drawLineUI, drawViaApi, findWidget, locateSettingsDialog, getPanes, parseExpiry, optionQueries, optionPaneVerifier, optionRowMatcher, buildLevels, isThreeColumns, hexToRgb },
};
