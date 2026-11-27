// Cardápio oficial, migração de banco já em uso, perfil Proprietário e relatórios.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase } from '../server/db.js';
import { createAudit } from '../server/audit.js';
import { hashPin } from '../server/auth.js';
import { CATALOG } from '../server/catalog.js';
import { startServer, tmpDataDir, login, newOrder, ID, PRICE, PINS, ticketPath } from './helpers.js';

const T = { timeout: 30_000 };
const servers = [];
after(async () => {
  for (const s of servers) await s.stop().catch(() => {});
});
async function boot(name, dataDir = tmpDataDir(name)) {
  const srv = await startServer({ dataDir });
  servers.push(srv);
  return { srv, dataDir };
}

/** Cria um banco "antigo" (versão 1, cardápio de exemplo, com um pedido já lançado), como o que está no ar. */
function buildOldDatabase(dataDir) {
  const db = openDatabase(path.join(dataDir, 'polpeteria.db'), { targetVersion: 1 });
  const audit = createAudit(db);
  const now = new Date().toISOString();
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({ table_count: '20', warn_minutes: '10', late_minutes: '20', seeded: now })) set.run(k, v);
  for (const role of ['garcom', 'cozinha', 'admin', 'caixa']) set.run(`pin_${role}`, hashPin(PINS[role]));
  const ins = db.prepare(
    'INSERT INTO menu_items (name, description, category, price_cents, active, in_combo, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const old = [
    ['Menu Completo', 'Menu Completo', 13000, 1, 0],
    ['Rotolini di Zucchine', 'Antipasti', 3600, 1, 1],
    ['Refrigerante lata', 'Bebidas', 1000, 1, 0],
    ['Pizza Margherita', 'Pizzas', 5600, 0, 0],
    ['Tiramisu', 'Sobremesas', 2900, 1, 1],
  ];
  old.forEach(([n, c, p, a, k], i) => ins.run(n, '', c, p, a, k, i * 10, now, now));
  const tabId = randomUUID();
  db.prepare("INSERT INTO tabs (id, table_number, status, business_date, opened_at) VALUES (?, 3, 'open', ?, ?)").run(tabId, '2026-11-22', now);
  const orderId = randomUUID();
  db.prepare(`INSERT INTO orders (id, tab_id, table_number, seq, business_date, status, created_by_role, received_at, status_changed_at, payload_hash)
    VALUES (?, ?, 3, 1, '2026-11-22', 'entregue', 'garcom', ?, ?, 'x')`).run(orderId, tabId, now, now);
  const item = db.prepare(`INSERT INTO order_items (id, order_id, line_no, menu_item_id, name, category, unit_price_cents, qty, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`);
  item.run(randomUUID(), orderId, 1, 3, 'Refrigerante lata', 'Bebidas', 1000, 2, now);
  item.run(randomUUID(), orderId, 2, 2, 'Rotolini di Zucchine', 'Antipasti', 3600, 1, now);
  audit.log(null, 'system.seed', 'database', null, {});
  db.close();
  return { orderId, tabId };
}

describe('Cardápio oficial e atualização do banco que já está no ar', () => {
  test('banco novo nasce exatamente com o cardápio da casa, nas seções do cardápio', T, async () => {
    const { srv } = await boot('catalogo-novo');
    const garcom = await login(srv.base, 'garcom');
    const menu = (await garcom.get('/api/state')).data.menu;
    assert.deepEqual(
      menu.map((m) => [m.category, m.name, m.priceCents]),
      CATALOG.map((c) => [c.category, c.name, c.price]),
    );
    assert.equal(menu.find((m) => m.name === 'Menu Completo').priceCents, 13000);
    assert.equal(menu.find((m) => m.name === 'Solare Spritz').priceCents, 3900);
    assert.equal(menu.find((m) => m.name === 'Esperanto Primitivo di Puglia').priceCents, 10500);
    assert.ok(!menu.some((m) => /Pizza|Carbonara|Lasagna|Prosecco/.test(m.name)), 'nada do cardápio de exemplo');
  });

  test('banco antigo: exemplos excluídos, item já pedido arquivado, cardápio oficial aplicado e pedidos antigos intactos', T, async () => {
    const dataDir = tmpDataDir('migracao');
    const { orderId } = buildOldDatabase(dataDir);
    const { srv } = await boot('migracao', dataDir);

    const dono = await login(srv.base, 'dono'); // perfil criado pela atualização (PIN 5555)
    const state = (await dono.get('/api/state')).data;
    assert.deepEqual(state.menu.map((m) => m.name), CATALOG.map((c) => c.name), 'somente o cardápio oficial aparece');
    const rotolini = state.menu.find((m) => m.name === 'Rotolini di Zucchine');
    assert.equal(rotolini.id, 2, 'item que já existia mantém o mesmo id');
    assert.equal(rotolini.category, 'Entrada');

    const db = new Database(path.join(dataDir, 'polpeteria.db'), { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) FROM menu_items WHERE name = 'Pizza Margherita'").pluck().get(), 0, 'exemplo nunca pedido foi excluído');
    const refri = db.prepare("SELECT * FROM menu_items WHERE name = 'Refrigerante lata'").get();
    assert.equal(refri.archived, 1, 'item já pedido fica arquivado');
    assert.equal(refri.active, 0);
    db.close();

    const old = state.orders.find((o) => o.id === orderId);
    assert.ok(old, 'pedido antigo continua no sistema');
    assert.equal(old.totalCents, 2 * 1000 + 3600, 'valores antigos preservados');
    assert.equal(old.tickets.length, 1, 'pedido antigo vira um tempo único na cozinha');
    assert.equal(old.tickets[0].status, 'entregue', 'com o mesmo andamento');
    assert.deepEqual(old.tickets[0].lines.map((l) => l.name), ['Rotolini di Zucchine'], 'bebida antiga fora da cozinha');
    assert.ok(state.categories.some((c) => c.name === 'Outros'), 'seções criadas');
    assert.ok(!state.categories.some((c) => ['Pizzas', 'Antipasti', 'Bebidas'].includes(c.name)), 'sem seções antigas vazias');
    assert.equal((await dono.get('/api/admin/audit/verify')).data.ok, true);

    // Reiniciar não repete a sincronização (idempotente).
    await srv.stop();
    const again = await startServer({ dataDir, port: srv.port });
    servers.push(again);
    const admin = await login(again.base, 'admin');
    const syncs = (await admin.get('/api/admin/audit?limit=5000')).data.entries.filter((e) => e.action === 'menu.catalog_sync');
    assert.equal(syncs.length, 1);
  });

  test('Admin exclui item: apaga se nunca foi pedido, arquiva se já foi', T, async () => {
    const { srv, dataDir } = await boot('excluir-item');
    const admin = await login(srv.base, 'admin');
    const garcom = await login(srv.base, 'garcom');
    await garcom.post('/api/orders', newOrder(1, [[ID.refri, 1]]));
    const del = async (id) => {
      const r = await fetch(`${srv.base}/api/admin/menu/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
      return r.json();
    };
    assert.equal((await del(ID.agua)).result, 'deleted');
    assert.equal((await del(ID.refri)).result, 'archived');
    const menu = (await garcom.get('/api/state')).data.menu;
    assert.ok(!menu.some((m) => m.id === ID.agua || m.id === ID.refri));
    const db = new Database(path.join(dataDir, 'polpeteria.db'), { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) FROM menu_items WHERE id = ?').pluck().get(ID.agua), 0);
    assert.equal(db.prepare('SELECT archived FROM menu_items WHERE id = ?').pluck().get(ID.refri), 1);
    db.close();
  });
});

describe('Perfil Proprietário e relatórios', () => {
  test('somente o Proprietário acessa relatórios; o Admin não exporta nem troca o PIN do Proprietário', T, async () => {
    const { srv } = await boot('permissoes');
    const [dono, admin, garcom] = await Promise.all([login(srv.base, 'dono'), login(srv.base, 'admin'), login(srv.base, 'garcom')]);
    assert.equal(dono.role, 'dono');
    assert.equal((await dono.get('/api/owner/report')).status, 200);
    assert.equal((await admin.get('/api/owner/report')).status, 403);
    assert.equal((await garcom.get('/api/owner/report')).status, 403);
    assert.equal((await admin.get('/api/admin/history')).status, 404, 'histórico saiu do Admin');
    assert.equal((await admin.put('/api/admin/pins/dono', { pin: '9876' })).status, 403);
    assert.equal((await dono.put('/api/admin/pins/dono', { pin: '9876' })).status, 200);
    assert.equal((await dono.get('/api/admin/menu')).status, 200, 'Proprietário também administra');
  });

  test('números do relatório conferem com o que foi vendido', T, async () => {
    const { srv } = await boot('relatorio');
    const [dono, garcom, cozinha, caixa] = await Promise.all([
      login(srv.base, 'dono'),
      login(srv.base, 'garcom', { name: 'Ana' }),
      login(srv.base, 'cozinha'),
      login(srv.base, 'caixa'),
    ]);
    const o1 = (await garcom.post('/api/orders', newOrder(4, [[ID.refri, 2], [ID.combo, 2, '', [ID.rotolini, ID.risotto, ID.tiramisu]]]))).data.order;
    const o2 = (await garcom.post('/api/orders', newOrder(4, [[ID.risotto, 1]]))).data.order;
    await garcom.post(`/api/items/${o1.items[0].id}/cancel`, { cancellationId: randomUUID(), qty: 1, reason: 'Cliente desistiu' });
    await cozinha.post(ticketPath(o2.id), { from: 'novo', to: 'preparando' });
    await cozinha.post(ticketPath(o2.id), { from: 'preparando', to: 'pronto' });
    const bill = (await caixa.get(`/api/tabs/${o1.tabId}/bill`)).data;
    await caixa.post(`/api/tabs/${o1.tabId}/close`, { expectedTotalCents: bill.grandTotalCents });

    const r = (await dono.get('/api/owner/report')).data;
    const expected = PRICE.refri * 1 + 2 * PRICE.combo + PRICE.risotto;
    assert.equal(r.kpis.salesCents, expected, 'vendas = itens válidos');
    const service = Math.round(expected * 0.1);
    assert.equal(r.kpis.serviceCents, service, 'serviço de 10% registrado');
    assert.equal(r.kpis.closedRevenueCents, expected + service, 'recebido = conta fechada (com serviço)');
    assert.equal(r.kpis.avgTicketCents, expected + service);
    assert.equal(r.kpis.itemsSold, 1 + 2 + 1);
    assert.equal(r.kpis.ordersCount, 2);
    assert.equal(r.kpis.tablesServed, 1);
    assert.equal(r.kpis.cancelledQty, 1);
    assert.equal(r.kpis.prepCount, 1, 'tempo de preparo medido no pedido que ficou pronto');

    const p = (id) => r.products.find((x) => x.menuItemId === id);
    assert.equal(r.products[0].menuItemId, ID.combo, 'Menu Completo é o mais vendido (2)');
    assert.equal(p(ID.risotto).qty, 1);
    assert.equal(p(ID.risotto).inCombos, 2);
    assert.equal(p(ID.risotto).servedQty, 3, 'preferência: 1 avulso + 2 no Menu Completo');
    assert.equal(p(ID.tiramisu).servedQty, 2);
    assert.equal(p(ID.refri).cancelledQty, 1);
    assert.equal(r.comboChoices.find((c) => c.step === 'Prato principal').items[0].menuItemId, ID.risotto);
    assert.equal(r.categories.find((c) => c.category === 'Não alcoólicas').revenueCents, PRICE.refri);
    assert.equal(r.waiters[0].name, 'Ana');
    assert.equal(r.cancellations.byReason[0].reason, 'Cliente desistiu');
    assert.equal(r.hours.reduce((s, h) => s + h.orders, 0), 2);
    assert.equal(r.days.length, 1);
    assert.equal(r.days[0].revenueCents, expected);
  });
});
