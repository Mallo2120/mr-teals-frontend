// Mr. Teals paper trading dashboard (Phase 1.2)
//
// This script implements a fully client‑side fake trading simulator. It
// maintains a local cash balance, positions, trade history and live prices.
// Prices are fetched periodically from CoinGecko with a fallback to Coinbase
// when values are missing. An equity chart tracks your account value over
// time with range selectors (Live, 1D, 1W, 1M, 1Y, ALL). The chart only
// updates every few seconds when the Live range is selected.

(() => {
  /* ---------------------------------------------------------------------
   * Configuration
   *
   * SYMBOLS: the set of pairs available for trading. Only these symbols will
   * appear in the live price list and dropdown. To add more, add the
   * appropriate key/value to COINGECKO_MAP and COINBASE_MAP below.
   */
  const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD", "DOT/USD", "DOGE/USD"];

  // Map base currencies to Coingecko IDs used by the simple price API.
  const COINGECKO_MAP = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    DOT: "polkadot",
    DOGE: "dogecoin",
  };

  // Map base currencies to Coinbase product IDs for fallback price lookup.
  const COINBASE_MAP = {
    BTC: "BTC-USD",
    ETH: "ETH-USD",
    SOL: "SOL-USD",
    DOT: "DOT-USD",
    DOGE: "DOGE-USD",
  };

  // Polling interval (in milliseconds) for live price updates. Changing this
  // will affect how frequently prices and the chart update when the Live
  // range is active.
  const POLL_INTERVAL = 2000;

  /* ---------------------------------------------------------------------
   * State
   */
  let localCash = 0; // available cash
  let localPositions = {}; // positions keyed by symbol (e.g. { 'ETH/USD': 2.5 })
  let localTrades = []; // executed trades (for rendering the log)
  let localPrices = {}; // last known USD price per symbol (e.g. { 'BTC/USD': 50000 })
  let priceHistory = []; // array of { t: Date, v: Number } for equity history
  let currentRange = "live"; // currently selected equity range
  let priceTimer = null; // timer id for polling
  let chart = null; // Chart.js instance

  /* ---------------------------------------------------------------------
   * DOM references
   */
  const refs = {
    snapEquity: document.getElementById("snapEquity"),
    snapCash: document.getElementById("snapCash"),
    snapPositions: document.getElementById("snapPositions"),
    startAmount: document.getElementById("startAmount"),
    btnAddBalance: document.getElementById("btnAddBalance"),
    priceUpdated: document.getElementById("priceUpdated"),
    priceBody: document.getElementById("priceBody"),
    manualTradeForm: document.getElementById("manualTradeForm"),
    manualSymbol: document.getElementById("manualSymbol"),
    manualSide: document.getElementById("manualSide"),
    manualQty: document.getElementById("manualQty"),
    estPrice: document.getElementById("estPrice"),
    estCost: document.getElementById("estCost"),
    tradeLogBody: document.getElementById("tradeLogBody"),
    chips: Array.from(document.querySelectorAll(".range-chips .chip")),
    btnReset: document.getElementById("btnReset"),
    toastContainer: document.getElementById("toastContainer"),
  };

  /* ---------------------------------------------------------------------
   * Utility functions
   */
  function fmtUSD(n) {
    const sign = n < 0 ? "-" : "";
    const v = Math.abs(Number(n) || 0);
    return `${sign}$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtQty(q) {
    const n = Number(q) || 0;
    return n.toFixed(4).replace(/\.0+$/, "");
  }

  function toast(message, type = "success", ms = 3000) {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    refs.toastContainer.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, ms);
  }

  // Compute the total market value of all open positions using the latest
  // prices. Symbols without a price are considered worthless.
  function computePositionsValue() {
    let total = 0;
    for (const sym in localPositions) {
      const qty = Number(localPositions[sym]) || 0;
      const price = Number(localPrices[sym]) || 0;
      total += price * qty;
    }
    return total;
  }

  // Update the equity/cash/positions values in the UI from the local state.
  function renderSnapshot() {
    const posVal = computePositionsValue();
    const equity = localCash + posVal;
    refs.snapCash.textContent = fmtUSD(localCash);
    refs.snapPositions.textContent = fmtUSD(posVal);
    refs.snapEquity.textContent = fmtUSD(equity);
  }

  // Render the trade log table from localTrades.
  function renderTradeLog() {
    refs.tradeLogBody.innerHTML = "";
    localTrades.forEach((t) => {
      const tr = document.createElement("tr");
      const time = new Date(t.time).toLocaleTimeString();
      tr.innerHTML = `
        <td>${time}</td>
        <td>${t.symbol}</td>
        <td style="color:${t.side === 'BUY' ? '#35c17b' : '#dd4f4f'}">${t.side}</td>
        <td>${fmtQty(t.qty)}</td>
        <td>${fmtUSD(t.price)}</td>
        <td>${fmtUSD(t.total)}</td>
      `;
      refs.tradeLogBody.insertBefore(tr, refs.tradeLogBody.firstChild);
    });
  }

  // Create or update the Chart.js instance using the supplied data array.
  function updateChart() {
    // Filter the priceHistory based on the current range selection
    let now = Date.now();
    let filtered;
    switch (currentRange) {
      case "1D": {
        const cutoff = now - 24 * 60 * 60 * 1000;
        filtered = priceHistory.filter((p) => p.t.getTime() >= cutoff);
        break;
      }
      case "1W": {
        const cutoff = now - 7 * 24 * 60 * 60 * 1000;
        filtered = priceHistory.filter((p) => p.t.getTime() >= cutoff);
        break;
      }
      case "1M": {
        const cutoff = now - 30 * 24 * 60 * 60 * 1000;
        filtered = priceHistory.filter((p) => p.t.getTime() >= cutoff);
        break;
      }
      case "1Y": {
        const cutoff = now - 365 * 24 * 60 * 60 * 1000;
        filtered = priceHistory.filter((p) => p.t.getTime() >= cutoff);
        break;
      }
      case "ALL":
        filtered = priceHistory.slice();
        break;
      case "live":
      default:
        filtered = priceHistory.slice();
        break;
    }
    // Transform into Chart.js friendly objects
    const points = filtered.map((pt) => ({ x: pt.t, y: pt.v }));
    // Create chart if it doesn't exist
    const ctx = document.getElementById("equityChart").getContext("2d");
    if (!chart) {
      chart = new Chart(ctx, {
        type: "line",
        data: {
          datasets: [
            {
              label: "Equity",
              data: points,
              fill: false,
              tension: 0.3,
              borderColor: "#28bfa3",
              borderWidth: 2,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              type: "time",
              time: { unit: "minute", tooltipFormat: "MMM d, h:mm:ss a" },
              grid: { display: false },
              ticks: { color: "#4f646f" },
            },
            y: {
              ticks: {
                color: "#4f646f",
                callback: function (value) {
                  return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
                },
              },
              grid: { color: "#1a2d42" },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  const v = ctx.parsed.y;
                  return `Equity: ${fmtUSD(v)}`;
                },
              },
            },
          },
        },
      });
    } else {
      chart.data.datasets[0].data = points;
      chart.update("none");
    }
  }

  // Add a new equity point to priceHistory and optionally update the chart
  function pushEquityPoint() {
    const posVal = computePositionsValue();
    const equity = localCash + posVal;
    priceHistory.push({ t: new Date(), v: equity });
    // Keep history from growing unbounded; cap at ~5k points (~2h of 2s ticks)
    if (priceHistory.length > 5000) priceHistory.shift();
    if (currentRange === "live") {
      updateChart();
    }
  }

  // Fetch current USD prices for all configured symbols. This uses Coingecko's
  // /simple/price endpoint for batch efficiency. When a price is missing
  // from Coingecko we fall back to Coinbase for that individual symbol. The
  // returned object contains symbol → price mappings.
  async function fetchAllPrices() {
    const ids = SYMBOLS.map((sym) => COINGECKO_MAP[sym.split("/")[0]]).filter(Boolean);
    const query = ids.join(",");
    let coingeckoData = {};
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${query}&vs_currencies=usd`,
        { cache: "no-store" }
      );
      coingeckoData = await res.json();
    } catch (e) {
      console.warn("Coingecko fetch failed", e);
    }
    const prices = {};
    for (const sym of SYMBOLS) {
      const base = sym.split("/")[0];
      const id = COINGECKO_MAP[base];
      const price = coingeckoData?.[id]?.usd;
      if (price != null && !isNaN(price)) {
        prices[sym] = Number(price);
      } else {
        // fallback to Coinbase per symbol
        const product = COINBASE_MAP[base];
        try {
          const r = await fetch(
            `https://api.exchange.coinbase.com/products/${product}/ticker`,
            { cache: "no-store" }
          );
          const json = await r.json();
          const p = Number(json.price);
          if (!isNaN(p)) prices[sym] = p;
        } catch (err) {
          console.warn(`Coinbase fetch failed for ${sym}`, err);
        }
      }
    }
    return prices;
  }

  // Update localPrices, price list UI, snapshot and equity history. Called
  // periodically by the polling timer.
  async function updatePrices() {
    const newPrices = await fetchAllPrices();
    const now = new Date();
    if (Object.keys(newPrices).length > 0) {
      localPrices = { ...localPrices, ...newPrices };
      refs.priceUpdated.textContent = `Updated: ${now.toLocaleTimeString()}`;
      renderPriceList();
      renderSnapshot();
      pushEquityPoint();
    } else {
      // When all price sources fail we mark the timestamp as stale but
      // otherwise leave values unchanged.
      refs.priceUpdated.textContent = `Updated: ${now.toLocaleTimeString()} (stale)`;
    }
  }

  // Render the live price list. Uses localPrices to build table rows.
  function renderPriceList() {
    refs.priceBody.innerHTML = "";
    SYMBOLS.forEach((sym) => {
      const tr = document.createElement("tr");
      const price = localPrices[sym];
      const priceText = price != null ? `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
      tr.innerHTML = `<td class="symbol">${sym}</td><td>${priceText}</td>`;
      refs.priceBody.appendChild(tr);
    });
  }

  // Handle starting balance addition
  function handleAddBalance() {
    const amt = parseFloat(refs.startAmount.value);
    if (isNaN(amt) || amt <= 0) {
      toast("Enter a valid amount", "error");
      return;
    }
    localCash += amt;
    refs.startAmount.value = "";
    renderSnapshot();
    pushEquityPoint();
    toast(`Added ${fmtUSD(amt)} to cash`, "success");
  }

  // Estimate price and cost as user types
  let estimateTimer = null;
  function scheduleEstimate() {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(async () => {
      const sym = refs.manualSymbol.value.trim().toUpperCase();
      const qty = parseFloat(refs.manualQty.value);
      if (!sym || isNaN(qty) || qty <= 0) {
        refs.estPrice.textContent = "Est. Price: —";
        refs.estCost.textContent = "Est. Cost: —";
        return;
      }
      const price = localPrices[sym] || (await fetchSinglePrice(sym));
      if (price != null) {
        refs.estPrice.textContent = `Est. Price: ${fmtUSD(price)}`;
        const cost = price * qty;
        refs.estCost.textContent = `Est. Cost: ${fmtUSD(cost)}`;
      } else {
        refs.estPrice.textContent = "Est. Price: —";
        refs.estCost.textContent = "Est. Cost: —";
      }
    }, 400);
  }

  // Fetch price for a single symbol using fallback logic (backend → Coingecko → Coinbase)
  async function fetchSinglePrice(sym) {
    const upper = sym.toUpperCase();
    // If cached price exists, return it
    if (localPrices[upper] != null) return localPrices[upper];
    // Try Coingecko
    const base = upper.split("/")[0];
    const id = COINGECKO_MAP[base];
    if (id) {
      try {
        const r = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
          { cache: "no-store" }
        );
        const j = await r.json();
        const p = j[id]?.usd;
        if (p != null && !isNaN(p)) return Number(p);
      } catch (e) {}
    }
    // Fallback to Coinbase
    const product = COINBASE_MAP[base];
    if (product) {
      try {
        const r = await fetch(
          `https://api.exchange.coinbase.com/products/${product}/ticker`,
          { cache: "no-store" }
        );
        const j = await r.json();
        const p = Number(j.price);
        if (!isNaN(p)) return p;
      } catch (e) {}
    }
    return null;
  }

  // Handle manual trade submission
  async function handleManualTrade(e) {
    e.preventDefault();
    const sym = refs.manualSymbol.value.trim().toUpperCase();
    const side = refs.manualSide.value.toUpperCase();
    const qty = parseFloat(refs.manualQty.value);
    if (!sym || !SYMBOLS.includes(sym)) {
      toast("Invalid symbol", "error");
      return;
    }
    if (isNaN(qty) || qty <= 0) {
      toast("Invalid quantity", "error");
      return;
    }
    // Ensure we have a price
    let price = localPrices[sym];
    if (price == null) {
      price = await fetchSinglePrice(sym);
      if (price == null) {
        toast("Price unavailable", "error");
        return;
      }
      localPrices[sym] = price;
      renderPriceList();
    }
    const totalCost = price * qty;
    if (side === "BUY") {
      if (totalCost > localCash) {
        toast("Not enough cash for this purchase", "error");
        return;
      }
      localCash -= totalCost;
      localPositions[sym] = (Number(localPositions[sym]) || 0) + qty;
    } else if (side === "SELL") {
      const held = Number(localPositions[sym]) || 0;
      if (qty > held) {
        toast("Not enough holdings to sell", "error");
        return;
      }
      localCash += totalCost;
      localPositions[sym] = held - qty;
      if (localPositions[sym] <= 0) delete localPositions[sym];
    }
    // Record trade
    const trade = {
      time: new Date(),
      symbol: sym,
      side,
      qty,
      price,
      total: totalCost,
    };
    localTrades.push(trade);
    // Update UI
    renderTradeLog();
    renderSnapshot();
    pushEquityPoint();
    refs.manualQty.value = "";
    toast(`${side} ${fmtQty(qty)} ${sym} executed`, "success");
  }

  // Handle range chip selection
  function handleRangeClick(e) {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const range = btn.getAttribute("data-range");
    currentRange = range;
    // Update active state
    refs.chips.forEach((chip) => chip.classList.toggle("active", chip === btn));
    // When switching away from live, we intentionally do not update the chart
    // every poll. Instead we render once on switch using the filtered history.
    updateChart();
  }

  // Reset the simulation: clear cash, positions, trades, history and snapshot
  function handleReset() {
    localCash = 0;
    localPositions = {};
    localTrades = [];
    priceHistory = [];
    renderTradeLog();
    renderSnapshot();
    updateChart();
    toast("Simulation reset", "success");
  }

  // Kick off periodic polling
  async function startPolling() {
    await updatePrices();
    if (priceTimer) clearInterval(priceTimer);
    priceTimer = setInterval(updatePrices, POLL_INTERVAL);
  }

  // Init function sets up event listeners, initial UI state and polling
  function init() {
    // Populate symbol datalist (in case future expansions)
    const datalist = document.getElementById("symbolList");
    datalist.innerHTML = "";
    SYMBOLS.forEach((sym) => {
      const opt = document.createElement("option");
      opt.value = sym;
      datalist.appendChild(opt);
    });
    // Event listeners
    refs.btnAddBalance.addEventListener("click", handleAddBalance);
    refs.manualSymbol.addEventListener("input", scheduleEstimate);
    refs.manualQty.addEventListener("input", scheduleEstimate);
    refs.manualTradeForm.addEventListener("submit", handleManualTrade);
    refs.chips.forEach((chip) => chip.addEventListener("click", handleRangeClick));
    refs.btnReset.addEventListener("click", handleReset);
    // Initial renders
    renderPriceList();
    renderSnapshot();
    renderTradeLog();
    updateChart();
    // Start price polling
    startPolling();
  }
  // Start when DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();