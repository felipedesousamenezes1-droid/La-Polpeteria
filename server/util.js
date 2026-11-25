import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const nowIso = () => new Date().toISOString();

/** Data local (fuso do restaurante, variável TZ) no formato AAAA-MM-DD. */
export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Intervalo [início, fim) em ISO/UTC correspondente a um dia local. */
export function localDayRange(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'BAD_DATE', 'Data inválida (use AAAA-MM-DD).');
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function previousLocalDate(date, days = 1) {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d - days, 12));
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function cleanText(value, max) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}
