import Database from 'better-sqlite3';

/**
 * Esquema do banco. Regras de integridade ficam no próprio SQLite (gatilhos),
 * para que nenhum erro de código consiga apagar ou alterar registros financeiros.
 */
const SCHEMA_V1 = `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  token        TEXT PRIMARY KEY,
  role         TEXT NOT NULL,
  name         TEXT,
  device_id    TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE TABLE menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  in_combo    INTEGER NOT NULL DEFAULT 0 CHECK (in_combo IN (0, 1)),
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Conta (comanda) de uma mesa. Uma mesa só pode ter uma conta não fechada.
CREATE TABLE tabs (
  id                 TEXT PRIMARY KEY,
  table_number       INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open', 'billing', 'closed')),
  business_date      TEXT NOT NULL,
  opened_at          TEXT NOT NULL,
  opened_by_role     TEXT,
  opened_by_name     TEXT,
  bill_requested_at  TEXT,
  closed_at          TEXT,
  closed_by_role     TEXT,
  closed_by_name     TEXT,
  closed_total_cents INTEGER,
  reopen_count       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX tabs_one_active_per_table ON tabs (table_number) WHERE status <> 'closed';
CREATE INDEX tabs_business_date ON tabs (business_date);

-- Pedido = uma rodada enviada à cozinha. O id (UUID) é gerado no aparelho do garçom.
CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  tab_id            TEXT NOT NULL REFERENCES tabs (id),
  table_number      INTEGER NOT NULL,
  seq               INTEGER NOT NULL,
  business_date     TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('novo', 'preparando', 'pronto', 'entregue')),
  created_by_role   TEXT NOT NULL,
  created_by_name   TEXT,
  device_id         TEXT,
  client_created_at TEXT,
  received_at       TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  UNIQUE (business_date, seq)
);
CREATE INDEX orders_tab ON orders (tab_id);
CREATE INDEX orders_status ON orders (status);
CREATE INDEX orders_business_date ON orders (business_date);

-- Itens enviados: imutáveis. Nome, categoria e preço são congelados no momento do pedido.
CREATE TABLE order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders (id),
  line_no          INTEGER NOT NULL,
  menu_item_id     INTEGER NOT NULL REFERENCES menu_items (id),
  name             TEXT NOT NULL,
  category         TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  notes            TEXT NOT NULL DEFAULT '',
  components       TEXT NOT NULL DEFAULT '[]', -- escolhas do Menu Completo (JSON), congeladas
  created_at       TEXT NOT NULL,
  UNIQUE (order_id, line_no)
);
CREATE INDEX order_items_order ON order_items (order_id);

-- Cancelamentos: registro separado, somente inserção. O item original permanece intacto.
CREATE TABLE cancellations (
  id            TEXT PRIMARY KEY,
  order_item_id TEXT NOT NULL REFERENCES order_items (id),
  qty           INTEGER NOT NULL CHECK (qty > 0),
  reason        TEXT NOT NULL,
  by_role       TEXT NOT NULL,
  by_name       TEXT,
  device_id     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX cancellations_item ON cancellations (order_item_id);

-- Log de auditoria encadeado por hash (cada linha inclui o hash da anterior).
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_role  TEXT NOT NULL,
  actor_name  TEXT,
  device_id   TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX audit_log_at ON audit_log (at);

-- ---------- Gatilhos de proteção (defesa em profundidade) ----------

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: o log de auditoria não pode ser alterado'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: o log de auditoria não pode ser apagado'); END;

CREATE TRIGGER order_items_no_update BEFORE UPDATE ON order_items
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: itens enviados são imutáveis (use cancelamento)'); END;
CREATE TRIGGER order_items_no_delete BEFORE DELETE ON order_items
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: itens enviados não podem ser apagados'); END;

CREATE TRIGGER cancellations_no_update BEFORE UPDATE ON cancellations
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: cancelamentos não podem ser alterados'); END;
CREATE TRIGGER cancellations_no_delete BEFORE DELETE ON cancellations
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: cancelamentos não podem ser apagados'); END;

CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: pedidos não podem ser apagados'); END;
CREATE TRIGGER orders_frozen_fields
BEFORE UPDATE OF id, tab_id, table_number, seq, business_date, created_by_role, created_by_name,
                 device_id, client_created_at, received_at, payload_hash ON orders
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: dados de origem do pedido não podem ser alterados'); END;

CREATE TRIGGER tabs_no_delete BEFORE DELETE ON tabs
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: contas não podem ser apagadas'); END;
CREATE TRIGGER tabs_frozen_fields BEFORE UPDATE OF id, table_number, business_date, opened_at ON tabs
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: dados de abertura da conta não podem ser alterados'); END;

CREATE TRIGGER menu_items_no_delete BEFORE DELETE ON menu_items
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: itens do cardápio não são apagados (desative-os)'); END;

CREATE TRIGGER orders_require_open_tab BEFORE INSERT ON orders
WHEN (SELECT status FROM tabs WHERE id = NEW.tab_id) IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'CONTA_FECHADA: a conta desta mesa não está aberta'); END;

CREATE TRIGGER order_items_require_open_tab BEFORE INSERT ON order_items
WHEN (SELECT t.status FROM orders o JOIN tabs t ON t.id = o.tab_id WHERE o.id = NEW.order_id) IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'CONTA_FECHADA: a conta desta mesa não está aberta'); END;

CREATE TRIGGER cancellations_require_unclosed_tab BEFORE INSERT ON cancellations
WHEN (SELECT t.status FROM order_items i JOIN orders o ON o.id = i.order_id JOIN tabs t ON t.id = o.tab_id
      WHERE i.id = NEW.order_item_id) = 'closed'
BEGIN SELECT RAISE(ABORT, 'CONTA_FECHADA: reabra a conta antes de cancelar itens'); END;

CREATE TRIGGER cancellations_not_exceed BEFORE INSERT ON cancellations
WHEN NEW.qty + (SELECT COALESCE(SUM(qty), 0) FROM cancellations WHERE order_item_id = NEW.order_item_id)
     > (SELECT qty FROM order_items WHERE id = NEW.order_item_id)
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: quantidade cancelada maior que a enviada'); END;
`;

// V2: itens do cardápio podem ser excluídos se nunca foram pedidos; os já pedidos são arquivados.
const SCHEMA_V2 = `
ALTER TABLE menu_items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
DROP TRIGGER menu_items_no_delete;
CREATE TRIGGER menu_items_no_delete BEFORE DELETE ON menu_items
WHEN EXISTS (SELECT 1 FROM order_items WHERE menu_item_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'PROTEGIDO: item que já consta em pedidos não pode ser apagado (é arquivado)'); END;
CREATE INDEX audit_log_entity ON audit_log (entity_id);
`;

export const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2];

/** targetVersion existe apenas para os testes simularem um banco antigo. */
export function openDatabase(file, { targetVersion = MIGRATIONS.length } = {}) {
  const db = new Database(file);
  // WAL + synchronous=FULL: cada transação confirmada está no disco antes da resposta ao aparelho.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, targetVersion);
  return db;
}

function migrate(db, targetVersion) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < targetVersion; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
