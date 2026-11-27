import { useEffect } from 'react';
import { useAppState, on, addReadyAlert } from './lib/store.js';
import { playReady } from './lib/sound.js';
import { vibrate } from './lib/util.js';
import { Header, Toasts, Logo } from './components/Header.jsx';
import Login from './screens/Login.jsx';
import WaiterScreen from './screens/waiter/WaiterScreen.jsx';
import KitchenScreen from './screens/kitchen/KitchenScreen.jsx';
import CashierScreen from './screens/cashier/CashierScreen.jsx';
import AdminScreen from './screens/admin/AdminScreen.jsx';
import OwnerScreen from './screens/owner/OwnerScreen.jsx';

const SCREENS = {
  garcom: WaiterScreen,
  cozinha: KitchenScreen,
  caixa: CashierScreen,
  admin: AdminScreen,
  dono: OwnerScreen,
};

function Loading() {
  const s = useAppState();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Logo size="lg" />
      <p className="text-lg text-seppia">{s.online ? 'Conectando ao servidor…' : 'Aparelho sem conexão. Aguardando a rede…'}</p>
      {s.outbox.pending > 0 && <p className="font-semibold">{s.outbox.pending} pedido(s) salvos neste aparelho serão enviados automaticamente.</p>}
    </div>
  );
}

export default function App() {
  const s = useAppState();
  const role = s.session?.role;
  const allowed = role === 'dono' ? ['dono', 'admin', 'garcom', 'cozinha', 'caixa'] : role === 'admin' ? ['admin', 'garcom', 'cozinha', 'caixa'] : [role];
  const screen = role ? (allowed.includes(s.screen) ? s.screen : allowed[0]) : null;

  // Garçom: som + vibração + faixa de alerta quando a cozinha marca "pronto".
  useEffect(() => {
    if (screen !== 'garcom') return undefined;
    return on('ticket:ready', ({ ticket }) => {
      playReady();
      vibrate([200, 100, 200]);
      addReadyAlert(ticket.id);
    });
  }, [screen]);

  if (!s.session) {
    return (
      <>
        <Login />
        <Toasts />
      </>
    );
  }
  const Screen = SCREENS[screen] || WaiterScreen;
  return (
    <div className="flex h-full flex-col">
      <Header screen={screen} />
      {s.loaded ? <Screen /> : <Loading />}
      <Toasts />
    </div>
  );
}
