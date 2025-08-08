// Client side logic for the Mr. Teals dashboard.
//
// This script establishes a WebSocket connection to the backend, polls
// periodic REST endpoints for account state and performance, and updates
// the DOM accordingly. It also wires up the control buttons and
// watchlist management UI to the corresponding REST endpoints.

(() => {
  // Dynamically create additional UI components (settings panel and equity chart)
  function buildAdditionalUI() {
    const main = document.querySelector('main');
    if (!main) return;
    // Inject minimal CSS for the new panels and fields. This keeps the UI
    // self‑contained without relying on style.css updates.
    const style = document.createElement('style');
    style.textContent = `
      #settings-section, #chart-section {
        margin-top: 1rem;
        background: rgba(0, 0, 0, 0.5);
        border-radius: 8px;
        padding: 1rem;
        box-shadow: 0 4px 8px rgba(0,0,0,0.4);
        backdrop-filter: blur(4px);
      }
      #settings-section h2, #chart-section h2 {
        margin-top: 0;
        font-size: 1.2rem;
        margin-bottom: 0.5rem;
      }
      .settings-field {
        display: flex;
        flex-direction: column;
        margin-bottom: 0.5rem;
      }
      .settings-field label {
        margin-bottom: 0.25rem;
        font-size: 0.9rem;
        color: #aacccc;
      }
      .settings-field input {
        padding: 0.5rem;
        border: none;
        border-radius: 4px;
        font-size: 0.9rem;
      }
      #save-settings-btn {
        margin-top: 0.5rem;
        padding: 0.5rem 1rem;
        background: #004444;
        border: none;
        border-radius: 6px;
        color: #fff;
        cursor: pointer;
        font-size: 0.9rem;
        transition: background 0.3s ease;
      }
      #save-settings-btn:hover {
        background: #006666;
      }
      #chart-section canvas {
        width: 100%;
        height: 300px;
      }
    `;
    document.head.appendChild(style);
    // Settings panel
    const settings = document.createElement('section');
    settings.id = 'settings-section';
    settings.innerHTML = `
      <h2>Trading Settings</h2>
      <div class="settings-field">
        <label for="position-size">Position Size (% of equity)</label>
        <input type="number" id="position-size" min="1" max="100" value="10">
      </div>
      <div class="settings-field">
        <label for="stop-loss">Stop Loss (%)</label>
        <input type="number" id="stop-loss" min="1" max="100" value="3">
      </div>
      <div class="settings-field">
        <label for="max-daily-loss">Max Daily Loss (%)</label>
        <input type="number" id="max-daily-loss" min="1" max="100" value="5">
      </div>
      <button id="save-settings-btn">Save Settings</button>
    `;
    // Append the settings panel near the end of the main content.
    main.appendChild(settings);
    // Chart panel
    const chart = document.createElement('section');
    chart.id = 'chart-section';
    chart.innerHTML = `
      <h2>Equity Over Time</h2>
      <canvas id="pnl-chart"></canvas>
    `;
    main.appendChild(chart);
  }
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

  // Chart object for visualising equity over time. We'll accumulate
  // equity values and timestamps (sampled each refresh interval) and
  // update the line chart accordingly. Chart.js is loaded in the
  // HTML head via CDN.
  let pnlChart;
  const pnlData = [];
  const pnlLabels = [];

  // Global variables for crypto detail modal and chart
  let cryptoChart;

  // Map watchlist symbols to CoinGecko coin IDs. Extend this mapping as new assets are added.
  const coinIdMap = {
    'BTC/USD': 'bitcoin',
    'BTCUSD': 'bitcoin',
    'ETH/USD': 'ethereum',
    'ETHUSD': 'ethereum',
    'SOL/USD': 'solana',
    'SOLUSD': 'solana',
    'DOGE/USD': 'dogecoin',
    'DOGEUSD': 'dogecoin',
    'ADA/USD': 'cardano',
    'ADAUSD': 'cardano',
  };

  /**
   * Open the crypto details modal for the given symbol.
   * Fetches price history and information from CoinGecko and displays them.
   * @param {string} sym - The watchlist symbol (e.g. BTC/USD or BTCUSD).
   */
  function openCryptoModal(sym) {
    const id = coinIdMap[sym] || coinIdMap[sym.replace('/', '')];
    if (!id) {
      alert('Details for this symbol are not available.');
      return;
    }
    const modal = document.getElementById('crypto-modal');
    const titleEl = document.getElementById('crypto-title');
    const timeframeButtons = document.querySelectorAll('#crypto-timeframes button');
    titleEl.textContent = `${sym} Details`;
    // Reset active timeframe buttons
    timeframeButtons.forEach((btn) => btn.classList.remove('active'));
    const defaultRange = '30';
    const defaultBtn = document.querySelector(`#crypto-timeframes button[data-range="${defaultRange}"]`);
    if (defaultBtn) defaultBtn.classList.add('active');
    // Load data for default range
    loadCryptoData(id, parseInt(defaultRange));
    // Set up click handlers for timeframe buttons
    timeframeButtons.forEach((btn) => {
      btn.onclick = () => {
        timeframeButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const range = parseInt(btn.getAttribute('data-range'));
        loadCryptoData(id, range);
      };
    });
    // Show modal
    modal.style.display = 'block';
    // Close handler
    const closeBtn = document.getElementById('crypto-close-btn');
    closeBtn.onclick = () => {
      modal.style.display = 'none';
    };
    // Hide modal when clicking outside content
    window.onclick = (event) => {
      if (event.target === modal) {
        modal.style.display = 'none';
      }
    };
  }

  /**
   * Fetch price history and info for a coin ID and update the modal.
   * @param {string} coinId - CoinGecko coin identifier (e.g. 'bitcoin').
   * @param {number} days - Number of days of price history to fetch.
   */
  async function loadCryptoData(coinId, days) {
    try {
      // Fetch price history
      const priceRes = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`);
      const priceData = await priceRes.json();
      const prices = priceData.prices || [];
      // Create labels and values based on range
      const labels = prices.map((p) => {
        const date = new Date(p[0]);
        if (days <= 7) {
          return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        } else if (days <= 30) {
          return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        } else if (days <= 365) {
          return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
        } else {
          return date.getFullYear().toString();
        }
      });
      const series = prices.map((p) => p[1]);
      updateCryptoChart(labels, series);
      // Fetch coin details
      const infoRes = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}`);
      const info = await infoRes.json();
      const infoContainer = document.getElementById('crypto-info');
      const marketCap = info.market_data?.market_cap?.usd;
      const circulating = info.market_data?.circulating_supply;
      const maxSupply = info.market_data?.max_supply;
      const desc = info.description?.en || '';
      infoContainer.innerHTML = `
        <p><strong>Market Cap:</strong> $${marketCap ? marketCap.toLocaleString() : 'N/A'}</p>
        <p><strong>Circulating Supply:</strong> ${circulating ? circulating.toLocaleString() : 'N/A'}</p>
        <p><strong>Max Supply:</strong> ${maxSupply ? maxSupply.toLocaleString() : 'N/A'}</p>
        <p>${desc ? desc.substring(0, 300) + '...' : ''}</p>
      `;
    } catch (err) {
      console.error('Failed to load crypto data:', err);
    }
  }

  /**
   * Update or initialize the crypto price chart.
   * @param {Array<string>} labels - X-axis labels.
   * @param {Array<number>} data - Price values.
   */
  function updateCryptoChart(labels, data) {
    const ctx = document.getElementById('crypto-chart');
    if (cryptoChart) {
      cryptoChart.data.labels = labels;
      cryptoChart.data.datasets[0].data = data;
      cryptoChart.update();
    } else {
      cryptoChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Price (USD)',
              data: data,
              borderColor: '#00cccc',
              borderWidth: 2,
              pointRadius: 0,
              fill: false,
              tension: 0.1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              display: true,
            },
            y: {
              beginAtZero: false,
            },
          },
        },
      });
    }
  }

  // buildAdditionalUI() is not used because the settings and chart panels
  // are defined statically in the HTML. Remove or comment out this call to
  // avoid creating duplicate elements.
  // buildAdditionalUI();
  function initChart() {
    const ctx = document.getElementById('pnl-chart');
    if (!ctx) return;
    pnlChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: pnlLabels,
        datasets: [
          {
            label: 'Equity',
            data: pnlData,
            borderColor: '#00cccc',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: 0.1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            display: false,
          },
          y: {
            beginAtZero: true,
          },
        },
      },
    });
  }

  function updateChart(equity) {
    if (!pnlChart) return;
    const timestamp = new Date().toLocaleTimeString();
    pnlLabels.push(timestamp);
    pnlData.push(equity);
    // Limit to last 50 points to keep chart readable
    if (pnlLabels.length > 50) {
      pnlLabels.shift();
      pnlData.shift();
    }
    pnlChart.update();
  }

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

  // Initialize the PnL chart when the script loads
  initChart();

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

      // Update the equity chart with the current total equity value
      updateChart(snapshot.equity);
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
      // Make the symbol clickable to open crypto details
      spanName.style.cursor = 'pointer';
      spanName.onclick = () => {
        openCryptoModal(sym);
      };
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

  // Save risk settings button handler
  const saveBtn = document.getElementById('save-settings-btn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const posSize = parseFloat(document.getElementById('position-size').value);
      const stopLoss = parseFloat(document.getElementById('stop-loss').value);
      const maxDaily = parseFloat(document.getElementById('max-daily-loss').value);
      // Send the updated risk settings to the backend. The backend will
      // ignore undefined values, so we only send what the user set.
      const body = {
        position_size: posSize,
        stop_loss_pct: stopLoss,
        max_daily_loss: maxDaily,
      };
      try {
        await fetchAPI('/settings/risk', 'POST', body);
        // Optionally refresh account and performance after saving
        refreshData();
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
    };
  }

  // Initial data load and periodic refresh
  refreshData();
  setInterval(refreshData, 5_000);
})();