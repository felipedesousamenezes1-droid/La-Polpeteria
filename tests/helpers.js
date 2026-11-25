import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PINS = { garcom: '1111', cozinha: '2222', admin: '3333', caixa: '4444' };

export function tmpDataDir(name) {
  return fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), `pulpeteria-${name}-`));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Sobe o servidor real (node server/index.js) em um processo separado. */
export async function startServer({ dataDir, port, env = {} } = {}) {
  port ??= await freePort();
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      TZ: 'America/Sao_Paulo',
      BACKUP_INTERVAL_MINUTES: '60',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Servidor não subiu:\n${output}`)), 15000);
    const onData = (d) => {
      output += d;
      if (output.includes('LISTENING')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => (output += d));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Servidor saiu com código ${code}:\n${output}`));
    });
  });
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    proc,
    output: () => output,
    /** Encerramento normal (SIGTERM). */
    async stop() {
      if (proc.exitCode !== null || proc.signalCode) return;
      proc.kill('SIGTERM');
      await exited;
    },
    /** Queda brusca do processo (como falta de energia/travamento): SIGKILL, sem nenhuma limpeza. */
    async crash() {
      proc.kill('SIGKILL');
      await exited;
    },
  };
}

/** Cliente HTTP autenticado (simula um aparelho). */
export async function login(base, role, { name = `Teste ${role}`, deviceId = randomUUID() } = {}) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PINS[role], name, deviceId }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`login falhou: ${JSON.stringify(data)}`);
  return device(base, data.token, data.role);
}

export function device(base, token, role) {
  async function req(method, p, body) {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* corpo vazio */
    }
    return { status: r.status, data };
  }
  return {
    token,
    role,
    base,
    get: (p) => req('GET', p),
    post: (p, b = {}) => req('POST', p, b),
    put: (p, b = {}) => req('PUT', p, b),
  };
}

export function newOrder(tableNumber, items, extra = {}) {
  return {
    id: randomUUID(),
    tableNumber,
    clientCreatedAt: new Date().toISOString(),
    items: items.map(([menuItemId, qty, notes = '']) => ({ menuItemId, qty, notes })),
    ...extra,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stripVolatile(state) {
  const { serverTime, ...rest } = state;
  return rest;
}
