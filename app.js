/* Mr. Teals Phase 1 — Manual Trading (Fake Money)
   Smoke Test:
   1) Load page → prices render within ~2s, no flicker; Equity/Cash/Positions all $0.00
   2) Add Starting Balance $10,000 → Cash=10k, Equity=10k, Positions=$0
   3) BUY 1 ETH → Trade row appears, Cash & Positions update. If cost > cash → blocked
   4) SELL more than you hold → blocked with error
   5) Reset → everything back to zero, prices still live
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

    addBtns: $$(".btn.add"),
    customAdd: $("#customAdd"),
    addCustom: $("#addCustomBtn"),

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
  const LS_KEY = "mrteals.state.v1";
  let state = {
    cash: 0,
    positions: {}, // symbol -> qty
    trades: [],    // [{time,symbol,side,qty,price,total}]
  };
  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) state = JSON.parse(raw);
    } catch {}
  }
  function saveState() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

  // volatile prices cache
  const prices = new Map(); // symbol -> {price:number, ts:number, stale:boolean}

  // ---------- Utils ----------
  function fmtUSD(n) {
    const v = Math.abs(Number(n) || 0);
    const sign = Number(n) < 0 ? "-" : "";
    return `${sign}$${v.toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2})}`;
  }
  function nowISO() {
    const d = new Date();
    return d.toLocaleTimeString();
  }
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    el.toastHost.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  function renderSnapshot() {
    // compute positions value from latest prices
    let posVal = 0;
    for (const [sym, qty] of Object.entries(state.positions)) {
      const p = prices.get(sym)?.price;
      if (p) posVal += qty * p;
    }
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
        <div class="muted">${p?.ts ? new Date(p.ts).toLocaleTimeString() : ""}</div>
      `;
      el.pricesList.appendChild(row);
    });
  }

  async function fetchCoingecko() {
    const ids = Object.values(CG_IDS).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      for (const sym of SYMBOLS) {
        const id = CG_IDS[sym];
        const price = data?.[id]?.usd;
        if (typeof price === "number") {
          prices.set(sym, { price, ts: Date.now(), stale: false });
        } else {
          // keep old, mark stale
          const prev = prices.get(sym) || {};
          prices.set(sym, { ...prev, stale: true });
        }
      }
      el.priceStatus.textContent = "Live";
      renderPrices();
      renderSnapshot();
      updateEstimate();
    } catch (e) {
      // mark all stale
      for (const sym of SYMBOLS) {
        const prev = prices.get(sym) || {};
        prices.set(sym, { ...prev, stale: true });
      }
      el.priceStatus.textContent = "Stale";
      renderPrices();
    }
  }

  function getPrice(sym) {
    return prices.get(sym)?.price ?? null;
  }

  function updateEstimate() {
    const sym = (el.tSymbol.value || "").toUpperCase().trim();
    const qty = Number(el.tQty.value);
    const p = getPrice(sym);
    el.estPrice.textContent = p ? fmtUSD(p) : "—";
    if (p && qty > 0) el.estCost.textContent = fmtUSD(p * qty);
    else el.estCost.textContent = "—";
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
    const p = getPrice(sym);
    if (!p) throw new Error("Price unavailable");

    if (side === "BUY") {
      const { ok, reason } = canBuy(sym, qty);
      if (!ok) throw new Error(reason);
      state.cash -= p * qty;
      state.positions[sym] = (state.positions[sym] || 0) + qty;
    } else {
      const { ok, reason } = canSell(sym, qty);
      if (!ok) throw new Error(reason);
      state.cash += p * qty;
      state.positions[sym] = (state.positions[sym] || 0) - qty;
      if (state.positions[sym] < 1e-12) delete state.positions[sym];
    }

    const trade = {
      time: nowISO(),
      symbol: sym,
      side,
      qty: Number(qty),
      price: p,
      total: p * qty
    };
    state.trades.unshift(trade);
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

  // ---------- Events ----------
  el.addBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const amt = Number(btn.dataset.add);
      if (amt > 0) {
        state.cash += amt;
        saveState();
        renderSnapshot();
        toast(`Added ${fmtUSD(amt)} starting balance`);
      }
    });
  });
  el.addCustom.addEventListener("click", () => {
    const amt = Number(el.customAdd.value);
    if (amt > 0) {
      state.cash += amt;
      el.customAdd.value = "";
      saveState();
      renderSnapshot();
      toast(`Added ${fmtUSD(amt)} starting balance`);
    }
  });

  el.tSymbol.addEventListener("input", updateEstimate);
  el.tQty.addEventListener("input", updateEstimate);
  el.tSide.addEventListener("change", updateEstimate);

  el.tradeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    el.tradeError.hidden = true;
    const sym = (el.tSymbol.value || "").toUpperCase().trim();
    const side = el.tSide.value;
    const qty = Number(el.tQty.value);

    if (!sym || !CG_IDS[sym]) {
      el.tradeError.hidden = false;
      el.tradeError.textContent = "Enter a valid symbol from the list.";
      return;
    }
    if (!(qty > 0)) {
      el.tradeError.hidden = false;
      el.tradeError.textContent = "Enter a positive quantity.";
      return;
    }
    try {
      executeTrade(sym, side, qty);
      // clear qty, keep symbol
      el.tQty.value = "";
      updateEstimate();
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
    toast("Simulation reset");
  });

  // ---------- Boot ----------
  function boot() {
    loadState();
    // init prices map entries so UI has stable rows
    SYMBOLS.forEach(sym => prices.set(sym, { price:null, ts:null, stale:false }));
    renderPrices();
    renderTrades();
    renderSnapshot();
    updateEstimate();
    // price poller (2s)
    fetchCoingecko();
    setInterval(fetchCoingecko, 2000);
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
