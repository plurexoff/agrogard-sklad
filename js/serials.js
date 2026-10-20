/* ==========================================================================
 * serials.js — экран «Выданное оборудование» и учёт серийных номеров.
 * serial_items: {id, product_id, serial, status: in_stock|issued|written_off,
 *   employee_id, employee_name, issue_date, basis, issue_op_id,
 *   created_op_id, created_date, last_return_date, writeoff_*}
 * Пространство имён: AG.Serials
 * ========================================================================== */
window.AG = window.AG || {};

AG.Serials = (function () {
  'use strict';

  var UI = AG.UI, DB = AG.DB, CSV = AG.CSV;

  var STATUS = {
    in_stock: { label: 'На складе', badge: 'badge-in' },
    issued: { label: 'Выдано', badge: 'badge-out' },
    written_off: { label: 'Списано', badge: 'badge-writeoff' }
  };

  var state = { status: 'issued', product_id: '', employee_id: '', search: '' };
  var container = null;
  var productsCache = [];
  var employeesCache = [];

  function renderPage(el) {
    container = el;
    Promise.all([DB.getAll('products'), DB.getAll('employees')]).then(function (res) {
      productsCache = res[0].filter(function (p) { return p.serial_tracking; })
        .sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
      employeesCache = res[1].sort(function (a, b) { return a.full_name.localeCompare(b.full_name, 'ru'); });

      container.innerHTML =
        '<div class="page-header"><h2>Выданное оборудование</h2>' +
          '<div class="page-actions">' +
            '<button class="btn btn-secondary" id="ser-export">Экспорт CSV</button>' +
          '</div>' +
        '</div>' +
        '<div class="toolbar">' +
          '<input type="search" id="ser-search" placeholder="Поиск по серийному номеру" value="' + UI.esc(state.search) + '">' +
          '<select id="ser-status">' +
            '<option value="issued"' + (state.status === 'issued' ? ' selected' : '') + '>Выданные</option>' +
            '<option value="in_stock"' + (state.status === 'in_stock' ? ' selected' : '') + '>На складе</option>' +
            '<option value="written_off"' + (state.status === 'written_off' ? ' selected' : '') + '>Списанные</option>' +
            '<option value=""' + (state.status === '' ? ' selected' : '') + '>Все статусы</option>' +
          '</select>' +
          '<select id="ser-product"><option value="">Все товары с сер. учётом</option>' +
            productsCache.map(function (p) {
              return '<option value="' + p.id + '"' + (String(p.id) === String(state.product_id) ? ' selected' : '') + '>' +
                UI.esc(p.name) + '</option>';
            }).join('') +
          '</select>' +
          '<select id="ser-employee"><option value="">Все сотрудники</option>' +
            employeesCache.map(function (e) {
              return '<option value="' + e.id + '"' + (String(e.id) === String(state.employee_id) ? ' selected' : '') + '>' +
                UI.esc(e.full_name) + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
        '<div class="table-wrap"><table class="table" id="ser-table"></table></div>';

      container.querySelector('#ser-search').addEventListener('input', UI.debounce(function (e) {
        state.search = e.target.value; renderTable();
      }, 200));
      container.querySelector('#ser-status').addEventListener('change', function (e) { state.status = e.target.value; renderTable(); });
      container.querySelector('#ser-product').addEventListener('change', function (e) { state.product_id = e.target.value; renderTable(); });
      container.querySelector('#ser-employee').addEventListener('change', function (e) { state.employee_id = e.target.value; renderTable(); });
      container.querySelector('#ser-export').addEventListener('click', exportIssued);

      renderTable();
    });
  }

  function filtered(items) {
    var q = state.search.trim().toLowerCase();
    return items.filter(function (it) {
      if (state.status && it.status !== state.status) return false;
      if (state.product_id && String(it.product_id) !== String(state.product_id)) return false;
      if (state.employee_id && String(it.employee_id) !== String(state.employee_id)) return false;
      if (q && it.serial.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderTable() {
    DB.getAll('serial_items').then(function (items) {
      var rows = filtered(items).sort(function (a, b) {
        // Свежие выдачи сверху
        if (a.issue_date !== b.issue_date) return String(b.issue_date).localeCompare(String(a.issue_date));
        return a.serial.localeCompare(b.serial, 'ru');
      });
      var byId = {};
      productsCache.forEach(function (p) { byId[p.id] = p; });
      // Товар мог быть удалён из кэша фильтра serial_tracking — подстрахуемся
      var table = container.querySelector('#ser-table');

      DB.getAll('products').then(function (allProducts) {
        var prodById = {};
        allProducts.forEach(function (p) { prodById[p.id] = p; });

        table.innerHTML =
          '<thead><tr>' +
            '<th>Серийный №</th><th>Товар</th><th>Статус</th><th>Сотрудник</th>' +
            '<th>Дата выдачи</th><th>Основание</th><th style="width:110px">Действия</th>' +
          '</tr></thead><tbody>' +
          (rows.length ? rows.map(function (it) { return rowHtml(it, prodById[it.product_id]); }).join('') :
            '<tr><td colspan="7"><div class="empty">Записей не найдено.</div></td></tr>') +
          '</tbody>';

        table.querySelectorAll('button[data-return]').forEach(function (b) {
          b.addEventListener('click', function () {
            returnOne(+b.getAttribute('data-return'));
          });
        });
      });
    });
  }

  function rowHtml(it, product) {
    var st = STATUS[it.status] || { label: it.status, badge: 'badge-muted' };
    return '<tr>' +
      '<td class="nowrap"><b>' + UI.esc(it.serial) + '</b></td>' +
      '<td>' + (product ? UI.esc(product.name) + ' <span class="muted">' + UI.esc(product.sku) + '</span>' : '<span class="muted">товар удалён</span>') + '</td>' +
      '<td><span class="badge ' + st.badge + '">' + st.label + '</span></td>' +
      '<td>' + (it.employee_name ? UI.esc(it.employee_name) : '—') + '</td>' +
      '<td class="nowrap">' + UI.fmtDate(it.issue_date) + '</td>' +
      '<td>' + (it.basis ? UI.esc(it.basis) : '—') + '</td>' +
      '<td>' + (it.status === 'issued' ?
        '<button class="btn btn-small btn-primary" data-return="' + it.id + '">Вернуть</button>' : '') + '</td>' +
    '</tr>';
  }

  /** Возврат одного серийного номера (создаёт операцию «Возврат»). */
  function returnOne(serialItemId) {
    DB.get('serial_items', serialItemId).then(function (it) {
      if (!it || it.status !== 'issued') { UI.toast('Запись не найдена или уже возвращена.', 'error'); return; }
      var body =
        '<div class="form-grid">' +
          '<div class="form-errors"></div>' +
          '<div class="form-field full"><div class="alert alert-info" style="margin:0">' +
            'Возврат: <b>' + UI.esc(it.serial) + '</b> от сотрудника <b>' + UI.esc(it.employee_name || '—') + '</b></div></div>' +
          '<div class="form-field"><label>Дата возврата <span class="req">*</span></label>' +
            '<input id="ret-date" type="date" value="' + UI.todayLocal() + '"></div>' +
          '<div class="form-field full"><label>Комментарий</label><textarea id="ret-comment" rows="2" maxlength="500"></textarea></div>' +
        '</div>';
      UI.modal({
        title: 'Возврат оборудования',
        body: body,
        buttons: [
          { label: 'Отмена', class: 'btn-secondary', onClick: function () { return true; } },
          {
            label: 'Оформить возврат', class: 'btn-primary',
            onClick: function (ctx) {
              var date = ctx.modal.querySelector('#ret-date').value;
              if (!date || !UI.isValidISODate(date)) {
                UI.showFormErrors(ctx.modal, ['Укажите корректную дату возврата.']);
                return;
              }
              AG.Operations.applyOperation({
                type: 'return',
                product_id: it.product_id,
                serial_ids: [it.id],
                date: date,
                comment: ctx.modal.querySelector('#ret-comment').value.trim()
              }).then(function () {
                UI.toast('Серийный номер ' + it.serial + ' возвращён на склад.', 'success');
                ctx.close();
                renderTable();
              }).catch(function (err) {
                UI.showFormErrors(ctx.modal, [err.message]);
              });
            }
          }
        ]
      });
    });
  }

  /* ------------------------------- Экспорт -------------------------------- */

  var ISSUED_HEADERS = ['serial', 'sku', 'product', 'employee', 'issue_date', 'basis'];

  function issuedRows(items) {
    return items.map(function (it) {
      var p = productsCache.find(function (x) { return x.id === it.product_id; });
      return [it.serial, p ? p.sku : '', p ? p.name : '', it.employee_name || '', it.issue_date || '', it.basis || ''];
    });
  }

  function exportIssued() {
    DB.getAll('serial_items').then(function (items) {
      var rows = filtered(items);
      CSV.download(CSV.filename('issued'), ISSUED_HEADERS, issuedRows(rows));
      UI.toast('Экспортировано записей: ' + rows.length + '.', 'success');
    });
  }

  return {
    STATUS: STATUS,
    renderPage: renderPage,
    ISSUED_HEADERS: ISSUED_HEADERS,
    issuedRows: issuedRows
  };
})();
