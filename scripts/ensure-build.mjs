// Garante que o frontend esteja compilado antes de iniciar o servidor (npm start).
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
  console.log('Compilando o frontend (primeira execução)...');
  execSync('npx vite build', { stdio: 'inherit' });
}
