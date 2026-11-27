import { useState } from 'react';
import { MENU_GROUPS, COURSE_OPTIONS } from '../../../../shared/constants.js';
import { useAppState, api, toast } from '../../lib/store.js';
import { money } from '../../lib/util.js';
import { Icon, Modal, ConfirmDialog } from '../../components/ui.jsx';

const STEP = ['entrada', 'principal', 'sobremesa'];
const COURSE_LABEL = Object.fromEntries(COURSE_OPTIONS);

function parsePrice(text) {
  const t = String(text).trim().replace(/[R$\s]/g, '');
  if (!/^\d+([.,]\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t.replace(',', '.')) * 100);
}

const groupTitle = (g, settings) => (g.key === 'proposta' ? settings.proposalTitle || g.title : g.title);
const enc = encodeURIComponent;

// ------------------------------------------------------------------ item

function MenuItemForm({ item, defaultCategory, onClose }) {
  const s = useAppState();
  const [form, setForm] = useState({
    name: item?.name || '',
    description: item?.description || '',
    category: item?.category || defaultCategory || s.categories[0]?.name || '',
    price: item ? (item.priceCents / 100).toFixed(2).replace('.', ',') : '',
    active: item ? item.active : true,
    inCombo: item ? item.inCombo : false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const cat = s.categories.find((c) => c.name === form.category);

  async function save() {
    const priceCents = parsePrice(form.price);
    if (priceCents == null) return setError('Preço inválido. Use, por exemplo, 62,00.');
    setBusy(true);
    setError('');
    try {
      const body = { name: form.name, description: form.description, category: form.category, priceCents, active: form.active, inCombo: form.inCombo };
      if (item) await api(`/api/admin/menu/${item.id}`, { method: 'PUT', body });
      else await api('/api/admin/menu', { method: 'POST', body });
      toast(item ? 'Item atualizado' : 'Item incluído no cardápio', 'ok');
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
          <button className="btn-primary" onClick={save} disabled={busy} data-testid="salvar-item">
            Salvar
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <div>
          <label className="label" htmlFor="item-nome">Nome</label>
          <input id="item-nome" className="input" value={form.name} onChange={set('name')} maxLength={80} />
        </div>
        <div>
          <label className="label" htmlFor="item-desc">Descrição</label>
          <textarea id="item-desc" className="input min-h-20 py-2" value={form.description} onChange={set('description')} maxLength={400} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="item-secao">Seção</label>
            <select id="item-secao" className="input" value={form.category} onChange={set('category')}>
              {MENU_GROUPS.map((g) => (
                <optgroup key={g.key} label={groupTitle(g, s.settings)}>
                  {s.categories
                    .filter((c) => c.group === g.key)
                    .map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="item-preco">Preço (R$)</label>
            <input id="item-preco" className="input" inputMode="decimal" value={form.price} onChange={set('price')} placeholder="0,00" />
          </div>
        </div>
        <label className="flex min-h-12 items-center gap-3 font-semibold">
          <input type="checkbox" className="h-6 w-6 accent-basilico-700" checked={form.active} onChange={set('active')} /> Disponível no cardápio
        </label>
        {cat?.course === 'combo' && (
          <p className="rounded-xl bg-oro-100 p-3 text-sm">
            Item composto: o garçom escolhe entrada, prato principal e sobremesa entre os pratos marcados como "faz parte do Menu Completo". O preço cobrado é o deste item, e a cozinha recebe um tempo por vez.
          </p>
        )}
        {STEP.includes(cat?.course) && (
          <label className="flex min-h-12 items-center gap-3 font-semibold">
            <input type="checkbox" className="h-6 w-6 accent-basilico-700" checked={form.inCombo} onChange={set('inCombo')} /> Faz parte do Menu Completo ({COURSE_LABEL[cat.course]})
          </label>
        )}
        {cat && (
          <p className="text-sm text-seppia">
            Seção "{cat.name}": {cat.kitchen ? 'vai para a tela da cozinha' : 'não vai para a cozinha (só entra na conta)'}
            {cat.inService ? '' : '; não entra no cálculo dos 10%'}.
          </p>
        )}
        {item && <p className="text-sm text-seppia">Mudanças de preço valem só para pedidos novos; contas já lançadas mantêm o preço do momento do pedido.</p>}
        {error && <p className="font-semibold text-pomodoro-700">{error}</p>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ seção

function CategoryForm({ category, defaultGroup, onClose }) {
  const s = useAppState();
  const [form, setForm] = useState({
    name: category?.name || '',
    group: category?.group || defaultGroup || 'proposta',
    kitchen: category ? category.kitchen : true,
    course: category?.course || '',
    inService: category ? category.inService : true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = { ...form, course: form.course || null };
      if (category) await api(`/api/admin/categories/${enc(category.name)}`, { method: 'PUT', body });
      else await api('/api/admin/categories', { method: 'POST', body });
      toast(category ? 'Seção atualizada' : 'Seção criada', 'ok');
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
      title={category ? `Editar seção "${category.name}"` : 'Nova seção do cardápio'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={save} disabled={busy} data-testid="salvar-secao">
            Salvar
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <div>
          <label className="label" htmlFor="secao-nome">Nome da seção</label>
          <input id="secao-nome" className="input" value={form.name} onChange={set('name')} maxLength={40} placeholder="Ex.: Petiscos" />
        </div>
        <div>
          <label className="label" htmlFor="secao-grupo">Parte do cardápio</label>
          <select id="secao-grupo" className="input" value={form.group} onChange={set('group')}>
            {MENU_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {groupTitle(g, s.settings)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-12 items-center gap-3 font-semibold">
          <input type="checkbox" className="h-6 w-6 accent-basilico-700" checked={form.kitchen} onChange={set('kitchen')} /> Vai para a tela da cozinha
        </label>
        <div>
          <label className="label" htmlFor="secao-tempo">Tempo no Menu Completo</label>
          <select id="secao-tempo" className="input" value={form.course} onChange={set('course')}>
            {COURSE_OPTIONS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-seppia">
            Em pedido com Menu Completo, a cozinha recebe um tempo por vez: a entrada sai na hora; prato principal e sobremesa aguardam o garçom liberar.
          </p>
        </div>
        <label className="flex min-h-12 items-center gap-3 font-semibold">
          <input type="checkbox" className="h-6 w-6 accent-basilico-700" checked={form.inService} onChange={set('inService')} /> Entra no cálculo da taxa de serviço (10%)
        </label>
        {category && form.name !== category.name && <p className="text-sm text-seppia">Os itens desta seção passam a aparecer com o novo nome.</p>}
        {error && <p className="font-semibold text-pomodoro-700">{error}</p>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ editor

function IconButton({ icon, label, onClick, danger, disabled }) {
  return (
    <button className={`btn-ghost !min-h-11 !px-2.5 ${danger ? 'text-pomodoro-700' : ''}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <Icon name={icon} className="h-5 w-5" />
    </button>
  );
}

export default function MenuEditor() {
  const s = useAppState();
  const [itemForm, setItemForm] = useState(null); // { item?, category? }
  const [catForm, setCatForm] = useState(null); // { category?, group? }
  const [removing, setRemoving] = useState(null); // { type: 'item'|'category', target }

  const call = async (fn, ok) => {
    try {
      const r = await fn();
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'ok');
    } catch (e) {
      toast(e.message, 'error', 6000);
    }
  };
  const moveItem = (m, dir) => call(() => api(`/api/admin/menu/${m.id}/move`, { method: 'POST', body: { dir } }));
  const moveCat = (c, dir) => call(() => api(`/api/admin/categories/${enc(c.name)}/move`, { method: 'POST', body: { dir } }));
  const toggle = (m) => call(() => api(`/api/admin/menu/${m.id}`, { method: 'PUT', body: { active: !m.active } }));

  async function confirmRemove() {
    const { type, target } = removing;
    setRemoving(null);
    if (type === 'item') {
      await call(
        () => api(`/api/admin/menu/${target.id}`, { method: 'DELETE' }),
        (r) => (r.result === 'deleted' ? `"${target.name}" excluído do cardápio` : `"${target.name}" removido do cardápio (mantido só no histórico de contas antigas)`),
      );
    } else {
      await call(() => api(`/api/admin/categories/${enc(target.name)}`, { method: 'DELETE' }), `Seção "${target.name}" excluída`);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-seppia">
          {s.menu.filter((m) => m.active).length} de {s.menu.length} itens disponíveis · {s.categories.length} seções. Mudanças aparecem na hora em todos os aparelhos.
        </p>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setCatForm({})} data-testid="nova-secao">
            <Icon name="plus" /> Nova seção
          </button>
          <button className="btn-primary" onClick={() => setItemForm({})} data-testid="novo-item">
            <Icon name="plus" /> Novo item
          </button>
        </div>
      </div>

      {MENU_GROUPS.map((g) => {
        const cats = s.categories.filter((c) => c.group === g.key);
        return (
          <div key={g.key} className="mb-6">
            <div className="mb-2 flex items-center gap-3">
              <h2 className="font-serif text-2xl font-bold tracking-wide text-basilico-800 uppercase">{groupTitle(g, s.settings)}</h2>
              <span className="h-0 flex-1 border-t-2 border-dashed border-crema-400" />
              <button className="btn-ghost !min-h-10 text-sm" onClick={() => setCatForm({ group: g.key })}>
                <Icon name="plus" className="h-4 w-4" /> Seção
              </button>
            </div>
            {!cats.length && <p className="text-sm text-seppia">Nenhuma seção nesta parte do cardápio.</p>}
            {cats.map((c, ci) => {
              const items = s.menu.filter((m) => m.category === c.name);
              return (
                <section key={c.name} className="mb-4" data-testid={`secao-${c.name}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="font-serif text-xl font-bold text-pomodoro-700">{c.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${c.kitchen ? 'bg-basilico-100 text-basilico-800' : 'bg-crema-200 text-seppia'}`}>
                      {c.kitchen ? 'vai para a cozinha' : 'sem cozinha'}
                    </span>
                    {c.course && <span className="rounded-full bg-oro-200 px-2 py-0.5 text-xs font-bold text-oro-700">{c.course === 'combo' ? 'Menu Completo' : `tempo: ${COURSE_LABEL[c.course]}`}</span>}
                    {!c.inService && <span className="rounded-full bg-crema-200 px-2 py-0.5 text-xs font-bold text-seppia">fora dos 10%</span>}
                    <span className="ml-auto flex gap-1">
                      <IconButton icon="up" label={`Subir seção ${c.name}`} onClick={() => moveCat(c, -1)} disabled={ci === 0} />
                      <IconButton icon="down" label={`Descer seção ${c.name}`} onClick={() => moveCat(c, 1)} disabled={ci === cats.length - 1} />
                      <IconButton icon="note" label={`Editar seção ${c.name}`} onClick={() => setCatForm({ category: c })} />
                      <IconButton icon="trash" label={`Excluir seção ${c.name}`} danger onClick={() => setRemoving({ type: 'category', target: c })} />
                    </span>
                  </div>
                  <ul className="card divide-y divide-crema-200">
                    {items.map((m, i) => (
                      <li key={m.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${m.active ? '' : 'opacity-60'}`}>
                        <div className="min-w-0 flex-1 basis-48">
                          <p className="font-semibold">
                            {m.name}
                            {m.inCombo && <span className="ml-2 rounded-full bg-oro-200 px-2 py-0.5 text-xs font-bold text-oro-700">Menu Completo</span>}
                          </p>
                          <p className="truncate text-sm text-seppia">{m.description}</p>
                        </div>
                        <span className="font-bold tabular-nums">{money(m.priceCents)}</span>
                        <IconButton icon="up" label={`Subir ${m.name}`} onClick={() => moveItem(m, -1)} disabled={i === 0} />
                        <IconButton icon="down" label={`Descer ${m.name}`} onClick={() => moveItem(m, 1)} disabled={i === items.length - 1} />
                        <button
                          className={`min-h-11 min-w-28 rounded-full px-3 text-sm font-bold ${m.active ? 'bg-basilico-700 text-white' : 'bg-crema-300 text-inchiostro'}`}
                          onClick={() => toggle(m)}
                          aria-pressed={m.active}
                        >
                          {m.active ? 'Ativo' : 'Desativado'}
                        </button>
                        <IconButton icon="note" label={`Editar ${m.name}`} onClick={() => setItemForm({ item: m })} />
                        <IconButton icon="trash" label={`Excluir ${m.name}`} danger onClick={() => setRemoving({ type: 'item', target: m })} />
                      </li>
                    ))}
                    <li>
                      <button className="flex min-h-12 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-basilico-700" onClick={() => setItemForm({ category: c.name })}>
                        <Icon name="plus" className="h-4 w-4" /> Adicionar item em {c.name}
                      </button>
                    </li>
                  </ul>
                </section>
              );
            })}
          </div>
        );
      })}

      {itemForm && <MenuItemForm item={itemForm.item} defaultCategory={itemForm.category} onClose={() => setItemForm(null)} />}
      {catForm && <CategoryForm category={catForm.category} defaultGroup={catForm.group} onClose={() => setCatForm(null)} />}
      <ConfirmDialog
        open={!!removing}
        danger
        title={removing?.type === 'category' ? `Excluir a seção "${removing?.target.name}"?` : `Excluir "${removing?.target.name}"?`}
        message={
          removing?.type === 'category'
            ? 'Só é possível excluir uma seção vazia. Mova ou exclua os itens dela antes.'
            : 'O item sai do cardápio. Se ele já foi pedido alguma vez, as contas e relatórios antigos continuam mostrando-o corretamente.'
        }
        confirmLabel="Excluir"
        onCancel={() => setRemoving(null)}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
