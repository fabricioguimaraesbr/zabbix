// Estado em memória da loja: catálogo, estoque, sessões e pedidos.
// Tudo é perdido ao reiniciar o container, o que é suficiente para o laboratório.
const crypto = require('node:crypto');

const INITIAL_PRODUCTS = [
  { id: 'camiseta', name: 'Camiseta Zabbix', icon: '👕', price: 79.9, stock: 25,
    description: 'Camiseta 100% algodão com o logo do Zabbix.' },
  { id: 'caneca', name: 'Caneca Monitoramento 24x7', icon: '☕', price: 49.9, stock: 40,
    description: 'Para o café do plantão. 350 ml, pode ir ao micro-ondas.' },
  { id: 'adesivos', name: 'Kit de adesivos', icon: '🏷️', price: 19.9, stock: 100,
    description: 'Dez adesivos de vinil: Zabbix, OpenTelemetry, ClickHouse e mais.' },
  { id: 'bone', name: 'Boné OpenTelemetry', icon: '🧢', price: 69.9, stock: 15,
    description: 'Boné ajustável com bordado do OpenTelemetry.' },
  { id: 'mochila', name: 'Mochila Sysadmin', icon: '🎒', price: 249.9, stock: 8,
    description: 'Compartimento acolchoado para notebook de até 16".' },
  { id: 'raspberry', name: 'Kit Raspberry Pi', icon: '🖥️', price: 599.0, stock: 3,
    description: 'Placa, fonte, case e cartão de 64 GB. Estoque baixo de propósito.' },
];

const products = new Map(INITIAL_PRODUCTS.map((p) => [p.id, { ...p }]));

function listProducts() {
  return [...products.values()];
}

function getProduct(id) {
  return products.get(id);
}

function restockAll() {
  for (const initial of INITIAL_PRODUCTS) {
    products.get(initial.id).stock = initial.stock;
  }
}

/**
 * Reserva o estoque de todos os itens ou de nenhum.
 * @returns {{ok: true} | {ok: false, product: object, requested: number}}
 */
function reserveStock(items) {
  for (const { product, quantity } of items) {
    if (product.stock < quantity) {
      return { ok: false, product, requested: quantity };
    }
  }
  for (const { product, quantity } of items) {
    product.stock -= quantity;
  }
  return { ok: true };
}

function releaseStock(items) {
  for (const { product, quantity } of items) {
    product.stock += quantity;
  }
}

// ---------- usuários ----------

/** Lê SHOP_USERS no formato "usuario:senha,usuario2:senha2". */
function parseUsers(raw) {
  const users = new Map();
  for (const entry of (raw || '').split(',')) {
    const index = entry.indexOf(':');
    if (index > 0) {
      users.set(entry.slice(0, index).trim(), entry.slice(index + 1));
    }
  }
  return users;
}

const users = parseUsers(process.env.SHOP_USERS);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function checkCredentials(username, password) {
  const expected = users.get(username);
  // Compara sempre algo, para o tempo de resposta não revelar se o usuário existe.
  const ok = crypto.timingSafeEqual(sha256(password), sha256(expected ?? crypto.randomUUID()));
  return expected !== undefined && ok;
}

// ---------- sessões ----------

const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map();

function createSession(username) {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { username, cart: new Map(), expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

function getSession(id) {
  const session = id && sessions.get(id);
  if (!session) return undefined;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function destroySession(id) {
  sessions.delete(id);
}

function activeSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(id);
  }
  return sessions.size;
}

/** Converte a sacola da sessão em linhas com produto, quantidade e subtotal. */
function cartLines(session) {
  const lines = [];
  for (const [productId, quantity] of session.cart) {
    const product = products.get(productId);
    if (product) lines.push({ product, quantity, subtotal: product.price * quantity });
  }
  return lines;
}

function cartCount(session) {
  let count = 0;
  for (const quantity of session?.cart.values() ?? []) count += quantity;
  return count;
}

// ---------- pedidos ----------

const orders = [];

function createOrder(data) {
  const order = {
    id: `PED-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
    createdAt: new Date(),
    ...data,
  };
  orders.unshift(order);
  if (orders.length > 500) orders.pop();
  return order;
}

function ordersFor(username) {
  return orders.filter((order) => order.username === username);
}

module.exports = {
  listProducts, getProduct, restockAll, reserveStock, releaseStock,
  users, checkCredentials,
  createSession, getSession, destroySession, activeSessions,
  cartLines, cartCount,
  createOrder, ordersFor,
};
