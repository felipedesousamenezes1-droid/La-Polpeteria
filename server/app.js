import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { openDatabase } from './db.js';
import { createAudit } from './audit.js';
import { createAuth } from './auth.js';
import { createServices } from './services.js';
import { seedIfEmpty, runDataMigrations } from './seed.js';
import { MANAGER_ROLES } from '../shared/constants.js';
import { createBackupManager, buildRangeExport } from './backup.js';
import { HttpError, localDate, localDayRange } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data')),
    distDir: path.resolve(env.DIST_DIR || path.join(ROOT, 'dist')),
    backupKeep: Number(env.BACKUP_KEEP || 50),
    backupIntervalMs: Number(env.BACKUP_INTERVAL_MINUTES || 10) * 60_000,
    httpsKey: env.HTTPS_KEY || null,
    httpsCert: env.HTTPS_CERT || null,
  };
}

/** Limite simples contra tentativa de adivinhar PIN por força bruta. */
function loginLimiter({ max = 10, windowMs = 5 * 60_000 } = {}) {
  const hits = new Map();
  return {
    check(ip) {
      const now = Date.now();
      const h = hits.get(ip);
      if (h && h.resetAt > now && h.count >= max) {
        throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Muitas tentativas de PIN. Aguarde alguns minutos.');
      }
    },
    fail(ip) {
      const now = Date.now();
      const h = hits.get(ip);
      if (!h || h.resetAt <= now) hits.set(ip, { count: 1, resetAt: now + windowMs });
      else h.count++;
    },
    ok(ip) {
      hits.delete(ip);
    },
  };
}

export async function createApp(config = loadConfig(), { logger = console } = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(path.join(config.dataDir, 'polpeteria.db'));
  const audit = createAudit(db);
  seedIfEmpty(db, audit);
  const migrated = runDataMigrations(db, audit);
  if (migrated) logger.log('[cardápio] sincronizado com o catálogo oficial:', migrated);
  const auth = createAuth({ db, audit });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const server =
    config.httpsKey && config.httpsCert
      ? https.createServer({ key: fs.readFileSync(config.httpsKey), cert: fs.readFileSync(config.httpsCert) }, app)
      : http.createServer(app);

  const io = new SocketServer(server, { pingInterval: 10_000, pingTimeout: 8_000, serveClient: false });
  // Cada evento carrega a versão (último id da auditoria) para o cliente nunca aplicar dado antigo sobre novo.
  const emit = (event, payload) => io.emit(event, { rev: audit.lastId(), data: payload });
  const services = createServices({ db, audit, auth, emit });
  const backups = createBackupManager({
    db,
    audit,
    services,
    dataDir: config.dataDir,
    keep: config.backupKeep,
    intervalMs: config.backupIntervalMs,
    logger,
  });

  io.use((socket, next) => {
    const session = auth.getSession(socket.handshake.auth?.token);
    if (!session) return next(new Error('unauthorized'));
    socket.data.session = session;
    next();
  });

  // ------------------------------------------------------------------ API
  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const limiter = loginLimiter();

  api.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  api.post('/login', (req, res) => {
    limiter.check(req.ip);
    try {
      const result = auth.login({ pin: req.body?.pin, name: req.body?.name, deviceId: req.body?.deviceId });
      limiter.ok(req.ip);
      res.json(result);
    } catch (err) {
      if (err.code === 'WRONG_PIN') limiter.fail(req.ip);
      throw err;
    }
  });

  api.use((req, res, next) => {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const session = auth.getSession(token);
    if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Sessão expirada. Entre novamente com o PIN.');
    req.actor = session;
    next();
  });

  /** Admin e Proprietário podem tudo; os demais perfis só o que for listado. */
  const allow =
    (...roles) =>
    (req, res, next) => {
      if (MANAGER_ROLES.includes(req.actor.role) || roles.includes(req.actor.role)) return next();
      throw new HttpError(403, 'FORBIDDEN', 'Este perfil não tem permissão para esta ação.');
    };

  api.get('/me', (req, res) => res.json({ role: req.actor.role, name: req.actor.name }));
  api.post('/logout', (req, res) => {
    auth.logout(req.actor);
    res.json({ ok: true });
  });
  api.get('/state', (req, res) => res.json({ ...services.state(), rev: audit.lastId() }));

  api.post('/orders', allow('garcom', 'caixa'), (req, res) => {
    const { order, duplicate } = services.createOrder(req.actor, req.body);
    res.status(duplicate ? 200 : 201).json({ order, duplicate });
  });
  api.post('/tickets/:id/status', allow('cozinha', 'garcom', 'caixa'), (req, res) => {
    res.json({ order: services.setTicketStatus(req.actor, req.params.id, req.body?.from, req.body?.to) });
  });
  api.post('/tickets/:id/fire', allow('garcom', 'caixa', 'cozinha'), (req, res) => {
    res.json({ order: services.fireTicket(req.actor, req.params.id) });
  });
  api.post('/tickets/:id/postpone', allow('garcom', 'caixa', 'cozinha'), (req, res) => {
    res.json({ order: services.postponeTicket(req.actor, req.params.id, req.body?.minutes ?? 10) });
  });
  api.post('/items/:id/cancel', (req, res) => {
    res.json(services.cancelItem(req.actor, req.params.id, req.body || {}));
  });
  api.post('/tabs/:id/request-bill', allow('garcom', 'caixa'), (req, res) => {
    res.json({ tab: services.requestBill(req.actor, req.params.id) });
  });
  api.get('/tabs/:id/bill', allow('garcom', 'caixa'), (req, res) => res.json(services.getBill(req.params.id)));
  api.post('/tabs/:id/service', allow('garcom', 'caixa'), (req, res) => {
    res.json({ tab: services.setService(req.actor, req.params.id, req.body?.enabled) });
  });
  api.post('/tabs/:id/close', allow('caixa'), (req, res) => {
    res.json(services.closeTab(req.actor, req.params.id, req.body?.expectedTotalCents));
  });
  api.post('/tabs/:id/reopen', allow('caixa'), (req, res) => {
    res.json({ tab: services.reopenTab(req.actor, req.params.id, req.body?.adminPin, req.body?.reason) });
  });

  // ---------------------------------------------------------- administração
  const admin = express.Router();
  admin.use(allow());
  admin.get('/menu', (req, res) => res.json(services.menu()));
  admin.post('/menu', (req, res) => res.status(201).json(services.createMenuItem(req.actor, req.body)));
  admin.put('/menu/:id', (req, res) => res.json(services.updateMenuItem(req.actor, Number(req.params.id), req.body)));
  admin.delete('/menu/:id', (req, res) => res.json(services.removeMenuItem(req.actor, Number(req.params.id))));
  admin.post('/menu/:id/move', (req, res) => res.json(services.moveMenuItem(req.actor, Number(req.params.id), req.body?.dir)));
  admin.get('/categories', (req, res) => res.json(services.categories()));
  admin.post('/categories', (req, res) => res.status(201).json(services.createCategory(req.actor, req.body)));
  admin.put('/categories/:name', (req, res) => res.json(services.updateCategory(req.actor, req.params.name, req.body)));
  admin.delete('/categories/:name', (req, res) => res.json(services.deleteCategory(req.actor, req.params.name)));
  admin.post('/categories/:name/move', (req, res) => res.json(services.moveCategory(req.actor, req.params.name, req.body?.dir)));
  admin.put('/settings', (req, res) => res.json(services.updateSettings(req.actor, req.body)));
  admin.put('/pins/:role', (req, res) => {
    auth.changePin(req.actor, req.params.role, req.body?.pin);
    for (const s of io.sockets.sockets.values()) {
      if (s.data.session?.role === req.params.role && !MANAGER_ROLES.includes(req.params.role)) {
        s.emit('session:revoked');
        s.disconnect(true);
      }
    }
    res.json({ ok: true });
  });
  admin.get('/audit', (req, res) => {
    const date = req.query.date || localDate();
    res.json({ date, entries: audit.list({ ...localDayRange(date), limit: Math.min(Number(req.query.limit) || 500, 5000) }) });
  });
  admin.get('/audit/verify', (req, res) => res.json(audit.verify()));
  admin.get('/backups', (req, res) => res.json({ dir: backups.backupDir, keep: config.backupKeep, files: backups.list() }));
  admin.post('/backups', async (req, res) => {
    db.transaction(() => audit.log(req.actor, 'backup.manual'))();
    const name = await backups.backupNow('manual');
    res.status(201).json({ name });
  });
  api.use('/admin', admin);

  // ---------------------------------------------------------- Proprietário: relatórios
  const owner = express.Router();
  owner.use((req, res, next) => {
    if (req.actor.role !== 'dono') throw new HttpError(403, 'FORBIDDEN', 'Relatórios: acesso exclusivo do Proprietário.');
    next();
  });
  const period = (req) => {
    const to = req.query.to || localDate();
    return { from: req.query.from || to, to };
  };
  owner.get('/report', (req, res) => {
    const { from, to } = period(req);
    res.json(services.report(from, to));
  });
  owner.get('/history', (req, res) => res.json(services.history(req.query.date || localDate())));
  owner.get('/export', (req, res) => {
    const { from, to } = period(req);
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const { csv, json } = buildRangeExport({ services, audit }, from, to);
    db.transaction(() => audit.log(req.actor, 'export.download', 'periodo', `${from}..${to}`, { formato: format }))();
    const name = from === to ? from : `${from}_a_${to}`;
    res.set('Content-Disposition', `attachment; filename="la-polpeteria_${name}.${format}"`);
    res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    res.send(format === 'csv' ? csv : json);
  });
  api.use('/owner', owner);

  api.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Rota não encontrada.' }));
  app.use('/api', api);

  // --------------------------------------------------------- frontend (PWA)
  const indexFile = path.join(config.distDir, 'index.html');
  app.use(
    express.static(config.distDir, {
      index: false,
      setHeaders(res, file) {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        else res.set('Cache-Control', 'no-cache');
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/socket.io')) return next();
    if (!fs.existsSync(indexFile)) {
      return res.status(503).type('text').send('Frontend ainda não compilado. Execute: npm run build');
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });

  // ------------------------------------------------------------- erros
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'BAD_JSON', message: 'Requisição malformada.' });
    }
    if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      const closed = err.message.includes('CONTA_FECHADA');
      return res.status(409).json({ error: closed ? 'TAB_CLOSED' : 'CONSTRAINT', message: err.message.replace(/^[A-Z_]+: /, '') });
    }
    logger.error('[erro]', err);
    res.status(500).json({ error: 'INTERNAL', message: 'Erro interno no servidor.' });
  });

  let schedulerTimer = null;
  async function listen(port = config.port, host = config.host) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    backups.start();
    // Agendador dos tempos do Menu Completo (também roda após cada mudança na cozinha).
    const tick = () => {
      try {
        services.runScheduler();
      } catch (err) {
        logger.error('[agendador] falha:', err);
      }
    };
    tick();
    schedulerTimer = setInterval(tick, 5000);
    schedulerTimer.unref?.();
    return server.address().port;
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(schedulerTimer);
    await backups.stop();
    io.close();
    await new Promise((r) => server.close(() => r()));
    db.close(); // faz checkpoint do WAL
  }

  return { app, server, io, db, audit, auth, services, backups, listen, close, config };
}
