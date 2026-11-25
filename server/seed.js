import { DEFAULT_PINS, ROLES } from '../shared/constants.js';
import { hashPin, verifyPin } from './auth.js';
import { nowIso } from './util.js';
import { applyMenuCatalog, CATALOG_VERSION } from './catalog.js';

export const DEFAULT_SETTINGS = {
  table_count: '20',
  warn_minutes: '10',
  late_minutes: '20',
  proposal_title: 'Proposta de Novembro',
};

/** Banco novo: configurações e PINs padrão. (O cardápio vem de runDataMigrations.) */
export function seedIfEmpty(db, audit) {
  const has = db.prepare("SELECT value FROM settings WHERE key = 'seeded'").pluck().get();
  if (has) return false;
  const now = nowIso();
  db.transaction(() => {
    const set = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) set.run(k, v);
    for (const [role, pin] of Object.entries(DEFAULT_PINS)) set.run(`pin_${role}`, hashPin(pin));
    set.run('seeded', now);
    audit.log(null, 'system.seed', 'database', null, { perfis: Object.keys(DEFAULT_PINS) });
  })();
  return true;
}

/**
 * Atualizações de dados de bancos que já estão em uso (idempotentes):
 * - cria o PIN do Proprietário, se ainda não existir (5555, ou o próximo livre);
 * - cria configurações novas com o valor padrão;
 * - sincroniza o cardápio com o catálogo oficial quando a versão do catálogo muda.
 */
export function runDataMigrations(db, audit) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?').pluck();
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (get.get(k) == null) set.run(k, v);
    if (!get.get('pin_dono')) {
      const others = ROLES.filter((r) => r !== 'dono').map((r) => get.get(`pin_${r}`));
      let pin = Number(DEFAULT_PINS.dono);
      while (others.some((h) => verifyPin(String(pin), h))) pin++;
      set.run('pin_dono', hashPin(String(pin)));
      audit.log(null, 'system.migration', 'role', 'dono', { acao: 'perfil Proprietário criado' });
    }
  })();

  const version = Number(get.get('menu_catalog_version') || 0);
  if (version < CATALOG_VERSION) {
    const stats = applyMenuCatalog(db, audit);
    set.run('menu_catalog_version', String(CATALOG_VERSION));
    return stats;
  }
  return null;
}
