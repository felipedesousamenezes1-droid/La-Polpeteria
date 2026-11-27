import { useEffect, useMemo, useState } from 'react';
import { ROLE_LABELS, ORDER_STATUS_LABELS } from '../../../../shared/constants.js';
import MenuEditor from './MenuEditor.jsx';
import { useAppState, api, toast, getState } from '../../lib/store.js';
import { money, time, dateTime, todayLocal } from '../../lib/util.js';
import { EmptyState, Icon, Modal, QtyStepper, ConfirmDialog } from '../../components/ui.jsx';

const TABS = [
  ['menu', 'Cardápio'],
  ['config', 'Mesas e PINs'],
  ['audit', 'Auditoria'],
  ['backup', 'Backups'],
];

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
        message={role === 'admin' || role === 'dono' ? 'O novo PIN passa a valer imediatamente.' : 'Os aparelhos conectados com esse perfil serão desconectados e precisarão do novo PIN. Pedidos pendentes nesses aparelhos continuam salvos.'}
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
        <div className="flex items-center justify-between py-2">
          <span className="font-semibold">
            Taxa de serviço (%) <span className="block text-xs font-normal text-seppia">calculada automaticamente na conta</span>
          </span>
          <QtyStepper value={cfg.servicePct ?? 10} onChange={(v) => setCfg({ ...cfg, servicePct: v })} min={0} max={30} />
        </div>
        <label className="flex min-h-12 items-center gap-3 font-semibold">
          <input type="checkbox" className="h-6 w-6 accent-basilico-700" checked={cfg.serviceDefault ?? true} onChange={(e) => setCfg({ ...cfg, serviceDefault: e.target.checked })} />
          Incluir a taxa de serviço automaticamente nas mesas novas
        </label>
        <div className="py-2">
          <label className="label" htmlFor="proposta">
            Nome da proposta do mês (título da seção no cardápio)
          </label>
          <input id="proposta" className="input" maxLength={40} value={cfg.proposalTitle || ''} onChange={(e) => setCfg({ ...cfg, proposalTitle: e.target.value })} />
        </div>
        <button className="btn-primary mt-2 w-full" onClick={save} disabled={busy}>
          Salvar configurações
        </button>
      </section>
      <section className="card p-4">
        <h3 className="mb-1 font-serif text-xl font-bold">PINs de acesso</h3>
        <p className="mb-2 text-sm text-seppia">De 4 a 8 dígitos; cada perfil precisa de um PIN diferente. Os PINs ficam guardados criptografados (hash).</p>
        {['garcom', 'cozinha', 'caixa', 'admin', ...(s.session?.role === 'dono' ? ['dono'] : [])].map((r) => (
          <PinRow key={r} role={r} />
        ))}
      </section>
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
  'export.download': 'Relatório exportado',
  'menu.delete': 'Item excluído do cardápio',
  'menu.move': 'Item reordenado no cardápio',
  'menu.category_create': 'Seção criada',
  'menu.category_update': 'Seção alterada',
  'menu.category_delete': 'Seção excluída',
  'menu.category_move': 'Seção reordenada',
  'ticket.status': 'Andamento na cozinha',
  'ticket.fire': 'Tempo liberado para a cozinha',
  'tab.service': 'Taxa de serviço alterada',
  'menu.catalog_sync': 'Cardápio atualizado com o catálogo oficial',
  'system.migration': 'Atualização do sistema',
};

function describe(e) {
  const d = e.details || {};
  switch (e.action) {
    case 'order.create':
      return `Mesa ${d.mesa} · #${d.seq} · ${(d.itens || []).map((i) => `${i.qtd}× ${i.item}`).join(', ')} · ${money(d.totalCentavos)}`;
    case 'order.status':
    case 'ticket.status':
      return `Mesa ${d.mesa} · #${d.seq}${d.tempo ? ` · ${d.tempo}` : ''}: ${ORDER_STATUS_LABELS[d.de]} → ${ORDER_STATUS_LABELS[d.para]}`;
    case 'ticket.fire':
      return `Mesa ${d.mesa} · #${d.seq} · ${d.tempo}`;
    case 'tab.service':
      return `Mesa ${d.mesa} · ${d.servico}`;
    case 'item.cancel':
      return `Mesa ${d.mesa} · #${d.seq}: ${d.qtd}× ${d.item} (${money(d.valorCentavos)}) — ${d.motivo}`;
    case 'tab.close':
      return `Mesa ${d.mesa} · ${money(d.totalCentavos)}${d.servicoCentavos ? ` (serviço ${money(d.servicoCentavos)})` : ''}`;
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
  const panel = useMemo(() => ({ menu: <MenuEditor />, config: <ConfigPanel />, audit: <AuditPanel />, backup: <BackupPanel /> })[tab], [tab]);
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
