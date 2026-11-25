import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLE_LABELS, TAB_STATUS_LABELS } from '../../../../shared/constants.js';
import { useAppState, actions, toast, ApiError } from '../../lib/store.js';
import { money, time, dateTime, splitCents } from '../../lib/util.js';
import { ConfirmDialog, EmptyState, Icon, Modal, PinPad, QtyStepper } from '../../components/ui.jsx';
import { CancelDialog } from '../waiter/TabOrders.jsx';

function billText(bill, split) {
  const lines = [
    'La Pulpeteria',
    `Mesa ${bill.tab.tableNumber} — ${new Date().toLocaleString('pt-BR')}`,
    '',
    ...bill.lines.map((l) => `${l.qty}x ${l.name}${l.notes ? ` (${l.notes})` : ''}  ${money(l.subtotalCents)}`),
    '',
    `TOTAL: ${money(bill.totalCents)}`,
  ];
  if (split > 1) {
    const parts = splitCents(bill.totalCents, split);
    lines.push(`Dividido por ${split}: ${parts.map((p) => money(p)).join(' / ')}`);
  }
  if (bill.cancelled.length) lines.push('', `Itens cancelados (não cobrados): ${bill.cancelled.length}`);
  return lines.join('\n');
}

function ReopenDialog({ tab, onClose, onDone }) {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await actions.reopenTab(tab.id, pin, reason);
      toast(`Conta da mesa ${tab.tableNumber} reaberta (registrado na auditoria)`, 'ok');
      onDone();
    } catch (e) {
      setError(e.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title={`Reabrir conta · Mesa ${tab.tableNumber}`}
      size="sm"
      footer={
        <>
          <button className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
            Voltar
          </button>
          <button className="btn-danger flex-1" onClick={submit} disabled={busy || pin.length < 4 || reason.trim().length < 3}>
            {busy ? 'Verificando…' : 'Reabrir conta'}
          </button>
        </>
      }
    >
      <p className="label">Motivo (obrigatório)</p>
      <div className="mb-2 flex flex-wrap gap-2">
        {['Correção de lançamento', 'Cliente pediu mais itens', 'Erro no fechamento'].map((r) => (
          <button key={r} className={`chip !min-h-11 ${reason === r ? 'border-pomodoro-600 bg-pomodoro-600 text-white' : 'border-crema-300 bg-white'}`} onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      <input className="input mb-4" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ou descreva o motivo…" maxLength={200} />
      <p className="mb-2 text-center font-semibold">PIN de Admin</p>
      <PinPad value={pin} onChange={setPin} onSubmit={submit} disabled={busy} />
      {error && <p className="mt-3 text-center font-semibold text-pomodoro-700" role="alert">{error}</p>}
    </Modal>
  );
}

function BillView({ tabId, onClosed }) {
  const s = useAppState();
  const tab = s.tabs[tabId];
  const [bill, setBill] = useState(null);
  const [error, setError] = useState('');
  const [split, setSplit] = useState(1);
  const [splitOpen, setSplitOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [busy, setBusy] = useState(false);

  // Recarrega a conta sempre que a conta ou qualquer pedido dela mudar.
  const ordersKey = useMemo(
    () => Object.values(s.orders).filter((o) => o.tabId === tabId).map((o) => `${o.id}:${o.status}:${o.items.map((i) => i.activeQty).join(',')}`).join('|'),
    [s.orders, tabId],
  );
  const load = useCallback(async () => {
    try {
      setBill(await actions.getBill(tabId));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [tabId]);
  useEffect(() => {
    load();
  }, [load, tab?.totalCents, tab?.status, ordersKey]);

  if (error && !bill) return <EmptyState title="Não foi possível carregar a conta">{error}</EmptyState>;
  if (!bill) return <EmptyState title="Carregando conta…" />;

  const closed = bill.tab.status === 'closed';
  const parts = splitCents(bill.totalCents, split);

  async function closeTab() {
    setBusy(true);
    try {
      await actions.closeTab(tabId, bill.totalCents);
      toast(`Conta da mesa ${bill.tab.tableNumber} fechada: ${money(bill.totalCents)}`, 'ok');
      setConfirmClose(false);
      onClosed?.();
    } catch (e) {
      toast(e.message, 'error', 7000);
      if (e instanceof ApiError && e.code === 'TOTAL_CHANGED') load();
      setConfirmClose(false);
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const text = billText(bill, split);
    try {
      if (navigator.share) {
        await navigator.share({ title: `Conta Mesa ${bill.tab.tableNumber}`, text });
        return;
      }
    } catch {
      return; // usuário cancelou
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Resumo copiado. Cole no WhatsApp ou onde preferir.', 'ok');
    } catch {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto p-3 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-serif text-3xl font-bold">Mesa {bill.tab.tableNumber}</h2>
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${closed ? 'bg-inchiostro text-white' : bill.tab.status === 'billing' ? 'bg-pomodoro-600 text-white' : 'bg-basilico-100 text-basilico-800'}`}>
            {TAB_STATUS_LABELS[bill.tab.status]}
          </span>
          <span className="text-sm text-seppia">
            aberta {dateTime(bill.tab.openedAt)}
            {bill.tab.reopenCount ? ` · reaberta ${bill.tab.reopenCount}×` : ''}
          </span>
        </div>

        {bill.pendingKitchen > 0 && !closed && (
          <p className="mb-3 rounded-xl bg-oro-100 p-3 text-sm font-semibold text-oro-700">
            {bill.pendingKitchen} pedido(s) desta mesa ainda em preparo na cozinha.
          </p>
        )}

        <div className="card overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm" data-testid="tabela-conta">
            <thead className="border-b border-crema-300 bg-crema-200 text-xs tracking-wide text-seppia uppercase">
              <tr>
                <th className="px-3 py-2">Hora</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Qtd</th>
                <th className="px-3 py-2 text-right">Unit.</th>
                <th className="px-3 py-2 text-right">Subtotal</th>
                {!closed && <th className="w-12" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-crema-200">
              {bill.lines.map((l) => (
                <tr key={l.itemId}>
                  <td className="px-3 py-2 whitespace-nowrap text-seppia tabular-nums">
                    {time(l.sentAt)}
                    <span className="block text-xs">#{l.orderSeq}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-semibold">{l.name}</span>
                    {l.notes && <span className="block text-xs font-semibold text-pomodoro-700">Obs.: {l.notes}</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{l.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(l.unitPriceCents)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(l.subtotalCents)}</td>
                  {!closed && (
                    <td className="pr-2">
                      <button
                        className="btn-ghost !min-h-10 !px-2 text-pomodoro-700"
                        aria-label={`Cancelar ${l.name}`}
                        onClick={() => {
                          const order = s.orders[l.orderId];
                          const item = order?.items.find((i) => i.id === l.itemId);
                          if (item) setCancelling({ item, order });
                        }}
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!bill.lines.length && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-seppia">
                    Nenhum item cobrável.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="border-t-2 border-inchiostro">
              <tr>
                <td colSpan={4} className="px-3 py-3 text-right font-serif text-xl font-bold">
                  Total ({bill.itemsCount} itens)
                </td>
                <td className="px-3 py-3 text-right font-serif text-2xl font-bold tabular-nums" data-testid="total-conta">
                  {money(bill.totalCents)}
                </td>
                {!closed && <td />}
              </tr>
              {split > 1 && (
                <tr>
                  <td colSpan={6} className="px-3 pb-3 text-right font-semibold text-basilico-800">
                    Dividido por {split}: {parts.map((p) => money(p)).join(' · ')}
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>

        {bill.cancelled.length > 0 && (
          <div className="mt-4 rounded-2xl border-2 border-dashed border-pomodoro-200 bg-pomodoro-50 p-3">
            <h3 className="font-serif text-lg font-bold text-pomodoro-800">Itens cancelados (não entram no total)</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {bill.cancelled.map((c, idx) => (
                <li key={idx} className="flex flex-wrap gap-x-2">
                  <span className="line-through">
                    {c.qty}× {c.name} — {money(c.valueCents)}
                  </span>
                  <span className="text-seppia">
                    {c.reason} · {ROLE_LABELS[c.by.role]}
                    {c.by.name ? ` (${c.by.name})` : ''} · {time(c.cancelledAt)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-seppia">Total cancelado: {money(bill.cancelledTotalCents)}</p>
          </div>
        )}

        {closed && (
          <p className="mt-4 rounded-xl bg-inchiostro p-3 text-center font-semibold text-white">
            <Icon name="lock" className="mr-1 inline h-5 w-5" />
            Conta fechada às {time(bill.tab.closedAt)} por {ROLE_LABELS[bill.tab.closedBy?.role]}
            {bill.tab.closedBy?.name ? ` (${bill.tab.closedBy.name})` : ''} · {money(bill.tab.closedTotalCents)}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t-2 border-crema-300 bg-crema-50 p-3 print:hidden">
        <button className="btn-ghost flex-1" onClick={() => setSplitOpen(true)}>
          <Icon name="users" /> Dividir
        </button>
        <button className="btn-ghost flex-1" onClick={() => window.print()}>
          <Icon name="print" /> Imprimir
        </button>
        <button className="btn-ghost flex-1" onClick={share}>
          <Icon name="share" /> Compartilhar
        </button>
        {closed ? (
          <button className="btn-danger w-full sm:w-auto sm:flex-1" onClick={() => setReopen(true)}>
            <Icon name="unlock" /> Reabrir (PIN Admin)
          </button>
        ) : (
          <button className="btn-primary min-h-14 w-full text-lg sm:w-auto sm:flex-[2]" onClick={() => setConfirmClose(true)} data-testid="fechar-conta">
            <Icon name="lock" /> Fechar conta · {money(bill.totalCents)}
          </button>
        )}
      </div>

      {/* Recibo para impressão (impressora térmica de 80 mm ou A4) */}
      <div className="print-area hidden print:block">
        <pre className="font-mono text-[11pt] whitespace-pre-wrap">{billText(bill, split)}</pre>
      </div>

      <Modal open={splitOpen} onClose={() => setSplitOpen(false)} title="Dividir a conta" size="sm" footer={<button className="btn-primary w-full" onClick={() => setSplitOpen(false)}>Concluir</button>}>
        <div className="flex items-center justify-between">
          <span className="font-semibold">Número de pessoas</span>
          <QtyStepper value={split} onChange={setSplit} min={1} max={30} size="lg" />
        </div>
        <ul className="mt-4 space-y-1">
          {parts.map((p, i) => (
            <li key={i} className="flex justify-between rounded-lg bg-crema-100 px-3 py-2 tabular-nums">
              <span>Pessoa {i + 1}</span>
              <span className="font-bold">{money(p)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-seppia">A soma das partes é exatamente o total ({money(bill.totalCents)}).</p>
      </Modal>

      <ConfirmDialog
        open={confirmClose}
        title={`Fechar a conta da mesa ${bill.tab.tableNumber}?`}
        confirmLabel={`Fechar · ${money(bill.totalCents)}`}
        busy={busy}
        onCancel={() => setConfirmClose(false)}
        onConfirm={closeTab}
      >
        <p>
          Total conferido: <strong>{money(bill.totalCents)}</strong> ({bill.itemsCount} itens).
        </p>
        <p className="mt-2 text-sm text-seppia">A mesa ficará travada. Para reabrir será necessário o PIN de Admin, e a reabertura fica registrada.</p>
        {bill.pendingKitchen > 0 && <p className="mt-2 text-sm font-semibold text-oro-700">Atenção: {bill.pendingKitchen} pedido(s) ainda na cozinha.</p>}
      </ConfirmDialog>
      {reopen && <ReopenDialog tab={bill.tab} onClose={() => setReopen(false)} onDone={() => setReopen(false)} />}
      {cancelling && <CancelDialog item={cancelling.item} order={cancelling.order} onClose={() => setCancelling(null)} />}
    </div>
  );
}

export default function CashierScreen() {
  const s = useAppState();
  const [selected, setSelected] = useState(null);
  const { active, closed } = useMemo(() => {
    const all = Object.values(s.tabs);
    return {
      active: all
        .filter((t) => t.status !== 'closed')
        .sort((a, b) => (a.status === 'billing') === (b.status === 'billing') ? a.tableNumber - b.tableNumber : a.status === 'billing' ? -1 : 1),
      closed: all.filter((t) => t.status === 'closed').sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || '')),
    };
  }, [s.tabs]);

  const TabButton = ({ t }) => (
    <button
      onClick={() => setSelected(t.id)}
      data-testid={`conta-mesa-${t.tableNumber}`}
      className={`flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 px-3 text-left ${
        selected === t.id ? 'border-basilico-700 bg-basilico-50' : t.status === 'billing' ? 'border-pomodoro-600 bg-pomodoro-50' : 'border-crema-300 bg-white'
      }`}
    >
      <span className="font-serif text-2xl font-bold">Mesa {t.tableNumber}</span>
      <span className="min-w-0 flex-1 text-xs text-seppia">
        {t.status === 'closed' ? `fechada ${time(t.closedAt)}` : t.status === 'billing' ? `conta pedida ${time(t.billRequestedAt)}` : `aberta ${time(t.openedAt)}`}
      </span>
      <span className="font-bold tabular-nums">{money(t.status === 'closed' ? t.closedTotalCents : t.totalCents)}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside className={`${selected ? 'hidden md:flex' : 'flex'} w-full flex-col gap-2 overflow-y-auto border-r border-crema-300 p-3 md:w-80 md:shrink-0 print:hidden`}>
        <h2 className="font-serif text-xl font-bold">Contas abertas</h2>
        {active.length ? active.map((t) => <TabButton key={t.id} t={t} />) : <p className="text-sm text-seppia">Nenhuma mesa com conta aberta.</p>}
        <h2 className="mt-4 font-serif text-xl font-bold">Fechadas hoje</h2>
        {closed.length ? closed.map((t) => <TabButton key={t.id} t={t} />) : <p className="text-sm text-seppia">Nenhuma ainda.</p>}
      </aside>
      <section className={`${selected ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        {selected ? (
          <>
            <button className="btn-ghost m-2 self-start md:hidden print:hidden" onClick={() => setSelected(null)}>
              <Icon name="back" /> Contas
            </button>
            <BillView key={selected} tabId={selected} />
          </>
        ) : (
          <EmptyState title="Selecione uma mesa">A conta mostra todos os itens enviados, com horários, valores congelados e cancelamentos separados.</EmptyState>
        )}
      </section>
    </div>
  );
}
