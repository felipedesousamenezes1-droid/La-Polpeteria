// Teste ponta a ponta com navegador real: aba do GARÇOM (celular) + aba da COZINHA (tela grande)
// + aba do CAIXA. Inclui queda de rede no aparelho do garçom.
// Requer Playwright com Chromium instalado (npx playwright install chromium).
// Uso: npm run e2e            (sobe um servidor temporário)
//      CAPTURAS=docs/capturas npm run e2e   (salva capturas de tela)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.CAPTURAS ? path.resolve(ROOT, process.env.CAPTURAS) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (msg) => {
  results.push(msg);
  console.log(`  ✔ ${msg}`);
};
function assert(cond, msg) {
  if (!cond) throw new Error(`FALHOU: ${msg}`);
  ok(msg);
}

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(process.env.E2E_TMPDIR || os.tmpdir(), 'polpeteria-e2e-'));
  const port = 3300 + Math.floor(Math.random() * 500);
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      if (out.includes('LISTENING')) resolve();
    });
    proc.on('exit', (c) => reject(new Error(`servidor saiu (${c})`)));
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => proc.kill('SIGTERM') };
}

async function login(page, base, pin, name) {
  await page.goto(base);
  if (name) await page.fill('#nome', name);
  for (const d of pin) await page.click(`button:text-is("${d}")`);
  await page.click('[data-testid=login-submit]');
}

const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const server = process.env.BASE_URL ? { base: process.env.BASE_URL, stop() {} } : await startServer();
const browser = await chromium.launch();
try {
  console.log(`\nServidor: ${server.base}\n`);
  const waiterCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const kitchenCtx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const cashierCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 });
  const garcom = await waiterCtx.newPage();
  const cozinha = await kitchenCtx.newPage();
  const caixa = await cashierCtx.newPage();
  const errors = [];
  for (const [n, p] of [['garçom', garcom], ['cozinha', cozinha], ['caixa', caixa]]) p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));

  await login(garcom, server.base, '1111', 'Marco');
  await login(cozinha, server.base, '2222');
  await login(caixa, server.base, '4444');
  await garcom.waitForSelector('[data-testid=mesa-1]');
  await cozinha.waitForSelector('[data-testid=coluna-novo]');
  ok('garçom, cozinha e caixa conectados (PIN 1111 / 2222 / 4444)');
  await garcom.waitForSelector('text=Sincronizado');

  // ---------------- Pedido com Menu Completo em 3 toques + bebida
  await garcom.click('[data-testid=mesa-5]'); // toque 1
  await garcom.click('button[data-testid^=item-]:has-text("Menu Completo")'); // toque 2: abre as escolhas (entrada única já vem marcada)
  await garcom.click('[data-testid^=combo-principal-]:has-text("Risotto alla Pera")'); // prato principal
  await shot(garcom, '03-garcom-menu-completo');
  await garcom.click('[data-testid^=combo-sobremesa-]:has-text("Tiramisu")'); // sobremesa: entra no pedido sozinho
  await garcom.click('button[data-testid^=item-]:has-text("Refrigerante lata")');
  await shot(garcom, '02-garcom-cardapio');
  const t0 = Date.now();
  await garcom.click('[data-testid=enviar-cozinha]'); // toque 3: envia
  await cozinha.waitForSelector('article:has-text("Mesa 5")');
  const latency = Date.now() - t0;
  assert(latency < 1000, `pedido apareceu na cozinha em ${latency} ms (< 1 s)`);
  await garcom.waitForSelector('text=/pedido #1 enviado ✓/');
  ok('garçom viu "Enviado ✓" após confirmação do servidor');
  const card = cozinha.locator('article:has-text("Mesa 5")');
  const cardText = await card.textContent();
  assert(cardText.includes('Rotolini di Zucchine') && cardText.includes('Tiramisu'), 'cozinha vê as escolhas do Menu Completo (entrada, principal, sobremesa)');
  await shot(cozinha, '04-cozinha-novo-pedido');

  // ---------------- Cozinha avança: Novo → Preparando → Pronto (um toque cada)
  await card.locator('button').first().click();
  await cozinha.waitForSelector('[data-testid=coluna-preparando] article:has-text("Mesa 5")');
  await cozinha.locator('[data-testid=coluna-preparando] article:has-text("Mesa 5") button').first().click();
  await cozinha.waitForSelector('[data-testid=coluna-pronto] article:has-text("Mesa 5")');
  ok('cozinha: Novo → Preparando → Pronto com um toque por etapa');
  await garcom.waitForSelector('[data-testid=alerta-pronto]:has-text("Mesa 5")');
  assert((await garcom.getAttribute('[data-testid=mesa-5]', 'data-status')) === 'pronto', 'garçom recebeu alerta "PRONTO" e a mesa 5 ficou dourada');
  await shot(garcom, '05-garcom-alerta-pronto');

  // ---------------- Queda de internet no aparelho do garçom
  await waiterCtx.setOffline(true);
  await garcom.click('[data-testid=mesa-7]');
  await garcom.click('button[data-testid^=item-]:has-text("Pasta all\'Ortolana")');
  await garcom.click('[data-testid=enviar-cozinha]');
  await garcom.waitForSelector('[data-testid=sync-status]:has-text("1 pedido pendente")');
  ok('sem internet: pedido salvo no aparelho e indicador "1 pedido pendente"');
  assert((await garcom.getAttribute('[data-testid=mesa-7]', 'data-status')) === 'ocupada', 'mesa 7 marcada com pedido pendente');
  await shot(garcom, '06-garcom-offline-pendente');
  await cozinha.waitForTimeout(800);
  assert((await cozinha.locator('article:has-text("Mesa 7")').count()) === 0, 'cozinha ainda não recebeu (aparelho offline)');
  await garcom.reload(); // recarregar o app offline não perde o pedido
  await garcom.waitForSelector('[data-testid=sync-status]:has-text("1 pedido pendente")');
  ok('após recarregar a página offline, o pedido continua pendente no aparelho (IndexedDB)');
  await waiterCtx.setOffline(false);
  await cozinha.waitForSelector('article:has-text("Mesa 7")', { timeout: 15000 });
  await garcom.waitForSelector('[data-testid=sync-status]:has-text("Sincronizado")', { timeout: 15000 });
  ok('rede voltou: reenvio automático, cozinha recebeu e o garçom voltou a "Sincronizado"');
  await shot(cozinha, '07-cozinha-quadro');

  // ---------------- Caixa: conta da mesa 5
  await caixa.waitForSelector('[data-testid=conta-mesa-5]');
  await caixa.click('[data-testid=conta-mesa-5]');
  await caixa.waitForSelector('[data-testid=total-conta]');
  const total = (await caixa.textContent('[data-testid=total-conta]')).replace(/\s/g, ' ').trim();
  assert(/R\$\s?140,00/.test(total), `conta da mesa 5 = ${total} (Menu Completo R$ 130 + refrigerante R$ 10)`);
  await shot(caixa, '08-caixa-conta');
  await caixa.click('[data-testid=fechar-conta]');
  await caixa.click('button:has-text("Fechar · R$")');
  await caixa.waitForSelector('text=/Conta fechada às/');
  ok('caixa fechou a conta (mesa travada; reabrir exige PIN de Admin)');
  await garcom.waitForFunction(() => document.querySelector('[data-testid=mesa-5]')?.dataset.status === 'livre');
  ok('mesa 5 voltou a "Livre" no aparelho do garçom em tempo real');
  await shot(garcom, '01-garcom-mesas');

  assert(errors.length === 0, `sem erros de JavaScript nas páginas${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log(`\nResultado: ${results.length} verificações OK\n`);
} catch (err) {
  console.error(`\n${err.stack || err}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.stop();
}
