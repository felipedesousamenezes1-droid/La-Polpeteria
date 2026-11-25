// Armazenamento durável da fila de pedidos no aparelho: IndexedDB (com fallback para localStorage).

const DB_NAME = 'la-polpeteria';
const STORE = 'outbox';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueado'));
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    // durability 'strict': o navegador só confirma depois de gravar em disco.
    const tx = db.transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transação abortada'));
  });
}

function localStorageAdapter() {
  const KEY = 'polpeteria.outbox';
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      return {};
    }
  };
  return {
    kind: 'localStorage',
    getAll: async () => Object.values(read()),
    put: async (e) => {
      const all = read();
      all[e.id] = e;
      localStorage.setItem(KEY, JSON.stringify(all));
    },
    delete: async (id) => {
      const all = read();
      delete all[id];
      localStorage.setItem(KEY, JSON.stringify(all));
    },
  };
}

export async function createDeviceStorage() {
  try {
    if (!('indexedDB' in globalThis)) throw new Error('sem IndexedDB');
    const db = await openDb();
    return {
      kind: 'indexeddb',
      getAll: () => run(db, 'readonly', (s) => s.getAll()),
      put: (e) => run(db, 'readwrite', (s) => s.put(e)),
      delete: (id) => run(db, 'readwrite', (s) => s.delete(id)),
    };
  } catch (err) {
    console.warn('IndexedDB indisponível; usando localStorage.', err);
    return localStorageAdapter();
  }
}
