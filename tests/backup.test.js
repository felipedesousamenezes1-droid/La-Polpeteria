// Backup, exportação e proteção contra disco temporário na nuvem.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { startServer, tmpDataDir, login, newOrder, ROOT, ID, PRICE } from './helpers.js';

const servers = [];
after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
});

describe('Backup e recuperação', () => {
  test('backup automático na inicialização, backup manual e retenção dos últimos N', { timeout: 30_000 }, async () => {
    const dataDir = tmpDataDir('backup');
    const srv = await startServer({ dataDir, env: { BACKUP_KEEP: '3' } });
    servers.push(srv);
    const garcom = await login(srv.base, 'garcom');
    const admin = await login(srv.base, 'admin');
    await garcom.post('/api/orders', newOrder(1, [[ID.risotto, 2]]));
    await garcom.post('/api/orders', newOrder(2, [[ID.trapanese, 1]]));

    for (let i = 0; i < 4; i++) assert.equal((await admin.post('/api/admin/backups')).status, 201);
    const list = (await admin.get('/api/admin/backups')).data;
    assert.equal(list.files.length, 3, 'mantém apenas os últimos 3 (BACKUP_KEEP)');

    // O backup mais recente é um banco completo e íntegro, com os pedidos.
    const latest = path.join(dataDir, 'backups', list.files[0].name);
    const db = new Database(latest, { readonly: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 2);
    assert.equal(db.prepare('SELECT COUNT(*) FROM order_items').pluck().get(), 2);
    db.close();
  });

  test('restaurar a partir de um backup devolve todos os pedidos', { timeout: 30_000 }, async () => {
    const dataDir = tmpDataDir('restore');
    const srv = await startServer({ dataDir });
    const garcom = await login(srv.base, 'garcom');
    const admin = await login(srv.base, 'admin');
    const o = (await garcom.post('/api/orders', newOrder(3, [[ID.tiramisu, 2]]))).data.order;
    const { name } = (await admin.post('/api/admin/backups')).data;
    await srv.stop();

    // Simula perda do banco principal e restauração do backup (procedimento do README).
    const restoreDir = tmpDataDir('restore-target');
    fs.copyFileSync(path.join(dataDir, 'backups', name), path.join(restoreDir, 'polpeteria.db'));
    const restored = await startServer({ dataDir: restoreDir });
    servers.push(restored);
    const admin2 = await login(restored.base, 'admin');
    const state = (await admin2.get('/api/state')).data;
    assert.ok(state.orders.some((x) => x.id === o.id));
    assert.equal((await admin2.get('/api/admin/audit/verify')).data.ok, true);
  });

  test('relatório do Proprietário gera CSV e JSON coerentes com o histórico', { timeout: 30_000 }, async () => {
    const dataDir = tmpDataDir('export');
    const srv = await startServer({ dataDir });
    servers.push(srv);
    const garcom = await login(srv.base, 'garcom');
    const dono = await login(srv.base, 'dono');
    const o = (await garcom.post('/api/orders', newOrder(4, [[ID.risotto, 2, 'sem queijo; "extra"'], [ID.refri, 1]]))).data.order;
    await garcom.post(`/api/items/${o.items[1].id}/cancel`, { cancellationId: crypto.randomUUID(), qty: 1, reason: 'Cliente desistiu' });

    const admin = await login(srv.base, 'admin');
    const old = await fetch(`${srv.base}/api/admin/export?format=csv`, { headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal(old.status, 404, 'Admin não tem mais "Exportar dia"');
    const csvRes = await fetch(`${srv.base}/api/owner/export?format=csv`, { headers: { Authorization: `Bearer ${dono.token}` } });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-disposition'), /attachment/);
    const csv = await csvRes.text();
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(rows.length, 4, 'cabeçalho + 2 itens + taxa de serviço da conta');
    assert.match(rows[3], /Taxa de serviço \(10%\)/);
    assert.match(rows[0], /^data;pedido_n;mesa/);
    assert.match(csv, /"sem queijo; ""extra"""/, 'campos com ; e aspas escapados');
    const unit = (PRICE.refri / 100).toFixed(2).replace('.', ',');
    assert.ok(rows[2].includes(`;1;1;0;${unit};0,00;`), 'refrigerante: 1 enviado, 1 cancelado, 0 válido');

    const json = await (await fetch(`${srv.base}/api/owner/export?format=json`, { headers: { Authorization: `Bearer ${dono.token}` } })).json();
    const dia = json.dias[0];
    assert.equal(dia.pedidos.length, 1);
    assert.equal(dia.contas[0].conta.totalCents, 2 * PRICE.risotto);
    assert.equal(dia.cancelamentos.length, 1);
    assert.ok(dia.auditoria.some((e) => e.action === 'item.cancel'));
    assert.equal(json.relatorio.kpis.salesCents, 2 * PRICE.risotto);
  });
});

describe('Hospedagem', () => {
  test('na nuvem sem disco persistente o servidor se recusa a iniciar', { timeout: 30_000 }, () => {
    const r = spawnSync(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, RENDER: 'true', DATA_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: '', PORT: '0' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /disco persistente/);
  });
});
