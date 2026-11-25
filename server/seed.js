import { DEFAULT_PINS, COMBO_CATEGORY } from '../shared/constants.js';
import { hashPin } from './auth.js';
import { nowIso } from './util.js';

const item = (category, name, description, price, { active = true, inCombo = false } = {}) => ({
  category,
  name,
  description,
  price,
  active,
  inCombo,
});

/**
 * Cardápio inicial (preços em centavos).
 * - Ativos: a "Proposta de Novembro" da La Polpeteria (preços reais do cardápio) e bebidas de exemplo.
 * - Desativados: pratos italianos de exemplo, prontos para o Admin ativar/editar quando quiser.
 */
export const SAMPLE_MENU = [
  // --- Proposta de Novembro (cardápio real) ---
  item(COMBO_CATEGORY, 'Menu Completo', 'Entrada + prato principal + sobremesa da Proposta de Novembro', 13000),
  item('Antipasti', 'Rotolini di Zucchine', 'Rolinhos de abobrinha grelhada recheados com presunto cru e queijo, com ervas e azeite', 3600, { inCombo: true }),
  item('Massas', 'Risotto alla Pera e Gorgonzola con Polpette al Vino Rosso', 'Risoto cremoso de pera e gorgonzola, com três polpette ao molho de vinho tinto', 7200, { inCombo: true }),
  item('Massas', 'Pasta al Pesto alla Trapanese con Polpette al Balsamico', 'Macarrão ao pesto trapanese (tomate, amêndoas e manjericão), com três polpette e redução de balsâmico', 7200, { inCombo: true }),
  item('Massas', "Pasta all'Ortolana con Polpette al Sugo", 'Massa ao molho leve de vegetais frescos da estação, com três polpette clássicas ao sugo', 6800, { inCombo: true }),
  item('Sobremesas', 'Tiramisu', 'Biscoito embebido em café, creme de mascarpone e cacau', 2900, { inCombo: true }),
  item('Sobremesas', 'Cheesecake alla Ricotta con Composta di Pomodorini', 'Cheesecake leve de ricota com compota artesanal de tomate-cereja', 2900, { inCombo: true }),

  // --- Bebidas (exemplo, preços fictícios: ajuste no Admin) ---
  item('Bebidas', 'Água mineral 500 ml', 'Com ou sem gás', 800),
  item('Bebidas', 'Refrigerante lata', 'Consulte os sabores', 1000),
  item('Bebidas', 'Limonata della Casa', 'Limonada siciliana com hortelã', 1600),
  item('Bebidas', 'Taça de Chianti', 'Vinho tinto da Toscana, 150 ml', 3800),
  item('Bebidas', 'Taça de Prosecco', 'Espumante do Vêneto, 150 ml', 3600),
  item('Bebidas', 'Espresso', 'Café expresso italiano', 900),

  // --- Pratos de exemplo (desativados; preços fictícios) ---
  item('Antipasti', 'Polpette al Sugo', 'Almôndegas da casa ao molho de tomate San Marzano', 3800, { active: false }),
  item('Antipasti', 'Bruschetta al Pomodoro', 'Pão italiano tostado, tomate, manjericão e azeite extravirgem', 2800, { active: false }),
  item('Antipasti', 'Burrata con Pomodorini', 'Burrata cremosa, tomates-cereja confitados e pesto', 5400, { active: false }),
  item('Antipasti', 'Arancini Siciliani', 'Bolinhos de risoto recheados com ragù e muçarela (4 un.)', 3600, { active: false }),
  item('Antipasti', 'Carpaccio di Manzo', 'Lâminas de filé, rúcula, alcaparras e lascas de parmesão', 4600, { active: false }),
  item('Massas', 'Spaghetti con Polpette', 'Spaghetti ao sugo com as polpette da casa', 6400, { active: false }),
  item('Massas', 'Spaghetti alla Carbonara', 'Guanciale, gema, pecorino romano e pimenta-do-reino', 6200, { active: false }),
  item('Massas', 'Lasagna alla Bolognese', 'Camadas de massa fresca, ragù à bolonhesa e bechamel', 6600, { active: false }),
  item('Massas', 'Gnocchi al Pesto Genovese', 'Nhoque de batata, pesto de manjericão e pinoli', 5800, { active: false }),
  item('Massas', 'Risotto ai Funghi Porcini', 'Arbóreo, funghi porcini, manteiga e parmesão', 7800, { active: false }),
  item('Pizzas', 'Pizza Margherita', 'Molho de tomate, fior di latte e manjericão', 5600, { active: false }),
  item('Pizzas', 'Pizza Diavola', 'Molho de tomate, muçarela e salame picante', 6200, { active: false }),
  item('Pizzas', 'Pizza Quattro Formaggi', 'Muçarela, gorgonzola, parmesão e provolone', 6400, { active: false }),
  item('Carnes', 'Ossobuco alla Milanese', 'Ossobuco braseado com risoto de açafrão', 9800, { active: false }),
  item('Carnes', 'Saltimbocca alla Romana', 'Escalopes de vitela, presunto cru e sálvia', 8600, { active: false }),
  item('Carnes', 'Pollo alla Parmigiana', 'Frango empanado, molho de tomate e muçarela gratinada', 7200, { active: false }),
  item('Sobremesas', 'Panna Cotta ai Frutti di Bosco', 'Creme cozido com calda de frutas vermelhas', 2800, { active: false }),
  item('Sobremesas', 'Cannoli Siciliani', 'Massa crocante recheada com ricota e pistache (2 un.)', 3000, { active: false }),
];

export const DEFAULT_SETTINGS = {
  table_count: '20',
  warn_minutes: '10',
  late_minutes: '20',
};

export function seedIfEmpty(db, audit) {
  const has = db.prepare("SELECT value FROM settings WHERE key = 'seeded'").pluck().get();
  if (has) return false;
  const now = nowIso();
  db.transaction(() => {
    const set = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) set.run(k, v);
    for (const [role, pin] of Object.entries(DEFAULT_PINS)) set.run(`pin_${role}`, hashPin(pin));
    const ins = db.prepare(
      'INSERT INTO menu_items (name, description, category, price_cents, active, in_combo, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    SAMPLE_MENU.forEach((m, i) => {
      ins.run(m.name, m.description, m.category, m.price, m.active ? 1 : 0, m.inCombo ? 1 : 0, (i + 1) * 10, now, now);
    });
    set.run('seeded', now);
    audit.log(null, 'system.seed', 'database', null, {
      itensCardapio: SAMPLE_MENU.length,
      ativos: SAMPLE_MENU.filter((m) => m.active).length,
    });
  })();
  return true;
}
