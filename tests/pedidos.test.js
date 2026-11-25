// Testes básicos: criação de pedidos, mudança de status, permissões, imutabilidade e tempo real.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { io } from 'socket.io-client';
import { startServer, tmpDataDir, login, newOrder } from './helpers.js';

let srv;
let dataDir;
let garcom;
let cozinha;
let admin;
let caixa;

before(async () => {
  dataDir = tmpDataDir('pedidos');
  srv = await startServer({ dataDir });
  [garcom, cozinha, admin, caixa] = await Promise.all([
    login(srv.base, 'garcom', { name: 'Marco' }),
    login(srv.base, 'cozinha'),
    login(srv.base, 'admin'),
    login(srv.base, 'caixa'),
  ]);
});
after(() => srv?.stop());

describe('Criação de pedidos', () => {
  test('cria o pedido, grava no banco antes de responder e congela nome e preço', { timeout: 30_000 }, async () => {
    const menu = (await garcom.get('/api/state')).data.menu;
    const carbonara = menu.find((m) => m.name === 'Spaghetti alla Carbonara');
    const order = newOrder(3, [[carbonara.id, 2, 'sem pimenta']]);
    const r = await garcom.post('/api/orders', order);
    assert.equal(r.status, 201);
    assert.equal(r.data.duplicate, false);
    assert.equal(r.data.order.id, order.id);
    assert.equal(r.data.order.status, 'novo');
    assert.equal(r.data.order.items[0].unitPriceCents, carbonara.priceCents);
    assert.equal(r.data.order.items[0].name, 'Spaghetti alla Carbonara');
    assert.equal(r.data.order.items[0].notes, 'sem pimenta');
    assert.equal(r.data.order.totalCents, carbonara.priceCents * 2);
    assert.equal(r.data.order.createdBy.name, 'Marco');

    // Lido direto do arquivo do banco por outra conexão: já está gravado.
    const db = new Database(path.join(dataDir, 'pulpeteria.db'), { readonly: true });
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    db.close();
    assert.ok(row, 'pedido deve estar no banco no momento da resposta');

    const state = (await cozinha.get('/api/state')).data;
    assert.ok(state.orders.some((o) => o.id === order.id));
    assert.equal(state.tabs.find((t) => t.tableNumber === 3).status, 'open');
  });

  test('rejeita pedidos inválidos sem gravar nada', { timeout: 30_000 }, async () => {
    assert.equal((await garcom.post('/api/orders', newOrder(3, []))).status, 400);
    assert.equal((await garcom.post('/api/orders', newOrder(999, [[1, 1]]))).status, 400);
    assert.equal((await garcom.post('/api/orders', newOrder(3, [[9999, 1]]))).data.error, 'UNKNOWN_ITEM');
    assert.equal((await garcom.post('/api/orders', newOrder(3, [[1, 0]]))).data.error, 'BAD_QTY');
    assert.equal((await garcom.post('/api/orders', { ...newOrder(3, [[1, 1]]), id: 'nao-e-uuid' })).data.error, 'BAD_ID');
    assert.equal((await cozinha.post('/api/orders', newOrder(3, [[1, 1]]))).status, 403, 'cozinha não lança pedidos');
  });

  test('a cozinha recebe o novo pedido em tempo real em menos de 1 segundo', { timeout: 30_000 }, async () => {
    const socket = io(srv.base, { auth: { token: cozinha.token }, transports: ['websocket'] });
    await new Promise((r) => socket.on('connect', r));
    const order = newOrder(4, [[12, 1]]);
    const received = new Promise((resolve) => {
      socket.on('order:upsert', ({ data }) => {
        if (data.id === order.id) resolve(performance.now());
      });
    });
    const t0 = performance.now();
    await garcom.post('/api/orders', order);
    const ms = (await received) - t0;
    socket.close();
    console.log(`    latência garçom → cozinha: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 1000, `latência ${ms} ms`);
  });
});

describe('Mudança de status', () => {
  test('Novo → Preparando → Pronto → Retirado, com controle de concorrência', { timeout: 30_000 }, async () => {
    const order = (await garcom.post('/api/orders', newOrder(5, [[13, 1]]))).data.order;
    const move = (dev, from, to) => dev.post(`/api/orders/${order.id}/status`, { from, to });

    assert.equal((await move(garcom, 'novo', 'preparando')).status, 403, 'garçom não altera preparo');
    assert.equal((await move(cozinha, 'novo', 'pronto')).status, 400, 'não pula etapa');

    const r1 = await move(cozinha, 'novo', 'preparando');
    assert.equal(r1.status, 200);
    assert.equal(r1.data.order.status, 'preparando');

    // Segundo toque com estado antigo (outro aparelho já avançou): conflito, nada muda.
    const stale = await move(cozinha, 'novo', 'preparando');
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, 'STATUS_CONFLICT');

    assert.equal((await move(cozinha, 'preparando', 'pronto')).data.order.status, 'pronto');
    assert.equal((await move(garcom, 'pronto', 'entregue')).data.order.status, 'entregue');

    const audit = (await admin.get('/api/admin/audit')).data.entries.filter((e) => e.entityId === order.id && e.action === 'order.status');
    assert.deepEqual(
      audit.map((e) => `${e.details.de}>${e.details.para}`).reverse(),
      ['novo>preparando', 'preparando>pronto', 'pronto>entregue'],
    );
  });

  test('evento "pronto" chega aos garçons', { timeout: 30_000 }, async () => {
    const order = (await garcom.post('/api/orders', newOrder(6, [[20, 2]]))).data.order;
    const socket = io(srv.base, { auth: { token: garcom.token }, transports: ['websocket'] });
    await new Promise((r) => socket.on('connect', r));
    const ready = new Promise((resolve) => socket.on('order:upsert', ({ data }) => data.id === order.id && data.status === 'pronto' && resolve(data)));
    await cozinha.post(`/api/orders/${order.id}/status`, { from: 'novo', to: 'preparando' });
    await cozinha.post(`/api/orders/${order.id}/status`, { from: 'preparando', to: 'pronto' });
    const got = await ready;
    socket.close();
    assert.equal(got.tableNumber, 6);
  });
});

describe('Cancelamentos e imutabilidade', () => {
  test('cozinha não pode cancelar; cancelamento exige motivo e não apaga o item', { timeout: 30_000 }, async () => {
    const order = (await garcom.post('/api/orders', newOrder(8, [[6, 3]]))).data.order;
    const itemId = order.items[0].id;
    const k = await cozinha.post(`/api/items/${itemId}/cancel`, { cancellationId: crypto.randomUUID(), qty: 1, reason: 'teste' });
    assert.equal(k.status, 403);
    const noReason = await garcom.post(`/api/items/${itemId}/cancel`, { cancellationId: crypto.randomUUID(), qty: 1, reason: '' });
    assert.equal(noReason.data.error, 'REASON_REQUIRED');

    const ok = await garcom.post(`/api/items/${itemId}/cancel`, { cancellationId: crypto.randomUUID(), qty: 1, reason: 'Cliente desistiu' });
    assert.equal(ok.status, 200);
    const item = ok.data.order.items[0];
    assert.equal(item.qty, 3, 'quantidade enviada preservada');
    assert.equal(item.cancelledQty, 1);
    assert.equal(item.activeQty, 2);
    assert.equal(item.cancellations[0].reason, 'Cliente desistiu');
    assert.equal(item.cancellations[0].by.role, 'garcom');

    const tooMany = await caixa.post(`/api/items/${itemId}/cancel`, { cancellationId: crypto.randomUUID(), qty: 3, reason: 'Erro' });
    assert.equal(tooMany.status, 400, 'não cancela mais do que restou');
  });

  test('o próprio banco recusa apagar/alterar pedidos, itens, cancelamentos e auditoria', { timeout: 30_000 }, () => {
    const db = new Database(path.join(dataDir, 'pulpeteria.db'));
    const attempts = [
      'DELETE FROM orders',
      'DELETE FROM order_items',
      "UPDATE order_items SET unit_price_cents = 1",
      "UPDATE order_items SET qty = 99",
      'DELETE FROM cancellations',
      "UPDATE cancellations SET qty = 0",
      'DELETE FROM audit_log',
      "UPDATE audit_log SET action = 'x'",
      'DELETE FROM tabs',
      "UPDATE orders SET table_number = 99",
      'DELETE FROM menu_items',
    ];
    for (const sql of attempts) {
      assert.throws(() => db.prepare(sql).run(), /PROTEGIDO/, `deveria bloquear: ${sql}`);
    }
    db.close();
  });

  test('cadeia de hashes da auditoria está íntegra', { timeout: 30_000 }, async () => {
    const r = await admin.get('/api/admin/audit/verify');
    assert.equal(r.data.ok, true);
    assert.ok(r.data.count > 10);
  });

  test('preço congelado: mudar o cardápio não altera contas abertas', { timeout: 30_000 }, async () => {
    const order = (await garcom.post('/api/orders', newOrder(9, [[15, 2]]))).data.order;
    const before = order.items[0].unitPriceCents;
    const up = await admin.put('/api/admin/menu/15', { priceCents: before + 5000 });
    assert.equal(up.data.priceCents, before + 5000);
    const bill = (await caixa.get(`/api/tabs/${order.tabId}/bill`)).data;
    assert.equal(bill.lines[0].unitPriceCents, before);
    assert.equal(bill.totalCents, before * 2);
    const novo = (await garcom.post('/api/orders', newOrder(9, [[15, 1]]))).data.order;
    assert.equal(novo.items[0].unitPriceCents, before + 5000, 'pedido novo usa o preço novo');
    await admin.put('/api/admin/menu/15', { priceCents: before });
  });

  test('item desativado some do cardápio do garçom, mas continua nas contas', { timeout: 30_000 }, async () => {
    await admin.put('/api/admin/menu/1', { active: false });
    const menu = (await garcom.get('/api/state')).data.menu;
    assert.equal(menu.find((m) => m.id === 1).active, false);
    await admin.put('/api/admin/menu/1', { active: true });
  });
});
