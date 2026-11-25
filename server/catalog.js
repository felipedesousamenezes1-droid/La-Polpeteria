import { COMBO_CATEGORY } from '../shared/constants.js';
import { nowIso } from './util.js';

/**
 * Cardápio oficial da La Polpeteria (transcrito do cardápio da casa). Preços em centavos.
 * Ao mudar este arquivo, aumente CATALOG_VERSION: o servidor sincroniza o banco na inicialização.
 */
export const CATALOG_VERSION = 2;

const it = (category, name, price, description = '', { inCombo = false } = {}) => ({ category, name, price, description, inCombo });
const SUCO = 'Ver disponibilidade de sabores do dia.';

export const CATALOG = [
  // ---------------- BEBIDAS · Não alcoólicas
  it('Não alcoólicas', 'Água sem gás', 500),
  it('Não alcoólicas', 'Água com gás', 500),
  it('Não alcoólicas', 'Coca-Cola lata', 800),
  it('Não alcoólicas', 'Guaraná lata', 800),
  it('Não alcoólicas', 'H2O', 800),
  it('Não alcoólicas', 'Soda italiana', 1200),
  it('Não alcoólicas', 'Suco copo', 1200, SUCO),
  it('Não alcoólicas', 'Suco jarra', 2700, SUCO),

  // ---------------- BEBIDAS · Alcoólicas
  it('Alcoólicas', 'Heineken long neck', 1200),
  it('Alcoólicas', 'Amstel Ultra lata', 900),
  it('Alcoólicas', 'Taça de vinho da casa', 1500),
  it('Alcoólicas', 'Taça de espumante', 1200),

  // ---------------- BEBIDAS · Drinks alcoólicos
  it('Drinks alcoólicos', 'Aperol Spritz', 2800, 'Aperol, espumante, água com gás, alecrim e rodelas de laranja Bahia.'),
  it('Drinks alcoólicos', 'Hugo Spritz', 2900, 'Xarope de flor de sabugueiro, espumante, água com gás, hortelã e rodelas de limão.'),
  it('Drinks alcoólicos', 'Limoncello Spritz', 3000, 'Limoncello, espumante, água com gás, alecrim e rodelas de limão.'),
  it('Drinks alcoólicos', 'Solare Spritz', 3900, 'Aperitivo Solare, espumante brut, água com gás, limão siciliano e alecrim.'),

  // ---------------- PROPOSTA DO MÊS
  it('Entrada', 'Rotolini di Zucchine', 3600,
    'Rolinhos de abobrinha grelhada, recheados com presunto cru e queijo, delicadamente temperados com ervas e azeite.',
    { inCombo: true }),
  it('Prato principal', 'Risotto alla Pera e Gorgonzola con Polpette al Vino Rosso', 7200,
    'Risoto cremoso de pera e gorgonzola, combinando a doçura delicada da fruta com o sabor marcante do queijo, acompanhado de três polpette ao molho de vinho tinto.',
    { inCombo: true }),
  it('Prato principal', 'Pasta al Pesto alla Trapanese con Polpette al Balsamico', 7200,
    'Macarrão ao pesto trapanese, preparado com tomate, amêndoas e manjericão, acompanhados de três polpette finalizadas com um delicado fio de redução de vinagre balsâmico.',
    { inCombo: true }),
  it('Prato principal', "Pasta all'Ortolana con Polpette al Sugo", 6800,
    'Massa envolvida em um molho leve de vegetais frescos e da estação, acompanhada de três polpette clássicas ao tradicional molho de tomate italiano.',
    { inCombo: true }),
  it('Sobremesa', 'Tiramisu', 2900,
    'Camadas de biscoito embebido em café, creme de mascarpone e cacau, na clássica sobremesa italiana.',
    { inCombo: true }),
  it('Sobremesa', 'Cheesecake alla Ricotta con Composta di Pomodorini', 2900,
    'Cheesecake leve e cremosa de ricota, acompanhada de uma compota artesanal de tomate-cereja, em uma combinação surpreendente de sabores.',
    { inCombo: true }),
  it(COMBO_CATEGORY, 'Menu Completo', 13000, 'Entrada + prato principal + sobremesa.'),

  // ---------------- CARTA DE VINHOS · Tintos
  it('Vinhos tintos', 'La Plata', 6000,
    'Argentina · Meio-seco. Produzido na região de Mendoza, apresenta aromas de frutas vermelhas frescas, corpo médio e paladar macio, com final levemente especiado. Uma opção versátil e agradável.'),
  it('Vinhos tintos', 'Metropolitano Cabernet Sauvignon', 6000,
    'Chile · Seco. Apresenta aromas de frutas vermelhas e negras, com notas de especiarias. Possui corpo médio, taninos presentes e final equilibrado. Ótima opção para acompanhar carnes e massas.'),
  it('Vinhos tintos', 'Trapiche Vineyards Malbec', 7900,
    'Argentina · Seco. Com aromas de ameixas e cerejas, apresenta paladar redondo, taninos macios e notas sutis de especiarias. Um Malbec equilibrado e frutado, com boa presença em boca.'),
  it('Vinhos tintos', 'Esteban Martín', 8500,
    'Espanha · Seco. Um elegante corte de três uvas espanholas (Garnacha, Syrah e Tempranillo), com aromas de frutas vermelhas e negras maduras, notas florais e especiarias. Corpo médio, boa acidez e taninos aveludados.'),
  it('Vinhos tintos', 'Esperanto Primitivo di Puglia', 10500,
    'Itália · Meio-seco. Originário da Puglia, elaborado com a uva Primitivo. Intenso e envolvente, com aromas de frutas negras maduras, ameixas e especiarias. Encorpado, paladar macio e agradável dulçor, com final persistente.'),

  // ---------------- CARTA DE VINHOS · Brancos
  it('Vinhos brancos', 'Fontegaia Bianco', 9900,
    'Itália · Seco. Branco italiano de perfil frutado e refrescante, com aromas delicados e boa vivacidade. Uma escolha agradável para quem aprecia vinhos leves e versáteis.'),

  // ---------------- CARTA DE VINHOS · Em taça
  it('Vinho em taça', 'Vinho da Casa', 1500, 'Uma opção para apreciar uma boa taça de vinho.'),
  it('Vinho em taça', 'Vinho Trapiche Vineyards Malbec', 2900, 'Uma opção para apreciar uma boa taça de vinho malbec.'),
];

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'").toLowerCase().trim();

/**
 * Deixa o cardápio do banco igual ao CATALOG:
 * - itens do catálogo: atualizados (mesmo id, se já existiam com o mesmo nome) ou inseridos;
 * - itens fora do catálogo nunca pedidos: EXCLUÍDOS;
 * - itens fora do catálogo que já constam em pedidos: ARQUIVADOS (somem do cardápio e do Admin,
 *   mas as contas e o histórico antigos continuam corretos).
 */
export function applyMenuCatalog(db, audit) {
  const now = nowIso();
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM menu_items').all();
    const byName = new Map(existing.map((r) => [norm(r.name), r]));
    const update = db.prepare(`UPDATE menu_items SET name = ?, description = ?, category = ?, price_cents = ?, active = 1,
      in_combo = ?, archived = 0, sort = ?, updated_at = ? WHERE id = ?`);
    const insert = db.prepare(`INSERT INTO menu_items (name, description, category, price_cents, active, in_combo, archived, sort, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`);
    const used = db.prepare('SELECT 1 FROM order_items WHERE menu_item_id = ? LIMIT 1').pluck();
    const archive = db.prepare('UPDATE menu_items SET active = 0, in_combo = 0, archived = 1, updated_at = ? WHERE id = ?');
    const del = db.prepare('DELETE FROM menu_items WHERE id = ?');

    const keep = new Set();
    const stats = { inseridos: 0, atualizados: 0, excluidos: 0, arquivados: 0 };
    CATALOG.forEach((m, i) => {
      const row = byName.get(norm(m.name));
      const sort = (i + 1) * 10;
      if (row && !keep.has(row.id)) {
        update.run(m.name, m.description, m.category, m.price, m.inCombo ? 1 : 0, sort, now, row.id);
        keep.add(row.id);
        stats.atualizados++;
      } else {
        const info = insert.run(m.name, m.description, m.category, m.price, m.inCombo ? 1 : 0, sort, now, now);
        keep.add(Number(info.lastInsertRowid));
        stats.inseridos++;
      }
    });
    for (const row of existing) {
      if (keep.has(row.id)) continue;
      if (used.get(row.id)) {
        archive.run(now, row.id);
        stats.arquivados++;
      } else {
        del.run(row.id);
        stats.excluidos++;
      }
    }
    audit.log(null, 'menu.catalog_sync', 'menu', null, { versao: CATALOG_VERSION, ...stats });
    return stats;
  })();
}
