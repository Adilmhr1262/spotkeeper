/* SpotKeeper — db.js
   IndexedDB layer. Database: spotkeeper-db, version 1.
   Stores: items (keyPath id), locations (keyPath id).
   Every mutation runs inside a transaction; a promise resolves only
   after the transaction commits, so the UI never reports a save that
   did not land. */
(function (global) {
  'use strict';

  var DB_NAME = 'spotkeeper-db';
  var DB_VERSION = 1;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('items')) {
          db.createObjectStore('items', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('locations')) {
          db.createObjectStore('locations', { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Could not open database.')); };
      req.onblocked = function () { reject(new Error('Database is blocked by another tab.')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('Transaction failed.')); };
      tx.onabort = function () { reject(tx.error || new Error('Transaction aborted.')); };
    });
  }

  function requestResult(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Database request failed.')); };
    });
  }

  function newId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    // Fallback for contexts without randomUUID (still unique enough here).
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  var api = {
    newId: newId,

    getAllItems: function () {
      return openDb().then(function (db) {
        var tx = db.transaction('items', 'readonly');
        var p = requestResult(tx.objectStore('items').getAll());
        return p.finally(function () { db.close(); });
      });
    },

    getAllLocations: function () {
      return openDb().then(function (db) {
        var tx = db.transaction('locations', 'readonly');
        var p = requestResult(tx.objectStore('locations').getAll());
        return p.finally(function () { db.close(); });
      });
    },

    getItem: function (id) {
      return openDb().then(function (db) {
        var tx = db.transaction('items', 'readonly');
        var p = requestResult(tx.objectStore('items').get(id));
        return p.finally(function () { db.close(); });
      });
    },

    getLocation: function (id) {
      return openDb().then(function (db) {
        var tx = db.transaction('locations', 'readonly');
        var p = requestResult(tx.objectStore('locations').get(id));
        return p.finally(function () { db.close(); });
      });
    },

    putItem: function (item) {
      return openDb().then(function (db) {
        var tx = db.transaction('items', 'readwrite');
        tx.objectStore('items').put(item);
        return txDone(tx).finally(function () { db.close(); });
      });
    },

    putLocation: function (location) {
      return openDb().then(function (db) {
        var tx = db.transaction('locations', 'readwrite');
        tx.objectStore('locations').put(location);
        return txDone(tx).finally(function () { db.close(); });
      });
    },

    deleteItem: function (id) {
      return openDb().then(function (db) {
        var tx = db.transaction('items', 'readwrite');
        tx.objectStore('items').delete(id);
        return txDone(tx).finally(function () { db.close(); });
      });
    },

    deleteLocation: function (id) {
      return openDb().then(function (db) {
        var tx = db.transaction('locations', 'readwrite');
        tx.objectStore('locations').delete(id);
        return txDone(tx).finally(function () { db.close(); });
      });
    },

    /* Replace everything atomically: validation happens in backup.js
       before this is called; the clear + put of both stores runs in
       one transaction, so a failure leaves the old data untouched. */
    replaceAll: function (items, locations) {
      return openDb().then(function (db) {
        var tx = db.transaction(['items', 'locations'], 'readwrite');
        var itemStore = tx.objectStore('items');
        var locStore = tx.objectStore('locations');
        itemStore.clear();
        locStore.clear();
        items.forEach(function (it) { itemStore.put(it); });
        locations.forEach(function (loc) { locStore.put(loc); });
        return txDone(tx).finally(function () { db.close(); });
      });
    },

    deleteAll: function () {
      return openDb().then(function (db) {
        var tx = db.transaction(['items', 'locations'], 'readwrite');
        tx.objectStore('items').clear();
        tx.objectStore('locations').clear();
        return txDone(tx).finally(function () { db.close(); });
      });
    },

    countItemsInLocation: function (locationId) {
      return api.getAllItems().then(function (items) {
        var n = 0;
        items.forEach(function (it) { if (it.locationId === locationId) n++; });
        return n;
      });
    }
  };

  global.SpotKeeperDB = api;
})(window);
