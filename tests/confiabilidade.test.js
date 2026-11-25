// Testes obrigatórios de segurança dos pedidos (nada perdido, duplicado ou alterado sem registro).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { io } from 'socket.io-client';
import { createOutbox, createHttpSender, memoryStorage } from '../client/src/lib/outbox-core.js';
import { splitCents } from '../client/src/lib/util.js';
import { startServer, tmpDataDir, login, device, newOrder, sleep, stripVolatile, PINS, ID, PRICE, SIMPLE_IDS } from './helpers.js';

const T = { timeout: 30_000 };
const servers = [];
after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
});
async function boot(name, opts = {}) {
  const dataDir = opts.dataDir || tmpDataDir(name);
  const srv = await startServer({ ...opts, dataDir });
  servers.push(srv);
  return { srv, dataDir };
}
function countOrders(dataDir, where = '1=1', ...params) {
  const db = new Database(path.join(dataDir, 'polpeteria.db'), { readonly: true });
  const n = db.prepare(`SELECT COUNT(*) FROM orders WHERE ${where}`).pluck().get(...params);
  db.close();
  return n;
}

/** Aparelho do garçom simulado: o MESMO outbox e o MESMO envio HTTP usados no navegador, com rede controlável. */
function waiterDevice(base, token) {
  const net = { mode: 'ok' }; // ok | offline | drop-response
  const fetchImpl = async (url, init) => {
    if (net.mode === 'offline') throw new TypeError('Failed to fetch (sem rede)');
    const res = await fetch(url, init);
    if (net.mode === 'drop-response') {
      await res.text(); // o servidor recebeu e respondeu...
      throw new TypeError('Conexão perdida antes da resposta'); // ...mas a resposta nunca chega ao aparelho
    }
    return res;
  };
  const storage = memoryStorage();
  let timers = [];
  const outbox = createOutbox({
    storage,
    send: createHttpSender({ baseUrl: base, getToken: () => token, fetchImpl }),
    backoff: [50, 100, 200],
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      timers.push(t);
      return t;
    },
    clearTimer: (t) => clearTimeout(t),
  });
  return {
    net,
    outbox,
    storage,
    stopTimers: () => timers.forEach(clearTimeout),
  };
}

describe('1. Queda de internet durante o envio', () => {
  test('sem rede: pedido fica salvo no aparelho como pendente e é enviado sozinho ao reconectar', T, async () => {
    const { srv, dataDir } = await boot('queda-rede');
    const garcom = await login(srv.base, 'garcom');
    const dev = waiterDevice(srv.base, garcom.token);
    await dev.outbox.init();

    dev.net.mode = 'offline';
    const entry = await dev.outbox.enqueue({ ...newOrder(2, [[ID.risotto, 2, 'sem cebola'], [ID.refri, 2]]) });
    await dev.outbox.flush();

    assert.equal(dev.outbox.snapshot().pending, 1, 'indicador: 1 pedido pendente');
    assert.equal(dev.outbox.get(entry.id).status, 'pending');
    assert.equal(dev.storage._map.get(entry.id).status, 'pending', 'gravado no armazenamento do aparelho');
    assert.equal(countOrders(dataDir, 'id = ?', entry.id), 0, 'servidor ainda não recebeu');

    // Várias tentativas automáticas falham enquanto offline (backoff).
    await sleep(400);
    assert.ok(dev.outbox.get(entry.id).attempts >= 2, 'reenvio automático com backoff');
    assert.equal(dev.outbox.get(entry.id).status, 'pending');

    dev.net.mode = 'ok';
    await dev.outbox.retryNow(); // evento "online"/reconexão do socket
    assert.equal(dev.outbox.get(entry.id).status, 'sent');
    assert.equal(dev.outbox.snapshot().pending, 0, 'indicador: Sincronizado');
    assert.equal(countOrders(dataDir, 'id = ?', entry.id), 1);
    dev.stopTimers();
  });

  test('rede cai DEPOIS de o servidor gravar (resposta perdida): reenvio não duplica', T, async () => {
    const { srv, dataDir } = await boot('queda-resposta');
    const garcom = await login(srv.base, 'garcom');
    const admin = await login(srv.base, 'admin');
    const dev = waiterDevice(srv.base, garcom.token);
    await dev.outbox.init();

    dev.net.mode = 'drop-response';
    const entry = await dev.outbox.enqueue(newOrder(3, [[ID.trapanese, 1], [ID.ortolana, 1]]));
    await dev.outbox.flush();
    assert.equal(dev.outbox.get(entry.id).status, 'pending', 'sem confirmação => continua Pendente, nunca "Enviado"');
    assert.equal(countOrders(dataDir, 'id = ?', entry.id), 1, 'o servidor gravou');

    dev.net.mode = 'ok';
    await dev.outbox.retryNow();
    const sent = dev.outbox.get(entry.id);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.duplicate, true, 'servidor reconheceu o reenvio');
    assert.equal(countOrders(dataDir, 'id = ?', entry.id), 1, 'continua 1 pedido');
    assert.equal(countOrders(dataDir), 1);

    const audit = (await admin.get('/api/admin/audit')).data.entries;
    assert.ok(audit.some((e) => e.action === 'order.resend_ignored' && e.entityId === entry.id), 'reenvio registrado na auditoria');
    dev.stopTimers();
  });

  test('vários pedidos offline são enviados em ordem e o servidor fora do ar não perde nada', T, async () => {
    const { srv, dataDir } = await boot('servidor-fora');
    const garcom = await login(srv.base, 'garcom');
    const dev = waiterDevice(srv.base, garcom.token);
    await dev.outbox.init();
    await srv.stop(); // servidor desligado (ex.: computador do restaurante reiniciando)
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push((await dev.outbox.enqueue(newOrder(i, [[ID.espresso, i]]))).id);
    await dev.outbox.flush();
    assert.equal(dev.outbox.snapshot().pending, 5);

    const again = await startServer({ dataDir, port: srv.port });
    servers.push(again);
    await dev.outbox.retryNow();
    assert.equal(dev.outbox.snapshot().pending, 0);
    assert.equal(countOrders(dataDir), 5);
    const state = (await device(again.base, garcom.token).get('/api/state')).data;
    const seqs = ids.map((id) => state.orders.find((o) => o.id === id).seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'ordem preservada');
    dev.stopTimers();
  });

  test('conta fechada enquanto o garçom estava offline: pedido é recusado de forma visível, não some, e pode ir para nova conta', T, async () => {
    const { srv } = await boot('conta-fechada-offline');
    const garcom = await login(srv.base, 'garcom');
    const caixa = await login(srv.base, 'caixa');
    const first = (await garcom.post('/api/orders', newOrder(10, [[ID.agua, 1]]))).data.order;
    const dev = waiterDevice(srv.base, garcom.token);
    await dev.outbox.init();
    dev.net.mode = 'offline';
    const entry = await dev.outbox.enqueue(newOrder(10, [[ID.refri, 1]], { tabId: first.tabId }));
    await dev.outbox.flush();
    // Enquanto isso o caixa fecha a conta.
    const bill = (await caixa.get(`/api/tabs/${first.tabId}/bill`)).data;
    assert.equal((await caixa.post(`/api/tabs/${first.tabId}/close`, { expectedTotalCents: bill.totalCents })).status, 200);
    dev.net.mode = 'ok';
    await dev.outbox.retryNow();
    const rejected = dev.outbox.get(entry.id);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.lastError.code, 'TAB_CLOSED');
    assert.equal(dev.outbox.snapshot().rejected, 1);
    await dev.outbox.resendRejected(entry.id, { asNewTab: true });
    const sent = dev.outbox.get(entry.id);
    assert.equal(sent.status, 'sent');
    assert.notEqual(sent.server.tabId, first.tabId, 'foi para uma conta nova');
    dev.stopTimers();
  });
});

describe('2. Reenvio duplicado do mesmo pedido', () => {
  test('mesmo UUID reenviado em sequência e em paralelo gera um único pedido', T, async () => {
    const { srv, dataDir } = await boot('duplicado');
    const garcom = await login(srv.base, 'garcom');
    const order = newOrder(4, [[ID.risotto, 2, 'sem queijo'], [ID.cheesecake, 1]]);

    const first = await garcom.post('/api/orders', order);
    assert.equal(first.status, 201);
    for (let i = 0; i < 5; i++) {
      const r = await garcom.post('/api/orders', order);
      assert.equal(r.status, 200);
      assert.equal(r.data.duplicate, true);
      assert.equal(r.data.order.seq, first.data.order.seq);
    }
    const parallel = await Promise.all(Array.from({ length: 20 }, () => garcom.post('/api/orders', order)));
    assert.ok(parallel.every((r) => r.status === 200 && r.data.duplicate));

    // Reenvio paralelo de um pedido NOVO: exatamente um 201.
    const other = newOrder(4, [[ID.trapanese, 1]]);
    const race = await Promise.all(Array.from({ length: 20 }, () => garcom.post('/api/orders', other)));
    assert.equal(race.filter((r) => r.status === 201).length, 1);
    assert.equal(race.filter((r) => r.status === 200).length, 19);

    assert.equal(countOrders(dataDir), 2);
    const state = (await garcom.get('/api/state')).data;
    const o = state.orders.find((x) => x.id === order.id);
    assert.equal(o.items.length, 2);
    assert.equal(o.items[0].qty, 2);
    assert.equal(state.tabs.find((t) => t.tableNumber === 4).totalCents, 2 * PRICE.risotto + PRICE.cheesecake + PRICE.trapanese);
  });

  test('mesmo UUID com conteúdo diferente é recusado e o original fica intacto', T, async () => {
    const { srv } = await boot('conflito-id');
    const garcom = await login(srv.base, 'garcom');
    const order = newOrder(5, [[ID.risotto, 1]]);
    await garcom.post('/api/orders', order);
    const tampered = { ...order, items: [{ menuItemId: ID.risotto, qty: 9, notes: '' }] };
    const r = await garcom.post('/api/orders', tampered);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'ID_CONFLICT');
    const o = (await garcom.get('/api/state')).data.orders.find((x) => x.id === order.id);
    assert.equal(o.items[0].qty, 1);
  });

  test('cancelamento reenviado (mesmo id) não cancela em dobro', T, async () => {
    const { srv } = await boot('cancel-dup');
    const garcom = await login(srv.base, 'garcom');
    const order = (await garcom.post('/api/orders', newOrder(6, [[ID.risotto, 3]]))).data.order;
    const body = { cancellationId: crypto.randomUUID(), qty: 1, reason: 'Cliente desistiu' };
    const rs = await Promise.all([1, 2, 3].map(() => garcom.post(`/api/items/${order.items[0].id}/cancel`, body)));
    assert.ok(rs.every((r) => r.status === 200));
    const item = (await garcom.get('/api/state')).data.orders.find((x) => x.id === order.id).items[0];
    assert.equal(item.cancelledQty, 1);
    assert.equal(item.activeQty, 2);
  });
});

describe('3. Reinício do servidor com pedidos abertos', () => {
  test('queda brusca (SIGKILL) e reinício: nenhum dado perdido e aparelhos ressincronizam sozinhos', T, async (t) => {
    const { srv, dataDir } = await boot('reinicio');
    const garcom = await login(srv.base, 'garcom', { name: 'Giulia' });
    const cozinha = await login(srv.base, 'cozinha');
    const admin = await login(srv.base, 'admin');

    // Movimento antes da queda
    const o1 = (await garcom.post('/api/orders', newOrder(1, [[ID.risotto, 2, 'sem pimenta'], [ID.refri, 2]]))).data.order;
    const o2 = (await garcom.post('/api/orders', newOrder(2, [[ID.trapanese, 1], [ID.combo, 1, '', [ID.rotolini, ID.ortolana, ID.cheesecake]]]))).data.order;
    const o3 = (await garcom.post('/api/orders', newOrder(1, [[ID.tiramisu, 2]]))).data.order;
    await cozinha.post(`/api/orders/${o1.id}/status`, { from: 'novo', to: 'preparando' });
    await cozinha.post(`/api/orders/${o2.id}/status`, { from: 'novo', to: 'preparando' });
    await cozinha.post(`/api/orders/${o2.id}/status`, { from: 'preparando', to: 'pronto' });
    await garcom.post(`/api/items/${o3.items[0].id}/cancel`, { cancellationId: crypto.randomUUID(), qty: 1, reason: 'Lançado por engano' });
    await garcom.post(`/api/tabs/${o2.tabId}/request-bill`);
    const before = stripVolatile((await admin.get('/api/state')).data);

    // Aparelho da cozinha conectado em tempo real. Como no app, a cada (re)conexão ele baixa o estado completo.
    const kitchenSocket = io(srv.base, { auth: { token: cozinha.token }, transports: ['websocket'], reconnectionDelay: 100, reconnectionDelayMax: 300 });
    t.after(() => kitchenSocket.close());
    let connects = 0;
    let lastResync = null;
    kitchenSocket.on('connect', async () => {
      connects++;
      try {
        lastResync = (await cozinha.get('/api/state')).data;
      } catch {
        /* como no app: se a rede cair no meio, tenta de novo na próxima conexão */
      }
    });
    await new Promise((r) => kitchenSocket.once('connect', r));

    // Garçom com pedido que vai ficar pendente durante a queda
    const dev = waiterDevice(srv.base, garcom.token);
    t.after(() => dev.stopTimers());
    await dev.outbox.init();

    await srv.crash(); // SIGKILL: sem fechamento limpo, sem checkpoint
    const pending = await dev.outbox.enqueue(newOrder(3, [[ID.cheesecake, 1]]));
    await dev.outbox.flush();
    assert.equal(dev.outbox.snapshot().pending, 1, 'durante a queda o pedido fica pendente no aparelho');

    const again = await startServer({ dataDir, port: srv.port });
    servers.push(again);

    // Mesmo token continua válido: aparelhos não precisam digitar PIN de novo.
    const after = stripVolatile((await device(again.base, admin.token).get('/api/state')).data);
    assert.deepEqual(after.tabs, before.tabs, 'contas idênticas após o reinício');
    assert.deepEqual(
      after.orders.filter((o) => o.id !== pending.id),
      before.orders,
      'pedidos, itens, status e cancelamentos idênticos',
    );
    assert.deepEqual(after.menu, before.menu);

    // O pedido pendente no aparelho é enviado sozinho (backoff) ou na reconexão.
    await dev.outbox.retryNow();
    assert.equal(dev.outbox.get(pending.id).status, 'sent');
    assert.equal(dev.outbox.snapshot().pending, 0, 'indicador volta a "Sincronizado"');

    // A cozinha reconecta sozinha e, ao ressincronizar, enxerga o pedido enviado durante a reconexão.
    const deadline = Date.now() + 8000;
    while ((connects < 2 || !lastResync?.orders.some((o) => o.id === pending.id)) && Date.now() < deadline) {
      await sleep(50);
      if (connects >= 2 && !lastResync?.orders.some((o) => o.id === pending.id)) lastResync = (await cozinha.get('/api/state').catch(() => ({ data: null }))).data;
    }
    assert.ok(connects >= 2, 'cozinha reconectou automaticamente');
    assert.equal(lastResync.orders.find((o) => o.id === pending.id)?.status, 'novo', 'pedido pendente apareceu na cozinha');

    // E o tempo real volta a funcionar: um pedido novo chega ao vivo pelo socket reconectado.
    const live = newOrder(4, [[ID.espresso, 1]]);
    const got = new Promise((resolve) => kitchenSocket.on('order:upsert', ({ data }) => data.id === live.id && resolve(data)));
    await device(again.base, garcom.token).post('/api/orders', live);
    assert.equal((await got).tableNumber, 4);

    // Integridade física do arquivo e da cadeia de auditoria
    const db = new Database(path.join(dataDir, 'polpeteria.db'), { readonly: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.close();
    assert.equal((await device(again.base, admin.token).get('/api/admin/audit/verify')).data.ok, true);
    assert.equal(countOrders(dataDir), 5);
  });

  test('reinício normal (SIGTERM) também preserva tudo', T, async () => {
    const { srv, dataDir } = await boot('reinicio-normal');
    const garcom = await login(srv.base, 'garcom');
    await garcom.post('/api/orders', newOrder(7, [[ID.agua, 4]]));
    const before = stripVolatile((await garcom.get('/api/state')).data);
    await srv.stop();
    const again = await startServer({ dataDir, port: srv.port });
    servers.push(again);
    const after = stripVolatile((await device(again.base, garcom.token).get('/api/state')).data);
    assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(after.tabs, before.tabs);
  });
});

describe('4. Dois garçons na mesma mesa ao mesmo tempo', () => {
  test('pedidos simultâneos em mesa livre caem na MESMA conta, sem sobrescrever nada', T, async () => {
    const { srv, dataDir } = await boot('dois-garcons');
    const ana = await login(srv.base, 'garcom', { name: 'Ana' });
    const bruno = await login(srv.base, 'garcom', { name: 'Bruno' });
    const menu = (await ana.get('/api/state')).data.menu;
    const price = (id) => menu.find((m) => m.id === id).priceCents;

    const ordersA = Array.from({ length: 10 }, (_, i) => newOrder(7, [[SIMPLE_IDS[i % 5], 1 + (i % 3)]]));
    const ordersB = Array.from({ length: 10 }, (_, i) => newOrder(7, [[SIMPLE_IDS[5 + (i % 6)], 1 + (i % 2), i % 2 ? 'sem cebola' : '']]));
    const results = await Promise.all([
      ...ordersA.map((o) => ana.post('/api/orders', o)),
      ...ordersB.map((o) => bruno.post('/api/orders', o)),
    ]);
    assert.ok(results.every((r) => r.status === 201), 'todos aceitos');

    const state = (await ana.get('/api/state')).data;
    const tabs = state.tabs.filter((t) => t.tableNumber === 7 && t.status !== 'closed');
    assert.equal(tabs.length, 1, 'uma única conta aberta para a mesa 7');
    const mine = state.orders.filter((o) => o.tableNumber === 7);
    assert.equal(mine.length, 20);
    assert.ok(mine.every((o) => o.tabId === tabs[0].id));

    // Cada pedido está exatamente como foi enviado, com o autor correto.
    for (const sent of [...ordersA, ...ordersB]) {
      const got = mine.find((o) => o.id === sent.id);
      assert.deepEqual(got.items.map((i) => [i.menuItemId, i.qty, i.notes]), sent.items.map((i) => [i.menuItemId, i.qty, i.notes]));
    }
    assert.equal(mine.filter((o) => o.createdBy.name === 'Ana').length, 10);
    assert.equal(mine.filter((o) => o.createdBy.name === 'Bruno').length, 10);

    const expected = [...ordersA, ...ordersB].flatMap((o) => o.items).reduce((s, i) => s + i.qty * price(i.menuItemId), 0);
    assert.equal(tabs[0].totalCents, expected, 'total = soma de tudo que os dois lançaram');
    assert.equal(new Set(mine.map((o) => o.seq)).size, 20, 'numeração sem colisão');
    assert.equal(countOrders(dataDir), 20);
  });

  test('um garçom com a conta conhecida e outro com a mesa "livre" (desatualizada) apenas somam itens', T, async () => {
    const { srv } = await boot('dois-garcons-2');
    const ana = await login(srv.base, 'garcom', { name: 'Ana' });
    const bruno = await login(srv.base, 'garcom', { name: 'Bruno' });
    const first = (await ana.post('/api/orders', newOrder(8, [[ID.risotto, 1]]))).data.order;
    const [a, b] = await Promise.all([
      ana.post('/api/orders', newOrder(8, [[ID.trapanese, 1]], { tabId: first.tabId })),
      bruno.post('/api/orders', newOrder(8, [[ID.ortolana, 2]])), // Bruno ainda via a mesa como livre
    ]);
    assert.equal(a.data.order.tabId, first.tabId);
    assert.equal(b.data.order.tabId, first.tabId);
    const tab = (await ana.get('/api/state')).data.tabs.find((t) => t.id === first.tabId);
    assert.equal(tab.totalCents, PRICE.risotto + PRICE.trapanese + 2 * PRICE.ortolana);
  });
});

describe('5. Conferência: total do caixa = itens enviados − cancelados', () => {
  test('total confere em centavos, com troca de preço, cancelamentos parciais/totais, fechamento e reabertura', T, async () => {
    const { srv } = await boot('conferencia');
    const garcom = await login(srv.base, 'garcom');
    const caixa = await login(srv.base, 'caixa');
    const admin = await login(srv.base, 'admin');
    const priceNow = async (id) => (await garcom.get('/api/state')).data.menu.find((m) => m.id === id).priceCents;

    // Registro independente do que foi enviado (livro-razão do teste)
    const ledger = []; // { itemId, qty, unit }
    let rng = 42;
    const rand = (n) => (rng = (rng * 1103515245 + 12345) % 2 ** 31) % n;

    let tabId = null;
    const send = async (items) => {
      const r = await garcom.post('/api/orders', newOrder(12, items, { tabId }));
      assert.equal(r.status, 201);
      tabId = r.data.order.tabId;
      for (const [menuItemId, qty] of items) {
        const it = r.data.order.items.find((i) => i.menuItemId === menuItemId && i.qty === qty && !ledger.some((l) => l.itemId === i.id));
        ledger.push({ itemId: it.id, qty, unit: await priceNow(menuItemId) });
      }
      return r.data.order;
    };

    for (let i = 0; i < 8; i++) {
      const lines = [];
      const used = new Set();
      for (let j = 0; j < 1 + rand(4); j++) {
        const id = SIMPLE_IDS[rand(SIMPLE_IDS.length)];
        if (used.has(id)) continue;
        used.add(id);
        lines.push([id, 1 + rand(4)]);
      }
      await send(lines);
    }
    // Troca de preço no meio do serviço: só afeta o que for lançado depois.
    const oldPrice = await priceNow(ID.ortolana);
    await admin.put(`/api/admin/menu/${ID.ortolana}`, { priceCents: oldPrice + 1234 });
    await send([[ID.ortolana, 2]]);
    await admin.put(`/api/admin/menu/${ID.ortolana}`, { priceCents: oldPrice });
    // Menu Completo: cobra o preço do menu (não a soma das escolhas).
    await send([[ID.combo, 2, '', [ID.rotolini, ID.trapanese, ID.cheesecake]]]);

    // Cancelamentos: parcial, total de uma linha e de um pedido inteiro.
    const cancels = [];
    const cancel = async (itemId, qty, who = garcom) => {
      const r = await who.post(`/api/items/${itemId}/cancel`, { cancellationId: crypto.randomUUID(), qty, reason: 'Conferência' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const unit = ledger.find((l) => l.itemId === itemId).unit;
      cancels.push({ itemId, qty, unit });
    };
    const multi = ledger.find((l) => l.qty >= 2);
    await cancel(multi.itemId, 1);
    const single = ledger.find((l) => l !== multi);
    await cancel(single.itemId, single.qty, caixa);
    const wholeOrder = await send([[ID.chianti, 2], [ID.espresso, 3]]);
    for (const it of wholeOrder.items) await cancel(it.id, it.qty);

    const sentTotal = ledger.reduce((s, l) => s + l.qty * l.unit, 0);
    const cancelledTotal = cancels.reduce((s, c) => s + c.qty * c.unit, 0);
    const expected = sentTotal - cancelledTotal;

    const bill = (await caixa.get(`/api/tabs/${tabId}/bill`)).data;
    console.log(`    enviados ${sentTotal / 100} − cancelados ${cancelledTotal / 100} = ${expected / 100} | caixa: ${bill.totalCents / 100}`);
    assert.equal(bill.totalCents, expected, 'TOTAL DO CAIXA = enviados − cancelados');
    assert.equal(bill.lines.reduce((s, l) => s + l.subtotalCents, 0), bill.totalCents, 'soma das linhas = total');
    assert.equal(bill.cancelledTotalCents, cancelledTotal, 'cancelados listados à parte');
    for (const l of ledger) {
      const active = bill.lines.find((x) => x.itemId === l.itemId)?.qty ?? 0;
      const cancelled = bill.cancelled.filter((c) => c.itemId === l.itemId).reduce((s, c) => s + c.qty, 0);
      assert.equal(active + cancelled, l.qty, 'cada unidade enviada está na conta ou nos cancelados');
    }
    const parts = splitCents(bill.totalCents, 3);
    assert.equal(parts.reduce((a, b) => a + b, 0), bill.totalCents, 'divisão da conta soma exatamente o total');

    // Fechamento exige o total conferido; conta fechada trava a mesa.
    const wrong = await caixa.post(`/api/tabs/${tabId}/close`, { expectedTotalCents: expected + 1 });
    assert.equal(wrong.data.error, 'TOTAL_CHANGED');
    assert.equal((await garcom.post(`/api/tabs/${tabId}/close`, { expectedTotalCents: expected })).status, 403, 'garçom não fecha conta');
    const closed = await caixa.post(`/api/tabs/${tabId}/close`, { expectedTotalCents: expected });
    assert.equal(closed.status, 200);
    assert.equal(closed.data.tab.closedTotalCents, expected);
    assert.equal((await garcom.post('/api/orders', newOrder(12, [[ID.agua, 1]], { tabId }))).data.error, 'TAB_CLOSED');
    assert.equal((await garcom.post(`/api/items/${multi.itemId}/cancel`, { cancellationId: crypto.randomUUID(), qty: 1, reason: 'depois de fechar' })).data.error, 'TAB_CLOSED');

    // Reabrir exige PIN de Admin e fica registrado (inclusive a tentativa negada).
    const denied = await caixa.post(`/api/tabs/${tabId}/reopen`, { adminPin: PINS.garcom, reason: 'Correção' });
    assert.equal(denied.status, 403);
    const reopened = await caixa.post(`/api/tabs/${tabId}/reopen`, { adminPin: PINS.admin, reason: 'Correção de lançamento' });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.tab.status, 'open');
    assert.equal(reopened.data.tab.totalCents, expected, 'reabrir não altera valores');

    const actions = (await admin.get('/api/admin/audit')).data.entries.filter((e) => e.entityId === tabId).map((e) => e.action);
    for (const a of ['tab.open', 'tab.close', 'tab.reopen_denied', 'tab.reopen']) assert.ok(actions.includes(a), `auditoria contém ${a}`);
    const dono = await login(srv.base, 'dono');
    const hist = (await dono.get('/api/owner/history')).data;
    assert.equal(hist.summary.cancelledCents, cancelledTotal);
  });
});
