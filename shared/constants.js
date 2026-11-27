// Constantes compartilhadas entre servidor e cliente.

export const RESTAURANT_NAME = 'La Polpeteria';

// "Menu Completo": item composto (entrada + prato principal + sobremesa) com preço próprio.
// Uma seção é de "Menu Completo" quando o seu tempo (course) é 'combo'.
export const COMBO_CATEGORY = 'Menu Completo';

// Grupos do cardápio (na ordem do cardápio impresso). As seções de cada grupo são editáveis no Admin.
// O título da proposta do mês é configurável (settings.proposalTitle).
export const MENU_GROUPS = [
  { key: 'bebidas', title: 'Bebidas' },
  { key: 'proposta', title: 'Proposta do mês' },
  { key: 'vinhos', title: 'Carta de vinhos' },
  { key: 'outros', title: 'Outros' },
];

// Tempos de serviço da cozinha. Pedido com Menu Completo é dividido em tempos:
// a entrada sai na hora; prato principal e sobremesa aguardam o garçom liberar.
export const COURSES = {
  entrada: { label: 'Entrada', tempo: 1 },
  principal: { label: 'Prato principal', tempo: 2 },
  sobremesa: { label: 'Sobremesa', tempo: 3 },
  unico: { label: 'Cozinha', tempo: 1 },
};

export const COURSE_OPTIONS = [
  ['', 'Nenhum (sai junto com o pedido)'],
  ['entrada', 'Entrada'],
  ['principal', 'Prato principal'],
  ['sobremesa', 'Sobremesa'],
  ['combo', 'É o próprio Menu Completo'],
];

// Etapas do Menu Completo: as opções são os itens ativos marcados como "faz parte do Menu Completo"
// nas seções cujo tempo é o da etapa.
export const COMBO_STEPS = [
  { key: 'entrada', label: 'Entrada' },
  { key: 'principal', label: 'Prato principal' },
  { key: 'sobremesa', label: 'Sobremesa' },
];

// Seções iniciais. kitchen: vai para a tela da cozinha; inService: entra no cálculo dos 10%.
export const DEFAULT_CATEGORIES = [
  { name: 'Não alcoólicas', group: 'bebidas', kitchen: false, course: null, inService: true },
  { name: 'Alcoólicas', group: 'bebidas', kitchen: false, course: null, inService: true },
  { name: 'Drinks alcoólicos', group: 'bebidas', kitchen: false, course: null, inService: true },
  { name: 'Entrada', group: 'proposta', kitchen: true, course: 'entrada', inService: true },
  { name: 'Prato principal', group: 'proposta', kitchen: true, course: 'principal', inService: true },
  { name: 'Sobremesa', group: 'proposta', kitchen: true, course: 'sobremesa', inService: true },
  { name: COMBO_CATEGORY, group: 'proposta', kitchen: true, course: 'combo', inService: true },
  { name: 'Vinhos tintos', group: 'vinhos', kitchen: false, course: null, inService: true },
  { name: 'Vinhos brancos', group: 'vinhos', kitchen: false, course: null, inService: true },
  { name: 'Vinho em taça', group: 'vinhos', kitchen: false, course: null, inService: true },
  { name: 'Outros', group: 'outros', kitchen: false, course: null, inService: false },
];

// "dono" = Proprietário: tudo o que o Admin faz + relatórios de vendas.
export const ROLES = ['garcom', 'cozinha', 'caixa', 'admin', 'dono'];
export const MANAGER_ROLES = ['admin', 'dono'];

export const ROLE_LABELS = {
  garcom: 'Garçom',
  cozinha: 'Cozinha',
  caixa: 'Caixa',
  admin: 'Admin',
  dono: 'Proprietário',
  sistema: 'Sistema',
};

export const DEFAULT_PINS = {
  garcom: '1111',
  cozinha: '2222',
  admin: '3333',
  caixa: '4444',
  dono: '5555',
};

// Fluxo de status de cada tempo na cozinha ("aguardando" = segurado até o garçom liberar).
export const ORDER_FLOW = ['novo', 'preparando', 'pronto', 'entregue'];

export const ORDER_STATUS_LABELS = {
  aguardando: 'Aguardando',
  novo: 'Novo',
  preparando: 'Preparando',
  pronto: 'Pronto',
  entregue: 'Entregue',
  sem_cozinha: 'Sem cozinha',
};

export const TAB_STATUS_LABELS = {
  open: 'Aberta',
  billing: 'Conta pedida',
  closed: 'Fechada',
};

// Atalhos de observação rápida exibidos ao garçom: por seção; se a seção for nova, pelo tempo ou grupo.
const COMIDA = ['sem cebola', 'sem alho', 'sem glúten', 'sem lactose', 'pouco sal', 'molho à parte', 'para viagem'];
export const QUICK_NOTES = {
  'Não alcoólicas': ['com gelo', 'sem gelo', 'com gelo e limão', 'sem açúcar', 'trazer junto com o prato'],
  Alcoólicas: ['bem gelada', 'com copo', 'trazer junto com o prato'],
  'Drinks alcoólicos': ['pouco gelo', 'sem gelo', 'sem alecrim'],
  Entrada: COMIDA,
  'Prato principal': ['sem gorgonzola', 'polpette à parte', 'sem pimenta', ...COMIDA],
  Sobremesa: ['para dividir', 'para viagem'],
  [COMBO_CATEGORY]: ['sem gorgonzola', ...COMIDA],
  'Vinhos tintos': ['servir já', 'temperatura ambiente', 'abrir na mesa'],
  'Vinhos brancos': ['bem gelado', 'balde de gelo', 'abrir na mesa'],
  'Vinho em taça': ['servir já', 'junto com o prato'],
  Outros: [],
  // alternativas para seções criadas no Admin
  'curso:entrada': COMIDA,
  'curso:principal': COMIDA,
  'curso:sobremesa': ['para dividir', 'para viagem'],
  'curso:combo': COMIDA,
  'grupo:bebidas': ['com gelo', 'sem gelo', 'trazer junto com o prato'],
  'grupo:vinhos': ['servir já', 'abrir na mesa'],
  'grupo:proposta': COMIDA,
};

export function quickNotesFor(category, categories = []) {
  if (QUICK_NOTES[category]) return QUICK_NOTES[category];
  const c = categories.find((x) => x.name === category);
  return (c && (QUICK_NOTES[`curso:${c.course}`] || QUICK_NOTES[`grupo:${c.group}`])) || [];
}

export const CANCEL_REASONS = [
  'Cliente desistiu',
  'Lançado por engano',
  'Item em falta',
  'Demora na entrega',
  'Problema no prato',
];

export const LIMITS = {
  maxLinesPerOrder: 60,
  maxQty: 99,
  maxNotes: 140,
  maxReason: 200,
  maxDescription: 400,
  maxCategoryName: 40,
  minTables: 1,
  maxTables: 200,
};
