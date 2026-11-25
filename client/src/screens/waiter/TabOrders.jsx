import { useMemo, useState } from 'react';
import { ORDER_STATUS_LABELS, CANCEL_REASONS, ROLE_LABELS } from '../../../../shared/constants.js';
import { useAppState, actions, outboxActions, toast } from '../../lib/store.js';
import { money, time, uuid } from '../../lib/util.js';
import { ConfirmDialog, Icon, Modal, QtyStepper, EmptyState } from '../../components/ui.jsx';

const STATUS_CHIP = {
  novo: 'bg-pomodoro-100 text-pomodoro-800',
  preparando: 'bg-oro-200 text-oro-700',
  pronto: 'bg-oro-400 text-inchiostro',
  entregue: 'bg-basilico-100 text-basilico-800',
};

export function CancelDialog({ item, order, onClose }) {
  const [qty, setQty] = useState(item.activeQty);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Mesmo id em todas as tentativas: se a rede cair no meio, o reenvio não cancela em dobro.
  const [cancellationId] = useState(() => uuid());

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      await actions.cancelItem(item.id, { cancellationId, qty, reason });
      toast(`Cancelado: ${qty}× ${item.name} (registrado no histórico)`, 'ok');
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Cancelar item"
      tone="danger"
      size="sm"
      footer={
        <>
          <button className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
            Voltar
          </button>
          <button className="btn-danger flex-1" onClick={confirm} disabled={busy || reason.trim().length < 3} data-testid="confirmar-cancelamento">
            {busy ? 'Cancelando…' : 'Confirmar cancelamento'}
          </button>
        </>
      }
    >
      <p className="font-semibold">
        Mesa {order.tableNumber} · Pedido #{order.seq}
      </p>
      <p className="mt-1 text-lg">{item.name}</p>
      {item.activeQty > 1 && (
        <div className="mt-3 flex items-center justify-between">
          <span className="font-semibold">Quantidade a cancelar</span>
          <QtyStepper value={qty} onChange={setQty} min={1} max={item.activeQty} />
        </div>
      )}
      <p className="label mt-4">Motivo (obrigatório)</p>
      <div className="flex flex-wrap gap-2">
        {CANCEL_REASONS.map((r) => (
          <button key={r} onClick={() => setReason(r)} className={`chip !min-h-11 ${reason === r ? 'border-pomodoro-600 bg-pomodoro-600 text-white' : 'border-crema-300 bg-white'}`}>
            {r}
          </button>
        ))}
      </div>
      <input className="input mt-2" placeholder="Ou descreva o motivo…" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      <p className="mt-3 text-sm text-seppia">
        O item não é apagado: fica registrado como cancelado, com motivo, horário e perfil, e sai do total da conta.
      </p>
      {error && <p className="mt-2 font-semibold text-pomodoro-700" role="alert">{error}</p>}
    </Modal>
  );
}

function LocalEntry({ entry }) {
  const [busy, setBusy] = useState(false);
  const rejected = entry.status === 'rejected';
  const tabClosed = entry.lastError?.code === 'TAB_CLOSED' || entry.lastError?.code === 'TAB_NOT_FOUND';
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`card border-2 p-3 ${rejected ? 'border-pomodoro-600 bg-pomodoro-50' : 'border-oro-400 bg-oro-100'}`} data-testid="pedido-local">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-sm font-bold ${rejected ? 'bg-pomodoro-600 text-white' : 'bg-oro-400 text-inchiostro'}`}>
          {rejected ? 'Recusado' : 'Pendente'}
        </span>
        <span className="text-sm text-seppia">salvo no aparelho às {time(new Date(entry.createdAt).toISOString())}</span>
      </div>
      <ul className="mt-2 space-y-1">
        {entry.items.map((i, idx) => (
          <li key={idx}>
            <span className="font-semibold">{i.qty}×</span> {i.name}
            {i.notes && <span className="ml-1 text-sm font-semibold text-pomodoro-700">({i.notes})</span>}
          </li>
        ))}
      </ul>
      {rejected ? (
        <>
          <p className="mt-2 text-sm font-semibold text-pomodoro-800">{entry.lastError?.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {tabClosed ? (
              <button className="btn-primary" disabled={busy} onClick={() => run(() => outboxActions.resend(entry.id, { asNewTab: true }))}>
                Enviar para nova conta da mesa
              </button>
            ) : (
              <button className="btn-primary" disabled={busy} onClick={() => run(() => outboxActions.resend(entry.id))}>
                Tentar novamente
              </button>
            )}
            <DiscardButton entry={entry} />
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-seppia">
          {entry.lastError ? `Última tentativa: ${entry.lastError.message}. ` : ''}Será enviado automaticamente quando a conexão voltar.
        </p>
      )}
    </li>
  );
}

function DiscardButton({ entry }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-ghost" onClick={() => setOpen(true)}>
        Descartar
      </button>
      <ConfirmDialog
        open={open}
        danger
        title="Descartar pedido não enviado?"
        message="Este pedido nunca chegou à cozinha nem à conta. Ele será marcado como descartado neste aparelho."
        confirmLabel="Descartar"
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          await outboxActions.discard(entry.id);
          setOpen(false);
        }}
      />
    </>
  );
}

export default function TabOrders({ table, tab, onBack }) {
  const s = useAppState();
  const [cancelling, setCancelling] = useState(null);
  const [confirmBill, setConfirmBill] = useState(false);
  const [busy, setBusy] = useState(false);

  const orders = useMemo(
    () => (tab ? Object.values(s.orders).filter((o) => o.tabId === tab.id).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)) : []),
    [s.orders, tab],
  );
  const local = s.outbox.list.filter((e) => e.tableNumber === table && (e.status === 'pending' || e.status === 'rejected'));

  async function markPicked(order) {
    try {
      await actions.setOrderStatus(order, 'entregue');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function requestBill() {
    setBusy(true);
    try {
      await actions.requestBill(tab.id);
      toast(`Mesa ${table}: conta enviada ao caixa`, 'ok');
      setConfirmBill(false);
      onBack();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!orders.length && !local.length) {
    return (
      <div className="flex-1 overflow-y-auto">
        <EmptyState title="Nenhum pedido nesta mesa">Use o cardápio para lançar o primeiro pedido.</EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex-1 space-y-3 overflow-y-auto p-3">
        {local.map((e) => (
          <LocalEntry key={e.id} entry={e} />
        ))}
        {orders.map((o) => (
          <li key={o.id} className={`card p-3 ${o.fullyCancelled ? 'opacity-60' : ''}`} data-testid="pedido-enviado">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-serif text-lg font-bold">#{o.seq}</span>
              <span className="text-sm text-seppia">
                {time(o.receivedAt)} · {ROLE_LABELS[o.createdBy.role]}
                {o.createdBy.name ? ` (${o.createdBy.name})` : ''}
              </span>
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-basilico-100 px-2 py-0.5 text-xs font-bold text-basilico-800">
                Enviado ✓
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_CHIP[o.status]}`}>{o.fullyCancelled ? 'Cancelado' : ORDER_STATUS_LABELS[o.status]}</span>
            </div>
            <ul className="mt-2 divide-y divide-crema-200">
              {o.items.map((i) => (
                <li key={i.id} className="flex items-center gap-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className={i.activeQty === 0 ? 'text-seppia line-through' : ''}>
                      <span className="font-semibold">{i.activeQty || i.qty}×</span> {i.name}
                      <span className="ml-1 text-sm text-seppia tabular-nums">{money(i.unitPriceCents * i.activeQty)}</span>
                    </p>
                    {i.notes && <p className="text-sm font-semibold text-pomodoro-700">Obs.: {i.notes}</p>}
                    {i.cancelledQty > 0 && (
                      <p className="text-xs font-semibold text-pomodoro-700">
                        {i.cancelledQty} cancelado(s): {i.cancellations.map((c) => c.reason).join('; ')}
                      </p>
                    )}
                  </div>
                  {i.activeQty > 0 && tab?.status !== 'closed' && (
                    <button className="btn-ghost !min-h-11 !px-3 text-pomodoro-700" onClick={() => setCancelling({ item: i, order: o })} aria-label={`Cancelar ${i.name}`}>
                      <Icon name="trash" className="h-5 w-5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {o.status === 'pronto' && !o.fullyCancelled && (
              <button className="btn-gold mt-2 w-full" onClick={() => markPicked(o)}>
                <Icon name="check" /> Retirei / entregue na mesa
              </button>
            )}
          </li>
        ))}
      </ul>
      {tab && (
        <div className="border-t-2 border-crema-300 bg-crema-50 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-semibold text-seppia">Total da mesa</span>
            <span className="font-serif text-2xl font-bold tabular-nums">{money(tab.totalCents)}</span>
          </div>
          {tab.status === 'billing' ? (
            <p className="rounded-xl bg-pomodoro-50 p-3 text-center font-semibold text-pomodoro-800">Conta pedida às {time(tab.billRequestedAt)} · aguardando o caixa</p>
          ) : (
            <button className="btn-danger min-h-14 w-full text-lg" onClick={() => setConfirmBill(true)} data-testid="fechar-mesa">
              Fechar mesa (enviar conta ao caixa)
            </button>
          )}
        </div>
      )}
      {cancelling && <CancelDialog item={cancelling.item} order={cancelling.order} onClose={() => setCancelling(null)} />}
      <ConfirmDialog
        open={confirmBill}
        title={`Fechar a mesa ${table}?`}
        message={`A conta (${money(tab?.totalCents)}) será enviada ao caixa. Se o cliente pedir mais alguma coisa, basta lançar normalmente.`}
        confirmLabel="Enviar ao caixa"
        busy={busy}
        onCancel={() => setConfirmBill(false)}
        onConfirm={requestBill}
      />
    </div>
  );
}
