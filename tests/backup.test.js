// Backup, exportação e proteção contra disco temporário na nuvem.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { startServer, tmpDataDir, login, newOrder, ROOT } from './helpers.js';

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
    await garcom.post('/api/orders', newOrder(1, [[6, 2]]));
    await garcom.post('/api/orders', newOrder(2, [[12, 1]]));

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
    const o = (await garcom.post('/api/orders', newOrder(3, [[20, 2]]))).data.order;
    const { name } = (await admin.post('/api/admin/backups')).data;
    await srv.stop();

    // Simula perda do banco principal e restauração do backup (procedimento do README).
    const restoreDir = tmpDataDir('restore-target');
    fs.copyFileSync(path.join(dataDir, 'backups', name), path.join(restoreDir, 'pulpeteria.db'));
    const restored = await startServer({ dataDir: restoreDir });
    servers.push(restored);
    const admin2 = await login(restored.base, 'admin');
    const state = (await admin2.get('/api/state')).data;
    assert.ok(state.orders.some((x) => x.id === o.id));
    assert.equal((await admin2.get('/api/admin/audit/verify')).data.ok, true);
  });

  test('"Exportar dia" gera CSV e JSON coerentes com o histórico', { timeout: 30_000 }, async () => {
    const dataDir = tmpDataDir('export');
    const srv = await startServer({ dataDir });
    servers.push(srv);
    const garcom = await login(srv.base, 'garcom');
    const admin = await login(srv.base, 'admin');
    const o = (await garcom.post('/api/orders', newOrder(4, [[6, 2, 'sem queijo; "extra"'], [24, 1]]))).data.order;
    await garcom.post(`/api/items/${o.items[1].id}/cancel`, { cancellationId: crypto.randomUUID(), qty: 1, reason: 'Cliente desistiu' });

    const csvRes = await fetch(`${srv.base}/api/admin/export?format=csv`, { headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-disposition'), /attachment/);
    const csv = await csvRes.text();
    const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(rows.length, 3, 'cabeçalho + 2 itens');
    assert.match(rows[0], /^data;pedido_n;mesa/);
    assert.match(csv, /"sem queijo; ""extra"""/, 'campos com ; e aspas escapados');
    assert.match(rows[2], /;1;1;0;10,00;0,00;/, 'refrigerante: 1 enviado, 1 cancelado, 0 válido');

    const json = await (await fetch(`${srv.base}/api/admin/export?format=json`, { headers: { Authorization: `Bearer ${admin.token}` } })).json();
    assert.equal(json.pedidos.length, 1);
    assert.equal(json.contas[0].conta.totalCents, 2 * 6200);
    assert.equal(json.cancelamentos.length, 1);
    assert.ok(json.auditoria.some((e) => e.action === 'item.cancel'));
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
