/* ==========================================================================
 * app.js — инициализация, hash-роутинг, демо-данные при первом запуске,
 * страница «Настройки» (резервное копирование, сброс данных).
 * Пространство имён: AG.App
 * ========================================================================== */
window.AG = window.AG || {};

AG.App = (function () {
  'use strict';

  var UI = AG.UI, DB = AG.DB, CSV = AG.CSV;

  /* ------------------------------ Роутинг --------------------------------- */

  var routes = {
    '/dashboard':  { title: 'Дашборд',       render: function (el) { AG.Reports.renderDashboard(el); } },
    '/products':   { title: 'Номенклатура',  render: function (el) { AG.Products.renderPage(el); } },
    '/operations': { title: 'Операции',      render: function (el) { AG.Operations.renderPage(el); } },
    '/issued':     { title: 'Выданное',      render: function (el) { AG.Serials.renderPage(el); } },
    '/inventory':  { title: 'Инвентаризация', render: function (el) { AG.Inventory.renderPage(el); } },
    '/employees':  { title: 'Сотрудники',    render: function (el) { AG.Employees.renderPage(el); } },
    '/reports':    { title: 'Отчёты',        render: function (el) { AG.Reports.renderPage(el); } },
    '/settings':   { title: 'Настройки',     render: renderSettings }
  };

  function currentRoute() {
    var h = location.hash.replace(/^#/, '');
    return routes[h] ? h : '/dashboard';
  }

  function router() {
    var key = currentRoute();
    var route = routes[key];

    document.querySelectorAll('#main-nav .nav-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === key);
    });
    document.title = route.title + ' — ИТ-Склад AgroGard';

    var content = document.getElementById('page-content');
    content.innerHTML = '';
    try {
      route.render(content);
    } catch (err) {
      content.innerHTML = '<div class="alert alert-danger">Ошибка отрисовки раздела: ' + UI.esc(err.message) + '</div>';
    }
    updateBell();
  }

  /* ----------------------- Шапка: колокольчик и FAB ----------------------- */

  /** Бейдж на колокольчике = число позиций ниже минимального остатка. */
  function updateBell() {
    var badge = document.getElementById('bell-badge');
    if (!badge) return;
    DB.getAll('products').then(function (ps) {
      var n = ps.filter(AG.Products.isLow).length;
      badge.hidden = !n;
      badge.textContent = n;
    }).catch(function () { /* не критично */ });
  }

  function initHeader() {
    var bell = document.getElementById('bell-btn');
    if (bell) {
      bell.addEventListener('click', function () {
        AG.Products.setLowFilter(true);
        // Если уже на странице номенклатуры — просто перерендериваем с фильтром
        if (location.hash === '#/products') AG.App.router();
        else location.hash = '#/products';
      });
    }

    var fab = document.getElementById('fab-add');
    var menu = document.getElementById('fab-menu');
    if (!fab || !menu) return;
    fab.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
    });
    menu.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        menu.hidden = true;
        var act = b.getAttribute('data-act');
        if (act === 'product') AG.Products.openCreate();
        else AG.Operations.openOpForm(act); // 'in' | 'out'
      });
    });
  }

  /* ---------------------------- Демо-данные ------------------------------- */

  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** Первый запуск: заполняем демонстрационные данные через реальные операции. */
  function ensureSeed() {
    return DB.getSetting('seeded').then(function (seeded) {
      if (seeded) return;

      var empIds = {};
      var prodIds = {};

      // Сотрудники
      return DB.add('employees', {
        full_name: 'Иванов Иван Иванович', position: 'Системный администратор',
        department: 'ИТ-отдел', contacts: '+7 (900) 111-22-33', created_at: Date.now()
      }).then(function (id) { empIds.ivanov = id; })
      .then(function () {
        return DB.add('employees', {
          full_name: 'Петрова Анна Сергеевна', position: 'Бухгалтер',
          department: 'Бухгалтерия', contacts: 'вн. 214', created_at: Date.now()
        });
      }).then(function (id) { empIds.petrova = id; })
      .then(function () {
        return DB.add('employees', {
          full_name: 'Сидоров Алексей Петрович', position: 'Агроном',
          department: 'Агрономический отдел', contacts: 'a.sidorov@agrogard.local', created_at: Date.now()
        });
      }).then(function (id) { empIds.sidorov = id; })

      // Товары
      .then(function () {
        return DB.add('products', {
          sku: 'NB-LEN-T14G3', name: 'Ноутбук Lenovo ThinkPad T14', category: 'Оборудование',
          manufacturer: 'Lenovo', model: 'ThinkPad T14 Gen 3', unit: 'шт.', quantity: 0,
          min_stock: 1, serial_tracking: 1, warranty_until: daysAgo(-365), comment: 'Демо: товар с серийным учётом', created_at: Date.now()
        });
      }).then(function (id) { prodIds.nb = id; })
      .then(function () {
        return DB.add('products', {
          sku: 'PRN-HP-M404', name: 'Принтер HP LaserJet M404dn', category: 'Оборудование',
          manufacturer: 'HP', model: 'LaserJet Pro M404dn', unit: 'шт.', quantity: 0,
          min_stock: 1, serial_tracking: 0, warranty_until: daysAgo(-21), comment: 'Демо: гарантия истекает скоро', tags: ['б/у'], created_at: Date.now()
        });
      }).then(function (id) { prodIds.prn = id; })
      .then(function () {
        return DB.add('products', {
          sku: 'KB-LOGI-K120', name: 'Клавиатура Logitech K120', category: 'Комплектующие',
          manufacturer: 'Logitech', model: 'K120', unit: 'шт.', quantity: 0,
          min_stock: 5, serial_tracking: 0, warranty_until: '', comment: '', tags: ['новое'], created_at: Date.now()
        });
      }).then(function (id) { prodIds.kb = id; })
      .then(function () {
        return DB.add('products', {
          sku: 'CART-HP-CF259A', name: 'Картридж HP CF259A', category: 'Расходники',
          manufacturer: 'HP', model: 'CF259A', unit: 'шт.', quantity: 0,
          min_stock: 4, serial_tracking: 0, warranty_until: '', comment: 'Демо: остаток ниже минимума', created_at: Date.now()
        });
      }).then(function (id) { prodIds.cart = id; })
      .then(function () {
        return DB.add('products', {
          sku: 'LIC-KES-1Y', name: 'Антивирус Kaspersky Endpoint Security, лицензия 1 год', category: 'ПО/Лицензии',
          manufacturer: 'Kaspersky', model: '', unit: 'шт.', quantity: 0,
          min_stock: 10, serial_tracking: 0, warranty_until: daysAgo(-250), comment: '', created_at: Date.now()
        });
      }).then(function (id) { prodIds.lic = id; })

      // Операции (через applyOperation — чтобы журнал и остатки были согласованы)
      .then(function () {
        return AG.Operations.applyOperation({
          type: 'in', product_id: prodIds.nb, date: daysAgo(20),
          serials: ['SN-T14-0001', 'SN-T14-0002', 'SN-T14-0003'],
          supplier: 'ООО «ТехноСнаб»', invoice_no: 'ТН-1024', comment: 'Начальная поставка'
        });
      })
      .then(function () {
        return AG.Operations.applyOperation({
          type: 'in', product_id: prodIds.prn, qty: 1, date: daysAgo(18),
          supplier: 'ООО «ТехноСнаб»', invoice_no: 'ТН-1024', comment: ''
        });
      })
      .then(function () {
        return AG.Operations.applyOperation({
          type: 'in', product_id: prodIds.kb, qty: 15, date: daysAgo(15),
          supplier: 'ООО «КомпЛайн»', invoice_no: 'КП-550', comment: ''
        });
      })
      .then(function () {
        return AG.Operations.applyOperation({
          type: 'in', product_id: prodIds.cart, qty: 5, date: daysAgo(15),
          supplier: 'ООО «КомпЛайн»', invoice_no: 'КП-550', comment: ''
        });
      })
      .then(function () {
        return AG.Operations.applyOperation({
          type: 'in', product_id: prodIds.lic, qty: 50, date: daysAgo(12),
          supplier: 'Kaspersky Lab', invoice_no: 'LIC-2026-77', comment: 'Годовые лицензии'
        });
      })
      // Выдача ноутбука по серийному номеру
      .then(function () { return DB.getByIndex('serial_items', 'product_id', prodIds.nb); })
      .then(function (serials) {
        var one = serials[0];
        return AG.Operations.applyOperation({
          type: 'out', product_id: prodIds.nb, serial_ids: [one.id], date: daysAgo(7),
          employee_id: empIds.ivanov, basis: 'Заявка № 12', comment: 'Замена парка'
        });
      })
      // Выдача картриджей (количественный товар)
      .then(function () {
        return AG.Operations.applyOperation({
          type: 'out', product_id: prodIds.cart, qty: 2, date: daysAgo(3),
          employee_id: empIds.petrova, basis: 'Заявка № 15', comment: ''
        });
      })
      .then(function () {
        return DB.setSetting('seeded', { at: Date.now(), demo: true });
      })
      .then(function () {
        UI.toast('Загружены демонстрационные данные. Очистить их можно в «Настройки → Сбросить все данные».', 'info', 7000);
      });
    });
  }

  /* ------------------------------ Настройки ------------------------------- */

  function renderSettings(el) {
    el.innerHTML =
      '<div class="page-header"><h2>Настройки</h2></div>' +
      '<div class="alert alert-warn"><b>Напоминание о резервном копировании.</b> ' +
        'Все данные хранятся только в этом браузере (IndexedDB). Очистка данных браузера, ' +
        'переустановка ОС или сбой диска приведут к потере данных. ' +
        '<b>Регулярно выгружайте резервную копию кнопкой «Экспортировать всё»</b> и храните CSV-файлы в надёжном месте.</div>' +
      '<div class="settings-grid">' +
        '<div class="settings-box"><h3>Резервное копирование</h3>' +
          '<p>Последовательное скачивание всех разделов в CSV (UTF-8 с BOM, разделитель «;»).</p>' +
          '<button class="btn btn-primary" id="set-export-all">Экспортировать всё</button>' +
        '</div>' +
        '<div class="settings-box"><h3>Шаблоны импорта</h3>' +
          '<p>Файлы-шаблоны также лежат в папке <b>templates/</b> дистрибутива.</p>' +
          '<button class="btn btn-secondary" data-tpl="products">template_products.csv</button>' +
          '<button class="btn btn-secondary" data-tpl="employees">template_employees.csv</button>' +
          '<button class="btn btn-secondary" data-tpl="initial_stock">template_initial_stock.csv</button>' +
        '</div>' +
        '<div class="settings-box"><h3>Хранилище</h3>' +
          '<p id="set-storage">Оценка занятого места…</p>' +
        '</div>' +
        '<div class="settings-box"><h3 style="color:var(--color-danger)">Опасная зона</h3>' +
          '<p>Полное удаление всех данных: номенклатура, журнал операций, серийные номера, сотрудники, инвентаризации.</p>' +
          '<button class="btn btn-danger" id="set-reset">Сбросить все данные</button>' +
        '</div>' +
      '</div>';

    el.querySelectorAll('[data-tpl]').forEach(function (b) {
      b.addEventListener('click', function () { CSV.downloadTemplate(b.getAttribute('data-tpl')); });
    });

    // Оценка занятого места (не во всех браузерах доступно)
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        var used = est.usage ? (est.usage / 1024).toFixed(1) : '—';
        el.querySelector('#set-storage').textContent = 'Занято данными приложения: ~' + used + ' КБ. Хранилище: IndexedDB (база agrogard_sklad_db).';
      }).catch(function () {
        el.querySelector('#set-storage').textContent = 'Хранилище: IndexedDB (база agrogard_sklad_db).';
      });
    } else {
      el.querySelector('#set-storage').textContent = 'Хранилище: IndexedDB (база agrogard_sklad_db).';
    }

    el.querySelector('#set-export-all').addEventListener('click', exportAll);
    el.querySelector('#set-reset').addEventListener('click', resetAll);
  }

  /** Полный бэкап: последовательное скачивание всех CSV. */
  function exportAll() {
    var delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    UI.toast('Начато резервное копирование: будет скачано 4 файла CSV.', 'info');

    AG.Products.exportProducts();
    return delay(400)
      .then(function () { return DB.getAll('operations'); })
      .then(function (ops) {
        ops.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
        CSV.download(CSV.filename('operations'), AG.Operations.JOURNAL_HEADERS, AG.Operations.opsToRows(ops));
        return delay(400);
      })
      .then(function () { AG.Employees.exportEmployees(); return delay(400); })
      .then(function () { return Promise.all([DB.getAll('serial_items'), DB.getAll('products')]); })
      .then(function (res) {
        var byId = {};
        res[1].forEach(function (p) { byId[p.id] = p; });
        var rows = res[0].map(function (s) {
          var p = byId[s.product_id];
          var st = AG.Serials.STATUS[s.status];
          return [s.serial, p ? p.sku : '', p ? p.name : '', st ? st.label : s.status,
            s.employee_name || '', s.issue_date || '', s.basis || ''];
        });
        CSV.download(CSV.filename('serials'),
          ['serial', 'sku', 'product', 'status', 'employee', 'issue_date', 'basis'], rows);
      })
      .then(function () {
        UI.toast('Резервное копирование завершено.', 'success');
      })
      .catch(function (err) {
        UI.toast('Ошибка резервного копирования: ' + err.message, 'error');
      });
  }

  /** Полный сброс с двойным подтверждением. */
  function resetAll() {
    UI.confirm('Вы действительно хотите удалить <b>ВСЕ данные</b> приложения?<br>' +
      'Будут очищены: номенклатура, журнал операций, серийные номера, сотрудники, инвентаризации.<br>' +
      '<b>Перед сбросом рекомендуется сделать «Экспортировать всё».</b>',
      { title: 'Сброс данных (шаг 1 из 2)', danger: true, okLabel: 'Продолжить' })
      .then(function (ok1) {
        if (!ok1) return;
        UI.confirm('<b>Последнее предупреждение.</b><br>Действие необратимо. Данные будут удалены без возможности восстановления. Продолжить?',
          { title: 'Сброс данных (шаг 2 из 2)', danger: true, okLabel: 'Да, удалить всё' })
          .then(function (ok2) {
            if (!ok2) return;
            DB.clearAll()
              // Помечаем, что сброс выполнен — демо-данные повторно не загружаем
              .then(function () { return DB.setSetting('seeded', { at: Date.now(), reset: true }); })
              .then(function () {
                UI.toast('Все данные удалены. Приложение возвращено в исходное состояние.', 'success');
                location.hash = '#/dashboard';
                router();
              })
              .catch(function (err) { UI.toast('Ошибка сброса: ' + err.message, 'error'); });
          });
      });
  }

  /* ------------------------------ Запуск ---------------------------------- */

  function boot() {
    DB.open()
      .then(ensureSeed)
      .then(function () {
        initHeader();
        window.addEventListener('hashchange', router);
        router();
      })
      .catch(function (err) {
        document.getElementById('page-content').innerHTML =
          '<div class="alert alert-danger"><b>Не удалось открыть локальную базу данных (IndexedDB).</b><br>' +
          UI.esc(err && err.message ? err.message : String(err)) +
          '<br>Проверьте, что браузер не в режиме «Инкогнито» и что IndexedDB не отключён.</div>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return { router: router };
})();
