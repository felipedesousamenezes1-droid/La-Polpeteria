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
  await garcom.click('button[data-testid^=item-]:has-text("Coca-Cola lata")');
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
  assert(cardText.includes('Rotolini di Zucchine') && /tempo 1 de 3/i.test(cardText), 'cozinha recebe só a ENTRADA do Menu Completo (tempo 1 de 3)');
  assert(!cardText.includes('Risotto') && !cardText.includes('Tiramisu'), 'prato principal e sobremesa ficam aguardando o garçom');
  assert(!cardText.includes('Coca-Cola'), 'bebida não vai para a cozinha');
  await shot(cozinha, '04-cozinha-novo-pedido');

  // ---------------- Cozinha avança a entrada: Novo → Preparando → Pronto (um toque cada)
  await card.locator('button').first().click();
  await cozinha.waitForSelector('[data-testid=coluna-preparando] article:has-text("Mesa 5")');
  await cozinha.locator('[data-testid=coluna-preparando] article:has-text("Mesa 5") button').first().click();
  await cozinha.waitForSelector('[data-testid=coluna-pronto] article:has-text("Mesa 5")');
  ok('cozinha: Novo → Preparando → Pronto com um toque por etapa');
  await garcom.waitForSelector('[data-testid=alerta-pronto]:has-text("Entrada PRONTO")');
  assert((await garcom.getAttribute('[data-testid=mesa-5]', 'data-status')) === 'pronto', 'garçom recebeu alerta "Entrada PRONTO" e a mesa 5 ficou dourada');
  await shot(garcom, '05-garcom-alerta-pronto');
  await garcom.click('[data-testid=alerta-pronto] button:has-text("Entregue")');
  await garcom.waitForFunction(() => document.querySelector('[data-testid=mesa-5]')?.dataset.status === 'ocupada');
  ok('garçom deu o check de "Entregue" só na entrada');

  // ---------------- Prato principal sai SOZINHO (sem o garçom precisar lembrar)
  await garcom.click('[data-testid=mesa-5]');
  await garcom.click('[data-testid=ver-conta-mesa]');
  await garcom.waitForSelector('[data-testid=agenda-principal]');
  const agenda = await garcom.textContent('[data-testid=agenda-principal]');
  assert(/Sai sozinho às \d{2}:\d{2} \(em [45] min\)/.test(agenda), `garçom vê o envio automático do prato principal: "${agenda}"`);
  const agendaSob = await garcom.textContent('[data-testid=agenda-sobremesa]');
  assert(/20 min depois que o prato principal ficar pronto/.test(agendaSob), `sobremesa: "${agendaSob}"`);
  await shot(garcom, '10-garcom-tempos');
  const strip = await cozinha.textContent('[data-testid=proximos-tempos]');
  assert(strip.includes('Mesa 5 · Prato principal') && strip.includes('Sai sozinho'), 'cozinha vê o prato principal em "Próximos tempos", com contagem regressiva');
  await shot(cozinha, '12-cozinha-proximos');
  // Para não esperar 5 minutos no teste, o Admin encurta o intervalo para 0: o horário já passou e o prato sai sozinho.
  const adminRes = await fetch(`${server.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '3333' }) });
  const adminToken = (await adminRes.json()).token;
  await fetch(`${server.base}/api/admin/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ coursePrincipalDelay: 0 }),
  });
  await cozinha.waitForSelector('[data-testid=coluna-novo] article:has-text("Prato principal")');
  const principal = await cozinha.textContent('[data-testid=coluna-novo] article:has-text("Prato principal")');
  assert(principal.includes('Risotto alla Pera') && /tempo 2 de 3/i.test(principal), 'prato principal chegou sozinho na cozinha (tempo 2 de 3), sem nenhum toque do garçom');
  await garcom.click('[data-testid=voltar-mesas]');

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
  assert(/R\$\s?151,80/.test(total), `conta da mesa 5 = ${total} (Menu Completo R$ 130 + Coca-Cola R$ 8 + serviço 10%)`);
  await caixa.click('[data-testid=servico-caixa]');
  await caixa.waitForFunction(() => /138,00/.test(document.querySelector('[data-testid=total-conta]')?.textContent || ''));
  ok('caixa retirou os 10%: R$ 138,00');
  await caixa.click('[data-testid=servico-caixa]');
  await caixa.waitForFunction(() => /151,80/.test(document.querySelector('[data-testid=total-conta]')?.textContent || ''));
  ok('caixa incluiu os 10% de novo: R$ 151,80');
  await shot(caixa, '08-caixa-conta');
  await caixa.click('[data-testid=fechar-conta]');
  await caixa.click('button:has-text("Fechar · R$")');
  await caixa.waitForSelector('text=/Conta fechada às/');
  ok('caixa fechou a conta (mesa travada; reabrir exige PIN de Admin)');
  await garcom.waitForFunction(() => document.querySelector('[data-testid=mesa-5]')?.dataset.status === 'livre');
  ok('mesa 5 voltou a "Livre" no aparelho do garçom em tempo real');
  await shot(garcom, '01-garcom-mesas');

  // ---------------- Proprietário: painel de vendas
  const donoCtx = await browser.newContext({ viewport: { width: 1280, height: 1800 }, deviceScaleFactor: 1 });
  const dono = await donoCtx.newPage();
  dono.on('pageerror', (e) => errors.push(`proprietário: ${e.message}`));
  await login(dono, server.base, '5555');
  await dono.click('button:has-text("Hoje")');
  await dono.waitForSelector('[data-testid=kpis]');
  const kpis = await dono.textContent('[data-testid=kpis]');
  assert(kpis.includes('R$') && kpis.includes('206,00'), 'painel do Proprietário mostra as vendas do dia (R$ 206,00)');
  assert((await dono.locator('[data-testid=tabela-produtos] tbody tr:has-text("Menu Completo")').count()) === 1, 'tabela de produtos lista o Menu Completo');
  await shot(dono, '09-proprietario-painel');
  await dono.selectOption('select[aria-label="Trocar tela"]', 'admin');
  await dono.waitForSelector('[data-testid=nova-secao]');
  assert((await dono.locator('[data-testid="secao-Outros"]:has-text("Taxa de rolha")').count()) === 1, 'Admin: seção "Outros" com a taxa de rolha');
  await shot(dono, '11-admin-cardapio');

  // ---------------- Começar a operação do zero (Proprietário), com um celular offline guardando um pedido de teste
  await waiterCtx.setOffline(true);
  await garcom.click('[data-testid=mesa-9]');
  await garcom.click('button[data-testid^=item-]:has-text("Tiramisu")');
  await garcom.click('[data-testid=enviar-cozinha]');
  await garcom.waitForSelector('[data-testid=sync-status]:has-text("1 pedido pendente")');
  await garcom.waitForTimeout(6000);
  await dono.selectOption('select[aria-label="Trocar tela"]', 'dono');
  await dono.click('button:has-text("Zerar dados de teste")');
  await dono.fill('#zerar-pin', '5555');
  await dono.fill('#zerar-confirma', 'ZERAR');
  await shot(dono, '13-zerar-antes');
  await dono.click('[data-testid=zerar-executar]');
  await dono.waitForSelector('[data-testid=zerar-ok]');
  ok('Proprietário apagou os dados de teste (PIN + ZERAR, com backup antes)');
  await cozinha.waitForFunction(() => !document.querySelector('article'));
  ok('quadro da cozinha ficou vazio na hora');
  await caixa.waitForFunction(() => !document.querySelector('[data-testid^=conta-mesa-]'));
  ok('caixa sem contas (inclusive as abertas)');
  await waiterCtx.setOffline(false);
  await garcom.waitForSelector('[data-testid=sync-status]:has-text("Sincronizado")', { timeout: 15000 });
  await cozinha.waitForTimeout(2500);
  assert((await cozinha.locator('article:has-text("Mesa 9")').count()) === 0, 'pedido de teste que estava no celular offline NÃO foi reenviado');
  assert((await garcom.getAttribute('[data-testid=mesa-9]', 'data-status')) === 'livre', 'mesa 9 livre no garçom');
  await garcom.click('[data-testid=mesa-2]');
  await garcom.click('button[data-testid^=item-]:has-text("Rotolini di Zucchine")');
  await garcom.click('[data-testid=enviar-cozinha]');
  await cozinha.waitForSelector('article:has-text("Mesa 2")');
  assert((await cozinha.textContent('article:has-text("Mesa 2")')).includes('#1 ·'), 'primeiro pedido real chega à cozinha como #1');
  await dono.click('button:has-text("Ir para o painel")');
  await dono.waitForFunction(() => !Array.from(document.querySelectorAll('nav button')).some((b) => b.textContent.includes('Zerar')));
  ok('opção de zerar desaparece depois de usada');

  assert(errors.length === 0, `sem erros de JavaScript nas páginas${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log(`\nResultado: ${results.length} verificações OK\n`);
} catch (err) {
  console.error(`\n${err.stack || err}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.stop();
}
