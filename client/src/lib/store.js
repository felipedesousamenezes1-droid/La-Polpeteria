import { useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';
import { createOutbox, createHttpSender } from './outbox-core.js';
import { createDeviceStorage } from './outbox-storage.js';
import { uuid } from './util.js';
import { playAlert } from './sound.js';

const SESSION_KEY = 'polpeteria.session';
const DEVICE_KEY = 'polpeteria.deviceId';
const DRAFTS_KEY = 'polpeteria.drafts';
const SCREEN_KEY = 'polpeteria.screen';
const CACHE_KEY = 'polpeteria.cache';
export const NAME_KEY = 'polpeteria.lastName';

function readJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* armazenamento cheio ou bloqueado */
  }
}

export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// ------------------------------------------------------------------ estado

let state = {
  session: readJson(SESSION_KEY, null),
  screen: localStorage.getItem(SCREEN_KEY) || null,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  connected: false,
  loaded: false,
  rev: 0,
  today: null,
  settings: { tableCount: 20, warnMinutes: 10, lateMinutes: 20 },
  menu: [],
  categories: [],
  tabs: {},
  orders: {},
  serverOffset: 0,
  outbox: { list: [], pending: 0, rejected: 0 },
  storageKind: null,
  drafts: readJson(DRAFTS_KEY, {}),
  toasts: [],
  readyAlerts: [],
};

const listeners = new Set();
export const getState = () => state;
function set(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export function useAppState() {
  return useSyncExternalStore(subscribe, getState);
}

// Barramento de eventos para efeitos (sons, alertas)
const bus = new EventTarget();
export function on(event, handler) {
  const h = (e) => handler(e.detail);
  bus.addEventListener(event, h);
  return () => bus.removeEventListener(event, h);
}
function fire(event, detail) {
  bus.dispatchEvent(new CustomEvent(event, { detail }));
}

// ------------------------------------------------------------------ avisos

export function toast(message, kind = 'info', ms = 3500) {
  const id = uuid();
  set((s) => ({ toasts: [...s.toasts, { id, message, kind }].slice(-4) }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
export function dismissToast(id) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ------------------------------------------------------------------ API HTTP

export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}
export class NetworkError extends Error {}

export async function api(path, { method = 'GET', body, timeout = 10000 } = {}) {
  const token = state.session?.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch {
      throw new NetworkError(navigator.onLine ? 'Servidor inacessível' : 'Aparelho sem conexão');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // Resposta cortada no meio: não sabemos se gravou. Tratar como falha de rede (reenvio é seguro).
      if (res.ok) throw new NetworkError('Resposta incompleta do servidor');
    }
    if (!res.ok) {
      if (res.status === 401 && path !== '/api/login') handleUnauthorized();
      throw new ApiError(res.status, data?.error || `HTTP_${res.status}`, data?.message || `Erro ${res.status}`, data);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ dados versionados

function applyEntity(collection, entity, rev) {
  const prev = state[collection][entity.id];
  if (prev && (prev._rev ?? 0) > rev) return prev;
  const next = { ...entity, _rev: rev };
  set((s) => ({ [collection]: { ...s[collection], [entity.id]: next } }));
  return next;
}

/** Avisos por tempo da cozinha: chegou na cozinha (som) / ficou pronto (alerta ao garçom). */
function detectOrderTransition(prev, next) {
  if (!state.loaded) return;
  for (const t of next.tickets || []) {
    const pt = prev?.tickets?.find((x) => x.id === t.id);
    const arrived = t.status === 'novo' && !t.fullyCancelled && (!pt || pt.status === 'aguardando');
    if (arrived) fire('ticket:new', { order: next, ticket: t });
    if (pt && pt.status !== 'pronto' && t.status === 'pronto') fire('ticket:ready', { order: next, ticket: t });
  }
}

export function applyOrder(order, rev = 0) {
  const prev = state.orders[order.id];
  if (prev && (prev._rev ?? 0) > rev) return;
  applyEntity('orders', order, rev);
  detectOrderTransition(prev, order);
}
export function applyTab(tab, rev = 0) {
  applyEntity('tabs', tab, rev);
}

function mergeSnapshot(collection, list, rev) {
  const current = state[collection];
  const merged = {};
  for (const e of list) {
    const prev = current[e.id];
    merged[e.id] = prev && (prev._rev ?? 0) > rev ? prev : { ...e, _rev: rev };
  }
  // Mantém o que chegou por evento depois do instantâneo.
  for (const [id, e] of Object.entries(current)) if (!merged[id] && (e._rev ?? 0) > rev) merged[id] = e;
  return merged;
}

/** Último estado conhecido, para o app abrir e aceitar pedidos mesmo sem rede. */
function saveCache() {
  const activeTabs = Object.values(state.tabs).filter((t) => t.status !== 'closed');
  const ids = new Set(activeTabs.map((t) => t.id));
  writeJson(CACHE_KEY, {
    rev: state.rev,
    today: state.today,
    settings: state.settings,
    menu: state.menu,
    categories: state.categories,
    tabs: activeTabs,
    orders: Object.values(state.orders).filter((o) => ids.has(o.tabId)),
    savedAt: Date.now(),
  });
}

function hydrateFromCache() {
  const c = readJson(CACHE_KEY, null);
  if (!c || !state.session) return;
  const byId = (list) => Object.fromEntries(list.map((e) => [e.id, { ...e, _rev: 0 }]));
  set({ loaded: true, rev: 0, today: c.today, settings: c.settings, menu: c.menu, categories: c.categories || [], tabs: byId(c.tabs), orders: byId(c.orders) });
}

let refreshing = null;
export function refreshState() {
  if (!state.session) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t0 = Date.now();
    try {
      const s = await api('/api/state');
      const t1 = Date.now();
      const prevOrders = state.orders;
      const orders = mergeSnapshot('orders', s.orders, s.rev);
      const tabs = mergeSnapshot('tabs', s.tabs, s.rev);
      const wasLoaded = state.loaded;
      set({
        loaded: true,
        rev: s.rev,
        today: s.today,
        settings: s.settings,
        menu: s.menu,
        categories: s.categories,
        orders,
        tabs,
        serverOffset: new Date(s.serverTime).getTime() - (t0 + t1) / 2,
      });
      if (wasLoaded) for (const o of Object.values(orders)) detectOrderTransition(prevOrders[o.id], o);
      saveCache();
    } catch (err) {
      if (!(err instanceof NetworkError)) console.warn('Falha ao sincronizar', err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ------------------------------------------------------------------ tempo real

let socket = null;

function connectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  if (!state.session) return;
  socket = io({
    auth: { token: state.session.token },
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 6000,
  });
  socket.on('connect', () => {
    set({ connected: true });
    refreshState();
    outbox?.retryNow();
  });
  socket.on('disconnect', () => set({ connected: false }));
  socket.on('connect_error', (err) => {
    set({ connected: false });
    if (err?.message === 'unauthorized') handleUnauthorized();
  });
  socket.on('order:upsert', ({ rev, data }) => applyOrder(data, rev));
  socket.on('tab:upsert', ({ rev, data }) => applyTab(data, rev));
  socket.on('menu:changed', ({ data }) => set({ menu: data.menu, categories: data.categories }));
  socket.on('settings:changed', ({ data }) => set({ settings: data }));
  socket.on('session:revoked', () => handleUnauthorized());
}

// ------------------------------------------------------------------ fila offline

let outbox = null;
const SENDER_ROLES = ['garcom', 'caixa', 'admin', 'dono'];

async function initOutbox() {
  const storage = await createDeviceStorage();
  outbox = createOutbox({
    storage,
    send: createHttpSender({ getToken: () => state.session?.token, onUnauthorized: () => handleUnauthorized() }),
    canSend: () => !!state.session && SENDER_ROLES.includes(state.session.role),
    onChange: (snap) => set({ outbox: snap }),
    onSent: (entry, result) => {
      if (result.order) applyOrder(result.order, 0);
      toast(`Mesa ${entry.tableNumber}: pedido #${result.order?.seq ?? ''} enviado ✓`, 'ok');
    },
    onRejected: (entry) => {
      playAlert();
      toast(`Mesa ${entry.tableNumber}: pedido NÃO aceito — ${entry.lastError?.message}`, 'error', 9000);
    },
  });
  await outbox.init();
  set({ storageKind: storage.kind });
  await outbox.prune();
  outbox.flush();
}

export const outboxActions = {
  resend: (id, opts) => outbox.resendRejected(id, opts),
  discard: (id) => outbox.discard(id),
  retryNow: () => outbox.retryNow(),
};

// ------------------------------------------------------------------ sessão

export async function login(pin, name) {
  const res = await api('/api/login', { method: 'POST', body: { pin, name, deviceId: deviceId() } });
  const session = { token: res.token, role: res.role, name: res.name };
  writeJson(SESSION_KEY, session);
  if (name) localStorage.setItem(NAME_KEY, name);
  const screen = res.role === 'admin' ? 'admin' : res.role;
  localStorage.setItem(SCREEN_KEY, screen);
  set({ session, screen, loaded: false, orders: {}, tabs: {}, readyAlerts: [] });
  connectSocket();
  outbox?.retryNow();
  return session;
}

export async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* sem rede: encerra localmente mesmo assim */
  }
  clearSession();
}

function clearSession() {
  writeJson(SESSION_KEY, null);
  writeJson(CACHE_KEY, null);
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  set({ session: null, connected: false, loaded: false, orders: {}, tabs: {}, readyAlerts: [] });
}

function handleUnauthorized() {
  if (!state.session) return;
  clearSession();
  toast('Sessão encerrada. Entre novamente com o PIN. Pedidos pendentes continuam salvos neste aparelho.', 'error', 8000);
}

export function setScreen(screen) {
  localStorage.setItem(SCREEN_KEY, screen);
  set({ screen });
}

// ------------------------------------------------------------------ rascunhos (carrinho por mesa)

export function setDraft(table, lines) {
  const drafts = { ...state.drafts };
  if (lines.length) drafts[table] = lines;
  else delete drafts[table];
  writeJson(DRAFTS_KEY, drafts);
  set({ drafts });
}

/** Adiciona 1 unidade. components: escolhas do Menu Completo [{ step, menuItemId, name }]. */
export function addToDraft(table, item, components = []) {
  const lines = [...(state.drafts[table] || [])];
  const sig = components.map((c) => c.menuItemId).join(',');
  const idx = lines.findIndex((l) => l.menuItemId === item.id && !l.notes && (l.components || []).map((c) => c.menuItemId).join(',') === sig);
  if (idx >= 0) lines[idx] = { ...lines[idx], qty: Math.min(99, lines[idx].qty + 1) };
  else lines.push({ key: uuid(), menuItemId: item.id, name: item.name, category: item.category, priceCents: item.priceCents, qty: 1, notes: '', components });
  setDraft(table, lines);
}

export function activeTabFor(table) {
  return Object.values(state.tabs).find((t) => t.tableNumber === table && t.status !== 'closed') || null;
}

/** Grava o pedido no aparelho (IndexedDB) e dispara o envio. Só limpa o carrinho depois de salvo. */
export async function submitDraft(table) {
  const lines = (state.drafts[table] || []).filter((l) => l.qty > 0);
  if (!lines.length) return null;
  const tab = activeTabFor(table);
  const entry = await outbox.enqueue({
    id: uuid(),
    tableNumber: table,
    tabId: tab?.id ?? null,
    clientCreatedAt: new Date().toISOString(),
    createdByName: state.session?.name ?? null,
    items: lines.map((l) => ({
      menuItemId: l.menuItemId,
      qty: l.qty,
      notes: l.notes || '',
      components: l.components || [],
      name: l.name,
      priceCents: l.priceCents,
      category: l.category,
    })),
  });
  setDraft(table, []);
  return entry;
}

// ------------------------------------------------------------------ ações online

export const actions = {
  /** Andamento de um tempo da cozinha (Novo → Preparando → Pronto → Entregue). */
  async setTicketStatus(ticket, to) {
    const r = await api(`/api/tickets/${encodeURIComponent(ticket.id)}/status`, { method: 'POST', body: { from: ticket.status, to } });
    applyOrder(r.order, 0);
    return r.order;
  },
  /** Garçom libera um tempo que estava aguardando (prato principal, sobremesa). */
  async fireTicket(ticket) {
    const r = await api(`/api/tickets/${encodeURIComponent(ticket.id)}/fire`, { method: 'POST' });
    applyOrder(r.order, 0);
    return r.order;
  },
  /** Exceção opcional: adiar um tempo que ainda aguarda. */
  async postponeTicket(ticket, minutes = 10) {
    const r = await api(`/api/tickets/${encodeURIComponent(ticket.id)}/postpone`, { method: 'POST', body: { minutes } });
    applyOrder(r.order, 0);
    return r.order;
  },
  /** Incluir ou retirar a taxa de serviço da conta. */
  setService: (tabId, enabled) => api(`/api/tabs/${tabId}/service`, { method: 'POST', body: { enabled } }).then((r) => applyTab(r.tab, 0)),
  async cancelItem(itemId, { cancellationId, qty, reason }) {
    const r = await api(`/api/items/${itemId}/cancel`, { method: 'POST', body: { cancellationId, qty, reason } });
    applyOrder(r.order, 0);
    return r;
  },
  requestBill: (tabId) => api(`/api/tabs/${tabId}/request-bill`, { method: 'POST' }).then((r) => applyTab(r.tab, 0)),
  getBill: (tabId) => api(`/api/tabs/${tabId}/bill`),
  closeTab: (tabId, expectedTotalCents) => api(`/api/tabs/${tabId}/close`, { method: 'POST', body: { expectedTotalCents } }),
  reopenTab: (tabId, adminPin, reason) => api(`/api/tabs/${tabId}/reopen`, { method: 'POST', body: { adminPin, reason } }),
};

// ------------------------------------------------------------------ alertas de pedido pronto

// Alertas guardam o id do tempo da cozinha ("pedido:tempo").
export function addReadyAlert(ticketId) {
  set((s) => ({ readyAlerts: s.readyAlerts.includes(ticketId) ? s.readyAlerts : [...s.readyAlerts, ticketId] }));
}
export function dismissReadyAlert(ticketId) {
  set((s) => ({ readyAlerts: s.readyAlerts.filter((id) => id !== ticketId) }));
}

// ------------------------------------------------------------------ inicialização

export async function startApp() {
  window.addEventListener('online', () => {
    set({ online: true });
    outbox?.retryNow();
    if (socket && !socket.connected) socket.connect();
  });
  window.addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.session) return;
    if (socket && !socket.connected) socket.connect();
    refreshState();
    outbox?.retryNow();
  });
  // Rede de segurança: ressincroniza periodicamente mesmo sem eventos.
  setInterval(() => {
    if (state.session && state.connected) refreshState();
  }, 60_000);

  try {
    await initOutbox();
  } catch (err) {
    console.error(err);
    toast('Não foi possível abrir o armazenamento local deste aparelho.', 'error', 10000);
  }
  if (state.session) {
    hydrateFromCache();
    connectSocket();
  }
}
