const ICONS = {
  logo: '<path d="M3 8.5 12 3l9 5.5v7L12 21l-9-5.5v-7Z"/><path d="m3.5 8.5 8.5 5 8.5-5M12 13.5V21M8 5.5l9 5.5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  box: '<path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10M7.5 4.5l9 5"/>',
  truck: '<path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  check: '<path d="m4.5 12.5 5 5L20 7"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.8 2.8L16.5 9"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  arrowUpRight: '<path d="M5 19 19 5M7 5h12v12"/>',
  arrowRight: '<path d="M4 12h16m-7-7 7 7-7 7"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7M5 12h14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4"/>',
  filter: '<path d="M4 6h16M7 12h10m-7 6h4"/>',
  mapPin: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  edit: '<path d="m4 15.5-.5 5 5-.5L19 9.5 14.5 5 4 15.5ZM12.5 7l4.5 4.5"/>',
  trash: '<path d="M4 7h16M10 4h4m-8 3 1 14h10l1-14M10 11v6m4-6v6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7.5 7.5 0 0 1 13-1.5L20 12M4 12l1.5 4.5A7.5 7.5 0 0 0 18.5 15"/>',
  route: '<circle cx="6" cy="5" r="2"/><path d="M6 7v10a4 4 0 0 0 4 4h5M10 5h4a4 4 0 0 1 4 4v8"/><circle cx="18" cy="19" r="2"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  packageCheck: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 4-2.2M12 13v9m4-6 2.2 2.2L22 14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9ZM10 21h4"/>',
  slash: '<path d="M5 19 19 5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>',
  shield: '<path d="M12 2 4 5v6c0 5.5 3.5 9 8 11 4.5-2 8-5.5 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  chart: '<path d="M4 20V11h4v9M10 20V4h4v16M16 20v-7h4v7"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18h2a2 2 0 0 0 1.4-3.4 1.2 1.2 0 0 1 .9-2h2A4.7 4.7 0 0 0 23 11c0-4.4-5-8-11-8Z"/><circle cx="7.5" cy="10" r="1"/><circle cx="11" cy="6.5" r="1"/><circle cx="16.5" cy="8" r="1"/>',
  external: '<path d="M13 5h6v6M19 5l-9 9M19 13v6H5V5h6"/>',
};

export function icon(name, size = 18, className = '') {
  const safe = ICONS[name] || ICONS.box;
  return `<svg class="icon ${className}" width="${Number(size)}" height="${Number(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${safe}</svg>`;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export const STATUS = {
  pending: { label: 'Pending', tone: 'slate', icon: 'clock' },
  picked_up: { label: 'Picked up', tone: 'blue', icon: 'box' },
  in_transit: { label: 'In transit', tone: 'indigo', icon: 'truck' },
  out_for_delivery: { label: 'Out for delivery', tone: 'violet', icon: 'route' },
  delivered: { label: 'Delivered', tone: 'green', icon: 'checkCircle' },
  exception: { label: 'Exception', tone: 'red', icon: 'alert' },
};

export const CARRIERS = ['Blue Dart', 'Delhivery', 'DTDC', 'Ekart', 'India Post', 'Ecom Express', 'DHL', 'FedEx', 'UPS', 'USPS', 'Other'];
export const SERVICES = ['Standard', 'Express', 'Priority'];

export function badge(status) {
  const config = STATUS[status] || STATUS.pending;
  return `<span class="badge badge-${config.tone}"><span class="badge-dot"></span>${config.label}</span>`;
}
export function dateShort(date) {
  if (!date) return 'Not set';
  const parsed = new Date(date.length === 10 ? `${date}T12:00:00` : date);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(parsed);
}
export function dateMini(date) {
  if (!date) return '—';
  const parsed = new Date(date.length === 10 ? `${date}T12:00:00` : date);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(parsed);
}
export function timeAgo(date) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 50) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return dateShort(date);
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('').toUpperCase();
}
export function clipped(value, max = 24) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
