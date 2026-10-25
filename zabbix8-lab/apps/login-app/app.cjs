const telemetrySdk = require('./instrumentation.cjs');
const http = require('node:http');
const crypto = require('node:crypto');
const { metrics } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const username = process.env.APP_USERNAME || 'demo';
const password = process.env.APP_PASSWORD;
const sessionSecret = process.env.SESSION_SECRET;

if (!password || !sessionSecret || Buffer.byteLength(sessionSecret) < 32) {
  throw new Error('APP_PASSWORD and a SESSION_SECRET of at least 32 bytes are required');
}

const meter = metrics.getMeter('zabbix-login-demo');
const loginAttempts = meter.createCounter('login.attempts', {
  description: 'Number of login attempts, split by outcome',
});
const loginDuration = meter.createHistogram('login.duration', {
  description: 'Duration of login attempts in milliseconds',
  unit: 'ms',
});
const logger = logs.getLogger('zabbix-login-demo');
const sessionCookie = 'login_session';
const sessionLifetimeSeconds = 3600;

function safeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function createSession(user) {
  const payload = Buffer.from(JSON.stringify({
    username: user,
    expires: Date.now() + sessionLifetimeSeconds * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`));
  if (!cookie) return null;

  const [payload, signature] = cookie.slice(sessionCookie.length + 1).split('.');
  if (!payload || !signature) return null;

  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  let session;
  try {
    session = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  return session.expires > Date.now() ? session : null;
}

function sendHtml(res, statusCode, html, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    ...headers,
  });
  res.end(html);
}

function loginPage(message = '') {
  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login demonstrativo</title>
<body>
  <main>
    <h1>Aplicação demonstrativa</h1>
    <p>Entre com as credenciais de demonstração configuradas no ambiente.</p>
    ${message ? `<p role="alert">${message}</p>` : ''}
    <form method="post" action="/login">
      <label>Usuário <input name="username" autocomplete="username" required></label>
      <label>Senha <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`;
}

function dashboardPage(user) {
  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Área autenticada</title>
<body>
  <main>
    <h1>Login realizado</h1>
    <p>Bem-vindo, ${user}.</p>
    <p>Esta página demonstra a instrumentação de logs, traces e métricas com OpenTelemetry.</p>
    <form method="post" action="/logout"><button type="submit">Sair</button></form>
  </main>
</body>
</html>`;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body) > 4096) {
        rejected = true;
        reject(new Error('Form body exceeds 4 KB'));
      }
    });
    req.on('end', () => {
      if (!rejected) resolve(new URLSearchParams(body));
    });
    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const session = readSession(req);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    if (session) {
      res.writeHead(303, { Location: '/dashboard' });
      res.end();
      return;
    }
    sendHtml(res, 200, loginPage());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    const start = process.hrtime.bigint();
    try {
      const form = await readForm(req);
      const submittedUser = form.get('username') || '';
      const submittedPassword = form.get('password') || '';
      const succeeded = safeEqual(submittedUser, username) && safeEqual(submittedPassword, password);
      const outcome = succeeded ? 'success' : 'failure';

      loginAttempts.add(1, { outcome });
      loginDuration.record(Number(process.hrtime.bigint() - start) / 1e6, { outcome });
      logger.emit({
        severityNumber: succeeded ? SeverityNumber.INFO : SeverityNumber.WARN,
        severityText: succeeded ? 'INFO' : 'WARN',
        body: succeeded ? 'User login succeeded' : 'User login failed',
        attributes: { 'login.outcome': outcome },
      });

      if (!succeeded) {
        sendHtml(res, 401, loginPage('Usuário ou senha inválidos.'));
        return;
      }

      res.writeHead(303, {
        Location: '/dashboard',
        'Set-Cookie': `${sessionCookie}=${createSession(username)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionLifetimeSeconds}`,
      });
      res.end();
    } catch (error) {
      logger.emit({
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        body: 'Login request could not be processed',
        attributes: { 'error.type': error.name },
      });
      sendHtml(res, 400, loginPage('Não foi possível processar a solicitação.'));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/dashboard') {
    if (!session) {
      res.writeHead(303, { Location: '/login' });
      res.end();
      return;
    }
    sendHtml(res, 200, dashboardPage(session.username));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/logout') {
    res.writeHead(303, {
      Location: '/login',
      'Set-Cookie': `${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    res.end();
    return;
  }

  sendHtml(res, 404, '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Não encontrado</title><h1>Não encontrado</h1>');
});

server.listen(8080, '0.0.0.0', () => {
  process.stdout.write('Login demo listening on port 8080\n');
});

function shutdown() {
  server.close(async () => {
    await telemetrySdk.shutdown();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
