// Sons gerados pela Web Audio API (sem arquivos de áudio). O navegador só libera o áudio
// depois de um toque do usuário; por isso "destravamos" no primeiro toque em qualquer lugar.

let ctx = null;

export function unlockAudio() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  } catch {
    return false;
  }
}

export function audioReady() {
  return !!ctx && ctx.state === 'running';
}

function tone(freq, start, duration, { type = 'sine', gain = 0.3 } = {}) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/** Cozinha: novo pedido (campainha dupla, repetida). */
export function playNewOrder() {
  if (!unlockAudio() || !ctx) return;
  [0, 0.7].forEach((o) => {
    tone(988, o, 0.35, { type: 'triangle', gain: 0.45 });
    tone(1319, o + 0.18, 0.45, { type: 'triangle', gain: 0.45 });
  });
}

/** Garçom: pedido pronto (arpejo ascendente). */
export function playReady() {
  if (!unlockAudio() || !ctx) return;
  tone(660, 0, 0.25, { gain: 0.4 });
  tone(880, 0.15, 0.25, { gain: 0.4 });
  tone(1175, 0.3, 0.5, { gain: 0.4 });
}

/** Erro / atenção. */
export function playAlert() {
  if (!unlockAudio() || !ctx) return;
  tone(330, 0, 0.3, { type: 'square', gain: 0.15 });
  tone(262, 0.3, 0.4, { type: 'square', gain: 0.15 });
}
