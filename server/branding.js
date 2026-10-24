import { InputError } from './validation.js';

const DEFAULTS = Object.freeze({
  companyName: 'Shipment Tracker', shortName: 'ST', accent: '#4959db',
  supportEmail: '', trackingMessage: 'Follow every milestone on the way to your destination.',
});
const isEmail = s => !s || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 160);
function contrastWithWhite(hex) {
  const c = [1,3,5].map(offset => parseInt(hex.slice(offset,offset+2),16)/255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return 1.05 / (.2126*c[0] + .7152*c[1] + .0722*c[2] + .05);
}

export class BrandingService {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS workspace_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    this.getSetting = db.prepare('SELECT value FROM workspace_settings WHERE key=?');
    this.putSetting = db.prepare('INSERT INTO workspace_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.deleteSetting = db.prepare('DELETE FROM workspace_settings WHERE key=?');
  }
  get() {
    let values = {};
    try { values = JSON.parse(this.getSetting.get('branding')?.value || '{}'); } catch { /* fallback */ }
    return { ...DEFAULTS, ...values, hasLogo: Boolean(this.getSetting.get('logo')?.value) };
  }
  update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Branding must be an object.');
    const keys = Object.keys(DEFAULTS);
    if (Object.keys(input).some(key => !keys.includes(key))) throw new InputError('Unknown branding field.');
    const updated = { ...this.get() };
    for (const key of keys) {
      if (!(key in input)) continue;
      if (typeof input[key] !== 'string') throw new InputError(`${key} must be text.`);
      const value = input[key].trim();
      if (key === 'companyName' && (value.length < 2 || value.length > 60)) throw new InputError('Workspace name must be 2–60 characters.');
      if (key === 'shortName' && !/^[\p{L}\p{N}]{1,3}$/u.test(value)) throw new InputError('Logo initials must contain 1–3 letters or numbers.');
      if (key === 'accent' && !/^#[0-9a-fA-F]{6}$/.test(value)) throw new InputError('Accent must be a six-digit hex color.');
      if (key === 'accent' && contrastWithWhite(value) < 4.5) throw new InputError('Choose a darker accent color for readable buttons (minimum 4.5:1 contrast).');
      if (key === 'supportEmail' && !isEmail(value)) throw new InputError('Enter a valid support email.');
      if (key === 'trackingMessage' && value.length > 180) throw new InputError('Tracking message must be at most 180 characters.');
      updated[key] = value;
    }
    const { hasLogo, ...withoutLogo } = updated;
    this.putSetting.run('branding', JSON.stringify(withoutLogo));
    return this.get();
  }
  logo() {
    const raw = this.getSetting.get('logo')?.value;
    if (!raw) return null;
    const [mime, base64] = raw.split(':', 2);
    if (!['image/png', 'image/jpeg'].includes(mime)) return null;
    return { mime, bytes: Buffer.from(base64, 'base64') };
  }
  saveLogo(input) {
    if (!input || typeof input !== 'object' || typeof input.image !== 'string') throw new InputError('Upload a PNG or JPEG image.');
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.image);
    if (!match) throw new InputError('Only PNG or JPEG image files are supported.');
    if (match[2].length > 350_000) throw new InputError('Logo must be 250 KB or smaller.', undefined, 413);
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length < 20 || bytes.length > 250_000) throw new InputError('Logo must be a valid image under 250 KB.');
    const good = match[1] === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!good) throw new InputError('Image content does not match its file type.');
    this.putSetting.run('logo', `${match[1]}:${bytes.toString('base64')}`);
    return { hasLogo: true };
  }
  removeLogo() { this.deleteSetting.run('logo'); return { hasLogo: false }; }
}
