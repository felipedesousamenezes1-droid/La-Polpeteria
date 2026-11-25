import { useMemo } from 'react';
import { useAppState } from '../../lib/store.js';
import { money } from '../../lib/util.js';
import { computeTableInfo, tableState } from './tableInfo.js';

const STYLES = {
  livre: { box: 'bg-white border-crema-300 text-inchiostro', label: 'Livre' },
  ocupada: { box: 'bg-basilico-700 border-basilico-800 text-white', label: 'Ocupada' },
  pronto: { box: 'bg-oro-400 border-oro-600 text-inchiostro ring-4 ring-oro-300', label: 'PRONTO' },
  conta: { box: 'bg-pomodoro-600 border-pomodoro-700 text-white', label: 'Conta pedida' },
};

function Legend() {
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-seppia">
      {[
        ['bg-white border border-crema-400', 'Livre'],
        ['bg-basilico-700', 'Ocupada'],
        ['bg-oro-400', 'Pronto p/ retirar'],
        ['bg-pomodoro-600', 'Conta pedida'],
      ].map(([c, l]) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span className={`h-3.5 w-3.5 rounded-full ${c}`} />
          {l}
        </span>
      ))}
    </div>
  );
}

export default function TableGrid({ onOpen }) {
  const s = useAppState();
  const info = useMemo(() => computeTableInfo(s), [s]);
  const tables = Array.from({ length: s.settings.tableCount }, (_, i) => i + 1);
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-3 sm:p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="font-serif text-2xl font-bold">Mesas</h1>
      </div>
      <Legend />
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {tables.map((n) => {
          const i = info.get(n);
          const st = tableState(i);
          const style = STYLES[st];
          return (
            <button
              key={n}
              onClick={() => onOpen(n)}
              data-testid={`mesa-${n}`}
              data-status={st}
              className={`relative flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 px-1 py-2 shadow-sm transition-transform duration-75 active:scale-95 ${style.box}`}
            >
              <span className="font-serif text-3xl leading-none font-bold">{n}</span>
              <span className="mt-1 text-xs font-bold tracking-wide uppercase">{style.label}</span>
              {i?.tab && <span className="text-xs font-semibold opacity-90">{money(i.tab.totalCents)}</span>}
              {(i?.pending > 0 || i?.rejected > 0 || i?.draft > 0) && (
                <span className="absolute -top-2 -right-1 flex flex-col items-end gap-0.5">
                  {i.rejected > 0 && <span className="rounded-full bg-pomodoro-700 px-2 py-0.5 text-[11px] font-bold text-white shadow">recusado</span>}
                  {i.pending > 0 && <span className="rounded-full bg-oro-300 px-2 py-0.5 text-[11px] font-bold text-inchiostro shadow">{i.pending} pendente</span>}
                  {i.draft > 0 && <span className="rounded-full bg-crema-50 px-2 py-0.5 text-[11px] font-bold text-basilico-800 shadow ring-1 ring-crema-400">rascunho</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </main>
  );
}
