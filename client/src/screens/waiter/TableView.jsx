import { useMemo, useState } from 'react';
import { MENU_GROUPS, QUICK_NOTES, TAB_STATUS_LABELS, COMBO_CATEGORY, COMBO_STEPS } from '../../../../shared/constants.js';
import { useAppState, addToDraft, setDraft, submitDraft, activeTabFor, toast, getState } from '../../lib/store.js';
import { money, normalize, vibrate } from '../../lib/util.js';
import { Icon, Modal, QtyStepper, ComboParts } from '../../components/ui.jsx';
import TabOrders from './TabOrders.jsx';

function comboOptions(menu) {
  return COMBO_STEPS.map((step) => menu.filter((m) => m.active && m.inCombo && step.categories.includes(m.category)));
}

/** Menu Completo: uma escolha por etapa; com a última escolha o item entra no pedido (sem toque extra). */
function ComboPicker({ combo, table, onClose }) {
  const s = useAppState();
  const options = useMemo(() => comboOptions(s.menu), [s.menu]);
  const [picked, setPicked] = useState(() => options.map((o) => (o.length === 1 ? o[0] : null)));
  function choose(i, m) {
    const next = [...picked];
    next[i] = m;
    setPicked(next);
    if (next.every(Boolean)) {
      addToDraft(table, combo, COMBO_STEPS.map((st, k) => ({ step: st.label, menuItemId: next[k].id, name: next[k].name })));
      vibrate(12);
      toast(`${combo.name} adicionado`, 'ok', 1500);
      onClose();
    }
  }
  return (
    <Modal open onClose={onClose} title={`${combo.name} · ${money(combo.priceCents)}`} size="lg">
      {COMBO_STEPS.map((step, i) => (
        <section key={step.key} className="mb-4">
          <h3 className="mb-2 font-serif text-lg font-bold text-pomodoro-700">
            {i + 1}. {step.label}
          </h3>
          {!options[i].length && <p className="text-sm text-seppia">Nenhuma opção ativa. Marque pratos como "faz parte do Menu Completo" no Admin.</p>}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {options[i].map((m) => (
              <button
                key={m.id}
                onClick={() => choose(i, m)}
                data-testid={`combo-${step.key}-${m.id}`}
                className={`min-h-14 rounded-2xl border-2 px-3 py-2 text-left font-semibold transition-transform duration-75 active:scale-[0.98] ${
                  picked[i]?.id === m.id ? 'border-basilico-700 bg-basilico-700 text-white' : 'border-crema-300 bg-white'
                }`}
              >
                {m.name}
              </button>
            ))}
          </div>
        </section>
      ))}
    </Modal>
  );
}

function MenuPicker({ table, lines }) {
  const s = useAppState();
  const [combo, setCombo] = useState(null);
  function tap(m) {
    if (m.category === COMBO_CATEGORY) {
      const opts = comboOptions(s.menu);
      if (opts.every((o) => o.length === 1)) {
        addToDraft(table, m, COMBO_STEPS.map((st, k) => ({ step: st.label, menuItemId: opts[k][0].id, name: opts[k][0].name })));
        vibrate(12);
      } else setCombo(m);
      return;
    }
    addToDraft(table, m);
    vibrate(12);
  }
  const [sel, setSel] = useState('todos');
  const groupTitle = (g) => (g.key === 'proposta' ? s.settings.proposalTitle || g.title : g.title);
  const [query, setQuery] = useState('');
  const qtyByItem = useMemo(() => {
    const m = new Map();
    for (const l of lines) m.set(l.menuItemId, (m.get(l.menuItemId) || 0) + l.qty);
    return m;
  }, [lines]);

  const items = useMemo(() => {
    const active = s.menu.filter((m) => m.active);
    const q = normalize(query.trim());
    if (q) return active.filter((m) => normalize(`${m.name} ${m.description}`).includes(q));
    if (sel === 'todos') return active;
    const cats = MENU_GROUPS.find((g) => g.key === sel)?.categories || [];
    return active.filter((m) => cats.includes(m.category));
  }, [s.menu, sel, query]);

  // Seções do cardápio da casa: grupo (Bebidas, Proposta, Vinhos) → categoria → itens.
  const groups = useMemo(
    () =>
      MENU_GROUPS.map((g) => ({
        ...g,
        cats: g.categories.map((c) => [c, items.filter((m) => m.category === c)]).filter(([, l]) => l.length),
      })).filter((g) => g.cats.length),
    [items],
  );

  return (
    <>
      <div className="space-y-2 border-b border-crema-300 bg-crema-100 px-3 pt-2 pb-2">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-seppia" />
          <input className="input !pl-10" placeholder="Buscar prato ou bebida…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar no cardápio" />
          {query && (
            <button className="absolute top-1/2 right-1 h-10 w-10 -translate-y-1/2 rounded-lg text-seppia" onClick={() => setQuery('')} aria-label="Limpar busca">
              <Icon name="close" className="mx-auto h-5 w-5" />
            </button>
          )}
        </div>
        <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]">
          {[{ key: 'todos', title: 'Todos' }, ...MENU_GROUPS].map((g) => (
            <button
              key={g.key}
              onClick={() => {
                setSel(g.key);
                setQuery('');
              }}
              className={`chip ${sel === g.key && !query ? 'border-basilico-700 bg-basilico-700 text-white' : 'border-crema-300 bg-crema-50 text-inchiostro'}`}
            >
              {g.key === 'todos' ? 'Todos' : groupTitle(g)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pt-2 pb-4">
        {groups.length === 0 && <p className="py-10 text-center text-seppia">Nenhum item encontrado.</p>}
        {groups.map((g) => (
          <div key={g.key} className="mb-2">
            <h2 className="mt-1 mb-1 text-center font-serif text-2xl font-bold tracking-wide text-basilico-800 uppercase">{groupTitle(g)}</h2>
        {g.cats.map(([c, list]) => (
          <section key={c} className="mb-3">
            <h3 className="sticky top-0 z-10 -mx-3 flex items-center gap-3 bg-crema-100 px-3 py-1 font-serif text-xl font-semibold text-pomodoro-700">
              {c}
              <span className="h-0 flex-1 border-t-2 border-dashed border-pomodoro-200" />
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {list.map((m) => {
                const qty = qtyByItem.get(m.id) || 0;
                return (
                  <button
                    key={m.id}
                    data-testid={`item-${m.id}`}
                    onClick={() => tap(m)}
                    className={`flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 px-3 py-2 text-left transition-transform duration-75 active:scale-[0.98] ${
                      qty ? 'border-basilico-600 bg-basilico-50' : m.category === COMBO_CATEGORY ? 'border-oro-400 bg-oro-100' : 'border-crema-300 bg-white'
                    }`}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-bold ${qty ? 'bg-basilico-700 text-white' : 'bg-crema-200 text-seppia'}`}>
                      {qty || <Icon name="plus" className="h-5 w-5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base leading-tight font-semibold">{m.name}</span>
                      <span className="block truncate text-sm text-seppia">{m.description}</span>
                    </span>
                    <span className="shrink-0 text-base font-bold text-basilico-800 tabular-nums">{money(m.priceCents)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
          </div>
        ))}
      </div>
      {combo && <ComboPicker combo={combo} table={table} onClose={() => setCombo(null)} />}
    </>
  );
}

function NoteEditor({ line, onChange }) {
  const quick = QUICK_NOTES[line.category] || [];
  const parts = line.notes ? line.notes.split(', ').filter(Boolean) : [];
  const toggle = (n) => {
    const next = parts.includes(n) ? parts.filter((p) => p !== n) : [...parts, n];
    onChange(next.join(', '));
  };
  return (
    <div className="mt-2 rounded-xl bg-crema-100 p-2">
      <div className="flex flex-wrap gap-2">
        {quick.map((n) => (
          <button key={n} onClick={() => toggle(n)} className={`chip !min-h-11 ${parts.includes(n) ? 'border-pomodoro-600 bg-pomodoro-600 text-white' : 'border-crema-300 bg-white'}`}>
            {n}
          </button>
        ))}
      </div>
      <input className="input mt-2" placeholder="Outra observação…" value={line.notes} maxLength={140} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function CartSheet({ open, onClose, table, lines, onSend, sending }) {
  const [editing, setEditing] = useState(null);
  const total = lines.reduce((a, l) => a + l.qty * l.priceCents, 0);
  const update = (key, patch) => {
    const next = lines.map((l) => (l.key === key ? { ...l, ...patch } : l)).filter((l) => l.qty > 0);
    setDraft(table, next);
    if (!next.length) onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Pedido · Mesa ${table}`}
      footer={
        <button className="btn-primary min-h-14 w-full text-lg" onClick={onSend} disabled={!lines.length || sending} data-testid="enviar-cozinha-modal">
          {sending ? 'Salvando…' : `Enviar para a cozinha · ${money(total)}`}
        </button>
      }
    >
      <ul className="divide-y divide-crema-300">
        {lines.map((l) => (
          <li key={l.key} className="py-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="leading-tight font-semibold">{l.name}</p>
                <ComboParts components={l.components} />
                <p className="text-sm text-seppia tabular-nums">
                  {money(l.priceCents)} · subtotal {money(l.priceCents * l.qty)}
                </p>
              </div>
              <QtyStepper value={l.qty} onChange={(qty) => update(l.key, { qty })} />
            </div>
            {l.notes && editing !== l.key && <p className="mt-1 rounded-lg bg-pomodoro-50 px-2 py-1 text-sm font-semibold text-pomodoro-800">Obs.: {l.notes}</p>}
            <button className="mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-basilico-700" onClick={() => setEditing(editing === l.key ? null : l.key)}>
              <Icon name="note" className="h-4 w-4" />
              {editing === l.key ? 'Concluir observação' : l.notes ? 'Editar observação' : 'Adicionar observação'}
            </button>
            {editing === l.key && <NoteEditor line={l} onChange={(notes) => update(l.key, { notes })} />}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export default function TableView({ table, onBack }) {
  const s = useAppState();
  const lines = s.drafts[table] || [];
  const [view, setView] = useState('menu');
  const [cartOpen, setCartOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const tab = activeTabFor(table);
  const total = lines.reduce((a, l) => a + l.qty * l.priceCents, 0);
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const sentCount = Object.values(s.orders).filter((o) => tab && o.tabId === tab.id).length;
  const localCount = s.outbox.list.filter((e) => e.tableNumber === table && (e.status === 'pending' || e.status === 'rejected')).length;

  async function send() {
    if (sending) return;
    setSending(true);
    try {
      const entry = await submitDraft(table);
      setCartOpen(false);
      onBack();
      // Se em 1,5 s não houver confirmação, avisa que ficou guardado no aparelho.
      setTimeout(() => {
        const e = getState().outbox.list.find((x) => x.id === entry?.id);
        if (e?.status === 'pending') toast(`Mesa ${table}: sem conexão. Pedido guardado no aparelho; será enviado automaticamente.`, 'info', 6000);
      }, 1500);
    } catch (err) {
      toast(`Não foi possível salvar o pedido neste aparelho: ${err.message}. O carrinho foi mantido.`, 'error', 9000);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-crema-300 bg-crema-50 px-2 py-2">
        <button className="btn-ghost !px-3" onClick={onBack} aria-label="Voltar às mesas" data-testid="voltar-mesas">
          <Icon name="back" />
          <span className="hidden sm:inline">Mesas</span>
        </button>
        <div className="min-w-0">
          <h1 className="font-serif text-2xl leading-none font-bold">Mesa {table}</h1>
          <p className="text-xs font-semibold text-seppia">
            {tab ? `${TAB_STATUS_LABELS[tab.status]} · ${money(tab.totalCents)}` : localCount ? 'Pedido pendente de envio' : 'Livre'}
          </p>
        </div>
        <div className="ml-auto flex rounded-xl border-2 border-crema-300 bg-crema-100 p-1">
          <button className={`min-h-11 rounded-lg px-3 text-sm font-bold ${view === 'menu' ? 'bg-basilico-700 text-white' : 'text-inchiostro'}`} onClick={() => setView('menu')}>
            Cardápio
          </button>
          <button
            className={`min-h-11 rounded-lg px-3 text-sm font-bold ${view === 'conta' ? 'bg-basilico-700 text-white' : 'text-inchiostro'}`}
            onClick={() => setView('conta')}
            data-testid="ver-conta-mesa"
          >
            Conta ({sentCount + localCount})
          </button>
        </div>
      </div>

      {view === 'menu' ? <MenuPicker table={table} lines={lines} /> : <TabOrders table={table} tab={tab} onBack={onBack} />}

      {view === 'menu' && (
        <div className="border-t-2 border-crema-300 bg-crema-50 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
          {lines.length > 0 ? (
            <button className="mb-2 flex w-full items-center gap-2 rounded-xl px-1 text-left" onClick={() => setCartOpen(true)} data-testid="resumo-pedido">
              <span className="shrink-0 rounded-full bg-basilico-700 px-2 py-0.5 text-sm font-bold text-white">
                {count} {count > 1 ? 'itens' : 'item'}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-seppia">
                {lines.map((l) => `${l.qty}× ${l.name}${l.notes ? ' *' : ''}`).join(' · ')}
              </span>
              <span className="shrink-0 text-sm font-bold text-basilico-700 underline">editar / obs.</span>
            </button>
          ) : (
            <p className="mb-2 text-center text-sm text-seppia">Toque nos pratos para adicionar ao pedido.</p>
          )}
          <button className="btn-primary min-h-14 w-full text-lg" disabled={!lines.length || sending} onClick={send} data-testid="enviar-cozinha">
            {sending ? 'Salvando…' : lines.length ? `Enviar para a cozinha · ${money(total)}` : 'Enviar para a cozinha'}
          </button>
        </div>
      )}

      <CartSheet open={cartOpen} onClose={() => setCartOpen(false)} table={table} lines={lines} onSend={send} sending={sending} />
    </div>
  );
}
