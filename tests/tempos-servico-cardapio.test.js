// Menu Completo em tempos, bebidas fora da cozinha, taxa de serviço e edição livre do cardápio.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServer, tmpDataDir, login, newOrder, ID, PRICE, ticketPath } from './helpers.js';

const T = { timeout: 30_000 };
let srv;
let garcom;
let cozinha;
let caixa;
let admin;

before(async () => {
  srv = await startServer({ dataDir: tmpDataDir('tempos') });
  [garcom, cozinha, caixa, admin] = await Promise.all([
    login(srv.base, 'garcom', { name: 'Ana' }),
    login(srv.base, 'cozinha'),
    login(srv.base, 'caixa'),
    login(srv.base, 'admin'),
  ]);
});
after(() => srv?.stop());

const kitchenTickets = async () =>
  (await cozinha.get('/api/state')).data.orders.flatMap((o) => o.tickets.map((t) => ({ ...t, tableNumber: o.tableNumber })));

describe('Menu Completo em tempos e cozinha só com comida', () => {
  test('entrada sai na hora; prato principal e sobremesa aguardam o garçom; bebida não vai para a cozinha', T, async () => {
    const order = (
      await garcom.post('/api/orders', newOrder(1, [[ID.combo, 2, '', [ID.rotolini, ID.risotto, ID.tiramisu]], [ID.refri, 2], [ID.chianti, 1]]))
    ).data.order;
    assert.deepEqual(
      order.tickets.map((t) => [t.course, t.tempo, t.status]),
      [
        ['entrada', 1, 'novo'],
        ['principal', 2, 'aguardando'],
        ['sobremesa', 3, 'aguardando'],
      ],
    );
    const names = order.tickets.flatMap((t) => t.lines.map((l) => l.name));
    assert.deepEqual(names, ['Rotolini di Zucchine', 'Risotto alla Pera e Gorgonzola con Polpette al Vino Rosso', 'Tiramisu']);
    assert.ok(!names.includes('Coca-Cola lata') && !names.includes('Aperol Spritz'), 'bebidas fora da cozinha');
    assert.equal(order.tickets[0].lines[0].qty, 2, 'dois menus = 2 entradas');

    const bill = (await caixa.get(`/api/tabs/${order.tabId}/bill`)).data;
    assert.equal(bill.totalCents, 2 * PRICE.combo + 2 * PRICE.refri + PRICE.chianti, 'bebidas continuam na conta');

    // A cozinha não libera tempos; o garçom libera com um toque (repetir não faz nada).
    assert.equal((await cozinha.post(ticketPath(order.id, 'principal', 'fire'))).status, 403);
    const fired = (await garcom.post(ticketPath(order.id, 'principal', 'fire'))).data.order;
    assert.equal(fired.tickets.find((t) => t.course === 'principal').status, 'novo');
    assert.ok(fired.tickets.find((t) => t.course === 'principal').firedAt);
    assert.equal((await garcom.post(ticketPath(order.id, 'principal', 'fire'))).status, 200, 'toque repetido é inofensivo');
    assert.equal(fired.tickets.find((t) => t.course === 'sobremesa').status, 'aguardando', 'sobremesa continua aguardando');

    // Cada tempo tem o seu próprio check de entregue.
    await cozinha.post(ticketPath(order.id, 'entrada'), { from: 'novo', to: 'preparando' });
    await cozinha.post(ticketPath(order.id, 'entrada'), { from: 'preparando', to: 'pronto' });
    const delivered = (await garcom.post(ticketPath(order.id, 'entrada'), { from: 'pronto', to: 'entregue' })).data.order;
    assert.deepEqual(
      delivered.tickets.map((t) => t.status),
      ['entregue', 'novo', 'aguardando'],
      'entrada entregue; principal em preparo; sobremesa pendente',
    );
    assert.equal(delivered.status, 'novo', 'pedido continua aberto enquanto houver tempo pendente');
    const audit = (await admin.get('/api/admin/audit')).data.entries;
    assert.ok(audit.some((e) => e.action === 'ticket.fire' && e.entityId === order.id), 'liberação registrada na auditoria');
  });

  test('pedido só de bebidas não aparece na cozinha; pedido sem Menu Completo sai em um tempo só', T, async () => {
    const drinks = (await garcom.post('/api/orders', newOrder(2, [[ID.refri, 3], [ID.agua, 1]]))).data.order;
    assert.equal(drinks.tickets.length, 0);
    assert.equal(drinks.status, 'sem_cozinha');
    const food = (await garcom.post('/api/orders', newOrder(2, [[ID.rotolini, 1], [ID.trapanese, 1], [ID.refri, 1]]))).data.order;
    assert.deepEqual(food.tickets.map((t) => [t.course, t.status]), [['unico', 'novo']]);
    assert.equal(food.tickets[0].lines.length, 2, 'só os pratos');
    const k = await kitchenTickets();
    assert.ok(!k.some((t) => t.orderId === drinks.id));
  });

  test('cancelar o Menu Completo tira os três pratos de todos os tempos', T, async () => {
    const order = (await garcom.post('/api/orders', newOrder(3, [[ID.combo, 1, '', [ID.rotolini, ID.trapanese, ID.cheesecake]]]))).data.order;
    const r = await garcom.post(`/api/items/${order.items[0].id}/cancel`, { cancellationId: randomUUID(), reason: 'Cliente desistiu' });
    assert.ok(r.data.order.tickets.every((t) => t.fullyCancelled));
    assert.equal((await garcom.post(ticketPath(order.id, 'principal', 'fire'))).status, 409);
  });
});

describe('Taxa de serviço (10%) e taxa de rolha', () => {
  test('10% automático sobre o consumo (taxas de "Outros" fora), retirar e incluir, fechar pelo total com serviço', T, async () => {
    const order = (await garcom.post('/api/orders', newOrder(5, [[ID.risotto, 2], [ID.refri, 1], [ID.rolha, 1]]))).data.order;
    const tabId = order.tabId;
    let bill = (await caixa.get(`/api/tabs/${tabId}/bill`)).data;
    const base = 2 * PRICE.risotto + PRICE.refri;
    assert.equal(PRICE.rolha, 3000, 'taxa de rolha R$ 30,00');
    assert.equal(bill.totalCents, base + PRICE.rolha);
    assert.equal(bill.serviceEnabled, true);
    assert.equal(bill.serviceCents, Math.round(base * 0.1), 'rolha fora do cálculo dos 10%');
    assert.equal(bill.grandTotalCents, base + PRICE.rolha + Math.round(base * 0.1));

    assert.equal((await garcom.post(`/api/tabs/${tabId}/service`, { enabled: false })).data.tab.serviceCents, 0, 'garçom retira os 10%');
    bill = (await caixa.get(`/api/tabs/${tabId}/bill`)).data;
    assert.equal(bill.grandTotalCents, base + PRICE.rolha);
    assert.equal((await caixa.post(`/api/tabs/${tabId}/service`, { enabled: true })).data.tab.serviceEnabled, true, 'caixa inclui de novo');
    bill = (await caixa.get(`/api/tabs/${tabId}/bill`)).data;

    assert.equal((await caixa.post(`/api/tabs/${tabId}/close`, { expectedTotalCents: bill.totalCents })).data.error, 'TOTAL_CHANGED', 'fecha pelo total COM serviço');
    const closed = await caixa.post(`/api/tabs/${tabId}/close`, { expectedTotalCents: bill.grandTotalCents });
    assert.equal(closed.data.tab.closedTotalCents, bill.grandTotalCents);
    assert.equal((await garcom.post(`/api/tabs/${tabId}/service`, { enabled: false })).data.error, 'TAB_CLOSED', 'conta fechada não muda');
    const audit = (await admin.get('/api/admin/audit')).data.entries.filter((e) => e.action === 'tab.service' && e.entityId === tabId);
    assert.equal(audit.length, 2, 'retirar e incluir ficam registrados');
  });

  test('Admin define o padrão: mesas novas sem serviço e com outro percentual', T, async () => {
    await admin.put('/api/admin/settings', { serviceDefault: false, servicePct: 12 });
    const order = (await garcom.post('/api/orders', newOrder(6, [[ID.trapanese, 1]]))).data.order;
    const tab = (await caixa.get(`/api/tabs/${order.tabId}/bill`)).data;
    assert.equal(tab.serviceEnabled, false);
    assert.equal(tab.servicePct, 12);
    await garcom.post(`/api/tabs/${order.tabId}/service`, { enabled: true });
    const bill = (await caixa.get(`/api/tabs/${order.tabId}/bill`)).data;
    assert.equal(bill.serviceCents, Math.round(PRICE.trapanese * 0.12));
    await admin.put('/api/admin/settings', { serviceDefault: true, servicePct: 10 });
  });
});

describe('Edição livre do cardápio pelo Admin', () => {
  test('criar seção e item, mover, renomear, regra da cozinha por seção e excluir seção só vazia', T, async () => {
    assert.equal((await garcom.post('/api/admin/categories', { name: 'Petiscos', group: 'proposta', kitchen: true })).status, 403);
    const created = await admin.post('/api/admin/categories', { name: 'Petiscos', group: 'proposta', kitchen: true, course: null, inService: true });
    assert.equal(created.status, 201);
    assert.equal((await admin.post('/api/admin/categories', { name: 'petiscos', group: 'bebidas' })).data.error, 'CATEGORY_EXISTS');

    const a = (await admin.post('/api/admin/menu', { name: 'Bruschetta', category: 'Petiscos', priceCents: 2500 })).data;
    const b = (await admin.post('/api/admin/menu', { name: 'Azeitonas', category: 'Petiscos', priceCents: 1800, description: 'Temperadas' })).data;
    let menu = (await garcom.get('/api/state')).data.menu.filter((m) => m.category === 'Petiscos');
    assert.deepEqual(menu.map((m) => m.name), ['Bruschetta', 'Azeitonas']);
    await admin.post(`/api/admin/menu/${b.id}/move`, { dir: -1 });
    menu = (await garcom.get('/api/state')).data.menu.filter((m) => m.category === 'Petiscos');
    assert.deepEqual(menu.map((m) => m.name), ['Azeitonas', 'Bruschetta'], 'item movido para cima');

    // Seção nova que vai para a cozinha: pedido aparece na cozinha.
    const o = (await garcom.post('/api/orders', newOrder(8, [[a.id, 1]]))).data.order;
    assert.equal(o.tickets.length, 1);

    // Renomear a seção leva os itens junto; desligar a cozinha vale para os próximos pedidos.
    await admin.put(`/api/admin/categories/${encodeURIComponent('Petiscos')}`, { name: 'Para beliscar', kitchen: false });
    const state = (await garcom.get('/api/state')).data;
    assert.ok(state.categories.some((c) => c.name === 'Para beliscar' && !c.kitchen));
    assert.equal(state.menu.filter((m) => m.category === 'Para beliscar').length, 2);
    const o2 = (await garcom.post('/api/orders', newOrder(8, [[a.id, 1]]))).data.order;
    assert.equal(o2.tickets.length, 0, 'seção sem cozinha não vai para a cozinha');

    const cats = (await admin.get('/api/admin/categories')).data.filter((c) => c.group === 'proposta').map((c) => c.name);
    await admin.post(`/api/admin/categories/${encodeURIComponent('Para beliscar')}/move`, { dir: -1 });
    const after = (await admin.get('/api/admin/categories')).data.filter((c) => c.group === 'proposta').map((c) => c.name);
    assert.equal(after.indexOf('Para beliscar'), cats.indexOf('Para beliscar') - 1, 'seção movida para cima');

    const del = async (name) => {
      const r = await fetch(`${srv.base}/api/admin/categories/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
      return { status: r.status, data: await r.json() };
    };
    assert.equal((await del('Para beliscar')).data.error, 'CATEGORY_NOT_EMPTY');
    for (const id of [a.id, b.id]) await fetch(`${srv.base}/api/admin/menu/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal((await del('Para beliscar')).status, 200);
    assert.ok(!(await garcom.get('/api/state')).data.categories.some((c) => c.name === 'Para beliscar'));

    // Editar preço/descrição de item existente
    const up = await admin.put(`/api/admin/menu/${ID.agua}`, { priceCents: 600, description: 'Sem gás, 500 ml' });
    assert.equal(up.data.priceCents, 600);
    assert.equal(up.data.description, 'Sem gás, 500 ml');
  });
});
