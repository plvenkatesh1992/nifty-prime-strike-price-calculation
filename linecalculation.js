/**
 * Calculates the Color Line Levels for Call and Put based on Spot price and JSON data.
 * @param {number} spotPrice - The spot price (e.g., 22523 or 22500)
 * @param {Array<Object>} levelsData - The array of levels objects from the JSON file
 * @returns {Object} Calculated line levels for both CALL and PUT
 */
function calculateColorLevels(spotPrice, levelsData) {
  // 1. Determine Strikes
  const callStrike = Math.floor(spotPrice / 100) * 100;
  const putStrike = callStrike + 100;

  // 2. Extract price pools across all strikes
  const allCallPrices = levelsData
    .map((item) => item.callSettlementPrice)
    .filter((p) => typeof p === 'number' && !isNaN(p));

  const allPutPrices = levelsData
    .map((item) => item.putSettlementPrice)
    .filter((p) => typeof p === 'number' && !isNaN(p));

  // 3. Locate selected strike data
  const callRow = levelsData.find((item) => item.strike === callStrike);
  const putRow = levelsData.find((item) => item.strike === putStrike);

  if (!callRow || !putRow) {
    throw new Error(`Strike data not found for Call (${callStrike}) or Put (${putStrike}) in the provided dataset.`);
  }

  // --- Helper: Black Line (Nearest strictly lower value from opposite pool) ---
  const getBlackLine = (greenPrice, oppositePool) => {
    const lowerValues = oppositePool
      .filter((p) => p < greenPrice)
      .sort((a, b) => b - a); // Descending: first item is highest of the lowers (nearest low)

    return lowerValues.length > 0 ? lowerValues[0] : 'N/A';
  };

  // --- Helper: Blue Lines (Next 3 strictly higher values from opposite pool, padded with 'N/A') ---
  const getBlueLines = (greenPrice, oppositePool) => {
    const higherValues = oppositePool
      .filter((p) => p > greenPrice)
      .sort((a, b) => a - b); // Ascending: nearest highs first

    const targets = higherValues.slice(0, 3);
    while (targets.length < 3) {
      targets.push('N/A');
    }
    return targets;
  };

  // 4. Derive Call Lines (Cross-references Put prices)
  const callGreen = callRow.callSettlementPrice;
  const callOrange = callRow.primeLevel;
  const callBlack = getBlackLine(callGreen, allPutPrices);
  const callBlue = getBlueLines(callGreen, allPutPrices);

  // 5. Derive Put Lines (Cross-references Call prices)
  const putGreen = putRow.putSettlementPrice;
  const putOrange = putRow.primeLevel;
  const putBlack = getBlackLine(putGreen, allCallPrices);
  const putBlue = getBlueLines(putGreen, allCallPrices);

  const data = {
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
  // console.log(data);
  console.log(formatColorLevelsTelegramMessage(data, 22523, '09-Oct-2026'));
}

/**
 * Formats the color line levels into a clean, modern HTML message for Telegram
 * with clear visual separation between Call and Put sections.
 * @param {Object} data - Output object from calculateColorLevels()
 * @param {number} spotPrice - Spot price used for calculation
 * @param {string} tradeDate - Optional settlement/trade date string (e.g., '09-Oct-2026')
 * @returns {string} HTML-formatted string ready for Telegram sendMessage
 */
function formatColorLevelsTelegramMessage(data, spotPrice, tradeDate = null) {
  const { call, put } = data;

  const formatTargets = (targets) => {
    return targets
      .map((val, idx) => `<b>T${idx + 1}:</b> <code>${val}</code>`)
      .join('  |  ');
  };

  let message = `🎯 <b><u>NIFTY CALL/PUT KEY LEVELS ANALYSIS</u></b>\n\n`;

  if (tradeDate) {
    message += `📅 <b>Trade Date:</b> ${tradeDate}\n`;
  }
  message += `🔹 <b>Spot Price:</b> ${spotPrice}\n`;
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
// Example Usage with your provided dataset:
// ---------------------------------------------------------------------------
const sampleLevels = [
  { strike: 22900, callSettlementPrice: 10, putSettlementPrice: 345, total: 355, primeLevel: 178 },
  { strike: 22800, callSettlementPrice: 22, putSettlementPrice: 260, total: 282, primeLevel: 141 },
  { strike: 22700, callSettlementPrice: 45, putSettlementPrice: 182, total: 227, primeLevel: 114 },
  { strike: 22600, callSettlementPrice: 83, putSettlementPrice: 120, total: 203, primeLevel: 102 },
  { strike: 22500, callSettlementPrice: 138, putSettlementPrice: 76, total: 214, primeLevel: 107 },
  { strike: 22400, callSettlementPrice: 210, putSettlementPrice: 47, total: 257, primeLevel: 129 },
  { strike: 22300, callSettlementPrice: 292, putSettlementPrice: 30, total: 322, primeLevel: 161 },
  { strike: 22200, callSettlementPrice: 381, putSettlementPrice: 19, total: 400, primeLevel: 200 },
  { strike: 22100, callSettlementPrice: 475, putSettlementPrice: 13, total: 488, primeLevel: 244 },
];

calculateColorLevels(22523, sampleLevels);

