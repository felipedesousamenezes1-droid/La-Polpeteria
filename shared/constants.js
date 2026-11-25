// Constantes compartilhadas entre servidor e cliente.

export const RESTAURANT_NAME = 'La Polpeteria';

// "Menu Completo": item composto (entrada + prato principal + sobremesa) com preço próprio.
export const COMBO_CATEGORY = 'Menu Completo';

// Seções do cardápio, na ordem do cardápio impresso da casa.
// O título da proposta do mês é configurável no Admin (settings.proposalTitle).
export const MENU_GROUPS = [
  { key: 'bebidas', title: 'Bebidas', categories: ['Não alcoólicas', 'Alcoólicas', 'Drinks alcoólicos'] },
  { key: 'proposta', title: 'Proposta do mês', categories: ['Entrada', 'Prato principal', 'Sobremesa', COMBO_CATEGORY] },
  { key: 'vinhos', title: 'Carta de vinhos', categories: ['Vinhos tintos', 'Vinhos brancos', 'Vinho em taça'] },
];

export const CATEGORIES = MENU_GROUPS.flatMap((g) => g.categories);

// Etapas do Menu Completo. As opções de cada etapa são os itens ativos marcados
// como "faz parte do Menu Completo" nas categorias indicadas.
export const COMBO_STEPS = [
  { key: 'entrada', label: 'Entrada', categories: ['Entrada'] },
  { key: 'principal', label: 'Prato principal', categories: ['Prato principal'] },
  { key: 'sobremesa', label: 'Sobremesa', categories: ['Sobremesa'] },
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

// Fluxo de status de um pedido (uma "rodada" enviada à cozinha).
export const ORDER_FLOW = ['novo', 'preparando', 'pronto', 'entregue'];

export const ORDER_STATUS_LABELS = {
  novo: 'Novo',
  preparando: 'Preparando',
  pronto: 'Pronto',
  entregue: 'Retirado',
};

export const TAB_STATUS_LABELS = {
  open: 'Aberta',
  billing: 'Conta pedida',
  closed: 'Fechada',
};

// Atalhos de observação rápida exibidos ao garçom (por categoria).
const COMIDA = ['sem cebola', 'sem alho', 'sem glúten', 'sem lactose', 'pouco sal', 'molho à parte', 'para viagem'];
export const QUICK_NOTES = {
  'Não alcoólicas': ['com gelo', 'sem gelo', 'com gelo e limão', 'sem açúcar', 'trazer junto com o prato'],
  Alcoólicas: ['bem gelada', 'com copo', 'trazer junto com o prato'],
  'Drinks alcoólicos': ['pouco gelo', 'sem gelo', 'sem alecrim'],
  Entrada: COMIDA,
  'Prato principal': ['sem gorgonzola', 'polpette à parte', 'sem pimenta', ...COMIDA],
  Sobremesa: ['servir depois', 'para dividir', 'para viagem'],
  [COMBO_CATEGORY]: ['servir a sobremesa depois', 'entrada já', 'sem gorgonzola', ...COMIDA],
  'Vinhos tintos': ['servir já', 'temperatura ambiente', 'abrir na mesa'],
  'Vinhos brancos': ['bem gelado', 'balde de gelo', 'abrir na mesa'],
  'Vinho em taça': ['servir já', 'junto com o prato'],
};

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
  minTables: 1,
  maxTables: 200,
};
