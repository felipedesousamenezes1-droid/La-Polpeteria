// Constantes compartilhadas entre servidor e cliente.

export const RESTAURANT_NAME = 'La Polpeteria';

// "Menu Completo": item composto (entrada + prato principal + sobremesa) com preço próprio.
export const COMBO_CATEGORY = 'Menu Completo';

export const CATEGORIES = [COMBO_CATEGORY, 'Antipasti', 'Massas', 'Pizzas', 'Carnes', 'Sobremesas', 'Bebidas'];

// Etapas do Menu Completo. As opções de cada etapa são os itens ativos marcados
// como "faz parte do Menu Completo" nas categorias indicadas.
export const COMBO_STEPS = [
  { key: 'entrada', label: 'Entrada', categories: ['Antipasti'] },
  { key: 'principal', label: 'Prato principal', categories: ['Massas', 'Pizzas', 'Carnes'] },
  { key: 'sobremesa', label: 'Sobremesa', categories: ['Sobremesas'] },
];

export const ROLES = ['garcom', 'cozinha', 'caixa', 'admin'];

export const ROLE_LABELS = {
  garcom: 'Garçom',
  cozinha: 'Cozinha',
  caixa: 'Caixa',
  admin: 'Admin',
  sistema: 'Sistema',
};

export const DEFAULT_PINS = {
  garcom: '1111',
  cozinha: '2222',
  admin: '3333',
  caixa: '4444',
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

// Atalhos de observação rápida exibidos ao garçom.
export const QUICK_NOTES = {
  [COMBO_CATEGORY]: ['servir a sobremesa depois', 'entrada já', 'sem gorgonzola'],
  geral: ['sem cebola', 'sem alho', 'sem queijo', 'sem glúten', 'sem lactose', 'pouco sal', 'molho à parte', 'para viagem'],
  Antipasti: ['sem pão', 'porção extra de pão'],
  Massas: ['al dente', 'bem cozida', 'sem pimenta', 'parmesão à parte'],
  Pizzas: ['massa fina', 'bem assada', 'sem orégano', 'meia a meia'],
  Carnes: ['mal passada', 'ao ponto', 'bem passada', 'sem molho'],
  Sobremesas: ['sem calda', 'para dividir'],
  Bebidas: ['sem gelo', 'com gelo e limão', 'natural', 'trazer junto com o prato'],
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
  minTables: 1,
  maxTables: 200,
};
