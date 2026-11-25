import { DEFAULT_PINS } from '../shared/constants.js';
import { hashPin } from './auth.js';
import { nowIso } from './util.js';

// Cardápio de exemplo: pratos italianos reais, preços fictícios (em centavos).
export const SAMPLE_MENU = [
  ['Antipasti', 'Bruschetta al Pomodoro', 'Pão italiano tostado, tomate, manjericão e azeite extravirgem', 2800],
  ['Antipasti', 'Burrata con Pomodorini', 'Burrata cremosa, tomates-cereja confitados e pesto', 5400],
  ['Antipasti', 'Arancini Siciliani', 'Bolinhos de risoto recheados com ragù e muçarela (4 un.)', 3600],
  ['Antipasti', 'Polpette al Sugo', 'Almôndegas da casa ao molho de tomate San Marzano', 3800],
  ['Antipasti', 'Carpaccio di Manzo', 'Lâminas de filé, rúcula, alcaparras e lascas de parmesão', 4600],
  ['Massas', 'Spaghetti alla Carbonara', 'Guanciale, gema, pecorino romano e pimenta-do-reino', 6200],
  ['Massas', 'Lasagna alla Bolognese', 'Camadas de massa fresca, ragù à bolonhesa e bechamel', 6600],
  ['Massas', 'Gnocchi al Pesto Genovese', 'Nhoque de batata, pesto de manjericão e pinoli', 5800],
  ['Massas', "Penne all'Arrabbiata", 'Molho de tomate apimentado, alho e salsinha', 5200],
  ['Massas', 'Spaghetti con Polpette', 'Spaghetti ao sugo com as almôndegas da casa', 6400],
  ['Massas', 'Risotto ai Funghi Porcini', 'Arbóreo, funghi porcini, manteiga e parmesão', 7800],
  ['Pizzas', 'Pizza Margherita', 'Molho de tomate, fior di latte e manjericão', 5600],
  ['Pizzas', 'Pizza Diavola', 'Molho de tomate, muçarela e salame picante', 6200],
  ['Pizzas', 'Pizza Quattro Formaggi', 'Muçarela, gorgonzola, parmesão e provolone', 6400],
  ['Pizzas', 'Pizza Prosciutto e Rucola', 'Muçarela, presunto de Parma e rúcula', 7200],
  ['Carnes', 'Ossobuco alla Milanese', 'Ossobuco braseado com risoto de açafrão', 9800],
  ['Carnes', 'Saltimbocca alla Romana', 'Escalopes de vitela, presunto cru e sálvia', 8600],
  ['Carnes', 'Pollo alla Parmigiana', 'Frango empanado, molho de tomate e muçarela gratinada', 7200],
  ['Carnes', 'Bistecca alla Fiorentina', 'T-bone grelhado (aprox. 600 g) com batatas', 14900],
  ['Sobremesas', 'Tiramisù', 'Savoiardi, café, mascarpone e cacau', 3200],
  ['Sobremesas', 'Panna Cotta ai Frutti di Bosco', 'Creme cozido com calda de frutas vermelhas', 2800],
  ['Sobremesas', 'Cannoli Siciliani', 'Massa crocante recheada com ricota e pistache (2 un.)', 3000],
  ['Bebidas', 'Água mineral 500 ml', 'Com ou sem gás', 800],
  ['Bebidas', 'Refrigerante lata', 'Consulte os sabores', 1000],
  ['Bebidas', 'Limonata della Casa', 'Limonada siciliana com hortelã', 1600],
  ['Bebidas', 'Taça de Chianti', 'Vinho tinto da Toscana, 150 ml', 3800],
  ['Bebidas', 'Espresso', 'Café expresso italiano', 900],
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
      'INSERT INTO menu_items (name, description, category, price_cents, active, sort, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
    );
    SAMPLE_MENU.forEach(([category, name, description, price], i) => {
      ins.run(name, description, category, price, (i + 1) * 10, now, now);
    });
    set.run('seeded', now);
    audit.log(null, 'system.seed', 'database', null, { itensCardapio: SAMPLE_MENU.length });
  })();
  return true;
}
