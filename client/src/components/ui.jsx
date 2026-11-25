import { useEffect, useRef, useState } from 'react';

/* Ícones em SVG inline (sem dependências, nítidos em qualquer tela) */
const paths = {
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'M18 6L6 18M6 6l12 12',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  check: 'M20 6L9 17l-5-5',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  note: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z',
  share: 'M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 017.5-2',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  undo: 'M3 7v6h6M3 13a9 9 0 103-7.7L3 8',
  wifi: 'M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M12 20h.01M1.5 9a15 15 0 0121 0',
  wifiOff: 'M1 1l22 22M16.7 11.1A10 10 0 0119 12.5M5 12.5a10 10 0 015.2-2.8M10.7 5.1A15 15 0 0122.5 9M1.5 9a15 15 0 014.2-2.9M8.5 16a5 5 0 017 0M12 20h.01',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  sound: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14',
  mute: 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6',
};

export function Icon({ name, className = 'h-6 w-6', strokeWidth = 2.2 }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md', tone }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-inchiostro/50 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-crema-50 shadow-2xl sm:rounded-3xl ${widths[size]}`}>
        <div className={`flex items-center justify-between gap-3 rounded-t-3xl border-b border-crema-300 px-5 py-3 ${tone === 'danger' ? 'bg-pomodoro-50' : ''}`}>
          <h2 className="font-serif text-xl font-bold">{title}</h2>
          {onClose && (
            <button className="btn-ghost !min-h-11 !px-3" onClick={onClose} aria-label="Fechar">
              <Icon name="close" />
            </button>
          )}
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-crema-300 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

/** Diálogo de confirmação: toda ação irreversível passa por aqui. */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirmar', danger, busy, onConfirm, onCancel, children }) {
  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onCancel}
      title={title}
      size="sm"
      tone={danger ? 'danger' : undefined}
      footer={
        <>
          <button className="btn-ghost flex-1 sm:flex-none" onClick={onCancel} disabled={busy}>
            Voltar
          </button>
          <button className={`${danger ? 'btn-danger' : 'btn-primary'} flex-1 sm:flex-none`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Aguarde…' : confirmLabel}
          </button>
        </>
      }
    >
      {message && <p className="text-base leading-relaxed">{message}</p>}
      {children}
    </Modal>
  );
}

export function QtyStepper({ value, onChange, min = 0, max = 99, size = 'md' }) {
  const h = size === 'lg' ? 'h-14 w-14' : 'h-12 w-12';
  return (
    <div className="inline-flex items-center gap-1">
      <button className={`btn-ghost !min-h-0 !px-0 ${h}`} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="Diminuir">
        <Icon name="minus" />
      </button>
      <span className="w-10 text-center text-xl font-bold tabular-nums">{value}</span>
      <button className={`btn-ghost !min-h-0 !px-0 ${h}`} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="Aumentar">
        <Icon name="plus" />
      </button>
    </div>
  );
}

/** Teclado numérico grande para PIN (Enter no teclado físico confirma). */
export function PinPad({ value, onChange, onSubmit, maxLength = 8, disabled }) {
  const press = (d) => {
    if (disabled) return;
    onChange((value + d).slice(0, maxLength));
  };
  useEffect(() => {
    const onKey = (e) => {
      if (disabled || e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') onChange(value.slice(0, -1));
      else if (e.key === 'Enter' && onSubmit && value.length >= 4) onSubmit(value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="mx-auto w-full max-w-xs">
      <div className="mb-4 flex min-h-4 justify-center gap-3" aria-label="PIN digitado">
        {Array.from({ length: Math.max(4, value.length) }).map((_, i) => (
          <span key={i} className={`h-4 w-4 rounded-full border-2 border-basilico-700 ${i < value.length ? 'bg-basilico-700' : ''}`} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="btn-ghost h-16 text-2xl" onClick={() => press(d)} disabled={disabled}>
            {d}
          </button>
        ))}
        <button type="button" className="btn-ghost h-16 text-base" onClick={() => onChange('')} disabled={disabled}>
          Limpar
        </button>
        <button type="button" className="btn-ghost h-16 text-2xl" onClick={() => press('0')} disabled={disabled}>
          0
        </button>
        <button type="button" className="btn-ghost h-16" onClick={() => onChange(value.slice(0, -1))} disabled={disabled} aria-label="Apagar">
          <Icon name="back" />
        </button>
      </div>
    </div>
  );
}

/** Escolhas de um Menu Completo (entrada / prato principal / sobremesa). */
export function ComboParts({ components, className = 'text-sm', stepClass = 'text-oro-700' }) {
  if (!components?.length) return null;
  return (
    <ul className={`mt-0.5 ${className}`}>
      {components.map((c) => (
        <li key={c.step}>
          <span className={`font-semibold ${stepClass}`}>{c.step}:</span> {c.name}
        </li>
      ))}
    </ul>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function EmptyState({ title, children }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center text-seppia">
      <p className="font-serif text-xl text-inchiostro">{title}</p>
      {children && <div className="mt-2 max-w-sm text-sm">{children}</div>}
    </div>
  );
}
