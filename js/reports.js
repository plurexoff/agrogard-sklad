/* ==========================================================================
 * reports.js — дашборд (карточки, диаграммы без внешних библиотек)
 * и раздел «Отчёты» с выгрузкой CSV.
 * Пространство имён: AG.Reports
 * ========================================================================== */
window.AG = window.AG || {};

AG.Reports = (function () {
  'use strict';

  var UI = AG.UI, DB = AG.DB, CSV = AG.CSV;

  /* ================================ Дашборд ================================ */

  var DONUT_COLORS = ['#2E7D32', '#66BB6A', '#9CCC65', '#FFB74D', '#4DB6AC', '#90A4AE'];
  var DONUT_FULL = 439.8; // длина окружности r=70

  // Иконки-миниатюры по категориям (для таблицы операций)
  var CAT_ICONS = {
    'Оборудование': '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    'Расходники': '<svg viewBox="0 0 24 24"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>',
    'Комплектующие': '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>',
    'ПО/Лицензии': '<svg viewBox="0 0 24 24"><path d="M12 22s8-3.6 8-10V5.4L12 2 4 5.4V12c0 6.4 8 10 8 10Z"/></svg>'
  };
  var BOX_ICON = '<svg viewBox="0 0 24 24"><path d="M21 8.5v7a2 2 0 0 1-1 1.73l-7 4.04a2 2 0 0 1-2 0l-7-4.04A2 2 0 0 1 3 15.5v-7a2 2 0 0 1 1-1.73l7-4.04a2 2 0 0 1 2 0l7 4.04A2 2 0 0 1 21 8.5Z"/><path d="M3.3 7.3 12 12l8.7-4.7M12 22V12"/></svg>';

  // Тип операции → пилюля статуса
  var OP_PILLS = {
    in: { label: 'Приход', cls: 'pill-green' },
    out: { label: 'Выдача', cls: 'pill-blue' },
    writeoff: { label: 'Списание', cls: 'pill-orange' },
    return: { label: 'Возврат', cls: 'pill-purple' },
    adjust: { label: 'Корректировка', cls: 'pill-amber' }
  };

  var KPI_ICONS = {
    box: '<svg viewBox="0 0 24 24"><path d="M21 8.5v7a2 2 0 0 1-1 1.73l-7 4.04a2 2 0 0 1-2 0l-7-4.04A2 2 0 0 1 3 15.5v-7a2 2 0 0 1 1-1.73l7-4.04a2 2 0 0 1 2 0l7 4.04A2 2 0 0 1 21 8.5Z"/><path d="M3.3 7.3 12 12l8.7-4.7M12 22V12"/></svg>',
    layers: '<svg viewBox="0 0 24 24"><path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z"/><path d="M3 12.5 12 17l9-4.5M3 17l9 4.5L21 17"/></svg>',
    monitor: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 22s8-3.6 8-10V5.4L12 2 4 5.4V12c0 6.4 8 10 8 10Z"/><path d="m9 11.5 2.2 2.2L15.5 9.5"/></svg>'
  };

  function daysUntil(isoDate) {
    var today = UI.todayLocal();
    var a = new Date(today + 'T00:00:00');
    var b = new Date(isoDate + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }

  /** «сегодня, 09:41» / «вчера» / «18.10.2026» */
  function relWhen(o) {
    var day = o.date || UI.todayLocal();
    var today = UI.todayLocal();
    if (day === today) {
      var d = new Date(o.created_at || Date.now());
      var p = function (n) { return String(n).padStart(2, '0'); };
      return 'сегодня, ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    var y = new Date(); y.setDate(y.getDate() - 1);
    var yIso = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
    if (day === yIso) return 'вчера';
    return UI.fmtDate(day);
  }

  function renderDashboard(el) {
    Promise.all([
      DB.getAll('products'),
      DB.getAll('operations'),
      DB.getAll('serial_items')
    ]).then(function (res) {
      var products = res[0], operations = res[1], serials = res[2];

      /* ---------- расчёт метрик ---------- */
      var totalPos = products.length;
      var totalUnits = products.reduce(function (s, p) { return s + (+p.quantity || 0); }, 0);
      var low = products.filter(AG.Products.isLow);

      var monthAgo = Date.now() - 30 * 86400000;
      var newPos = products.filter(function (p) { return (p.created_at || 0) >= monthAgo; }).length;

      var weekAgo = Date.now() - 7 * 86400000;
      var weekOps = operations.filter(function (o) { return (o.created_at || 0) >= weekAgo; }).length;

      var issued = serials.filter(function (s) { return s.status === 'issued'; });

      var warranty = products
        .filter(function (p) { return p.warranty_until; })
        .map(function (p) { return { p: p, days: daysUntil(p.warranty_until) }; })
        .filter(function (x) { return x.days <= 30; });
      var expired = warranty.filter(function (x) { return x.days < 0; }).length;

      var lastOps = operations.slice().sort(function (a, b) {
        return (b.created_at || 0) - (a.created_at || 0);
      }).slice(0, 5);

      var byId = {};
      products.forEach(function (p) { byId[p.id] = p; });

      /* ---------- KPI-карточки ---------- */
      var html =
        '<div class="page-header"><h2>Дашборд</h2></div>' +
        '<section class="kpi-grid">' +
          kpiCard('ic-green', KPI_ICONS.box, 'Всего позиций', totalPos,
            newPos ? '<span class="trend-up">▲ +' + newPos + '</span> за 30 дней' : 'без новых за 30 дней', false) +
          kpiCard('ic-emerald', KPI_ICONS.layers, 'Единиц на складе', totalUnits,
            weekOps + ' операций за 7 дней', false) +
          kpiCard('ic-blue', KPI_ICONS.monitor, 'Выдано сотрудникам', issued.length,
            '<a href="#/issued">перейти к списку</a>', false) +
          kpiCard('ic-warm', KPI_ICONS.warn, 'Ниже минимума' + (low.length ? ' <span class="pulse-dot"></span>' : ''), low.length,
            low.length ? '<a href="#/products" data-low="1" class="trend-warm">требуется закупка →</a>' : 'все остатки в норме', low.length > 0) +
          kpiCard('ic-teal', KPI_ICONS.shield, 'Гарантия истекает', warranty.length,
            expired ? '<span class="trend-warm">истекло: ' + expired + '</span>' : 'в ближайшие 30 дней', false) +
        '</section>' +

        /* ---------- Диаграммы ---------- */
        '<section class="dash-charts">' +
          '<div class="panel"><h3>Структура запасов</h3><div class="hint">по категориям, единиц</div>' +
            donutHtml(products, totalUnits) + '</div>' +
          '<div class="panel"><h3>Распределение по категориям</h3><div class="hint">количество единиц</div>' +
            barsHtml(products) + '</div>' +
        '</section>' +

        /* ---------- Последние операции ---------- */
        '<section class="table-card">' +
          '<div class="table-head"><h3>Последние операции</h3><a href="#/operations">Все операции →</a></div>' +
          lastOpsTable(lastOps, byId) +
        '</section>';

      el.innerHTML = html;

      // Переход из карточки «Ниже минимума» к отфильтрованной номенклатуре
      el.querySelectorAll('a[data-low]').forEach(function (a) {
        a.addEventListener('click', function () { AG.Products.setLowFilter(true); });
      });
    });

    function kpiCard(icCls, icon, label, val, sub, warm) {
      return '<div class="kpi-card' + (warm ? ' kpi-warm' : '') + '">' +
        '<div class="kpi-ic ' + icCls + '">' + icon + '</div>' +
        '<div class="kpi-lbl">' + label + '</div>' +
        '<div class="kpi-val">' + val + '</div>' +
        '<div class="kpi-sub">' + sub + '</div></div>';
    }
  }

  /* -------- Donut (SVG, закруглённые сегменты, центральное число) -------- */

  function donutHtml(products, totalUnits) {
    if (!products.length || !totalUnits) {
      return '<div class="empty">Нет данных для диаграммы.</div>';
    }
    var byCat = {};
    products.forEach(function (p) {
      var q = +p.quantity || 0;
      if (q > 0) byCat[p.category] = (byCat[p.category] || 0) + q;
    });
    var entries = Object.keys(byCat).map(function (k) { return { name: k, value: byCat[k] }; });
    if (!entries.length) return '<div class="empty">Склад пуст.</div>';

    var gap = entries.length > 1 ? 5 : 0;
    var acc = 0;
    var circles = entries.map(function (e, i) {
      e.color = DONUT_COLORS[i % DONUT_COLORS.length];
      var len = e.value / totalUnits * DONUT_FULL;
      var visible = Math.max(1.5, len - gap);
      var offset = -(acc + (gap ? gap / 2 : 0));
      acc += len;
      e.pct = Math.round(e.value / totalUnits * 100);
      return '<circle cx="100" cy="100" r="70" stroke="' + e.color + '" style="--full:' + DONUT_FULL + '" ' +
        'stroke-dasharray="' + visible.toFixed(1) + ' ' + (DONUT_FULL - visible).toFixed(1) + '" ' +
        'stroke-dashoffset="' + offset.toFixed(1) + '"/>';
    }).join('');

    return '<div class="donut-wrap">' +
      '<div class="donut"><svg viewBox="0 0 200 200">' + circles + '</svg>' +
        '<div class="center"><div class="c-val">' + totalUnits + '</div>' +
        '<div class="c-lbl">единиц<br>на складе</div></div></div>' +
      '<div class="donut-legend">' +
        entries.map(function (e) {
          return '<div class="li"><span class="dot" style="background:' + e.color + '"></span>' + UI.esc(e.name) +
            '<span class="pc"><b>' + e.value + '</b> · ' + e.pct + '%</span></div>';
        }).join('') +
      '</div></div>';
  }

  /* -------- Горизонтальные бары по категориям на фоне сетки -------- */

  function barsHtml(products) {
    var byCat = {};
    products.forEach(function (p) {
      var q = +p.quantity || 0;
      if (q > 0) byCat[p.category] = (byCat[p.category] || 0) + q;
    });
    var entries = Object.keys(byCat).map(function (k) { return { name: k, value: byCat[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
    if (!entries.length) return '<div class="empty">Склад пуст.</div>';

    // «красивый» максимум оси: округляем вверх до 1/2/5 × 10^n
    var max = entries[0].value;
    var pow = Math.pow(10, Math.max(0, Math.floor(Math.log10(max))));
    var step = pow;
    if (max / pow <= 2) step = pow / 2; else if (max / pow > 5) step = pow * 2;
    var nice = Math.max(step, Math.ceil(max / step) * step);

    var rows = entries.map(function (e, i) {
      var w = Math.max(2, Math.round(e.value / nice * 100));
      return '<div class="bar-row2"><span class="nm" title="' + UI.esc(e.name) + '">' + UI.esc(e.name) + '</span>' +
        '<div class="bar-track2"><div class="bar-fill2" style="width:' + w + '%;animation-delay:' + (i * 0.09).toFixed(2) + 's"></div></div>' +
        '<span class="bar-v2">' + e.value + '</span></div>';
    }).join('');

    return '<div class="bars2">' +
      '<div class="gridlines"><i></i><i></i><i></i><i></i><i></i></div>' +
      rows +
      '<div class="axis2"><span>0</span><span>' + Math.round(nice * .25) + '</span><span>' + Math.round(nice * .5) +
        '</span><span>' + Math.round(nice * .75) + '</span><span>' + nice + '</span></div>' +
      '</div>';
  }

  /* ----------------- Таблица последних операций ------------------ */

  function lastOpsTable(ops, productsById) {
    if (!ops.length) return '<div class="empty">Операций пока нет. Проведите первый приход через «Операции» или кнопку «+» в шапке.</div>';
    return '<table class="dtable"><thead><tr>' +
      '<th>Товар</th><th>Артикул</th><th>Тип</th><th>Изменение</th><th>Детали</th><th>Когда</th>' +
      '</tr></thead><tbody>' +
      ops.map(function (o) {
        var pill = OP_PILLS[o.type] || { label: o.type, cls: 'pill-amber' };
        var p = productsById[o.product_id];
        var icon = p && CAT_ICONS[p.category] ? CAT_ICONS[p.category] : BOX_ICON;
        return '<tr>' +
          '<td><div class="t-name"><span class="thumb">' + icon + '</span>' + UI.esc(o.product_name) + '</div></td>' +
          '<td class="muted">' + UI.esc(o.product_sku) + '</td>' +
          '<td><span class="pill ' + pill.cls + '">' + pill.label + '</span></td>' +
          '<td><span class="' + (o.delta >= 0 ? 'qty-plus' : 'qty-minus') + '">' + (o.delta >= 0 ? '+' : '') + o.delta + '</span></td>' +
          '<td class="muted">' + UI.esc(o.employee_name || o.supplier || o.reason || '—') + '</td>' +
          '<td class="muted nowrap">' + relWhen(o) + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  /* ================================ Отчёты ================================= */

  var tab = 'ostatki';
  var container = null;
  var repState = {
    ostatki: { category: '', stock: '' },
    dvizhenie: { from: '', to: '' },
    inventory: { id: '' }
  };

  function renderPage(el) {
    container = el;
    container.innerHTML =
      '<div class="page-header"><h2>Отчёты</h2></div>' +
      '<div class="tabs" id="rep-tabs">' +
        tabBtn('ostatki', 'Остатки на складе') +
        tabBtn('dvizhenie', 'Движение за период') +
        tabBtn('issued', 'Выданное оборудование') +
        tabBtn('lowstock', 'Ниже минимума') +
        tabBtn('inventory', 'Инвентаризационная ведомость') +
      '</div>' +
      '<div id="rep-body"></div>';

    container.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () {
        tab = b.getAttribute('data-tab');
        container.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderTab();
      });
    });

    renderTab();
  }

  function tabBtn(key, label) {
    return '<button class="tab' + (tab === key ? ' active' : '') + '" data-tab="' + key + '">' + label + '</button>';
  }

  function renderTab() {
    if (tab === 'ostatki') return tabOstatki();
    if (tab === 'dvizhenie') return tabDvizhenie();
    if (tab === 'issued') return tabIssued();
    if (tab === 'lowstock') return tabLowStock();
    if (tab === 'inventory') return tabInventory();
  }

  function body() { return container.querySelector('#rep-body'); }

  /* -------- Остатки на складе (фильтры: категория, наличие) -------- */

  function tabOstatki() {
    var st = repState.ostatki;
    body().innerHTML =
      '<div class="toolbar">' +
        '<select id="r-cat"><option value="">Все категории</option>' +
          AG.Products.CATEGORIES.map(function (c) {
            return '<option' + (st.category === c ? ' selected' : '') + '>' + c + '</option>';
          }).join('') + '</select>' +
        '<select id="r-stock">' +
          '<option value=""' + (st.stock === '' ? ' selected' : '') + '>Любое наличие</option>' +
          '<option value="in"' + (st.stock === 'in' ? ' selected' : '') + '>В наличии (&gt; 0)</option>' +
          '<option value="out"' + (st.stock === 'out' ? ' selected' : '') + '>Нет в наличии (= 0)</option>' +
          '<option value="low"' + (st.stock === 'low' ? ' selected' : '') + '>Ниже минимума</option>' +
        '</select>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-secondary" id="r-export">Экспорт CSV</button>' +
      '</div>' +
      '<div class="table-wrap"><table class="table" id="r-table"></table></div>';

    function load() {
      DB.getAll('products').then(function (rows) {
        var filtered = rows.filter(function (p) {
          if (st.category && p.category !== st.category) return false;
          if (st.stock === 'in' && !(+p.quantity > 0)) return false;
          if (st.stock === 'out' && +p.quantity !== 0) return false;
          if (st.stock === 'low' && !AG.Products.isLow(p)) return false;
          return true;
        }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });

        container.querySelector('#r-table').innerHTML =
          '<thead><tr><th>Артикул</th><th>Наименование</th><th>Категория</th><th>Производитель</th>' +
          '<th>Ед.</th><th class="num">Остаток</th><th class="num">Мин.</th><th>Гарантия</th></tr></thead><tbody>' +
          (filtered.length ? filtered.map(function (p) {
            var low = AG.Products.isLow(p);
            return '<tr class="' + (low ? 'row-low' : '') + '">' +
              '<td>' + UI.esc(p.sku) + '</td><td>' + UI.esc(p.name) + '</td><td>' + UI.esc(p.category) + '</td>' +
              '<td>' + UI.esc(p.manufacturer || '—') + '</td><td>' + UI.esc(p.unit) + '</td>' +
              '<td class="num"><b>' + (+p.quantity || 0) + '</b></td><td class="num">' + (+p.min_stock || 0) + '</td>' +
              '<td>' + UI.fmtDate(p.warranty_until) + '</td></tr>';
          }).join('') : '<tr><td colspan="8"><div class="empty">Нет данных.</div></td></tr>') +
          '</tbody>';

        return filtered;
      });
    }

    function currentRows(cb) {
      DB.getAll('products').then(function (rows) {
        cb(rows.filter(function (p) {
          if (st.category && p.category !== st.category) return false;
          if (st.stock === 'in' && !(+p.quantity > 0)) return false;
          if (st.stock === 'out' && +p.quantity !== 0) return false;
          if (st.stock === 'low' && !AG.Products.isLow(p)) return false;
          return true;
        }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); }));
      });
    }

    body().querySelector('#r-cat').addEventListener('change', function (e) { st.category = e.target.value; load(); });
    body().querySelector('#r-stock').addEventListener('change', function (e) { st.stock = e.target.value; load(); });
    body().querySelector('#r-export').addEventListener('click', function () {
      currentRows(function (rows) {
        CSV.download(CSV.filename('report_ostatki'),
          ['sku', 'name', 'category', 'manufacturer', 'unit', 'quantity', 'min_stock', 'warranty_until'],
          rows.map(function (p) {
            return [p.sku, p.name, p.category, p.manufacturer || '', p.unit, +p.quantity || 0, +p.min_stock || 0, p.warranty_until || ''];
          }));
        UI.toast('Отчёт выгружен: ' + rows.length + ' позиций.', 'success');
      });
    });

    load();
  }

  /* ---------------------- Движение за период ---------------------- */

  function tabDvizhenie() {
    var st = repState.dvizhenie;
    if (!st.from) {
      var d = new Date(); d.setDate(1);
      st.from = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    }
    if (!st.to) st.to = UI.todayLocal();

    body().innerHTML =
      '<div class="toolbar">' +
        '<label>с <input type="date" id="r-from" value="' + st.from + '"></label>' +
        '<label>по <input type="date" id="r-to" value="' + st.to + '"></label>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-secondary" id="r-export">Экспорт CSV</button>' +
      '</div>' +
      '<div class="table-wrap"><table class="table" id="r-table"></table></div>';

    function load() {
      DB.getAll('operations').then(function (ops) {
        var rows = ops.filter(function (o) {
          return (!st.from || o.date >= st.from) && (!st.to || o.date <= st.to);
        }).sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;
          return (b.created_at || 0) - (a.created_at || 0);
        });

        var TYPES = AG.Operations.TYPES;
        container.querySelector('#r-table').innerHTML =
          '<thead><tr><th>Дата</th><th>Тип</th><th>Товар</th><th class="num">Кол-во</th><th class="num">Δ</th><th>Детали</th><th>Комментарий</th></tr></thead><tbody>' +
          (rows.length ? rows.map(function (o) {
            var t = TYPES[o.type] || { label: o.type, badge: 'badge-muted' };
            var details = [o.supplier && 'Поставщик: ' + o.supplier, o.invoice_no && 'Накладная № ' + o.invoice_no,
              o.employee_name, o.basis && 'Основание: ' + o.basis, o.reason && 'Причина: ' + o.reason]
              .filter(Boolean).map(UI.esc).join('<br>');
            return '<tr><td class="nowrap">' + UI.fmtDate(o.date) + '</td>' +
              '<td><span class="badge ' + t.badge + '">' + t.label + '</span></td>' +
              '<td>' + UI.esc(o.product_name) + ' <span class="muted">' + UI.esc(o.product_sku) + '</span></td>' +
              '<td class="num">' + o.qty + '</td>' +
              '<td class="num"><span class="' + (o.delta >= 0 ? 'qty-plus' : 'qty-minus') + '">' + (o.delta >= 0 ? '+' : '') + o.delta + '</span></td>' +
              '<td>' + (details || '—') + '</td><td>' + UI.esc(o.comment || '—') + '</td></tr>';
          }).join('') : '<tr><td colspan="7"><div class="empty">За выбранный период операций нет.</div></td></tr>') +
          '</tbody>';
        return rows.length;
      });
    }

    function doExport() {
      DB.getAll('operations').then(function (ops) {
        var rows = ops.filter(function (o) {
          return (!st.from || o.date >= st.from) && (!st.to || o.date <= st.to);
        }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
        CSV.download(CSV.filename('report_dvizhenie'), AG.Operations.JOURNAL_HEADERS, AG.Operations.opsToRows(rows));
        UI.toast('Отчёт выгружен: ' + rows.length + ' операций.', 'success');
      });
    }

    body().querySelector('#r-from').addEventListener('change', function (e) { st.from = e.target.value; load(); });
    body().querySelector('#r-to').addEventListener('change', function (e) { st.to = e.target.value; load(); });
    body().querySelector('#r-export').addEventListener('click', doExport);
    load();
  }

  /* ---------------------- Выданное оборудование ---------------------- */

  function tabIssued() {
    body().innerHTML =
      '<div class="toolbar"><span class="muted">Оборудование с серийным учётом, числящееся выданным.</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-secondary" id="r-export">Экспорт CSV</button></div>' +
      '<div class="table-wrap"><table class="table" id="r-table"></table></div>';

    function load() {
      Promise.all([DB.getAll('serial_items'), DB.getAll('products')]).then(function (res) {
        var serials = res[0].filter(function (s) { return s.status === 'issued'; });
        var byId = {};
        res[1].forEach(function (p) { byId[p.id] = p; });

        container.querySelector('#r-table').innerHTML =
          '<thead><tr><th>Серийный №</th><th>Товар</th><th>Сотрудник</th><th>Дата выдачи</th><th>Основание</th></tr></thead><tbody>' +
          (serials.length ? serials.map(function (s) {
            var p = byId[s.product_id];
            return '<tr><td><b>' + UI.esc(s.serial) + '</b></td>' +
              '<td>' + (p ? UI.esc(p.name) : '<span class="muted">товар удалён</span>') + '</td>' +
              '<td>' + UI.esc(s.employee_name || '—') + '</td>' +
              '<td class="nowrap">' + UI.fmtDate(s.issue_date) + '</td>' +
              '<td>' + UI.esc(s.basis || '—') + '</td></tr>';
          }).join('') : '<tr><td colspan="5"><div class="empty">Выданного оборудования нет.</div></td></tr>') +
          '</tbody>';
      });
    }

    body().querySelector('#r-export').addEventListener('click', function () {
      Promise.all([DB.getAll('serial_items'), DB.getAll('products')]).then(function (res) {
        var serials = res[0].filter(function (s) { return s.status === 'issued'; });
        var byId = {};
        res[1].forEach(function (p) { byId[p.id] = p; });
        CSV.download(CSV.filename('report_issued'), AG.Serials.ISSUED_HEADERS, serials.map(function (s) {
          var p = byId[s.product_id];
          return [s.serial, p ? p.sku : '', p ? p.name : '', s.employee_name || '', s.issue_date || '', s.basis || ''];
        }));
        UI.toast('Отчёт выгружен: ' + serials.length + ' записей.', 'success');
      });
    });

    load();
  }

  /* ---------------------- Позиции ниже минимума ---------------------- */

  function tabLowStock() {
    body().innerHTML =
      '<div class="toolbar"><span class="muted">Позиции, у которых остаток ≤ минимального.</span>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-secondary" id="r-export">Экспорт CSV</button></div>' +
      '<div class="table-wrap"><table class="table" id="r-table"></table></div>';

    function load() {
      DB.getAll('products').then(function (rows) {
        var low = rows.filter(AG.Products.isLow).sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
        container.querySelector('#r-table').innerHTML =
          '<thead><tr><th>Артикул</th><th>Наименование</th><th>Категория</th><th>Ед.</th>' +
          '<th class="num">Остаток</th><th class="num">Мин.</th><th class="num">Нужно докупить</th></tr></thead><tbody>' +
          (low.length ? low.map(function (p) {
            return '<tr class="row-low"><td>' + UI.esc(p.sku) + '</td><td>' + UI.esc(p.name) + '</td>' +
              '<td>' + UI.esc(p.category) + '</td><td>' + UI.esc(p.unit) + '</td>' +
              '<td class="num"><b>' + (+p.quantity || 0) + '</b></td><td class="num">' + (+p.min_stock || 0) + '</td>' +
              '<td class="num">' + Math.max(0, (+p.min_stock || 0) - (+p.quantity || 0) + 1) + '</td></tr>';
          }).join('') : '<tr><td colspan="7"><div class="empty">Все остатки в норме.</div></td></tr>') +
          '</tbody>';
      });
    }

    body().querySelector('#r-export').addEventListener('click', function () {
      DB.getAll('products').then(function (rows) {
        var low = rows.filter(AG.Products.isLow).sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
        CSV.download(CSV.filename('report_lowstock'),
          ['sku', 'name', 'category', 'unit', 'quantity', 'min_stock'],
          low.map(function (p) { return [p.sku, p.name, p.category, p.unit, +p.quantity || 0, +p.min_stock || 0]; }));
        UI.toast('Отчёт выгружен: ' + low.length + ' позиций.', 'success');
      });
    });

    load();
  }

  /* ---------------- Инвентаризационная ведомость по сессии ---------------- */

  function tabInventory() {
    DB.getAll('inventories').then(function (list) {
      var closed = list.filter(function (i) { return i.status === 'closed'; })
        .sort(function (a, b) { return b.id - a.id; });

      if (!closed.length) {
        body().innerHTML = '<div class="empty">Закрытых инвентаризаций пока нет.</div>';
        return;
      }

      var st = repState.inventory;
      if (!st.id || !closed.some(function (i) { return String(i.id) === String(st.id); })) st.id = closed[0].id;

      body().innerHTML =
        '<div class="toolbar"><label>Сессия: <select id="r-inv">' +
          closed.map(function (i) {
            return '<option value="' + i.id + '"' + (String(i.id) === String(st.id) ? ' selected' : '') + '>' +
              '№' + i.id + ' от ' + UI.fmtDate(i.date_start) + ' (' + UI.esc(i.category) + ')</option>';
          }).join('') + '</select></label>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-secondary" id="r-export">Экспорт CSV</button></div>' +
        '<div class="table-wrap"><table class="table" id="r-table"></table></div>';

      function load() {
        var inv = closed.find(function (i) { return String(i.id) === String(st.id); });
        if (!inv) return;
        container.querySelector('#r-table').innerHTML =
          '<thead><tr><th>Товар</th><th>Артикул</th><th>Ед.</th>' +
          '<th class="num">Учётный</th><th class="num">Фактический</th><th class="num">Расхождение</th></tr></thead><tbody>' +
          (inv.items || []).map(function (i) {
            var d = i.actual - i.expected;
            return '<tr class="' + (d ? 'row-diff' : '') + '">' +
              '<td>' + UI.esc(i.name) + '</td><td>' + UI.esc(i.sku) + '</td><td>' + UI.esc(i.unit) + '</td>' +
              '<td class="num">' + i.expected + '</td><td class="num">' + i.actual + '</td>' +
              '<td class="num diff-cell ' + (d < 0 ? 'diff-neg' : d > 0 ? 'diff-pos' : '') + '">' + (d > 0 ? '+' + d : d) + '</td></tr>';
          }).join('') + '</tbody>';
      }

      body().querySelector('#r-inv').addEventListener('change', function (e) { st.id = e.target.value; load(); });
      body().querySelector('#r-export').addEventListener('click', function () {
        var inv = closed.find(function (i) { return String(i.id) === String(st.id); });
        if (inv) AG.Inventory.exportSheet(inv);
      });

      load();
    });
  }

  return {
    renderDashboard: renderDashboard,
    renderPage: renderPage
  };
})();
