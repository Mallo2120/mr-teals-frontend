/* Mr. Teals Phase 1.1 — Manual Trading (Fake Money, Live Prices, Equity Chart)
   Smoke Test:
   1) Load → prices render within ~2s, no flicker; Equity/Cash/Positions $0.00
   2) Select $10k, then click Add → Cash=10k, Equity=10k, Positions=$0
   3) BUY 1 ETH → Trade row appears; snapshot updates; equity moves with price
   4) SELL more than you hold → blocked with error
   5) Switch Refresh: Fast/Normal/Pause works; chart updates live
   6) Reset → everything back to zero, prices still live
*/
(() => {
  // ---------- Symbols & Coingecko mapping ----------
  const SYMBOLS = ["BTC/USD","ETH/USD","SOL/USD","DOT/USD","DOGE/USD"];
  const CG_IDS = {
    "BTC/USD": "bitcoin",
    "ETH/USD": "ethereum",
    "SOL/USD": "solana",
    "DOT/USD": "polkadot",
    "DOGE/USD": "dogecoin",
  };

  // ---------- Elements ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const el = {
    equity: $("#equityVal"),
    cash: $("#cashVal"),
    positions: $("#positionsVal"),
    pricesList: $("#pricesList"),
    priceStatus: $("#priceStatus"),
    lastUpdated: $("#lastUpdated"),
    refreshRate: $("#refreshRate"),
    addBtns: $$(".btn.add"),
    customAdd: $("#customAdd"),
    addApply: $("#addApplyBtn"),
    tradeForm: $("#tradeForm"),
    tSymbol: $("#tradeSymbol"),
    tSide: $("#tradeSide"),
    tQty: $("#tradeQty"),
    estPrice: $("#estPrice"),
    estCost: $("#estCost"),
    tradeError: $("#tradeError"),
    tradeTable: $("#tradeTable"),
    reset: $("#resetBtn"),
    toastHost: $("#toastHost"),
  };

  // ---------- Local state (persisted) ----------
  const LS_KEY = "mrteals.state.v1.1";
  let state = { cash: 0, positions: {}, trades: [] };
  function loadState() { try { const raw = localStorage.getItem(LS_KEY); if (raw) state = JSON.parse(raw); } catch {} }
  function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

  // volatile prices cache
  const prices = new Map(); // symbol -> {price:number, ts:number, stale:boolean}

  // ---------- Utils ----------
  function fmtUSD(n) {
    const v = Math.abs(Number(n) || 0);
    const sign = Number(n) < 0 ? "-" : "";
    return `${sign}$${v.toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2})}`;
  }
  function nowTime() { return new Date().toLocaleTimeString(); }
  function toast(msg) { const t=document.createElement("div"); t.className="toast"; t.textContent=msg; el.toastHost.appendChild(t); setTimeout(()=>t.remove(), 2500); }

  function computePositionsValue() {
    let val = 0;
    for (const [sym, qty] of Object.entries(state.positions)) {
      const p = prices.get(sym)?.price;
      if (p) val += qty * p;
    }
    return val;
  }
  function renderSnapshot() {
    const posVal = computePositionsValue();
    el.cash.textContent = fmtUSD(state.cash);
    el.positions.textContent = fmtUSD(posVal);
    el.equity.textContent = fmtUSD(state.cash + posVal);
  }

  function renderPrices() {
    el.pricesList.innerHTML = "";
    SYMBOLS.forEach(sym => {
      const row = document.createElement("li");
      const p = prices.get(sym);
      const val = p?.price != null ? fmtUSD(p.price) : "—";
      row.innerHTML = `
        <div class="sym">${sym}</div>
        <div class="val ${p?.stale ? "stale":""}">${val}</div>
      `;
      el.pricesList.appendChild(row);
    });
  }

  async function fetchCoingecko() {
    const ids = Object.values(CG_IDS).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      for (const sym of SYMBOLS) {
        const id = CG_IDS[sym];
        const price = data?.[id]?.usd;
        if (typeof price === "number") {
          prices.set(sym, { price, ts: Date.now(), stale: false });
        } else {
          const prev = prices.get(sym) || {};
          prices.set(sym, { ...prev, stale: true });
        }
      }
      el.priceStatus.textContent = "Live";
      el.lastUpdated.textContent = `Updated: ${nowTime()}`;
      renderPrices();
      renderSnapshot();
      recordEquityPoint();
      renderChart();
      updateEstimate();
    } catch (e) {
      for (const sym of SYMBOLS) {
        const prev = prices.get(sym) || {};
        prices.set(sym, { ...prev, stale: true });
      }
      el.priceStatus.textContent = "Stale";
    }
  }

  function getPrice(sym) { return prices.get(sym)?.price ?? null; }
  function updateEstimate() {
    const sym = (el.tSymbol.value || "").toUpperCase().trim();
    const qty = Number(el.tQty.value);
    const p = getPrice(sym);
    el.estPrice.textContent = p ? fmtUSD(p) : "—";
    el.estCost.textContent = (p && qty > 0) ? fmtUSD(p * qty) : "—";
  }

  // ---------- Trading ----------
  function canBuy(sym, qty) {
    const p = getPrice(sym); if (!p) return { ok:false, reason:"Price unavailable" };
    const cost = p * qty;
    if (cost > state.cash + 1e-9) return { ok:false, reason:`Not enough cash: need ${fmtUSD(cost)}, have ${fmtUSD(state.cash)}`};
    return { ok:true };
  }
  function canSell(sym, qty) {
    const held = state.positions[sym] || 0;
    if (qty > held + 1e-12) return { ok:false, reason:`Not enough holdings: have ${held}` };
    return { ok:true };
  }
  function executeTrade(sym, side, qty) {
    const p = getPrice(sym); if (!p) throw new Error("Price unavailable");
    if (side === "BUY") {
      const v = canBuy(sym, qty); if (!v.ok) throw new Error(v.reason);
      state.cash -= p * qty;
      state.positions[sym] = (state.positions[sym] || 0) + qty;
    } else {
      const v = canSell(sym, qty); if (!v.ok) throw new Error(v.reason);
      state.cash += p * qty;
      state.positions[sym] = (state.positions[sym] || 0) - qty;
      if (state.positions[sym] < 1e-12) delete state.positions[sym];
    }
    state.trades.unshift({ time: nowTime(), symbol:sym, side, qty:Number(qty), price:p, total:p*qty });
    saveState();
    renderSnapshot();
    renderTrades();
    toast(`${side} ${qty} ${sym} @ ${fmtUSD(p)}`);
  }

  function renderTrades() {
    el.tradeTable.innerHTML = "";
    state.trades.forEach(tr => {
      const trEl = document.createElement("tr");
      trEl.innerHTML = `
        <td>${tr.time}</td>
        <td>${tr.symbol}</td>
        <td class="${tr.side === "BUY" ? "good":"bad"}">${tr.side}</td>
        <td>${tr.qty}</td>
        <td>${fmtUSD(tr.price)}</td>
        <td>${fmtUSD(tr.total)}</td>
      `;
      el.tradeTable.appendChild(trEl);
    });
  }

  // ---------- Refresh control & Chart ----------
  let pollTimer = null;
  let pollMs = 2000;
  const equityHistory = []; // [{t:number, v:number}]
  let chart, currentRange = "1D";

  function recordEquityPoint() {
    const eq = state.cash + computePositionsValue();
    equityHistory.push({ t: Date.now(), v: eq });
    // cap history to last ~7 days to avoid unbounded growth
    const cutoff = Date.now() - 7*24*60*60*1000;
    while (equityHistory.length && equityHistory[0].t < cutoff) equityHistory.shift();
  }
  function startPoll() {
    if (pollTimer) clearInterval(pollTimer);
    if (pollMs > 0) {
      pollTimer = setInterval(fetchCoingecko, pollMs);
    }
  }
  el.refreshRate.addEventListener("change", () => {
    pollMs = Number(el.refreshRate.value);
    startPoll();
    if (pollMs > 0) fetchCoingecko(); // immediate tick on change
  });

  function buildChart() {
    const ctx = document.getElementById("equityChart").getContext("2d");
    chart = new Chart(ctx, {
      type: "line",
      data: { labels: [], datasets: [{ label:"Equity", data: [], borderWidth:2, pointRadius:0, tension:0.25 }] },
      options: {
        animation: false, responsive: true,
        scales: {
          x: { ticks: { color: "#9db2b2" }, grid: { color: "#24303a" } },
          y: { ticks: { color: "#9db2b2" }, grid: { color: "#24303a" } },
        },
        plugins: { legend: { display:false } }
      }
    });
  }
  function renderChart() {
    if (!chart) return;
    const now = Date.now();
    const win = { "1D":86400000, "1W":604800000, "1M":2592000000, "1Y":31536000000, "ALL": Infinity }[currentRange];
    const slice = equityHistory.filter(p => currentRange === "ALL" || (now - p.t) <= win);
    chart.data.labels = slice.map(p => new Date(p.t).toLocaleTimeString());
    chart.data.datasets[0].data = slice.map(p => p.v);
    chart.update();
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    document.querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
    btn.classList.add("selected");
    currentRange = btn.dataset.range;
    renderChart();
  });

  // ---------- Events ----------
  let selectedAdd = null;
  el.addBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      selectedAdd = Number(btn.dataset.add);
      el.addBtns.forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });
  el.addApply.addEventListener("click", () => {
    let amt = selectedAdd;
    const custom = Number(el.customAdd.value);
    if ((!amt || amt <= 0) && custom > 0) amt = custom;
    if (amt && amt > 0) {
      state.cash += amt;
      saveState();
      toast(`Added ${fmtUSD(amt)} starting balance`);
      selectedAdd = null;
      el.addBtns.forEach(b => b.classList.remove("selected"));
      el.customAdd.value = "";
      renderSnapshot();
      // chart point after balance change
      recordEquityPoint();
      renderChart();
    }
  });

  el.tSymbol.addEventListener("input", updateEstimate);
  el.tQty.addEventListener("input", updateEstimate);
  el.tSide.addEventListener("change", updateEstimate);

  el.tradeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    el.tradeError.hidden = true
  });

    const sym = (el.tSymbol.value || "").toUpperCase().trim();
    const side = el.tSide.value;
    const qty = Number(el.tQty.value);
    if (!sym || !CG_IDS[sym]) { el.tradeError.hidden=false; el.tradeError.textContent="Enter a valid symbol from the list."; return; }
    if (!(qty > 0)) { el.tradeError.hidden=false; el.tradeError.textContent="Enter a positive quantity."; return; }
    try {
      executeTrade(sym, side, qty);
      el.tQty.value = "";
      updateEstimate();
      recordEquityPoint();
      renderChart();
    } catch (err) {
      el.tradeError.hidden = false;
      el.tradeError.textContent = err.message || "Trade failed";
    }
  });

  el.reset.addEventListener("click", () => {
    state = { cash:0, positions:{}, trades:[] };
    saveState();
    renderTrades();
    renderSnapshot();
    equityHistory.length = 0;
    recordEquityPoint();
    renderChart();
    toast("Simulation reset");
  });

  // ---------- Boot ----------
  function boot() {
    loadState();
    SYMBOLS.forEach(sym => prices.set(sym, { price:null, ts:null, stale:false }));
    renderPrices();
    renderTrades();
    renderSnapshot();
    updateEstimate();
    buildChart();
    recordEquityPoint();
    renderChart();
    fetchCoingecko();
    // Start poller
    const sel = document.getElementById("refreshRate");
    pollMs = Number(sel.value || 2000);
    if (pollMs > 0) startPoll();
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
