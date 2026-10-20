import { icon, esc, STATUS, CARRIERS, SERVICES, badge, dateShort, dateMini, timeAgo, today, initials, clipped } from './ui.js';

const app = document.getElementById('app');
const NAV = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'shipments', label: 'All shipments', icon: 'box' },
  { id: 'tracking', label: 'Track package', icon: 'route' },
  { id: 'activity', label: 'Activity log', icon: 'activity' },
  { id: 'analytics', label: 'Analytics', icon: 'chart' },
  { id: 'import', label: 'Bulk import', icon: 'upload' },
  { id: 'team', label: 'Team members', icon: 'shield' },
  { id: 'automation', label: 'Integrations', icon: 'refresh' },
  { id: 'branding', label: 'Branding', icon: 'palette' },
];
const ACTIVE = ['pending', 'picked_up', 'in_transit', 'out_for_delivery'];
const statusOrder = ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception'];
const routeFromHash = () => {
  const id = window.location.hash.replace('#', '');
  return NAV.some((item) => item.id === id) ? id : 'overview';
};
let account = null;
let initialized = null;
let setupProtectionRequired = false;
let branding = { companyName:'Shipment Tracker',shortName:'ST',accent:'#4959db',supportEmail:'',trackingMessage:'Follow every milestone on the way to your destination.',hasLogo:false };
let brandVersion = 0;
const state = {
  page: routeFromHash(), shipments: [], loading: true, loadError: '',
  query: '', statusFilter: 'all', carrierFilter: 'all', sort: 'updated', listPage: 1,
  activityFilter: 'all', trackingQuery: '', trackedId: null, selectedId: null,
  modal: null, mobileMenu: false, saving: false, toast: null,
  capabilities: null, integrationData: null, integrationLoading: false,
  analyticsData: null, analyticsError:'', analyticsLoading:false, analyticsPeriod:30,
  importText:'', importName:'', importPreview:null, importLoading:false, importSkipDuplicates:true, importError:'',
};
let searchTimer;
let toastTimer;

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
  } catch {
    throw new Error('Cannot connect to the server. Check that it is running.');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`Server returned an unexpected response (${response.status}).`); }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.details = data.details;
    throw error;
  }
  return data;
}

async function fetchShipments({ initial = false } = {}) {
  if (initial) state.loading = true;
  try {
    const data = await api('/shipments');
    state.shipments = data.shipments;
    state.loadError = '';
  } catch (error) { state.loadError = error.message; }
  finally { state.loading = false; render(); }
}

function notify(message, type = 'success') {
  state.toast = { message, type };
  renderToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = null; renderToast(); }, 4200);
}
function renderToast() {
  const slot = document.getElementById('toast-slot');
  if (!slot) return;
  slot.innerHTML = state.toast
    ? `<div class="toast ${state.toast.type === 'error' ? 'toast-error' : ''}" role="status">${icon(state.toast.type === 'error' ? 'alert' : 'checkCircle', 19)}<span>${esc(state.toast.message)}</span><button type="button" class="icon-button mini" data-action="dismiss-toast" aria-label="Dismiss message">${icon('x', 16)}</button></div>`
    : '';
}

function metrics() {
  const count = Object.fromEntries(statusOrder.map((key) => [key, 0]));
  let overdue = 0;
  let attention = 0;
  for (const s of state.shipments) {
    if (count[s.status] !== undefined) count[s.status]++;
    const late = isLate(s);
    if (late) overdue++;
    if (late || s.status === 'exception') attention++;
  }
  return { count, total: state.shipments.length, active: ACTIVE.reduce((acc, status) => acc + count[status], 0),
    delivered: count.delivered, attention, overdue };
}
function activities() {
  return state.shipments.flatMap((s) => (s.events || []).map((event) => ({ ...event,
    shipmentId: s.id, trackingNumber: s.trackingNumber, carrier: s.carrier,
    recipientName: s.recipientName, route: `${s.originCity} → ${s.destinationCity}`,
  }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function shipment(id) { return state.shipments.find((s) => s.id === id); }
function getFiltered() {
  const q = state.query.toLowerCase().trim();
  const filtered = state.shipments.filter((s) => {
    const text = [s.trackingNumber, s.carrier, s.recipientName, s.recipientEmail, s.originCity,
      s.destinationCity, s.reference, s.packageDescription].join(' ').toLowerCase();
    const okStatus = state.statusFilter === 'all' ||
      (state.statusFilter === 'active' ? ACTIVE.includes(s.status) : s.status === state.statusFilter);
    return (!q || text.includes(q)) && okStatus &&
      (state.carrierFilter === 'all' || s.carrier === state.carrierFilter);
  });
  if (state.sort === 'eta') filtered.sort((a, b) => (a.estimatedDelivery || '9999').localeCompare(b.estimatedDelivery || '9999'));
  else if (state.sort === 'oldest') filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  else if (state.sort === 'recipient') filtered.sort((a, b) => a.recipientName.localeCompare(b.recipientName));
  else filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return filtered;
}

function buttonNew(extraClass = '') {
  if (account?.role === 'viewer') return '';
  return `<button type="button" class="btn btn-primary ${extraClass}" data-action="new">${icon('plus', 18)}<span>New shipment</span></button>`;
}
function downloadButton(extraClass = '') {
  return `<a class="btn btn-secondary ${extraClass}" href="/api/shipments/export.csv" download="shipments.csv">${icon('download', 17)}<span>Export CSV</span></a>`;
}
function pageHeader(kicker, title, desc, actions = '') {
  return `<div class="page-heading"><div class="page-heading-copy"><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="page-actions">${actions}</div></div>`;
}
function sidebar() {
  return `<aside class="sidebar ${state.mobileMenu ? 'is-open' : ''}" id="sidebar">
    <div class="sidebar-top">
      <a class="brand" href="#overview" aria-label="${esc(branding.companyName)} home">
        <span class="brand-mark">${brandMark()}</span><span><strong class="brand-workspace-name">${esc(branding.companyName)}</strong><small>OPERATIONS</small></span>
      </a>
      <div class="sidebar-label">WORKSPACE</div>
      <nav class="nav-links" aria-label="Primary navigation">${NAV.filter(item => (account?.role === 'admin' || !['team','automation','branding'].includes(item.id)) && (account?.role !== 'viewer' || item.id !== 'import')).map((item) => `<a class="nav-link ${state.page === item.id ? 'is-active' : ''}" href="#${item.id}" ${state.page === item.id ? 'aria-current="page"' : ''}>${icon(item.icon, 19)}<span>${item.label}</span>${state.page === item.id ? '<span class="nav-active-indicator"></span>' : ''}</a>`).join('')}</nav>
      <div class="sidebar-label tools-label">WORKSPACE INFO</div>
      <div class="workspace-note">${icon('shield', 18)}<div><strong>Local workspace</strong><span>Data saved on this server</span></div></div>
    </div>
    <div class="sidebar-bottom"><div class="sidebar-tip"><span class="sidebar-tip-icon">${icon('info', 20)}</span><strong>${state.capabilities?.aftershipConfigured ? 'Live tracking available' : 'Manual tracking ready'}</strong><p>${state.capabilities?.aftershipConfigured ? 'Connect shipments to sync with carriers automatically.' : 'Add AfterShip credentials to enable courier syncing.'}</p></div>
      <div class="profile"><div class="avatar">${esc(initials(account?.name || "User"))}</div><div><strong>${esc(account?.name || "User")}</strong><span>${esc(account?.role || "viewer")}</span></div><button class="signout" data-action="logout" type="button">Sign out</button></div>
    </div>
  </aside>`;
}
function topbar() {
  const label = NAV.find((item) => item.id === state.page)?.label || 'Overview';
  return `<header class="topbar">
    <div class="topbar-left"><button class="icon-button menu-button" type="button" data-action="menu" aria-label="Toggle menu" aria-expanded="${state.mobileMenu}">${icon('menu', 23)}</button>
    <div class="breadcrumbs"><span>Workspace</span>${icon('chevronRight', 14)}<strong>${label}</strong></div></div>
    <div class="topbar-right"><span class="today-label">${icon('calendar', 16)} ${dateShort(today())}</span>
      <span class="topbar-separator"></span><button class="icon-button notification-button" type="button" data-action="go-activity" aria-label="View activity log">${icon('bell', 20)}</button>
      <div class="topbar-avatar" title="${esc(account?.name || "User")}">${esc(initials(account?.name || "User"))}</div></div>
  </header>`;
}

function kpi(label, number, sub, glyph, tone, suffix = '') {
  return `<article class="kpi-card"><div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-icon kpi-${tone}">${icon(glyph, 20)}</span></div>
  <div class="kpi-number">${number.toLocaleString('en-IN')}${suffix ? `<span>${suffix}</span>` : ''}</div>
  <div class="kpi-sub">${sub}</div></article>`;
}
function sectionHeading(title, subtitle, action = '') {
  return `<div class="panel-heading"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>${action}</div>`;
}
function statusGraph(info) {
  const keys = ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception'];
  const colors = { pending: '#9ca8bb', picked_up: '#46abed', in_transit: '#5965e9', out_for_delivery: '#aa87e6', delivered: '#2fb99b', exception: '#e97870' };
  return `<article class="panel status-panel">
    ${sectionHeading('Shipment distribution', 'Current status across all records')}
    <div class="status-graph">${info.total ? keys.filter((k) => info.count[k]).map((k) => `<div title="${STATUS[k].label}: ${info.count[k]}" style="flex:${info.count[k]};background:${colors[k]}"></div>`).join('') : '<div class="graph-empty"></div>'}</div>
    <div class="legend-grid">${keys.map((k) => `<div class="legend-item"><span class="legend-dot" style="background:${colors[k]}"></span><span>${STATUS[k].label}</span><strong>${info.count[k]}</strong></div>`).join('')}</div>
  </article>`;
}
function dailyTrend() {
  const logs = activities();
  const entries = [];
  for (let offset = 6; offset >= 0; offset--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - offset);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    entries.push({ day, label: new Intl.DateTimeFormat('en-IN', { weekday: 'short' }).format(d),
      count: logs.filter((x) => {
        const date = new Date(x.createdAt);
        const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return dateKey === day;
      }).length });
  }
  const highest = Math.max(1, ...entries.map((x) => x.count));
  const sum = entries.reduce((acc, x) => acc + x.count, 0);
  return `<article class="panel trend-panel">${sectionHeading('Shipment activity', 'Tracking events added in the last 7 days')}
    <div class="trend-summary"><strong>${sum.toLocaleString('en-IN')}</strong><span>events this week</span></div>
    <div class="bar-chart" role="img" aria-label="Activity over last seven days: ${entries.map((x) => `${x.label} ${x.count}`).join(', ')}">
      ${entries.map((x, index) => `<div class="bar-group"><span class="bar-value">${x.count || ''}</span><div class="bar-track"><div class="bar-fill ${index === 6 ? 'bar-current' : ''}" style="height:${Math.max(x.count ? 10 : 3, Math.round(x.count / highest * 100))}%"></div></div><span class="bar-day">${x.label}</span></div>`).join('')}
    </div>
  </article>`;
}
function emptyState({ title = 'No shipments yet', detail = 'Create your first shipment to begin tracking its delivery journey.', action = true, glyph = 'box' } = {}) {
  return `<div class="empty-state"><div class="empty-illustration">${icon(glyph, 29)}</div><h3>${title}</h3><p>${detail}</p>${action ? buttonNew('btn-sm') : ''}</div>`;
}
function shipmentTable(items, { compact = false, selectable = false } = {}) {
  if (!items.length) return emptyState();
  return `<div class="table-wrap"><table class="ship-table"><thead><tr><th>SHIPMENT</th><th>ROUTE</th><th>CARRIER</th><th>EST. DELIVERY</th><th>STATUS</th><th><span class="visually-hidden">Details</span></th></tr></thead>
  <tbody>${items.map((s) => `<tr class="shipment-row" data-action="${selectable ? 'track-select' : 'open'}" data-id="${esc(s.id)}" tabindex="0" role="button" aria-label="Open shipment ${esc(s.trackingNumber)}">
    <td><div class="shipment-cell"><span class="table-package-icon">${icon('box', 19)}</span><span><strong>${esc(clipped(s.trackingNumber, 23))}</strong><small>${esc(clipped(s.recipientName, 24))}</small></span></div></td>
    <td><div class="route-cell"><strong>${esc(clipped(s.originCity, 16))}</strong>${icon('arrowRight', 13)}<strong>${esc(clipped(s.destinationCity, 16))}</strong></div></td>
    <td><span class="carrier-name">${esc(s.carrier)}</span></td>
    <td><span class="delivery-date ${isLate(s) ? 'late' : ''}">${s.estimatedDelivery ? dateMini(s.estimatedDelivery) : 'Not set'}${isLate(s) ? '<small>Overdue</small>' : ''}</span></td>
    <td>${badge(s.status)}</td><td class="row-go">${icon('chevronRight', 19)}</td></tr>`).join('')}</tbody></table></div>`;
}
function isLate(s) { return Boolean(s.estimatedDelivery && s.estimatedDelivery < today() && s.status !== 'delivered'); }
function recentActivityPanel(limit = 5) {
  const list = activities().slice(0, limit);
  return `<article class="panel recent-activity">${sectionHeading('Recent activity', 'Latest tracking milestones', `<a href="#activity" class="text-link">View all ${icon('arrowRight', 15)}</a>`)}
    ${list.length ? `<div class="activity-feed">${list.map((e) => `<button type="button" class="feed-item" data-action="open" data-id="${esc(e.shipmentId)}"><span class="feed-icon ${STATUS[e.status]?.tone || 'slate'}">${icon(STATUS[e.status]?.icon || 'box', 18)}</span><span class="feed-copy"><strong>${esc(STATUS[e.status]?.label || e.status)}</strong><small>${esc(e.trackingNumber)} · ${esc(e.carrier)}</small></span><time>${timeAgo(e.createdAt)}</time></button>`).join('')}</div>` : emptyState({ title: 'No activity yet', detail: 'Shipment updates will appear here.', action: false, glyph: 'activity' })}
  </article>`;
}
function overview() {
  const info = metrics();
  const recents = [...state.shipments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return `${pageHeader('OPERATIONS / OVERVIEW', 'Shipment overview', 'A clearer picture of every package, at every stage.', `${downloadButton()}${buttonNew()}`)}
    <div class="overview-intro"><span class="intro-pulse"></span><strong>Workspace ready</strong><span>Manual updates and optional courier sync in one place.</span><span class="intro-right">${icon('clock', 15)} Updated just now</span></div>
    <div class="kpi-grid">${kpi('Total shipments', info.total, 'All saved records', 'box', 'indigo')}
      ${kpi('In progress', info.active, 'Awaiting final delivery', 'truck', 'blue')}
      ${kpi('Delivered', info.delivered, 'Successfully completed', 'packageCheck', 'green')}
      ${kpi('Needs attention', info.attention, `${info.overdue} overdue · ${info.count.exception} exceptions`, 'alert', 'red')}
    </div>
    <div class="insights-grid">${statusGraph(info)}${dailyTrend()}</div>
    <div class="bottom-grid"><article class="panel recent-shipments">${sectionHeading('Recent shipments', 'A quick look at recently updated packages', `<a href="#shipments" class="text-link">View all ${icon('arrowRight', 15)}</a>`)}
    ${recents.length ? shipmentTable(recents, { compact: true }) : emptyState()}</article>${recentActivityPanel()}</div>`;
}

const FILTERS = [
  ['all', 'All shipments'], ['active', 'Active'], ['in_transit', 'In transit'],
  ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered'], ['exception', 'Exceptions'],
];
function shipmentResults() {
  const all = getFiltered();
  const pageCount = Math.max(1, Math.ceil(all.length / 9));
  state.listPage = Math.min(pageCount, Math.max(1, state.listPage));
  const visible = all.slice((state.listPage - 1) * 9, state.listPage * 9);
  return `<div class="results-heading"><span><strong>${all.length}</strong> shipment${all.length === 1 ? '' : 's'} found</span><span>Showing ${all.length ? (state.listPage - 1) * 9 + 1 : 0}–${Math.min(all.length, state.listPage * 9)} of ${all.length}</span></div>
    ${visible.length ? shipmentTable(visible) : emptyState({ title: state.shipments.length ? 'No matching shipments' : 'No shipments yet',
      detail: state.shipments.length ? 'Try different filters or a broader search.' : 'Add a new shipment to get started.',
      action: !state.shipments.length, glyph: state.shipments.length ? 'search' : 'box' })}
    ${pageCount > 1 ? `<div class="pagination"><span>Page ${state.listPage} of ${pageCount}</span><div><button class="pagination-button" data-action="previous" ${state.listPage === 1 ? 'disabled' : ''}>${icon('arrowLeft', 16)} Previous</button><button class="pagination-button" data-action="next" ${state.listPage === pageCount ? 'disabled' : ''}>Next ${icon('arrowRight', 16)}</button></div></div>` : ''}`;
}
function shipmentList() {
  const counts = metrics();
  const carriers = Array.from(new Set([...CARRIERS, ...state.shipments.map((s) => s.carrier)]));
  return `${pageHeader('OPERATIONS / SHIPMENTS', 'All shipments', 'Manage package details, delivery progress, and exceptions.', `${account?.role !== 'viewer' ? `<a class="btn btn-secondary" href="#import">${icon('upload',16)} Import CSV</a>` : ''}${downloadButton()}${buttonNew()}`)}
    <section class="panel list-panel"><div class="list-tabs" role="group" aria-label="Shipment status filters">${FILTERS.map(([value, label]) => `<button type="button" class="filter-tab ${state.statusFilter === value ? 'active' : ''}" data-action="filter-status" data-value="${value}">${label}${value === 'all' ? `<span class="tab-count">${counts.total}</span>` : ''}</button>`).join('')}</div>
    <div class="toolbar"><label class="search-field">${icon('search', 18)}<input id="shipment-search" type="search" placeholder="Search ID, recipient, route, carrier..." value="${esc(state.query)}" autocomplete="off" aria-label="Search shipments"><span class="search-shortcut">/</span></label>
      <div class="toolbar-right"><label class="select-wrap">${icon('filter', 16)}<select id="carrier-filter" aria-label="Filter by carrier"><option value="all">All carriers</option>${carriers.map((carrier) => `<option value="${esc(carrier)}" ${state.carrierFilter === carrier ? 'selected' : ''}>${esc(carrier)}</option>`).join('')}</select>${icon('chevronDown', 15)}</label>
      <label class="select-wrap sort-select"><select id="sort-order" aria-label="Sort shipments"><option value="updated" ${state.sort === 'updated' ? 'selected' : ''}>Recently updated</option><option value="eta" ${state.sort === 'eta' ? 'selected' : ''}>Delivery ETA</option><option value="oldest" ${state.sort === 'oldest' ? 'selected' : ''}>Oldest first</option><option value="recipient" ${state.sort === 'recipient' ? 'selected' : ''}>Recipient name</option></select>${icon('chevronDown', 15)}</label></div>
    </div><div id="shipment-results">${shipmentResults()}</div></section>`;
}

function statusJourney(s) {
  const stages = ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'];
  const reached = Math.max(0, stages.indexOf(s.status));
  const activeIndex = s.status === 'exception'
    ? Math.max(0, ...s.events.map((e) => stages.indexOf(e.status))) : reached;
  return `<div class="journey"><div class="journey-track">${stages.map((key, index) => `<div class="journey-stage ${index <= activeIndex ? 'reached' : ''} ${index === activeIndex ? 'current' : ''}"><span class="journey-dot">${index < activeIndex ? icon('check', 14) : index + 1}</span><small>${STATUS[key].label}</small></div>`).join('')}</div>
  ${s.status === 'exception' ? `<p class="journey-alert">${icon('alert', 17)} Delivery exception reported. Review the latest update.</p>` : ''}</div>`;
}
function timeline(s, { compact = false } = {}) {
  const events = [...(s.events || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `<div class="timeline ${compact ? 'timeline-compact' : ''}">${events.map((e, index) => `<div class="timeline-item ${index === 0 ? 'latest' : ''}"><span class="timeline-node">${icon(STATUS[e.status]?.icon || 'box', 17)}</span><div class="timeline-body"><div class="timeline-head"><strong>${esc(STATUS[e.status]?.label || e.status)}</strong><time>${dateShort(e.createdAt)} · ${new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(e.createdAt))}</time></div><p>${esc(e.description)}</p>${e.location ? `<span class="timeline-location">${icon('mapPin', 13)} ${esc(e.location)}</span>` : ''}</div></div>`).join('')}</div>`;
}
function tracking() {
  const q = state.trackingQuery.toLowerCase().trim();
  const matches = q ? state.shipments.filter((s) => [s.trackingNumber, s.recipientName, s.reference].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 8) : [];
  const selected = shipment(state.trackedId) || (matches.length === 1 ? matches[0] : null);
  return `${pageHeader('OPERATIONS / LOOKUP', 'Track a package', 'Find a parcel and review its complete, recorded delivery journey.', buttonNew())}
  <section class="tracking-search-card"><div class="tracking-search-content"><span class="tracking-kicker">${icon('route', 17)} SHIPMENT LOOKUP</span><h2>Where is your package?</h2><p>Search your saved shipments by tracking number, recipient name, or order reference.</p>
    <form id="track-form" class="tracking-search-form"><label class="tracking-input">${icon('search', 21)}<input id="tracking-input" name="trackingQuery" placeholder="e.g. DEMO-BD-732490" value="${esc(state.trackingQuery)}" aria-label="Tracking number or recipient name" required><button type="submit" class="btn btn-primary">Find shipment ${icon('arrowRight', 17)}</button></label></form>
    <div class="tracking-hint">${icon('info', 16)} Results come from your workspace. Connected shipments can sync their courier milestones.</div>
    </div><div class="tracking-decoration" aria-hidden="true"><div class="orbit orbit-outer"></div><div class="orbit orbit-inner"></div><div class="tracking-deco-icon">${icon('box', 46)}</div><span class="deco-point deco-point-a"></span><span class="deco-point deco-point-b"></span></div></section>
  ${q && matches.length === 0 ? `<section class="panel tracking-outcome">${emptyState({ title: 'No package found', detail: 'Check the tracking number or try a recipient name.', action: false, glyph: 'search' })}</section>` : ''}
  ${q && matches.length > 1 && (!selected || !matches.some((s) => s.id === selected.id)) ? `<section class="panel tracking-matches">${sectionHeading(`${matches.length} matching shipments`, 'Select a package to see its journey')}${shipmentTable(matches, { selectable: true })}</section>` : ''}
  ${selected && q ? `<div class="tracked-details"><div class="tracked-summary panel"><div class="tracked-top"><div><span class="card-eyebrow">TRACKING NUMBER</span><h2>${esc(selected.trackingNumber)}</h2><p>${esc(selected.carrier)} · ${esc(selected.service)}</p></div>${badge(selected.status)}</div>
    <div class="tracked-route"><div><small>FROM</small><strong>${esc(selected.originCity)}</strong></div><div class="route-mid">${icon('truck', 24)}<span></span></div><div><small>TO</small><strong>${esc(selected.destinationCity)}</strong></div></div>
    <div class="tracked-facts"><div><small>Recipient</small><strong>${esc(selected.recipientName)}</strong></div><div><small>Estimated delivery</small><strong>${dateShort(selected.estimatedDelivery)}</strong></div><div><small>Last location</small><strong>${esc(selected.location || 'Not recorded')}</strong></div></div>
    ${statusJourney(selected)}<button class="btn btn-secondary btn-sm" data-action="open" data-id="${esc(selected.id)}">View full details ${icon('arrowRight', 16)}</button></div>
    <div class="panel tracked-events">${sectionHeading('Tracking history', `${selected.events.length} recorded milestones`)}${timeline(selected, { compact: true })}</div></div>` : ''}`;
}
function activityPage() {
  const events = activities().filter((e) => state.activityFilter === 'all' || e.status === state.activityFilter);
  return `${pageHeader('OPERATIONS / HISTORY', 'Activity log', 'An audit trail of shipment updates in this workspace.', buttonNew())}
    <section class="panel activity-panel"><div class="activity-panel-top">${sectionHeading('All activity', `${events.length} tracking events recorded`)}<label class="select-wrap">${icon('filter', 16)}<select id="activity-filter" aria-label="Filter activity status"><option value="all">All updates</option>${statusOrder.map((key) => `<option value="${key}" ${state.activityFilter === key ? 'selected' : ''}>${STATUS[key].label}</option>`).join('')}</select>${icon('chevronDown', 15)}</label></div>
    ${events.length ? `<div class="activity-list">${events.slice(0, 100).map((e) => `<button class="activity-entry" type="button" data-action="open" data-id="${esc(e.shipmentId)}"><span class="activity-symbol ${STATUS[e.status]?.tone || 'slate'}">${icon(STATUS[e.status]?.icon || 'box', 19)}</span><span class="activity-description"><strong>${esc(STATUS[e.status]?.label || e.status)} <span>· ${esc(e.trackingNumber)}</span></strong><small>${esc(e.description)}</small><span class="activity-meta">${esc(e.carrier)} ${e.location ? ` · ${esc(e.location)}` : ''}</span></span><span class="activity-time">${timeAgo(e.createdAt)}<small>${dateMini(e.createdAt)}</small></span>${icon('chevronRight', 17, 'activity-chevron')}</button>`).join('')}</div>${events.length > 100 ? '<p class="list-limit">Showing 100 most recent events.</p>' : ''}` : emptyState({ title: 'No activity to show', detail: 'Try another status, or update a shipment to create a new event.', action: false, glyph: 'activity' })}</section>`;
}

function linkFor(s) { return s?.shareToken ? `${window.location.origin}/track/${encodeURIComponent(s.shareToken)}` : ''; }
function sharingSection(s) {
  const enabled = Boolean(s.shareToken), canEdit = account?.role !== 'viewer';
  const link = linkFor(s);
  return `<div class="drawer-block"><div class="drawer-block-heading"><h3>Public tracking link</h3>${icon('external', 18)}</div>
    <p class="feature-helper">Share a read-only tracking page. The recipient's email, internal notes and order details stay private.</p>
    ${enabled ? `<div class="share-link-value" title="${esc(link)}">${icon('external', 17)}<span>${esc(link)}</span></div>
      <div class="feature-actions"><button type="button" class="btn btn-secondary btn-sm" data-action="copy-share">${icon('copy', 15)} Copy link</button><a class="btn btn-secondary btn-sm" href="${esc(link)}" rel="noopener noreferrer" target="_blank">${icon('external', 15)} Open</a></div>
      ${canEdit ? `<div class="feature-actions"><button class="btn btn-linkish btn-sm" type="button" data-action="rotate-share">Rotate link</button><button class="btn btn-linkish text-danger btn-sm" type="button" data-action="disable-share">Disable link</button></div>` : ''}`
      : `<p class="feature-subtle">Link sharing is off for this shipment.</p>${canEdit ? `<button class="btn btn-secondary btn-sm" type="button" data-action="enable-share">${icon('external', 15)} Enable tracking link</button>` : ''}`}
  </div>`;
}
function providerSection(s) {
  const connected = Boolean(s.providerTrackingId), canEdit = account?.role !== 'viewer';
  return `<div class="drawer-block"><div class="drawer-block-heading"><h3>Courier synchronization</h3><span class="integration-chip ${connected ? 'chip-live' : ''}">${connected ? 'Connected' : 'Manual'}</span></div>
    <p class="feature-helper">${connected ? 'AfterShip can pull new carrier checkpoints on schedule and receive signed webhooks.' : 'Your saved milestones stay available even when no courier API is connected.'}</p>
    ${connected ? `<dl class="sync-meta"><div><dt>Provider</dt><dd>AfterShip · ${esc(s.providerSlug || s.carrier)}</dd></div><div><dt>Last synced</dt><dd>${s.lastSyncedAt ? dateShort(s.lastSyncedAt) : 'Not yet'}</dd></div></dl>
    ${s.syncError ? `<p class="inline-error">${icon('alert', 16)} ${esc(s.syncError)}</p>` : ''}
    ${canEdit ? `<div class="feature-actions"><button class="btn btn-secondary btn-sm" type="button" data-action="sync-one">${icon('refresh', 15)} Sync now</button><button class="btn btn-linkish btn-sm" type="button" data-action="disconnect-one">Disconnect</button></div>` : ''}`
      : state.capabilities?.aftershipConfigured ? (canEdit ? `<button type="button" class="btn btn-secondary btn-sm" data-action="connect-one">${icon('plus', 15)} Connect courier</button>` : '')
        : `<p class="feature-subtle">Add AFTERSHIP_API_KEY to the server environment to enable this feature.</p>`}
    <div class="notification-optin">${icon('bell', 16)} Recipient emails: <strong>${s.notificationOptIn ? 'Opted in' : 'Off'}</strong> · ${state.capabilities?.notificationsConfigured ? 'Sender ready' : 'Sender not configured'}</div>
  </div>`;
}
function detailDrawer() {
  const s = shipment(state.selectedId);
  if (!s) return '';
  return `<div class="overlay drawer-overlay" data-action="close-drawer"><aside class="drawer" role="dialog" aria-modal="true" aria-label="Shipment details"><div class="drawer-heading"><div><span class="drawer-eyebrow">SHIPMENT DETAILS</span><h2>Shipment overview</h2></div><button type="button" class="icon-button" data-action="close-drawer" aria-label="Close shipment details">${icon('x', 21)}</button></div>
    <div class="drawer-scroll"><div class="drawer-shipment-header"><span class="drawer-box">${icon('box', 30)}</span><div class="tracking-caption">Tracking ID</div><h3>${esc(s.trackingNumber)}</h3><div class="drawer-subtitle">${esc(s.carrier)} <span>·</span> ${esc(s.service)}</div><div class="drawer-current-status">${badge(s.status)}<button class="copy-mini" data-action="copy" data-value="${esc(s.trackingNumber)}" aria-label="Copy tracking number">${icon('copy', 15)} Copy</button></div></div>
    <div class="drawer-block"><div class="drawer-block-heading"><h3>Delivery route</h3>${icon('route', 18)}</div><div class="route-vertical"><div class="route-end"><span class="route-pin origin-pin"></span><div><small>ORIGIN</small><strong>${esc(s.originCity)}</strong></div></div><div class="route-end"><span class="route-pin destination-pin"></span><div><small>DESTINATION</small><strong>${esc(s.destinationCity)}</strong></div></div></div></div>
    <div class="drawer-block"><div class="drawer-block-heading"><h3>Shipment information</h3>${icon('list', 18)}</div><dl class="detail-grid">
      <div><dt>Recipient</dt><dd>${esc(s.recipientName)}</dd></div><div><dt>Service type</dt><dd>${esc(s.service)}</dd></div>
      <div><dt>Estimated delivery</dt><dd class="${isLate(s) ? 'text-danger' : ''}">${dateShort(s.estimatedDelivery)}${isLate(s) ? ' · Overdue' : ''}</dd></div>
      <div><dt>Ship date</dt><dd>${dateShort(s.shippedAt)}</dd></div>
      <div><dt>Weight</dt><dd>${s.weightKg != null ? `${esc(s.weightKg)} kg` : 'Not set'}</dd></div>
      <div><dt>Order reference</dt><dd>${esc(s.reference || 'Not set')}</dd></div>
      <div><dt>Last location</dt><dd>${esc(s.location || 'Not recorded')}</dd></div><div><dt>Email</dt><dd>${esc(s.recipientEmail || 'Not set')}</dd></div>
      <div class="detail-grid-full"><dt>Package description</dt><dd>${esc(s.packageDescription || 'Not provided')}</dd></div>
      ${s.notes ? `<div class="detail-grid-full"><dt>Notes</dt><dd>${esc(s.notes)}</dd></div>` : ''}</dl></div>
    ${sharingSection(s)}${providerSection(s)}
    <div class="drawer-block"><div class="drawer-block-heading"><h3>Status history</h3><span class="event-count">${s.events.length} updates</span></div>${timeline(s, { compact: true })}</div>
    </div><footer class="drawer-actions">${account?.role === 'viewer' ? '' : `<button type="button" class="btn btn-primary" data-action="update-status">${icon('plus', 17)} Add update</button><button type="button" class="btn btn-secondary" data-action="edit">${icon('edit', 17)} Edit</button>`}${account?.role === 'admin' ? `<button type="button" class="btn btn-danger-soft" data-action="delete" aria-label="Delete shipment">${icon('trash', 17)}</button>` : ''}</footer>
  </aside></div>`;
}
function formField(name, label, value = '', attrs = '', required = false) {
  return `<div class="field"><label for="field-${name}">${label}${required ? '<span class="required"> *</span>' : ''}</label><input id="field-${name}" name="${name}" value="${esc(value)}" ${attrs} ${required ? 'required' : ''}><small class="field-error" data-error="${name}"></small></div>`;
}
function selectField(name, label, options, value, required = false) {
  return `<div class="field"><label for="field-${name}">${label}${required ? '<span class="required"> *</span>' : ''}</label><select name="${name}" id="field-${name}" ${required ? 'required' : ''}>${options.map((x) => `<option value="${esc(x)}" ${x === value ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select><small class="field-error" data-error="${name}"></small></div>`;
}
function shipmentForm() {
  const edit = state.modal === 'edit';
  const s = edit ? shipment(state.selectedId) : null;
  const v = (field) => s?.[field] ?? '';
  return `<div class="modal-head"><div><span class="modal-eyebrow">SHIPMENT WORKSPACE</span><h2>${edit ? 'Edit shipment' : 'Create new shipment'}</h2><p>${edit ? 'Update the shipment information below.' : 'Add the parcel details to start tracking.'}</p></div><button class="icon-button" type="button" data-action="close-modal" aria-label="Close form">${icon('x', 22)}</button></div>
    <form id="shipment-form" novalidate><div class="modal-body"><div class="form-section-label">${icon('box', 17)} PACKAGE INFORMATION</div>
    <div class="form-grid">${formField('trackingNumber', 'Tracking number', v('trackingNumber'), 'maxlength="70" placeholder="Enter shipment tracking ID"', true)}
    ${selectField('carrier', 'Shipping carrier', Array.from(new Set([...CARRIERS, s?.carrier].filter(Boolean))), v('carrier') || 'Blue Dart', true)}
    ${formField('reference', 'Order reference', v('reference'), 'maxlength="80" placeholder="e.g. ORD-4821"')}
    ${selectField('service', 'Service level', SERVICES, v('service') || 'Standard')}
    ${formField('packageDescription', 'Package description', v('packageDescription'), 'maxlength="200" placeholder="e.g. Laptop accessories"')}
    ${formField('weightKg', 'Package weight (kg)', v('weightKg'), 'type="number" min="0.001" max="100000" step="0.001" placeholder="e.g. 1.5"')}</div>
    <div class="form-section-label">${icon('mapPin', 17)} ROUTE & RECIPIENT</div><div class="form-grid">
    ${formField('originCity', 'Origin city', v('originCity'), 'maxlength="100" placeholder="e.g. Mumbai"', true)}
    ${formField('destinationCity', 'Destination city', v('destinationCity'), 'maxlength="100" placeholder="e.g. Bengaluru"', true)}
    ${formField('recipientName', 'Recipient name', v('recipientName'), 'maxlength="100" placeholder="Full name"', true)}
    ${formField('recipientEmail', 'Recipient email', v('recipientEmail'), 'type="email" maxlength="160" placeholder="name@example.com"')}
    ${formField('shippedAt', 'Shipping date', v('shippedAt'), 'type="date"')}
    ${formField('estimatedDelivery', 'Estimated delivery', v('estimatedDelivery'), 'type="date"')}</div>
    <div class="form-section-label">${icon('bell', 17)} DELIVERY NOTIFICATIONS</div><label class="switch-field"><input type="checkbox" name="notificationOptIn" ${v('notificationOptIn') ? 'checked' : ''}><span><strong>Email recipient when delivery status changes</strong><small>Opt-in only. Requires a configured Resend sender. No email is sent without consent.</small></span></label>
    <div class="form-section-label">${icon('edit', 17)} ADDITIONAL NOTES</div><div class="field"><label for="field-notes">Internal notes</label><textarea id="field-notes" name="notes" maxlength="1200" rows="3" placeholder="Special instructions, delivery notes...">${esc(v('notes'))}</textarea><small class="field-error" data-error="notes"></small></div>
    <p class="form-api-error" role="alert" hidden></p>
    </div><footer class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary" ${state.saving ? 'disabled' : ''}>${icon(edit ? 'check' : 'plus', 17)} ${edit ? 'Save changes' : 'Create shipment'}</button></footer></form>`;
}
function statusForm() {
  const s = shipment(state.selectedId);
  if (!s) return '';
  return `<div class="modal-head"><div><span class="modal-eyebrow">TRACKING UPDATE</span><h2>Update shipment status</h2><p>Record the latest milestone for ${esc(s.trackingNumber)}.</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close update">${icon('x', 22)}</button></div>
  <form id="status-form" novalidate><div class="modal-body"><div class="status-context">${icon('box', 23)}<div><strong>${esc(s.recipientName)}</strong><span>${esc(s.originCity)} → ${esc(s.destinationCity)}</span></div>${badge(s.status)}</div>
  <div class="field"><label for="field-status">New status<span class="required"> *</span></label><select id="field-status" name="status" required>${statusOrder.map((key) => `<option value="${key}" ${s.status === key ? 'selected' : ''}>${STATUS[key].label}</option>`).join('')}</select><small class="field-error" data-error="status"></small></div>
  ${formField('location', 'Current location', s.location, 'maxlength="100" placeholder="e.g. Mumbai sorting center"')}
  <div class="field"><label for="event-description">Update description</label><textarea id="event-description" name="description" maxlength="500" rows="4" placeholder="Describe what happened to this shipment..."></textarea><small class="field-error" data-error="description"></small></div>
  <p class="form-help">${icon('info', 16)} This update will appear in the shipment's status history with the current date and time.</p><p class="form-api-error" role="alert" hidden></p></div>
  <footer class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary" ${state.saving ? 'disabled' : ''}>${icon('check', 17)} Save status update</button></footer></form>`;
}
function deleteConfirm() {
  const s = shipment(state.selectedId);
  if (!s) return '';
  return `<div class="delete-confirm"><span class="delete-symbol">${icon('trash', 27)}</span><h2>Delete this shipment?</h2><p>You are about to permanently remove <strong>${esc(s.trackingNumber)}</strong> and all of its tracking history. This action cannot be undone.</p>
  <div class="delete-actions"><button type="button" class="btn btn-secondary" data-action="close-modal">Keep shipment</button><button type="button" class="btn btn-danger" data-action="confirm-delete" ${state.saving ? 'disabled' : ''}>Delete shipment</button></div></div>`;
}
function connectForm() {
  const s = shipment(state.selectedId);
  if (!s) return '';
  return `<div class="modal-head"><div><span class="modal-eyebrow">LIVE CARRIER TRACKING</span><h2>Connect to AfterShip</h2><p>Register ${esc(s.trackingNumber)} to retrieve courier milestones.</p></div><button type="button" class="icon-button" data-action="close-modal" aria-label="Close">${icon('x', 22)}</button></div>
  <form id="connect-form" novalidate><div class="modal-body"><div class="status-context">${icon('truck', 24)}<div><strong>${esc(s.carrier)}</strong><span>${esc(s.trackingNumber)}</span></div></div>
  ${formField('slug', 'AfterShip carrier slug (optional)', '', 'maxlength="50" pattern="[a-z0-9-]*" placeholder="Leave empty to use suggested courier"')}
  <p class="form-help">Carrier registration may incur usage charges on your AfterShip plan. For unlisted carriers leave the slug empty to use auto-detection.</p><p class="form-api-error" role="alert" hidden></p></div>
  <footer class="modal-footer"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">${icon('refresh', 16)} Connect & sync</button></footer></form>`;
}
function modal() {
  if (!state.modal) return '';
  return `<div class="overlay modal-overlay" data-action="close-modal"><div class="modal ${state.modal === 'delete' ? 'modal-small' : ['status','connect'].includes(state.modal) ? 'modal-medium' : ''}" role="dialog" aria-modal="true" aria-label="${state.modal === 'delete' ? 'Confirm deletion' : state.modal === 'status' ? 'Shipment update form' : state.modal === 'connect' ? 'Courier integration form' : 'Shipment form'}">${state.modal === 'delete' ? deleteConfirm() : state.modal === 'status' ? statusForm() : state.modal === 'connect' ? connectForm() : shipmentForm()}</div></div>`;
}
function authScreen() {
  const setup = initialized === false;
  app.innerHTML = `<main class="auth-bg"><div class="auth-panel"><div class="auth-logo">${brandMark()} <strong>${esc(branding.companyName)}</strong></div><div class="eyebrow">SECURE WORKSPACE</div><h1>${setup ? 'Create your workspace' : 'Welcome back'}</h1><p>${setup ? 'Create the first administrator account to protect your shipment records.' : 'Sign in to manage shipments and delivery updates.'}</p><form id="auth-form">${setup ? `<label>Full name<input name="name" required minlength="2" maxlength="100" autocomplete="name" placeholder="Your name"></label>` : ''}<label>Email address<input name="email" type="email" required autocomplete="username" placeholder="you@company.com"></label><label>Password<input name="password" type="password" required minlength="${setup ? 12 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? 'At least 12 characters' : 'Enter your password'}"></label>${setup && setupProtectionRequired ? '<label>Administrator setup key<input name="setupKey" type="password" required autocomplete="off" placeholder="From your server environment"></label>' : ''}<p id="auth-error" class="auth-error" role="alert"></p><button type="submit" class="btn btn-primary">${setup ? 'Create administrator' : 'Sign in'}</button></form><div class="auth-caption">Self-hosted shipment operations · Your data stays on your server</div></div></main>`;
}
function automationPage() {
  if (account?.role !== 'admin') return pageHeader('SECURITY / PERMISSIONS', 'Integrations', 'Administrator access required.');
  const d = state.integrationData;
  return `${pageHeader('SETTINGS / AUTOMATION', 'Tracking integrations', 'Connect courier updates, manage synchronization, and inspect delivery notifications.', `<button class="btn btn-secondary" type="button" data-action="refresh-integrations">${icon('refresh', 16)} Refresh</button>`)}
  ${!d ? `<section class="panel automation-loading">Loading integration status…</section>` : `<div class="automation-grid">
    <section class="panel automation-card"><div class="automate-icon">${icon('truck', 22)}</div><div class="eyebrow">COURIER SYNC</div><h2>AfterShip Tracking</h2><div class="integration-state ${d.aftershipConfigured ? 'good' : 'muted'}"><span class="state-dot"></span>${d.aftershipConfigured ? 'API credentials configured' : 'API key not configured'}</div>
      <p>Use supported carrier networks to import tracking milestones automatically. Existing manual shipments are not registered until you choose to connect them.</p>
      <div class="automate-number"><strong>${d.linked}</strong><span>linked shipments</span></div>
      <div class="feature-actions"><button class="btn btn-primary" type="button" data-action="sync-all" ${!d.aftershipConfigured || !d.linked ? 'disabled' : ''}>${icon('refresh', 16)} Sync linked shipments</button></div>
      <small class="automate-foot">Automatic polling: ${d.syncMinutes > 0 ? `every ${d.syncMinutes} minutes` : 'off'} while the Node.js server is running.</small></section>
    <section class="panel automation-card"><div class="automate-icon">${icon('bell', 22)}</div><div class="eyebrow">CUSTOMER MESSAGES</div><h2>Email notifications</h2><div class="integration-state ${d.notifications.configured ? 'good' : 'muted'}"><span class="state-dot"></span>${d.notifications.configured ? 'Resend configured' : 'Email sender not configured'}</div>
      <p>Send updates when shipment status changes, but only for records whose recipients have explicitly opted in.</p>
      <div class="automation-stats"><div><strong>${d.notifications.counts.sent}</strong><span>Sent</span></div><div><strong>${d.notifications.counts.pending}</strong><span>Queued</span></div><div><strong>${d.notifications.counts.failed}</strong><span>Failed</span></div></div>
      <small class="automate-foot">${d.notifications.sender ? `Sender: ${esc(d.notifications.sender)}` : 'Add RESEND_API_KEY and RESEND_FROM_EMAIL to your environment.'}</small></section>
    <section class="panel automation-card"><div class="automate-icon">${icon('external', 22)}</div><div class="eyebrow">TRACKING PAGES</div><h2>Shareable tracking</h2><div class="integration-state ${d.shareEnabled ? 'good' : 'muted'}"><span class="state-dot"></span>${d.shareEnabled} active links</div>
      <p>Enable a token-based public page per shipment, with private recipient information excluded. Links can be rotated or revoked at any time.</p>
      <div class="feature-actions"><a href="#shipments" class="btn btn-secondary">Manage shipments ${icon('arrowRight', 16)}</a></div>
      <small class="automate-foot">Signed courier webhooks: ${d.webhookConfigured ? 'Configured' : 'Not configured'}.</small></section>
    </div>
    <section class="panel automation-log">${sectionHeading('Recent email activity', 'Delivery notifications sent through the server')}
      ${d.notifications.latest.length ? `<div class="notification-table-wrap"><table class="notification-table"><thead><tr><th>RECIPIENT</th><th>STATUS</th><th>DELIVERY</th><th>CREATED</th></tr></thead><tbody>${d.notifications.latest.map(n => `<tr><td>${esc(n.recipient)}</td><td>${esc(n.status_label)}</td><td><span class="mail-state mail-${esc(n.state)}">${esc(n.state)}</span>${n.last_error ? `<small class="inline-error">${esc(n.last_error)}</small>` : ''}</td><td>${dateMini(n.created_at)}</td></tr>`).join('')}</tbody></table></div>` : emptyState({title:'No notifications yet',detail:'Opted-in shipment status changes will appear here once email delivery is configured.',action:false,glyph:'bell'})}</section>
    <section class="automation-guidance"><strong>Environment setup</strong><span>API keys are configured on the server, never in your browser. Use the included .env.example as a reference and restart the server after changes.</span></section>`}`;
}
async function fetchIntegrationStatus() {
  if (account?.role !== 'admin' || state.integrationLoading) return;
  state.integrationLoading = true;
  try { state.integrationData = await api('/integrations/status'); if (state.page === 'automation') render(); }
  catch (e) { notify(e.message,'error'); }
  finally { state.integrationLoading = false; }
}
async function changeSharing(action) {
  if (action === 'rotate' && !confirm('Rotate this link? The previous link will stop working.')) return;
  const id = state.selectedId;
  try { await api(`/shipments/${id}/share`, { method:'POST', body:JSON.stringify({action}) }); await fetchShipments(); notify(action==='disable' ? 'Tracking link disabled.' : action==='rotate' ? 'Link rotated. Old link revoked.' : 'Public tracking link enabled.'); }
  catch (error) { notify(error.message,'error'); }
}
async function performSyncOne() {
  const id = state.selectedId;
  try { const {statusChanged,eventsAdded} = await api(`/shipments/${id}/tracking/sync`, {method:'POST'}); await fetchShipments(); notify(statusChanged || eventsAdded ? `${eventsAdded} carrier milestones imported.` : 'Carrier data is up to date.'); }
  catch (error) { notify(error.message,'error'); await fetchShipments(); }
}
async function connectOne(form) {
  const slug = String(new FormData(form).get('slug') || '').trim();
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try { await api(`/shipments/${state.selectedId}/tracking/connect`, {method:'POST',body:JSON.stringify({slug})}); state.modal = null; await fetchShipments(); notify('Carrier tracking connected.'); }
  catch (error) { applyFormErrors(form,error); }
  finally { button.disabled = false; }
}
function analyticsPage() {
  const a = state.analyticsData;
  const periodSelect = `<label class="period-select">Time range <select id="analytics-period" aria-label="Analytics period">${[7,30,90,365].map(d => `<option value="${d}" ${state.analyticsPeriod === d ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select></label>`;
  if (state.analyticsLoading && !a) return `${pageHeader('PERFORMANCE / REPORTS', 'Delivery analytics', 'Measured delivery activity and courier performance.', periodSelect)}<section class="panel report-loading"><div class="spinner"></div>Calculating reports…</section>`;
  if (state.analyticsError) return `${pageHeader('PERFORMANCE / REPORTS', 'Delivery analytics', 'Measured delivery activity and courier performance.',periodSelect)}<div class="panel report-loading">${esc(state.analyticsError)} <button class="btn btn-secondary" data-action="refresh-analytics">Retry</button></div>`;
  if (!a) return `${pageHeader('PERFORMANCE / REPORTS', 'Delivery analytics', 'Measured delivery activity and courier performance.',periodSelect)}<section class="panel report-loading">Preparing report…</section>`;
  const totalTrend = Math.max(1, ...a.trend.flatMap(d => [d.created,d.delivered]));
  const metric = (label, value, note, glyph) => `<article class="report-metric"><span class="report-metric-icon">${icon(glyph,19)}</span><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
  return `${pageHeader('PERFORMANCE / REPORTS', 'Delivery analytics', 'Understand delivery volume, timeliness and courier performance.', periodSelect)}
    <div class="report-metrics">${metric('New shipments',a.createdInPeriod,`Created in the last ${a.period} days`,'box')}
      ${metric('Completed',a.deliveredInPeriod,'Delivered during this period','packageCheck')}
      ${metric('On-time delivery',a.onTimeRate == null ? '—' : `${a.onTimeRate}%`,`${a.onTimeSample} shipments with ETA data`,'clock')}
      ${metric('Avg. transit',a.avgTransitDays == null ? '—' : `${a.avgTransitDays} days`,'truck')}
      ${metric('Overdue now',a.overdue,'Undelivered past their ETA','alert')}</div>
    <div class="report-two-column">
      <section class="panel report-panel"><div class="report-title"><div><div class="eyebrow">DELIVERY VOLUME</div><h2>Activity over time</h2><p>When shipments were created and delivered in the selected period.</p></div><div class="chart-legend"><span><i class="legend-created"></i>Created</span><span><i class="legend-delivered"></i>Delivered</span></div></div>
        <div class="report-chart-scroll"><div class="report-bars" role="img" style="grid-template-columns:repeat(${a.trend.length},minmax(17px,1fr))" aria-label="Created and delivered shipments by day or time window">${a.trend.map(t => `<div class="report-bar-column" title="${esc(t.start)} – ${esc(t.end)}: ${t.created} created, ${t.delivered} delivered"><div class="report-bar-values"><span>${t.created || ''}</span><span>${t.delivered || ''}</span></div><div class="report-bar-pair"><div class="report-bar-created" style="height:${Math.max(t.created ? 5 : 0, Math.round(t.created / totalTrend * 100))}%"></div><div class="report-bar-delivered" style="height:${Math.max(t.delivered ? 5 : 0, Math.round(t.delivered / totalTrend * 100))}%"></div></div><small>${esc(t.label)}</small></div>`).join('')}</div></div>
      </section>
      <section class="panel report-panel"><div class="report-title"><div><div class="eyebrow">CURRENT PORTFOLIO</div><h2>Status breakdown</h2><p>${a.total} shipments in your workspace</p></div></div><div class="report-breakdown">${Object.keys(STATUS).map(key=>{const value=a.counts[key]||0;return `<div class="breakdown-item"><div><span>${esc(STATUS[key].label)}</span><strong>${value.toLocaleString('en-IN')}</strong></div><div class="breakdown-track"><div class="breakdown-fill breakdown-${key}" style="width:${a.total ? Math.max(value ? 1 : 0, value/a.total*100) : 0}%"></div></div></div>`;}).join('')}</div></section>
    </div>
    <section class="panel report-panel report-carriers"><div class="report-title"><div><div class="eyebrow">COURIER COMPARISON</div><h2>Carrier performance</h2><p>Lifetime shipment performance across your carriers.</p></div></div>
    ${a.carriers.length ? `<div class="table-wrap"><table class="ship-table report-table"><thead><tr><th>CARRIER</th><th>SHIPMENTS</th><th>DELIVERED</th><th>DELIVERY RATE</th><th>EXCEPTIONS</th><th>OVERDUE</th></tr></thead><tbody>${a.carriers.map(c=>`<tr><td><strong>${esc(c.carrier)}</strong></td><td>${c.total}</td><td>${c.delivered}</td><td><div class="rate-cell"><span>${c.deliveryRate??'—'}%</span><div class="mini-rate"><i style="width:${c.deliveryRate||0}%"></i></div></div></td><td>${c.exceptions}</td><td>${c.overdue}</td></tr>`).join('')}</tbody></table></div>` : emptyState({title:'No carrier data yet',detail:'Create shipments to begin measuring performance.',action:false,glyph:'truck'})}</section>
    <p class="report-footnote">On-time percentage includes only delivered shipments with a recorded delivery estimate. Transit time requires both a shipping date and a delivery timestamp. No estimates are fabricated for missing data.</p>`;
}
async function fetchAnalytics() {
  if (!account || state.analyticsLoading) return;
  state.analyticsLoading = true;
  state.analyticsError = '';
  try { const data = await api(`/analytics?days=${state.analyticsPeriod}`); state.analyticsData = data.analytics; }
  catch (error) { state.analyticsError = error.message; }
  finally { state.analyticsLoading = false; if (state.page === 'analytics') render(); }
}
function importResults() {
  const r = state.importPreview;
  if (!r) return '';
  return `<section class="panel import-results"><div class="report-title"><div><div class="eyebrow">VALIDATION RESULTS</div><h2>CSV preview</h2><p>Nothing has been saved yet.</p></div></div>
    <div class="import-stats"><div><strong>${r.total}</strong><span>Rows found</span></div><div><strong>${r.ready}</strong><span>Ready to import</span></div><div><strong>${r.skipped}</strong><span>Duplicates skipped</span></div><div class="${r.errors.length ? 'text-danger' : ''}"><strong>${r.errors.length}</strong><span>Issues to fix</span></div></div>
    ${r.errors.length ? `<div class="import-issues"><strong>${icon('alert',17)} Fix these rows and upload the revised file</strong><ul>${r.errors.slice(0,30).map(e => `<li><b>Row ${e.row}:</b> ${esc(e.error)}</li>`).join('')}</ul>${r.errors.length>30?`<small>Showing the first 30 of ${r.errors.length} issues.</small>`:''}</div>` : ''}
    ${r.examples.length ? `<div class="table-wrap"><table class="ship-table import-table"><thead><tr><th>TRACKING NO.</th><th>COURIER</th><th>RECIPIENT</th><th>ROUTE</th></tr></thead><tbody>${r.examples.map(x=>`<tr><td><strong>${esc(x.trackingNumber)}</strong></td><td>${esc(x.carrier)}</td><td>${esc(x.recipientName)}</td><td>${esc(x.route)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="import-actions"><button type="button" class="btn btn-primary" data-action="commit-import" ${r.errors.length || !r.ready || state.importLoading ? 'disabled' : ''}>${icon('upload', 16)} Import ${r.ready} shipments</button><span>${r.errors.length ? 'Fix all invalid rows before importing.' : 'Validated rows are added in one database transaction.'}</span></div>
  </section>`;
}
function importPage() {
  if (account?.role === 'viewer') return pageHeader('OPERATIONS / IMPORT', 'Bulk shipment import', 'Read-only accounts cannot import shipments.');
  return `${pageHeader('OPERATIONS / IMPORT', 'Import shipments', 'Upload a CSV to add hundreds of packages safely.', `<a class="btn btn-secondary" href="/api/shipments/import/template.csv" download>${icon('download',16)} Download CSV template</a>`)}
  <div class="import-grid"><section class="panel import-upload"><div class="import-upload-icon">${icon('upload',27)}</div><h2>Choose your CSV file</h2><p>Supports up to 500 shipments per upload and a maximum file size of 600 KB. We validate every row before anything is saved.</p>
    <form id="import-form"><label class="file-dropzone" for="import-file">${icon('upload',19)} <strong>${state.importName ? esc(state.importName) : 'Browse for a CSV file'}</strong><span>${state.importName ? 'Choose a different file to replace it' : 'Comma-separated values · UTF-8'}</span><input id="import-file" type="file" accept=".csv,text/csv" aria-label="Choose CSV file"></label>
    <label class="switch-field import-duplicate"><input id="import-skip" type="checkbox" ${state.importSkipDuplicates ? 'checked' : ''}><span><strong>Skip existing tracking numbers</strong><small>Matches are checked using carrier and tracking number.</small></span></label>
    <p class="form-api-error" role="alert" ${state.importError ? '' : 'hidden'}>${esc(state.importError)}</p>
    <button class="btn btn-primary" type="submit" ${!state.importText || state.importLoading ? 'disabled' : ''}>${icon('checkCircle',17)} ${state.importLoading ? 'Validating…' : 'Preview and validate'}</button></form>
  </section><section class="panel import-help"><div class="eyebrow">IMPORT CHECKLIST</div><h2>Prepare your spreadsheet</h2><ol><li>Download the template and fill it in Excel or Google Sheets.</li><li>Keep the required columns: tracking number, carrier, recipient, origin, and destination.</li><li>Export your sheet as CSV (UTF-8) and upload it here.</li><li>Review duplicates and errors before importing.</li></ol><div class="import-note">${icon('shield',18)} Existing shipments are never overwritten. Email consent defaults to off unless explicitly set in the CSV.</div></section></div>${importResults()}`;
}
async function previewImport() {
  if (!state.importText || state.importLoading) return;
  state.importLoading = true;
  state.importError = '';
  state.importPreview = null;
  render();
  try { state.importPreview = await api('/shipments/import/preview',{method:'POST',body:JSON.stringify({csv:state.importText,skipDuplicates:state.importSkipDuplicates})}); }
  catch (e) { state.importError = e.message; }
  finally { state.importLoading = false; render(); }
}
async function commitImport() {
  if (!state.importPreview?.ready || state.importPreview.errors.length || state.importLoading) return;
  state.importLoading = true;
  render();
  try {
    const result = await api('/shipments/import',{method:'POST',body:JSON.stringify({csv:state.importText,skipDuplicates:state.importSkipDuplicates})});
    state.importText = ''; state.importName = ''; state.importPreview = null; state.importError = '';
    await fetchShipments();
    notify(`${result.imported} shipments imported. ${result.skipped} duplicates skipped.`);
  } catch (e) { state.importError = e.message; }
  finally { state.importLoading = false; render(); }
}
function brandMark(forPublic = false) {
  const mark = branding.hasLogo ? `<img src="/api/public/logo?v=${brandVersion}" alt="" class="brand-logo-image">` : `<span class="brand-initials">${esc(branding.shortName)}</span>`;
  return forPublic ? `<span class="public-brand-mark">${mark}</span>` : mark;
}
function brandingPage() {
  if (account?.role !== 'admin') return pageHeader('SETTINGS / BRAND', 'Workspace branding', 'Administrator access required.');
  return `${pageHeader('SETTINGS / BRAND', 'Workspace branding', 'Make the dashboard and customer tracking pages yours.')}
    <div class="branding-grid"><section class="panel branding-panel"><div class="eyebrow">VISUAL IDENTITY</div><h2>Brand details</h2><p>Your workspace and public tracking pages share this branding.</p>
    <form id="branding-form" class="branding-form">
      ${formField('companyName','Workspace name',branding.companyName,'required maxlength="60"',true)}
      <div class="brand-form-two">${formField('shortName','Logo initials',branding.shortName,'maxlength="3" required',true)}<div class="field"><label for="brand-color">Accent color</label><div class="color-field"><input id="brand-color" name="accent" type="color" value="${esc(branding.accent)}"><span>${esc(branding.accent)}</span></div></div></div>
      ${formField('supportEmail','Support email (shown publicly)',branding.supportEmail,'type="email" maxlength="160" placeholder="support@company.com"')}
      <div class="field"><label for="tracking-message">Public tracking description</label><textarea id="tracking-message" name="trackingMessage" maxlength="180" rows="3">${esc(branding.trackingMessage)}</textarea></div>
      <p class="form-api-error" role="alert" hidden></p><button class="btn btn-primary" type="submit">${icon('check',17)} Save brand settings</button>
    </form></section>
    <div class="branding-side"><section class="panel branding-panel"><div class="eyebrow">COMPANY LOGO</div><h2>Logo image</h2><div class="branding-logo-preview">${brandMark()}</div><p>Optional PNG or JPEG, 250 KB maximum. Stored in the database, without creating asset or cache files.</p><label class="btn btn-secondary branding-upload" for="branding-logo-file">${icon('upload',16)} Upload logo</label><input type="file" id="branding-logo-file" accept="image/png,image/jpeg" hidden>${branding.hasLogo ? `<button type="button" class="btn btn-danger-soft" data-action="remove-logo">Remove logo</button>` : ''}</section>
      <section class="panel branding-preview"><div class="eyebrow">PREVIEW</div><h2>Public tracking identity</h2><div class="brand-preview-card"><div class="brand-preview-title">${brandMark(true)}<strong>${esc(branding.companyName)}</strong></div><p>${esc(branding.trackingMessage)}</p><div class="brand-preview-route"><span></span><i></i><span></span></div><small>${esc(branding.supportEmail || 'No support email configured')}</small></div></section>
    </div></div>`;
}
async function fetchBranding() {
  try {
    const { branding: next } = await api('/public/branding');
    branding = next;
    document.documentElement.style.setProperty('--accent',branding.accent);
    document.documentElement.style.setProperty('--accent-strong',`color-mix(in srgb, ${branding.accent} 79%, #11182e)`);
    document.documentElement.style.setProperty('--accent-wash',`color-mix(in srgb, ${branding.accent} 8%, white)`);
    document.title = `${branding.companyName} · Shipment operations`;
    brandVersion++;
  } catch { /* Use bundled defaults if server is temporarily unavailable. */ }
}
async function saveBranding(form) {
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api('/branding',{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    await fetchBranding(); render(); notify('Brand settings saved.');
  } catch(e) { applyFormErrors(form,e); button.disabled = false; }
}
async function uploadBrandLogo(file) {
  if (!file) return;
  if (!['image/png','image/jpeg'].includes(file.type) || file.size > 250000) return notify('Choose a PNG or JPEG smaller than 250 KB.','error');
  try {
    const dataUrl = await new Promise((resolve,reject) => {const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=reject; reader.readAsDataURL(file);});
    await api('/branding/logo',{method:'POST',body:JSON.stringify({image:dataUrl})});
    await fetchBranding(); render(); notify('Workspace logo updated.');
  } catch(e) { notify(e.message,'error'); }
}

function teamPage() {
  if (account?.role !== 'admin') return pageHeader('PERMISSIONS', 'Team members', 'Only administrators can manage users.');
  return `${pageHeader('WORKSPACE / TEAM', 'Team members', 'Manage access to your shipment workspace.')}
  <section class="team-grid"><div class="panel"><h2>Add a team member</h2><form id="team-form" class="team-form"><label>Full name<input name="name" required minlength="2" maxlength="100"></label><label>Email<input name="email" type="email" required></label><label>Temporary password<input name="password" type="password" required minlength="12" placeholder="12+ characters"></label><label>Role<select name="role"><option value="viewer">Viewer · read only</option><option value="operator">Operator · create and update</option><option value="admin">Admin · full control</option></select></label><button class="btn btn-primary">Add member</button></form></div><div class="panel"><h2>Workspace users</h2><div id="team-results">Loading team members…</div></div></section>`;
}
async function fetchTeam() {
  if (account?.role !== 'admin') return;
  try {
    const { users } = await api('/users');
    const box = document.getElementById('team-results');
    if (box) box.innerHTML = users.map(u => `<div class="team-user"><div><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></div><div><select aria-label="Role for ${esc(u.name)}" data-role-id="${u.id}" ${u.id === account.id ? 'disabled' : ''}>${['admin','operator','viewer'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>${u.id !== account.id ? `<button class="btn btn-danger-soft" type="button" data-action="remove-user" data-id="${u.id}">Remove</button>` : '<small>You</small>'}</div></div>`).join('');
  } catch (error) { notify(error.message, 'error'); }
}
async function bootstrap() {
  await fetchBranding();
  try {
    const result = await api('/auth/state');
    initialized = result.initialized;
    setupProtectionRequired = Boolean(result.setupProtectionRequired);
    account = result.user;
    if (account) { render(); try { state.capabilities = await api('/integrations/capabilities'); } catch {} await fetchShipments({ initial: true }); if (state.page === 'team') fetchTeam(); }
    else authScreen();
  } catch (error) { app.textContent = error.message; }
}
function render() {
  if (!account) { authScreen(); return; }
  const mainContent = state.loading ? `<div class="loading-state"><div class="spinner"></div><h2>Loading shipments</h2><p>Connecting to your workspace...</p></div>` : state.loadError
    ? `<div class="error-state">${icon('alert', 34)}<h2>Workspace unavailable</h2><p>${esc(state.loadError)}</p><button class="btn btn-primary" data-action="retry">${icon('refresh', 17)} Try again</button></div>`
    : state.page === 'team' ? teamPage() : state.page === 'automation' ? automationPage() : state.page === 'analytics' ? analyticsPage() : state.page === 'import' ? importPage() : state.page === 'branding' ? brandingPage() : state.page === 'shipments' ? shipmentList() : state.page === 'activity' ? activityPage() : state.page === 'tracking' ? tracking() : overview();
  app.innerHTML = `${sidebar()}${state.mobileMenu ? '<div class="mobile-scrim" data-action="menu"></div>' : ''}<div class="shell">${topbar()}<main class="main-content" id="main-content">${mainContent}<footer class="page-footer"><span>${esc(branding.companyName)} · Shipment operations</span><span>${icon('shield', 14)} Your data stays on this server</span></footer></main></div>${detailDrawer()}${modal()}<div id="toast-slot" class="toast-slot" aria-live="polite"></div>`;
  renderToast();
  if (state.page === 'team' && !state.loading) fetchTeam();
  if (state.page === 'automation' && !state.loading && !state.integrationData && !state.integrationLoading) void fetchIntegrationStatus();
  if (state.page === 'analytics' && !state.analyticsData && !state.analyticsLoading && !state.analyticsError) void fetchAnalytics();
  if (state.modal) requestAnimationFrame(() => document.querySelector('.modal input, .modal select, .modal button')?.focus({ preventScroll: true }));
  else if (state.selectedId) requestAnimationFrame(() => document.querySelector('.drawer .icon-button')?.focus({ preventScroll: true }));
}

function setPage(page) {
  if (!NAV.some((x) => x.id === page)) return;
  if (['team','automation','branding'].includes(page) && account?.role !== 'admin') page = 'overview';
  if (page === 'import' && account?.role === 'viewer') page = 'overview';
  state.page = page;
  state.mobileMenu = false;
  state.selectedId = null;
  state.modal = null;
  state.trackedId = null;
  render();
  document.getElementById('main-content')?.scrollTo(0, 0);
  window.scrollTo(0, 0);
}
function showModal(mode) { state.modal = mode; render(); }
function closeModal() { state.modal = null; state.saving = false; render(); }
function closeDrawer() { state.selectedId = null; render(); }
function openDetail(id) { if (shipment(id)) { state.modal = null; state.selectedId = id; render(); } }
function applyFormErrors(form, error) {
  form.querySelectorAll('.field-error').forEach((element) => { element.textContent = ''; });
  form.querySelectorAll('.invalid-field').forEach((element) => element.classList.remove('invalid-field'));
  for (const [key, message] of Object.entries(error.details || {})) {
    const hint = form.querySelector(`[data-error="${key}"]`);
    if (hint) hint.textContent = message;
    const input = form.elements.namedItem(key);
    if (input?.classList) input.classList.add('invalid-field');
  }
  const msg = form.querySelector('.form-api-error');
  if (msg) { msg.textContent = error.message; msg.hidden = false; }
}
async function saveShipment(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  values.notificationOptIn = Boolean(form.elements.namedItem('notificationOptIn')?.checked);
  values.weightKg = values.weightKg ? Number(values.weightKg) : null;
  const edit = state.modal === 'edit';
  const id = state.selectedId;
  const submitButton = form.querySelector('[type="submit"]');
  if (state.saving) return;
  state.saving = true;
  submitButton.disabled = true;
  try {
    const data = await api(edit ? `/shipments/${id}` : '/shipments', {
      method: edit ? 'PATCH' : 'POST', body: JSON.stringify(values),
    });
    state.modal = null;
    state.selectedId = data.shipment.id;
    await fetchShipments();
    notify(edit ? 'Shipment changes saved.' : 'Shipment created successfully.');
  } catch (error) { applyFormErrors(form, error); }
  finally { state.saving = false; submitButton.disabled = false; }
}
async function saveEvent(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const id = state.selectedId;
  const submitButton = form.querySelector('[type="submit"]');
  if (state.saving) return;
  state.saving = true;
  submitButton.disabled = true;
  try {
    await api(`/shipments/${id}/events`, { method: 'POST', body: JSON.stringify(values) });
    state.modal = null;
    await fetchShipments();
    notify('Tracking milestone added.');
  } catch (error) { applyFormErrors(form, error); }
  finally { state.saving = false; submitButton.disabled = false; }
}
async function deleteShipment() {
  if (state.saving) return;
  state.saving = true;
  const id = state.selectedId;
  try {
    await api(`/shipments/${id}`, { method: 'DELETE' });
    state.modal = null;
    state.selectedId = null;
    state.trackedId = null;
    await fetchShipments();
    notify('Shipment permanently deleted.');
  } catch (error) { notify(error.message, 'error'); }
  finally { state.saving = false; }
}
async function copyValue(value) {
  try {
    await navigator.clipboard.writeText(value);
    notify('Copied to clipboard.');
  } catch {
    notify('Unable to copy. Select the tracking number manually.', 'error');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (target.tagName === 'A') event.preventDefault();
  if ((action === 'close-drawer' && target.classList.contains('drawer-overlay') && event.target !== target)
    || (action === 'close-modal' && target.classList.contains('modal-overlay') && event.target !== target)) return;
  if (action === 'logout') { api('/auth/logout', { method: 'POST' }).finally(() => { account = null; state.shipments = []; state.selectedId = null; state.modal = null; state.analyticsData = null; state.integrationData = null; state.importText = ''; state.importName = ''; state.importPreview = null; state.page = 'overview'; window.location.hash = 'overview'; authScreen(); }); }
  else if (action === 'remove-user') { if (confirm('Remove this team member?')) api(`/users/${target.dataset.id}`, { method: 'DELETE' }).then(fetchTeam).catch(e => notify(e.message,'error')); }
  else if (action === 'new') { state.selectedId = null; showModal('create'); }
  else if (action === 'open') openDetail(target.dataset.id);
  else if (action === 'track-select') { state.trackedId = target.dataset.id; render(); }
  else if (action === 'close-drawer') closeDrawer();
  else if (action === 'close-modal') closeModal();
  else if (action === 'update-status') showModal('status');
  else if (action === 'edit') showModal('edit');
  else if (action === 'delete') showModal('delete');
  else if (action === 'confirm-delete') deleteShipment();
  else if (action === 'copy') copyValue(target.dataset.value);
  else if (action === 'copy-share') copyValue(linkFor(shipment(state.selectedId)));
  else if (action === 'enable-share') changeSharing('enable');
  else if (action === 'disable-share') changeSharing('disable');
  else if (action === 'rotate-share') changeSharing('rotate');
  else if (action === 'connect-one') showModal('connect');
  else if (action === 'sync-one') performSyncOne();
  else if (action === 'disconnect-one') { if(confirm('Disconnect local tracking? This does not remove your tracking from the AfterShip account.')) api(`/shipments/${state.selectedId}/tracking/disconnect`,{method:'POST'}).then(fetchShipments).then(() => notify('Shipment disconnected.')).catch(e => notify(e.message,'error')); }
  else if (action === 'refresh-analytics') {state.analyticsData=null;state.analyticsError='';fetchAnalytics();}
  else if (action === 'commit-import') commitImport();
  else if (action === 'remove-logo') { if(confirm('Remove the current company logo?')) api('/branding/logo',{method:'DELETE'}).then(fetchBranding).then(()=>{render();notify('Logo removed.');}).catch(e=>notify(e.message,'error')); }
  else if (action === 'refresh-integrations') { state.integrationData=null; fetchIntegrationStatus(); }
  else if (action === 'sync-all') { target.disabled=true; api('/integrations/sync',{method:'POST'}).then(async result => { await fetchShipments(); state.integrationData=null; await fetchIntegrationStatus(); notify(`Synced ${result.synced} shipment(s); ${result.failed} failed.`); }).catch(e => notify(e.message,'error')).finally(() => { if(target.isConnected) target.disabled=false; }); }
  else if (action === 'retry') fetchShipments({ initial: true });
  else if (action === 'menu') { state.mobileMenu = !state.mobileMenu; render(); }
  else if (action === 'go-activity') { window.location.hash = 'activity'; }
  else if (action === 'dismiss-toast') { state.toast = null; renderToast(); }
  else if (action === 'filter-status') { state.statusFilter = target.dataset.value; state.listPage = 1; render(); }
  else if (action === 'previous') { state.listPage--; render(); }
  else if (action === 'next') { state.listPage++; render(); }
});
document.addEventListener('submit', (event) => {
  if (event.target.id === 'auth-form') {
    event.preventDefault(); const form = event.target; const button = form.querySelector('button'); button.disabled = true;
    api(initialized ? '/auth/login' : '/auth/setup', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }).then(async ({user}) => { account = user; initialized = true; state.page = 'overview'; window.location.hash = 'overview'; try { state.capabilities = await api('/integrations/capabilities'); } catch {} await fetchShipments({initial:true}); }).catch(e => { document.getElementById('auth-error').textContent = e.message; button.disabled = false; });
  } else if (event.target.id === 'import-form') {event.preventDefault();previewImport();}
  else if (event.target.id === 'branding-form') {event.preventDefault();saveBranding(event.target);}
  else if (event.target.id === 'team-form') {
    event.preventDefault(); const form = event.target; api('/users', {method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))}).then(() => { form.reset(); fetchTeam(); notify('Team member added.'); }).catch(e => notify(e.message,'error'));
  } else if (event.target.id === 'connect-form') { event.preventDefault(); connectOne(event.target); } else if (event.target.id === 'shipment-form') { event.preventDefault(); saveShipment(event.target); }
  else if (event.target.id === 'status-form') { event.preventDefault(); saveEvent(event.target); }
  else if (event.target.id === 'track-form') {
    event.preventDefault();
    state.trackingQuery = String(new FormData(event.target).get('trackingQuery') || '').trim();
    state.trackedId = null;
    render();
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'analytics-period') {state.analyticsPeriod=Number(event.target.value);state.analyticsData=null;state.analyticsError='';render();}
  else if (event.target.id === 'import-skip') {state.importSkipDuplicates=event.target.checked;state.importPreview=null;render();}
  else if (event.target.id === 'import-file') {const file=event.target.files?.[0];if(!file)return;if(file.size>600000){state.importError='File is larger than 600 KB.';state.importText='';state.importPreview=null;render();return;}file.text().then(t=>{state.importText=t;state.importName=file.name;state.importPreview=null;state.importError='';render();}).catch(()=>notify('Unable to read this file.','error'));}
  else if (event.target.id === 'branding-logo-file') uploadBrandLogo(event.target.files?.[0]);
  else if (event.target.matches('[data-role-id]')) { api(`/users/${event.target.dataset.roleId}`, {method:'PATCH',body:JSON.stringify({role:event.target.value})}).then(() => { notify('Role updated.'); fetchTeam(); }).catch(e => { notify(e.message,'error'); fetchTeam(); }); }
  else if (event.target.id === 'carrier-filter') { state.carrierFilter = event.target.value; state.listPage = 1; render(); }
  else if (event.target.id === 'sort-order') { state.sort = event.target.value; render(); }
  else if (event.target.id === 'activity-filter') { state.activityFilter = event.target.value; render(); }
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'shipment-search') {
    state.query = event.target.value;
    state.listPage = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const output = document.getElementById('shipment-results');
      if (output) output.innerHTML = shipmentResults();
    }, 100);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && (state.modal || state.selectedId)) {
    const root = document.querySelector(state.modal ? '.modal' : '.drawer');
    const focusable = [...(root?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])') || [])]
      .filter((el) => el.getClientRects().length);
    if (focusable.length) {
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }
  if (event.key === 'Escape') {
    if (state.modal) closeModal();
    else if (state.selectedId) closeDrawer();
    else if (state.mobileMenu) { state.mobileMenu = false; render(); }
  }
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    if (state.page === 'shipments') { event.preventDefault(); document.getElementById('shipment-search')?.focus(); }
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-action="open"], tr[data-action="track-select"]')) {
    event.preventDefault();
    if (event.target.dataset.action === 'track-select') { state.trackedId = event.target.dataset.id; render(); }
    else openDetail(event.target.dataset.id);
  }
});
window.addEventListener('hashchange', () => setPage(routeFromHash()));
bootstrap();
