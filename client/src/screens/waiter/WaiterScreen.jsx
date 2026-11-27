import { useState } from 'react';
import { useAppState, actions, dismissReadyAlert, toast } from '../../lib/store.js';
import { Icon } from '../../components/ui.jsx';
import TableGrid from './TableGrid.jsx';
import TableView from './TableView.jsx';

/** Encontra um tempo da cozinha (id "pedido:tempo") no estado. */
export function findTicket(orders, ticketId) {
  const orderId = ticketId.slice(0, ticketId.lastIndexOf(':'));
  const order = orders[orderId];
  return order ? { order, ticket: order.tickets?.find((t) => t.id === ticketId) } : {};
}

/** Faixa de alerta "prato pronto" — visível em qualquer tela do garçom. */
function ReadyAlerts({ onOpenTable }) {
  const s = useAppState();
  const alerts = s.readyAlerts
    .map((id) => findTicket(s.orders, id))
    .filter(({ ticket }) => ticket && ticket.status === 'pronto' && !ticket.fullyCancelled);
  if (!alerts.length) return null;
  return (
    <div className="space-y-2 border-b-2 border-oro-500 bg-oro-300 px-3 py-2" role="alert" data-testid="alerta-pronto">
      {alerts.map(({ order: o, ticket: t }) => (
        <div key={t.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-lg font-bold">
            <Icon name="bell" className="h-6 w-6 shrink-0" />
            Mesa {o.tableNumber} · #{o.seq}
            {t.tempos > 1 ? ` · ${t.label}` : ''} PRONTO para retirar
          </p>
          <div className="flex gap-2">
            <button className="btn-ghost !min-h-11 flex-1 bg-white" onClick={() => onOpenTable(o.tableNumber)}>
              Ver mesa
            </button>
            <button
              className="btn-primary !min-h-11 flex-1"
              onClick={async () => {
                try {
                  await actions.setTicketStatus(t, 'entregue');
                  dismissReadyAlert(t.id);
                } catch (e) {
                  toast(e.message, 'error');
                }
              }}
            >
              Entregue ✓
            </button>
            <button className="btn-ghost !min-h-11 !px-3" onClick={() => dismissReadyAlert(t.id)} aria-label="Dispensar alerta">
              <Icon name="close" className="h-5 w-5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WaiterScreen() {
  const [table, setTable] = useState(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReadyAlerts onOpenTable={setTable} />
      {table ? <TableView key={table} table={table} onBack={() => setTable(null)} /> : <TableGrid onOpen={setTable} />}
    </div>
  );
}
