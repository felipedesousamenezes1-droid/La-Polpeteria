import crypto from 'node:crypto';
import { LIMITS, ORDER_FLOW, COMBO_STEPS, COURSES, MENU_GROUPS, MANAGER_ROLES, ROLE_LABELS } from '../shared/constants.js';
import { HttpError, nowIso, localDate, localDayRange, sha256, UUID_RE, cleanText, isInt } from './util.js';

const STEP_COURSES = ['entrada', 'principal', 'sobremesa'];
const VALID_COURSES = [...STEP_COURSES, 'combo'];
const GROUP_ORDER = MENU_GROUPS.map((g) => g.key);

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
    // cardápio
    menuAll: db.prepare('SELECT * FROM menu_items WHERE archived = 0 ORDER BY sort, id'),
    menuUsed: db.prepare('SELECT 1 FROM order_items WHERE menu_item_id = ? LIMIT 1').pluck(),
    menuArchive: db.prepare('UPDATE menu_items SET active = 0, in_combo = 0, archived = 1, updated_at = ? WHERE id = ?'),
    menuDelete: db.prepare('DELETE FROM menu_items WHERE id = ?'),
    menuById: db.prepare('SELECT * FROM menu_items WHERE id = ?'),
    menuMaxSortInCat: db.prepare('SELECT COALESCE(MAX(sort), 0) FROM menu_items WHERE category = ? AND archived = 0').pluck(),
    menuInCat: db.prepare('SELECT * FROM menu_items WHERE category = ? AND archived = 0 ORDER BY sort, id'),
    menuSetSort: db.prepare('UPDATE menu_items SET sort = ? WHERE id = ?'),
    menuRenameCat: db.prepare('UPDATE menu_items SET category = ? WHERE category = ?'),
    menuCountInCat: db.prepare('SELECT COUNT(*) FROM menu_items WHERE category = ? AND archived = 0').pluck(),
    insertMenu: db.prepare(`INSERT INTO menu_items (name, description, category, price_cents, active, in_combo, sort, created_at, updated_at)
      VALUES (@name, @description, @category, @price_cents, @active, @in_combo, @sort, @now, @now)`),
    updateMenu: db.prepare(`UPDATE menu_items SET name = @name, description = @description, category = @category,
      price_cents = @price_cents, active = @active, in_combo = @in_combo, updated_at = @now WHERE id = @id`),
    // seções
    catAll: db.prepare('SELECT * FROM menu_categories ORDER BY sort, name'),
    catByName: db.prepare('SELECT * FROM menu_categories WHERE name = ?'),
    catByNameCI: db.prepare('SELECT * FROM menu_categories WHERE lower(name) = lower(?)'),
    catInsert: db.prepare('INSERT INTO menu_categories (name, group_key, sort, kitchen, course, in_service) VALUES (?, ?, ?, ?, ?, ?)'),
    catUpdate: db.prepare('UPDATE menu_categories SET name = ?, group_key = ?, kitchen = ?, course = ?, in_service = ? WHERE name = ?'),
    catDelete: db.prepare('DELETE FROM menu_categories WHERE name = ?'),
    catSetSort: db.prepare('UPDATE menu_categories SET sort = ? WHERE name = ?'),
    catInGroup: db.prepare('SELECT * FROM menu_categories WHERE group_key = ? ORDER BY sort, name'),
    catMaxSortInGroup: db.prepare('SELECT COALESCE(MAX(sort), 0) FROM menu_categories WHERE group_key = ?').pluck(),
    // contas
    tabById: db.prepare('SELECT * FROM tabs WHERE id = ?'),
    activeTabForTable: db.prepare("SELECT * FROM tabs WHERE table_number = ? AND status <> 'closed'"),
    maxActiveTable: db.prepare("SELECT COALESCE(MAX(table_number), 0) FROM tabs WHERE status <> 'closed'").pluck(),
    insertTab: db.prepare(`INSERT INTO tabs (id, table_number, status, business_date, opened_at, opened_by_role, opened_by_name, service_enabled, service_pct)
      VALUES (@id, @table_number, 'open', @business_date, @opened_at, @opened_by_role, @opened_by_name, @service_enabled, @service_pct)`),
    setTabStatus: db.prepare('UPDATE tabs SET status = ?, bill_requested_at = ? WHERE id = ?'),
    setTabService: db.prepare("UPDATE tabs SET service_enabled = ? WHERE id = ? AND status <> 'closed'"),
    closeTab: db.prepare(`UPDATE tabs SET status = 'closed', closed_at = @closed_at, closed_by_role = @role,
      closed_by_name = @name, closed_total_cents = @total, closed_service_cents = @service WHERE id = @id AND status <> 'closed'`),
    reopenTab: db.prepare(`UPDATE tabs SET status = 'open', bill_requested_at = NULL, closed_at = NULL, closed_by_role = NULL,
      closed_by_name = NULL, closed_total_cents = NULL, closed_service_cents = NULL, reopen_count = reopen_count + 1
      WHERE id = ? AND status = 'closed'`),
    tabTotal: db.prepare(`
      SELECT COALESCE(SUM((i.qty - COALESCE(c.cq, 0)) * i.unit_price_cents), 0) AS items,
             COALESCE(SUM(CASE WHEN i.in_service = 1 THEN (i.qty - COALESCE(c.cq, 0)) * i.unit_price_cents ELSE 0 END), 0) AS base
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN (SELECT order_item_id, SUM(qty) AS cq FROM cancellations GROUP BY order_item_id) c ON c.order_item_id = i.id
      WHERE o.tab_id = ?`),
    // pedidos
    orderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    nextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 FROM orders WHERE business_date = ?').pluck(),
    insertOrder: db.prepare(`INSERT INTO orders (id, tab_id, table_number, seq, business_date, status, created_by_role,
      created_by_name, device_id, client_created_at, received_at, status_changed_at, payload_hash)
      VALUES (@id, @tab_id, @table_number, @seq, @business_date, 'novo', @created_by_role, @created_by_name, @device_id,
      @client_created_at, @received_at, @received_at, @payload_hash)`),
    insertItem: db.prepare(`INSERT INTO order_items (id, order_id, line_no, menu_item_id, name, category, unit_price_cents, qty, notes,
      components, kitchen_course, in_service, created_at)
      VALUES (@id, @order_id, @line_no, @menu_item_id, @name, @category, @unit_price_cents, @qty, @notes,
      @components, @kitchen_course, @in_service, @created_at)`),
    itemById: db.prepare('SELECT * FROM order_items WHERE id = ?'),
    cancelledQty: db.prepare('SELECT COALESCE(SUM(qty), 0) FROM cancellations WHERE order_item_id = ?').pluck(),
    cancellationById: db.prepare('SELECT * FROM cancellations WHERE id = ?'),
    insertCancellation: db.prepare(`INSERT INTO cancellations (id, order_item_id, qty, reason, by_role, by_name, device_id, created_at)
      VALUES (@id, @order_item_id, @qty, @reason, @by_role, @by_name, @device_id, @created_at)`),
    // tempos da cozinha
    ticketById: db.prepare('SELECT * FROM kitchen_tickets WHERE id = ?'),
    insertTicket: db.prepare(`INSERT INTO kitchen_tickets (id, order_id, course, tempo, status, created_at, fired_at, status_changed_at)
      VALUES (@id, @order_id, @course, @tempo, @status, @now, @fired_at, @now)`),
    setTicketStatus: db.prepare(`UPDATE kitchen_tickets SET status = @to, status_changed_at = @now,
      ready_at = CASE WHEN @to = 'pronto' AND @from = 'preparando' THEN @now ELSE ready_at END
      WHERE id = @id AND status = @from`),
    setSchedule: db.prepare('UPDATE kitchen_tickets SET scheduled_at = ? WHERE id = ?'),
    postponeTicket: db.prepare("UPDATE kitchen_tickets SET extra_delay_min = extra_delay_min + ? WHERE id = ? AND status = 'aguardando'"),
    fireTicket: db.prepare(`UPDATE kitchen_tickets SET status = 'novo', fired_at = @now, status_changed_at = @now
      WHERE id = @id AND status = 'aguardando'`),
  };

  // ---------------------------------------------------------------- leitura

  function settings() {
    return {
      tableCount: Number(q.getSetting.get('table_count')),
      warnMinutes: Number(q.getSetting.get('warn_minutes')),
      lateMinutes: Number(q.getSetting.get('late_minutes')),
      proposalTitle: q.getSetting.get('proposal_title') || 'Proposta do mês',
      operationStartedAt: q.getSetting.get('operation_started_at') || null,
      resetId: q.getSetting.get('reset_id') || null,
      serviceDefault: q.getSetting.get('service_default') !== '0',
      servicePct: Number(q.getSetting.get('service_pct') ?? 10),
      // Minutos depois que o tempo anterior fica PRONTO na cozinha.
      coursePrincipalDelay: Number(q.getSetting.get('course_delay_principal') ?? 5),
      courseSobremesaDelay: Number(q.getSetting.get('course_delay_sobremesa') ?? 20),
    };
  }

  const serializeCategory = (c) => ({
    name: c.name,
    group: c.group_key,
    sort: c.sort,
    kitchen: !!c.kitchen,
    course: c.course || null,
    inService: !!c.in_service,
  });

  /** Seções na ordem do cardápio: grupo (Bebidas, Proposta, Vinhos, Outros) e depois a ordem da seção. */
  function categories() {
    return q.catAll
      .all()
      .map(serializeCategory)
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.sort - b.sort || a.name.localeCompare(b.name));
  }
  const catMap = () => new Map(q.catAll.all().map((c) => [c.name, c]));

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
    const order = new Map(categories().map((c, i) => [c.name, i]));
    return q.menuAll
      .all()
      .map(serializeMenuItem)
      .sort((a, b) => (order.get(a.category) ?? 999) - (order.get(b.category) ?? 999) || a.sort - b.sort || a.id - b.id);
  }

  function emitMenu() {
    emit('menu:changed', { menu: menu(), categories: categories() });
  }

  /** Valores de uma conta: consumo, taxa de serviço (sobre as seções que entram nos 10%) e total a pagar. */
  function tabMoney(t) {
    const { items, base } = q.tabTotal.get(t.id);
    const serviceEnabled = !!t.service_enabled;
    const serviceCents = serviceEnabled ? Math.round((base * t.service_pct) / 100) : 0;
    return {
      totalCents: items,
      serviceBaseCents: base,
      serviceEnabled,
      servicePct: t.service_pct,
      serviceCents,
      grandTotalCents: items + serviceCents,
    };
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
      closedServiceCents: t.closed_service_cents,
      reopenCount: t.reopen_count,
      ...tabMoney(t),
    };
  }

  function getTab(id) {
    return serializeTab(q.tabById.get(id));
  }

  /** Linhas de um tempo da cozinha: itens inteiros desse tempo + escolhas do Menu Completo desse tempo. */
  function ticketLines(items, course) {
    const lines = [];
    for (const i of items) {
      const last = i.cancellations.length ? i.cancellations[i.cancellations.length - 1].reason : null;
      if (i.kitchenCourse === course) {
        lines.push({ itemId: i.id, name: i.name, qty: i.activeQty, sentQty: i.qty, cancelledQty: i.cancelledQty, notes: i.notes, components: i.components, fromCombo: null, lastCancelReason: last });
      } else if (i.kitchenCourse === 'combo') {
        for (const c of i.components) {
          if (c.course === course) {
            lines.push({ itemId: i.id, name: c.name, qty: i.activeQty, sentQty: i.qty, cancelledQty: i.cancelledQty, notes: i.notes, components: [], fromCombo: i.name, lastCancelReason: last });
          }
        }
      }
    }
    return lines;
  }

  function aggregateStatus(tickets) {
    if (!tickets.length) return 'sem_cozinha';
    const live = tickets.filter((t) => !t.fullyCancelled);
    if (!live.length) return 'entregue';
    for (const s of ['pronto', 'preparando', 'novo', 'aguardando']) if (live.some((t) => t.status === s)) return s;
    return 'entregue';
  }

  /** Carrega pedidos completos (itens, cancelamentos e tempos da cozinha) que satisfazem uma cláusula WHERE. */
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
    const tickets = db
      .prepare('SELECT * FROM kitchen_tickets WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY tempo')
      .all(ids);

    const cancelsByItem = new Map();
    for (const c of cancels) {
      if (!cancelsByItem.has(c.order_item_id)) cancelsByItem.set(c.order_item_id, []);
      cancelsByItem.get(c.order_item_id).push({ id: c.id, qty: c.qty, reason: c.reason, by: { role: c.by_role, name: c.by_name }, createdAt: c.created_at });
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
        kitchenCourse: i.kitchen_course,
        inService: !!i.in_service,
        createdAt: i.created_at,
        cancellations: cl,
      });
    }
    const ticketsByOrder = new Map();
    for (const t of tickets) {
      if (!ticketsByOrder.has(t.order_id)) ticketsByOrder.set(t.order_id, []);
      ticketsByOrder.get(t.order_id).push(t);
    }
    return rows.map((o) => {
      const its = itemsByOrder.get(o.id) || [];
      const allCancels = its.flatMap((i) => i.cancellations);
      const lastCancelledAt = allCancels.length ? allCancels[allCancels.length - 1].createdAt : null;
      const raw = ticketsByOrder.get(o.id) || [];
      const ts = raw.map((t) => {
        const lines = ticketLines(its, t.course);
        return {
          id: t.id,
          orderId: o.id,
          course: t.course,
          tempo: t.tempo,
          tempos: raw.length,
          label: COURSES[t.course]?.label || 'Cozinha',
          status: t.status,
          firedAt: t.fired_at,
          readyAt: t.ready_at,
          scheduledAt: t.scheduled_at,
          extraDelayMin: t.extra_delay_min,
          statusChangedAt: t.status_changed_at,
          lines,
          fullyCancelled: lines.length > 0 && lines.every((l) => l.qty === 0),
          lastCancelledAt,
        };
      });
      return {
        id: o.id,
        tabId: o.tab_id,
        tableNumber: o.table_number,
        seq: o.seq,
        businessDate: o.business_date,
        status: aggregateStatus(ts),
        createdBy: { role: o.created_by_role, name: o.created_by_name, deviceId: o.device_id },
        clientCreatedAt: o.client_created_at,
        receivedAt: o.received_at,
        statusChangedAt: o.status_changed_at,
        items: its,
        tickets: ts,
        totalCents: its.reduce((s, i) => s + i.activeQty * i.unitPriceCents, 0),
        fullyCancelled: its.length > 0 && its.every((i) => i.activeQty === 0),
        lastCancelledAt,
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
      `tab_id IN (SELECT value FROM json_each(?))
       OR id IN (SELECT order_id FROM kitchen_tickets WHERE status IN ('aguardando', 'novo', 'preparando', 'pronto'))`,
      [tabIds],
    );
    return { serverTime: nowIso(), today, settings: settings(), categories: categories(), menu: menu(), tabs, orders };
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

  /** Menu Completo: exige uma escolha válida por etapa e congela nomes e tempos escolhidos. */
  function resolveComponents(menuRow, ids, cats) {
    if (cats.get(menuRow.category)?.course !== 'combo') {
      if (ids.length) throw new HttpError(400, 'BAD_COMBO', `"${menuRow.name}" não é um Menu Completo.`);
      return [];
    }
    if (ids.length !== COMBO_STEPS.length) {
      throw new HttpError(400, 'BAD_COMBO', 'Escolha entrada, prato principal e sobremesa do Menu Completo.');
    }
    return COMBO_STEPS.map((step, i) => {
      const c = q.menuById.get(ids[i]);
      if (!c || cats.get(c.category)?.course !== step.key) {
        throw new HttpError(400, 'BAD_COMBO', `Escolha inválida para "${step.label}" no Menu Completo.`);
      }
      return { step: step.label, course: step.key, menuItemId: c.id, name: c.name };
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
      return { duplicate: true, orderId: v.id };
    }

    const cfg = settings();
    if (v.tableNumber > cfg.tableCount) throw new HttpError(400, 'BAD_TABLE', `A mesa ${v.tableNumber} não existe.`);

    const cats = catMap();
    const lines = v.items.map((it) => {
      const m = q.menuById.get(it.menuItemId);
      if (!m) throw new HttpError(400, 'UNKNOWN_ITEM', 'Um dos itens não existe no cardápio.');
      const cat = cats.get(m.category);
      return {
        it,
        m,
        cat,
        comps: resolveComponents(m, it.components, cats),
        kitchen: !!cat?.kitchen,
        inService: cat ? !!cat.in_service : true,
        isCombo: cat?.course === 'combo',
      };
    });

    // Tempos: pedido com Menu Completo é dividido (entrada sai já; principal e sobremesa aguardam o garçom).
    // Sem Menu Completo, toda a comida sai junta. Bebidas e "Outros" não vão para a cozinha.
    const split = lines.some((l) => l.isCombo && l.kitchen);
    const courses = new Set();
    for (const l of lines) {
      if (!l.kitchen) l.course = null;
      else if (!split) l.course = 'unico';
      else if (l.isCombo) l.course = 'combo';
      else l.course = STEP_COURSES.includes(l.cat?.course) ? l.cat.course : 'entrada';
      if (l.course === 'combo') l.comps.forEach((c) => courses.add(c.course));
      else if (l.course) courses.add(l.course);
    }

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
          service_enabled: cfg.serviceDefault ? 1 : 0,
          service_pct: cfg.servicePct,
        };
        q.insertTab.run(newTab);
        audit.log(actor, 'tab.open', 'tab', newTab.id, { mesa: v.tableNumber, servico: newTab.service_enabled ? `${cfg.servicePct}%` : 'não' });
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
    lines.forEach((l, idx) => {
      total += l.m.price_cents * l.it.qty;
      q.insertItem.run({
        id: crypto.randomUUID(),
        order_id: v.id,
        line_no: idx + 1,
        menu_item_id: l.m.id,
        name: l.m.name,
        category: l.m.category,
        unit_price_cents: l.m.price_cents, // preço congelado no momento do pedido
        qty: l.it.qty,
        notes: l.it.notes,
        components: JSON.stringify(l.comps),
        kitchen_course: l.course,
        in_service: l.inService ? 1 : 0,
        created_at: now,
      });
    });
    const ordered = [...courses].sort((a, b) => COURSES[a].tempo - COURSES[b].tempo);
    ordered.forEach((course, i) => {
      q.insertTicket.run({
        id: `${v.id}:${course}`,
        order_id: v.id,
        course,
        tempo: i + 1,
        status: i === 0 ? 'novo' : 'aguardando',
        fired_at: i === 0 ? now : null,
        now,
      });
    });
    audit.log(actor, 'order.create', 'order', v.id, {
      seq,
      mesa: v.tableNumber,
      conta: tab.id,
      itens: lines.map((l) => ({
        item: l.m.name,
        qtd: l.it.qty,
        precoCentavos: l.m.price_cents,
        obs: l.it.notes || undefined,
        escolhas: l.comps.length ? l.comps.map((c) => c.name) : undefined,
      })),
      tempos: ordered.map((c) => COURSES[c].label),
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

  function ticketContext(ticketId) {
    const t = q.ticketById.get(ticketId);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Tempo da cozinha não encontrado.');
    const order = getOrder(t.order_id);
    return { t, order, ticket: order.tickets.find((x) => x.id === ticketId) };
  }

  /** Andamento de um tempo na cozinha: Novo → Preparando → Pronto → Entregue (um passo por vez). */
  function setTicketStatus(actor, ticketId, from, to) {
    let orderId;
    db.transaction(() => {
      const { t, order, ticket } = ticketContext(ticketId);
      orderId = order.id;
      const fi = ORDER_FLOW.indexOf(from);
      const ti = ORDER_FLOW.indexOf(to);
      if (fi < 0 || ti < 0 || Math.abs(ti - fi) !== 1) throw new HttpError(400, 'INVALID_TRANSITION', 'Mudança de status inválida.');
      if (t.status !== from) {
        throw new HttpError(409, 'STATUS_CONFLICT', 'Este prato já foi atualizado em outro aparelho.', { order });
      }
      const kitchenLike = actor.role === 'cozinha' || MANAGER_ROLES.includes(actor.role);
      const pickupOnly = (from === 'pronto' && to === 'entregue') || (from === 'entregue' && to === 'pronto');
      if (!kitchenLike && !pickupOnly) throw new HttpError(403, 'FORBIDDEN', 'Somente a cozinha altera o preparo.');
      if (ticket.fullyCancelled && ti > fi) throw new HttpError(409, 'ORDER_CANCELLED', 'Este prato foi totalmente cancelado.');
      const changed = q.setTicketStatus.run({ id: ticketId, from, to, now: nowIso() }).changes;
      if (changed !== 1) throw new HttpError(409, 'STATUS_CONFLICT', 'Este prato já foi atualizado em outro aparelho.');
      audit.log(actor, 'ticket.status', 'order', order.id, { seq: order.seq, mesa: order.tableNumber, tempo: ticket.label, de: from, para: to });
    })();
    runScheduler(); // "pronto" agenda o próximo tempo
    const order = getOrder(orderId);
    emit('order:upsert', order);
    return order;
  }

  /**
   * Agendador dos tempos: o próximo tempo sai SOZINHO depois que o anterior fica pronto
   * (prato principal: X min após a entrada; sobremesa: Y min após o principal; mais adiamentos).
   * Se o tempo anterior foi cancelado (ou não existe), sai na hora. Conta fechada não dispara nada.
   * Roda após mudanças na cozinha e periodicamente; o horário fica gravado (sobrevive a reinícios).
   */
  function runScheduler(now = new Date()) {
    const cfg = settings();
    const delay = { entrada: 0, unico: 0, principal: cfg.coursePrincipalDelay, sobremesa: cfg.courseSobremesaDelay };
    const nowIsoStr = now.toISOString();
    const orders = loadOrders("id IN (SELECT order_id FROM kitchen_tickets WHERE status = 'aguardando')");
    const changed = new Set();
    db.transaction(() => {
      for (const o of orders) {
        if (q.tabById.get(o.tabId)?.status === 'closed') continue;
        for (const t of o.tickets) {
          if (t.status !== 'aguardando' || t.fullyCancelled) continue;
          const prev = o.tickets.filter((x) => x.tempo < t.tempo && !x.fullyCancelled).pop();
          let due = null;
          if (!prev) due = nowIsoStr;
          else if ((prev.status === 'pronto' || prev.status === 'entregue') && prev.readyAt) {
            due = new Date(new Date(prev.readyAt).getTime() + ((delay[t.course] ?? 0) + t.extraDelayMin) * 60_000).toISOString();
          }
          if (due !== t.scheduledAt) {
            q.setSchedule.run(due, t.id);
            changed.add(o.id);
          }
          if (due && due <= nowIsoStr) {
            q.fireTicket.run({ id: t.id, now: nowIsoStr });
            audit.log(null, 'ticket.auto_fire', 'order', o.id, { seq: o.seq, mesa: o.tableNumber, tempo: t.label, automatico: true });
            changed.add(o.id);
          }
          break; // só o primeiro tempo aguardando de cada pedido; o seguinte depende deste
        }
      }
    })();
    for (const id of changed) emit('order:upsert', getOrder(id));
    return changed;
  }

  /** Exceção opcional: adiar o próximo tempo (cliente demorando). */
  function postponeTicket(actor, ticketId, minutes = 10) {
    if (!isInt(minutes, 1, 120)) throw new HttpError(400, 'BAD_REQUEST', 'Adiamento inválido.');
    let orderId;
    db.transaction(() => {
      const { t, order, ticket } = ticketContext(ticketId);
      orderId = order.id;
      if (t.status !== 'aguardando') throw new HttpError(409, 'ALREADY_FIRED', 'Este tempo já foi para a cozinha.');
      q.postponeTicket.run(minutes, ticketId);
      audit.log(actor, 'ticket.postpone', 'order', order.id, { seq: order.seq, mesa: order.tableNumber, tempo: ticket.label, minutos: minutes });
    })();
    runScheduler();
    const order = getOrder(orderId);
    emit('order:upsert', order);
    return order;
  }

  /** Exceção opcional: enviar agora um tempo que ainda aguardava (garçom antecipa ou cozinha puxa). */
  function fireTicket(actor, ticketId) {
    let orderId;
    let changed = 0;
    db.transaction(() => {
      const { t, order, ticket } = ticketContext(ticketId);
      orderId = order.id;
      if (t.status !== 'aguardando') return; // já liberado (toque repetido ou outro aparelho): nada a fazer
      if (ticket.fullyCancelled) throw new HttpError(409, 'ORDER_CANCELLED', 'Este prato foi totalmente cancelado.');
      changed = q.fireTicket.run({ id: ticketId, now: nowIso() }).changes;
      if (changed) audit.log(actor, 'ticket.fire', 'order', order.id, { seq: order.seq, mesa: order.tableNumber, tempo: ticket.label });
    })();
    const order = getOrder(orderId);
    if (changed) emit('order:upsert', order);
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

    if (!r.duplicate) runScheduler(); // tempo anterior cancelado libera o seguinte
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

  /** Incluir ou retirar a taxa de serviço de uma conta (calculada automaticamente). */
  function setService(actor, tabId, enabled) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'BAD_REQUEST', 'Informe se a taxa de serviço está incluída.');
    db.transaction(() => {
      const tab = q.tabById.get(tabId);
      if (!tab) throw new HttpError(404, 'NOT_FOUND', 'Conta não encontrada.');
      if (tab.status === 'closed') throw new HttpError(409, 'TAB_CLOSED', 'A conta já foi fechada. Reabra-a no caixa com o PIN de Admin.');
      if (!!tab.service_enabled === enabled) return;
      q.setTabService.run(enabled ? 1 : 0, tabId);
      audit.log(actor, 'tab.service', 'tab', tabId, { mesa: tab.table_number, servico: enabled ? `incluído (${tab.service_pct}%)` : 'retirado' });
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
            inService: i.inService,
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
    const pendingKitchen = orders
      .flatMap((o) => o.tickets)
      .filter((t) => !t.fullyCancelled && ['aguardando', 'novo', 'preparando'].includes(t.status)).length;
    return {
      tab,
      lines,
      cancelled,
      totalCents: tab.totalCents,
      serviceEnabled: tab.serviceEnabled,
      servicePct: tab.servicePct,
      serviceBaseCents: tab.serviceBaseCents,
      serviceCents: tab.serviceCents,
      grandTotalCents: tab.grandTotalCents,
      cancelledTotalCents: cancelled.reduce((s, c) => s + c.valueCents, 0),
      itemsCount: lines.reduce((s, l) => s + l.qty, 0),
      ordersCount: orders.length,
      pendingKitchen,
      generatedAt: nowIso(),
    };
  }

  /** Fecha a conta pelo total a pagar conferido (consumo + serviço). */
  function closeTab(actor, tabId, expectedTotalCents) {
    if (!Number.isInteger(expectedTotalCents)) {
      throw new HttpError(400, 'EXPECTED_TOTAL_REQUIRED', 'Informe o total conferido para fechar a conta.');
    }
    db.transaction(() => {
      const tab = q.tabById.get(tabId);
      if (!tab) throw new HttpError(404, 'NOT_FOUND', 'Conta não encontrada.');
      if (tab.status === 'closed') throw new HttpError(409, 'ALREADY_CLOSED', 'Esta conta já está fechada.');
      const money = tabMoney(tab);
      if (money.grandTotalCents !== expectedTotalCents) {
        throw new HttpError(409, 'TOTAL_CHANGED', 'A conta mudou enquanto você conferia (itens, cancelamentos ou taxa de serviço). Confira novamente.', {
          grandTotalCents: money.grandTotalCents,
        });
      }
      q.closeTab.run({ id: tabId, closed_at: nowIso(), role: actor.role, name: actor.name ?? null, total: money.grandTotalCents, service: money.serviceCents });
      audit.log(actor, 'tab.close', 'tab', tabId, {
        mesa: tab.table_number,
        consumoCentavos: money.totalCents,
        servicoCentavos: money.serviceCents,
        totalCentavos: money.grandTotalCents,
      });
    })();
    emit('tab:upsert', getTab(tabId));
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

  // ---------------------------------------------------------------- cardápio (Admin)

  function validateMenuInput(input, current) {
    const name = cleanText(input.name ?? current?.name, 80);
    const description = cleanText(input.description ?? current?.description ?? '', LIMITS.maxDescription);
    const category = input.category ?? current?.category;
    const priceCents = input.priceCents ?? current?.price_cents;
    const active = input.active ?? (current ? !!current.active : true);
    const inCombo = input.inCombo ?? (current ? !!current.in_combo : false);
    if (name.length < 2) throw new HttpError(400, 'BAD_NAME', 'Informe o nome do item.');
    const cat = q.catByName.get(category ?? '');
    if (!cat) throw new HttpError(400, 'BAD_CATEGORY', 'Seção inválida.');
    if (!isInt(priceCents, 0, 10_000_000)) throw new HttpError(400, 'BAD_PRICE', 'Preço inválido.');
    return {
      name,
      description,
      category,
      price_cents: priceCents,
      active: active ? 1 : 0,
      in_combo: inCombo && STEP_COURSES.includes(cat.course) ? 1 : 0,
    };
  }

  function createMenuItem(actor, input) {
    const v = validateMenuInput(input || {});
    const id = db.transaction(() => {
      const info = q.insertMenu.run({ ...v, sort: q.menuMaxSortInCat.get(v.category) + 10, now: nowIso() });
      audit.log(actor, 'menu.create', 'menu_item', info.lastInsertRowid, v);
      return Number(info.lastInsertRowid);
    })();
    emitMenu();
    return serializeMenuItem(q.menuById.get(id));
  }

  function updateMenuItem(actor, id, input) {
    db.transaction(() => {
      const current = q.menuById.get(id);
      if (!current || current.archived) throw new HttpError(404, 'NOT_FOUND', 'Item não encontrado.');
      const v = validateMenuInput(input || {}, current);
      q.updateMenu.run({ ...v, id, now: nowIso() });
      if (v.category !== current.category) q.menuSetSort.run(q.menuMaxSortInCat.get(v.category) + 10, id);
      const before = { name: current.name, description: current.description, category: current.category, price_cents: current.price_cents, active: current.active, in_combo: current.in_combo };
      const changes = Object.fromEntries(Object.keys(v).filter((k) => v[k] !== before[k]).map((k) => [k, { de: before[k], para: v[k] }]));
      audit.log(actor, 'menu.update', 'menu_item', id, { item: current.name, alteracoes: changes });
    })();
    emitMenu();
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
    emitMenu();
    return { result };
  }

  /** Troca a posição com o vizinho (dir = -1 sobe, +1 desce), renumerando a lista. */
  function moveInList(list, index, dir, setSort) {
    const target = index + dir;
    if (index < 0 || target < 0 || target >= list.length) return false;
    const arr = [...list];
    [arr[index], arr[target]] = [arr[target], arr[index]];
    arr.forEach((row, i) => setSort((i + 1) * 10, row));
    return true;
  }

  function moveMenuItem(actor, id, dir) {
    if (dir !== -1 && dir !== 1) throw new HttpError(400, 'BAD_REQUEST', 'Direção inválida.');
    db.transaction(() => {
      const current = q.menuById.get(id);
      if (!current || current.archived) throw new HttpError(404, 'NOT_FOUND', 'Item não encontrado.');
      const list = q.menuInCat.all(current.category);
      if (moveInList(list, list.findIndex((m) => m.id === id), dir, (sort, row) => q.menuSetSort.run(sort, row.id))) {
        audit.log(actor, 'menu.move', 'menu_item', id, { item: current.name, direcao: dir < 0 ? 'acima' : 'abaixo' });
      }
    })();
    emitMenu();
    return menu();
  }

  // ---------------------------------------------------------------- seções do cardápio (Admin)

  function validateCategoryInput(input, current) {
    const name = cleanText(input.name ?? current?.name, LIMITS.maxCategoryName);
    const group = input.group ?? current?.group_key;
    const kitchen = input.kitchen ?? (current ? !!current.kitchen : false);
    const rawCourse = input.course === undefined ? current?.course : input.course;
    const course = rawCourse ? String(rawCourse) : null;
    const inService = input.inService ?? (current ? !!current.in_service : true);
    if (name.length < 2) throw new HttpError(400, 'BAD_NAME', 'Informe o nome da seção.');
    if (!GROUP_ORDER.includes(group)) throw new HttpError(400, 'BAD_GROUP', 'Grupo inválido.');
    if (course && !VALID_COURSES.includes(course)) throw new HttpError(400, 'BAD_COURSE', 'Tempo inválido.');
    return { name, group, kitchen: kitchen ? 1 : 0, course, inService: inService ? 1 : 0 };
  }

  function createCategory(actor, input = {}) {
    const v = validateCategoryInput(input);
    db.transaction(() => {
      if (q.catByNameCI.get(v.name)) throw new HttpError(409, 'CATEGORY_EXISTS', 'Já existe uma seção com esse nome.');
      q.catInsert.run(v.name, v.group, q.catMaxSortInGroup.get(v.group) + 10, v.kitchen, v.course, v.inService);
      audit.log(actor, 'menu.category_create', 'category', v.name, v);
    })();
    emitMenu();
    return categories();
  }

  function updateCategory(actor, name, input = {}) {
    db.transaction(() => {
      const current = q.catByName.get(name);
      if (!current) throw new HttpError(404, 'NOT_FOUND', 'Seção não encontrada.');
      const v = validateCategoryInput(input, current);
      if (v.name !== name) {
        const clash = q.catByNameCI.get(v.name);
        if (clash && clash.name !== name) throw new HttpError(409, 'CATEGORY_EXISTS', 'Já existe uma seção com esse nome.');
      }
      q.catUpdate.run(v.name, v.group, v.kitchen, v.course, v.inService, name);
      if (v.group !== current.group_key) q.catSetSort.run(q.catMaxSortInGroup.get(v.group) + 10, v.name);
      if (v.name !== name) q.menuRenameCat.run(v.name, name);
      audit.log(actor, 'menu.category_update', 'category', name, { de: serializeCategory(current), para: v });
    })();
    emitMenu();
    return categories();
  }

  function deleteCategory(actor, name) {
    db.transaction(() => {
      const current = q.catByName.get(name);
      if (!current) throw new HttpError(404, 'NOT_FOUND', 'Seção não encontrada.');
      const n = q.menuCountInCat.get(name);
      if (n > 0) throw new HttpError(409, 'CATEGORY_NOT_EMPTY', `A seção "${name}" ainda tem ${n} item(ns). Mova ou exclua os itens antes.`);
      q.catDelete.run(name);
      audit.log(actor, 'menu.category_delete', 'category', name, serializeCategory(current));
    })();
    emitMenu();
    return categories();
  }

  function moveCategory(actor, name, dir) {
    if (dir !== -1 && dir !== 1) throw new HttpError(400, 'BAD_REQUEST', 'Direção inválida.');
    db.transaction(() => {
      const current = q.catByName.get(name);
      if (!current) throw new HttpError(404, 'NOT_FOUND', 'Seção não encontrada.');
      const list = q.catInGroup.all(current.group_key);
      if (moveInList(list, list.findIndex((c) => c.name === name), dir, (sort, row) => q.catSetSort.run(sort, row.name))) {
        audit.log(actor, 'menu.category_move', 'category', name, { direcao: dir < 0 ? 'acima' : 'abaixo' });
      }
    })();
    emitMenu();
    return categories();
  }

  // ---------------------------------------------------------------- configurações

  function updateSettings(actor, input = {}) {
    const cur = settings();
    const next = {
      tableCount: input.tableCount ?? cur.tableCount,
      warnMinutes: input.warnMinutes ?? cur.warnMinutes,
      lateMinutes: input.lateMinutes ?? cur.lateMinutes,
      proposalTitle: input.proposalTitle == null ? cur.proposalTitle : cleanText(input.proposalTitle, 40),
      serviceDefault: input.serviceDefault ?? cur.serviceDefault,
      servicePct: input.servicePct ?? cur.servicePct,
      coursePrincipalDelay: input.coursePrincipalDelay ?? cur.coursePrincipalDelay,
      courseSobremesaDelay: input.courseSobremesaDelay ?? cur.courseSobremesaDelay,
    };
    if (!isInt(next.coursePrincipalDelay, 0, 120) || !isInt(next.courseSobremesaDelay, 0, 120)) {
      throw new HttpError(400, 'BAD_DELAY', 'Intervalo entre tempos deve estar entre 0 e 120 minutos.');
    }
    if (next.proposalTitle.length < 3) throw new HttpError(400, 'BAD_TITLE', 'Informe o nome da proposta do mês.');
    if (!isInt(next.tableCount, LIMITS.minTables, LIMITS.maxTables)) {
      throw new HttpError(400, 'BAD_TABLES', `Número de mesas deve estar entre ${LIMITS.minTables} e ${LIMITS.maxTables}.`);
    }
    if (!isInt(next.warnMinutes, 1, 240) || !isInt(next.lateMinutes, 2, 480) || next.lateMinutes <= next.warnMinutes) {
      throw new HttpError(400, 'BAD_TIMERS', 'O tempo de atraso deve ser maior que o de alerta.');
    }
    if (typeof next.serviceDefault !== 'boolean' || !isInt(next.servicePct, 0, 30)) {
      throw new HttpError(400, 'BAD_SERVICE', 'Taxa de serviço deve estar entre 0% e 30%.');
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
      q.setSetting.run('service_default', next.serviceDefault ? '1' : '0');
      q.setSetting.run('service_pct', String(next.servicePct));
      q.setSetting.run('course_delay_principal', String(next.coursePrincipalDelay));
      q.setSetting.run('course_delay_sobremesa', String(next.courseSobremesaDelay));
      audit.log(actor, 'settings.update', 'settings', null, { de: cur, para: next });
    })();
    emit('settings:changed', settings());
    runScheduler(); // novos intervalos valem para os tempos que ainda aguardam
    return settings();
  }

  // ---------------------------------------------------------------- histórico do dia

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
        closedServiceCents: closed.reduce((s, t) => s + (t.closedServiceCents || 0), 0),
        openTabsCount: open.length,
        openTabsCents: open.reduce((s, t) => s + t.grandTotalCents, 0),
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

    const cats = categories();
    const catByName = new Map(cats.map((c) => [c.name, c]));
    const orders = loadOrders('business_date BETWEEN ? AND ?', [from, to]);
    const menuRows = new Map(db.prepare('SELECT * FROM menu_items').all().map((m) => [m.id, m]));
    const products = new Map();
    const categoryAgg = new Map();
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

    const productFor = (id, fallbackName, fallbackCategory) => {
      if (!products.has(id)) {
        const m = menuRows.get(id);
        const category = m && !m.archived ? m.category : fallbackCategory;
        products.set(id, {
          menuItemId: id,
          name: m?.name ?? fallbackName,
          category,
          isDish: STEP_COURSES.includes(catByName.get(category)?.course),
          qty: 0,
          revenueCents: 0,
          cancelledQty: 0,
          cancelledCents: 0,
          orderIds: new Set(),
          inCombos: 0,
        });
      }
      return products.get(id);
    };

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
        const p = productFor(i.menuItemId, i.name, i.category);
        const value = i.activeQty * i.unitPriceCents;
        p.qty += i.activeQty;
        p.revenueCents += value;
        p.cancelledQty += i.cancelledQty;
        p.cancelledCents += i.cancelledQty * i.unitPriceCents;
        if (i.activeQty > 0) p.orderIds.add(o.id);
        const c = categoryAgg.get(p.category) || { category: p.category, qty: 0, revenueCents: 0 };
        categoryAgg.set(p.category, c);
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
    for (const ch of choices.values()) productFor(ch.menuItemId, ch.name, '').inCombos += ch.qty;
    const productList = [...products.values()]
      .map(({ orderIds, ...p }) => ({ ...p, ordersCount: orderIds.size, servedQty: p.qty + p.inCombos }))
      .sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents || a.name.localeCompare(b.name));

    const closedTabs = db.prepare("SELECT * FROM tabs WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?").all(startIso, endIso);
    const closedRevenueCents = closedTabs.reduce((s, t) => s + t.closed_total_cents, 0);
    const serviceCents = closedTabs.reduce((s, t) => s + (t.closed_service_cents || 0), 0);
    const avgTabMinutes = closedTabs.length
      ? closedTabs.reduce((s, t) => s + (new Date(t.closed_at) - new Date(t.opened_at)), 0) / closedTabs.length / 60000
      : null;

    // Tempo de preparo: de quando o tempo foi liberado para a cozinha até ficar pronto.
    const prep = db
      .prepare(
        `SELECT t.fired_at AS f, t.ready_at AS r FROM kitchen_tickets t JOIN orders o ON o.id = t.order_id
         WHERE o.business_date BETWEEN ? AND ? AND t.fired_at IS NOT NULL AND t.ready_at IS NOT NULL`,
      )
      .all(from, to);
    const avgPrepMinutes = prep.length ? prep.reduce((s, x) => s + (new Date(x.r) - new Date(x.f)), 0) / prep.length / 60000 : null;

    const catOrder = new Map(cats.map((c, i) => [c.name, i]));
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
        serviceCents,
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
      categories: [...categoryAgg.values()].sort((a, b) => (catOrder.get(a.category) ?? 999) - (catOrder.get(b.category) ?? 999)),
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

  // ---------------------------------------------------------------- começar a operação do zero

  const RESET_TABLES = ['cancellations', 'kitchen_tickets', 'order_items', 'orders', 'tabs', 'audit_log'];

  /** Validações da limpeza dos dados de teste (antes do backup). Uso único, salvo ALLOW_RESET=1. */
  function checkReset(actor, { pin, confirm } = {}) {
    if (actor.role !== 'dono') throw new HttpError(403, 'FORBIDDEN', 'Somente o Proprietário pode zerar os dados.');
    if (String(confirm || '').trim().toUpperCase() !== 'ZERAR') {
      throw new HttpError(400, 'CONFIRM_REQUIRED', 'Digite ZERAR para confirmar.');
    }
    if (!auth.verifyPinForRole('dono', pin)) {
      db.transaction(() => audit.log(actor, 'system.reset_denied', 'database', null, { motivo: 'PIN do Proprietário incorreto' }))();
      throw new HttpError(403, 'OWNER_PIN_REQUIRED', 'PIN do Proprietário incorreto.');
    }
    if (q.getSetting.get('operation_started_at') && process.env.ALLOW_RESET !== '1') {
      throw new HttpError(409, 'ALREADY_RESET', 'Os dados de teste já foram apagados e a operação já começou. Os dados reais ficam protegidos.');
    }
  }

  /**
   * Apaga pedidos, contas, cancelamentos, tempos da cozinha e a auditoria (dados de teste) e começa uma
   * auditoria nova. Mantém cardápio, seções, configurações, PINs e sessões. O backup é feito ANTES (rota).
   */
  function resetOperationalData(actor, { backupName }) {
    const counts = Object.fromEntries(RESET_TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()]));
    const resetId = crypto.randomUUID();
    const now = nowIso();
    db.transaction(() => {
      // Os gatilhos de proteção são removidos só durante esta transação e recriados idênticos em seguida.
      const triggers = db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${RESET_TABLES.map(() => '?').join(', ')})`)
        .all(...RESET_TABLES);
      for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
      for (const table of RESET_TABLES) db.exec(`DELETE FROM ${table}`);
      db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_log'");
      for (const t of triggers) db.exec(t.sql);
      counts.itensArquivadosRemovidos = db.prepare('DELETE FROM menu_items WHERE archived = 1').run().changes;
      q.setSetting.run('operation_started_at', now);
      q.setSetting.run('reset_id', resetId);
      audit.log(actor, 'system.reset', 'database', null, {
        acao: 'Dados de teste apagados; início da operação',
        backupAntes: backupName,
        removidos: counts,
      });
    })();
    emit('settings:changed', settings());
    emit('system:reset', { resetId, at: now });
    return { resetId, at: now, removed: counts, backup: backupName };
  }

  return {
    checkReset,
    resetOperationalData,
    report,
    categories,
    createCategory,
    updateCategory,
    deleteCategory,
    moveCategory,
    moveMenuItem,
    removeMenuItem,
    settings,
    menu,
    state,
    getTab,
    getOrder,
    loadOrders,
    createOrder,
    setTicketStatus,
    fireTicket,
    postponeTicket,
    runScheduler,
    cancelItem,
    requestBill,
    setService,
    getBill,
    closeTab,
    reopenTab,
    createMenuItem,
    updateMenuItem,
    updateSettings,
    history,
  };
}
