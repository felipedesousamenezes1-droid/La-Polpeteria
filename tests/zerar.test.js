// "Começar a operação do zero": apagar os dados de teste uma única vez, com backup e sem afetar o cardápio.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { io } from 'socket.io-client';
import { startServer, tmpDataDir, login, newOrder, ID, PINS, ticketPath, device } from './helpers.js';

const T = { timeout: 30_000 };
const servers = [];
after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
});

describe('Zerar dados de teste (Proprietário, uma única vez)', () => {
  test('apaga pedidos, contas e auditoria com backup antes; mantém cardápio, PINs e aparelhos; trava depois', T, async (t) => {
    const dataDir = tmpDataDir('zerar');
    const srv = await startServer({ dataDir });
    servers.push(srv);
    const [garcom, cozinha, caixa, admin, dono] = await Promise.all(['garcom', 'cozinha', 'caixa', 'admin', 'dono'].map((r) => login(srv.base, r)));

    // Movimento de teste: conta fechada, conta aberta, cancelamento, tempos da cozinha, item arquivado.
    const o1 = (await garcom.post('/api/orders', newOrder(1, [[ID.risotto, 1], [ID.refri, 1]]))).data.order;
    await cozinha.post(ticketPath(o1.id), { from: 'novo', to: 'preparando' });
    const b1 = (await caixa.get(`/api/tabs/${o1.tabId}/bill`)).data;
    await caixa.post(`/api/tabs/${o1.tabId}/close`, { expectedTotalCents: b1.grandTotalCents });
    const o2 = (await garcom.post('/api/orders', newOrder(2, [[ID.combo, 1, '', [ID.rotolini, ID.trapanese, ID.tiramisu]], [ID.agua, 2]]))).data.order;
    await garcom.post(`/api/items/${o2.items[1].id}/cancel`, { cancellationId: randomUUID(), qty: 1, reason: 'Teste' });
    await garcom.post('/api/orders', newOrder(3, [[ID.limonata, 1]]));
    const del = await fetch(`${srv.base}/api/admin/menu/${ID.limonata}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal((await del.json()).result, 'archived', 'item usado em teste fica arquivado');
    const menuBefore = (await garcom.get('/api/state')).data.menu;
    const exportsDir = path.join(dataDir, 'exports');
    fs.writeFileSync(path.join(exportsDir, '2026-11-20.csv'), 'teste');

    const socket = io(srv.base, { auth: { token: garcom.token }, transports: ['websocket'] });
    t.after(() => socket.close());
    await new Promise((r) => socket.on('connect', r));
    const resetEvent = new Promise((r) => socket.on('system:reset', ({ data }) => r(data)));

    // Proteções
    for (const who of [garcom, caixa, admin]) assert.equal((await who.post('/api/owner/reset', { pin: PINS[who.role], confirm: 'ZERAR' })).status, 403);
    assert.equal((await dono.post('/api/owner/reset', { pin: PINS.dono, confirm: 'sim' })).data.error, 'CONFIRM_REQUIRED');
    assert.equal((await dono.post('/api/owner/reset', { pin: '9999', confirm: 'ZERAR' })).data.error, 'OWNER_PIN_REQUIRED');

    const r = await dono.post('/api/owner/reset', { pin: PINS.dono, confirm: 'zerar' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.removed.orders >= 2 && r.data.removed.tabs >= 2 && r.data.removed.audit_log > 5);
    assert.equal((await resetEvent).resetId, r.data.resetId, 'aparelhos avisados em tempo real');

    // Backup antes de apagar contém os dados de teste.
    const backupFile = path.join(dataDir, 'backups', r.data.backup);
    const bk = new Database(backupFile, { readonly: true });
    assert.ok(bk.prepare('SELECT COUNT(*) FROM orders').pluck().get() >= 2, 'backup guarda tudo o que foi apagado');
    bk.close();

    // Estado depois: vazio de movimento, cardápio e configurações intactos, mesmos tokens funcionando.
    const st = (await garcom.get('/api/state')).data;
    assert.equal(st.orders.length, 0);
    assert.equal(st.tabs.length, 0);
    assert.deepEqual(st.menu.map((m) => [m.id, m.name, m.priceCents]), menuBefore.map((m) => [m.id, m.name, m.priceCents]));
    assert.ok(st.settings.operationStartedAt);
    const audit = (await dono.get('/api/admin/audit')).data.entries;
    assert.deepEqual(audit.map((e) => e.action), ['system.reset'], 'auditoria recomeça com o registro da limpeza');
    assert.equal(audit[0].id, 1);
    assert.equal((await dono.get('/api/admin/audit/verify')).data.ok, true);
    assert.equal(fs.readdirSync(exportsDir).length, 0, 'relatórios de teste removidos');
    const db = new Database(path.join(dataDir, 'polpeteria.db'), { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) FROM menu_items WHERE archived = 1').pluck().get(), 0, 'item arquivado (de teste) removido');
    db.close();

    // Operação real: numeração recomeça, gatilhos de proteção voltaram, PINs valem.
    const real = (await garcom.post('/api/orders', newOrder(4, [[ID.rotolini, 1]]))).data.order;
    assert.equal(real.seq, 1, 'primeiro pedido real é o #1');
    const db2 = new Database(path.join(dataDir, 'polpeteria.db'));
    for (const sql of ['DELETE FROM orders', 'DELETE FROM audit_log', 'DELETE FROM tabs', 'UPDATE order_items SET qty = 9', 'DELETE FROM kitchen_tickets']) {
      assert.throws(() => db2.prepare(sql).run(), /PROTEGIDO/, `proteção restaurada: ${sql}`);
    }
    db2.close();
    assert.equal((await login(srv.base, 'cozinha')).role, 'cozinha');

    // Uso único: os dados reais não podem mais ser apagados.
    const again = await dono.post('/api/owner/reset', { pin: PINS.dono, confirm: 'ZERAR' });
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'ALREADY_RESET');
    assert.equal((await device(srv.base, garcom.token, 'garcom').get('/api/state')).data.orders.length, 1, 'pedido real intacto');
  });
});
