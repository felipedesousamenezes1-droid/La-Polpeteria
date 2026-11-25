import { nowIso, sha256 } from './util.js';

const GENESIS = 'GENESIS';

function computeHash(row) {
  return sha256(
    [
      row.prev_hash,
      row.at,
      row.actor_role,
      row.actor_name ?? '',
      row.device_id ?? '',
      row.action,
      row.entity_type ?? '',
      row.entity_id ?? '',
      row.details ?? '',
    ].join('\u001f'),
  );
}

/**
 * Log de auditoria somente-inserção e encadeado por hash.
 * Deve ser chamado DENTRO da mesma transação da alteração auditada.
 */
export function createAudit(db) {
  const lastHash = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').pluck();
  const insert = db.prepare(`
    INSERT INTO audit_log (at, actor_role, actor_name, device_id, action, entity_type, entity_id, details, prev_hash, hash)
    VALUES (@at, @actor_role, @actor_name, @device_id, @action, @entity_type, @entity_id, @details, @prev_hash, @hash)
  `);
  const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) FROM audit_log').pluck();

  function log(actor, action, entityType = null, entityId = null, details = null) {
    const row = {
      at: nowIso(),
      actor_role: actor?.role ?? 'sistema',
      actor_name: actor?.name ?? null,
      device_id: actor?.deviceId ?? null,
      action,
      entity_type: entityType,
      entity_id: entityId == null ? null : String(entityId),
      details: details == null ? null : JSON.stringify(details),
      prev_hash: lastHash.get() ?? GENESIS,
    };
    row.hash = computeHash(row);
    insert.run(row);
  }

  /** Recalcula toda a cadeia de hashes; detecta qualquer adulteração direta no arquivo. */
  function verify() {
    let prev = GENESIS;
    let count = 0;
    for (const row of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
      count++;
      if (row.prev_hash !== prev || computeHash(row) !== row.hash) {
        return { ok: false, count, brokenAtId: row.id };
      }
      prev = row.hash;
    }
    return { ok: true, count, brokenAtId: null };
  }

  function list({ startIso, endIso, limit = 500 }) {
    return db
      .prepare('SELECT * FROM audit_log WHERE at >= ? AND at < ? ORDER BY id DESC LIMIT ?')
      .all(startIso, endIso, limit)
      .map((r) => ({
        id: r.id,
        at: r.at,
        actorRole: r.actor_role,
        actorName: r.actor_name,
        deviceId: r.device_id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        details: r.details ? JSON.parse(r.details) : null,
        hash: r.hash,
      }));
  }

  return { log, verify, list, lastId: () => maxId.get() };
}
