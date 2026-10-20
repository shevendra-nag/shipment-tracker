import { icon, esc, STATUS, dateShort, timeAgo } from './ui.js';

const app = document.getElementById('public-app');
const token = window.location.pathname.match(/^\/track\/([A-Za-z0-9_-]{32})$/)?.[1];
let branding = {companyName:'Shipment Tracker',shortName:'ST',accent:'#4959db',supportEmail:'',trackingMessage:'Follow every milestone on the way to your destination.',hasLogo:false};
const progress = ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'];

function logo() {
  return `<a href="/track/${encodeURIComponent(token || '')}" class="public-logo" aria-label="${esc(branding.companyName)} tracking"><span class="public-brand-mark">${branding.hasLogo ? '<img src="/api/public/logo" alt="" class="brand-logo-image">' : `<span class="brand-initials">${esc(branding.shortName)}</span>`}</span><span>${esc(branding.companyName)}</span></a>`;
}
function pageFrame(body) {
  return `<header class="public-header"><div class="public-container public-header-inner">${logo()}<span class="public-header-note">SHIPMENT TRACKING</span></div></header>
  <main class="public-container public-main">${body}</main>
  <footer class="public-footer public-container"><span>© ${new Date().getFullYear()} ${esc(branding.companyName)}</span><span>${branding.supportEmail ? `Support: <a href="mailto:${esc(branding.supportEmail)}">${esc(branding.supportEmail)}</a>` : 'Secure, read-only tracking page'}</span></footer>`;
}
function stageBar(s) {
  const current = progress.indexOf(s.status);
  let filled = Math.max(0, current);
  if (current < 0) filled = Math.max(0, ...s.events.map(e => progress.indexOf(e.status)));
  return `<div class="public-stages" aria-label="Delivery progress">${progress.map((key, index) => `<div class="public-stage ${index <= filled ? 'is-reached' : ''} ${index === filled ? 'is-current' : ''}">
    <span class="public-stage-bullet">${index < filled ? icon('check', 16) : String(index + 1)}</span><span>${esc(STATUS[key].label)}</span></div>`).join('')}</div>`;
}
function history(events) {
  return `<div class="public-timeline">${[...events].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map((event, index) => {
    const config = STATUS[event.status] || STATUS.pending;
    return `<div class="public-event ${index === 0 ? 'newest' : ''}"><div class="public-event-symbol">${icon(config.icon, 19)}</div><div class="public-event-body"><div class="public-event-title"><strong>${esc(config.label)}</strong><span>${dateShort(event.createdAt)}</span></div>
      <p>${event.location ? `Scanned in ${esc(event.location)}` : 'Shipment milestone recorded'}</p><small>${new Date(event.createdAt).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</small></div></div>`;
  }).join('')}</div>`;
}
function shipmentView(s) {
  const current = STATUS[s.status] || STATUS.pending;
  const lastUpdate = s.events.length ? s.events[0].createdAt : null;
  return pageFrame(`<div class="public-eyebrow"><span class="public-eyebrow-mark"></span> DELIVERY JOURNEY</div>
    <h1>Track your <span>shipment.</span></h1><p class="public-lead">${esc(branding.trackingMessage || 'Follow each milestone on its way to the destination.')}</p>
    <div class="public-grid"><div class="public-left">
      <section class="public-card public-hero"><div class="public-hero-top"><div><span class="public-overline">TRACKING NUMBER</span><h2>${esc(s.trackingNumber)}</h2><div class="public-carrier">${icon('truck', 16)} ${esc(s.carrier)}</div></div><div class="public-status status-${esc(s.status)}">${icon(current.icon, 17)} ${esc(current.label)}</div></div>
      <div class="public-divider"></div><div class="public-route"><div class="public-location"><span class="public-overline">ORIGIN</span><strong>${esc(s.originCity)}</strong><span>Shipping from</span></div><div class="public-route-line"><div></div>${icon('truck', 21)}<div></div></div><div class="public-location destination"><span class="public-overline">DESTINATION</span><strong>${esc(s.destinationCity)}</strong><span>Delivery to</span></div></div>
      <div class="public-divider"></div><div class="public-facts"><div><span class="public-overline">ESTIMATED DELIVERY</span><strong>${s.estimatedDelivery ? dateShort(s.estimatedDelivery) : 'To be confirmed'}</strong></div><div><span class="public-overline">LATEST LOCATION</span><strong>${esc(s.location || 'Not reported')}</strong></div></div>
      ${s.status === 'exception' ? `<div class="public-exception">${icon('alert',17)} There is a delivery exception. Please contact the courier for further information.</div>` : ''}
      </section>
      <section class="public-card public-journey"><div class="public-section-head"><div><span class="public-overline">DELIVERY PATH</span><h2>Making progress</h2></div>${icon('route',22)}</div>${stageBar(s)}</section>
    </div><div class="public-right"><section class="public-card public-history"><div class="public-section-head"><div><span class="public-overline">LATEST UPDATES</span><h2>Tracking history</h2></div><span class="public-event-count">${s.events.length} ${s.events.length === 1 ? 'event' : 'events'}</span></div>
      ${history(s.events)}<div class="public-history-foot">${icon('clock', 16)} ${lastUpdate ? `Last event ${timeAgo(lastUpdate)}` : 'Updates appear here as they arrive'}</div></section>
      <div class="public-note">${icon('shield',20)} <span>This page shares tracking milestones only. Recipient information and internal order details remain private.</span></div></div></div>
    <p class="public-refreshed">${icon('refresh',14)} ${s.lastSyncedAt ? `Courier checked ${timeAgo(s.lastSyncedAt)}` : 'Updates are provided by the shipment operator'}</p>`);
}
function missing() {
  app.innerHTML = pageFrame(`<div class="public-empty"><div class="public-empty-icon">${icon('box',38)}</div><h1>Tracking link unavailable</h1><p>The link may have been disabled, replaced or entered incorrectly. Ask the sender for a new tracking link.</p><a class="public-home" href="/">Back to workspace ${icon('arrowRight',16)}</a></div>`);
}
async function load() {
  if (!token) return missing();
  try {
    const response = await fetch(`/api/public/track/${encodeURIComponent(token)}`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return missing();
    const body = await response.json();
    if (!body.shipment || !Array.isArray(body.shipment.events)) return missing();
    app.innerHTML = shipmentView(body.shipment);
  } catch { app.innerHTML = pageFrame(`<div class="public-empty"><div class="public-empty-icon">${icon('alert',38)}</div><h1>Could not load tracking</h1><p>Please check your connection and try again.</p><button type="button" class="public-home" id="public-retry">Try again ${icon('refresh',16)}</button></div>`); }
}
document.addEventListener('click', event => { if (event.target.closest('#public-retry')) load(); });
async function start() {
  try {
    const response = await fetch('/api/public/branding', { credentials:'omit',cache:'no-store' });
    if (response.ok) {const data=await response.json();branding=data.branding;document.documentElement.style.setProperty('--brand-accent',branding.accent);document.title=`${branding.companyName} · Tracking`; }
  } catch { /* Default branding remains usable offline. */ }
  await load();
}
start();
