/* ==========================================================================
 * db.js — обёртка над IndexedDB: открытие БД, миграции, CRUD-помощники.
 * Все данные приложения хранятся локально в IndexedDB браузера.
 * Пространство имён: AG.DB
 * ========================================================================== */
window.AG = window.AG || {};

AG.DB = (function () {
  'use strict';

  var DB_NAME = 'agrogard_sklad_db';
  var DB_VERSION = 1;
  var dbPromise = null;

  /** Открывает (и при первом запуске создаёт) базу данных. */
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var db = e.target.result;

        // Справочник номенклатуры
        if (!db.objectStoreNames.contains('products')) {
          var p = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
          p.createIndex('sku', 'sku', { unique: true });
          p.createIndex('category', 'category', { unique: false });
        }

        // Журнал складских операций
        if (!db.objectStoreNames.contains('operations')) {
          var o = db.createObjectStore('operations', { keyPath: 'id', autoIncrement: true });
          o.createIndex('product_id', 'product_id', { unique: false });
          o.createIndex('date', 'date', { unique: false });
          o.createIndex('type', 'type', { unique: false });
        }

        // Справочник сотрудников
        if (!db.objectStoreNames.contains('employees')) {
          var em = db.createObjectStore('employees', { keyPath: 'id', autoIncrement: true });
          em.createIndex('full_name', 'full_name', { unique: false });
        }

        // Серийные номера (единицы оборудования с серийным учётом)
        if (!db.objectStoreNames.contains('serial_items')) {
          var s = db.createObjectStore('serial_items', { keyPath: 'id', autoIncrement: true });
          s.createIndex('product_id', 'product_id', { unique: false });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('employee_id', 'employee_id', { unique: false });
          s.createIndex('serial', 'serial', { unique: true });
        }

        // Сессии инвентаризации (items хранятся массивом внутри записи)
        if (!db.objectStoreNames.contains('inventories')) {
          db.createObjectStore('inventories', { keyPath: 'id', autoIncrement: true });
        }

        // Настройки приложения (key/value)
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () {
        reject(new Error('База данных заблокирована другой вкладкой. Закройте остальные вкладки приложения и обновите страницу.'));
      };
    });
    return dbPromise;
  }

  /** Промис из IDB-запроса. */
  function reqP(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getAll(store) {
    return open().then(function (db) {
      return reqP(db.transaction(store, 'readonly').objectStore(store).getAll());
    });
  }

  function get(store, id) {
    return open().then(function (db) {
      return reqP(db.transaction(store, 'readonly').objectStore(store).get(id));
    });
  }

  function getByIndex(store, index, value) {
    return open().then(function (db) {
      return reqP(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(value));
    });
  }

  function put(store, obj) {
    return open().then(function (db) {
      return reqP(db.transaction(store, 'readwrite').objectStore(store).put(obj));
    });
  }

  function add(store, obj) {
    return open().then(function (db) {
      return reqP(db.transaction(store, 'readwrite').objectStore(store).add(obj));
    });
  }

  function del(store, id) {
    return open().then(function (db) {
      return reqP(db.transaction(store, 'readwrite').objectStore(store).delete(id));
    });
  }

  function clear(store) {
    return open().then(function (db) {
      return reqP(db.transaction(store, 'readwrite').objectStore(store).clear());
    });
  }

  /**
   * Выполняет fn(stores) в одной readwrite-транзакции по нескольким
   * хранилищам. fn может ставить запросы в очередь, в т.ч. из onsuccess
   * предыдущих запросов (стандартный паттерн IDB). Промис завершается
   * по oncomplete транзакции — это гарантирует атомарность операций
   * (товар + журнал + серийные номера).
   */
  function writeTx(storeNames, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeNames, 'readwrite');
        var stores = {};
        storeNames.forEach(function (n) { stores[n] = tx.objectStore(n); });
        var result = null;
        try {
          result = fn(stores) || null;
        } catch (err) {
          try { tx.abort(); } catch (_) { /* noop */ }
          reject(err);
          return;
        }
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error('Ошибка транзакции IndexedDB')); };
        tx.onabort = function () { reject(tx.error || new Error('Транзакция отменена')); };
      });
    });
  }

  /** Полная очистка всех хранилищ (используется в «Сбросить все данные»). */
  function clearAll() {
    return open().then(function (db) {
      var names = Array.prototype.slice.call(db.objectStoreNames);
      return Promise.all(names.map(clear));
    });
  }

  function getSetting(key) {
    return get('settings', key).then(function (r) { return r ? r.value : undefined; });
  }

  function setSetting(key, value) {
    return put('settings', { key: key, value: value });
  }

  return {
    open: open,
    getAll: getAll,
    get: get,
    getByIndex: getByIndex,
    put: put,
    add: add,
    del: del,
    clear: clear,
    clearAll: clearAll,
    writeTx: writeTx,
    getSetting: getSetting,
    setSetting: setSetting
  };
})();
