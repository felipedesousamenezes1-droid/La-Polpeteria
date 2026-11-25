import fs from 'node:fs';
import path from 'node:path';
import { localDate, localDayRange, previousLocalDate, nowIso } from './util.js';
import { ROLE_LABELS, ORDER_STATUS_LABELS, TAB_STATUS_LABELS } from '../shared/constants.js';

const money = (cents) => (cents / 100).toFixed(2).replace('.', ',');

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Monta a exportação de um dia (JSON completo + CSV por item, pronto para Excel em pt-BR). */
export function buildDayExport({ services, audit }, date) {
  const h = services.history(date);
  const { startIso, endIso } = localDayRange(date);
  const tabsById = new Map(h.tabs.map((t) => [t.id, t]));

  const header = [
    'data', 'pedido_n', 'mesa', 'conta_id', 'status_conta', 'enviado_em', 'lancado_por', 'categoria', 'item',
    'observacoes', 'qtd_enviada', 'qtd_cancelada', 'qtd_valida', 'preco_unitario', 'subtotal_valido', 'status_pedido',
    'cancelamentos',
  ];
  const rows = [header.join(';')];
  for (const o of h.orders) {
    const tab = tabsById.get(o.tabId) || services.getTab(o.tabId);
    for (const i of o.items) {
      rows.push(
        [
          o.businessDate,
          o.seq,
          o.tableNumber,
          o.tabId,
          TAB_STATUS_LABELS[tab?.status] || '',
          new Date(o.receivedAt).toLocaleString('pt-BR'),
          `${ROLE_LABELS[o.createdBy.role] || o.createdBy.role}${o.createdBy.name ? ` (${o.createdBy.name})` : ''}`,
          i.category,
          i.components?.length ? `${i.name} (${i.components.map((c) => c.name).join(' + ')})` : i.name,
          i.notes,
          i.qty,
          i.cancelledQty,
          i.activeQty,
          money(i.unitPriceCents),
          money(i.activeQty * i.unitPriceCents),
          ORDER_STATUS_LABELS[o.status],
          i.cancellations
            .map((c) => `${c.qty}x ${c.reason} - ${ROLE_LABELS[c.by.role] || c.by.role} ${new Date(c.createdAt).toLocaleTimeString('pt-BR')}`)
            .join(' | '),
        ]
          .map(csvCell)
          .join(';'),
      );
    }
  }
  const csv = `﻿${rows.join('\r\n')}\r\n`;

  const json = JSON.stringify(
    {
      restaurante: 'La Polpeteria',
      data: date,
      geradoEm: nowIso(),
      resumo: h.summary,
      contas: h.tabs.map((t) => ({ ...t, conta: services.getBill(t.id) })),
      pedidos: h.orders,
      cancelamentos: h.cancellations,
      auditoria: audit.list({ startIso, endIso, limit: 100000 }).reverse(),
    },
    null,
    2,
  );
  return { csv, json };
}

/**
 * Backups online do SQLite (API de backup, consistente mesmo com o servidor em uso)
 * e exportações diárias automáticas.
 */
export function createBackupManager({ db, audit, services, dataDir, keep = 50, intervalMs = 10 * 60_000, logger = console }) {
  const backupDir = path.join(dataDir, 'backups');
  const exportDir = path.join(dataDir, 'exports');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(exportDir, { recursive: true });

  let lastBackedUpAuditId = -1;
  let timer = null;
  let running = Promise.resolve();

  function list() {
    return fs
      .readdirSync(backupDir)
      .filter((f) => f.endsWith('.sqlite'))
      .sort()
      .reverse()
      .map((name) => {
        const st = fs.statSync(path.join(backupDir, name));
        return { name, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
      });
  }

  function prune() {
    const files = list();
    for (const f of files.slice(keep)) fs.rmSync(path.join(backupDir, f.name), { force: true });
  }

  function stamp() {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${localDate(d)}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  }

  async function doBackup(reason) {
    const auditId = audit.lastId();
    const name = `polpeteria_${stamp()}_${reason}.sqlite`;
    const tmp = path.join(backupDir, `${name}.tmp`);
    await db.backup(tmp);
    fs.renameSync(tmp, path.join(backupDir, name));
    lastBackedUpAuditId = auditId;
    prune();
    return name;
  }

  /** Enfileira backups para nunca rodarem dois ao mesmo tempo. */
  function backupNow(reason = 'manual') {
    const p = running.then(() => doBackup(reason));
    running = p.catch(() => {});
    return p;
  }

  function exportDay(date) {
    const { csv, json } = buildDayExport({ services, audit }, date);
    writeAtomic(path.join(exportDir, `${date}.csv`), csv);
    writeAtomic(path.join(exportDir, `${date}.json`), json);
    return { csv: `${date}.csv`, json: `${date}.json` };
  }

  /** Garante a exportação dos últimos 7 dias encerrados que tiveram movimento. */
  function ensureDailyExports() {
    const today = localDate();
    for (let i = 1; i <= 7; i++) {
      const date = previousLocalDate(today, i);
      if (fs.existsSync(path.join(exportDir, `${date}.json`))) continue;
      const count = db.prepare('SELECT COUNT(*) FROM orders WHERE business_date = ?').pluck().get(date);
      if (count > 0) {
        exportDay(date);
        logger.log(`[export] Exportação diária gerada: ${date}`);
      }
    }
  }

  async function tick() {
    try {
      if (audit.lastId() !== lastBackedUpAuditId) {
        const name = await backupNow('auto');
        logger.log(`[backup] ${name}`);
      }
      ensureDailyExports();
    } catch (err) {
      logger.error('[backup] Falha no backup automático:', err);
    }
  }

  function start() {
    // Backup imediato na inicialização e depois a cada intervalo (apenas se houve alteração).
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await running;
  }

  return { start, stop, backupNow, list, exportDay, ensureDailyExports, backupDir, exportDir };
}
