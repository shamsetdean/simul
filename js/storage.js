/* ==========================================================================
   simul — storage.js
   IndexedDB uniquement. Rien ne sort du telephone.
   ========================================================================== */

const DB_NAME = 'simul-db';
const DB_VERSION = 1;
const STORE = 'souvenirs';

let dbPromise = null;

function openDB(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)){
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('by_date', 'createdAt');
        store.createIndex('by_tags', 'tags', { multiEntry: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode){
  return openDB().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

const Storage = {

  /**
   * souvenir shape:
   * {
   *   id, createdAt, kind: 'photo'|'video',
   *   mediaBlob, mapImageBlob, lat, lng,
   *   tags: [string], captureMode: 'simultane'|'alterne'
   * }
   */
  async save(souvenir){
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(souvenir);
      req.onsuccess = () => resolve(souvenir);
      req.onerror = () => reject(req.error);
    });
  },

  async remove(id){
    const store = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  async getAll(){
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        items.sort((a, b) => b.createdAt - a.createdAt);
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async getById(id){
    const store = await tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async byTag(tag){
    const store = await tx('readonly');
    const idx = store.index('by_tags');
    return new Promise((resolve, reject) => {
      const req = idx.getAll(tag);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  /** Tags distincts deja utilises, pour l'autocomplete. */
  async allTags(){
    const items = await this.getAll();
    const set = new Set();
    items.forEach(s => (s.tags || []).forEach(t => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'));
  }
};

window.Storage = Storage;
