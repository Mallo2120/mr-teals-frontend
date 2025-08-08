/* Mr. Teals Dashboard App (Teal & Graphite Theme)
   Handles API interactions with fallback, chart rendering, watchlist & modal.
*/

const API_BASE = window.MR_TEALS_API ?? 'https://mr-teals-backend.onrender.com';
const REQUEST_TIMEOUT_MS = 4500;

// Respect reduced motion preference
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Element references
const el = {
  realizedPL: document.getElementById('realizedPL'),
  realizedPLSub: document.getElementById('realizedPLSub'),
  unrealizedPL: document.getElementById('unrealizedPL'),
  unrealizedPLSub: document.getElementById('unrealizedPLSub'),
  tradesToday: document.getElementById('tradesToday'),
  tradesTodaySub: document.getElementById('tradesTodaySub'),
  snapEquity: document.getElementById('snapEquity'),
  snapCash: document.getElementById('snapCash'),
  snapPositions: document.getElementById('snapPositions'),
  equityEmpty: document.getElementById('equityEmpty'),
  chips: Array.from(document.querySelectorAll('.range-chips .chip')).filter(c=>!c.closest('.range-chips.mini')),
  equityCanvas: document.getElementById('equityChart'),
  settingsForm: document.getElementById('settingsForm'),
  strategy: document.getElementById('strategy'),
  watchlist: document.getElementById('watchlist'),
  modal: document.getElementById('cryptoModal'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalClose: document.getElementById('modalClose'),
  modalTitle: document.getElementById('cryptoTitle'),
  modalPrice: document.getElementById('modalPrice'),
  modalChange: document.getElementById('modalChange'),
  modalMcap: document.getElementById('modalMcap'),
  modalSupply: document.getElementById('modalSupply'),
  miniCanvas: document.getElementById('miniChart'),
  toastContainer: document.getElementById('toastContainer'),
  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  btnKill: document.getElementById('btnKill'),
  btnReset: document.getElementById('btnReset'),
  themeToggle: document.getElementById('themeToggle'),
  addSymbolInput: document.getElementById('addSymbolInput'),
  addSymbolButton: document.getElementById('addSymbolButton')
  , tradeLog: document.getElementById('tradeLog')
  , tradeEmpty: document.getElementById('tradeEmpty')
  , manualTradeForm: document.getElementById('manualTradeForm'),
  tradeSymbol: document.getElementById('tradeSymbol'),
  tradeSide: document.getElementById('tradeSide'),
  tradeQty: document.getElementById('tradeQty')
};

// Timer for periodic updates when bot is running
let updateTimer = null;

// Strategy engine state. The strategy will run a simple moving average crossover on the
// watchlist symbols. When running, it periodically fetches live prices, computes
// short and long moving averages, and executes trades via the backend if crossovers occur.
let strategyRunning = false;
let strategyInterval = null;
// For each symbol, strategyState tracks price history and whether we currently hold a position.
let strategyState = {};
// For each symbol, botPositions tracks the quantity currently held. This mirrors
// backend positions for the purposes of deciding sell sizes. It is updated when
// we successfully execute trades via the API.
let botPositions = {};

/**
 * Start the local simulation loop. This sets the running flag, resets the
 * simulation state using current settings and watchlist, then schedules
 * repeated calls to `simulateStep()`. Each step will update prices, PnL,
 * trade log and refresh the UI. If a previous simulation loop was running
 * it is cleared before scheduling a new one.
 */
function startSimulation() {
  // If the simulation is already running, do nothing.
  if(simRunning) return;
  simRunning = true;
  // Clear any existing interval
  if(simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
  // Prime with one step and schedule periodic updates
  simulateStep();
  simInterval = setInterval(() => {
    if(simRunning) {
      simulateStep();
    }
  }, 5000);
}

/**
 * Stop the local simulation loop. This clears the interval and marks the
 * simulation as not running. The current state is preserved so that
 * equity, positions and trade logs remain visible until the next start.
 */
function stopSimulation() {
  simRunning = false;
  if(simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
}

/**
 * Reset the simulation state to initial conditions without starting it.
 * This stops any running simulation and clears positions, cash, PnL and
 * trade history. It also reinitialises the watchlist prices.
 */
function resetSimulation() {
  stopSimulation();
  initSimulation();
}

/**
 * Execute a manual trade in the simulation. Allows the user to buy or sell
 * a specific quantity of a symbol. Updates cash, positions, realized PnL
 * and trade log accordingly. If the simulator is not running, it will
 * still execute the trade based on the current watchlist price.
 * @param {string} symbol
 * @param {string} side 'BUY' or 'SELL'
 * @param {number} qty  quantity of the asset to trade
 */
function executeManualTrade(symbol, side, qty) {
  if(!symbol || !qty || qty <= 0) return;
  // Execute trade via backend
  manualTradeAPI(symbol, side, qty).then(success => {
    if(success) {
      // Update local botPositions map
      if(side === 'BUY') {
        botPositions[symbol] = (botPositions[symbol] || 0) + qty;
      } else {
        botPositions[symbol] = Math.max(0, (botPositions[symbol] || 0) - qty);
      }
      // Refresh UI
      loadSnapshot();
      loadPerformance();
      loadTradeLog();
      loadWatchlist();
    }
  });
}

/**
 * Initialize simulation state based on current settings and watchlist.
 */
function initSimulation() {
  const payload = getSettingsPayload();
  simInitialBalance = payload.initialBalance;
  simCash = simInitialBalance;
  simPositions = {};
  simRealizedPnl = 0;
  simUnrealizedPnl = 0;
  simEquityHistory = [];
  simTradeLog = [];
  // Initialize watchlist prices from existing list or fallback
  if(el.watchlist.children.length > 0) {
    simWatchlist = Array.from(el.watchlist.children).map(li => {
      const spans = li.querySelectorAll('span');
      const symbol = spans[0].textContent.trim();
      const priceText = spans[1].textContent.replace(/[$,]/g, '');
      const price = parseFloat(priceText) || 100; // default fallback
      return { symbol, price, changePct: 0 };
    });
  } else {
    simWatchlist = fakeWatchlist().map(item => ({ symbol: item.symbol, price: item.price, changePct: item.changePct }));
  }
  // Reset equity chart to flat line at initial balance
  simEquityHistory.push({ x: new Date(), y: simInitialBalance });
  buildEquityChart(simEquityHistory);
  // Update UI snapshot
  applySnapshot({ equity: simInitialBalance, cash: simCash, positions: 0 });
  applyPerformance({ realized: 0, unrealized: 0, trades: 0 });
  renderTradeLog(simTradeLog);
}

/**
 * Perform one simulation step: update prices, maybe execute a trade, update PnL and UI.
 */
async function simulateStep() {
  // Attempt to fetch live prices from Coingecko; if that fails, use random drift
  let livePrices = null;
  try {
    livePrices = await fetchLivePrices(simWatchlist.map(i => i.symbol));
  } catch {}
  simWatchlist.forEach(item => {
    if(livePrices && livePrices[item.symbol] != null) {
      const oldPrice = item.price;
      item.price = livePrices[item.symbol];
      const change = item.price - oldPrice;
      item.changePct = (change / oldPrice) * 100;
    } else {
      // Fallback: random drift if no live price available
      const drift = (Math.random() - 0.5) * 0.01 * item.price;
      item.price += drift;
      item.changePct = (drift / item.price) * 100;
    }
  });
  // Possibly execute a trade (50% chance)
  if(Math.random() < 0.5) {
    const idx = Math.floor(Math.random() * simWatchlist.length);
    const symObj = simWatchlist[idx];
    const symbol = symObj.symbol;
    const price = symObj.price;
    const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
    const settings = getSettingsPayload();
    const posPct = settings.positionSizePct / 100;
    const qtyValue = simCash * posPct;
    if(side === 'BUY' && qtyValue > 0) {
      const qty = qtyValue / price;
      simCash -= qty * price;
      // Update positions
      if(simPositions[symbol]) {
        const pos = simPositions[symbol];
        const totalCost = pos.qty * pos.avgCost + qty * price;
        pos.qty += qty;
        pos.avgCost = totalCost / pos.qty;
      } else {
        simPositions[symbol] = { qty, avgCost: price };
      }
      simTradeLog.push({ time: new Date().toISOString().slice(0,19).replace('T',' '), symbol, side:'BUY', qty: qty.toFixed(3), price: price.toFixed(2) });
    } else if(side === 'SELL') {
      const pos = simPositions[symbol];
      if(pos && pos.qty > 0) {
        const qty = pos.qty;
        simCash += qty * price;
        simRealizedPnl += qty * (price - pos.avgCost);
        simTradeLog.push({ time: new Date().toISOString().slice(0,19).replace('T',' '), symbol, side:'SELL', qty: qty.toFixed(3), price: price.toFixed(2) });
        delete simPositions[symbol];
      }
    }
  }
  // Update unrealized PnL and positions value
  simUnrealizedPnl = 0;
  let positionsValue = 0;
  Object.keys(simPositions).forEach(sym => {
    const pos = simPositions[sym];
    const currentPrice = simWatchlist.find(item => item.symbol === sym)?.price || pos.avgCost;
    positionsValue += pos.qty * currentPrice;
    simUnrealizedPnl += pos.qty * (currentPrice - pos.avgCost);
  });
  const equity = simCash + positionsValue;
  simEquityHistory.push({ x: new Date(), y: equity });
  // Limit equity history for 5m range to last 60 points
  if(simEquityHistory.length > 60) {
    simEquityHistory.shift();
  }
  // Apply UI updates
  applyPerformance({ realized: simRealizedPnl, unrealized: simUnrealizedPnl, trades: simTradeLog.length });
  applySnapshot({ equity, cash: simCash, positions: positionsValue });
  renderTradeLog(simTradeLog);
  renderWatchlist(simWatchlist);
  buildEquityChart(simEquityHistory);
}

/**
 * Start periodic updates of performance, snapshot, equity and watchlist.
 * This runs every 5 seconds until stopped.
 */
function startUpdates() {
  stopUpdates();
  updateTimer = setInterval(() => {
    // Poll the backend for fresh data
    loadPerformance();
    loadSnapshot();
    // Load equity chart range using the active chip's dataset.range
    const activeChip = document.querySelector('.range-chips .chip.active');
    const range = activeChip ? activeChip.dataset.range : '1M';
    loadEquity(range);
    loadWatchlist();
    loadTradeLog();
  }, 5000);
}

/**
 * Stop the periodic update interval.
 */
function stopUpdates() {
  if(updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

/* --------------------------------------------------------------------------
   Utilities
--------------------------------------------------------------------------- */
function toast(message, type='success', ms=3000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  el.toastContainer.appendChild(t);
  const timeout = setTimeout(() => {
    t.remove();
  }, ms);
  t.addEventListener('click', () => {
    clearTimeout(timeout);
    t.remove();
  });
}
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}
async function getJSON(url, opts = {}) {
  try {
    const res = await withTimeout(fetch(url, { headers: { 'Accept': 'application/json' }, ...opts }), REQUEST_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw e;
  }
}
async function postJSON(url, body) {
  try {
    const res = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body || {})
    }), REQUEST_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(() => ({}));
  } catch (e) {
    throw e;
  }
}
function fmtUSD(num) {
  const sign = num < 0 ? '-' : '';
  const val = Math.abs(num);
  return `${sign}$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(p) {
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/* --------------------------------------------------------------------------
   Price Fetching and Trade Helpers
--------------------------------------------------------------------------- */
/**
 * Fetch current USD prices for a list of symbols from the backend. If the backend
 * cannot provide a price for a symbol, that entry will be undefined in the
 * returned object. Symbols should be in the format "BTC/USD".
 * @param {string[]} symbols
 * @returns {Promise<Object>} mapping of symbol -> price
 */
async function fetchPrices(symbols) {
  if(!symbols || symbols.length === 0) return {};
  const q = symbols.map(s => s.trim().toUpperCase()).join(',');
  try {
    return await getJSON(`${API_BASE}/api/prices?symbols=${encodeURIComponent(q)}`);
  } catch {
    return {};
  }
}

/**
 * Execute a manual trade via the backend. Returns true if successful.
 * Quantity should be a positive number. Side must be BUY or SELL.
 * @param {string} symbol
 * @param {string} side
 * @param {number} qty
 * @returns {Promise<boolean>}
 */
async function manualTradeAPI(symbol, side, qty) {
  try {
    const url = `${API_BASE}/api/trade?symbol=${encodeURIComponent(symbol)}&side=${side}&quantity=${qty}`;
    const res = await postJSON(url, {});
    if(res && !res.error) {
      return true;
    } else {
      toast(res.error || 'Trade failed', 'warn', 2400);
      return false;
    }
  } catch {
    toast('Trade request failed', 'warn', 2400);
    return false;
  }
}

/**
 * Reset the paper account via the backend. Optionally accepts a new starting balance.
 * After resetting, the UI will reload snapshot, performance and trade log.
 * @param {number|null} balance
 */
async function resetAccount(balance = null) {
  try {
    const url = balance != null ? `${API_BASE}/api/reset?balance=${balance}` : `${API_BASE}/api/reset`;
    await postJSON(url, {});
    // Reload state after reset
    await loadSnapshot();
    await loadPerformance();
    await loadTradeLog();
    await loadWatchlist();
    toast('Account reset', 'info', 2000);
    // Clear strategy state
    strategyState = {};
    botPositions = {};
  } catch {
    toast('Reset failed', 'warn', 2400);
  }
}

/* --------------------------------------------------------------------------
   Strategy Engine (Moving Average Crossover)
--------------------------------------------------------------------------- */
/**
 * Start the trading strategy. This function fetches the current watchlist from the backend
 * and then periodically (every 5 seconds) fetches live prices, computes moving averages
 * and executes trades based on a simple crossover rule. Short window = 3, long window = 6.
 */
async function startStrategy() {
  if(strategyRunning) return;
  strategyRunning = true;
  // Initialize state for each watchlist symbol
  try {
    const res = await getJSON(`${API_BASE}/api/watchlist`);
    const list = Array.isArray(res) ? res : res?.watchlist || [];
    list.forEach(sym => {
      const s = sym.trim().toUpperCase();
      strategyState[s] = { history: [], isLong: false };
      if(!botPositions[s]) botPositions[s] = 0;
    });
  } catch {
    // On failure, do nothing
  }
  // Poll every 5 seconds
  strategyInterval = setInterval(async () => {
    const symbols = Object.keys(strategyState);
    if(symbols.length === 0) return;
    const prices = await fetchPrices(symbols);
    // Fetch current snapshot once per iteration for position sizing
    let snapshot;
    try {
      snapshot = await getJSON(`${API_BASE}/api/account/snapshot`);
    } catch {
      snapshot = null;
    }
    symbols.forEach(sym => {
      const state = strategyState[sym];
      const price = prices[sym];
      if(!price) return;
      state.history.push(price);
      // Keep last 6 prices
      if(state.history.length > 6) state.history.shift();
      if(state.history.length >= 6) {
        const shortArr = state.history.slice(-3);
        const longArr = state.history.slice(-6);
        const shortMA = shortArr.reduce((a,b) => a+b, 0) / shortArr.length;
        const longMA = longArr.reduce((a,b) => a+b, 0) / longArr.length;
        if(!state.isLong && shortMA > longMA) {
          // Enter long position using 10% of available cash
          const cash = snapshot ? snapshot.cash : 0;
          const qty = cash * 0.1 / price;
          if(qty > 0) {
            manualTradeAPI(sym, 'BUY', qty).then(ok => {
              if(ok) {
                state.isLong = true;
                botPositions[sym] = (botPositions[sym] || 0) + qty;
              }
            });
          }
        } else if(state.isLong && shortMA < longMA) {
          // Exit position completely
          const qty = botPositions[sym] || 0;
          if(qty > 0) {
            manualTradeAPI(sym, 'SELL', qty).then(ok => {
              if(ok) {
                state.isLong = false;
                botPositions[sym] = 0;
              }
            });
          }
        }
      }
    });
    // After trades, refresh UI
    loadPerformance();
    loadSnapshot();
    loadTradeLog();
    loadWatchlist();
  }, 5000);
}

function stopStrategy() {
  strategyRunning = false;
  if(strategyInterval) {
    clearInterval(strategyInterval);
    strategyInterval = null;
  }
}

/* --------------------------------------------------------------------------
   Live Price Fetching (Coingecko API)
--------------------------------------------------------------------------- */
// Map our symbol format to Coingecko coin IDs. Extend this as you add more
// symbols to your watchlist. For unsupported symbols the fetch will fall back
// to random drift.
const COINGECKO_IDS = {
  'BTC/USD': 'bitcoin',
  'ETH/USD': 'ethereum',
  'SOL/USD': 'solana',
  'DOT/USD': 'polkadot',
  'DOGE/USD': 'dogecoin'
};

async function fetchLivePrices(symbols) {
  // Construct a list of IDs to fetch
  const ids = symbols.map(sym => COINGECKO_IDS[sym] || '').filter(Boolean);
  if(ids.length === 0) {
    return null;
  }
  const uniqueIds = Array.from(new Set(ids)).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${uniqueIds}&vs_currencies=usd`;
  try {
    const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    // Map back to symbol->price objects
    const result = {};
    symbols.forEach(sym => {
      const id = COINGECKO_IDS[sym];
      if(id && json[id] && json[id].usd != null) {
        result[sym] = json[id].usd;
      }
    });
    return result;
  } catch(err) {
    console.warn('Live price fetch failed:', err.message);
    return null;
  }
}

/* --------------------------------------------------------------------------
   Fake Data Generators
--------------------------------------------------------------------------- */
const RANGES = ['1D','1W','1M','3M','YTD','1Y','5Y','ALL'];
function generateSeries(points=240, startVal=10000, drift=0.02, vol=0.8) {
  const out = [];
  let v = startVal;
  const now = Date.now();
  const spanMs = 1000*60*60*24*180; // ~6 months
  for(let i=points-1; i>=0; i--) {
    const t = now - (spanMs/points)*i;
    const shock = (Math.random()-0.5)*vol;
    v = Math.max(100, v * (1 + drift/points + shock/100));
    out.push({ t, v });
  }
  return out;
}
function rangeToPoints(range) {
  switch(range) {
    case '5m':
    case '5M':
      return 30; // 30 points for 5 minutes (approx one point every 10 seconds)
    case '1D': return 288; // 5 min
    case '1W': return 7*96; // 15 min
    case '1M': return 900;
    case '3M': return 900;
    case 'YTD': return 1000;
    case '1Y': return 1100;
    case '5Y': return 1500;
    case 'ALL': return 1800;
    default: return 900;
  }
}
function fakeEquity(range='1M') {
  // Return a flat line at a constant initial value (e.g. $10,000) when no real data is available.
  const pts = rangeToPoints(range);
  const initial = 10000;
  const out = [];
  const now = Date.now();
  // Distribute points over a 6-month span for chart spacing
  const spanMs = 1000 * 60 * 60 * 24 * 180;
  for (let i = pts - 1; i >= 0; i--) {
    const t = now - (spanMs / pts) * i;
    out.push({ x: new Date(t), y: initial });
  }
  return out;
}
function fakePerformanceToday() {
  const realized = (Math.random()-0.3) * 400;
  const unrealized = (Math.random()-0.5) * 600;
  const trades = Math.floor(Math.random()*12);
  return { realized, unrealized, trades, realizedNote:'From closed positions', unrealizedNote:'Open positions P&L' };
}
function fakeSnapshot() {
  const equity = 12000 + Math.random()*6000;
  const cash = equity * (0.35 + Math.random()*0.25);
  const positions = equity - cash;
  return { equity, cash, positions };
}
function fakeWatchlist() {
  const base = [
    { symbol:'BTC/USD', price: 60000 + Math.random()*8000 },
    { symbol:'ETH/USD', price: 2800 + Math.random()*400 },
    { symbol:'SOL/USD', price: 120 + Math.random()*30 }
  ];
  return base.map(b => {
    const chg = (Math.random()-0.5)*8;
    return { ...b, changePct: chg };
  });
}
function fakeCryptoDetails(symbol) {
  const price = 100 + Math.random()*50000;
  const changePct = (Math.random()-0.5)*12;
  const mcap = (Math.random()*500 + 50)*1e9;
  const supply = (Math.random()*400 + 50)*1e6;
  const facts = [
    `${symbol} trades 24/7 across global venues.`,
    `High liquidity with tight spreads on major exchanges.`,
    `Volatility can exceed traditional assets.`,
    `Often used as a risk-on sentiment indicator.`,
    `Network fees vary by congestion.`,
    `Custody and security practices are critical.`,
    `Derivatives volume rivals spot on some days.`,
    `Regulatory treatment varies by region.`
  ].slice(0, 5 + Math.floor(Math.random()*3));
  return { price, changePct, marketCap:mcap, supply, facts };
}

/* --------------------------------------------------------------------------
   Chart Builders
--------------------------------------------------------------------------- */
let equityChart, miniChart;
const chartOptionsBase = (label='Equity') => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: prefersReduced ? false : { duration: 250 },
  scales: {
    x: {
      type: 'time',
      time: { tooltipFormat: 'MMM d, HH:mm' },
      grid: { color:'rgba(255,255,255,.06)' },
      ticks:{ color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary') }
    },
    y: {
      beginAtZero: false,
      grid: { color:'rgba(255,255,255,.06)' },
      ticks: {
        callback: v => '$' + Number(v).toLocaleString(),
        color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary')
      }
    }
  },
  plugins: {
    legend: { display:false },
    tooltip: {
      mode:'index', intersect:false,
      callbacks: {
        label: ctx => {
          const val = ctx.parsed.y;
          const prev = ctx.dataset.data[Math.max(0, ctx.dataIndex-1)]?.y ?? val;
          const delta = val - prev;
          return ` ${label}: ${fmtUSD(val)} (Δ ${fmtUSD(delta)})`;
        }
      }
    }
  }
});
function buildEquityChart(data) {
  if(equityChart) equityChart.destroy();
  const ctx = el.equityCanvas.getContext('2d');
  equityChart = new Chart(ctx, {
    type:'line',
    data:{ datasets:[{ label:'Equity', data, borderColor:getComputedStyle(document.documentElement).getPropertyValue('--accent'), borderWidth:1.8, tension:0.25, pointRadius:0, fill:false }]},
    options: chartOptionsBase('Equity')
  });
  const ys = data.map(d => d.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  equityChart.options.scales.y.suggestedMin = min - (max-min)*0.08;
  equityChart.options.scales.y.suggestedMax = max + (max-min)*0.08;
  equityChart.update();
}
function buildMiniChart(data) {
  if(miniChart) miniChart.destroy();
  const ctx = el.miniCanvas.getContext('2d');
  miniChart = new Chart(ctx, {
    type:'line',
    data:{ datasets:[{ label:'Price', data, borderColor:getComputedStyle(document.documentElement).getPropertyValue('--accent'), borderWidth:1.6, tension:0.25, pointRadius:0, fill:false }]},
    options: chartOptionsBase('Price')
  });
  const ys = data.map(d => d.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  miniChart.options.scales.y.suggestedMin = min - (max-min)*0.08;
  miniChart.options.scales.y.suggestedMax = max + (max-min)*0.08;
  miniChart.update();
}

/* --------------------------------------------------------------------------
   Load and Apply Data
--------------------------------------------------------------------------- */
async function loadPerformance() {
  try {
    const data = await getJSON(`${API_BASE}/api/performance/today`);
    applyPerformance(data);
  } catch {
    const fake = fakePerformanceToday();
    applyPerformance(fake);
    toast('Using sample performance data', 'warn', 2500);
  }
}
function applyPerformance({ realized, unrealized, trades, realizedNote, unrealizedNote }) {
  el.realizedPL.textContent = fmtUSD(realized || 0);
  el.unrealizedPL.textContent = fmtUSD(unrealized || 0);
  el.tradesToday.textContent = trades || 0;
  const realizedHint = realized >= 0 ? 'Gain' : 'Loss';
  const unrealizedHint = unrealized >= 0 ? 'Gain' : 'Loss';
  el.realizedPLSub.textContent = `${realizedHint}${realizedNote ? ` — ${realizedNote}` : ''}`;
  el.unrealizedPLSub.textContent = `${unrealizedHint}${unrealizedNote ? ` — ${unrealizedNote}` : ''}`;
  el.tradesTodaySub.textContent = trades > 0 ? 'Active day' : 'Quiet so far';
}
async function loadSnapshot() {
  try {
    const snap = await getJSON(`${API_BASE}/api/account/snapshot`);
    applySnapshot(snap);
  } catch {
    applySnapshot(fakeSnapshot());
    toast('Using sample account snapshot', 'warn', 2200);
  }
}
function applySnapshot({ equity, cash, positions }) {
  el.snapEquity.textContent = fmtUSD(equity);
  el.snapCash.textContent = fmtUSD(cash);
  el.snapPositions.textContent = fmtUSD(positions);
}
async function loadEquity(range='1M') {
  // When simulation is running, display the simulated equity series instead of
  // fetching from the backend. This ensures the chart reflects trades
  // performed locally and avoids mixing in server values.
  if(simRunning) {
    if(simEquityHistory.length) {
      buildEquityChart(simEquityHistory);
      el.equityEmpty.hidden = true;
    } else {
      // No simulation data yet; show initial flat line
      const data = fakeEquity(range);
      buildEquityChart(data);
      el.equityEmpty.hidden = false;
    }
    return;
  }
  try {
    const res = await getJSON(`${API_BASE}/api/performance/today?range=${encodeURIComponent(range)}`);
    const data = (res?.series || []).map(d => ({ x: new Date(d.t), y: d.v }));
    if(!data.length) {
      el.equityEmpty.hidden = false;
      buildEquityChart(fakeEquity(range));
      el.equityEmpty.hidden = true;
    } else {
      el.equityEmpty.hidden = true;
      buildEquityChart(data);
    }
  } catch {
    const data = fakeEquity(range);
    el.equityEmpty.hidden = false;
    buildEquityChart(data);
    el.equityEmpty.hidden = true;
    toast('Using sample equity data', 'warn', 2200);
  }
}
async function loadWatchlist() {
  // If simulation is running, use the simulated watchlist
  if(simRunning && simWatchlist.length) {
    renderWatchlist(simWatchlist);
    return;
  }
  let list;
  try {
    const res = await getJSON(`${API_BASE}/api/watchlist`);
    list = Array.isArray(res) ? res : res?.watchlist ?? res?.items;
    if(!list || !list.length) throw new Error('empty');
  } catch {
    list = [];
  }
  if(!list || list.length === 0) {
    // If no backend list, fall back to existing watchlist DOM entries
    const current = [];
    el.watchlist.querySelectorAll('.wl-row span:first-child').forEach(span => current.push(span.textContent.trim()));
    list = current;
  }
  // Fetch live prices for watchlist symbols
  const priceMap = await fetchPrices(list);
  const items = list.map(sym => {
    const price = priceMap[sym];
    return { symbol: sym, price: price || 0, changePct: 0 };
  });
  renderWatchlist(items);
}
function renderWatchlist(items) {
  el.watchlist.innerHTML = '';
  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'wl-row';
    li.setAttribute('role','option');
    li.setAttribute('tabindex','0');
    const chgClass = item.changePct >= 0 ? 'chg-pos' : 'chg-neg';
    li.innerHTML = `
      <span>${item.symbol}</span>
      <span>${fmtUSD(item.price)}</span>
      <span class="${chgClass}">${fmtPct(item.changePct)}</span>
      <span aria-hidden="true">›</span>
    `;
    li.addEventListener('click', () => openCryptoModal(item.symbol));
    li.addEventListener('keypress', (e) => {
      if(e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openCryptoModal(item.symbol);
      }
    });
    el.watchlist.appendChild(li);
  });
  // Update manual trade symbol options to include current watchlist symbols
  if(el.tradeSymbol) {
    // Clear existing options
    el.tradeSymbol.innerHTML = '';
    items.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.symbol;
      opt.textContent = item.symbol;
      el.tradeSymbol.appendChild(opt);
    });
  }
}

/* --------------------------------------------------------------------------
   Trade Log
--------------------------------------------------------------------------- */
function fakeTradeLog() {
  const symbols = ['BTC/USD','ETH/USD','SOL/USD'];
  const sides = ['BUY','SELL'];
  return Array.from({ length: 10 }, () => {
    return {
      time: new Date(Date.now() - Math.random()*300000).toISOString().slice(0,19).replace('T',' '),
      symbol: symbols[Math.floor(Math.random()*symbols.length)],
      side: sides[Math.floor(Math.random()*sides.length)],
      qty: (Math.random()*0.5 + 0.1).toFixed(3),
      price: (Math.random()*50000 + 1000).toFixed(2)
    };
  });
}
async function loadTradeLog() {
  // If our simulation is running, use the simulated trade log instead of
  // fetching from the backend. This gives an immediate sense of activity
  // without relying on a live trading engine.
  if(simRunning && simTradeLog.length) {
    renderTradeLog(simTradeLog);
    return;
  }
  let trades;
  try {
    // Try to fetch from the backend. Some backends expose /api/trades or
    // return a structure with an "items" array.
    const res = await getJSON(`${API_BASE}/api/trades/last`);
    // Backend returns a single trade object. Wrap it in an array if needed.
    if(res && res.time) {
      trades = [res];
    } else {
      trades = Array.isArray(res) ? res : res?.items;
    }
    if(!trades || !trades.length) throw new Error('empty');
  } catch {
    // When no data from the server, use sample logs so the UI stays populated.
    trades = fakeTradeLog();
  }
  renderTradeLog(trades);
}
function renderTradeLog(trades) {
  el.tradeLog.innerHTML = '';
  const emptyEl = document.getElementById('tradeEmpty');
  if(!trades || trades.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  trades.forEach(tr => {
    const li = document.createElement('li');
    const sideClass = (tr.side || '').toUpperCase() === 'BUY' ? 'side-buy' : 'side-sell';
    // Calculate cost of trade (quantity * price) if available
    const qtyNum = Number(tr.qty);
    const priceNum = Number(tr.price);
    const cost = (qtyNum && priceNum) ? qtyNum * priceNum : null;
    li.innerHTML = `
      <span>${tr.time}</span>
      <span>${tr.symbol}</span>
      <span class="${sideClass}">${tr.side}</span>
      <span>${tr.qty}</span>
      <span>$${Number(tr.price).toLocaleString()}</span>
      <span>${cost !== null ? '$' + cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</span>
    `;
    el.tradeLog.appendChild(li);
  });
}

/* --------------------------------------------------------------------------
   Crypto Modal
--------------------------------------------------------------------------- */
let currentSymbol = null;
async function openCryptoModal(symbol) {
  currentSymbol = symbol;
  el.modalTitle.textContent = symbol;
  let details;
  try {
    const res = await getJSON(`${API_BASE}/api/crypto?symbol=${encodeURIComponent(symbol)}`);
    details = res;
  } catch {
    details = fakeCryptoDetails(symbol);
  }
  el.modalPrice.textContent = fmtUSD(details.price);
  el.modalChange.textContent = fmtPct(details.changePct);
  el.modalChange.className = 'val ' + (details.changePct >= 0 ? 'chg-pos' : 'chg-neg');
  el.modalMcap.textContent = '$' + Math.round(details.marketCap).toLocaleString();
  el.modalSupply.textContent = Math.round(details.supply).toLocaleString();
  // build mini chart
  const miniData = fakeEquity('1M');
  buildMiniChart(miniData);
  // facts
  const ul = document.getElementById('factsList');
  ul.innerHTML = '';
  details.facts.forEach(f => {
    const li = document.createElement('li');
    li.textContent = f;
    ul.appendChild(li);
  });
  // open
  el.modal.classList.add('open');
  el.modalOverlay.classList.add('open');
  el.modal.setAttribute('aria-hidden','false');
  el.modalOverlay.setAttribute('aria-hidden','false');
  el.modalClose.focus();
}
function closeCryptoModal() {
  el.modal.classList.remove('open');
  el.modalOverlay.classList.remove('open');
  el.modal.setAttribute('aria-hidden','true');
  el.modalOverlay.setAttribute('aria-hidden','true');
}
el.modalClose.addEventListener('click', closeCryptoModal);
el.modalOverlay.addEventListener('click', closeCryptoModal);
window.addEventListener('keydown', (e) => {
  if(e.key === 'Escape') {
    closeCryptoModal();
  }
});
// mini range chips: update mini chart with fake data for now
document.querySelectorAll('.range-chips.mini .chip').forEach(ch => {
  ch.addEventListener('click', () => {
    document.querySelectorAll('.range-chips.mini .chip').forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
    const miniRange = ch.dataset.mini;
    buildMiniChart(fakeEquity(miniRange));
  });
});

/* --------------------------------------------------------------------------
   Equity range chips
--------------------------------------------------------------------------- */
el.chips.forEach(ch => {
  ch.addEventListener('click', () => {
    el.chips.forEach(c => c.classList.remove('active'));
    ch.classList.add('active');
    const range = ch.dataset.range;
    loadEquity(range);
  });
});
// set default active chip to 1M
(function setDefaultRange() {
  const defaultChip = el.chips.find(c => c.dataset.range === '1M') || el.chips[0];
  if(defaultChip) {
    el.chips.forEach(c => c.classList.remove('active'));
    defaultChip.classList.add('active');
  }
})();

/* --------------------------------------------------------------------------
   Settings persistence and submission
--------------------------------------------------------------------------- */
const LS_KEY = 'mrteals.settings.v2';
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if(saved.initialBalance != null) document.getElementById('initialBalance').value = saved.initialBalance;
    if(saved.positionSizePct != null) document.getElementById('positionSizePct').value = saved.positionSizePct;
    if(saved.stopLossPct != null) document.getElementById('stopLossPct').value = saved.stopLossPct;
    if(saved.maxDailyLossPct != null) document.getElementById('maxDailyLossPct').value = saved.maxDailyLossPct;
    if(saved.strategy) el.strategy.value = saved.strategy;
  } catch {}
}
function getSettingsPayload() {
  const initialBalance = Number(document.getElementById('initialBalance').value || 10000);
  const positionSizePct = clamp(Number(document.getElementById('positionSizePct').value || 5), 0, 100);
  const stopLossPct = clamp(Number(document.getElementById('stopLossPct').value || 2), 0, 100);
  const maxDailyLossPct = clamp(Number(document.getElementById('maxDailyLossPct').value || 4), 0, 100);
  const strategy = el.strategy.value || 'momentum';
  return { initialBalance, positionSizePct, stopLossPct, maxDailyLossPct, strategy };
}
function saveSettingsLocal() {
  const payload = getSettingsPayload();
  localStorage.setItem(LS_KEY, JSON.stringify(payload));
}
el.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = getSettingsPayload();
  saveSettingsLocal();
  try {
    await postJSON(`${API_BASE}/api/settings/risk`, payload);
    toast('Settings saved', 'success', 2000);
  } catch {
    toast('Server unreachable — settings saved locally', 'warn', 2600);
  }
});
el.strategy.addEventListener('change', saveSettingsLocal);

/* --------------------------------------------------------------------------
   Theme Toggle (dark/light)
--------------------------------------------------------------------------- */
(function initTheme() {
  const root = document.documentElement;
  const key = 'mrteals.theme.v1';
  const saved = localStorage.getItem(key) || 'dark';
  if(saved === 'light') root.classList.add('light');
  el.themeToggle.addEventListener('click', () => {
    root.classList.toggle('light');
    const current = root.classList.contains('light') ? 'light' : 'dark';
    el.themeToggle.textContent = current === 'light' ? 'Dark' : 'Light';
    localStorage.setItem(key, current);
  });
  // Set initial button text
  el.themeToggle.textContent = root.classList.contains('light') ? 'Dark' : 'Light';
})();

/* --------------------------------------------------------------------------
   Control Buttons (Start/Pause/Kill)
--------------------------------------------------------------------------- */
async function sendControl(cmd) {
  try {
    toast(`${cmd.toUpperCase()} sent`, 'success', 1600);
    await postJSON(`${API_BASE}/api/control/${cmd}`, {});
    // Manage update loop based on command
    if(cmd === 'start') {
      // Start periodic polling and strategy execution. Do not reset account.
      startUpdates();
      startStrategy();
    } else if(cmd === 'pause' || cmd === 'kill') {
      // Stop updates and strategy without resetting account.
      stopUpdates();
      stopStrategy();
    }
  } catch {
    toast(`Server unreachable — ${cmd} queued locally`, 'warn', 2000);
  }
}
el.btnStart.addEventListener('click', () => sendControl('start'));
el.btnPause.addEventListener('click', () => sendControl('pause'));
el.btnKill.addEventListener('click', () => sendControl('kill'));

// Reset button: clears state without starting new simulation
if(el.btnReset) {
  el.btnReset.addEventListener('click', () => {
    // Reset backend account and clear strategy state
    const balVal = parseFloat(document.getElementById('initialBalance').value) || null;
    resetAccount(balVal);
    stopStrategy();
    stopUpdates();
  });
}

/* --------------------------------------------------------------------------
   Add Symbol to Watchlist
--------------------------------------------------------------------------- */
el.addSymbolButton.addEventListener('click', async (e) => {
  e.preventDefault();
  const val = el.addSymbolInput.value.trim().toUpperCase();
  if(!val) return;
  try {
    // Attempt to send to backend (if API supports)
    // Use the backend endpoint for adding a symbol. The API expects a query param
    // e.g. /api/watchlist/add?symbol=BTC/USD. Fall back locally on failure.
    await postJSON(`${API_BASE}/api/watchlist/add?symbol=${encodeURIComponent(val)}`, {});
    // Reload watchlist to reflect new symbol
    loadWatchlist();
    toast('Symbol added', 'success', 1500);
  } catch {
    // Append locally
    const current = [];
    el.watchlist.querySelectorAll('.wl-row span:first-child').forEach(span => current.push(span.textContent));
    if(!current.includes(val)) {
      current.push(val);
    }
    const items = current.map(sym => ({ symbol:sym, price:0, changePct:0 }));
    renderWatchlist(items);
    toast('Added locally (preview)', 'warn', 1800);
  }
  el.addSymbolInput.value = '';
});

/* --------------------------------------------------------------------------
   Boot sequence
--------------------------------------------------------------------------- */
async function boot() {
  loadSettings();
  // Call each load function separately so that one failure doesn’t prevent others from running.
  try {
    await loadPerformance();
  } catch (e) {
    console.warn('Failed to load performance:', e);
  }
  try {
    await loadSnapshot();
  } catch (e) {
    console.warn('Failed to load snapshot:', e);
  }
  try {
    await loadEquity('1M');
  } catch (e) {
    console.warn('Failed to load equity:', e);
  }
  try {
    await loadWatchlist();
  } catch (e) {
    console.warn('Failed to load watchlist:', e);
  }
  try {
    await loadTradeLog();
  } catch (e) {
    console.warn('Failed to load trade log:', e);
  }
}
document.addEventListener('DOMContentLoaded', boot);
// Custom tooltip handling for settings inputs
document.addEventListener('DOMContentLoaded', () => {
  const tooltipEl = document.getElementById('customTooltip');
  document.querySelectorAll('input').forEach(inp => {
    const tip = inp.getAttribute('title');
    if(!tip) return;
    inp.addEventListener('mouseenter', (e) => {
      tooltipEl.textContent = tip;
      tooltipEl.style.display = 'block';
      tooltipEl.style.left = `${e.pageX + 10}px`;
      tooltipEl.style.top = `${e.pageY + 10}px`;
    });
    inp.addEventListener('mousemove', (e) => {
      tooltipEl.style.left = `${e.pageX + 10}px`;
      tooltipEl.style.top = `${e.pageY + 10}px`;
    });
    inp.addEventListener('mouseleave', () => {
      tooltipEl.style.display = 'none';
    });
  });
  // Manual trade form handler
  if(el.manualTradeForm) {
    el.manualTradeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const sym = el.tradeSymbol.value;
      const side = el.tradeSide.value;
      const qty = parseFloat(el.tradeQty.value);
      executeManualTrade(sym, side, qty);
      // Clear quantity input
      el.tradeQty.value = '';
    });
  }
});