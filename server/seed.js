import { DEFAULT_PINS, ROLES, DEFAULT_CATEGORIES } from '../shared/constants.js';
import { hashPin, verifyPin } from './auth.js';
import { nowIso } from './util.js';
import { applyMenuCatalog, CATALOG_VERSION, CATALOG } from './catalog.js';

export const DEFAULT_SETTINGS = {
  table_count: '20',
  warn_minutes: '10',
  late_minutes: '20',
  proposal_title: 'Proposta de Novembro',
  service_default: '1',
  service_pct: '10',
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
 * - cria as seções do cardápio (uma vez) a partir das seções padrão e das já usadas;
 * - sincroniza o cardápio com o catálogo oficial quando a versão do catálogo muda;
 * - inclui a "Taxa de rolha" (uma vez; se o Admin excluir depois, não volta).
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

  let stats = null;
  const version = Number(get.get('menu_catalog_version') || 0);
  if (version < CATALOG_VERSION) {
    stats = applyMenuCatalog(db, audit);
    set.run('menu_catalog_version', String(CATALOG_VERSION));
  }

  // Seções (tabela criada na versão 3 do banco).
  db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) FROM menu_categories').pluck().get();
    if (count > 0) return;
    const ins = db.prepare('INSERT OR IGNORE INTO menu_categories (name, group_key, sort, kitchen, course, in_service) VALUES (?, ?, ?, ?, ?, ?)');
    DEFAULT_CATEGORIES.forEach((c, i) => ins.run(c.name, c.group, (i + 1) * 10, c.kitchen ? 1 : 0, c.course, c.inService ? 1 : 0));
    // Seções que já existiam nos itens e não estão na lista padrão ficam em "Outros".
    const extra = db.prepare('SELECT DISTINCT category FROM menu_items WHERE archived = 0').pluck().all();
    extra.forEach((name, i) => ins.run(name, 'outros', 1000 + i * 10, 0, null, 1));
    audit.log(null, 'system.migration', 'menu', null, { acao: 'seções do cardápio criadas' });
  })();

  if (!get.get('migration_rolha')) {
    db.transaction(() => {
      const exists = db.prepare("SELECT 1 FROM menu_items WHERE name = 'Taxa de rolha' AND archived = 0").pluck().get();
      if (!exists) {
        const r = CATALOG.find((m) => m.name === 'Taxa de rolha');
        const sort = db.prepare("SELECT COALESCE(MAX(sort), 0) + 10 FROM menu_items WHERE category = 'Outros'").pluck().get();
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO menu_items (name, description, category, price_cents, active, in_combo, archived, sort, created_at, updated_at)
          VALUES (?, ?, 'Outros', ?, 1, 0, 0, ?, ?, ?)`).run(r.name, r.description, r.price, sort, now, now);
        audit.log(null, 'system.migration', 'menu', null, { acao: 'Taxa de rolha incluída em Outros' });
      }
      set.run('migration_rolha', '1');
    })();
  }
  return stats;
}
