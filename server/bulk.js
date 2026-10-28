import { InputError, validateShipment } from './validation.js';

const MAX_ROWS = 500;
const MAX_CSV_CHARS = 600_000;
export const CSV_COLUMNS = Object.freeze([
  ['trackingNumber', 'Tracking number'], ['carrier', 'Carrier'], ['recipientName', 'Recipient'],
  ['recipientEmail', 'Recipient email'], ['originCity', 'Origin'], ['destinationCity', 'Destination'],
  ['service', 'Service'], ['packageDescription', 'Description'], ['weightKg', 'Weight (kg)'],
  ['reference', 'Order reference'], ['shippedAt', 'Shipped at'], ['estimatedDelivery', 'Estimated delivery'],
  ['notes', 'Notes'], ['notificationOptIn', 'Email opt-in'],
]);
const aliases = new Map([
  ['trackingnumber','trackingNumber'], ['trackingid','trackingNumber'],
  ['carrier','carrier'], ['courier','carrier'],
  ['recipient','recipientName'], ['recipientname','recipientName'], ['customer','recipientName'],
  ['recipientemail','recipientEmail'], ['email','recipientEmail'],
  ['origin','originCity'], ['origincity','originCity'],
  ['destination','destinationCity'], ['destinationcity','destinationCity'],
  ['service','service'], ['description','packageDescription'], ['packagedescription','packageDescription'],
  ['weightkg','weightKg'], ['weight','weightKg'],
  ['orderreference','reference'], ['reference','reference'],
  ['shippedat','shippedAt'], ['shippingdate','shippedAt'],
  ['estimateddelivery','estimatedDelivery'], ['eta','estimatedDelivery'],
  ['notes','notes'], ['emailoptin','notificationOptIn'], ['notificationoptin','notificationOptIn'],
]);
const required = ['trackingNumber', 'carrier', 'recipientName', 'originCity', 'destinationCity'];
const normalized = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

export function csvTemplate() {
  return '\ufeff' + CSV_COLUMNS.map(([, title]) => quote(title)).join(',') + '\r\n';
}

export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new InputError('Choose a non-empty CSV file.');
  if (text.length > MAX_CSV_CHARS) throw new InputError('CSV exceeds the 600 KB import limit.', undefined, 413);
  // RFC 4180 style comma CSV, supporting escaped quotes, quoted line breaks and CRLF.
  const rows = [];
  let row = [], field = '', inside = false, endedQuote = false;
  const csv = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inside) {
      if (ch === '"' && csv[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inside = false; endedQuote = true; }
      else field += ch;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(field); field = ''; endedQuote = false;
      if (ch !== ',') {
        if (row.some(v => v.trim())) rows.push(row);
        row = [];
        if (ch === '\r' && csv[i + 1] === '\n') i++;
        if (rows.length > MAX_ROWS + 1) throw new InputError(`Import up to ${MAX_ROWS} shipments at once.`, undefined, 413);
      }
    } else if (ch === '"' && field === '' && !endedQuote) inside = true;
    else if (endedQuote && (ch === ' ' || ch === '\t')) { /* whitespace after closing quote */ }
    else if (endedQuote || ch === '"') throw new InputError('Malformed CSV: unexpected characters after a quote.');
    else field += ch;
  }
  if (inside) throw new InputError('Malformed CSV: unclosed quoted field.');
  if (field || row.length) { row.push(field); if (row.some(v => v.trim())) rows.push(row); }
  if (!rows.length) throw new InputError('CSV does not contain a header row.');
  const titles = rows.shift();
  if (rows.length > MAX_ROWS) throw new InputError(`Import up to ${MAX_ROWS} shipments at once.`, undefined, 413);
  if (!rows.length) throw new InputError('CSV has a header but no shipment rows.');
  const columns = titles.map(t => aliases.get(normalized(t)) || null);
  for (const name of required) if (!columns.includes(name)) throw new InputError(`Missing required CSV column: ${CSV_COLUMNS.find(x => x[0] === name)[1]}.`);
  if (new Set(columns.filter(Boolean)).size !== columns.filter(Boolean).length) throw new InputError('CSV has duplicate or overlapping column headings.');
  return rows.map((values, index) => {
    const data = {};
    for (let i = 0; i < columns.length; i++) {
      if (columns[i]) data[columns[i]] = (values[i] || '').trim();
      else if (i >= titles.length && values[i]?.trim()) throw new InputError(`Row ${index + 2} has extra columns.`);
    }
    return { row: index + 2, data };
  });
}

export function analyzeCsv(text, store, { skipDuplicates = true } = {}) {
  if (typeof skipDuplicates !== 'boolean') throw new InputError('skipDuplicates must be true or false.');
  const rows = parseCsv(text);
  const errors = [], records = [], examples = [], seen = new Set();
  let skipped = 0;
  for (const entry of rows) {
    const data = { ...entry.data };
    if (!data.service) delete data.service;
    if (!data.weightKg) delete data.weightKg;
    else { const value = Number(data.weightKg); data.weightKg = Number.isFinite(value) ? value : data.weightKg; }
    const consent = String(data.notificationOptIn || '').toLowerCase();
    if (consent && !['true', 'false', 'yes', 'no', '1', '0'].includes(consent)) {
      errors.push({ row: entry.row, error: 'Email opt-in must be yes/no or true/false.' });
      continue;
    }
    data.notificationOptIn = ['true', 'yes', '1'].includes(consent);
    try {
      const record = validateShipment(data);
      if (record.notificationOptIn && !record.recipientEmail) throw new InputError('Opted-in shipments require a recipient email.');
      const key = `${record.carrier.toLowerCase()}\0${record.trackingNumber.toLowerCase()}`;
      if (seen.has(key) || store.hasDuplicate(record.carrier, record.trackingNumber)) {
        if (skipDuplicates) { skipped++; continue; }
        throw new InputError('Duplicate carrier and tracking number.');
      }
      seen.add(key);
      records.push(record);
      if (examples.length < 8) examples.push({ trackingNumber: record.trackingNumber, carrier: record.carrier, recipientName: record.recipientName, route: `${record.originCity} → ${record.destinationCity}` });
    } catch (e) {
      errors.push({ row: entry.row, error: e instanceof InputError ? e.details ? Object.entries(e.details).map(([k,v])=>`${k}: ${v}`).join('; ') : e.message : 'Invalid shipment data.' });
    }
  }
  return { total: rows.length, ready: records.length, skipped, errors, examples, records };
}
