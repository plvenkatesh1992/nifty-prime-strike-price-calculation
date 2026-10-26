// Quick test of the Dhan drawing WITHOUT Telegram.
//   node dhan-test.js                      -> uses the defaults below
//   node dhan-test.js 27-Oct-2026 22500 22600
// Edit the sample levels so they sit inside the price range visible on each chart.
const { drawLinesOnDhan } = require('./dhan-draw');

const [expiry = '27-Oct-2026', callStrike = '22500', putStrike = '22600'] = process.argv.slice(2);

drawLinesOnDhan({
  expiry,
  call: { strike: Number(callStrike), greenLine: 200, orangeLine: 180, blackLine: 150, blueLines: [230, 250, 270] },
  put: { strike: Number(putStrike), greenLine: 100, orangeLine: 90, blackLine: 80, blueLines: [105, 110, 115] },
  notify: async (text) => console.log('[notify]', text.replace(/<[^>]+>/g, '')),
})
  .then((r) => console.log('\nRESULT:', r.summary.replace(/<[^>]+>/g, '')))
  .catch((e) => console.error('\nFAILED:', e.message));
// the browser stays open so you can look at the charts; press Ctrl+C to quit
