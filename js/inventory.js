/* ==========================================================================
 * inventory.js — инвентаризация: создание сессии по категории или по всем
 * товарам, ввод фактических остатков, автоподсчёт расхождений, закрытие
 * с созданием корректирующих операций, история и ведомости.
 * Пространство имён: AG.Inventory
 * ========================================================================== */
window.AG = window.AG || {};

AG.Inventory = (function () {
  'use strict';

  var UI = AG.UI, DB = AG.DB, CSV = AG.CSV;

  var container = null;
  var activeInv = null; // активная сессия (status === 'active')

  /* ------------------------------ Страница -------------------------------- */

  function renderPage(el) {
    container = el;
    DB.getAll('inventories').then(function (list) {
      activeInv = null;
      list.forEach(function (i) { if (i.status === 'active') activeInv = i; });
      if (activeInv) renderSession(activeInv);
      else renderHome(list);
    });
  }

  /* --------------------- Главная: история + новая сессия ------------------- */

  function renderHome(list) {
    var closed = list.filter(function (i) { return i.status === 'closed'; })
      .sort(function (a, b) { return (b.id || 0) - (a.id || 0); });

    container.innerHTML =
      '<div class="page-header"><h2>Инвентаризация</h2>' +
        '<div class="page-actions">' +
          '<button class="btn btn-primary" id="inv-new">+ Новая инвентаризация</button>' +
        '</div>' +
      '</div>' +
      '<div class="alert alert-info">Инвентаризация сверяет учётные остатки с фактическими. ' +
        'При закрытии по каждому расхождению автоматически создаётся операция «Корректировка» ' +
        '(кроме товаров с серийным учётом — их остаток меняется приходом/списанием с серийными номерами).</div>' +
      '<div class="table-wrap"><table class="table" id="inv-table"></table></div>';

    var table = container.querySelector('#inv-table');
    table.innerHTML =
      '<thead><tr><th>№</th><th>Создана</th><th>Закрыта</th><th>Категория</th>' +
      '<th class="num">Позиций</th><th class="num">Расхождений</th><th style="width:190px">Действия</th></tr></thead>' +
      '<tbody>' +
      (closed.length ? closed.map(function (i) {
        return '<tr data-id="' + i.id + '">' +
          '<td>' + i.id + '</td>' +
          '<td class="nowrap">' + UI.fmtDate(i.date_start) + '</td>' +
          '<td class="nowrap">' + UI.fmtDate(i.date_end) + '</td>' +
          '<td>' + UI.esc(i.category) + '</td>' +
          '<td class="num">' + (i.items ? i.items.length : 0) + '</td>' +
          '<td class="num">' + (i.discrepancies > 0 ?
            '<span class="badge badge-warn">' + i.discrepancies + '</span>' : '0') + '</td>' +
          '<td class="actions">' +
            '<button class="btn btn-small btn-secondary" data-act="view">Просмотр</button> ' +
            '<button class="btn btn-small btn-secondary" data-act="csv">CSV</button>' +
          '</td></tr>';
      }).join('') : '<tr><td colspan="7"><div class="empty">Закрытых инвентаризаций пока нет.</div></td></tr>') +
      '</tbody>';

    table.querySelectorAll('tr[data-id]').forEach(function (tr) {
      var id = +tr.getAttribute('data-id');
      var inv = closed.find(function (i) { return i.id === id; });
      tr.querySelector('[data-act="view"]').addEventListener('click', function () { viewReport(inv); });
      tr.querySelector('[data-act="csv"]').addEventListener('click', function () { exportSheet(inv); });
    });

    container.querySelector('#inv-new').addEventListener('click', createSession);
  }

  /* ----------------------------- Новая сессия ------------------------------ */

  function createSession() {
    var body =
      '<div class="form-grid">' +
        '<div class="form-field full"><label>Область инвентаризации</label>' +
          '<select id="inv-cat">' +
            '<option value="">Все товары</option>' +
            AG.Products.CATEGORIES.map(function (c) { return '<option>' + c + '</option>'; }).join('') +
          '</select></div>' +
      '</div>';

    UI.modal({
      title: 'Новая инвентаризация',
      body: body,
      buttons: [
        { label: 'Отмена', class: 'btn-secondary', onClick: function () { return true; } },
        {
          label: 'Создать сессию', class: 'btn-primary',
          onClick: function (ctx) {
            var cat = ctx.modal.querySelector('#inv-cat').value;
            DB.getAll('products').then(function (products) {
              var items = products
                .filter(function (p) { return !cat || p.category === cat; })
                .sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); })
                .map(function (p) {
                  return {
                    product_id: p.id, sku: p.sku, name: p.name, unit: p.unit,
                    serial_tracking: p.serial_tracking ? 1 : 0,
                    expected: +p.quantity || 0, actual: null
                  };
                });
              if (!items.length) {
                UI.showFormErrors(ctx.modal, ['Нет товаров в выбранной области.']);
                return;
              }
              var inv = {
                date_start: UI.todayLocal(),
                date_end: null,
                status: 'active',
                category: cat || 'Все товары',
                items: items,
                discrepancies: 0,
                created_at: Date.now()
              };
              DB.add('inventories', inv).then(function (id) {
                inv.id = id;
                UI.toast('Сессия инвентаризации №' + id + ' создана: позиций ' + items.length + '.', 'success');
                ctx.close();
                renderPage(container);
              });
            });
          }
        }
      ]
    });
  }

  /* --------------------------- Активная сессия ----------------------------- */

  function renderSession(inv) {
    container.innerHTML =
      '<div class="page-header"><h2>Инвентаризация №' + inv.id + ' <span class="badge badge-warn">активна</span></h2>' +
        '<div class="page-actions">' +
          '<button class="btn btn-primary" id="inv-close">Закрыть инвентаризацию</button>' +
          '<button class="btn btn-outline-danger" id="inv-cancel">Отменить сессию</button>' +
        '</div>' +
      '</div>' +
      '<div class="alert alert-info">Категория: <b>' + UI.esc(inv.category) + '</b> · создана ' + UI.fmtDate(inv.date_start) +
        '. Введите фактические остатки — расхождения подсвечиваются автоматически.</div>' +
      '<div class="table-wrap"><table class="table" id="inv-active-table"></table></div>' +
      '<div class="mb14" id="inv-summary"></div>';

    renderSessionTable(inv);

    container.querySelector('#inv-close').addEventListener('click', function () { closeSession(inv); });
    container.querySelector('#inv-cancel').addEventListener('click', function () {
      UI.confirm('Отменить сессию инвентаризации №' + inv.id + '?<br><span class="muted">Введённые данные будут удалены, остатки не изменятся.</span>',
        { title: 'Отмена инвентаризации', danger: true, okLabel: 'Отменить сессию' })
        .then(function (ok) {
          if (!ok) return;
          DB.del('inventories', inv.id).then(function () {
            UI.toast('Сессия удалена.', 'info');
            renderPage(container);
          });
        });
    });
  }

  function renderSessionTable(inv) {
    var table = container.querySelector('#inv-active-table');
    table.innerHTML =
      '<thead><tr><th>Товар</th><th>Артикул</th><th>Ед.</th>' +
      '<th class="num">Учётный остаток</th><th class="num" style="width:130px">Фактический</th><th class="num">Расхождение</th></tr></thead>' +
      '<tbody>' +
      inv.items.map(function (it, idx) {
        var diff = it.actual === null ? null : it.actual - it.expected;
        return '<tr data-idx="' + idx + '" class="' + (diff ? 'row-diff' : '') + '">' +
          '<td>' + UI.esc(it.name) + (it.serial_tracking ? ' <span class="badge badge-muted">сер. учёт</span>' : '') + '</td>' +
          '<td class="nowrap">' + UI.esc(it.sku) + '</td>' +
          '<td>' + UI.esc(it.unit) + '</td>' +
          '<td class="num">' + it.expected + '</td>' +
          '<td class="num"><input type="number" min="0" step="1" data-actual="' + idx + '" value="' + (it.actual === null ? '' : it.actual) + '" style="width:100px"></td>' +
          '<td class="num diff-cell">' + (diff === null ? '—' : (diff > 0 ? '+' + diff : diff)) + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody>';

    table.querySelectorAll('input[data-actual]').forEach(function (input) {
      // Обновляем diff без полной перерисовки, чтобы не терять фокус ввода
      input.addEventListener('input', function () {
        var idx = +input.getAttribute('data-actual');
        var val = input.value.trim();
        inv.items[idx].actual = val === '' ? null : UI.parseIntStrict(val);

        var tr = table.querySelector('tr[data-idx="' + idx + '"]');
        var cell = tr.querySelector('.diff-cell');
        var it = inv.items[idx];
        var diff = (it.actual === null) ? null : it.actual - it.expected;
        cell.textContent = diff === null ? '—' : (diff > 0 ? '+' + diff : String(diff));
        cell.className = 'num diff-cell ' + (diff < 0 ? 'diff-neg' : diff > 0 ? 'diff-pos' : '');
        tr.className = diff ? 'row-diff' : '';
        renderSummary(inv);
      });
      // Черновик сохраняем с задержкой, чтобы не потерять ввод при перезагрузке
      input.addEventListener('input', UI.debounce(function () {
        DB.put('inventories', inv);
      }, 400));
    });

    renderSummary(inv);
  }

  function renderSummary(inv) {
    var filled = inv.items.filter(function (i) { return i.actual !== null; }).length;
    var diffs = inv.items.filter(function (i) { return i.actual !== null && i.actual !== i.expected; });
    container.querySelector('#inv-summary').innerHTML =
      'Заполнено: <b>' + filled + ' / ' + inv.items.length + '</b> · расхождений: <b>' + diffs.length + '</b>';
  }

  /* ---------------------------- Закрытие сессии ---------------------------- */

  function closeSession(inv) {
    var notFilled = inv.items.filter(function (i) { return i.actual === null; }).length;
    var bad = inv.items.filter(function (i) { return i.actual !== null && i.actual < 0; }).length;

    if (bad || notFilled) {
      UI.toast('Заполните фактические остатки для всех позиций (целые числа ≥ 0).', 'error', 5000);
      return;
    }

    var diffs = inv.items.filter(function (i) { return i.actual !== i.expected; });
    var serialDiffs = diffs.filter(function (i) { return i.serial_tracking; });

    var msg = 'Закрыть инвентаризацию №' + inv.id + '?<br>' +
      'Расхождений: <b>' + diffs.length + '</b>. По каждому будет создана операция «Корректировка», остатки обновятся.';
    if (serialDiffs.length) {
      msg += '<br><span style="color:var(--color-warning)">Внимание: ' + serialDiffs.length +
        ' позиций с серийным учётом имеют расхождения и <b>не</b> будут скорректированы автоматически ' +
        '(используйте приход/списание с серийными номерами).</span>';
    }

    UI.confirm(msg, { title: 'Закрытие инвентаризации', okLabel: 'Закрыть и скорректировать' })
      .then(function (ok) {
        if (!ok) return;

        var date = UI.todayLocal();
        inv.status = 'closed';
        inv.date_end = date;
        inv.discrepancies = diffs.length;

        // Корректирующие операции только по товарам без серийного учёта
        var toAdjust = diffs.filter(function (i) { return !i.serial_tracking; });
        var chain = Promise.resolve();
        toAdjust.forEach(function (item) {
          chain = chain.then(function () {
            return AG.Operations.applyOperation({
              type: 'adjust',
              product_id: item.product_id,
              new_qty: item.actual,
              date: date,
              basis: 'Инвентаризация №' + inv.id,
              comment: 'Инвентаризация №' + inv.id + ' от ' + UI.fmtDate(inv.date_start) +
                ': учётный ' + item.expected + ', фактический ' + item.actual
            });
          });
        });

        chain.then(function () { return DB.put('inventories', inv); })
          .then(function () {
            UI.toast('Инвентаризация №' + inv.id + ' закрыта. Создано корректировок: ' + toAdjust.length + '.', 'success', 6000);
            if (serialDiffs.length) {
              UI.modal({
                title: 'Позиции с серийным учётом не скорректированы',
                body: '<div class="alert alert-warn">По следующим позициям есть расхождения, но автоматическая корректировка невозможна — остаток меняется приходом/списанием с серийными номерами:</div>' +
                  '<ul>' + serialDiffs.map(function (i) {
                    return '<li>' + UI.esc(i.name) + ' (' + UI.esc(i.sku) + '): учётный ' + i.expected + ', фактический ' + i.actual + '</li>';
                  }).join('') + '</ul>',
                buttons: [{ label: 'Понятно', class: 'btn-primary', onClick: function () { return true; } }]
              });
            }
            renderPage(container);
          })
          .catch(function (err) {
            UI.toast('Ошибка при закрытии: ' + err.message, 'error', 7000);
          });
      });
  }

  /* ---------------------- Просмотр и выгрузка ведомости -------------------- */

  var SHEET_HEADERS = ['sku', 'name', 'unit', 'expected', 'actual', 'diff'];

  function sheetRows(inv) {
    return (inv.items || []).map(function (i) {
      return [i.sku, i.name, i.unit, i.expected, i.actual, i.actual - i.expected];
    });
  }

  function viewReport(inv) {
    var rows = inv.items || [];
    UI.modal({
      title: 'Инвентаризационная ведомость №' + inv.id + ' (' + UI.fmtDate(inv.date_start) + ' — ' + UI.fmtDate(inv.date_end) + ')',
      wide: true,
      body:
        '<div class="mb14">Категория: <b>' + UI.esc(inv.category) + '</b> · расхождений: <b>' + inv.discrepancies + '</b></div>' +
        '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>Товар</th><th>Артикул</th><th>Ед.</th><th class="num">Учётный</th><th class="num">Фактический</th><th class="num">Расхождение</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (i) {
          var d = i.actual - i.expected;
          return '<tr class="' + (d ? 'row-diff' : '') + '">' +
            '<td>' + UI.esc(i.name) + '</td><td>' + UI.esc(i.sku) + '</td><td>' + UI.esc(i.unit) + '</td>' +
            '<td class="num">' + i.expected + '</td><td class="num">' + i.actual + '</td>' +
            '<td class="num diff-cell ' + (d < 0 ? 'diff-neg' : d > 0 ? 'diff-pos' : '') + '">' + (d > 0 ? '+' + d : d) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>',
      buttons: [
        { label: 'Экспорт CSV', class: 'btn-secondary', onClick: function () { exportSheet(inv); } },
        { label: 'Закрыть', class: 'btn-primary', onClick: function () { return true; } }
      ]
    });
  }

  function exportSheet(inv) {
    CSV.download(CSV.filename('inventory_' + inv.id), SHEET_HEADERS, sheetRows(inv));
    UI.toast('Ведомость №' + inv.id + ' выгружена.', 'success');
  }

  return {
    renderPage: renderPage,
    SHEET_HEADERS: SHEET_HEADERS,
    sheetRows: sheetRows,
    exportSheet: exportSheet
  };
})();
