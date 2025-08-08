/* Mr. Teals front-end (vanilla + Chart.js)
   - Loads watchlist BEFORE Start
   - Manual trades show cash cost (qty * price)
   - Separate Reset action
   - Defensive boot: each section loads even if another fails
*/

const API_BASE = window.MR_TEALS_API || "https://mr-teals-backend.onrender.com";
const REQUEST_TIMEOUT_MS = 5000;

// Elements
const el = {
  realizedPL: document.getElementById("realizedPL"),
  realizedPLSub: document.getElementById("realizedPLSub"),
  unrealizedPL: document.getElementById("unrealizedPL"),
  unrealizedPLSub: document.getElementById("unrealizedPLSub"),
  tradesToday: document.getElementById("tradesToday"),
  tradesTodaySub: document.getElementById("tradesTodaySub"),

  snapEquity: document.getElementById("snapEquity"),
  snapCash: document.getElementById("snapCash"),
  snapPositions: document.getElementById("snapPositions"),

  equityCanvas: document.getElementById("equityChart"),
  equityEmpty: document.getElementById("equityEmpty"),
  chips: Array.from(document.querySelectorAll(".range-chips .chip")),

  settingsForm: document.getElementById("settingsForm"),
  themeToggle: document.getElementById("themeToggle"),

  btnStart: document.getElementById("btnStart"),
  btnPause: document.getElementById("btnPause"),
  btnKill: document.getElementById("btnKill"),
  btnReset: document.getElementById("btnReset"),

  // watchlist + manual trade
  watchlist: document.getElementById("watchlist"),
  addSymbolInput: document.getElementById("addSymbolInput"),
  addSymbolBtn: document.getElementById("addSymbolBtn"),
  symbolsList: document.getElementById("symbolsList"),
  manualTradeForm: document.getElementById("manualTradeForm"),
  manualSymbol: document.getElementById("manualSymbol"),
  manualSide: document.getElementById("manualSide"),
  manualQty: document.getElementById("manualQty"),

  // trade log
  tradeLogBody: document.getElementById("tradeLogBody"),

  // toast
  toastContainer: document.getElementById("toastContainer"),
};

function toast(msg, type = "success", ms = 2500) {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  el.toastContainer.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function withTimeout(promise, ms = REQUEST_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("timeout")), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function getJSON(url, opts = {}) {
  const res = await withTimeout(fetch(url, { headers: { Accept: "application/json" }, ...opts }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    })
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

function fmtUSD(n) {
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(Number(n) || 0);
  return `${sign}$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* -------------------- State -------------------- */

// Keep track of the currently selected equity chart range. This is used when
// refreshing performance data periodically so we respect the user’s selection.
let currentRange = "1M";

// Timer used for debouncing price lookups when estimating trade cost
let estimateTimer = null;

/* -------------------- Loaders -------------------- */

async function loadPerformance(range = "1M") {
  try {
    // Persist the last requested range for periodic refreshes
    currentRange = range;
    const res = await getJSON(`${API_BASE}/api/performance/today?range=${encodeURIComponent(range)}`);
    const realized = Number(res?.realized ?? 0);
    const unrealized = Number(res?.unrealized ?? 0);
    const trades = Number(res?.trades ?? 0);
    el.realizedPL.textContent = fmtUSD(realized);
    el.unrealizedPL.textContent = fmtUSD(unrealized);
    el.tradesToday.textContent = trades;
    el.realizedPLSub.textContent = realized >= 0 ? "Gain" : "Loss";
    el.unrealizedPLSub.textContent = unrealized >= 0 ? "Gain" : "Loss";

    const series = Array.isArray(res?.series) ? res.series : [];
    if (series.length) {
      el.equityEmpty.hidden = true;
      buildEquityChart(series.map((d) => ({ x: new Date(d.t), y: Number(d.v) })));
    } else {
      el.equityEmpty.hidden = false;
    }
  } catch (e) {
    console.warn("loadPerformance failed:", e.message);
    el.equityEmpty.hidden = false;
  }
}

async function loadSnapshot() {
  try {
    const s = await getJSON(`${API_BASE}/api/account/snapshot`);
    el.snapEquity.textContent = fmtUSD(s?.equity ?? 0);
    el.snapCash.textContent = fmtUSD(s?.cash ?? 0);
    el.snapPositions.textContent = fmtUSD(s?.positions ?? 0);
  } catch (e) {
    console.warn("loadSnapshot failed:", e.message);
  }
}

async function loadWatchlist() {
  try {
    // Symbols list (defaults provided by backend)
    const res = await getJSON(`${API_BASE}/api/watchlist`);
    const list = Array.isArray(res) ? res : res?.watchlist ?? res?.items ?? [];
    if (!list.length) throw new Error("empty list");

    // Fetch prices for those symbols
    const symbols = list.map((x) => x.symbol || x).join(",");
    const prices = await getJSON(`${API_BASE}/api/prices?symbols=${encodeURIComponent(symbols)}`);

    renderWatchlist(
      list.map((it) => {
        const sym = it.symbol || it;
        const p = prices?.[sym]?.price ?? prices?.[sym] ?? null;
        const change = prices?.[sym]?.changePct ?? null;
        return { symbol: sym, price: p, changePct: change };
      })
    );

    // Fill datalist for manual trading convenience
    el.symbolsList.innerHTML = "";
    list.forEach((it) => {
      const opt = document.createElement("option");
      opt.value = it.symbol || it;
      el.symbolsList.appendChild(opt);
    });
  } catch (e) {
    console.warn("loadWatchlist failed:", e.message);
    // Fallback defaults
    const fallback = ["BTC/USD", "ETH/USD", "SOL/USD", "DOT/USD", "DOGE/USD"].map((s) => ({
      symbol: s,
      price: null,
      changePct: null,
    }));
    renderWatchlist(fallback);
    fallback.forEach((it) => {
      const opt = document.createElement("option");
      opt.value = it.symbol;
      el.symbolsList.appendChild(opt);
    });
  }
}

function renderWatchlist(items) {
  el.watchlist.innerHTML = "";
  items.forEach((it) => {
    const li = document.createElement("li");
    li.className = "wl-row";
    const chgClass = (it.changePct ?? 0) >= 0 ? "chg-pos" : "chg-neg";
    const priceStr = it.price != null ? fmtUSD(it.price) : "—";
    const chgStr = it.changePct != null ? `${(it.changePct >= 0 ? "+" : "")}\${it.changePct.toFixed(2)}%` : "—";
    li.innerHTML = `<span>${it.symbol}</span><span>${priceStr}</span><span class="${chgClass}">${chgStr}</span><span aria-hidden="true">›</span>`;
    // Clicking on a watchlist row opens a modal showing details for that symbol
    li.addEventListener("click", () => openSymbolModal(it.symbol));
    el.watchlist.appendChild(li);
  });
}

async function loadTradeLog() {
  try {
    const res = await getJSON(`${API_BASE}/api/trades`);
    const trades = Array.isArray(res) ? res : res?.trades ?? [];
    renderTradeLog(trades);
  } catch (e) {
    console.warn("loadTradeLog failed:", e.message);
    el.tradeLogBody.innerHTML = "";
  }
}

/* -------------------- Chart -------------------- */

let equityChart;
function buildEquityChart(data) {
  const dataset = data.map((d) => ({ x: new Date(d.x || d.t), y: Number(d.y ?? d.v) }));
  if (equityChart) equityChart.destroy();
  const ctx = el.equityCanvas.getContext("2d");
  equityChart = new Chart(ctx, {
    type: "line",
    data: { datasets: [{ label: "Equity", data: dataset, borderColor: "#11C5C6", tension: 0.25, pointRadius: 0 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      scales: {
        x: { type: "time", time: { tooltipFormat: "ll HH:mm" }, grid: { color: "rgba(255,255,255,.06)" } },
        y: { grid: { color: "rgba(255,255,255,.06)" }, ticks: { callback: (v) => "$" + Number(v).toLocaleString() } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

/* -------------------- Controls -------------------- */

async function sendControl(cmd) {
  try {
    await postJSON(`${API_BASE}/api/control/${cmd}`, {});
    toast(`${cmd.toUpperCase()} sent`);
  } catch (e) {
    toast(`${cmd.toUpperCase()} failed: ${e.message}`, "error");
  }
}
el.btnStart.addEventListener("click", () => sendControl("start"));
el.btnPause.addEventListener("click", () => sendControl("pause"));
el.btnKill.addEventListener("click", () => sendControl("kill"));

el.btnReset.addEventListener("click", async () => {
  try {
    await postJSON(`${API_BASE}/api/reset`, {});
    toast("Reset complete");
    await Promise.all([
      loadSnapshot(),
      loadPerformance(currentRange),
      loadTradeLog(),
      loadWatchlist(),
    ]);
  } catch (e) {
    toast("Reset failed", "error");
  }
});

/* -------------------- Manual trade -------------------- */

// Estimate the cost of a manual trade by looking up the latest price.  This
// provides instant feedback to the user before executing a trade.  We debounce
// API requests so that typing in the inputs doesn’t spam the backend.
function updateManualEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(async () => {
    const symbol = (el.manualSymbol.value || "").trim().toUpperCase();
    const qty = Number(el.manualQty.value);
    const output = document.getElementById("manualEst");
    if (!symbol || !qty || qty <= 0) {
      output.textContent = "";
      return;
    }
    try {
      const data = await getJSON(`${API_BASE}/api/prices?symbols=${encodeURIComponent(symbol)}`);
      const info = data?.[symbol] ?? {};
      const price = info.price != null ? info.price : (typeof info === "number" ? info : null);
      if (price != null && !isNaN(price)) {
        const cost = price * qty;
        output.textContent = `Est. Price: ${fmtUSD(price)} | Est. Cost: ${fmtUSD(cost)}`;
      } else {
        output.textContent = "No price data";
      }
    } catch (err) {
      output.textContent = "Price lookup error";
    }
  }, 400);
}

// Update estimate whenever symbol or quantity changes
el.manualSymbol.addEventListener("input", updateManualEstimate);
el.manualQty.addEventListener("input", updateManualEstimate);

el.manualTradeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const symbol = (el.manualSymbol.value || "").trim().toUpperCase();
  const side = el.manualSide.value;
  const qty = Number(el.manualQty.value);
  if (!symbol || !qty || qty <= 0) {
    toast("Enter symbol and a positive quantity", "warn");
    return;
  }
  try {
    // /api/trade expects query parameters rather than a JSON body
    const url = `${API_BASE}/api/trade?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(side)}&quantity=${encodeURIComponent(qty)}`;
    await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { Accept: "application/json" },
      })
    );
    toast(`${side} ${qty} ${symbol} sent`);
    el.manualQty.value = "";
    // refresh UI pieces
    await Promise.all([
      loadSnapshot(),
      loadPerformance(currentRange),
      loadTradeLog(),
      loadWatchlist(),
    ]);
    // Clear estimate after trade
    document.getElementById("manualEst").textContent = "";
  } catch (e2) {
    toast(`Trade failed: ${e2.message}`, "error");
  }
});

/* -------------------- Settings -------------------- */

const LS_KEY = "mrteals.settings.v1";
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    if (s.initialBalance != null) document.getElementById("initialBalance").value = s.initialBalance;
    if (s.positionSizePct != null) document.getElementById("positionSizePct").value = s.positionSizePct;
    if (s.stopLossPct != null) document.getElementById("stopLossPct").value = s.stopLossPct;
    if (s.maxDailyLossPct != null) document.getElementById("maxDailyLossPct").value = s.maxDailyLossPct;
    if (s.strategy) document.getElementById("strategy").value = s.strategy;
  } catch {}
}
function saveSettingsLocal() {
  const payload = {
    initialBalance: Number(document.getElementById("initialBalance").value || 10000),
    positionSizePct: Number(document.getElementById("positionSizePct").value || 10),
    stopLossPct: Number(document.getElementById("stopLossPct").value || 2),
    maxDailyLossPct: Number(document.getElementById("maxDailyLossPct").value || 5),
    strategy: document.getElementById("strategy").value || "momentum",
  };
  localStorage.setItem(LS_KEY, JSON.stringify(payload));
}
el.settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  saveSettingsLocal();
  try {
    await postJSON(`${API_BASE}/api/settings/risk`, JSON.parse(localStorage.getItem(LS_KEY)));
    toast("Settings saved");
  } catch {
    toast("Server unreachable — saved locally", "warn");
  }
});

/* -------------------- Trade log renderer -------------------- */

function renderTradeLog(trades) {
  el.tradeLogBody.innerHTML = "";
  trades.forEach((tr) => {
    const sideClass = tr.side === "BUY" ? "chg-pos" : "chg-neg";
    const qtyNum = Number(tr.qty);
    const priceNum = Number(tr.price);
    const cost = qtyNum && priceNum ? qtyNum * priceNum : null;
    const trEl = document.createElement("tr");
    trEl.innerHTML = `
      <td>${tr.time || tr.timestamp || ""}</td>
      <td>${tr.symbol || ""}</td>
      <td class="${sideClass}">${tr.side}</td>
      <td>${qtyNum ?? ""}</td>
      <td>${priceNum ? fmtUSD(priceNum) : ""}</td>
      <td>${cost != null ? fmtUSD(cost) : ""}</td>
    `;
    el.tradeLogBody.appendChild(trEl);
  });
}

/* -------------------- Symbol details modal -------------------- */
// Open a modal displaying details for the selected symbol.  It fetches the
// latest price and change from the backend and renders them in a simple
// information card.  If the lookup fails, a message is shown instead.
function openSymbolModal(symbol) {
  const modal = document.getElementById("symbolModal");
  const modalSymbol = document.getElementById("modalSymbol");
  const modalBody = document.getElementById("modalBody");
  modalSymbol.textContent = symbol;
  modalBody.innerHTML = "<p>Loading…</p>";
  modal.classList.add("active");

  getJSON(`${API_BASE}/api/prices?symbols=${encodeURIComponent(symbol)}`)
    .then((data) => {
      const info = data?.[symbol] ?? {};
      const price = info.price != null ? info.price : (typeof info === "number" ? info : null);
      const change = info.changePct != null ? info.changePct : null;
      const priceStr = price != null ? fmtUSD(price) : "—";
      const changeStr = change != null ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—";
      modalBody.innerHTML = `<p>Price: ${priceStr}</p><p>Change: ${changeStr}</p>`;
    })
    .catch(() => {
      modalBody.innerHTML = "<p>Error loading price</p>";
    });
}

// Initialize modal close handlers.  Clicking the close button or the shaded
// backdrop will dismiss the modal.
(function initModal() {
  const modal = document.getElementById("symbolModal");
  const closeBtn = document.getElementById("modalClose");
  if (!modal || !closeBtn) return;
  closeBtn.addEventListener("click", () => modal.classList.remove("active"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("active");
  });
})();

/* -------------------- Equity range chips -------------------- */
el.chips.forEach((chip) => {
  chip.addEventListener("click", async () => {
    el.chips.forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    await loadPerformance(chip.dataset.range);
  });
});

/* -------------------- Theme -------------------- */
(function initTheme() {
  const root = document.documentElement;
  const key = "mrteals.theme";
  const saved = localStorage.getItem(key) || "dark";
  if (saved === "light") root.classList.add("light");
  el.themeToggle.addEventListener("click", () => {
    root.classList.toggle("light");
    localStorage.setItem(key, root.classList.contains("light") ? "light" : "dark");
  });
})();

/* -------------------- Boot -------------------- */
async function boot() {
  loadSettings();

  // Load each section independently so one failure doesn't block others
  try { await loadWatchlist(); } catch(e){ console.warn("watchlist:", e.message); }
  try { await loadSnapshot(); } catch(e){ console.warn("snapshot:", e.message); }
  try { await loadPerformance("1M"); } catch(e){ console.warn("perf:", e.message); }
  try { await loadTradeLog(); } catch(e){ console.warn("trades:", e.message); }

  // Add symbol to watchlist UI only (server owns canonical watchlist)
  el.addSymbolBtn.addEventListener("click", async () => {
    const val = (el.addSymbolInput.value || "").toUpperCase().trim();
    if (!val) return;
    try {
      await postJSON(`${API_BASE}/api/watchlist`, { symbol: val }); // backend may support this
    } catch {}
    el.addSymbolInput.value = "";
    await loadWatchlist();
  });

  // Periodically refresh key data (snapshot, performance, trades and watchlist)
  async function refreshAll() {
    try {
      // respect the user's selected range when refreshing performance
      await Promise.all([
        loadSnapshot(),
        loadPerformance(currentRange),
        loadTradeLog(),
        loadWatchlist(),
      ]);
    } catch (e) {
      console.warn("Periodic refresh failed:", e.message);
    }
  }
  // Start polling every 10 seconds to provide near real‑time feedback
  setInterval(refreshAll, 10000);
}
document.addEventListener("DOMContentLoaded", boot);
