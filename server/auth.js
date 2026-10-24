import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { InputError } from './validation.js';

const roles = new Set(['admin', 'operator', 'viewer']);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const cleanUser = ({ password_hash, ...user }) => user;
const validEmail = (email) => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
function passwordHash(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${digest.toString('hex')}`;
}
function checkPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, digest] = stored.split(':');
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(digest)) return false;
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), 64), Buffer.from(digest, 'hex'));
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) throw new InputError('Password must be at least 12 characters (maximum 256 bytes).');
}
export class AuthService {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
  }
  initialized() { return !!this.db.prepare('SELECT id FROM users LIMIT 1').get(); }
  create(data, role = 'viewer') {
    const name = String(data?.name || '').trim();
    const email = String(data?.email || '').trim().toLowerCase();
    if (name.length < 2 || name.length > 100 || !validEmail(email)) throw new InputError('Enter a valid name and email address.');
    if (!roles.has(role)) throw new InputError('Invalid account role.');
    validatePassword(data.password);
    const user = { id: randomUUID(), name, email, role, created_at: new Date().toISOString() };
    try {
      this.db.prepare('INSERT INTO users (id,name,email,role,password_hash,created_at) VALUES (?,?,?,?,?,?)').run(user.id, name, email, role, passwordHash(data.password), user.created_at);
    } catch (error) { if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new InputError('An account with that email already exists.', undefined, 409); throw error; }
    return user;
  }
  setup(data) { if (this.initialized()) throw new InputError('Workspace setup is complete.', undefined, 409); return this.create(data, 'admin'); }
  login(data) {
    const email = String(data?.email || '').trim().toLowerCase();
    const password = data?.password;
    const user = this.db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (typeof password !== 'string' || !user || !checkPassword(password, user.password_hash)) throw new InputError('Invalid email or password.', undefined, 401);
    return { user: cleanUser(user), token: this.issue(user.id) };
  }
  issue(userId) {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(hashToken(token), userId, Date.now() + 7 * 86400_000);
    return token;
  }
  me(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token), Date.now());
    return row ? cleanUser(row) : null;
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); }
  listUsers() { return this.db.prepare('SELECT id,name,email,role,created_at FROM users ORDER BY created_at').all(); }
  changeRole(id, role, actorId) {
    if (!roles.has(role)) throw new InputError('Invalid role.');
    if (id === actorId && role !== 'admin') throw new InputError('You cannot remove your own admin access.');
    const changed = this.db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
    if (!changed.changes) throw new InputError('User not found.', undefined, 404);
    return this.db.prepare('SELECT id,name,email,role,created_at FROM users WHERE id=?').get(id);
  }
  removeUser(id, actorId) {
    if (id === actorId) throw new InputError('You cannot delete your own account.');
    const changed = this.db.prepare('DELETE FROM users WHERE id=?').run(id);
    if (!changed.changes) throw new InputError('User not found.', undefined, 404);
  }
}
export const parseSession = (req) => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('shiptrack_session='))?.slice('shiptrack_session='.length) || '';
export const cookie = (token, secure = false) => `shiptrack_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`;
export const clearCookie = (secure = false) => `shiptrack_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
