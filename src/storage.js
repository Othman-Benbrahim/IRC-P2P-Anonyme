// storage.js
// Persistance locale via IndexedDB (s'exécute dans le background, qui a le DOM).
// Deux magasins : "messages" (historique du chat) et "peers" (pairs connus).
// Aucune donnée ne quitte la machine.

const Storage = {
  db: null,
  DB_NAME: "ircp2p",
  DB_VERSION: 1,
  MAX_MESSAGES: 5000, // au-delà, on élague les plus anciens

  init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("messages")) {
          const s = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
          s.createIndex("ts", "ts");
          s.createIndex("channel", "channel");
        }
        if (!db.objectStoreNames.contains("peers")) {
          db.createObjectStore("peers", { keyPath: "pubkey" });
        }
      };

      req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },

  _tx(store, mode) {
    return this.db.transaction(store, mode).objectStore(store);
  },

  // Ajoute un message et renvoie l'entrée avec son id attribué.
  addMessage(entry) {
    return new Promise((resolve, reject) => {
      const store = this._tx("messages", "readwrite");
      const req = store.add(entry);
      req.onsuccess = () => resolve({ ...entry, id: req.result });
      req.onerror = () => reject(req.error);
    });
  },

  // Récupère les N derniers messages (ordre chronologique croissant).
  getRecentMessages(limit = 200) {
    return new Promise((resolve, reject) => {
      const out = [];
      const idx = this._tx("messages", "readonly").index("ts");
      const cursorReq = idx.openCursor(null, "prev"); // du plus récent au plus ancien
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && out.length < limit) {
          out.push(cursor.value);
          cursor.continue();
        } else {
          resolve(out.reverse()); // remet en ordre croissant
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  },

  // Élague l'historique si on dépasse MAX_MESSAGES.
  async pruneIfNeeded() {
    const store = this._tx("messages", "readwrite");
    const count = await new Promise((res) => { const r = store.count(); r.onsuccess = () => res(r.result); });
    if (count <= this.MAX_MESSAGES) return;
    let toDelete = count - this.MAX_MESSAGES;
    const cursorReq = this._tx("messages", "readwrite").index("ts").openCursor(null, "next");
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && toDelete > 0) {
        cursor.delete();
        toDelete--;
        cursor.continue();
      }
    };
  },

  savePeer(peer) {
    return new Promise((resolve, reject) => {
      const store = this._tx("peers", "readwrite");
      const req = store.put(peer); // { pubkey, nick, lastSeen }
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  getPeers() {
    return new Promise((resolve, reject) => {
      const req = this._tx("peers", "readonly").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  clearAll() {
    return new Promise((resolve) => {
      const tx = this.db.transaction(["messages", "peers"], "readwrite");
      tx.objectStore("messages").clear();
      tx.objectStore("peers").clear();
      tx.oncomplete = () => resolve();
    });
  }
};
