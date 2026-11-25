import crypto from 'node:crypto';
import { CATEGORIES, LIMITS, ORDER_FLOW, COMBO_CATEGORY, COMBO_STEPS, MANAGER_ROLES, ROLE_LABELS } from '../shared/constants.js';
import { HttpError, nowIso, localDate, localDayRange, sha256, UUID_RE, cleanText, isInt } from './util.js';

/**
 * Regras de negócio. Toda alteração acontece dentro de uma transação síncrona do SQLite,
 * junto com o registro de auditoria, e só depois do COMMIT os aparelhos são avisados.
 */
export function createServices({ db, audit, auth, emit = () => {} }) {
  const q = {
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?').pluck(),
    setSetting: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    menuAll: db.prepare('SELECT * FROM menu_items WHERE archived = 0 ORDER BY sort, id'),
    menuUsed: db.prepare('SELECT 1 FROM order_items WHERE menu_item_id = ? LIMIT 1').pluck(),
    menuArchive: db.prepare('UPDATE menu_items SET active = 0, in_combo = 0, archived = 1, updated_at = ? WHERE id = ?'),
    menuDelete: db.prepare('DELETE FROM menu_items WHERE id = ?'),
    menuById: db.prepare('SELECT * FROM menu_items WHERE id = ?'),
    menuMaxSort: db.prepare('SELECT COALESCE(MAX(sort), 0) FROM menu_items').pluck(),
    insertMenu: db.prepare(`INSERT INTO menu_items (name, description, category, price_cents, active, in_combo, sort, created_at, updated_at)
      VALUES (@name, @description, @category, @price_cents, @active, @in_combo, @sort, @now, @now)`),
    updateMenu: db.prepare(`UPDATE menu_items SET name = @name, description = @description, category = @category,
      price_cents = @price_cents, active = @active, in_combo = @in_combo, updated_at = @now WHERE id = @id`),
    tabById: db.prepare('SELECT * FROM tabs WHERE id = ?'),
    activeTabForTable: db.prepare("SELECT * FROM tabs WHERE table_number = ? AND status <> 'closed'"),
    maxActiveTable: db.prepare("SELECT COALESCE(MAX(table_number), 0) FROM tabs WHERE status <> 'closed'").pluck(),
    insertTab: db.prepare(`INSERT INTO tabs (id, table_number, status, business_date, opened_at, opened_by_role, opened_by_name)
      VALUES (@id, @table_number, 'open', @business_date, @opened_at, @opened_by_role, @opened_by_name)`),
    setTabStatus: db.prepare('UPDATE tabs SET status = ?, bill_requested_at = ? WHERE id = ?'),
    closeTab: db.prepare(`UPDATE tabs SET status = 'closed', closed_at = @closed_at, closed_by_role = @role,
      closed_by_name = @name, closed_total_cents = @total WHERE id = @id AND status <> 'closed'`),
    reopenTab: db.prepare(`UPDATE tabs SET status = 'open', bill_requested_at = NULL, closed_at = NULL, closed_by_role = NULL,
      closed_by_name = NULL, closed_total_cents = NULL, reopen_count = reopen_count + 1 WHERE id = ? AND status = 'closed'`),
    tabTotal: db.prepare(`
      SELECT COALESCE(SUM((i.qty - COALESCE(c.cq, 0)) * i.unit_price_cents), 0)
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN (SELECT order_item_id, SUM(qty) AS cq FROM cancellations GROUP BY order_item_id) c ON c.order_item_id = i.id
      WHERE o.tab_id = ?`).pluck(),
    orderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    nextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 FROM orders WHERE business_date = ?').pluck(),
    insertOrder: db.prepare(`INSERT INTO orders (id, tab_id, table_number, seq, business_date, status, created_by_role,
      created_by_name, device_id, client_created_at, received_at, status_changed_at, payload_hash)
      VALUES (@id, @tab_id, @table_number, @seq, @business_date, 'novo', @created_by_role, @created_by_name, @device_id,
      @client_created_at, @received_at, @received_at, @payload_hash)`),
    insertItem: db.prepare(`INSERT INTO order_items (id, order_id, line_no, menu_item_id, name, category, unit_price_cents, qty, notes, components, created_at)
      VALUES (@id, @order_id, @line_no, @menu_item_id, @name, @category, @unit_price_cents, @qty, @notes, @components, @created_at)`),
    setOrderStatus: db.prepare('UPDATE orders SET status = ?, status_changed_at = ? WHERE id = ? AND status = ?'),
    itemById: db.prepare('SELECT * FROM order_items WHERE id = ?'),
    cancelledQty: db.prepare('SELECT COALESCE(SUM(qty), 0) FROM cancellations WHERE order_item_id = ?').pluck(),
    cancellationById: db.prepare('SELECT * FROM cancellations WHERE id = ?'),
    insertCancellation: db.prepare(`INSERT INTO cancellations (id, order_item_id, qty, reason, by_role, by_name, device_id, created_at)
      VALUES (@id, @order_item_id, @qty, @reason, @by_role, @by_name, @device_id, @created_at)`),
  };

  // ---------------------------------------------------------------- leitura

  function settings() {
    return {
      tableCount: Number(q.getSetting.get('table_count')),
      warnMinutes: Number(q.getSetting.get('warn_minutes')),
      lateMinutes: Number(q.getSetting.get('late_minutes')),
      proposalTitle: q.getSetting.get('proposal_title') || 'Proposta do mês',
    };
  }

  const serializeMenuItem = (m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    category: m.category,
    priceCents: m.price_cents,
    active: !!m.active,
    inCombo: !!m.in_combo,
    sort: m.sort,
  });

  function menu() {
    return q.menuAll.all().map(serializeMenuItem);
  }

  function serializeTab(t) {
    if (!t) return null;
    return {
      id: t.id,
      tableNumber: t.table_number,
      status: t.status,
      businessDate: t.business_date,
      openedAt: t.opened_at,
      openedBy: { role: t.opened_by_role, name: t.opened_by_name },
      billRequestedAt: t.bill_requested_at,
      closedAt: t.closed_at,
      closedBy: t.closed_at ? { role: t.closed_by_role, name: t.closed_by_name } : null,
      closedTotalCents: t.closed_total_cents,
      reopenCount: t.reopen_count,
      totalCents: q.tabTotal.get(t.id),
    };
  }

  function getTab(id) {
    return serializeTab(q.tabById.get(id));
  }

  /** Carrega pedidos completos (itens + cancelamentos) que satisfazem uma cláusula WHERE. */
  function loadOrders(whereSql, params = []) {
    const rows = db.prepare(`SELECT * FROM orders WHERE ${whereSql} ORDER BY received_at, seq`).all(...params);
    if (!rows.length) return [];
    const ids = JSON.stringify(rows.map((r) => r.id));
    const items = db
      .prepare('SELECT * FROM order_items WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY order_id, line_no')
      .all(ids);
    const cancels = db
      .prepare(
        `SELECT c.* FROM cancellations c JOIN order_items i ON i.id = c.order_item_id
         WHERE i.order_id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at`,
      )
      .all(ids);

    const cancelsByItem = new Map();
    for (const c of cancels) {
      if (!cancelsByItem.has(c.order_item_id)) cancelsByItem.set(c.order_item_id, []);
      cancelsByItem.get(c.order_item_id).push({
        id: c.id,
        qty: c.qty,
        reason: c.reason,
        by: { role: c.by_role, name: c.by_name },
        createdAt: c.created_at,
      });
    }
    const itemsByOrder = new Map();
    for (const i of items) {
      const cl = cancelsByItem.get(i.id) || [];
      const cancelledQty = cl.reduce((s, c) => s + c.qty, 0);
      if (!itemsByOrder.has(i.order_id)) itemsByOrder.set(i.order_id, []);
      itemsByOrder.get(i.order_id).push({
        id: i.id,
        lineNo: i.line_no,
        menuItemId: i.menu_item_id,
        name: i.name,
        category: i.category,
        unitPriceCents: i.unit_price_cents,
        qty: i.qty,
        cancelledQty,
        activeQty: i.qty - cancelledQty,
        notes: i.notes,
        components: JSON.parse(i.components || '[]'),
        createdAt: i.created_at,
        cancellations: cl,
      });
    }
    return rows.map((o) => {
      const its = itemsByOrder.get(o.id) || [];
      const allCancels = its.flatMap((i) => i.cancellations);
      return {
        id: o.id,
        tabId: o.tab_id,
        tableNumber: o.table_number,
        seq: o.seq,
        businessDate: o.business_date,
        status: o.status,
        createdBy: { role: o.created_by_role, name: o.created_by_name, deviceId: o.device_id },
        clientCreatedAt: o.client_created_at,
        receivedAt: o.received_at,
        statusChangedAt: o.status_changed_at,
        items: its,
        totalCents: its.reduce((s, i) => s + i.activeQty * i.unitPriceCents, 0),
        fullyCancelled: its.length > 0 && its.every((i) => i.activeQty === 0),
        lastCancelledAt: allCancels.length ? allCancels[allCancels.length - 1].createdAt : null,
      };
    });
  }

  function getOrder(id) {
    return loadOrders('id = ?', [id])[0] || null;
  }

  /** Estado completo para sincronizar um aparelho (carga inicial e após reconexão). */
  function state() {
    const today = localDate();
    const { startIso } = localDayRange(today);
    const tabs = db
      .prepare("SELECT * FROM tabs WHERE status <> 'closed' OR business_date = ? OR closed_at >= ? ORDER BY opened_at")
      .all(today, startIso)
      .map(serializeTab);
    const tabIds = JSON.stringify(tabs.map((t) => t.id));
    const orders = loadOrders(
      "tab_id IN (SELECT value FROM json_each(?)) OR status IN ('novo', 'preparando', 'pronto')",
      [tabIds],
    );
    return { serverTime: nowIso(), today, settings: settings(), menu: menu(), tabs, orders };
  }

  // ---------------------------------------------------------------- pedidos

  function validateOrderInput(input) {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'BAD_REQUEST', 'Pedido inválido.');
    const id = String(input.id || '').toLowerCase();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_ID', 'Identificador do pedido inválido.');
    const tableNumber = Number(input.tableNumber);
    if (!isInt(tableNumber, 1, LIMITS.maxTables)) throw new HttpError(400, 'BAD_TABLE', 'Número de mesa inválido.');
    const tabId = input.tabId ? String(input.tabId) : null;
    if (tabId && !UUID_RE.test(tabId)) throw new HttpError(400, 'BAD_TAB', 'Conta inválida.');
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new HttpError(400, 'EMPTY_ORDER', 'O pedido não tem itens.');
    }
    if (input.items.length > LIMITS.maxLinesPerOrder) throw new HttpError(400, 'TOO_MANY_ITEMS', 'Itens demais em um único pedido.');
    const items = input.items.map((it) => {
      const menuItemId = Number(it?.menuItemId);
      const qty = Number(it?.qty);
      if (!Number.isInteger(menuItemId)) throw new HttpError(400, 'BAD_ITEM', 'Item inválido.');
      if (!isInt(qty, 1, LIMITS.maxQty)) throw new HttpError(400, 'BAD_QTY', `Quantidade deve estar entre 1 e ${LIMITS.maxQty}.`);
      const components = it?.components == null ? [] : it.components;
      if (!Array.isArray(components) || components.length > COMBO_STEPS.length || !components.every((c) => Number.isInteger(c))) {
        throw new HttpError(400, 'BAD_COMBO', 'Escolhas do Menu Completo inválidas.');
      }
      return { menuItemId, qty, notes: cleanText(it?.notes, LIMITS.maxNotes), components };
    });
    const clientCreatedAt = input.clientCreatedAt ? cleanText(input.clientCreatedAt, 40) : null;
    return { id, tableNumber, tabId, items, clientCreatedAt };
  }

  /** Menu Completo: exige uma escolha válida por etapa e congela os nomes escolhidos. */
  function resolveComponents(menuRow, ids) {
    if (menuRow.category !== COMBO_CATEGORY) {
      if (ids.length) throw new HttpError(400, 'BAD_COMBO', `"${menuRow.name}" não é um Menu Completo.`);
      return [];
    }
    if (ids.length !== COMBO_STEPS.length) {
      throw new HttpError(400, 'BAD_COMBO', 'Escolha entrada, prato principal e sobremesa do Menu Completo.');
    }
    return COMBO_STEPS.map((step, i) => {
      const c = q.menuById.get(ids[i]);
      if (!c || !step.categories.includes(c.category)) {
        throw new HttpError(400, 'BAD_COMBO', `Escolha inválida para "${step.label}" no Menu Completo.`);
      }
      return { step: step.label, menuItemId: c.id, name: c.name };
    });
  }

  const createOrderTx = db.transaction((actor, v) => {
    const payloadHash = sha256(JSON.stringify([v.tableNumber, v.tabId, v.items.map((i) => [i.menuItemId, i.qty, i.notes, i.components])]));

    // Idempotência: o mesmo UUID nunca gera um segundo pedido.
    const existing = q.orderById.get(v.id);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new HttpError(409, 'ID_CONFLICT', 'Já existe um pedido com este identificador e conteúdo diferente.');
      }
      audit.log(actor, 'order.resend_ignored', 'order', v.id, { seq: existing.seq, mesa: existing.table_number });
      return { duplicate: true, orderId: v.id, tabEvents: false };
    }

    const { tableCount } = settings();
    if (v.tableNumber > tableCount) throw new HttpError(400, 'BAD_TABLE', `A mesa ${v.tableNumber} não existe.`);

    const menuRows = v.items.map((i) => {
      const m = q.menuById.get(i.menuItemId);
      if (!m) throw new HttpError(400, 'UNKNOWN_ITEM', 'Um dos itens não existe no cardápio.');
      return m;
    });
    const componentsByLine = v.items.map((i, idx) => resolveComponents(menuRows[idx], i.components));

    const now = nowIso();
    let tab;
    if (v.tabId) {
      tab = q.tabById.get(v.tabId);
      if (!tab) throw new HttpError(409, 'TAB_NOT_FOUND', 'A conta desta mesa não foi encontrada.');
      if (tab.table_number !== v.tableNumber) throw new HttpError(409, 'TAB_MISMATCH', 'A conta informada é de outra mesa.');
      if (tab.status === 'closed') {
        throw new HttpError(409, 'TAB_CLOSED', `A conta da mesa ${v.tableNumber} já foi fechada no caixa.`);
      }
    } else {
      // Sem conta informada: usa a conta aberta da mesa ou abre uma nova.
      // Dois garçons simultâneos caem na mesma conta (índice único + transação serializada).
      tab = q.activeTabForTable.get(v.tableNumber);
      if (!tab) {
        const newTab = {
          id: crypto.randomUUID(),
          table_number: v.tableNumber,
          business_date: localDate(),
          opened_at: now,
          opened_by_role: actor.role,
          opened_by_name: actor.name ?? null,
        };
        q.insertTab.run(newTab);
        audit.log(actor, 'tab.open', 'tab', newTab.id, { mesa: v.tableNumber });
        tab = q.tabById.get(newTab.id);
      }
    }
    if (tab.status === 'billing') {
      q.setTabStatus.run('open', null, tab.id);
      audit.log(actor, 'tab.bill_request_cleared', 'tab', tab.id, { mesa: v.tableNumber, motivo: 'novos itens lançados' });
    }

    const businessDate = localDate();
    const seq = q.nextSeq.get(businessDate);
    q.insertOrder.run({
      id: v.id,
      tab_id: tab.id,
      table_number: v.tableNumber,
      seq,
      business_date: businessDate,
      created_by_role: actor.role,
      created_by_name: actor.name ?? null,
      device_id: actor.deviceId ?? null,
      client_created_at: v.clientCreatedAt,
      received_at: now,
      payload_hash: payloadHash,
    });
    let total = 0;
    v.items.forEach((it, idx) => {
      const m = menuRows[idx];
      total += m.price_cents * it.qty;
      q.insertItem.run({
        id: crypto.randomUUID(),
        order_id: v.id,
        line_no: idx + 1,
        menu_item_id: m.id,
        name: m.name,
        category: m.category,
        unit_price_cents: m.price_cents, // preço congelado no momento do pedido
        qty: it.qty,
        notes: it.notes,
        components: JSON.stringify(componentsByLine[idx]),
        created_at: now,
      });
    });
    audit.log(actor, 'order.create', 'order', v.id, {
      seq,
      mesa: v.tableNumber,
      conta: tab.id,
      itens: v.items.map((it, idx) => ({
        item: menuRows[idx].name,
        qtd: it.qty,
        precoCentavos: menuRows[idx].price_cents,
        obs: it.notes || undefined,
        escolhas: componentsByLine[idx].length ? componentsByLine[idx].map((c) => c.name) : undefined,
      })),
      totalCentavos: total,
    });
    return { duplicate: false, orderId: v.id };
  });

  function createOrder(actor, input) {
    const v = validateOrderInput(input);
    const r = createOrderTx(actor, v);
    const order = getOrder(r.orderId);
    if (!r.duplicate) {
      emit('order:upsert', order);
      emit('tab:upsert', getTab(order.tabId));
    }
    return { order, duplicate: r.duplicate };
  }

  function setOrderStatus(actor, orderId, from, to) {
    db.transaction(() => {
      const o = q.orderById.get(orderId);
      if (!o) throw new HttpError(404, 'NOT_FOUND', 'Pedido não encontrado.');
      const fi = ORDER_FLOW.indexOf(from);
      const ti = ORDER_FLOW.indexOf(to);
      if (fi < 0 || ti < 0 || Math.abs(ti - fi) !== 1) {
        throw new HttpError(400, 'INVALID_TRANSITION', 'Mudança de status inválida.');
      }
      if (o.status !== from) {
        throw new HttpError(409, 'STATUS_CONFLICT', 'O pedido já foi atualizado em outro aparelho.', { order: getOrder(orderId) });
      }
      const kitchenLike = actor.role === 'cozinha' || MANAGER_ROLES.includes(actor.role);
      const pickupOnly = (from === 'pronto' && to === 'entregue') || (from === 'entregue' && to === 'pronto');
      if (!kitchenLike && !pickupOnly) throw new HttpError(403, 'FORBIDDEN', 'Somente a cozinha altera o preparo.');
      const order = getOrder(orderId);
      if (order.fullyCancelled && ti > fi) throw new HttpError(409, 'ORDER_CANCELLED', 'Este pedido foi totalmente cancelado.');
      const changed = q.setOrderStatus.run(to, nowIso(), orderId, from).changes;
      if (changed !== 1) throw new HttpError(409, 'STATUS_CONFLICT', 'O pedido já foi atualizado em outro aparelho.');
      audit.log(actor, 'order.status', 'order', orderId, { seq: o.seq, mesa: o.table_number, de: from, para: to });
    })();
    const order = getOrder(orderId);
    emit('order:upsert', order);
    if (to === 'pronto' && from === 'preparando') emit('order:ready', order);
    return order;
  }

  function cancelItem(actor, itemId, input = {}) {
    if (actor.role === 'cozinha') {
      throw new HttpError(403, 'FORBIDDEN', 'A cozinha não pode cancelar nem apagar pedidos.');
    }
    const cancellationId = String(input.cancellationId || '').toLowerCase();
    if (!UUID_RE.test(cancellationId)) throw new HttpError(400, 'BAD_ID', 'Identificador do cancelamento inválido.');
    const reason = cleanText(input.reason, LIMITS.maxReason);
    if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Informe o motivo do cancelamento.');

    const r = db.transaction(() => {
      const existing = q.cancellationById.get(cancellationId);
      if (existing) return { orderItemId: existing.order_item_id, duplicate: true };
      const item = q.itemById.get(itemId);
      if (!item) throw new HttpError(404, 'NOT_FOUND', 'Item não encontrado.');
      const order = q.orderById.get(item.order_id);
      const tab = q.tabById.get(order.tab_id);
      if (tab.status === 'closed') throw new HttpError(409, 'TAB_CLOSED', 'A conta já foi fechada. Reabra-a no caixa com o PIN de Admin.');
      const remaining = item.qty - q.cancelledQty.get(item.id);
      const qty = input.qty == null ? remaining : Number(input.qty);
      if (remaining <= 0) throw new HttpError(409, 'ALREADY_CANCELLED', 'Este item já está totalmente cancelado.');
      if (!isInt(qty, 1, remaining)) throw new HttpError(400, 'BAD_QTY', `Quantidade a cancelar deve estar entre 1 e ${remaining}.`);
      q.insertCancellation.run({
        id: cancellationId,
        order_item_id: item.id,
        qty,
        reason,
        by_role: actor.role,
        by_name: actor.name ?? null,
        device_id: actor.deviceId ?? null,
        created_at: nowIso(),
      });
      audit.log(actor, 'item.cancel', 'order_item', item.id, {
        pedido: order.id,
        seq: order.seq,
        mesa: order.table_number,
        item: item.name,
        qtd: qty,
        precoCentavos: item.unit_price_cents,
        valorCentavos: qty * item.unit_price_cents,
        motivo: reason,
      });
      return { orderItemId: item.id, duplicate: false };
    })();

    const item = q.itemById.get(r.orderItemId);
    const order = getOrder(item.order_id);
    if (!r.duplicate) {
      emit('order:upsert', order);
      emit('tab:upsert', getTab(order.tabId));
    }
    return { order, duplicate: r.duplicate };
  }

  // ---------------------------------------------------------------- contas

  function requestBill(actor, tabId) {
    db.transaction(() => {
      const tab = q.tabById.get(tabId);
      if (!tab) throw new HttpError(404, 'NOT_FOUND', 'Conta não encontrada.');
      if (tab.status === 'closed') throw new HttpError(409, 'TAB_CLOSED', 'Esta conta já foi fechada.');
      if (tab.status === 'billing') return;
      q.setTabStatus.run('billing', nowIso(), tabId);
      audit.log(actor, 'tab.request_bill', 'tab', tabId, { mesa: tab.table_number });
    })();
    const tab = getTab(tabId);
    emit('tab:upsert', tab);
    return tab;
  }

  function getBill(tabId) {
    const tab = getTab(tabId);
    if (!tab) throw new HttpError(404, 'NOT_FOUND', 'Conta não encontrada.');
    const orders = loadOrders('tab_id = ?', [tabId]);
    const lines = [];
    const cancelled = [];
    for (const o of orders) {
      for (const i of o.items) {
        if (i.activeQty > 0) {
          lines.push({
            orderId: o.id,
            orderSeq: o.seq,
            itemId: i.id,
            name: i.name,
            category: i.category,
            notes: i.notes,
            components: i.components,
            qty: i.activeQty,
            unitPriceCents: i.unitPriceCents,
            subtotalCents: i.activeQty * i.unitPriceCents,
            sentAt: o.receivedAt,
            sentBy: o.createdBy,
            orderStatus: o.status,
          });
        }
        for (const c of i.cancellations) {
          cancelled.push({
            orderSeq: o.seq,
            itemId: i.id,
            name: i.name,
            notes: i.notes,
            components: i.components,
            qty: c.qty,
            unitPriceCents: i.unitPriceCents,
            valueCents: c.qty * i.unitPriceCents,
            reason: c.reason,
            by: c.by,
            sentAt: o.receivedAt,
            cancelledAt: c.createdAt,
          });
        }
      }
    }
    const totalCents = lines.reduce((s, l) => s + l.subtotalCents, 0);
    const pendingKitchen = orders.filter((o) => !o.fullyCancelled && (o.status === 'novo' || o.status === 'preparando')).length;
    return {
      tab,
      lines,
      cancelled,
      totalCents,
      cancelledTotalCents: cancelled.reduce((s, c) => s + c.valueCents, 0),
      itemsCount: lines.reduce((s, l) => s + l.qty, 0),
      ordersCount: orders.length,
      pendingKitchen,
      generatedAt: nowIso(),
    };
  }

  function closeTab(actor, tabId, expectedTotalCents) {
    if (!Number.isInteger(expectedTotalCents)) {
      throw new HttpError(400, 'EXPECTED_TOTAL_REQUIRED', 'Informe o total conferido para fechar a conta.');
    }
    db.transaction(() => {
      const tab = q.tabById.get(tabId);
      if (!tab) throw new HttpError(404, 'NOT_FOUND', 'Conta não encontrada.');
      if (tab.status === 'closed') throw new HttpError(409, 'ALREADY_CLOSED', 'Esta conta já está fechada.');
      const total = q.tabTotal.get(tabId);
      if (total !== expectedTotalCents) {
        throw new HttpError(409, 'TOTAL_CHANGED', 'A conta mudou enquanto você conferia (novos itens ou cancelamentos). Confira novamente.', {
          totalCents: total,
        });
      }
      q.closeTab.run({ id: tabId, closed_at: nowIso(), role: actor.role, name: actor.name ?? null, total });
      audit.log(actor, 'tab.close', 'tab', tabId, { mesa: tab.table_number, totalCentavos: total });
    })();
    const tab = getTab(tabId);
    emit('tab:upsert', tab);
    return getBill(tabId);
  }

  function reopenTab(actor, tabId, adminPin, reasonInput) {
    const reason = cleanText(reasonInput, LIMITS.maxReason);
    const tabRow = q.tabById.get(tabId);
    if (!tabRow) throw new HttpError(404, 'NOT_FOUND', 'Conta não encontrada.');
    if (!auth.verifyAdminPin(adminPin)) {
      db.transaction(() => audit.log(actor, 'tab.reopen_denied', 'tab', tabId, { mesa: tabRow.table_number, motivo: 'PIN de Admin incorreto' }))();
      throw new HttpError(403, 'ADMIN_PIN_REQUIRED', 'PIN de Admin incorreto.');
    }
    if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Informe o motivo da reabertura.');
    db.transaction(() => {
      const tab = q.tabById.get(tabId);
      if (tab.status !== 'closed') throw new HttpError(409, 'NOT_CLOSED', 'Esta conta não está fechada.');
      const other = q.activeTabForTable.get(tab.table_number);
      if (other) {
        throw new HttpError(409, 'TABLE_BUSY', `A mesa ${tab.table_number} já tem outra conta aberta. Feche-a antes de reabrir esta.`);
      }
      q.reopenTab.run(tabId);
      audit.log(actor, 'tab.reopen', 'tab', tabId, {
        mesa: tab.table_number,
        motivo: reason,
        autorizadoPor: 'PIN de Admin',
        totalAnteriorCentavos: tab.closed_total_cents,
        fechadaEm: tab.closed_at,
      });
    })();
    const tab = getTab(tabId);
    emit('tab:upsert', tab);
    return tab;
  }

  // ---------------------------------------------------------------- administração

  function validateMenuInput(input, current) {
    const name = cleanText(input.name ?? current?.name, 80);
    const description = cleanText(input.description ?? current?.description ?? '', LIMITS.maxDescription);
    const category = input.category ?? current?.category;
    const priceCents = input.priceCents ?? current?.price_cents;
    const active = input.active ?? (current ? !!current.active : true);
    const inCombo = input.inCombo ?? (current ? !!current.in_combo : false);
    if (name.length < 2) throw new HttpError(400, 'BAD_NAME', 'Informe o nome do item.');
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'BAD_CATEGORY', 'Categoria inválida.');
    if (!isInt(priceCents, 0, 10_000_000)) throw new HttpError(400, 'BAD_PRICE', 'Preço inválido.');
    return { name, description, category, price_cents: priceCents, active: active ? 1 : 0, in_combo: inCombo && category !== COMBO_CATEGORY ? 1 : 0 };
  }

  function createMenuItem(actor, input) {
    const v = validateMenuInput(input || {});
    const id = db.transaction(() => {
      const info = q.insertMenu.run({ ...v, sort: q.menuMaxSort.get() + 10, now: nowIso() });
      audit.log(actor, 'menu.create', 'menu_item', info.lastInsertRowid, v);
      return Number(info.lastInsertRowid);
    })();
    emit('menu:changed', menu());
    return serializeMenuItem(q.menuById.get(id));
  }

  function updateMenuItem(actor, id, input) {
    db.transaction(() => {
      const current = q.menuById.get(id);
      if (!current || current.archived) throw new HttpError(404, 'NOT_FOUND', 'Item não encontrado.');
      const v = validateMenuInput(input || {}, current);
      q.updateMenu.run({ ...v, id, now: nowIso() });
      const before = { name: current.name, description: current.description, category: current.category, price_cents: current.price_cents, active: current.active, in_combo: current.in_combo };
      const changes = Object.fromEntries(Object.keys(v).filter((k) => v[k] !== before[k]).map((k) => [k, { de: before[k], para: v[k] }]));
      audit.log(actor, 'menu.update', 'menu_item', id, { item: current.name, alteracoes: changes });
    })();
    emit('menu:changed', menu());
    return serializeMenuItem(q.menuById.get(id));
  }

  /** Excluir item do cardápio: apaga de verdade se nunca foi pedido; senão arquiva (histórico preservado). */
  function removeMenuItem(actor, id) {
    const result = db.transaction(() => {
      const current = q.menuById.get(id);
      if (!current || current.archived) throw new HttpError(404, 'NOT_FOUND', 'Item não encontrado.');
      const used = !!q.menuUsed.get(id);
      if (used) q.menuArchive.run(nowIso(), id);
      else q.menuDelete.run(id);
      audit.log(actor, 'menu.delete', 'menu_item', id, { item: current.name, modo: used ? 'arquivado (já consta em pedidos)' : 'excluído' });
      return used ? 'archived' : 'deleted';
    })();
    emit('menu:changed', menu());
    return { result };
  }

  function updateSettings(actor, input = {}) {
    const cur = settings();
    const next = {
      tableCount: input.tableCount ?? cur.tableCount,
      warnMinutes: input.warnMinutes ?? cur.warnMinutes,
      lateMinutes: input.lateMinutes ?? cur.lateMinutes,
      proposalTitle: input.proposalTitle == null ? cur.proposalTitle : cleanText(input.proposalTitle, 40),
    };
    if (next.proposalTitle.length < 3) throw new HttpError(400, 'BAD_TITLE', 'Informe o nome da proposta do mês.');
    if (!isInt(next.tableCount, LIMITS.minTables, LIMITS.maxTables)) {
      throw new HttpError(400, 'BAD_TABLES', `Número de mesas deve estar entre ${LIMITS.minTables} e ${LIMITS.maxTables}.`);
    }
    if (!isInt(next.warnMinutes, 1, 240) || !isInt(next.lateMinutes, 2, 480) || next.lateMinutes <= next.warnMinutes) {
      throw new HttpError(400, 'BAD_TIMERS', 'O tempo de atraso deve ser maior que o de alerta.');
    }
    db.transaction(() => {
      const maxActive = q.maxActiveTable.get();
      if (next.tableCount < maxActive) {
        throw new HttpError(409, 'TABLE_IN_USE', `A mesa ${maxActive} está com conta aberta; não é possível reduzir para ${next.tableCount} mesas.`);
      }
      q.setSetting.run('table_count', String(next.tableCount));
      q.setSetting.run('warn_minutes', String(next.warnMinutes));
      q.setSetting.run('late_minutes', String(next.lateMinutes));
      q.setSetting.run('proposal_title', next.proposalTitle);
      audit.log(actor, 'settings.update', 'settings', null, { de: cur, para: next });
    })();
    emit('settings:changed', settings());
    return settings();
  }

  function history(date) {
    const { startIso, endIso } = localDayRange(date);
    const orders = loadOrders('business_date = ?', [date]);
    const tabs = db
      .prepare('SELECT * FROM tabs WHERE business_date = ? OR (closed_at >= ? AND closed_at < ?) ORDER BY opened_at')
      .all(date, startIso, endIso)
      .map(serializeTab);
    const cancellations = [];
    let itemsCount = 0;
    let ordersCents = 0;
    for (const o of orders) {
      ordersCents += o.totalCents;
      for (const i of o.items) {
        itemsCount += i.activeQty;
        for (const c of i.cancellations) {
          cancellations.push({ orderSeq: o.seq, tableNumber: o.tableNumber, name: i.name, qty: c.qty, valueCents: c.qty * i.unitPriceCents, reason: c.reason, by: c.by, at: c.createdAt });
        }
      }
    }
    const closed = tabs.filter((t) => t.status === 'closed' && t.closedAt >= startIso && t.closedAt < endIso);
    const open = tabs.filter((t) => t.status !== 'closed');
    return {
      date,
      generatedAt: nowIso(),
      summary: {
        ordersCount: orders.length,
        itemsCount,
        ordersCents,
        cancelledCount: cancellations.reduce((s, c) => s + c.qty, 0),
        cancelledCents: cancellations.reduce((s, c) => s + c.valueCents, 0),
        closedTabsCount: closed.length,
        closedRevenueCents: closed.reduce((s, t) => s + t.closedTotalCents, 0),
        openTabsCount: open.length,
        openTabsCents: open.reduce((s, t) => s + t.totalCents, 0),
      },
      tabs,
      orders,
      cancellations,
    };
  }

  // ---------------------------------------------------------------- relatórios (Proprietário)

  function datesBetween(from, to) {
    const out = [];
    const [y, m, d] = from.split('-').map(Number);
    for (let i = 0; i < 400; i++) {
      const dt = new Date(y, m - 1, d + i, 12);
      const s = localDate(dt);
      if (s > to) break;
      out.push(s);
    }
    return out;
  }

  function report(from, to) {
    localDayRange(from);
    localDayRange(to);
    if (from > to) throw new HttpError(400, 'BAD_RANGE', 'A data inicial deve ser anterior à final.');
    const days = datesBetween(from, to);
    if (days[days.length - 1] !== to) throw new HttpError(400, 'BAD_RANGE', 'Período longo demais (máximo de 400 dias).');
    const { startIso } = localDayRange(from);
    const { endIso } = localDayRange(to);

    const orders = loadOrders('business_date BETWEEN ? AND ?', [from, to]);
    const menuRows = new Map(db.prepare('SELECT * FROM menu_items').all().map((m) => [m.id, m]));
    const products = new Map();
    const categories = new Map();
    const byDay = new Map();
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, items: 0, revenueCents: 0 }));
    const waiters = new Map();
    const choices = new Map();
    const reasons = new Map();
    const tabsServed = new Set();
    let salesCents = 0;
    let itemsSold = 0;
    let ordersCount = 0;
    let cancelledQty = 0;
    let cancelledCents = 0;
    let sentQty = 0;

    for (const o of orders) {
      const hour = new Date(o.receivedAt).getHours();
      const day = byDay.get(o.businessDate) || { date: o.businessDate, revenueCents: 0, orders: 0, items: 0 };
      byDay.set(o.businessDate, day);
      const who = o.createdBy.name || ROLE_LABELS[o.createdBy.role] || o.createdBy.role;
      const waiter = waiters.get(who) || { name: who, orders: 0, items: 0, revenueCents: 0 };
      waiters.set(who, waiter);
      if (!o.fullyCancelled) {
        ordersCount++;
        day.orders++;
        hours[hour].orders++;
        waiter.orders++;
        tabsServed.add(o.tabId);
      }
      for (const i of o.items) {
        const m = menuRows.get(i.menuItemId);
        const name = m?.name ?? i.name;
        const category = m && !m.archived ? m.category : i.category;
        const value = i.activeQty * i.unitPriceCents;
        const p = products.get(i.menuItemId) || { menuItemId: i.menuItemId, name, category, qty: 0, revenueCents: 0, cancelledQty: 0, cancelledCents: 0, orderIds: new Set(), inCombos: 0 };
        products.set(i.menuItemId, p);
        p.qty += i.activeQty;
        p.revenueCents += value;
        p.cancelledQty += i.cancelledQty;
        p.cancelledCents += i.cancelledQty * i.unitPriceCents;
        if (i.activeQty > 0) p.orderIds.add(o.id);
        const c = categories.get(category) || { category, qty: 0, revenueCents: 0 };
        categories.set(category, c);
        c.qty += i.activeQty;
        c.revenueCents += value;
        salesCents += value;
        itemsSold += i.activeQty;
        sentQty += i.qty;
        day.revenueCents += value;
        day.items += i.activeQty;
        hours[hour].items += i.activeQty;
        hours[hour].revenueCents += value;
        waiter.items += i.activeQty;
        waiter.revenueCents += value;
        if (i.activeQty > 0) {
          for (const comp of i.components) {
            const key = `${comp.step}|${comp.menuItemId}`;
            const ch = choices.get(key) || { step: comp.step, menuItemId: comp.menuItemId, name: menuRows.get(comp.menuItemId)?.name ?? comp.name, qty: 0 };
            choices.set(key, ch);
            ch.qty += i.activeQty;
          }
        }
        for (const cl of i.cancellations) {
          cancelledQty += cl.qty;
          cancelledCents += cl.qty * i.unitPriceCents;
          const r = reasons.get(cl.reason) || { reason: cl.reason, qty: 0, valueCents: 0 };
          reasons.set(cl.reason, r);
          r.qty += cl.qty;
          r.valueCents += cl.qty * i.unitPriceCents;
        }
      }
    }

    // "Preferência": quantas vezes o prato foi servido, avulso ou escolhido dentro do Menu Completo.
    for (const ch of choices.values()) {
      const p = products.get(ch.menuItemId);
      if (p) p.inCombos += ch.qty;
      else {
        const m = menuRows.get(ch.menuItemId);
        products.set(ch.menuItemId, { menuItemId: ch.menuItemId, name: ch.name, category: m && !m.archived ? m.category : '', qty: 0, revenueCents: 0, cancelledQty: 0, cancelledCents: 0, orderIds: new Set(), inCombos: ch.qty });
      }
    }
    const productList = [...products.values()]
      .map(({ orderIds, ...p }) => ({ ...p, ordersCount: orderIds.size, servedQty: p.qty + p.inCombos }))
      .sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents || a.name.localeCompare(b.name));

    const closedTabs = db.prepare("SELECT * FROM tabs WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?").all(startIso, endIso);
    const closedRevenueCents = closedTabs.reduce((s, t) => s + t.closed_total_cents, 0);
    const avgTabMinutes = closedTabs.length
      ? closedTabs.reduce((s, t) => s + (new Date(t.closed_at) - new Date(t.opened_at)), 0) / closedTabs.length / 60000
      : null;

    const prep = db
      .prepare(
        `SELECT o.received_at AS r, MIN(a.at) AS p FROM orders o
         JOIN audit_log a ON a.entity_id = o.id AND a.action = 'order.status' AND json_extract(a.details, '$.para') = 'pronto'
         WHERE o.business_date BETWEEN ? AND ? GROUP BY o.id`,
      )
      .all(from, to);
    const avgPrepMinutes = prep.length ? prep.reduce((s, x) => s + (new Date(x.p) - new Date(x.r)), 0) / prep.length / 60000 : null;

    return {
      from,
      to,
      generatedAt: nowIso(),
      kpis: {
        salesCents,
        itemsSold,
        ordersCount,
        tablesServed: tabsServed.size,
        closedTabs: closedTabs.length,
        closedRevenueCents,
        avgTicketCents: closedTabs.length ? Math.round(closedRevenueCents / closedTabs.length) : null,
        avgTabMinutes,
        cancelledQty,
        cancelledCents,
        cancelRatePct: sentQty ? (cancelledQty / sentQty) * 100 : 0,
        avgPrepMinutes,
        prepCount: prep.length,
        daysWithSales: byDay.size,
      },
      products: productList,
      categories: CATEGORIES.map((c) => categories.get(c)).filter(Boolean).concat([...categories.values()].filter((c) => !CATEGORIES.includes(c.category))),
      days: days.filter((d) => byDay.has(d)).map((d) => byDay.get(d)),
      hours,
      waiters: [...waiters.values()].sort((a, b) => b.revenueCents - a.revenueCents),
      comboChoices: COMBO_STEPS.map((s) => ({
        step: s.label,
        items: [...choices.values()].filter((c) => c.step === s.label).sort((a, b) => b.qty - a.qty),
      })),
      cancellations: {
        byReason: [...reasons.values()].sort((a, b) => b.qty - a.qty),
        byProduct: productList.filter((p) => p.cancelledQty > 0).sort((a, b) => b.cancelledQty - a.cancelledQty),
      },
    };
  }

  return {
    report,
    removeMenuItem,
    settings,
    menu,
    state,
    getTab,
    getOrder,
    loadOrders,
    createOrder,
    setOrderStatus,
    cancelItem,
    requestBill,
    getBill,
    closeTab,
    reopenTab,
    createMenuItem,
    updateMenuItem,
    updateSettings,
    history,
  };
}
