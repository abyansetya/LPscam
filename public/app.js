const state = {
  owner: "",
  status: "",
  query: "",
  positions: [],
  selected: null,
};

const els = {
  form: document.querySelector("#walletForm"),
  wallet: document.querySelector("#walletInput"),
  search: document.querySelector("#searchInput"),
  searchButton: document.querySelector("#searchButton"),
  list: document.querySelector("#positionsList"),
  empty: document.querySelector("#emptyState"),
  panel: document.querySelector("#detailPanel"),
  detail: document.querySelector("#detailContent"),
  backdrop: document.querySelector("#panelBackdrop"),
  metricCount: document.querySelector("#metricCount"),
  metricInput: document.querySelector("#metricInput"),
  metricPnl: document.querySelector("#metricPnl"),
  metricFees: document.querySelector("#metricFees"),
  segments: Array.from(document.querySelectorAll(".segment")),
};

function money(value) {
  if (value == null || value === "") return "-";
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(number) >= 1000 ? 0 : 2,
  }).format(number);
}

function percent(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `${Number(value).toFixed(2)}%`;
}

function compact(value, size = 6) {
  if (!value) return "-";
  const text = String(value);
  return text.length > size * 2 + 3 ? `${text.slice(0, size)}...${text.slice(-size)}` : text;
}

function dateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatAge(position) {
  if (position.ageHour != null) {
    const hours = Number(position.ageHour);
    if (!Number.isFinite(hours)) return "-";
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 48) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  }
  if (position.age != null) {
    const days = Number(position.age);
    if (Number.isFinite(days)) return days < 1 ? `${(days * 24).toFixed(1)}h` : `${days.toFixed(1)}d`;
  }
  if (position.createdAt) {
    const hours = (Date.now() - new Date(position.createdAt).getTime()) / 36e5;
    if (Number.isFinite(hours)) return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
  }
  return "-";
}

function numberClass(value) {
  const number = Number(value || 0);
  if (number > 0) return "positive";
  if (number < 0) return "negative";
  return "";
}

function displayFee(position) {
  const collected = Number(position.collectedFee ?? position.fee ?? 0);
  const uncollected = Number(position.unCollectedFee ?? position.uncollectedFee ?? 0);
  return collected + uncollected;
}

function displayUpnl(position) {
  if (position.upnl != null && position.upnl !== "") return Number(position.upnl);
  if (position.pnl && position.pnl.value != null) return Number(position.pnl.value);
  return null;
}

function strategyName(position) {
  const raw = position.strategyType || position.inferredStrategyType || "";
  if (/bidask/i.test(raw)) return "Bid Ask";
  if (/curve/i.test(raw)) return "Curve";
  if (/spot/i.test(raw)) return "Spot";
  return raw
    .replace(/ImBalanced/g, " Imbalanced")
    .replace(/BidAsk/g, "Bid Ask")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function logoHtml(position) {
  const logo0 = position.logo0;
  const logo1 = position.logo1;
  const fallback0 = (position.tokenName0 || "T0").slice(0, 2).toUpperCase();
  const fallback1 = (position.tokenName1 || "T1").slice(0, 2).toUpperCase();
  return `
    <div class="logos">
      ${
        logo0
          ? `<img src="${logo0}" alt="" onerror="this.replaceWith(fallbackLogo('${fallback0}'))" />`
          : `<span class="fallback-logo">${fallback0}</span>`
      }
      ${
        logo1
          ? `<img src="${logo1}" alt="" onerror="this.replaceWith(fallbackLogo('${fallback1}'))" />`
          : `<span class="fallback-logo">${fallback1}</span>`
      }
    </div>
  `;
}

window.fallbackLogo = function fallbackLogo(label) {
  const span = document.createElement("span");
  span.className = "fallback-logo";
  span.textContent = label;
  return span;
};

function statusClass(status) {
  return String(status || "").toLowerCase() === "open" ? "status-open" : "status-closed";
}

function normalizePositions(payload) {
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.map((position) => ({
    ...position,
    id: position.position || position.tokenId,
  }));
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    wallet: params.get("wallet") || params.get("owner") || "",
    status: params.get("status") || "",
    query: params.get("q") || "",
  };
}

function writeUrlState({ replace = false } = {}) {
  const params = new URLSearchParams();
  if (state.owner) params.set("wallet", state.owner);
  if (state.status) params.set("status", state.status);
  if (state.query) params.set("q", state.query);
  const nextUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", nextUrl);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload && payload.message) || `Request failed: ${response.status}`);
  }
  return payload;
}

async function loadWallet(owner) {
  state.owner = owner.trim();
  state.selected = null;
  writeUrlState({ replace: true });
  els.list.innerHTML = `<div class="empty-state"><strong>Loading positions</strong><span>${compact(state.owner, 10)}</span></div>`;
  els.empty.classList.add("hidden");

  const params = new URLSearchParams({ history: "1" });
  if (state.status) params.set("status", state.status);
  const payload = await fetchJson(`/wallets/${encodeURIComponent(state.owner)}/positions?${params}`);
  state.positions = normalizePositions(payload);
  render();
}

function filteredPositions() {
  const query = state.query.trim().toLowerCase();
  return state.positions.filter((position) => {
    if (!query) return true;
    return [
      position.pairName,
      position.status,
      position.position,
      position.pool,
      position.token0,
      position.token1,
      position.strategyType,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
}

function renderSummary(positions) {
  const totals = positions.reduce(
    (sum, position) => {
      if (position.inputValue != null) sum.input += Number(position.inputValue || 0);
      if (position.pnl && position.pnl.value != null) sum.pnl += Number(position.pnl.value || 0);
      sum.fees += displayFee(position);
      return sum;
    },
    { input: 0, pnl: 0, fees: 0 },
  );
  els.metricCount.textContent = positions.length;
  els.metricInput.textContent = money(totals.input);
  els.metricPnl.textContent = money(totals.pnl);
  els.metricPnl.className = numberClass(totals.pnl);
  els.metricFees.textContent = money(totals.fees);
}

function positionRow(position) {
  const upnlValue = displayUpnl(position);
  const pnlPct = position.pnl && position.pnl.percent;
  const status = position.status || "-";
  const claimedFee = Number(position.collectedFee ?? position.fee ?? 0);
  const unclaimedFee = Number(position.unCollectedFee ?? position.uncollectedFee ?? 0);
  const strategy = strategyName(position);
  return `
    <button class="position-row ${state.selected === position.id ? "selected" : ""}" data-position="${position.id}">
      <span class="pair-cell">
        ${logoHtml(position)}
        <span>
          <span class="pair-title">
            ${position.pairName || "Unknown pair"}
            ${strategy ? `<span class="strategy-badge">${strategy}</span>` : ""}
          </span>
          <span class="mono">${compact(position.id)}</span>
        </span>
      </span>
      <span class="status-pill ${statusClass(status)}"><span class="status-dot"></span>${status}</span>
      <span class="number-cell">${money(position.value ?? position.currentValue)}</span>
      <span class="number-cell">${formatAge(position)}</span>
      <span class="number-cell">${money(claimedFee)} <span class="mono">| ${money(unclaimedFee)}</span></span>
      <span class="number-cell ${numberClass(upnlValue)}">${money(upnlValue)} <span class="mono">${percent(pnlPct)}</span></span>
    </button>
  `;
}

function render() {
  const positions = filteredPositions();
  renderSummary(positions);
  els.list.innerHTML = positions.map(positionRow).join("");
  els.empty.classList.toggle("hidden", positions.length > 0);

  els.list.querySelectorAll(".position-row").forEach((row) => {
    row.addEventListener("click", () => openDetail(row.dataset.position));
  });
}

function detailItem(label, value, className = "") {
  return `<div class="detail-item"><span>${label}</span><strong class="${className}">${value ?? "-"}</strong></div>`;
}

function sourceText(detail) {
  const raw = detail.sources && detail.sources.rawSources;
  if (!raw) return "-";
  return raw.historicalPrice || raw.events || detail.sources.detail || "-";
}

function eventsHtml(events) {
  if (!Array.isArray(events) || !events.length) {
    return `<div class="source-box"><strong>No event payload loaded</strong></div>`;
  }
  return `
    <div class="event-list">
      ${events
        .map(
          (event) => `
            <div class="event-row">
              <div>
                <strong>${event.actionType || event.eventType || "-"}</strong>
                <span>${compact(event.signature, 8)}</span>
              </div>
              <span>${dateTime(event.timestamp)}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderDetail(detail, events = detail.events) {
  const pnlValue = displayUpnl(detail);
  const claimedFee = Number(detail.collectedFee ?? detail.fee ?? 0);
  const unclaimedFee = Number(detail.unCollectedFee ?? detail.uncollectedFee ?? 0);
  els.detail.innerHTML = `
    <div class="panel-header">
      <div>
        <p class="eyebrow">${detail.protocol || "Position"}</p>
        <h2 class="panel-title">${detail.pairName || "Unknown pair"}</h2>
        ${strategyName(detail) ? `<span class="strategy-badge">${strategyName(detail)}</span>` : ""}
        <span class="mono">${detail.position || detail.tokenId}</span>
      </div>
      <button class="panel-close" id="panelClose" title="Close detail"><span class="icon">×</span></button>
    </div>

    <div class="pair-cell">
      ${logoHtml(detail)}
      <span class="status-pill ${statusClass(detail.status)}"><span class="status-dot"></span>${detail.status}</span>
    </div>

    <div class="detail-grid">
      ${detailItem("Input", money(detail.inputValue))}
      ${detailItem("Output", money(detail.outputValue))}
      ${detailItem("Current Value", money(detail.value || detail.currentValue))}
      ${detailItem("Claimed Fee", money(claimedFee))}
      ${detailItem("Unclaimed Fee", money(unclaimedFee))}
      ${detailItem("uPNL", `${money(pnlValue)} (${percent(detail.pnl && detail.pnl.percent)})`, numberClass(pnlValue))}
      ${detailItem("Age", formatAge(detail))}
      ${detailItem("DPR", percent(detail.dpr))}
      ${detailItem("Range", `${detail.tickLower ?? "-"} / ${detail.tickUpper ?? "-"}`)}
      ${detailItem("Strategy", detail.strategyType || detail.inferredStrategyType || "-")}
      ${detailItem("Created", dateTime(detail.createdAt))}
      ${detailItem("Closed", dateTime(detail.closeAt || detail.close_At))}
    </div>

    <p class="section-title">Addresses</p>
    <div class="detail-grid">
      ${detailItem("Pool", compact(detail.pool, 10))}
      ${detailItem("Owner", compact(detail.owner, 10))}
      ${detailItem("Token 0", compact(detail.token0, 10))}
      ${detailItem("Token 1", compact(detail.token1, 10))}
    </div>

    <p class="section-title">Source</p>
    <div class="source-box">
      <span>Pricing / Events</span>
      <strong>${sourceText(detail)}</strong>
    </div>

    <p class="section-title">Events</p>
    ${eventsHtml(events)}
  `;
  document.querySelector("#panelClose").addEventListener("click", closeDetail);
}

async function openDetail(positionId) {
  if (!positionId) return;
  state.selected = positionId;
  render();
  els.panel.classList.add("open");
  els.panel.setAttribute("aria-hidden", "false");
  els.detail.innerHTML = `<div class="empty-state"><strong>Loading detail</strong><span>${compact(positionId, 10)}</span></div>`;
  const listFallback = state.positions.find((position) => position.id === positionId);

  try {
    const payload = await fetchJson(`/positions/${encodeURIComponent(positionId)}?include=events`);
    renderDetail(payload.data);
  } catch (error) {
    if (listFallback) {
      renderDetail(listFallback, []);
      return;
    }
    els.detail.innerHTML = `
        <div class="panel-header">
          <div>
            <p class="eyebrow">Error</p>
            <h2 class="panel-title">Detail unavailable</h2>
          </div>
          <button class="panel-close" id="panelClose" title="Close detail"><span class="icon">×</span></button>
        </div>
        <div class="source-box"><strong>${error.message}</strong></div>
      `;
    document.querySelector("#panelClose").addEventListener("click", closeDetail);
  }
}

function closeDetail() {
  state.selected = null;
  els.panel.classList.remove("open");
  els.panel.setAttribute("aria-hidden", "true");
  render();
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.owner = els.wallet.value.trim();
  writeUrlState();
  loadWallet(els.wallet.value).catch((error) => {
    els.list.innerHTML = "";
    els.empty.classList.remove("hidden");
    els.empty.innerHTML = `<strong>Unable to load wallet</strong><span>${error.message}</span>`;
  });
});

els.search.addEventListener("input", () => {
  state.query = els.search.value;
  writeUrlState({ replace: true });
  render();
});

els.search.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    state.query = els.search.value;
    writeUrlState();
    render();
  }
});

els.searchButton.addEventListener("click", () => {
  state.query = els.search.value;
  writeUrlState();
  render();
});

els.segments.forEach((button) => {
  button.addEventListener("click", () => {
    els.segments.forEach((segment) => segment.classList.remove("active"));
    button.classList.add("active");
    state.status = button.dataset.status;
    writeUrlState();
    if (state.owner) loadWallet(state.owner);
  });
});

els.backdrop.addEventListener("click", closeDetail);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDetail();
});

window.addEventListener("popstate", () => {
  const urlState = readUrlState();
  state.status = urlState.status;
  state.query = urlState.query;
  els.search.value = state.query;
  els.segments.forEach((segment) => {
    segment.classList.toggle("active", segment.dataset.status === state.status);
  });
  if (urlState.wallet) {
    els.wallet.value = urlState.wallet;
    loadWallet(urlState.wallet);
  }
});

const initialUrlState = readUrlState();
if (initialUrlState.wallet) els.wallet.value = initialUrlState.wallet;
state.status = initialUrlState.status;
state.query = initialUrlState.query;
els.search.value = state.query;
els.segments.forEach((segment) => {
  segment.classList.toggle("active", segment.dataset.status === state.status);
});

loadWallet(els.wallet.value).catch((error) => {
  els.empty.classList.remove("hidden");
  els.empty.innerHTML = `<strong>Unable to load wallet</strong><span>${error.message}</span>`;
});
