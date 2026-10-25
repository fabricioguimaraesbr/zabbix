// Páginas HTML da loja, renderizadas no servidor.

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const money = (value) => brl.format(value);

function layout({ title, user, cartCount = 0, flash, body }) {
  const nav = user
    ? `<a href="/orders">Meus pedidos</a>
       <a href="/cart" class="cart-link">Sacola <span class="badge">${cartCount}</span></a>
       <form method="post" action="/logout" class="inline"><button class="link">Sair (${esc(user)})</button></form>`
    : '<a href="/login" class="button small">Entrar</a>';

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · Loja Zabbix Lab</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <header class="topbar">
    <a href="/" class="brand">🛒 Loja Zabbix Lab</a>
    <nav>${nav}</nav>
  </header>
  <main>
    ${flash ? `<div class="flash ${esc(flash.type)}">${esc(flash.text)}</div>` : ''}
    ${body}
  </main>
  <footer>Loja de demonstração para gerar telemetria OpenTelemetry. Nenhum pagamento é real.</footer>
</body>
</html>`;
}

function stockLabel(product) {
  if (product.stock === 0) return '<span class="stock out">Esgotado</span>';
  if (product.stock <= 5) return `<span class="stock low">Últimas ${product.stock} unidades</span>`;
  return `<span class="stock">${product.stock} em estoque</span>`;
}

function addToCartForm(product, user) {
  if (!user) return '<a class="button" href="/login">Entre para comprar</a>';
  if (product.stock === 0) return '<button class="button" disabled>Esgotado</button>';
  return `<form method="post" action="/cart/add">
    <input type="hidden" name="productId" value="${esc(product.id)}">
    <input type="number" name="quantity" value="1" min="1" max="${product.stock}" aria-label="Quantidade">
    <button class="button">Adicionar à sacola</button>
  </form>`;
}

function catalogPage(ctx, products) {
  const cards = products.map((p) => `
    <article class="card">
      <a href="/product/${esc(p.id)}" class="card-icon">${p.icon}</a>
      <h2><a href="/product/${esc(p.id)}">${esc(p.name)}</a></h2>
      <p class="price">${money(p.price)}</p>
      ${stockLabel(p)}
      ${addToCartForm(p, ctx.user)}
    </article>`).join('');

  return layout({ ...ctx, title: 'Produtos', body: `
    <h1>Produtos</h1>
    <div class="grid">${cards}</div>` });
}

function productPage(ctx, p) {
  return layout({ ...ctx, title: p.name, body: `
    <p><a href="/">← Voltar aos produtos</a></p>
    <section class="product">
      <div class="product-icon">${p.icon}</div>
      <div>
        <h1>${esc(p.name)}</h1>
        <p>${esc(p.description)}</p>
        <p class="price big">${money(p.price)}</p>
        ${stockLabel(p)}
        ${addToCartForm(p, ctx.user)}
      </div>
    </section>` });
}

function loginPage(ctx, { next = '/', error, users = [] } = {}) {
  const hint = users.length
    ? `<p class="hint">Usuários de teste: ${users.map((u) => `<code>${esc(u)}</code>`).join(', ')}.
       As senhas estão em <code>env/shop-app/app.env</code>.</p>`
    : '';
  return layout({ ...ctx, title: 'Entrar', body: `
    <section class="panel narrow">
      <h1>Entrar</h1>
      ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="next" value="${esc(next)}">
        <label>Usuário <input name="username" autocomplete="username" required autofocus></label>
        <label>Senha <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="button">Entrar</button>
      </form>
      ${hint}
    </section>` });
}

function cartTable(lines, { editable }) {
  const rows = lines.map(({ product, quantity, subtotal }) => `
    <tr>
      <td>${product.icon} ${esc(product.name)}</td>
      <td class="num">${money(product.price)}</td>
      <td class="num">${editable
        ? `<form method="post" action="/cart/update" class="inline">
             <input type="hidden" name="productId" value="${esc(product.id)}">
             <input type="number" name="quantity" value="${quantity}" min="0" max="99" aria-label="Quantidade">
             <button class="link">Atualizar</button>
           </form>`
        : quantity}</td>
      <td class="num">${money(subtotal)}</td>
      ${editable ? `<td><form method="post" action="/cart/remove" class="inline">
        <input type="hidden" name="productId" value="${esc(product.id)}">
        <button class="link danger">Remover</button></form></td>` : ''}
    </tr>`).join('');
  return `<table class="cart">
    <thead><tr><th>Produto</th><th class="num">Preço</th><th class="num">Qtd.</th><th class="num">Subtotal</th>${editable ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function cartPage(ctx, lines, total) {
  if (lines.length === 0) {
    return layout({ ...ctx, title: 'Sacola', body: `
      <h1>Sua sacola</h1>
      <p>A sacola está vazia. <a href="/">Ver produtos</a></p>` });
  }
  return layout({ ...ctx, title: 'Sacola', body: `
    <h1>Sua sacola</h1>
    ${cartTable(lines, { editable: true })}
    <div class="summary">
      <p>Total dos produtos: <strong>${money(total)}</strong></p>
      <a href="/" class="button secondary">Continuar comprando</a>
      <a href="/checkout" class="button">Ir para o checkout</a>
    </div>` });
}

function checkoutPage(ctx, { lines, total, shippingOptions, paymentMethods, values = {}, error }) {
  const shipping = shippingOptions.map((s, i) => `
    <label class="option"><input type="radio" name="shipping" value="${esc(s.id)}" ${values.shipping === s.id || (!values.shipping && i === 0) ? 'checked' : ''}>
      ${esc(s.label)} — ${s.price(total) === 0 ? 'grátis' : money(s.price(total))} <small>(${esc(s.eta)})</small></label>`).join('');
  const payment = paymentMethods.map((m, i) => `
    <label class="option"><input type="radio" name="payment" value="${esc(m.id)}" ${values.payment === m.id || (!values.payment && i === 0) ? 'checked' : ''}>
      ${esc(m.label)}</label>`).join('');

  return layout({ ...ctx, title: 'Checkout', body: `
    <h1>Checkout</h1>
    ${error ? `<div class="flash error">${esc(error)}</div>` : ''}
    <div class="checkout">
      <form method="post" action="/checkout" class="panel stack">
        <h2>Entrega</h2>
        <label>Nome completo <input name="name" value="${esc(values.name)}" required maxlength="80"></label>
        <label>CEP <input name="cep" value="${esc(values.cep)}" required pattern="[0-9]{5}-?[0-9]{3}" placeholder="01001-000"></label>
        <label>Endereço <input name="address" value="${esc(values.address)}" required maxlength="120"></label>
        <fieldset><legend>Frete</legend>${shipping}</fieldset>
        <h2>Pagamento <small>(simulado, nenhum dado de pagamento é pedido)</small></h2>
        <fieldset><legend>Forma de pagamento</legend>${payment}</fieldset>
        <button class="button">Confirmar compra</button>
      </form>
      <aside class="panel">
        <h2>Resumo</h2>
        ${cartTable(lines, { editable: false })}
        <p>Produtos: <strong>${money(total)}</strong></p>
        <p class="hint">O frete é somado na confirmação.</p>
      </aside>
    </div>` });
}

function orderConfirmedPage(ctx, order) {
  return layout({ ...ctx, title: 'Pedido confirmado', body: `
    <section class="panel">
      <h1>✅ Pedido confirmado</h1>
      <p>Número do pedido: <strong>${esc(order.id)}</strong></p>
      ${cartTable(order.lines, { editable: false })}
      <p>Frete (${esc(order.shipping.label)}): ${money(order.shippingCost)}</p>
      <p class="price big">Total: ${money(order.total)}</p>
      <p>Pagamento: ${esc(order.payment.label)} · Autorização <code>${esc(order.authorization)}</code></p>
      <p>Entrega para ${esc(order.name)}, ${esc(order.address)} (CEP ${esc(order.cep)}) em ${esc(order.shipping.eta)}.</p>
      <a href="/" class="button">Voltar à loja</a> <a href="/orders" class="button secondary">Meus pedidos</a>
    </section>` });
}

function ordersPage(ctx, orders) {
  const rows = orders.map((o) => `
    <tr>
      <td><code>${esc(o.id)}</code></td>
      <td>${dateTime.format(o.createdAt)}</td>
      <td>${o.lines.map((l) => `${l.quantity}× ${esc(l.product.name)}`).join('<br>')}</td>
      <td>${esc(o.payment.label)}</td>
      <td class="num">${money(o.total)}</td>
    </tr>`).join('');
  return layout({ ...ctx, title: 'Meus pedidos', body: `
    <h1>Meus pedidos</h1>
    ${orders.length === 0 ? '<p>Nenhum pedido ainda. <a href="/">Ver produtos</a></p>' : `
    <table class="cart">
      <thead><tr><th>Pedido</th><th>Data</th><th>Itens</th><th>Pagamento</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`}` });
}

function errorPage(ctx, status, message) {
  return layout({ ...ctx, title: `Erro ${status}`, body: `
    <section class="panel"><h1>Erro ${status}</h1><p>${esc(message)}</p><a href="/" class="button">Voltar à loja</a></section>` });
}

module.exports = {
  catalogPage, productPage, loginPage, cartPage, checkoutPage,
  orderConfirmedPage, ordersPage, errorPage, money,
};
