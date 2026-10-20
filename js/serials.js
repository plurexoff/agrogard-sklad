/* ==========================================================================
 * serials.js — экран «Выданное оборудование».
 * Показывает два блока:
 *  1) серийные номера (serial_items): статус, получатель, дата, основание,
 *     возврат одной кнопкой;
 *  2) количественные выдачи товаров БЕЗ серийного учёта — вычисляются из
 *     журнала операций: Σ(выдача) − Σ(возврат) по паре «товар + сотрудник».
 *     Возвраты без указания сотрудника гасят самые ранние выдачи товара (FIFO).
 *     Благодаря этому выданные ПО/лицензии, расходники и прочие
 *     количественные товары тоже видны на вкладке «Выданное».
 *
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
      productsCache = res[0].slice()
        .sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
      employeesCache = res[1].slice()
        .sort(function (a, b) { return a.full_name.localeCompare(b.full_name, 'ru'); });

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
          '<select id="ser-product"><option value="">Все товары</option>' +
            productsCache.map(function (p) {
              return '<option value="' + p.id + '"' + (String(p.id) === String(state.product_id) ? ' selected' : '') + '>' +
                UI.esc(p.name) + (p.serial_tracking ? '' : ' (без сер. учёта)') + '</option>';
            }).join('') +
          '</select>' +
          '<select id="ser-employee"><option value="">Все сотрудники</option>' +
            employeesCache.map(function (e) {
              return '<option value="' + e.id + '"' + (String(e.id) === String(state.employee_id) ? ' selected' : '') + '>' +
                UI.esc(e.full_name) + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
        '<div class="table-wrap"><table class="table" id="ser-table"></table></div>' +
        '<div id="qty-section">' +
          '<h3 style="margin:18px 0 8px;font-size:15px">Выданное по количеству ' +
            '<span class="muted" style="font-weight:400">(товары без серийного учёта: выдачи минус возвраты)</span></h3>' +
          '<div class="table-wrap"><table class="table" id="qty-table"></table></div>' +
        '</div>';

      container.querySelector('#ser-search').addEventListener('input', UI.debounce(function (e) {
        state.search = e.target.value; renderTables();
      }, 200));
      container.querySelector('#ser-status').addEventListener('change', function (e) { state.status = e.target.value; renderTables(); });
      container.querySelector('#ser-product').addEventListener('change', function (e) { state.product_id = e.target.value; renderTables(); });
      container.querySelector('#ser-employee').addEventListener('change', function (e) { state.employee_id = e.target.value; renderTables(); });
      container.querySelector('#ser-export').addEventListener('click', exportIssued);

      renderTables();
    });
  }

  /* ==================== Серийные номера (таблица 1) ==================== */

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

  function renderTables() {
    Promise.all([DB.getAll('serial_items'), DB.getAll('operations'), DB.getAll('products')])
      .then(function (res) {
        var prodById = {};
        res[2].forEach(function (p) { prodById[p.id] = p; });
        renderSerialTable(res[0], prodById);
        renderQtyTable(computeQtyIssued(res[1], prodById), prodById);
      });
  }

  function renderSerialTable(items, prodById) {
    var rows = filtered(items).sort(function (a, b) {
      // Свежие выдачи сверху
      if (a.issue_date !== b.issue_date) return String(b.issue_date).localeCompare(String(a.issue_date));
      return a.serial.localeCompare(b.serial, 'ru');
    });

    var table = container.querySelector('#ser-table');
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
                renderTables();
              }).catch(function (err) {
                UI.showFormErrors(ctx.modal, [err.message]);
              });
            }
          }
        ]
      });
    });
  }

  /* ========== Количественные выдачи без серийного учёта (таблица 2) ========== */

  function byDateAsc(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.created_at || 0) - (b.created_at || 0);
  }

  /**
   * Текущие количественные выдачи: Σ(out) − Σ(return) по паре товар+сотрудник.
   * Возврат сотрудника гасит в первую очередь его собственные выдачи;
   * возврат без сотрудника — самые ранние выдачи товара (FIFO).
   * Возвращает [{product_id, employee_id, employee_name, qty, lastDate, basis,
   *              product_name, product_sku}] — только позиции с qty > 0.
   */
  function computeQtyIssued(ops, prodById) {
    function nonSerial(o) {
      if (o.type !== 'out' && o.type !== 'return') return false;
      var p = prodById[o.product_id];
      if (p) return !p.serial_tracking;
      // Товар удалён из справочника — судим по содержимому операции
      return !(o.serials && o.serials.length);
    }

    var buckets = {}; // ключ: product_id|employee_id
    ops.filter(function (o) { return o.type === 'out' && nonSerial(o); }).sort(byDateAsc)
      .forEach(function (o) {
        var key = o.product_id + '|' + (o.employee_id == null ? '' : o.employee_id);
        var b = buckets[key];
        if (!b) {
          b = buckets[key] = {
            product_id: o.product_id,
            employee_id: o.employee_id == null ? null : o.employee_id,
            employee_name: o.employee_name || '',
            qty: 0, firstDate: o.date, lastDate: o.date, basis: o.basis || '',
            product_name: o.product_name, product_sku: o.product_sku
          };
        }
        b.qty += (+o.qty || 0);
        if (o.date < b.firstDate) b.firstDate = o.date;
        if (String(o.date) >= String(b.lastDate)) { b.lastDate = o.date; if (o.basis) b.basis = o.basis; }
      });

    ops.filter(function (o) { return o.type === 'return' && nonSerial(o); }).sort(byDateAsc)
      .forEach(function (o) {
        var left = +o.qty || 0;
        if (!left) return;
        var keys = Object.keys(buckets).filter(function (k) {
          return String(buckets[k].product_id) === String(o.product_id) && buckets[k].qty > 0;
        });
        keys.sort(function (ka, kb) {
          var a = buckets[ka], b = buckets[kb];
          // Возврат с указанным сотрудником гасит сначала его собственные выдачи
          if (o.employee_id != null) {
            var am = String(a.employee_id) === String(o.employee_id) ? 0 : 1;
            var bm = String(b.employee_id) === String(o.employee_id) ? 0 : 1;
            if (am !== bm) return am - bm;
          }
          return String(a.firstDate) < String(b.firstDate) ? -1 : 1;
        });
        for (var i = 0; i < keys.length && left > 0; i++) {
          var b = buckets[keys[i]];
          var take = Math.min(b.qty, left);
          b.qty -= take; left -= take;
        }
      });

    return Object.keys(buckets).map(function (k) { return buckets[k]; })
      .filter(function (b) { return b.qty > 0; });
  }

  function filteredQty(rows) {
    return rows.filter(function (r) {
      if (state.product_id && String(r.product_id) !== String(state.product_id)) return false;
      if (state.employee_id && String(r.employee_id) !== String(state.employee_id)) return false;
      return true;
    }).sort(function (a, b) {
      if (a.lastDate !== b.lastDate) return String(b.lastDate).localeCompare(String(a.lastDate));
      return String(a.product_name).localeCompare(String(b.product_name), 'ru');
    });
  }

  function renderQtyTable(rows, prodById) {
    var section = container.querySelector('#qty-section');
    // Блок актуален только для режимов «Выданные» / «Все статусы»
    if (state.status && state.status !== 'issued') { section.style.display = 'none'; return; }
    section.style.display = '';

    var list = filteredQty(rows);
    var table = container.querySelector('#qty-table');
    table.innerHTML =
      '<thead><tr>' +
        '<th>Товар</th><th>Сотрудник</th><th class="num">Кол-во на руках</th>' +
        '<th>Последняя выдача</th><th>Основание</th><th style="width:110px">Действия</th>' +
      '</tr></thead><tbody>' +
      (list.length ? list.map(function (r, i) {
        var p = prodById[r.product_id];
        return '<tr>' +
          '<td>' + (p ? UI.esc(p.name) + ' <span class="muted">' + UI.esc(p.sku) + '</span>'
                     : UI.esc(r.product_name) + ' <span class="muted">' + UI.esc(r.product_sku) + ' · товар удалён</span>') + '</td>' +
          '<td>' + (r.employee_name ? UI.esc(r.employee_name) : '—') + '</td>' +
          '<td class="num"><b>' + r.qty + '</b> ' + UI.esc(p ? p.unit : '') + '</td>' +
          '<td class="nowrap">' + UI.fmtDate(r.lastDate) + '</td>' +
          '<td>' + (r.basis ? UI.esc(r.basis) : '—') + '</td>' +
          '<td><button class="btn btn-small btn-primary" data-qreturn="' + i + '">Вернуть</button></td>' +
        '</tr>';
      }).join('') :
        '<tr><td colspan="6"><div class="empty">Выданного по количеству нет.</div></td></tr>') +
      '</tbody>';

    table.querySelectorAll('button[data-qreturn]').forEach(function (b) {
      b.addEventListener('click', function () {
        returnQty(list[+b.getAttribute('data-qreturn')], prodById);
      });
    });
  }

  /** Возврат количественной выдачи (создаёт операцию «Возврат»). */
  function returnQty(row, prodById) {
    var p = prodById[row.product_id];
    var name = p ? p.name : row.product_name;
    var unit = p ? p.unit : '';
    var body =
      '<div class="form-grid">' +
        '<div class="form-errors"></div>' +
        '<div class="form-field full"><div class="alert alert-info" style="margin:0">' +
          'Возврат: <b>' + UI.esc(name) + '</b> от сотрудника <b>' + UI.esc(row.employee_name || '—') + '</b>. ' +
          'Числится выданным: <b>' + row.qty + '</b> ' + UI.esc(unit) + '</div></div>' +
        '<div class="form-field"><label>Количество <span class="req">*</span></label>' +
          '<input id="ret-qty" type="number" min="1" max="' + row.qty + '" step="1" value="' + row.qty + '"></div>' +
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
            var errors = [];
            var qty = UI.parseIntStrict(ctx.modal.querySelector('#ret-qty').value);
            var date = ctx.modal.querySelector('#ret-date').value;
            if (qty === null || qty < 1) errors.push('Количество должно быть целым числом ≥ 1.');
            else if (qty > row.qty) errors.push('Нельзя вернуть больше, чем числится выданным (' + row.qty + ' ' + unit + ').');
            if (!date || !UI.isValidISODate(date)) errors.push('Укажите корректную дату возврата.');
            if (errors.length) { UI.showFormErrors(ctx.modal, errors); return; }

            AG.Operations.applyOperation({
              type: 'return',
              product_id: row.product_id,
              qty: qty,
              date: date,
              employee_id: row.employee_id,
              comment: ctx.modal.querySelector('#ret-comment').value.trim()
            }).then(function () {
              UI.toast('Возврат «' + name + '» (' + qty + ' ' + unit + ') оформлен.', 'success');
              ctx.close();
              renderTables();
            }).catch(function (err) {
              UI.showFormErrors(ctx.modal, [err.message]);
            });
          }
        }
      ]
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

  /** Выгрузка обеих таблиц одним файлом (с учётом текущих фильтров). */
  function exportIssued() {
    Promise.all([DB.getAll('serial_items'), DB.getAll('operations'), DB.getAll('products')])
      .then(function (res) {
        var prodById = {};
        res[2].forEach(function (p) { prodById[p.id] = p; });

        var serialPart = filtered(res[0]).map(function (it) {
          var p = prodById[it.product_id];
          return [it.serial, p ? p.sku : '', p ? p.name : it.product_name || '', 1,
            it.employee_name || '', it.issue_date || '', it.basis || ''];
        });

        var qtyPart = [];
        if (!state.status || state.status === 'issued') {
          qtyPart = filteredQty(computeQtyIssued(res[1], prodById)).map(function (r) {
            var p = prodById[r.product_id];
            return ['', p ? p.sku : r.product_sku, p ? p.name : r.product_name, r.qty,
              r.employee_name || '', r.lastDate || '', r.basis || ''];
          });
        }

        var rows = serialPart.concat(qtyPart);
        CSV.download(CSV.filename('issued'),
          ['serial', 'sku', 'product', 'qty', 'employee', 'issue_date', 'basis'], rows);
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
