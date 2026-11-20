// Browser-local data only. IndexedDB is not an encrypted vault.
export function createStore(indexedDBImpl) {
  let database;
  let queue = Promise.resolve();
  async function open() {
    if (indexedDBImpl === undefined) {
      try { indexedDBImpl = globalThis.indexedDB; } catch { indexedDBImpl = null; }
    }
    if (!indexedDBImpl) throw new Error('Browser storage is unavailable. Changes will not survive reload.');
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDBImpl.open('prism-local', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined; };
        resolve(request.result);
      };
      request.onerror = () => reject(new Error('Could not open browser storage.'));
      request.onblocked = () => reject(new Error('Close other Prism tabs to enable browser storage.'));
    });
    return database;
  }
  async function transact(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('workspace', mode);
      const request = action(transaction.objectStore('workspace'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(new Error('Unable to save browser data. Storage may be full or disabled. Download your chats before closing.'));
    });
  }
  return {
    load: () => transact('readonly', store => store.get('current')),
    save(value) {
      const snapshot = structuredClone(value);
      queue = queue.catch(() => {}).then(() => transact('readwrite', store => store.put(snapshot, 'current')));
      return queue;
    },
    clear() {
      queue = queue.catch(() => {}).then(() => transact('readwrite', store => store.clear()));
      return queue;
    },
  };
}
