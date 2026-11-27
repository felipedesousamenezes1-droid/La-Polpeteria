import { time } from './util.js';

// "a entrada ficar pronta" / "o prato principal ficar pronto"
const PREV_TEXT = {
  entrada: 'a entrada ficar pronta',
  principal: 'o prato principal ficar pronto',
  sobremesa: 'a sobremesa ficar pronta',
  unico: 'os pratos anteriores ficarem prontos',
};

/** Texto do envio automático de um tempo que ainda aguarda. */
export function scheduleText(ticket, order, settings, nowMs) {
  if (ticket.scheduledAt) {
    const mins = Math.ceil((Date.parse(ticket.scheduledAt) - nowMs) / 60000);
    return `Sai sozinho às ${time(ticket.scheduledAt)} (${mins <= 0 ? 'agora' : `em ${mins} min`})`;
  }
  const prev = order.tickets.filter((x) => x.tempo < ticket.tempo && !x.fullyCancelled).pop();
  const base = ticket.course === 'sobremesa' ? settings.courseSobremesaDelay : settings.coursePrincipalDelay;
  const total = (base ?? 0) + (ticket.extraDelayMin || 0);
  const when = total > 0 ? `${total} min depois que` : 'assim que';
  return `Sai sozinho ${when} ${PREV_TEXT[prev?.course] || 'o tempo anterior ficar pronto'}`;
}
