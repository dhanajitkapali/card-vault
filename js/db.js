// IndexedDB: db `vault`, stores `meta` (key/value) and `cards` (keyed by id).
// Card records hold only { id, iv, ct } — the label is inside the ciphertext,
// so the list leaks nothing before unlock (PLAN.md §4).

const DB_NAME = 'vault';
const DB_VERSION = 1;

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const metaGet = (k) => tx('meta', 'readonly', (s) => s.get(k));
export const metaSet = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));
export const metaDel = (k) => tx('meta', 'readwrite', (s) => s.delete(k));

export const cardsAll = () => tx('cards', 'readonly', (s) => s.getAll());
export const cardPut = (rec) => tx('cards', 'readwrite', (s) => s.put(rec));
export const cardDel = (id) => tx('cards', 'readwrite', (s) => s.delete(id));

export async function isInitialised() {
  return Boolean(await metaGet('salt'));
}

// Best-effort hint to the OS not to evict us under storage pressure.
// Home-screen install is what actually matters on iOS; this costs nothing.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch { /* not supported — ignore */ }
  return false;
}
