require('./instrumentation.cjs');

const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const express = require('express');
const { trace } = require('@opentelemetry/api');
const store = require('./store.cjs');
const views = require('./views.cjs');
const { instruments, registerGauges, log, withSpan, SpanStatusCode } = require('./telemetry.cjs');

const PORT = Number(process.env.PORT || 8080);
const PAYMENT_FAILURE_RATE = Number(process.env.PAYMENT_FAILURE_RATE ?? 0.1);
const SLOW_CHECKOUT_RATE = Number(process.env.SLOW_CHECKOUT_RATE ?? 0.05);
const RESTOCK_INTERVAL_MINUTES = Number(process.env.RESTOCK_INTERVAL_MINUTES ?? 30);
const SESSION_COOKIE = 'shop_session';

if (store.users.size === 0) {
  throw new Error('Configure SHOP_USERS (formato usuario:senha,usuario2:senha2)');
}

const SHIPPING_OPTIONS = [
  { id: 'pac', label: 'PAC', eta: '5 a 8 dias úteis', price: (total) => (total >= 300 ? 0 : 19.9) },
  { id: 'sedex', label: 'SEDEX', eta: '1 a 3 dias úteis', price: () => 39.9 },
];

// Latência e chance de recusa variam por forma de pagamento, para os traces terem perfis distintos.
const PAYMENT_METHODS = [
  { id: 'pix', label: 'Pix (simulado)', latency: [80, 300], failureWeight: 0.3 },
  { id: 'credit_card', label: 'Cartão de crédito (simulado)', latency: [300, 1200], failureWeight: 1.5 },
  { id: 'boleto', label: 'Boleto (simulado)', latency: [50, 150], failureWeight: 0.2 },
];

const DECLINE_REASONS = ['saldo insuficiente', 'transação recusada pelo emissor', 'suspeita de fraude', 'tempo limite do adquirente'];

const random = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

registerGauges(store.listProducts, store.activeSessions);

if (RESTOCK_INTERVAL_MINUTES > 0) {
  setInterval(() => {
    store.restockAll();
    log('INFO', 'Estoque reabastecido', { 'shop.restock.interval_minutes': RESTOCK_INTERVAL_MINUTES });
  }, RESTOCK_INTERVAL_MINUTES * 60 * 1000).unref();
}

const app = express();
app.disable('x-powered-by');
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Sessão a partir do cookie; também anota o usuário no span HTTP da requisição.
app.use((req, res, next) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const index = c.indexOf('=');
    return [c.slice(0, index).trim(), decodeURIComponent(c.slice(index + 1))];
  }));
  req.sessionId = cookies[SESSION_COOKIE];
  req.session = store.getSession(req.sessionId);
  res.locals.ctx = {
    user: req.session?.username,
    cartCount: store.cartCount(req.session),
  };
  if (req.session) {
    trace.getActiveSpan()?.setAttribute('enduser.id', req.session.username);
  }
  next();
});

function requireLogin(req, res, next) {
  if (req.session) return next();
  const target = req.method === 'GET' ? req.originalUrl : '/';
  res.redirect(303, `/login?next=${encodeURIComponent(target)}`);
}

/** Simula a consulta ao banco do catálogo, para os traces terem um span filho. */
function queryCatalog(operation, fn) {
  return withSpan(`catalog ${operation}`, { 'db.system.name': 'in-memory', 'db.operation.name': operation }, async () => {
    await sleep(random(3, 25));
    return fn();
  });
}

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

// ---------- catálogo ----------

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.get('/', async (req, res) => {
  const products = await queryCatalog('list_products', store.listProducts);
  res.send(views.catalogPage(res.locals.ctx, products));
});

app.get('/product/:id', async (req, res) => {
  const product = await queryCatalog('get_product', () => store.getProduct(req.params.id));
  if (!product) {
    res.status(404).send(views.errorPage(res.locals.ctx, 404, 'Produto não encontrado.'));
    return;
  }
  trace.getActiveSpan()?.setAttribute('shop.product.id', product.id);
  res.send(views.productPage(res.locals.ctx, product));
});

// ---------- login ----------

app.get('/login', (req, res) => {
  if (req.session) return res.redirect(303, '/');
  res.send(views.loginPage(res.locals.ctx, { next: safeNext(req.query.next), users: [...store.users.keys()] }));
});

app.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);

  await withSpan('auth.verify_credentials', { 'enduser.id': username }, async (span) => {
    await sleep(random(20, 60));
    const ok = store.checkCredentials(username, password);
    span.setAttribute('shop.login.outcome', ok ? 'success' : 'failure');
    instruments.logins.add(1, { 'shop.login.outcome': ok ? 'success' : 'failure' });

    if (!ok) {
      log('WARN', 'Falha de login', { 'enduser.id': username, 'shop.login.outcome': 'failure' });
      res.status(401).send(views.loginPage(res.locals.ctx, {
        next, error: 'Usuário ou senha inválidos.', users: [...store.users.keys()],
      }));
      return;
    }

    log('INFO', 'Login realizado', { 'enduser.id': username, 'shop.login.outcome': 'success' });
    const sessionId = store.createSession(username);
    res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 1000 });
    res.redirect(303, next);
  });
});

app.post('/logout', (req, res) => {
  if (req.session) {
    log('INFO', 'Logout', { 'enduser.id': req.session.username });
    store.destroySession(req.sessionId);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect(303, '/');
});

// ---------- sacola ----------

app.get('/cart', requireLogin, (req, res) => {
  const lines = store.cartLines(req.session);
  const total = lines.reduce((sum, line) => sum + line.subtotal, 0);
  res.send(views.cartPage(res.locals.ctx, lines, total));
});

app.post('/cart/add', requireLogin, async (req, res) => {
  const product = await queryCatalog('get_product', () => store.getProduct(String(req.body.productId)));
  const quantity = Math.max(1, Math.min(99, Number.parseInt(req.body.quantity, 10) || 1));
  if (!product) {
    res.status(404).send(views.errorPage(res.locals.ctx, 404, 'Produto não encontrado.'));
    return;
  }
  const current = req.session.cart.get(product.id) || 0;
  req.session.cart.set(product.id, current + quantity);

  trace.getActiveSpan()?.setAttributes({ 'shop.product.id': product.id, 'shop.cart.quantity': quantity });
  instruments.cartAdditions.add(quantity, { 'shop.product.id': product.id });
  log('INFO', 'Produto adicionado à sacola', {
    'enduser.id': req.session.username, 'shop.product.id': product.id, 'shop.cart.quantity': quantity,
  });
  res.redirect(303, '/cart');
});

app.post('/cart/update', requireLogin, (req, res) => {
  const productId = String(req.body.productId);
  const quantity = Math.max(0, Math.min(99, Number.parseInt(req.body.quantity, 10) || 0));
  if (quantity === 0) req.session.cart.delete(productId);
  else if (store.getProduct(productId)) req.session.cart.set(productId, quantity);
  res.redirect(303, '/cart');
});

app.post('/cart/remove', requireLogin, (req, res) => {
  req.session.cart.delete(String(req.body.productId));
  log('INFO', 'Produto removido da sacola', { 'enduser.id': req.session.username, 'shop.product.id': String(req.body.productId) });
  res.redirect(303, '/cart');
});

// ---------- checkout ----------

function renderCheckout(req, res, { status = 200, values, error } = {}) {
  const lines = store.cartLines(req.session);
  const total = lines.reduce((sum, line) => sum + line.subtotal, 0);
  res.status(status).send(views.checkoutPage(res.locals.ctx, {
    lines, total, shippingOptions: SHIPPING_OPTIONS, paymentMethods: PAYMENT_METHODS, values, error,
  }));
}

app.get('/checkout', requireLogin, (req, res) => {
  if (req.session.cart.size === 0) return res.redirect(303, '/cart');
  renderCheckout(req, res);
});

class CheckoutError extends Error {
  constructor(status, message, outcome) {
    super(message);
    this.status = status;
    this.outcome = outcome;
  }
}

app.post('/checkout', requireLogin, async (req, res) => {
  const started = performance.now();
  const username = req.session.username;
  const values = {
    name: String(req.body.name || '').trim().slice(0, 80),
    cep: String(req.body.cep || '').trim(),
    address: String(req.body.address || '').trim().slice(0, 120),
    shipping: String(req.body.shipping || ''),
    payment: String(req.body.payment || ''),
  };
  const shipping = SHIPPING_OPTIONS.find((s) => s.id === values.shipping);
  const payment = PAYMENT_METHODS.find((m) => m.id === values.payment);
  const paymentAttr = { 'shop.payment.method': payment?.id ?? 'unknown' };
  let outcome = 'confirmed';

  try {
    await withSpan('checkout.process', { 'enduser.id': username, ...paymentAttr }, async (checkoutSpan) => {
      // 1. validação
      const lines = await withSpan('checkout.validate', {}, async () => {
        const current = store.cartLines(req.session);
        if (current.length === 0) throw new CheckoutError(400, 'Sua sacola está vazia.', 'invalid');
        if (!values.name || !values.address || !/^\d{5}-?\d{3}$/.test(values.cep) || !shipping || !payment) {
          throw new CheckoutError(400, 'Preencha nome, CEP, endereço, frete e forma de pagamento.', 'invalid');
        }
        return current;
      });
      const itemsTotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
      const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
      checkoutSpan.setAttributes({ 'shop.cart.items': itemCount, 'shop.cart.value': itemsTotal });

      // Lentidão ocasional, útil para testar triggers de latência no Zabbix.
      if (Math.random() < SLOW_CHECKOUT_RATE) {
        await withSpan('fraud.analysis', { 'shop.fraud.slow_path': true }, () => sleep(random(1500, 3500)));
      }

      // 2. reserva de estoque
      await withSpan('inventory.reserve', { 'shop.cart.items': itemCount }, async (span) => {
        await sleep(random(10, 40));
        const reservation = store.reserveStock(lines);
        if (!reservation.ok) {
          span.setAttributes({ 'shop.product.id': reservation.product.id, 'shop.inventory.available': reservation.product.stock });
          log('WARN', 'Estoque insuficiente no checkout', {
            'enduser.id': username, 'shop.product.id': reservation.product.id,
            'shop.inventory.requested': reservation.requested, 'shop.inventory.available': reservation.product.stock,
          });
          throw new CheckoutError(409,
            `Estoque insuficiente para ${reservation.product.name}: disponível ${reservation.product.stock}.`, 'out_of_stock');
        }
      });

      try {
        // 3. frete
        const shippingCost = await withSpan('shipping.quote', { 'shop.shipping.method': shipping.id }, async (span) => {
          await sleep(random(40, 180));
          const cost = shipping.price(itemsTotal);
          span.setAttribute('shop.shipping.cost', cost);
          return cost;
        });
        const total = Math.round((itemsTotal + shippingCost) * 100) / 100;

        // 4. pagamento simulado
        const authorization = await withSpan('payment.authorize', { ...paymentAttr, 'shop.payment.amount': total }, async (span) => {
          const paymentStarted = performance.now();
          await sleep(random(...payment.latency));
          const declined = Math.random() < PAYMENT_FAILURE_RATE * payment.failureWeight;
          const status = declined ? 'declined' : 'approved';
          instruments.paymentDuration.record(performance.now() - paymentStarted, { ...paymentAttr, 'shop.payment.status': status });
          span.setAttribute('shop.payment.status', status);
          if (declined) {
            const reason = pick(DECLINE_REASONS);
            span.setAttribute('shop.payment.decline_reason', reason);
            log('WARN', 'Pagamento recusado', {
              'enduser.id': username, ...paymentAttr, 'shop.payment.amount': total, 'shop.payment.decline_reason': reason,
            });
            throw new CheckoutError(402, `Pagamento recusado: ${reason}. Tente novamente ou escolha outra forma de pagamento.`, 'payment_declined');
          }
          return `AUT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
        });

        // 5. pedido
        const order = await withSpan('order.create', {}, async (span) => {
          await sleep(random(5, 20));
          const created = store.createOrder({
            username, lines, itemsTotal, shippingCost, total, shipping, payment, authorization,
            name: values.name, cep: values.cep, address: values.address,
          });
          span.setAttribute('shop.order.id', created.id);
          return created;
        });

        checkoutSpan.setAttributes({ 'shop.order.id': order.id, 'shop.order.total': total });
        instruments.revenue.add(total, paymentAttr);
        instruments.orderValue.record(total, paymentAttr);
        log('INFO', 'Pedido confirmado', {
          'enduser.id': username, 'shop.order.id': order.id, 'shop.order.total': total,
          'shop.cart.items': itemCount, ...paymentAttr, 'shop.shipping.method': shipping.id,
        });

        req.session.cart.clear();
        res.locals.ctx.cartCount = 0;
        res.send(views.orderConfirmedPage(res.locals.ctx, order));
      } catch (error) {
        store.releaseStock(lines);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof CheckoutError) {
      outcome = error.outcome;
      renderCheckout(req, res, { status: error.status, values, error: error.message });
    } else {
      outcome = 'error';
      log('ERROR', 'Erro inesperado no checkout', { 'enduser.id': username, 'exception.message': error.message });
      res.status(500).send(views.errorPage(res.locals.ctx, 500, 'Erro inesperado ao processar o pedido.'));
    }
  } finally {
    if (outcome !== 'invalid') {
      instruments.orders.add(1, { 'shop.order.status': outcome, ...paymentAttr });
    }
    instruments.checkoutDuration.record(performance.now() - started, { 'shop.order.status': outcome });
  }
});

app.get('/orders', requireLogin, (req, res) => {
  res.send(views.ordersPage(res.locals.ctx, store.ordersFor(req.session.username)));
});

app.use((req, res) => {
  res.status(404).send(views.errorPage(res.locals.ctx ?? {}, 404, 'Página não encontrada.'));
});

app.use((error, req, res, _next) => {
  trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  log('ERROR', 'Erro não tratado', { 'exception.message': error.message, 'url.path': req.path });
  res.status(500).send(views.errorPage(res.locals.ctx ?? {}, 500, 'Erro inesperado.'));
});

app.listen(PORT, () => {
  console.log(`Loja Zabbix Lab ouvindo na porta ${PORT}`);
  log('INFO', 'Loja iniciada', { 'server.port': PORT });
});
