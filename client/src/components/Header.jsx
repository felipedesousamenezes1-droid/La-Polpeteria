import { useState } from 'react';
import { ROLE_LABELS } from '../../../shared/constants.js';
import { useAppState, logout, setScreen, outboxActions } from '../lib/store.js';
import { Icon, ConfirmDialog } from './ui.jsx';

export function Logo({ size = 'md' }) {
  const big = size === 'lg';
  return (
    <div className="flex flex-col leading-none">
      <span className={`font-serif font-bold whitespace-nowrap italic text-basilico-800 ${big ? 'text-5xl' : 'text-xl sm:text-2xl'}`}>La Pulpeteria</span>
      <span className={`mt-1 font-semibold whitespace-nowrap text-oro-600 uppercase ${big ? 'text-sm tracking-[0.35em]' : 'text-[8px] tracking-[0.18em] sm:text-[10px] sm:tracking-[0.35em]'}`}>
        trattoria · cucina italiana
      </span>
    </div>
  );
}

/** Indicador sempre visível: "Sincronizado" ou "X pedidos pendentes". */
export function SyncStatus() {
  const s = useAppState();
  const { pending, rejected } = s.outbox;
  const showOutbox = s.session && s.session.role !== 'cozinha';

  if (showOutbox && rejected > 0) {
    return (
      <span className="inline-flex min-h-10 items-center gap-1.5 rounded-full whitespace-nowrap text-[13px] sm:text-sm bg-pomodoro-600 px-3 font-bold text-white" data-testid="sync-status">
        <Icon name="alert" className="h-4 w-4" />
        {rejected} recusado{rejected > 1 ? 's' : ''}
      </span>
    );
  }
  if (showOutbox && pending > 0) {
    return (
      <button onClick={() => outboxActions.retryNow()} className="inline-flex min-h-10 items-center gap-1.5 rounded-full whitespace-nowrap text-[13px] sm:text-sm bg-oro-400 px-3 font-bold text-inchiostro" data-testid="sync-status" title="Tentar enviar agora">
        <Icon name="clock" className="h-4 w-4" />
        {pending} pedido{pending > 1 ? 's' : ''} pendente{pending > 1 ? 's' : ''}
      </button>
    );
  }
  if (!s.connected) {
    return (
      <span className="inline-flex min-h-10 items-center gap-1.5 rounded-full whitespace-nowrap text-[13px] sm:text-sm bg-pomodoro-100 px-3 font-bold text-pomodoro-800" data-testid="sync-status">
        <Icon name="wifiOff" className="h-4 w-4" />
        {s.online ? 'Reconectando…' : 'Sem conexão'}
      </span>
    );
  }
  return (
    <span className="inline-flex min-h-10 items-center gap-1.5 rounded-full whitespace-nowrap text-[13px] sm:text-sm bg-basilico-100 px-3 font-bold text-basilico-800" data-testid="sync-status">
      <Icon name="check" className="h-4 w-4" />
      Sincronizado
    </span>
  );
}

const SCREENS = [
  ['admin', 'Admin'],
  ['garcom', 'Garçom'],
  ['cozinha', 'Cozinha'],
  ['caixa', 'Caixa'],
];

export function Header({ screen }) {
  const s = useAppState();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const role = s.session?.role;
  return (
    <header className="sticky top-0 z-30 border-b border-crema-300 bg-crema-50/95 backdrop-blur print:hidden">
      <div className="tricolore h-1.5" />
      <div className="flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
        <Logo />
        <span className="hidden rounded-full border border-oro-300 bg-oro-100 px-3 py-1 text-sm font-semibold text-oro-700 sm:inline">
          {ROLE_LABELS[screen]}
          {s.session?.name ? ` · ${s.session.name}` : ''}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <SyncStatus />
          {role === 'admin' && (
            <select className="input !min-h-10 !w-auto !py-0 text-sm font-semibold" value={screen} onChange={(e) => setScreen(e.target.value)} aria-label="Trocar tela">
              {SCREENS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          )}
          <button className="btn-ghost !min-h-10 !px-3" onClick={() => setConfirmLogout(true)} aria-label="Sair" title="Sair">
            <Icon name="logout" className="h-5 w-5" />
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmLogout}
        title="Sair deste aparelho?"
        message={
          s.outbox.pending > 0
            ? `Há ${s.outbox.pending} pedido(s) pendente(s). Eles continuam salvos neste aparelho e serão enviados quando alguém entrar com o PIN de Garçom.`
            : 'Será necessário digitar o PIN novamente.'
        }
        confirmLabel="Sair"
        onCancel={() => setConfirmLogout(false)}
        onConfirm={() => {
          setConfirmLogout(false);
          logout();
        }}
      />
    </header>
  );
}

export function Toasts() {
  const s = useAppState();
  if (!s.toasts.length) return null;
  const tones = {
    ok: 'bg-basilico-700 text-white',
    error: 'bg-pomodoro-600 text-white',
    info: 'bg-inchiostro text-crema-50',
  };
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-[60] flex flex-col items-center gap-2 px-3 print:hidden" aria-live="polite">
      {s.toasts.map((t) => (
        <div key={t.id} className={`pointer-events-auto max-w-lg rounded-2xl px-4 py-3 text-base font-semibold shadow-lg ${tones[t.kind] || tones.info}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
