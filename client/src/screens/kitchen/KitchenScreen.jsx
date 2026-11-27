import { useEffect, useMemo, useState } from 'react';
import { useAppState, actions, on, toast } from '../../lib/store.js';
import { playNewOrder, unlockAudio, audioReady } from '../../lib/sound.js';
import { elapsed, time } from '../../lib/util.js';
import { Icon, useNow, ComboParts } from '../../components/ui.jsx';

const COLUMNS = [
  { key: 'novo', title: 'Novo', head: 'bg-pomodoro-600 text-white', action: 'Iniciar preparo', next: 'preparando' },
  { key: 'preparando', title: 'Preparando', head: 'bg-oro-400 text-inchiostro', action: 'Marcar como pronto', next: 'pronto' },
  { key: 'pronto', title: 'Pronto', head: 'bg-basilico-700 text-white', action: 'Entregue pelo garçom', next: 'entregue' },
];
const PREV = { preparando: 'novo', pronto: 'preparando' };
const CANCELLED_VISIBLE_MS = 2 * 60_000;

function useWakeLock() {
  useEffect(() => {
    let lock = null;
    const request = async () => {
      try {
        if (document.visibilityState === 'visible' && navigator.wakeLock) lock = await navigator.wakeLock.request('screen');
      } catch {
        /* sem suporte ou negado */
      }
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      document.removeEventListener('visibilitychange', request);
      lock?.release?.();
    };
  }, []);
}

function TicketCard({ order, ticket, column, serverNow, settings, flash }) {
  const [busy, setBusy] = useState(false);
  const age = serverNow - new Date(ticket.firedAt || order.receivedAt).getTime();
  const sinceStatus = serverNow - new Date(ticket.statusChangedAt).getTime();
  const late = column.key !== 'pronto' && age >= settings.lateMinutes * 60_000;
  const warn = column.key !== 'pronto' && !late && age >= settings.warnMinutes * 60_000;
  const tone = ticket.fullyCancelled
    ? 'border-pomodoro-600 bg-pomodoro-50'
    : late
      ? 'border-pomodoro-600 bg-pomodoro-100'
      : warn
        ? 'border-oro-500 bg-oro-200'
        : 'border-crema-300 bg-white';
  const waiting = order.tickets.filter((t) => t.status === 'aguardando' && !t.fullyCancelled).map((t) => t.label);

  async function move(to) {
    if (busy) return;
    setBusy(true);
    try {
      await actions.setTicketStatus(ticket, to);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`overflow-hidden rounded-2xl border-[3px] shadow-sm ${tone} ${flash ? 'flash-new' : ''}`} data-testid={`card-${ticket.id}`} data-status={ticket.status}>
      <button className="block w-full p-4 text-left disabled:opacity-70" onClick={() => !ticket.fullyCancelled && move(column.next)} disabled={busy || ticket.fullyCancelled}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-serif text-4xl leading-none font-bold">Mesa {order.tableNumber}</p>
            <p className="mt-1 text-base text-seppia">
              #{order.seq} · {time(ticket.firedAt || order.receivedAt)}
              {order.createdBy.name ? ` · ${order.createdBy.name}` : ''}
            </p>
          </div>
          <div className={`text-right ${late ? 'text-pomodoro-700' : warn ? 'text-oro-700' : 'text-inchiostro'}`}>
            <p className="text-3xl font-bold tabular-nums">{elapsed(column.key === 'pronto' ? sinceStatus : age)}</p>
            <p className="text-xs font-bold uppercase">{column.key === 'pronto' ? 'pronto há' : late ? 'atrasado' : warn ? 'atenção' : 'desde o envio'}</p>
          </div>
        </div>
        {ticket.tempos > 1 && (
          <p className="mt-2 inline-block rounded-full bg-inchiostro px-3 py-1 text-base font-bold text-white uppercase">
            {ticket.label} · tempo {ticket.tempo} de {ticket.tempos}
          </p>
        )}
        {ticket.fullyCancelled && <p className="mt-3 rounded-lg bg-pomodoro-600 px-3 py-2 text-center text-2xl font-bold text-white">CANCELADO</p>}
        <ul className="mt-3 space-y-2">
          {ticket.lines.map((l, idx) => (
            <li key={`${l.itemId}-${idx}`}>
              <p className={`text-2xl leading-snug ${l.qty === 0 ? 'text-seppia line-through' : ''}`}>
                <span className="font-bold">{l.qty || l.sentQty}×</span> {l.name}
                {l.fromCombo && <span className="ml-2 text-base font-semibold text-oro-700">({l.fromCombo})</span>}
              </p>
              {l.qty > 0 && <ComboParts components={l.components} className="ml-8 text-xl leading-snug" />}
              {l.notes && l.qty > 0 && (
                <p className="mt-1 inline-block rounded-lg bg-pomodoro-600 px-3 py-1 text-xl font-bold text-white uppercase">
                  <Icon name="alert" className="mr-1 -mt-1 inline h-5 w-5" />
                  {l.notes}
                </p>
              )}
              {l.cancelledQty > 0 && (
                <p className="mt-1 text-lg font-bold text-pomodoro-700 uppercase">
                  {l.cancelledQty} cancelado{l.cancelledQty > 1 ? 's' : ''}
                  {l.lastCancelReason ? ` — ${l.lastCancelReason}` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
        {waiting.length > 0 && column.key !== 'pronto' && (
          <p className="mt-3 text-sm font-semibold text-seppia">Depois, aguardando o garçom: {waiting.join(', ')}</p>
        )}
        {!ticket.fullyCancelled && (
          <span className={`mt-4 flex min-h-14 items-center justify-center rounded-xl text-lg font-bold ${column.head}`}>{busy ? 'Atualizando…' : `${column.action} →`}</span>
        )}
      </button>
      {PREV[column.key] && !ticket.fullyCancelled && (
        <div className="border-t border-crema-300 px-4 py-1">
          <button className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-seppia" onClick={() => move(PREV[column.key])} disabled={busy}>
            <Icon name="undo" className="h-4 w-4" /> Voltar para {COLUMNS.find((c) => c.key === PREV[column.key]).title}
          </button>
        </div>
      )}
    </article>
  );
}

export default function KitchenScreen() {
  const s = useAppState();
  const now = useNow(1000);
  const serverNow = now + s.serverOffset;
  const [flash, setFlash] = useState(() => new Set());
  const [soundOk, setSoundOk] = useState(audioReady());
  useWakeLock();

  useEffect(
    () =>
      on('ticket:new', ({ ticket }) => {
        playNewOrder();
        setFlash((f) => new Set(f).add(ticket.id));
        setTimeout(() => setFlash((f) => {
          const n = new Set(f);
          n.delete(ticket.id);
          return n;
        }), 3500);
      }),
    [],
  );
  useEffect(() => {
    const t = setInterval(() => setSoundOk(audioReady()), 1000);
    return () => clearInterval(t);
  }, []);

  const columns = useMemo(() => {
    const by = { novo: [], preparando: [], pronto: [] };
    // Só comida (tempos da cozinha); bebidas não aparecem aqui.
    for (const o of Object.values(s.orders)) {
      for (const t of o.tickets || []) {
        if (!by[t.status]) continue;
        if (t.fullyCancelled && serverNow - new Date(t.lastCancelledAt).getTime() > CANCELLED_VISIBLE_MS) continue;
        by[t.status].push({ order: o, ticket: t });
      }
    }
    const at = (x) => x.ticket.firedAt || x.order.receivedAt;
    for (const k of Object.keys(by)) by[k].sort((a, b) => at(a).localeCompare(at(b)));
    return by;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.orders, Math.floor(serverNow / 10_000)]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-crema-200">
      {!soundOk && (
        <button className="btn-gold m-2 min-h-14 text-lg" onClick={() => { unlockAudio(); setSoundOk(audioReady()); }}>
          <Icon name="sound" /> Toque aqui para ativar o som de novos pedidos
        </button>
      )}
      <div className="grid min-h-0 flex-1 auto-cols-[minmax(300px,1fr)] grid-flow-col gap-3 overflow-x-auto p-3 md:grid-flow-row md:grid-cols-3 md:overflow-x-visible">
        {COLUMNS.map((col) => (
          <section key={col.key} className="flex min-h-0 flex-col rounded-2xl bg-crema-100 shadow-inner" data-testid={`coluna-${col.key}`}>
            <header className={`flex items-center justify-between rounded-t-2xl px-4 py-3 ${col.head}`}>
              <h2 className="font-serif text-2xl font-bold">{col.title}</h2>
              <span className="rounded-full bg-white/90 px-3 py-0.5 text-xl font-bold text-inchiostro tabular-nums">{columns[col.key].length}</span>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto p-3">
              {columns[col.key].map(({ order, ticket }) => (
                <TicketCard key={ticket.id} order={order} ticket={ticket} column={col} serverNow={serverNow} settings={s.settings} flash={flash.has(ticket.id)} />
              ))}
              {!columns[col.key].length && <p className="py-8 text-center text-lg text-seppia">Nenhum pedido</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
