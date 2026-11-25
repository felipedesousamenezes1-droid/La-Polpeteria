// Fontes empacotadas localmente (funcionam sem internet na rede do restaurante)
import '@fontsource/playfair-display/latin-600.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/playfair-display/latin-700-italic.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import './index.css';

import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { startApp } from './lib/store.js';
import { unlockAudio } from './lib/sound.js';

startApp();
createRoot(document.getElementById('root')).render(<App />);

// Libera o áudio no primeiro toque (exigência dos navegadores).
window.addEventListener('pointerdown', unlockAudio, { passive: true });

// Service worker só existe em contexto seguro (HTTPS ou localhost).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
