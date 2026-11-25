import { useState } from 'react';

/*
 * Gráficos leves em HTML/CSS (sem biblioteca): uma série por gráfico, uma cor,
 * barras finas com ponta arredondada, valores em cor de texto e leitura ao tocar/passar o mouse.
 */

const TONES = {
  verde: { bar: 'bg-basilico-600', hover: 'bg-basilico-800' },
  vermelho: { bar: 'bg-pomodoro-500', hover: 'bg-pomodoro-700' },
  dourado: { bar: 'bg-oro-500', hover: 'bg-oro-700' },
};

/** Barras horizontais (rankings). rows: [{ key, label, value, display, detail }] */
export function HBarChart({ rows, tone = 'verde', emptyText = 'Sem dados no período.' }) {
  const [hover, setHover] = useState(null);
  if (!rows.length) return <p className="py-6 text-center text-sm text-seppia">{emptyText}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const t = TONES[tone];
  return (
    <ul className="space-y-2.5" role="list">
      {rows.map((r, i) => (
        <li
          key={r.key ?? r.label}
          className="cursor-default"
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          onClick={() => setHover(hover === i ? null : i)}
          title={r.detail || `${r.label}: ${r.display}`}
        >
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-semibold">
              <span className="mr-1.5 text-seppia tabular-nums">{i + 1}.</span>
              {r.label}
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{r.display}</span>
          </div>
          <div className="h-3 w-full rounded-r bg-crema-200">
            <div className={`h-3 rounded-r-[4px] ${hover === i ? t.hover : t.bar}`} style={{ width: `${Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0)}%` }} />
          </div>
          {hover === i && r.detail && <p className="mt-1 text-xs text-seppia">{r.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Colunas verticais (por dia / por horário). rows: [{ key, label, value, display, detail }] */
export function VBarChart({ rows, tone = 'verde', height = 180, emptyText = 'Sem dados no período.', unitHint }) {
  const [hover, setHover] = useState(null);
  if (!rows.length || rows.every((r) => !r.value)) return <p className="py-6 text-center text-sm text-seppia">{emptyText}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const t = TONES[tone];
  const peak = rows.reduce((a, r, i) => (r.value > rows[a].value ? i : a), 0);
  const shown = hover ?? peak;
  return (
    <div>
      <p className="mb-2 min-h-5 text-sm" aria-live="polite">
        <span className="font-semibold">{rows[shown].detail || `${rows[shown].label}: ${rows[shown].display}`}</span>
        {hover == null && <span className="text-seppia"> · maior valor{unitHint ? ` (${unitHint})` : ''}</span>}
      </p>
      <div className="flex items-end gap-[2px] border-b border-crema-400" style={{ height }}>
        {rows.map((r, i) => (
          <button
            key={r.key ?? r.label}
            type="button"
            className="group flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onClick={() => setHover(hover === i ? null : i)}
            aria-label={r.detail || `${r.label}: ${r.display}`}
          >
            <span className={`mx-auto block w-full max-w-10 rounded-t-[4px] ${hover === i ? t.hover : t.bar}`} style={{ height: `${(r.value / max) * 100}%`, minHeight: r.value > 0 ? 3 : 0 }} />
          </button>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px]">
        {rows.map((r, i) => (
          <span key={r.key ?? r.label} className={`min-w-0 flex-1 truncate text-center text-[11px] tabular-nums ${hover === i ? 'font-bold text-inchiostro' : 'text-seppia'}`}>
            {r.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ChartCard({ title, subtitle, children, right, className = '' }) {
  return (
    <section className={`card p-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-serif text-xl font-bold">{title}</h3>
          {subtitle && <p className="text-sm text-seppia">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone = '' }) {
  return (
    <div className={`card p-3 ${tone}`}>
      <p className="text-xs font-bold tracking-wide text-seppia uppercase">{label}</p>
      <p className="font-serif text-2xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-seppia">{sub}</p>}
    </div>
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-xl border-2 border-crema-300 bg-crema-100 p-1">
      {options.map(([k, l]) => (
        <button key={k} type="button" onClick={() => onChange(k)} className={`min-h-10 rounded-lg px-3 text-sm font-bold ${value === k ? 'bg-basilico-700 text-white' : 'text-inchiostro'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}
