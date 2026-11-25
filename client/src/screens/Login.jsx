import { useState } from 'react';
import { Logo } from '../components/Header.jsx';
import { PinPad } from '../components/ui.jsx';
import { login, useAppState, NAME_KEY } from '../lib/store.js';

export default function Login() {
  const s = useAppState();
  const [pin, setPin] = useState('');
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(value = pin) {
    if (value.length < 4 || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(value, name.trim());
    } catch (e) {
      setError(e.message || 'Não foi possível entrar.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="tricolore h-2" />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 py-8">
        <div className="flex flex-col items-center text-center">
          <Logo size="lg" />
          <p className="mt-4 text-seppia">Sistema de pedidos</p>
        </div>

        {s.outbox.pending > 0 && (
          <div className="rounded-2xl border-2 border-oro-400 bg-oro-100 p-3 text-center text-sm font-semibold">
            {s.outbox.pending} pedido(s) salvo(s) neste aparelho aguardando envio. Entre com o PIN de Garçom para enviá-los.
          </div>
        )}

        <div className="card p-5">
          <label className="label" htmlFor="nome">
            Seu nome (opcional, aparece no histórico)
          </label>
          <input id="nome" className="input mb-5" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Marco" autoComplete="off" />
          <p className="mb-3 text-center font-serif text-lg font-semibold">Digite seu PIN</p>
          <PinPad value={pin} onChange={setPin} onSubmit={submit} disabled={busy} />
          {error && <p className="mt-3 text-center font-semibold text-pomodoro-700" role="alert">{error}</p>}
          <button className="btn-primary mt-4 w-full text-lg" onClick={() => submit()} disabled={pin.length < 4 || busy} data-testid="login-submit">
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
        <p className="text-center text-xs text-seppia">O perfil fica lembrado neste aparelho até você sair.</p>
      </main>
    </div>
  );
}
