/** Situação de cada mesa, combinando servidor (contas/pedidos) e aparelho (fila offline/rascunhos). */
export function computeTableInfo(s) {
  const info = new Map();
  const get = (n) => {
    if (!info.has(n)) info.set(n, { tab: null, ready: 0, inKitchen: 0, pending: 0, rejected: 0, draft: 0 });
    return info.get(n);
  };
  const activeTabIds = new Set();
  for (const t of Object.values(s.tabs)) {
    if (t.status === 'closed') continue;
    get(t.tableNumber).tab = t;
    activeTabIds.add(t.id);
  }
  for (const o of Object.values(s.orders)) {
    if (!activeTabIds.has(o.tabId) || o.fullyCancelled) continue;
    if (o.status === 'pronto') get(o.tableNumber).ready++;
    if (o.status === 'novo' || o.status === 'preparando') get(o.tableNumber).inKitchen++;
  }
  for (const e of s.outbox.list) {
    if (e.status === 'pending') get(e.tableNumber).pending++;
    if (e.status === 'rejected') get(e.tableNumber).rejected++;
  }
  for (const [n, lines] of Object.entries(s.drafts)) {
    get(Number(n)).draft = lines.reduce((a, l) => a + l.qty, 0);
  }
  return info;
}

export function tableState(i) {
  if (!i) return 'livre';
  if (i.ready > 0) return 'pronto';
  if (i.tab?.status === 'billing') return 'conta';
  if (i.tab || i.pending > 0) return 'ocupada';
  return 'livre';
}
