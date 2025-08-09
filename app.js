/* Mr. Teals Phase 1.2 — Manual Trading (Fake Money, Live Prices with Fallback, Equity Chart) */
(() => {
  const SYMBOLS = ["BTC/USD","ETH/USD","SOL/USD","DOT/USD","DOGE/USD"];
  const CG_IDS = { "BTC/USD":"bitcoin","ETH/USD":"ethereum","SOL/USD":"solana","DOT/USD":"polkadot","DOGE/USD":"dogecoin" };

  const $ = (s)=>document.querySelector(s);
  const $$ = (s)=>Array.from(document.querySelectorAll(s));
  const el = {
    equity: $("#equityVal"), cash: $("#cashVal"), positions: $("#positionsVal"),
    pricesList: $("#pricesList"), priceStatus: $("#priceStatus"), lastUpdated: $("#lastUpdated"),
    refreshRate: $("#refreshRate"),
    customAdd: $("#customAdd"), addApply: $("#addApplyBtn"),
    tradeForm: $("#tradeForm"), tSymbol: $("#tradeSymbol"), tSide: $("#tradeSide"), tQty: $("#tradeQty"),
    estPrice: $("#estPrice"), estCost: $("#estCost"), tradeError: $("#tradeError"),
    tradeTable: $("#tradeTable"), reset: $("#resetBtn"), toastHost: $("#toastHost"),
  };

  const LS_KEY = "mrteals.state.v1.2";
  let state = { cash:0, positions:{}, trades:[] };
  try { const raw = localStorage.getItem(LS_KEY); if (raw) state = JSON.parse(raw);} catch {}
  const prices = new Map(); // symbol -> {price, ts, stale}

  const fmtUSD = (n) => {
    const v = Math.abs(Number(n) || 0); const sign = Number(n) < 0 ? "-" : "";
    return `${sign}$${v.toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2})}`;
  };
  const nowTime = ()=> new Date().toLocaleTimeString();
  const toast = (m)=>{ const t=document.createElement("div"); t.className="toast"; t.textContent=m; el.toastHost.appendChild(t); setTimeout(()=>t.remove(),2500); };
  const save = ()=> localStorage.setItem(LS_KEY, JSON.stringify(state));

  const computePositionsValue = ()=> Object.entries(state.positions).reduce((sum,[sym,qty])=>{
    const p = prices.get(sym)?.price; return sum + (p? p*qty:0);
  },0);

  function renderSnapshot(){
    const pos = computePositionsValue();
    el.cash.textContent = fmtUSD(state.cash);
    el.positions.textContent = fmtUSD(pos);
    el.equity.textContent = fmtUSD(state.cash + pos);
  }

  function renderPrices(){
    el.pricesList.innerHTML = "";
    SYMBOLS.forEach(sym=>{
      const row = document.createElement("li");
      const p = prices.get(sym);
      row.innerHTML = `<div class="sym">${sym}</div><div class="val ${p?.stale?'stale':''}">${p?.price!=null?fmtUSD(p.price):'—'}</div>`;
      el.pricesList.appendChild(row);
    });
  }

  async function fetchCoinbaseSpot(sym){
    // Coinbase expects "ETH-USD" etc
    const pair = sym.replace("/","-").replace("DOGE","DOGE").replace("DOT","DOT");
    const url = `https://api.coinbase.com/v2/prices/${pair}/spot`;
    const r = await fetch(url,{cache:"no-store"});
    const j = await r.json();
    const price = Number(j?.data?.amount);
    if (Number.isFinite(price)) return price;
    throw new Error("coinbase price missing");
  }

  async function fetchPrices(){
    // Try CoinGecko batch first
    const ids = Object.values(CG_IDS).join(",");
    const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    let ok = false;
    try{
      const res = await fetch(cgUrl,{cache:"no-store"});
      if(!res.ok) throw new Error("cg http");
      const data = await res.json();
      for(const sym of SYMBOLS){
        const id = CG_IDS[sym];
        const price = data?.[id]?.usd;
        if(typeof price === "number"){
          prices.set(sym,{price, ts:Date.now(), stale:false});
          ok = true;
        }else{
          // mark for fallback
          prices.set(sym,{...(prices.get(sym)||{}), stale:true});
        }
      }
    }catch(e){
      // cg failed, fall through to fallback
    }

    // Fallback for any stale/empty using Coinbase
    for(const sym of SYMBOLS){
      const entry = prices.get(sym);
      if(!entry || entry.stale || entry.price == null){
        try{
          const p = await fetchCoinbaseSpot(sym);
          prices.set(sym,{price:p, ts:Date.now(), stale:false});
          ok = true;
        }catch(e){
          const prev = prices.get(sym)||{};
          prices.set(sym,{...prev, stale:true});
        }
      }
    }

    el.priceStatus.textContent = ok ? "Live" : "Stale";
    el.lastUpdated.textContent = ok ? `Updated: ${nowTime()}` : "";
    renderPrices();
    renderSnapshot();
    recordEquityPoint();
    renderChart();
    updateEstimate();
  }

  const getPrice = (sym)=> prices.get(sym)?.price ?? null;
  function updateEstimate(){
    const sym = (el.tSymbol.value||"").toUpperCase().trim();
    const qty = Number(el.tQty.value);
    const p = getPrice(sym);
    el.estPrice.textContent = p? fmtUSD(p): "—";
    el.estCost.textContent = (p && qty>0)? fmtUSD(p*qty): "—";
  }

  function canBuy(sym, qty){
    const p = getPrice(sym); if(!p) return {ok:false, reason:"Price unavailable"};
    const cost = p*qty; if(cost > state.cash + 1e-9) return {ok:false, reason:`Not enough cash: need ${fmtUSD(cost)}, have ${fmtUSD(state.cash)}`};
    return {ok:true};
  }
  function canSell(sym, qty){
    const held = state.positions[sym]||0; if(qty > held + 1e-12) return {ok:false, reason:`Not enough holdings: have ${held}`};
    return {ok:true};
  }
  function executeTrade(sym, side, qty){
    const p = getPrice(sym); if(!p) throw new Error("Price unavailable");
    if(side==="BUY"){ const v=canBuy(sym, qty); if(!v.ok) throw new Error(v.reason); state.cash -= p*qty; state.positions[sym]=(state.positions[sym]||0)+qty; }
    else { const v=canSell(sym, qty); if(!v.ok) throw new Error(v.reason); state.cash += p*qty; state.positions[sym]=(state.positions[sym]||0)-qty; if(state.positions[sym]<1e-12) delete state.positions[sym]; }
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

  // Chart + refresh control
  let pollMs = 2000, pollTimer=null; const equityHistory=[]; let chart, currentRange="1D";
  function recordEquityPoint(){ const eq = state.cash + computePositionsValue(); equityHistory.push({t:Date.now(), v:eq}); const cutoff=Date.now()-7*24*60*60*1000; while(equityHistory.length && equityHistory[0].t<cutoff) equityHistory.shift(); }
  function startPoll(){ if(pollTimer) clearInterval(pollTimer); if(pollMs>0) pollTimer=setInterval(fetchPrices, pollMs); }
  el.refreshRate.addEventListener("change", ()=>{ pollMs = Number(el.refreshRate.value); startPoll(); if(pollMs>0) fetchPrices(); });

  function buildChart(){
    const ctx = document.getElementById("equityChart").getContext("2d");
    chart = new Chart(ctx, { type:"line", data:{ labels:[], datasets:[{label:"Equity", data:[], borderWidth:2, pointRadius:0, tension:0.25}] },
      options:{ animation:false, responsive:true, scales:{ x:{ticks:{color:"#9db2b2"}, grid:{color:"#24303a"}}, y:{ticks:{color:"#9db2b2"}, grid:{color:"#24303a"}} }, plugins:{legend:{display:false}} } });
  }
  function renderChart(){
    if(!chart) return; const now=Date.now(); const win={ "1D":86400000,"1W":604800000,"1M":2592000000,"1Y":31536000000,"ALL":Infinity }[currentRange];
    const slice = equityHistory.filter(p => currentRange==="ALL" || (now-p.t)<=win);
    chart.data.labels = slice.map(p=> new Date(p.t).toLocaleTimeString());
    chart.data.datasets[0].data = slice.map(p=> p.v);
    chart.update();
  }
  document.addEventListener("click", (e)=>{ const b=e.target.closest(".chip"); if(!b) return; document.querySelectorAll(".chip").forEach(c=>c.classList.remove("selected")); b.classList.add("selected"); currentRange=b.dataset.range; renderChart(); });

  // Events
  el.addApply.addEventListener("click", ()=>{
    const amt = Number(el.customAdd.value);
    if(amt>0){ state.cash += amt; save(); toast(`Added ${fmtUSD(amt)} starting balance`); el.customAdd.value=""; renderSnapshot(); recordEquityPoint(); renderChart(); }
  });

  el.tSymbol.addEventListener("input", updateEstimate);
  el.tQty.addEventListener("input", updateEstimate);
  el.tSide.addEventListener("change", updateEstimate);

  el.tradeForm.addEventListener("submit", (e)=>{
    e.preventDefault();
    el.tradeError.hidden = true;
    const sym = (el.tSymbol.value||"").toUpperCase().trim();
    const side = el.tSide.value;
    const qty = Number(el.tQty.value);
    if(!["BTC/USD","ETH/USD","SOL/USD","DOT/USD","DOGE/USD"].includes(sym)){ el.tradeError.hidden=false; el.tradeError.textContent="Enter a valid symbol from the list."; return; }
    if(!(qty>0)){ el.tradeError.hidden=false; el.tradeError.textContent="Enter a positive quantity."; return; }
    try { executeTrade(sym, side, qty); el.tQty.value=""; updateEstimate(); recordEquityPoint(); renderChart(); }
    catch(err){ el.tradeError.hidden=false; el.tradeError.textContent = err.message || "Trade failed"; }
  });

  el.reset.addEventListener("click", ()=>{
    state = { cash:0, positions:{}, trades:[] };
    save(); renderTrades(); renderSnapshot(); equityHistory.length=0; recordEquityPoint(); renderChart(); toast("Simulation reset");
  });

  function boot(){
    SYMBOLS.forEach(sym=> prices.set(sym,{price:null, ts:null, stale:false}));
    renderPrices(); renderTrades(); renderSnapshot(); updateEstimate(); buildChart(); recordEquityPoint(); renderChart();
    fetchPrices(); pollMs = Number(el.refreshRate.value||2000); if(pollMs>0) startPoll();
  }
  document.addEventListener("DOMContentLoaded", boot);
})();