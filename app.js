// Client side logic for the Mr. Teals dashboard.
//
// This script establishes a WebSocket connection to the backend, polls
// periodic REST endpoints for account state and performance, and updates
// the DOM accordingly. It also wires up the control buttons and
// watchlist management UI to the corresponding REST endpoints.

(() => {
  // Determine the WebSocket URL. The backend is assumed to run on port
  // 8000 on the same host. When deploying behind a proxy, adjust this
  // accordingly or expose an environment variable via the frontend.
  // Define the API and WebSocket base URLs for production (Render backend).
  // When running locally, these can be left undefined to fall back to the
  // default localhost URLs. See fetchAPI below for details.
  const API_BASE = 'https://mr-teals-backend.onrender.com';
  // Use a fixed WebSocket URL pointing at the Render backend for production.
  const wsUrl = 'wss://mr-teals-backend.onrender.com/ws';
  let socket;

  function connectWebSocket() {
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      console.log('WebSocket connected');
    };
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'prices') {
          updatePrices(msg.data);
        } else if (msg.type === 'status') {
          console.log('Bot status:', msg.status);
        }
      } catch (err) {
        console.error('Failed to parse message', err);
      }
    };
    socket.onclose = () => {
      console.warn('WebSocket closed; reconnecting in 3s');
      setTimeout(connectWebSocket, 3000);
    };
    socket.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }
  connectWebSocket();

  async function fetchAPI(endpoint, method = 'GET', body = null) {
    // Build the full API URL using the configured API_BASE. When running locally,
    // API_BASE will be defined above and used. If API_BASE is undefined (e.g.
    // during development), the path remains relative to the frontend origin.
    const url = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api' + endpoint;
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(url, options);
    if (!res.ok) {
      console.error('API error', res.status);
    }
    return res.json();
  }

  async function refreshData() {
    try {
      const perf = await fetchAPI('/performance/today');
      document.getElementById('realized-pnl').textContent = perf.realized_pnl.toFixed(2);
      document.getElementById('unrealized-pnl').textContent = perf.unrealized_pnl.toFixed(2);
      document.getElementById('trades-count').textContent = perf.trades_count;
      const snapshot = await fetchAPI('/account/snapshot');
      document.getElementById('equity').textContent = snapshot.equity.toFixed(2);
      document.getElementById('cash').textContent = snapshot.cash.toFixed(2);
      document.getElementById('positions-value').textContent = snapshot.positions_value.toFixed(2);
      document.getElementById('account-unrealized-pnl').textContent = snapshot.unrealized_pnl.toFixed(2);
      const lastTrade = await fetchAPI('/trades/last');
      document.getElementById('last-symbol').textContent = lastTrade.symbol || 'N/A';
      document.getElementById('last-side').textContent = lastTrade.side || 'N/A';
      document.getElementById('last-qty').textContent = lastTrade.quantity != null ? lastTrade.quantity : 'N/A';
      document.getElementById('last-price').textContent = lastTrade.price != null ? lastTrade.price : 'N/A';
      document.getElementById('last-time').textContent = lastTrade.time || 'N/A';
      document.getElementById('last-strategy').textContent = lastTrade.strategy || 'N/A';
      const wl = await fetchAPI('/watchlist');
      renderWatchlist(wl.watchlist);
    } catch (err) {
      console.error('Failed to refresh data:', err);
    }
  }

  function updatePrices(data) {
    // Update the price column in the watchlist
    Object.keys(data).forEach((symbol) => {
      const price = data[symbol];
      const li = document.querySelector(`li[data-symbol="${symbol}"] span.price`);
      if (li) {
        li.textContent = price.toFixed(2);
      }
    });
  }

  function renderWatchlist(symbols) {
    const list = document.getElementById('watchlist');
    list.innerHTML = '';
    symbols.forEach((sym) => {
      const li = document.createElement('li');
      li.setAttribute('data-symbol', sym);
      const spanName = document.createElement('span');
      spanName.className = 'symbol';
      spanName.textContent = sym;
      const spanPrice = document.createElement('span');
      spanPrice.className = 'price';
      spanPrice.textContent = '-';
      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        await fetchAPI('/watchlist/remove?symbol=' + encodeURIComponent(sym), 'POST');
        refreshData();
      };
      li.appendChild(spanName);
      li.appendChild(spanPrice);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
  }

  // Control buttons
  document.getElementById('start-btn').onclick = async () => {
    await fetchAPI('/control/start', 'POST');
  };
  document.getElementById('pause-btn').onclick = async () => {
    await fetchAPI('/control/pause', 'POST');
  };
  document.getElementById('kill-btn').onclick = async () => {
    await fetchAPI('/control/kill', 'POST');
  };
  document.getElementById('add-symbol-btn').onclick = async () => {
    const symInput = document.getElementById('symbol-input');
    const sym = symInput.value.trim();
    if (sym) {
      await fetchAPI('/watchlist/add?symbol=' + encodeURIComponent(sym), 'POST');
      symInput.value = '';
      refreshData();
    }
  };

  // Initial data load and periodic refresh
  refreshData();
  setInterval(refreshData, 5_000);
})();
