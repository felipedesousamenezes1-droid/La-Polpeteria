/**
 * Fila de saída (outbox) de pedidos — núcleo sem dependência de navegador.
 *
 * Garantias:
 *  1. O pedido é gravado no armazenamento local ANTES de qualquer tentativa de envio.
 *  2. O UUID é gerado no aparelho; reenvios do mesmo pedido nunca duplicam no servidor.
 *  3. Falhas de rede mantêm o pedido "pendente" e ele é reenviado sozinho (backoff + reconexão).
 *  4. Só vira "enviado" quando o servidor confirma a gravação.
 *  5. Recusas definitivas (ex.: conta já fechada) ficam visíveis como "recusado", nunca somem.
 *
 * storage: { getAll(): Promise<Entry[]>, put(entry): Promise<void>, delete(id): Promise<void> }
 * send(payload): Promise<{ ok: true, order, duplicate } | { ok: false, retryable, code, message, authRequired? }>
 *   — se lançar exceção, é tratado como falha de rede (o pedido pode ou não ter chegado; reenviar é seguro).
 */
export function createOutbox({
  storage,
  send,
  canSend = () => true,
  onChange = () => {},
  onSent = () => {},
  onRejected = () => {},
  now = () => Date.now(),
  backoff = [1000, 2000, 4000, 8000, 15000, 30000],
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  const entries = new Map();
  let flushing = null;
  let rerun = false;
  let timer = null;
  let failures = 0;

  function snapshot() {
    const list = [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
    return {
      list,
      pending: list.filter((e) => e.status === 'pending').length,
      rejected: list.filter((e) => e.status === 'rejected').length,
    };
  }

  const notify = () => onChange(snapshot());

  async function save(entry) {
    await storage.put(entry);
    entries.set(entry.id, entry);
    notify();
    return entry;
  }

  async function init() {
    const all = await storage.getAll();
    for (const e of all) entries.set(e.id, e);
    notify();
  }

  /** Grava localmente e dispara o envio. Lança erro se nem o armazenamento local funcionar. */
  async function enqueue(order) {
    const entry = {
      ...order,
      status: 'pending',
      attempts: 0,
      createdAt: now(),
      lastError: null,
    };
    await save(entry);
    flush();
    return entry;
  }

  function flush() {
    if (flushing) {
      rerun = true;
      return flushing;
    }
    flushing = (async () => {
      try {
        do {
          rerun = false;
          await runOnce();
        } while (rerun);
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  async function runOnce() {
    if (!canSend()) return;
    const pending = snapshot().list.filter((e) => e.status === 'pending');
    for (const entry of pending) {
      const current = entries.get(entry.id);
      if (!current || current.status !== 'pending') continue;
      let result;
      try {
        result = await send(payloadOf(current));
      } catch (err) {
        await save({
          ...current,
          attempts: current.attempts + 1,
          lastAttemptAt: now(),
          lastError: { code: 'NETWORK', message: err?.message || 'Sem conexão com o servidor' },
        });
        scheduleRetry();
        return; // sem rede: não adianta tentar os próximos agora
      }
      if (result?.ok) {
        failures = 0;
        const sent = await save({
          ...current,
          status: 'sent',
          attempts: current.attempts + 1,
          sentAt: now(),
          lastError: null,
          duplicate: !!result.duplicate,
          server: result.order ? { seq: result.order.seq, tabId: result.order.tabId, receivedAt: result.order.receivedAt } : null,
        });
        onSent(sent, result);
        continue;
      }
      if (result?.retryable) {
        await save({
          ...current,
          attempts: current.attempts + 1,
          lastAttemptAt: now(),
          lastError: { code: result.code, message: result.message, authRequired: !!result.authRequired },
        });
        if (!result.authRequired) scheduleRetry();
        return;
      }
      const rejected = await save({
        ...current,
        status: 'rejected',
        attempts: current.attempts + 1,
        lastAttemptAt: now(),
        lastError: { code: result?.code || 'REJECTED', message: result?.message || 'Pedido recusado pelo servidor' },
      });
      onRejected(rejected);
    }
  }

  function scheduleRetry() {
    if (timer) return;
    const delay = backoff[Math.min(failures, backoff.length - 1)];
    failures++;
    timer = setTimer(() => {
      timer = null;
      flush();
    }, delay);
  }

  /** Reconexão detectada: tenta imediatamente, zerando o backoff. */
  function retryNow() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    failures = 0;
    return flush();
  }

  /** Reenvia um pedido recusado; opcionalmente para uma NOVA conta da mesa (a anterior foi fechada). */
  async function resendRejected(id, { asNewTab = false } = {}) {
    const e = entries.get(id);
    if (!e || e.status !== 'rejected') return;
    await save({ ...e, status: 'pending', tabId: asNewTab ? null : e.tabId, lastError: null });
    return flush();
  }

  /** Descarta um pedido que NUNCA chegou ao servidor (fica marcado, não é apagado). */
  async function discard(id) {
    const e = entries.get(id);
    if (!e || e.status !== 'rejected') return;
    await save({ ...e, status: 'discarded', discardedAt: now() });
  }

  /** Remove do aparelho os registros que satisfazem o critério (ex.: criados antes de apagar os dados de teste). */
  async function purgeWhere(predicate) {
    for (const e of [...entries.values()]) {
      if (predicate(e)) {
        await storage.delete(e.id);
        entries.delete(e.id);
      }
    }
    notify();
  }

  /** Limpa do aparelho registros já confirmados pelo servidor há mais de maxAgeMs. */
  async function prune(maxAgeMs = 24 * 3600_000) {
    const limit = now() - maxAgeMs;
    for (const e of [...entries.values()]) {
      const done = e.status === 'sent' ? e.sentAt : e.status === 'discarded' ? e.discardedAt : null;
      if (done && done < limit) {
        await storage.delete(e.id);
        entries.delete(e.id);
      }
    }
    notify();
  }

  return {
    init,
    enqueue,
    flush,
    retryNow,
    resendRejected,
    discard,
    prune,
    purgeWhere,
    snapshot,
    get: (id) => entries.get(id),
    isRetryScheduled: () => !!timer,
  };
}

/**
 * Envio HTTP de um pedido e classificação da resposta (mesmo código no navegador e nos testes).
 * - exceção (rede caiu, timeout, resposta cortada) => o outbox trata como falha de rede e reenvia;
 * - 2xx => confirmado (201 criado, 200 reenvio reconhecido como duplicata);
 * - 401/403 => aguarda novo login, sem descartar;
 * - 5xx/429/408 => tenta de novo;
 * - demais 4xx => recusa definitiva, visível ao garçom.
 */
export function createHttpSender({ baseUrl = '', getToken, fetchImpl = (...a) => fetch(...a), timeoutMs = 8000, onUnauthorized = () => {} }) {
  return async function send(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() || ''}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        if (res.ok) throw new Error('Resposta incompleta do servidor');
      }
      if (res.ok) return { ok: true, order: data.order, duplicate: !!data.duplicate };
      const code = data?.error || `HTTP_${res.status}`;
      const message = data?.message || `Erro ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        if (res.status === 401) onUnauthorized();
        return { ok: false, retryable: true, authRequired: true, code, message: 'Entre com o PIN de Garçom para enviar' };
      }
      if (res.status >= 500 || res.status === 429 || res.status === 408) return { ok: false, retryable: true, code, message };
      return { ok: false, retryable: false, code, message };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Conteúdo enviado ao servidor — determinístico, para que reenvios sejam idênticos. */
export function payloadOf(entry) {
  return {
    id: entry.id,
    tableNumber: entry.tableNumber,
    tabId: entry.tabId ?? null,
    clientCreatedAt: entry.clientCreatedAt ?? null,
    items: entry.items.map((i) => ({
      menuItemId: i.menuItemId,
      qty: i.qty,
      notes: i.notes || '',
      components: (i.components || []).map((c) => (typeof c === 'object' ? c.menuItemId : c)),
    })),
  };
}

/** Armazenamento em memória (testes). */
export function memoryStorage() {
  const map = new Map();
  return {
    kind: 'memory',
    getAll: async () => [...map.values()].map((e) => structuredClone(e)),
    put: async (e) => void map.set(e.id, structuredClone(e)),
    delete: async (id) => void map.delete(id),
    _map: map,
  };
}
