import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROLE_LABELS, ORDER_STATUS_LABELS, TAB_STATUS_LABELS } from '../../../../shared/constants.js';
import { useAppState, api, toast, getState } from '../../lib/store.js';
import { money, time, todayLocal } from '../../lib/util.js';
import { EmptyState, Icon } from '../../components/ui.jsx';
import { HBarChart, VBarChart, ChartCard, Stat, Segmented } from './charts.jsx';

// ------------------------------------------------------------------ utilitários

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
const dayLabel = (s) => parse(s).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
const shortDate = (s) => parse(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const minutes = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h${pad(Math.round(m % 60))}` : `${Math.round(m)} min`);

/** Sábado e domingo mais recentes (se hoje for sábado ou domingo, o fim de semana atual). */
function lastWeekend() {
  const today = new Date();
  const dow = today.getDay(); // 0 = domingo, 6 = sábado
  const sat = dow === 6 ? today : dow === 0 ? addDays(today, -1) : addDays(today, -(dow + 1));
  return { from: iso(sat), to: iso(addDays(sat, 1)) };
}

const PRESETS = {
  fds: { label: 'Último fim de semana', range: lastWeekend },
  mes: { label: 'Este mês', range: () => ({ from: todayLocal().slice(0, 8) + '01', to: todayLocal() }) },
  d30: { label: 'Últimos 30 dias', range: () => ({ from: iso(addDays(new Date(), -29)), to: todayLocal() }) },
  hoje: { label: 'Hoje', range: () => ({ from: todayLocal(), to: todayLocal() }) },
};

async function download(path, filename) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getState().session.token}` } });
  if (!res.ok) throw new Error(`Falha ao gerar o relatório (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ExportButtons({ from, to }) {
  const name = from === to ? from : `${from}_a_${to}`;
  const run = (format) =>
    download(`/api/owner/export?from=${from}&to=${to}&format=${format}`, `la-polpeteria_${name}.${format}`).catch((e) => toast(e.message, 'error'));
  return (
    <div className="flex flex-wrap gap-2">
      <button className="btn-primary" onClick={() => run('csv')} data-testid="exportar-csv">
        <Icon name="download" /> Baixar planilha (Excel)
      </button>
      <button className="btn-ghost" onClick={() => run('json')}>
        <Icon name="download" /> Baixar completo (JSON)
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ painel de vendas

function SalesPanel() {
  const s = useAppState();
  const [preset, setPreset] = useState('fds');
  const [range, setRange] = useState(() => PRESETS.fds.range());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [rankBy, setRankBy] = useState('qty');
  const timer = useRef(null);

  const load = useCallback(() => {
    api(`/api/owner/report?from=${range.from}&to=${range.to}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
  }, [range]);
  useEffect(() => {
    load();
  }, [load]);
  // Atualiza sozinho durante o serviço (no máximo a cada 3 s).
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 3000);
    return () => clearTimeout(timer.current);
  }, [s.orders, s.tabs, load]);

  const choose = (k) => {
    setPreset(k);
    if (PRESETS[k]) setRange(PRESETS[k].range());
  };

  const view = useMemo(() => {
    if (!data) return null;
    const k = data.kpis;
    const products = data.products.filter((p) => p.qty > 0);
    const top = [...products]
      .sort((a, b) => (rankBy === 'qty' ? b.qty - a.qty || b.revenueCents - a.revenueCents : b.revenueCents - a.revenueCents))
      .slice(0, 10)
      .map((p) => ({
        key: p.menuItemId,
        label: p.name,
        value: rankBy === 'qty' ? p.qty : p.revenueCents,
        display: rankBy === 'qty' ? `${p.qty} un.` : money(p.revenueCents),
        detail: `${p.name}: ${p.qty} un. · ${money(p.revenueCents)} · em ${p.ordersCount} pedido(s)`,
      }));
    const dishes = data.products
      .filter((p) => p.isDish && p.servedQty > 0)
      .sort((a, b) => b.servedQty - a.servedQty)
      .map((p) => ({
        key: p.menuItemId,
        label: p.name,
        value: p.servedQty,
        display: `${p.servedQty}×`,
        detail: `${p.name}: ${p.qty} avulso(s) + ${p.inCombos} no Menu Completo`,
      }));
    const cats = data.categories.map((c) => ({ key: c.category, label: c.category, value: c.revenueCents, display: money(c.revenueCents), detail: `${c.category}: ${c.qty} un. · ${money(c.revenueCents)}` }));
    const days = data.days.map((d) => ({ key: d.date, label: data.days.length > 10 ? shortDate(d.date) : dayLabel(d.date), value: d.revenueCents, display: money(d.revenueCents), detail: `${dayLabel(d.date)}: ${money(d.revenueCents)} · ${d.orders} pedido(s) · ${d.items} item(ns)` }));
    const used = data.hours.filter((h) => h.orders > 0);
    const first = used.length ? used[0].hour : 11;
    const last = used.length ? used[used.length - 1].hour : 23;
    const hours = data.hours.slice(first, last + 1).map((h) => ({ key: h.hour, label: `${h.hour}h`, value: h.orders, display: `${h.orders} pedido(s)`, detail: `${h.hour}h–${h.hour + 1}h: ${h.orders} pedido(s) · ${h.items} item(ns) · ${money(h.revenueCents)}` }));
    return { k, top, dishes, cats, days, hours };
  }, [data, rankBy]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        {Object.entries(PRESETS).map(([k, p]) => (
          <button key={k} onClick={() => choose(k)} className={`chip ${preset === k ? 'border-basilico-700 bg-basilico-700 text-white' : 'border-crema-300 bg-white'}`}>
            {p.label}
          </button>
        ))}
        <button onClick={() => setPreset('custom')} className={`chip ${preset === 'custom' ? 'border-basilico-700 bg-basilico-700 text-white' : 'border-crema-300 bg-white'}`}>
          Escolher datas
        </button>
        {preset === 'custom' && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm font-semibold">
              De
              <input type="date" className="input mt-1" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
            </label>
            <label className="text-sm font-semibold">
              Até
              <input type="date" className="input mt-1" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
            </label>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-serif text-lg">
          {range.from === range.to ? dayLabel(range.from) : `${dayLabel(range.from)} a ${dayLabel(range.to)}`}
        </p>
        <ExportButtons from={range.from} to={range.to} />
      </div>

      {error && <p className="rounded-xl bg-pomodoro-50 p-3 font-semibold text-pomodoro-800">{error}</p>}
      {!view ? (
        <EmptyState title="Carregando relatório…" />
      ) : view.k.ordersCount === 0 && view.k.closedTabs === 0 ? (
        <EmptyState title="Sem vendas neste período">Escolha outro período acima.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="kpis">
            <Stat label="Vendas" value={money(view.k.salesCents)} sub={`${view.k.itemsSold} itens vendidos`} tone="border-basilico-200" />
            <Stat label="Recebido (contas fechadas)" value={money(view.k.closedRevenueCents)} sub={`${view.k.closedTabs} conta(s), com serviço`} />
            <Stat label="Ticket médio por mesa" value={view.k.avgTicketCents == null ? '—' : money(view.k.avgTicketCents)} sub={view.k.avgTabMinutes == null ? '' : `permanência média ${minutes(view.k.avgTabMinutes)}`} />
            <Stat label="Mesas atendidas" value={view.k.tablesServed} sub={`${view.k.ordersCount} pedido(s) à cozinha`} />
            <Stat label="Tempo médio de preparo" value={minutes(view.k.avgPrepMinutes)} sub={view.k.prepCount ? `do envio ao "pronto" (${view.k.prepCount} pedidos)` : 'sem pedidos marcados como pronto'} />
            <Stat
              label="Cancelamentos"
              value={view.k.cancelledQty}
              sub={`${money(view.k.cancelledCents)} · ${view.k.cancelRatePct.toFixed(1).replace('.', ',')}% dos itens`}
              tone={view.k.cancelledQty ? 'border-pomodoro-200' : ''}
            />
            <Stat label="Serviço recebido" value={money(view.k.serviceCents || 0)} sub="taxa de serviço das contas fechadas" />
            <Stat label="Média por dia" value={view.k.daysWithSales ? money(Math.round(view.k.salesCents / view.k.daysWithSales)) : '—'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Produtos mais vendidos"
              subtitle="Os 10 primeiros do período"
              right={<Segmented value={rankBy} onChange={setRankBy} options={[['qty', 'Quantidade'], ['rev', 'Faturamento']]} />}
            >
              <HBarChart rows={view.top} />
            </ChartCard>
            <ChartCard title="Pratos preferidos pelos clientes" subtitle="Vezes que cada prato foi servido: avulso ou escolhido no Menu Completo">
              <HBarChart rows={view.dishes} tone="dourado" emptyText="Nenhum prato da proposta vendido no período." />
            </ChartCard>
            <ChartCard title="Escolhas no Menu Completo" subtitle="O que os clientes escolhem em cada etapa">
              {data.comboChoices.every((c) => !c.items.length) ? (
                <p className="py-6 text-center text-sm text-seppia">Nenhum Menu Completo vendido no período.</p>
              ) : (
                <div className="space-y-4">
                  {data.comboChoices.map((c) => (
                    <div key={c.step}>
                      <p className="mb-1 text-sm font-bold text-pomodoro-700 uppercase">{c.step}</p>
                      <HBarChart rows={c.items.map((x) => ({ key: x.menuItemId, label: x.name, value: x.qty, display: `${x.qty}×` }))} tone="dourado" />
                    </div>
                  ))}
                </div>
              )}
            </ChartCard>
            <ChartCard title="Vendas por seção do cardápio" subtitle="Faturamento de cada seção">
              <HBarChart rows={view.cats} />
            </ChartCard>
            <ChartCard title="Vendas por dia" subtitle="Somente os dias com movimento">
              <VBarChart rows={view.days} unitHint="faturamento" />
            </ChartCard>
            <ChartCard title="Movimento por horário" subtitle="Pedidos enviados à cozinha em cada hora">
              <VBarChart rows={view.hours} unitHint="pedidos" />
            </ChartCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Garçons" subtitle="Pedidos lançados por quem atendeu">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-seppia uppercase">
                  <tr>
                    <th className="py-1">Nome</th>
                    <th className="py-1 text-right">Pedidos</th>
                    <th className="py-1 text-right">Itens</th>
                    <th className="py-1 text-right">Vendas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-crema-200">
                  {data.waiters.map((w) => (
                    <tr key={w.name}>
                      <td className="py-1.5 font-semibold">{w.name}</td>
                      <td className="py-1.5 text-right tabular-nums">{w.orders}</td>
                      <td className="py-1.5 text-right tabular-nums">{w.items}</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">{money(w.revenueCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ChartCard>
            <ChartCard title="Cancelamentos" subtitle="Motivos e itens mais cancelados (podem indicar pratos com problema)">
              {!data.cancellations.byReason.length ? (
                <p className="py-6 text-center text-sm text-seppia">Nenhum cancelamento no período.</p>
              ) : (
                <div className="space-y-4">
                  <HBarChart tone="vermelho" rows={data.cancellations.byReason.map((r) => ({ key: r.reason, label: r.reason, value: r.qty, display: `${r.qty} · ${money(r.valueCents)}` }))} />
                  <ul className="divide-y divide-crema-200 text-sm">
                    {data.cancellations.byProduct.map((p) => (
                      <li key={p.menuItemId} className="flex justify-between gap-2 py-1.5">
                        <span className="min-w-0 truncate">{p.name}</span>
                        <span className="shrink-0 tabular-nums">
                          {p.cancelledQty} cancelado(s) · {money(p.cancelledCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </ChartCard>
          </div>

          <ChartCard title="Todos os produtos" subtitle="Tabela completa do período">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm" data-testid="tabela-produtos">
                <thead className="border-b border-crema-300 text-left text-xs text-seppia uppercase">
                  <tr>
                    <th className="py-2">Produto</th>
                    <th className="py-2">Seção</th>
                    <th className="py-2 text-right">Vendidos</th>
                    <th className="py-2 text-right">No Menu Completo</th>
                    <th className="py-2 text-right">Faturamento</th>
                    <th className="py-2 text-right">% das vendas</th>
                    <th className="py-2 text-right">Cancelados</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-crema-200">
                  {data.products.map((p) => (
                    <tr key={p.menuItemId}>
                      <td className="py-1.5 font-semibold">{p.name}</td>
                      <td className="py-1.5 text-seppia">{p.category}</td>
                      <td className="py-1.5 text-right tabular-nums">{p.qty}</td>
                      <td className="py-1.5 text-right tabular-nums">{p.inCombos || '—'}</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">{money(p.revenueCents)}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {view.k.salesCents ? `${((p.revenueCents / view.k.salesCents) * 100).toFixed(1).replace('.', ',')}%` : '—'}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{p.cancelledQty || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-seppia">
              "Preferência" é medida pelo que os clientes pedem: o sistema não coleta avaliações. Itens muito cancelados por "Problema no prato" merecem atenção.
            </p>
          </ChartCard>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ histórico dia a dia

function HistoryPanel() {
  const s = useAppState();
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState(null);
  const load = useCallback(() => api(`/api/owner/history?date=${date}`).then(setData).catch((e) => toast(e.message, 'error')), [date]);
  useEffect(() => {
    load();
  }, [load, s.orders, s.tabs]);
  if (!data) return <EmptyState title="Carregando…" />;
  const sm = data.summary;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Dia</label>
          <input type="date" className="input" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <ExportButtons from={date} to={date} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Contas fechadas" value={money(sm.closedRevenueCents)} sub={`${sm.closedTabsCount} conta(s)`} tone="border-basilico-200" />
        <Stat label="Contas abertas" value={money(sm.openTabsCents)} sub={`${sm.openTabsCount} mesa(s)`} />
        <Stat label="Pedidos" value={sm.ordersCount} sub={`${sm.itemsCount} itens · ${money(sm.ordersCents)}`} />
        <Stat label="Cancelamentos" value={sm.cancelledCount} sub={money(sm.cancelledCents)} tone="border-pomodoro-200" />
      </div>

      <h3 className="mt-5 mb-2 font-serif text-xl font-bold">Contas</h3>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-crema-200 text-left text-xs text-seppia uppercase">
            <tr>
              <th className="px-3 py-2">Mesa</th>
              <th className="px-3 py-2">Aberta</th>
              <th className="px-3 py-2">Fechada</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-crema-200">
            {data.tabs.map((t) => (
              <tr key={t.id}>
                <td className="px-3 py-2 font-bold">{t.tableNumber}</td>
                <td className="px-3 py-2">{time(t.openedAt)}</td>
                <td className="px-3 py-2">{t.closedAt ? `${time(t.closedAt)} · ${ROLE_LABELS[t.closedBy?.role] || ''}` : '—'}</td>
                <td className="px-3 py-2">
                  {TAB_STATUS_LABELS[t.status]}
                  {t.reopenCount ? ` (reaberta ${t.reopenCount}×)` : ''}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(t.status === 'closed' ? t.closedTotalCents : t.totalCents)}</td>
              </tr>
            ))}
            {!data.tabs.length && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-seppia">
                  Sem contas neste dia.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="mt-5 mb-2 font-serif text-xl font-bold">Pedidos</h3>
      <ul className="space-y-2">
        {[...data.orders].reverse().map((o) => (
          <li key={o.id} className="card p-3 text-sm">
            <div className="flex flex-wrap gap-x-3">
              <strong>#{o.seq}</strong>
              <span>Mesa {o.tableNumber}</span>
              <span>{time(o.receivedAt)}</span>
              <span>
                {ROLE_LABELS[o.createdBy.role]}
                {o.createdBy.name ? ` (${o.createdBy.name})` : ''}
              </span>
              <span>{o.fullyCancelled ? 'Cancelado' : ORDER_STATUS_LABELS[o.status]}</span>
              <span className="ml-auto font-bold tabular-nums">{money(o.totalCents)}</span>
            </div>
            <p className="text-seppia">
              {o.items.map((i) => `${i.qty}× ${i.name}${i.cancelledQty ? ` (${i.cancelledQty} cancel.)` : ''}`).join(' · ')}
            </p>
          </li>
        ))}
        {!data.orders.length && <li className="text-sm text-seppia">Sem pedidos neste dia.</li>}
      </ul>

      {data.cancellations.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 font-serif text-xl font-bold text-pomodoro-800">Cancelamentos</h3>
          <ul className="card divide-y divide-crema-200 text-sm">
            {data.cancellations.map((c, idx) => (
              <li key={idx} className="flex flex-wrap gap-x-3 px-3 py-2">
                <span>{time(c.at)}</span>
                <span>Mesa {c.tableNumber}</span>
                <span>
                  {c.qty}× {c.name}
                </span>
                <span className="text-seppia">{c.reason}</span>
                <span className="text-seppia">
                  {ROLE_LABELS[c.by.role]}
                  {c.by.name ? ` (${c.by.name})` : ''}
                </span>
                <span className="ml-auto tabular-nums">{money(c.valueCents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ começar a operação do zero

function ResetPanel({ onDone }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const r = await api('/api/owner/reset', { method: 'POST', body: { pin, confirm }, timeout: 60000 });
      setResult(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const r = result.removed;
    return (
      <section className="card mx-auto max-w-xl border-basilico-200 p-5" data-testid="zerar-ok">
        <h2 className="font-serif text-2xl font-bold text-basilico-800">Pronto: operação começando do zero</h2>
        <ul className="mt-3 space-y-1">
          <li>{r.orders} pedido(s) de teste apagado(s)</li>
          <li>{r.tabs} conta(s) apagada(s), inclusive as abertas</li>
          <li>{r.audit_log} registro(s) de auditoria apagado(s)</li>
        </ul>
        <p className="mt-3 text-sm text-seppia">
          Cópia de segurança feita antes da limpeza: <code className="break-all">{result.backup}</code>. Cardápio, seções, configurações e PINs foram mantidos. A partir de agora os dados reais ficam protegidos e esta opção não aparece mais.
        </p>
        <button className="btn-primary mt-4" onClick={onDone}>
          Ir para o painel
        </button>
      </section>
    );
  }

  return (
    <section className="card mx-auto max-w-xl border-pomodoro-200 p-5">
      <h2 className="font-serif text-2xl font-bold text-pomodoro-800">Começar a operação do zero</h2>
      <p className="mt-2">Use uma única vez, antes de abrir para clientes, para apagar tudo o que foi feito em testes:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        <li>
          <strong>Apaga:</strong> todos os pedidos, contas (inclusive as abertas), cancelamentos, a fila da cozinha e toda a auditoria; também os pedidos de teste guardados nos celulares.
        </li>
        <li>
          <strong>Mantém:</strong> cardápio, seções, configurações, PINs e os aparelhos conectados.
        </li>
        <li>
          <strong>Segurança:</strong> antes de apagar, o sistema faz uma cópia completa (backup). Depois disso, a opção é desativada e os dados reais não podem mais ser apagados.
        </li>
      </ul>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="zerar-pin">Seu PIN de Proprietário</label>
          <input id="zerar-pin" className="input" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div>
          <label className="label" htmlFor="zerar-confirma">Digite ZERAR para confirmar</label>
          <input id="zerar-confirma" className="input uppercase" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </div>
      </div>
      {error && <p className="mt-3 font-semibold text-pomodoro-700" role="alert">{error}</p>}
      <button className="btn-danger mt-4 w-full" disabled={busy || pin.length < 4 || confirm.trim().toUpperCase() !== 'ZERAR'} onClick={run} data-testid="zerar-executar">
        {busy ? 'Fazendo backup e apagando…' : 'Apagar dados de teste e começar'}
      </button>
    </section>
  );
}

export default function OwnerScreen() {
  const s = useAppState();
  const canReset = !s.settings.operationStartedAt;
  const [tab, setTab] = useState(() => localStorage.getItem('polpeteria.ownerTab') || 'vendas');
  // A aba de limpeza fica aberta até o usuário sair dela (o aviso de "operação iniciada" pode chegar
  // pelo tempo real antes da resposta do botão).
  const [resetShown, setResetShown] = useState(() => tab === 'zerar' && !s.settings.operationStartedAt);
  const select = (t) => {
    setTab(t);
    setResetShown(t === 'zerar' && (!s.settings.operationStartedAt || resetShown));
    try {
      localStorage.setItem('polpeteria.ownerTab', t);
    } catch {
      /* sem armazenamento */
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex gap-2 overflow-x-auto border-b border-crema-300 bg-crema-50 px-3 py-2">
        {[
          ['vendas', 'Painel de vendas'],
          ['dia', 'Dia a dia'],
          ...(canReset || resetShown ? [['zerar', 'Zerar dados de teste']] : []),
        ].map(([k, l]) => (
          <button key={k} onClick={() => select(k)} className={`chip ${tab === k ? 'border-basilico-700 bg-basilico-700 text-white' : 'border-crema-300 bg-white'}`}>
            {l}
          </button>
        ))}
      </nav>
      <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-3 sm:p-5">
        {tab === 'zerar' && (canReset || resetShown) ? (
          <ResetPanel onDone={() => select('vendas')} />
        ) : tab === 'dia' ? (
          <HistoryPanel />
        ) : (
          <SalesPanel />
        )}
      </main>
    </div>
  );
}
