import crypto from 'node:crypto';
import { ROLES, MANAGER_ROLES } from '../shared/constants.js';
import { HttpError, nowIso, cleanText } from './util.js';

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (!stored || typeof pin !== 'string' && typeof pin !== 'number') return false;
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const PIN_RE = /^\d{4,8}$/;

export function createAuth({ db, audit }) {
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?').pluck();
  const insertSession = db.prepare(
    'INSERT INTO sessions (token, role, name, device_id, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE token = ? AND revoked_at IS NULL');
  const revokeStmt = db.prepare('UPDATE sessions SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL');
  const revokeRoleStmt = db.prepare('UPDATE sessions SET revoked_at = ? WHERE role = ? AND revoked_at IS NULL');
  const setSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  const cache = new Map(); // token -> sessão (evita consulta a cada requisição)

  function roleForPin(pin) {
    for (const role of ROLES) {
      if (verifyPin(String(pin), getSetting.get(`pin_${role}`))) return role;
    }
    return null;
  }

  const loginTx = db.transaction(({ role, name, deviceId }) => {
    const token = crypto.randomBytes(24).toString('base64url');
    insertSession.run(token, role, name || null, deviceId || null, nowIso());
    audit.log({ role, name, deviceId }, 'auth.login', 'session', token.slice(0, 8));
    return token;
  });

  function login({ pin, name, deviceId }) {
    if (!PIN_RE.test(String(pin ?? ''))) throw new HttpError(400, 'BAD_PIN', 'PIN deve ter de 4 a 8 dígitos.');
    const role = roleForPin(String(pin));
    if (!role) throw new HttpError(401, 'WRONG_PIN', 'PIN incorreto.');
    const cleanName = cleanText(name, 40) || null;
    const cleanDevice = cleanText(deviceId, 64) || null;
    const token = loginTx({ role, name: cleanName, deviceId: cleanDevice });
    return { token, role, name: cleanName };
  }

  function getSession(token) {
    if (!token) return null;
    if (cache.has(token)) return cache.get(token);
    const row = getSessionStmt.get(token);
    if (!row) return null;
    const session = { token: row.token, role: row.role, name: row.name, deviceId: row.device_id };
    cache.set(token, session);
    return session;
  }

  function logout(actor) {
    db.transaction(() => {
      revokeStmt.run(nowIso(), actor.token);
      audit.log(actor, 'auth.logout', 'session', actor.token.slice(0, 8));
    })();
    cache.delete(actor.token);
  }

  /** Autorizações que exigem "PIN de Admin" aceitam também o PIN do Proprietário. */
  function verifyAdminPin(pin) {
    if (!PIN_RE.test(String(pin ?? ''))) return false;
    return MANAGER_ROLES.some((r) => verifyPin(String(pin), getSetting.get(`pin_${r}`)));
  }

  /** Troca o PIN de um perfil e encerra as sessões existentes desse perfil. */
  function changePin(actor, role, newPin) {
    if (!ROLES.includes(role)) throw new HttpError(400, 'BAD_ROLE', 'Perfil inválido.');
    if (role === 'dono' && actor.role !== 'dono') {
      throw new HttpError(403, 'FORBIDDEN', 'Somente o Proprietário pode trocar o próprio PIN.');
    }
    if (!PIN_RE.test(String(newPin ?? ''))) throw new HttpError(400, 'BAD_PIN', 'O PIN deve ter de 4 a 8 dígitos.');
    for (const other of ROLES) {
      if (other !== role && verifyPin(String(newPin), getSetting.get(`pin_${other}`))) {
        throw new HttpError(409, 'PIN_IN_USE', 'Este PIN já é usado por outro perfil.');
      }
    }
    db.transaction(() => {
      setSetting.run(`pin_${role}`, hashPin(String(newPin)));
      if (!MANAGER_ROLES.includes(role)) revokeRoleStmt.run(nowIso(), role);
      audit.log(actor, 'settings.pin_change', 'role', role, { sessoesEncerradas: !MANAGER_ROLES.includes(role) });
    })();
    for (const [token, s] of cache) if (s.role === role && !MANAGER_ROLES.includes(role)) cache.delete(token);
  }

  return { login, logout, getSession, verifyAdminPin, changePin };
}
