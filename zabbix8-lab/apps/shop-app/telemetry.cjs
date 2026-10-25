// Instrumentos OpenTelemetry da loja: tracer, métricas e logger.
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const SCOPE = 'zabbix-shop-demo';

const tracer = trace.getTracer(SCOPE, '1.0.0');
const meter = metrics.getMeter(SCOPE, '1.0.0');
const logger = logs.getLogger(SCOPE, '1.0.0');

const instruments = {
  logins: meter.createCounter('shop.logins', {
    description: 'Tentativas de login, por resultado',
  }),
  cartAdditions: meter.createCounter('shop.cart.items_added', {
    description: 'Itens adicionados à sacola, por produto',
    unit: '{item}',
  }),
  orders: meter.createCounter('shop.orders', {
    description: 'Pedidos finalizados, por status e forma de pagamento',
    unit: '{order}',
  }),
  revenue: meter.createCounter('shop.revenue', {
    description: 'Receita de pedidos confirmados',
    unit: 'BRL',
  }),
  orderValue: meter.createHistogram('shop.order.value', {
    description: 'Valor dos pedidos confirmados',
    unit: 'BRL',
    advice: { explicitBucketBoundaries: [25, 50, 100, 200, 400, 800, 1600] },
  }),
  checkoutDuration: meter.createHistogram('shop.checkout.duration', {
    description: 'Duração do processamento do checkout',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [100, 250, 500, 1000, 2000, 4000, 8000] },
  }),
  paymentDuration: meter.createHistogram('shop.payment.duration', {
    description: 'Duração da autorização de pagamento simulada',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2000] },
  }),
};

/**
 * Registra gauges observáveis lidos a cada exportação de métricas.
 * @param {() => Array<{id: string, name: string, stock: number}>} getProducts
 * @param {() => number} getActiveSessions
 */
function registerGauges(getProducts, getActiveSessions) {
  meter.createObservableGauge('shop.inventory.stock', {
    description: 'Estoque disponível por produto',
    unit: '{item}',
  }).addCallback((result) => {
    for (const product of getProducts()) {
      result.observe(product.stock, { 'shop.product.id': product.id, 'shop.product.name': product.name });
    }
  });

  meter.createObservableGauge('shop.sessions.active', {
    description: 'Sessões de usuários logados',
    unit: '{session}',
  }).addCallback((result) => result.observe(getActiveSessions()));
}

const SEVERITY = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

/**
 * Emite um log OTel. Dentro de um span ativo, o log sai correlacionado ao trace.
 */
function log(level, body, attributes = {}) {
  logger.emit({ severityNumber: SEVERITY[level], severityText: level, body, attributes });
}

/**
 * Executa fn dentro de um span filho. Exceções marcam o span como erro e são relançadas.
 */
async function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

module.exports = { instruments, registerGauges, log, withSpan, SpanStatusCode };
