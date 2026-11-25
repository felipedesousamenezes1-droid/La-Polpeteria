// Fuso do restaurante: define o que é "o dia" no histórico, nas exportações e na numeração dos pedidos.
process.env.TZ ||= 'America/Sao_Paulo';

import os from 'node:os';
import { createApp, loadConfig } from './app.js';

const config = loadConfig();

// Proteção: na nuvem, recusar subir com disco temporário (os dados sumiriam a cada deploy).
const onCloud = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME);
const hasPersistentDir = !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);
if (onCloud && !hasPersistentDir && process.env.ALLOW_EPHEMERAL_DISK !== '1') {
  console.error(
    '\n[ERRO] Ambiente de nuvem detectado sem disco persistente.\n' +
      'Configure um volume/disco persistente e defina DATA_DIR com o caminho de montagem (veja o README).\n' +
      'O servidor NÃO será iniciado para evitar perda de pedidos.\n',
  );
  process.exit(1);
}

const instance = await createApp(config);
const port = await instance.listen();

const proto = config.httpsKey ? 'https' : 'http';
const addrs = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => `${proto}://${a.address}:${port}`);

console.log('\n  La Polpeteria — sistema de pedidos');
console.log(`  Dados em: ${config.dataDir}`);
console.log(`  Neste computador:   ${proto}://localhost:${port}`);
for (const a of addrs) console.log(`  Na rede (Wi-Fi):    ${a}`);
console.log(`LISTENING ${port}\n`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[${signal}] Encerrando com segurança...`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  try {
    await instance.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
