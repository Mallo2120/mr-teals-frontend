/* Mr. Teals Phase 1.4 — restore presets + Live, smaller chart, dynamic watchlist (add/remove), keep Max + P/L */
(() => {
  // Default symbols
  let SYMBOLS = ["BTC/USD","ETH/USD","SOL/USD","DOT/USD","DOGE/USD"];

  // Known CG id mappings; we can resolve unknowns via search.
  const KNOWN_IDS = {
    "BTC":"bitcoin","ETH":"ethereum","SOL":"solana","DOT":"polkadot","DOGE":"dogecoin",
    "TRX":"tron","ADA":"cardano","XRP":"ripple","LTC":"litecoin","BCH":"bitcoin-cash",
    "LINK":"chainlink","AVAX":"avalanche-2","MATIC":"polygon-pos","ATOM":"cosmos","XLM":"stellar",
    "SHIB":"shiba-inu","ARB":"arbitrum","APT":"aptos","NEAR":"near","UNI":"uniswap","OP":"optimism"
  };

  const $ = (s)=>document.querySelector(s);
  const el = {
    equity: $("#equityVal"), cash: $("#cashVal"), positions: $("#positionsVal"),
    pricesList: $("#pricesList"), priceStatus: $("#priceStatus"), lastUpdated: $("#lastUpdated"),
    refreshRate: $("#refreshRate"),
    customAdd: $("#customAdd"), addApply: $("#addApplyBtn"),
    tradeForm: $("#tradeForm"), tSymbol: $("#tradeSymbol"), tSide: $("#tradeSide"), tQty: $("#tradeQty"),
    estPrice: $("#estPrice"), estCost: $("#estCost"), tradeError: $("#tradeError"),
    pnlPreview: $("#pnlPreview"), maxQtyBtn: $("#maxQtyBtn"),
    tradeTable: $("#tradeTable"), reset: $("#resetBtn"), toastHost: $("#toastHost"),
    addSymInput: $("#addSymbolInput"), addSymBtn: $("#addSymbolBtn"), symbolsList: $("#symbolsList")
  };

  const LS_KEY = "mrteals.state.v1.4";
  let state = { cash:0, positions:{}, trades:[], positionsMeta:{}, symbols: SYMBOLS, cgIds: {} };
  try { const raw = localStorage.getItem(LS_KEY); if (raw) state = {...state, ...JSON.parse(raw)}; } catch {}
  SYMBOLS = state.symbols || SYMBOLS;

  const prices = new Map(); // symbol -> {price, ts, stale}
  const fmtUSD = (n) => { const v=Math.abs(Number(n)||0); const sign=Number(n)<0? "-" : ""; return `${sign}$${v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`; };
  const nowTime = ()=> new Date().toLocaleTimeString();
  const toast = (m)=>{ const t=document.createElement("div"); t.className="toast"; t.textContent=m; el.toastHost.appendChild(t); setTimeout(()=>t.remove(),2500); };
  const save = ()=> localStorage.setItem(LS_KEY, JSON.stringify(state));

  const holding = (sym)=> state.positions[sym] || 0;
  const avgCost = (sym)=> state.positionsMeta?.[sym]?.avg ?? null;

  // ---- Starting balance presets ----
  let selectedPreset = null;
  function wirePresets(){
    document.querySelectorAll(".amount-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        document.querySelectorAll(".amount-btn").forEach(b=>b.classList.remove("selected"));
        btn.classList.add("selected");
        selectedPreset = Number(btn.dataset.amt);
        el.customAdd.value = "";
      });
    });
    el.addApply.addEventListener("click", ()=>{
      const amt = selectedPreset ?? Number(el.customAdd.value);
      if(amt>0){ state.cash += amt; selectedPreset=null; document.querySelectorAll(".amount-btn").forEach(b=>b.classList.remove("selected")); el.customAdd.value=""; save(); toast(`Added ${fmtUSD(amt)} starting balance`); renderSnapshot(); recordEquityPoint(); renderChart(); }
    });
  }

  // ---- Prices + symbols ----
  function baseFromSymbol(sym){ return (sym.split("/")[0]||"").toUpperCase().trim(); }
  function coinbasePair(sym){ return sym.replace("/","-"); }

  async function resolveCGIdForSymbol(sym){
    const base = baseFromSymbol(sym);
    if (state.cgIds[base]) return state.cgIds[base];
    if (KNOWN_IDS[base]) { state.cgIds[base]=KNOWN_IDS[base]; save(); return KNOWN_IDS[base]; }
    try{
      const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(base)}`, {cache:"no-store"});
      const j = await res.json();
      const exact = (j?.coins||[]).find(c => (c.symbol||"").toUpperCase()===base);
      const best = exact || (j?.coins||[])[0];
      if (best?.id){ state.cgIds[base]=best.id; save(); return best.id; }
    }catch {}
    return null;
  }

  async function fetchCoinbaseSpot(sym){
    const url = `https://api.coinbase.com/v2/prices/${coinbasePair(sym)}/spot`;
    const r = await fetch(url,{cache:"no-store"});
    const j = await r.json();
    const price = Number(j?.data?.amount);
    if (Number.isFinite(price)) return price;
    throw new Error("coinbase price missing");
  }

  async function fetchPrices(){
    const ids = [];
    for (const sym of SYMBOLS){
      const id = await resolveCGIdForSymbol(sym);
      if (id) ids.push(id);
    }
    let ok=false;
    if(ids.length){
      const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
      try{
        const res = await fetch(cgUrl,{cache:"no-store"});
        if(res.ok){
          const data = await res.json();
          for (const sym of SYMBOLS){
            const id = await resolveCGIdForSymbol(sym);
            const price = id ? data?.[id]?.usd : undefined;
            if (typeof price === "number"){ prices.set(sym,{price,ts:Date.now(),stale:false}); ok=true; }
            else { prices.set(sym,{...(prices.get(sym)||{}), stale:true}); }
          }
        }
      }catch{}
    }
    for(const sym of SYMBOLS){
      const entry = prices.get(sym);
      if(!entry || entry.stale || entry.price == null){
        try{ const p = await fetchCoinbaseSpot(sym); prices.set(sym,{price:p,ts:Date.now(),stale:false}); ok=true; }catch{ prices.set(sym,{...(prices.get(sym)||{}), stale:true}); }
      }
    }
    el.priceStatus.textContent = ok ? "Live" : "Stale";
    el.lastUpdated.textContent = ok ? `Updated: ${nowTime()}` : "";
    renderPrices(); renderSnapshot(); recordEquityPoint(); if(currentRange==="LIVE") renderChart(); updateEstimate();
  }

  function renderPrices(){
    el.pricesList.innerHTML = "";
    SYMBOLS.forEach(sym=>{
      const li = document.createElement("li");
      const p = prices.get(sym);
      li.innerHTML = `<div class="sym">${sym}</div>
        <div class="val ${p?.stale?'stale':''}">${p?.price!=null?fmtUSD(p.price):'—'}</div>
        <button class="remove-btn" data-sym="${sym}" title="Remove from watchlist">×</button>`;
      el.pricesList.appendChild(li);
    });
    el.pricesList.querySelectorAll(".remove-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const sym = btn.getAttribute("data-sym");
        SYMBOLS = SYMBOLS.filter(s=>s!==sym);
        delete state.positions[sym];
        state.symbols = SYMBOLS; save();
        rebuildSymbolList(); renderPrices(); renderSnapshot(); updateEstimate();
      });
    });
  }

  function rebuildSymbolList(){
    el.symbolsList.innerHTML = "";
    SYMBOLS.forEach(sym=>{
      const o=document.createElement("option"); o.value=sym; el.symbolsList.appendChild(o);
    });
  }

  // ---- Trading + estimates ----
  const getPrice = (sym)=> prices.get(sym)?.price ?? null;

  function updateEstimate(){
    const sym = (el.tSymbol.value||"").toUpperCase().trim();
    const qty = Number(el.tQty.value);
    const p = getPrice(sym);
    el.estPrice.textContent = p? fmtUSD(p): "—";
    el.estCost.textContent = (p && qty>0)? fmtUSD(p*qty): "—";
    el.pnlPreview.hidden = true;
    if (p && qty>0 && el.tSide.value === "SELL"){
      const ac = avgCost(sym);
      const proceeds = p * qty;
      if (ac != null){
        const pnl = (p - ac) * qty;
        const pct = ac ? ((p-ac)/ac)*100 : 0;
        const cls = pnl >= 0 ? 'pos' : 'neg';
        el.pnlPreview.innerHTML = `If sell ${qty} ${sym}: Proceeds <b>${fmtUSD(proceeds)}</b> · P/L <b class="${cls}">${fmtUSD(pnl)}</b> (${pct.toFixed(2)}%)`;
        el.pnlPreview.hidden = false;
      }
    }
  }

  function canBuy(sym, qty){
    const p = getPrice(sym); if(!p) return {ok:false, reason:"Price unavailable"};
    const cost = p*qty; if(cost > state.cash + 1e-9) return {ok:false, reason:`Not enough cash: need ${fmtUSD(cost)}, have ${fmtUSD(state.cash)}`};
    return {ok:true};
  }
  function canSell(sym, qty){
    const held = state.positions[sym] || 0; if(qty > held + 1e-12) return {ok:false, reason:`Not enough holdings: have ${held}`};
    return {ok:true};
  }

  function executeTrade(sym, side, qty){
    const p = getPrice(sym); if(!p) throw new Error("Price unavailable");
    if(side==="BUY"){
      const v=canBuy(sym, qty); if(!v.ok) throw new Error(v.reason);
      state.cash -= p*qty;
      const prevQty = state.positions[sym] || 0;
      const prevAvg = avgCost(sym) ?? p;
      const newQty = prevQty + qty;
      const newAvg = newQty > 0 ? ((prevAvg*prevQty) + (p*qty)) / newQty : p;
      state.positions[sym] = newQty;
      state.positionsMeta[sym] = { avg: newAvg };
    } else {
      const v=canSell(sym, qty); if(!v.ok) throw new Error(v.reason);
      state.cash += p*qty;
      const prevQty = state.positions[sym] || 0;
      const ac = avgCost(sym) ?? p;
      const newQty = prevQty - qty;
      const pnl = (p - ac) * qty;
      state.positions[sym] = newQty;
      if (newQty <= 1e-12){ delete state.positions[sym]; delete state.positionsMeta[sym]; }
      state.trades.unshift({time: nowTime(), symbol:sym, side, qty:Number(qty), price:p, total:p*qty, pnl});
      save(); renderSnapshot(); renderTrades(); toast(`${side} ${qty} ${sym} @ ${fmtUSD(p)}`);
      updateEstimate(); recordEquityPoint(); if(currentRange==="LIVE") renderChart(); return;
    }
    state.trades.unshift({time: nowTime(), symbol:sym, side, qty:Number(qty), price:p, total:p*qty});
    save(); renderSnapshot(); renderTrades(); toast(`${side} ${qty} ${sym} @ ${fmtUSD(p)}`);
  }

  function renderTrades(){
    el.tradeTable.innerHTML = "";
    state.trades.forEach(tr=>{
      const r = document.createElement("tr");
      r.innerHTML = `<td>${tr.time}</td><td>${tr.symbol}</td><td class="${tr.side==="BUY"?"good":"bad"}">${tr.side}</td><td>${tr.qty}</td><td>${fmtUSD(tr.price)}</td><td>${fmtUSD(tr.total)}</td>`;
      el.tradeTable.appendChild(r);
    });
  }

  // ---- Chart ----
  let pollMs = 2000, pollTimer=null; const equityHistory=[]; let chart, currentRange="LIVE";
  function computePositionsValue(){
    return Object.entries(state.positions).reduce((sum,[sym,qty])=>{
      const p = prices.get(sym)?.price; return sum + (p? p*qty:0);
    },0);
  }
  function recordEquityPoint(){ const eq = state.cash + computePositionsValue(); equityHistory.push({t:Date.now(), v:eq}); const cutoff=Date.now()-7*24*60*60*1000; while(equityHistory.length && equityHistory[0].t<cutoff) equityHistory.shift(); }
  function startPoll(){ if(pollTimer) clearInterval(pollTimer); if(pollMs>0) pollTimer=setInterval(fetchPrices, pollMs); }
  el.refreshRate.addEventListener("change", ()=>{ pollMs = Number(el.refreshRate.value); startPoll(); if(pollMs>0) fetchPrices(); });

  function buildChart(){
    const ctx = document.getElementById("equityChart").getContext("2d");
    chart = new Chart(ctx,{ type:"line", data:{labels:[], datasets:[{label:"Equity", data:[], borderWidth:2, pointRadius:0, tension:0.25}]},
      options:{ animation:false, responsive:true, scales:{ x:{ticks:{color:"#9db2b2"}, grid:{color:"#24303a"}}, y:{ticks:{color:"#9db2b2"}, grid:{color:"#24303a"}} }, plugins:{legend:{display:false}} });
  }
  function renderChart(){
    if(!chart) return; const now=Date.now();
    const windows = { LIVE: Infinity, "1D":86400000,"1W":604800000,"1M":2592000000,"1Y":31536000000,"ALL":Infinity };
    const win = windows[currentRange];
    const slice = equityHistory.filter(p => win===Infinity ? true : (now-p.t)<=win);
    chart.data.labels = slice.map(p=> new Date(p.t).toLocaleTimeString());
    chart.data.datasets[0].data = slice.map(p=> p.v);
    chart.update();
  }
  document.addEventListener("click", (e)=>{
    const b=e.target.closest(".chip"); if(!b) return;
    document.querySelectorAll(".chip").forEach(c=>c.classList.remove("selected"));
    b.classList.add("selected"); currentRange=b.dataset.range; renderChart();
  });

  // ---- Events ----
  function renderSnapshot(){
    const pos = computePositionsValue();
    el.cash.textContent = fmtUSD(state.cash);
    el.positions.textContent = fmtUSD(pos);
    el.equity.textContent = fmtUSD(state.cash + pos);
  }

  el.tSymbol.addEventListener("input", updateEstimate);
  el.tQty.addEventListener("input", updateEstimate);
  el.tSide.addEventListener("change", updateEstimate);

  // Max button
  el.maxQtyBtn.addEventListener("click", ()=>{
    const sym = (el.tSymbol.value||"").toUpperCase().trim();
    const p = getPrice(sym); if (!sym || !p) return;
    if (el.tSide.value === "BUY"){
      const maxQty = Math.max(0, Math.floor((state.cash / p) * 1e6) / 1e6);
      el.tQty.value = maxQty > 0 ? String(maxQty) : "";
    } else {
      const hold = holding(sym);
      el.tQty.value = hold > 0 ? String(hold) : "";
    }
    updateEstimate();
  });

  // Add symbol to watchlist
  el.addSymBtn.addEventListener("click", async ()=>{
    let sym = (el.addSymInput.value||"").toUpperCase().trim();
    if(!sym || !sym.includes("/")){ toast("Enter symbol as TICKER/USD (e.g., TRX/USD)"); return; }
    if(SYMBOLS.includes(sym)){ toast("Already in watchlist"); return; }
    const id = await resolveCGIdForSymbol(sym);
    if(!id){ toast("Couldn't resolve symbol on CoinGecko"); return; }
    SYMBOLS.push(sym); state.symbols = SYMBOLS; save();
    rebuildSymbolList(); renderPrices(); el.addSymInput.value=""; fetchPrices(); toast(`Added ${sym}`);
  });

  el.tradeForm.addEventListener("submit", (e)=>{
    e.preventDefault();
    el.tradeError.hidden = true;
    const sym = (el.tSymbol.value||"").toUpperCase().trim();
    const side = el.tSide.value;
    const qty = Number(el.tQty.value);
    if(!SYMBOLS.includes(sym)){ el.tradeError.hidden=false; el.tradeError.textContent="Enter a valid symbol from the watchlist."; return; }
    if(!(qty>0)){ el.tradeError.hidden=false; el.tradeError.textContent="Enter a positive quantity."; return; }
    try { executeTrade(sym, side, qty); el.tQty.value=""; updateEstimate(); recordEquityPoint(); if(currentRange==="LIVE") renderChart(); }
    catch(err){ el.tradeError.hidden=false; el.tradeError.textContent = err.message || "Trade failed"; }
  });

  el.reset.addEventListener("click", ()=>{
    state = { cash:0, positions:{}, trades:[], positionsMeta:{}, symbols:["BTC/USD","ETH/USD","SOL/USD","DOT/USD","DOGE/USD"], cgIds:{} };
    SYMBOLS = state.symbols.slice(); save();
    rebuildSymbolList(); renderTrades(); renderSnapshot(); equityHistory.length=0; recordEquityPoint(); renderChart(); toast("Simulation reset");
  });

  function rebuildAll(){
    rebuildSymbolList(); renderPrices(); renderTrades(); renderSnapshot(); updateEstimate();
  }

  function boot(){
    SYMBOLS.forEach(sym=> prices.set(sym,{price:null, ts:null, stale:false}));
    rebuildAll(); buildChart(); recordEquityPoint(); renderChart();
    fetchPrices(); pollMs = Number(el.refreshRate.value||2000); if(pollMs>0) startPoll();
    wirePresets();
  }

  let pollMs = 2000, pollTimer=null;
  document.addEventListener("DOMContentLoaded", boot);
})();
