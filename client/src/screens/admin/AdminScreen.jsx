import { useCallback, useEffect, useMemo, useState } from 'react';
import { CATEGORIES, ROLE_LABELS, ORDER_STATUS_LABELS, TAB_STATUS_LABELS, COMBO_CATEGORY, COMBO_STEPS } from '../../../../shared/constants.js';
import { useAppState, api, toast, getState } from '../../lib/store.js';
import { money, time, dateTime, todayLocal } from '../../lib/util.js';
import { EmptyState, Icon, Modal, QtyStepper, ConfirmDialog } from '../../components/ui.jsx';

const TABS = [
  ['menu', 'Cardápio'],
  ['config', 'Mesas e PINs'],
  ['history', 'Histórico do dia'],
  ['audit', 'Auditoria'],
  ['backup', 'Backups e exportação'],
];

function parsePrice(text) {
  const t = String(text).trim().replace(/[R$\s]/g, '');
  if (!/^\d+([.,]\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t.replace(',', '.')) * 100);
}

async function download(path, filename) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getState().session.token}` } });
  if (!res.ok) throw new Error(`Falha ao exportar (${res.status})`);
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

function ExportButtons({ date }) {
  const run = (format) =>
    download(`/api/admin/export?date=${date}&format=${format}`, `la-polpeteria_${date}.${format}`).catch((e) => toast(e.message, 'error'));
  return (
    <div className="flex flex-wrap gap-2">
      <button className="btn-primary" onClick={() => run('csv')} data-testid="exportar-csv">
        <Icon name="download" /> Exportar dia (CSV/Excel)
      </button>
      <button className="btn-ghost" onClick={() => run('json')}>
        <Icon name="download" /> Exportar dia (JSON)
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Cardápio

function MenuItemForm({ item, onClose }) {
  const [form, setForm] = useState({
    name: item?.name || '',
    description: item?.description || '',
    category: item?.category || CATEGORIES[0],
    price: item ? (item.priceCents / 100).toFixed(2).replace('.', ',') : '',
    active: item ? item.active : true,
    inCombo: item ? item.inCombo : false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save() {
    const priceCents = parsePrice(form.price);
    if (priceCents == null) return setError('Preço inválido. Use, por exemplo, 62,00.');
    setBusy(true);
    setError('');
    try {
      const body = { name: form.name, description: form.description, category: form.category, priceCents, active: form.active, inCombo: form.inCombo };
      if (item) await api(`/api/admin/menu/${item.id}`, { method: 'PUT', body });
      else await api('/api/admin/menu', { method: 'POST', body });
      toast('Cardápio atualizado', 'ok');
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
      onClose={onClose}
      title={item ? 'Editar item' : 'Novo item'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            Salvar
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <div>
          <label className="label">Nome</label>
          <input className="input" value={form.name} onChange={set('name')} maxLength={80} />
        </div>
        <div>
          <label className="label">Descrição</label>
          <input className="input" value={form.description} onChange={set('description')} maxLength={200} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Categoria</label>
            <select className="input" value={form.category} onChange={set('category')}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Preço (R$)</label>
            <input className="input" inputMode="decimal" value={form.price} onChange={set('price')} placeholder="0,00" />
          </div>
        </div>
        <label className="flex min-h-12 items-center gap-3 font-semibold">
          <input type="checkbox" className="h-6 w-6 accent-basilico-700" checked={form.active} onChange={set('active')} /> Disponível no cardápio
        </label>
        {form.category === COMBO_CATEGORY ? (
          <p className="rounded-xl bg-oro-100 p-3 text-sm">
            Item composto: o garçom escolhe {COMBO_STEPS.map((s) => s.label.toLowerCase()).join(', ')} entre os pratos marcados como "faz parte do Menu Completo". O preço cobrado é o deste item.
          </p>
        ) : (
          COMBO_STEPS.some((s) => s.categories.includes(form.category)) && (
            <label className="flex min-h-12 items-center gap-3 font-semibold">
              <input type="checkbox" className="h-6 w-6 accent-basilico-700" checked={form.inCombo} onChange={set('inCombo')} /> Faz parte do Menu Completo
            </label>
          )
        )}
        {item && <p className="text-sm text-seppia">Mudanças de preço valem só para pedidos novos; contas já lançadas mantêm o preço do momento do pedido.</p>}
        {error && <p className="font-semibold text-pomodoro-700">{error}</p>}
      </div>
    </Modal>
  );
}

function MenuPanel() {
  const s = useAppState();
  const [editing, setEditing] = useState(null);
  async function toggle(item) {
    try {
      await api(`/api/admin/menu/${item.id}`, { method: 'PUT', body: { active: !item.active } });
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-seppia">{s.menu.filter((m) => m.active).length} de {s.menu.length} itens disponíveis</p>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" /> Novo item
        </button>
      </div>
      {CATEGORIES.map((c) => (
        <section key={c} className="mb-4">
          <h3 className="mb-2 font-serif text-xl font-bold text-basilico-800">{c}</h3>
          <ul className="card divide-y divide-crema-200">
            {s.menu
              .filter((m) => m.category === c)
              .map((m) => (
                <li key={m.id} className={`flex items-center gap-3 px-3 py-2 ${m.active ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {m.name}
                      {m.inCombo && <span className="ml-2 rounded-full bg-oro-200 px-2 py-0.5 text-xs font-bold text-oro-700">Menu Completo</span>}
                    </p>
                    <p className="truncate text-sm text-seppia">{m.description}</p>
                  </div>
                  <span className="font-bold tabular-nums">{money(m.priceCents)}</span>
                  <button
                    className={`min-h-11 min-w-28 rounded-full px-3 text-sm font-bold ${m.active ? 'bg-basilico-700 text-white' : 'bg-crema-300 text-inchiostro'}`}
                    onClick={() => toggle(m)}
                    aria-pressed={m.active}
                  >
                    {m.active ? 'Ativo' : 'Desativado'}
                  </button>
                  <button className="btn-ghost !min-h-11 !px-3" onClick={() => setEditing(m)} aria-label={`Editar ${m.name}`}>
                    <Icon name="note" className="h-5 w-5" />
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
      {editing && <MenuItemForm item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ Configurações

function PinRow({ role }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState(false);
  async function save() {
    try {
      await api(`/api/admin/pins/${role}`, { method: 'PUT', body: { pin } });
      toast(`PIN de ${ROLE_LABELS[role]} alterado`, 'ok');
      setPin('');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setConfirm(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      <span className="w-24 font-semibold">{ROLE_LABELS[role]}</span>
      <input className="input !w-40" inputMode="numeric" maxLength={8} placeholder="Novo PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
      <button className="btn-ghost" disabled={pin.length < 4} onClick={() => setConfirm(true)}>
        Salvar PIN
      </button>
      <ConfirmDialog
        open={confirm}
        title={`Trocar o PIN de ${ROLE_LABELS[role]}?`}
        message={role === 'admin' ? 'O novo PIN passa a valer imediatamente.' : 'Os aparelhos conectados com esse perfil serão desconectados e precisarão do novo PIN. Pedidos pendentes nesses aparelhos continuam salvos.'}
        onCancel={() => setConfirm(false)}
        onConfirm={save}
      />
    </div>
  );
}

function ConfigPanel() {
  const s = useAppState();
  const [cfg, setCfg] = useState(s.settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setCfg(s.settings), [s.settings]);
  async function save() {
    setBusy(true);
    try {
      await api('/api/admin/settings', { method: 'PUT', body: cfg });
      toast('Configurações salvas', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-4">
        <h3 className="mb-3 font-serif text-xl font-bold">Salão e cozinha</h3>
        <div className="flex items-center justify-between py-2">
          <span className="font-semibold">Número de mesas</span>
          <QtyStepper value={cfg.tableCount} onChange={(v) => setCfg({ ...cfg, tableCount: v })} min={1} max={200} />
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="font-semibold">
            Alerta amarelo na cozinha <span className="block text-xs font-normal text-seppia">minutos desde o envio</span>
          </span>
          <QtyStepper value={cfg.warnMinutes} onChange={(v) => setCfg({ ...cfg, warnMinutes: v })} min={1} max={240} />
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="font-semibold">
            Alerta vermelho (atraso) <span className="block text-xs font-normal text-seppia">minutos desde o envio</span>
          </span>
          <QtyStepper value={cfg.lateMinutes} onChange={(v) => setCfg({ ...cfg, lateMinutes: v })} min={2} max={480} />
        </div>
        <button className="btn-primary mt-2 w-full" onClick={save} disabled={busy}>
          Salvar configurações
        </button>
      </section>
      <section className="card p-4">
        <h3 className="mb-1 font-serif text-xl font-bold">PINs de acesso</h3>
        <p className="mb-2 text-sm text-seppia">De 4 a 8 dígitos; cada perfil precisa de um PIN diferente. Os PINs ficam guardados criptografados (hash).</p>
        {['garcom', 'cozinha', 'caixa', 'admin'].map((r) => (
          <PinRow key={r} role={r} />
        ))}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Histórico

function Stat({ label, value, sub, tone = '' }) {
  return (
    <div className={`card p-3 ${tone}`}>
      <p className="text-xs font-bold tracking-wide text-seppia uppercase">{label}</p>
      <p className="font-serif text-2xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-seppia">{sub}</p>}
    </div>
  );
}

function HistoryPanel() {
  const s = useAppState();
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState(null);
  const load = useCallback(() => api(`/api/admin/history?date=${date}`).then(setData).catch((e) => toast(e.message, 'error')), [date]);
  useEffect(() => {
    load();
  }, [load, s.rev, s.orders, s.tabs]);
  if (!data) return <EmptyState title="Carregando…" />;
  const sm = data.summary;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Dia</label>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <ExportButtons date={date} />
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

// ------------------------------------------------------------------ Auditoria

const ACTION_LABELS = {
  'system.seed': 'Banco criado com dados iniciais',
  'auth.login': 'Entrada no sistema',
  'auth.logout': 'Saída do sistema',
  'tab.open': 'Conta aberta',
  'tab.request_bill': 'Mesa fechada pelo garçom (conta pedida)',
  'tab.bill_request_cleared': 'Conta reaberta para novos itens',
  'tab.close': 'Conta fechada no caixa',
  'tab.reopen': 'Conta REABERTA',
  'tab.reopen_denied': 'Tentativa de reabertura NEGADA',
  'order.create': 'Pedido enviado',
  'order.resend_ignored': 'Reenvio do mesmo pedido (ignorado, sem duplicar)',
  'order.status': 'Mudança de status do pedido',
  'item.cancel': 'Item cancelado',
  'menu.create': 'Item criado no cardápio',
  'menu.update': 'Item do cardápio alterado',
  'settings.update': 'Configurações alteradas',
  'settings.pin_change': 'PIN alterado',
  'backup.manual': 'Backup manual',
  'export.download': 'Exportação do dia',
};

function describe(e) {
  const d = e.details || {};
  switch (e.action) {
    case 'order.create':
      return `Mesa ${d.mesa} · #${d.seq} · ${(d.itens || []).map((i) => `${i.qtd}× ${i.item}`).join(', ')} · ${money(d.totalCentavos)}`;
    case 'order.status':
      return `Mesa ${d.mesa} · #${d.seq}: ${ORDER_STATUS_LABELS[d.de]} → ${ORDER_STATUS_LABELS[d.para]}`;
    case 'item.cancel':
      return `Mesa ${d.mesa} · #${d.seq}: ${d.qtd}× ${d.item} (${money(d.valorCentavos)}) — ${d.motivo}`;
    case 'tab.close':
      return `Mesa ${d.mesa} · ${money(d.totalCentavos)}`;
    case 'tab.reopen':
      return `Mesa ${d.mesa} · motivo: ${d.motivo} · total anterior ${money(d.totalAnteriorCentavos)}`;
    case 'menu.update':
      return `${d.item}: ${Object.entries(d.alteracoes || {}).map(([k, v]) => `${k} ${k === 'price_cents' ? `${money(v.de)} → ${money(v.para)}` : `${v.de} → ${v.para}`}`).join('; ')}`;
    default:
      return d.mesa ? `Mesa ${d.mesa}` : e.details ? JSON.stringify(e.details) : '';
  }
}

function AuditPanel() {
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState(null);
  const [verify, setVerify] = useState(null);
  useEffect(() => {
    api(`/api/admin/audit?date=${date}&limit=1000`).then(setData).catch((e) => toast(e.message, 'error'));
  }, [date]);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Dia</label>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <button className="btn-ghost" onClick={() => api('/api/admin/audit/verify').then(setVerify).catch((e) => toast(e.message, 'error'))}>
          <Icon name="lock" /> Verificar integridade do log
        </button>
        {verify && (
          <span className={`rounded-full px-3 py-2 text-sm font-bold ${verify.ok ? 'bg-basilico-100 text-basilico-800' : 'bg-pomodoro-600 text-white'}`}>
            {verify.ok ? `Íntegro: ${verify.count} registros encadeados` : `ADULTERAÇÃO detectada no registro ${verify.brokenAtId}`}
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-seppia">Registros somente-leitura: o banco recusa qualquer alteração ou exclusão, e cada registro contém o hash do anterior.</p>
      {!data ? (
        <EmptyState title="Carregando…" />
      ) : (
        <ul className="card divide-y divide-crema-200 text-sm">
          {data.entries.map((e) => (
            <li key={e.id} className="grid gap-x-3 px-3 py-2 sm:grid-cols-[5rem_10rem_1fr]">
              <span className="text-seppia tabular-nums">{new Date(e.at).toLocaleTimeString('pt-BR')}</span>
              <span className="font-semibold">
                {ROLE_LABELS[e.actorRole] || e.actorRole}
                {e.actorName ? ` (${e.actorName})` : ''}
              </span>
              <span>
                <strong>{ACTION_LABELS[e.action] || e.action}</strong> <span className="text-seppia">{describe(e)}</span>
              </span>
            </li>
          ))}
          {!data.entries.length && <li className="px-3 py-4 text-center text-seppia">Sem registros neste dia.</li>}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Backups

function BackupPanel() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/api/admin/backups').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    load();
  }, []);
  const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-4">
        <h3 className="mb-2 font-serif text-xl font-bold">Exportar dia</h3>
        <p className="mb-3 text-sm text-seppia">Planilha CSV (abre no Excel) ou JSON completo com contas, pedidos, cancelamentos e auditoria. O sistema também gera a exportação do dia anterior automaticamente.</p>
        <ExportButtons date={todayLocal()} />
      </section>
      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-serif text-xl font-bold">Backups automáticos</h3>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api('/api/admin/backups', { method: 'POST' });
                toast(`Backup criado: ${r.name}`, 'ok');
                load();
              } catch (e) {
                toast(e.message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Fazer backup agora
          </button>
        </div>
        {data && (
          <>
            <p className="mb-2 text-sm text-seppia">
              A cada 10 minutos (quando houve movimento), mantendo os últimos {data.keep}. Pasta: <code className="break-all">{data.dir}</code>
            </p>
            <ul className="max-h-80 divide-y divide-crema-200 overflow-y-auto text-sm">
              {data.files.map((f) => (
                <li key={f.name} className="flex justify-between gap-2 py-1.5">
                  <span className="break-all">{f.name}</span>
                  <span className="shrink-0 text-seppia">
                    {dateTime(f.createdAt)} · {size(f.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

export default function AdminScreen() {
  const [tab, setTab] = useState(() => localStorage.getItem('polpeteria.adminTab') || 'menu');
  const select = (t) => {
    setTab(t);
    localStorage.setItem('polpeteria.adminTab', t);
  };
  const panel = useMemo(() => ({ menu: <MenuPanel />, config: <ConfigPanel />, history: <HistoryPanel />, audit: <AuditPanel />, backup: <BackupPanel /> })[tab], [tab]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex gap-2 overflow-x-auto border-b border-crema-300 bg-crema-50 px-3 py-2">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => select(k)} className={`chip ${tab === k ? 'border-basilico-700 bg-basilico-700 text-white' : 'border-crema-300 bg-white'}`}>
            {l}
          </button>
        ))}
      </nav>
      <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto p-3 sm:p-5">{panel}</main>
    </div>
  );
}
