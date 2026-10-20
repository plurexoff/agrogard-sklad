/* ==========================================================================
 * operations.js — складские операции и журнал.
 * Типы операций: in (Приход), out (Выдача), writeoff (Списание),
 *                return (Возврат), adjust (Корректировка).
 * Каждая операция атомарно меняет products.quantity и (при серийном учёте)
 * записи serial_items. Удаление операции полностью откатывает её эффект.
 * Пространство имён: AG.Operations
 * ========================================================================== */
window.AG = window.AG || {};

AG.Operations = (function () {
  'use strict';

  var UI = AG.UI, DB = AG.DB, CSV = AG.CSV;

  var TYPES = {
    in:       { label: 'Приход',        badge: 'badge-in' },
    out:      { label: 'Выдача',        badge: 'badge-out' },
    writeoff: { label: 'Списание',      badge: 'badge-writeoff' },
    return:   { label: 'Возврат',       badge: 'badge-return' },
    adjust:   { label: 'Корректировка', badge: 'badge-adjust' }
  };

  var WRITEOFF_REASONS = ['Поломка', 'Устаревание', 'Утеря', 'Другое'];

  var state = { from: '', to: '', type: '', product_id: '' };
  var container = null;
  var productsCache = [];

  /* ============================ Ядро: проведение ============================ */

  /**
   * Провести операцию. input:
   *  {type, product_id, date, qty, new_qty, supplier, invoice_no, employee_id,
   *   reason, basis, comment, serials: [строки] (для in), serial_ids: [id] (для out/writeoff/return)}
   * Возвращает Promise<op>. При ошибке валидации — reject с Error(текст).
   */
  function applyOperation(input) {
    var product, employee = null;
    var type = input.type;

    return DB.get('products', input.product_id).then(function (p) {
      if (!p) throw new Error('Товар не найден.');
      product = p;
      if (input.employee_id) return DB.get('employees', +input.employee_id);
      return null;
    }).then(function (emp) {
      employee = emp;

      var op = {
        type: type,
        product_id: product.id,
        product_name: product.name,
        product_sku: product.sku,
        qty: 0,
        delta: 0,
        date: input.date || UI.todayLocal(),
        created_at: Date.now(),
        supplier: input.supplier || '',
        invoice_no: input.invoice_no || '',
        employee_id: employee ? employee.id : null,
        employee_name: employee ? employee.full_name : '',
        reason: input.reason || '',
        basis: input.basis || '',
        comment: input.comment || '',
        serial_ids: [],
        serials: [],
        return_snapshot: []
      };

      /* ---- Подготовка и валидация по типам ---- */
      var serialItems = []; // записи serial_items для out/writeoff/return

      if (type === 'in') {
        if (product.serial_tracking) {
          var serials = (input.serials || []).map(function (s) { return String(s).trim(); })
            .filter(function (s) { return s !== ''; });
          if (!serials.length) throw new Error('Введите серийные номера (по одному на строку).');
          var seen = {};
          for (var i = 0; i < serials.length; i++) {
            if (seen[serials[i]]) throw new Error('Серийный номер «' + serials[i] + '» указан дважды.');
            seen[serials[i]] = true;
          }
          op.qty = serials.length;
          op.delta = serials.length;
          op.serials = serials;
        } else {
          var qtyIn = UI.parseIntStrict(input.qty);
          if (qtyIn === null || qtyIn < 1) throw new Error('Количество должно быть целым числом ≥ 1.');
          op.qty = qtyIn; op.delta = qtyIn;
        }
      }

      if (type === 'out' || type === 'writeoff') {
        if (type === 'out' && !employee) throw new Error('Выберите получателя из справочника сотрудников.');
        if (type === 'writeoff' && !op.reason) throw new Error('Укажите причину списания.');

        if (product.serial_tracking) {
          var ids = (input.serial_ids || []).map(Number);
          if (!ids.length) throw new Error('Выберите серийные номера.');
          op.qty = ids.length; op.delta = -ids.length;
        } else {
          var qtyOut = UI.parseIntStrict(input.qty);
          if (qtyOut === null || qtyOut < 1) throw new Error('Количество должно быть целым числом ≥ 1.');
          if (qtyOut > product.quantity) {
            throw new Error('Нельзя выдать/списать больше остатка: доступно ' + product.quantity + ' ' + product.unit + '.');
          }
          op.qty = qtyOut; op.delta = -qtyOut;
        }
      }

      if (type === 'return') {
        if (product.serial_tracking) {
          var rids = (input.serial_ids || []).map(Number);
          if (!rids.length) throw new Error('Выберите возвращаемые серийные номера.');
          op.qty = rids.length; op.delta = rids.length;
        } else {
          var qtyRet = UI.parseIntStrict(input.qty);
          if (qtyRet === null || qtyRet < 1) throw new Error('Количество должно быть целым числом ≥ 1.');
          op.qty = qtyRet; op.delta = qtyRet;
        }
      }

      if (type === 'adjust') {
        if (product.serial_tracking) {
          throw new Error('Для товара с серийным учётом остаток меняется приходом/списанием с серийными номерами.');
        }
        var newQty = UI.parseIntStrict(input.new_qty);
        if (newQty === null || newQty < 0) throw new Error('Новый остаток должен быть целым числом ≥ 0.');
        if (!op.comment) throw new Error('Для корректировки обязателен комментарий.');
        op.prev_qty = product.quantity;
        op.new_qty = newQty;
        op.delta = newQty - product.quantity;
        op.qty = Math.abs(op.delta);
      }

      /* ---- Загрузка записей серийных номеров ---- */
      var loadSerials = Promise.resolve();
      if (product.serial_tracking && (type === 'out' || type === 'writeoff' || type === 'return')) {
        var ids = input.serial_ids.map(Number);
        loadSerials = Promise.all(ids.map(function (id) { return DB.get('serial_items', id); }))
          .then(function (items) {
            for (var i = 0; i < items.length; i++) {
              var it = items[i];
              if (!it || it.product_id !== product.id) throw new Error('Серийный номер не найден.');
              if (type === 'return') {
                if (it.status !== 'issued') throw new Error('Серийный номер «' + it.serial + '» не числится выданным.');
              } else {
                if (it.status !== 'in_stock') throw new Error('Серийный номер «' + it.serial + '» недоступен на складе.');
              }
            }
            serialItems = items;
            op.serial_ids = ids;
            op.serials = items.map(function (it) { return it.serial; });
          });
      }

      // Проверка дублей серийных номеров при приходе
      if (product.serial_tracking && type === 'in') {
        loadSerials = DB.getAll('serial_items').then(function (allSer) {
          var existSet = {};
          allSer.forEach(function (s) { existSet[s.serial] = true; });
          var dups = op.serials.filter(function (s) { return existSet[s]; });
          if (dups.length) throw new Error('Серийные номера уже зарегистрированы: ' + dups.join(', '));
        });
      }

      return loadSerials.then(function () {
        /* ---- Атомарная запись: товар + журнал + серийные номера ---- */
        product.quantity = (+product.quantity || 0) + op.delta;

        return DB.writeTx(['products', 'operations', 'serial_items'], function (s) {
          s.products.put(product);
          var addReq = s.operations.add(op);
          addReq.onsuccess = function () {
            var opId = addReq.result;
            if (!product.serial_tracking) return;

            if (type === 'in') {
              op.serials.forEach(function (sn) {
                s.serial_items.add({
                  product_id: product.id, serial: sn, status: 'in_stock',
                  employee_id: null, employee_name: '', issue_date: '', basis: '',
                  issue_op_id: null, created_op_id: opId, created_date: op.date
                });
              });
            } else if (type === 'out') {
              serialItems.forEach(function (it) {
                it.status = 'issued';
                it.employee_id = employee.id;
                it.employee_name = employee.full_name;
                it.issue_date = op.date;
                it.basis = op.basis;
                it.issue_op_id = opId;
                s.serial_items.put(it);
              });
            } else if (type === 'writeoff') {
              serialItems.forEach(function (it) {
                it.status = 'written_off';
                it.writeoff_date = op.date;
                it.writeoff_op_id = opId;
                it.writeoff_reason = op.reason;
                s.serial_items.put(it);
              });
            } else if (type === 'return') {
              serialItems.forEach(function (it) {
                op.return_snapshot.push({
                  id: it.id, employee_id: it.employee_id, employee_name: it.employee_name,
                  issue_date: it.issue_date, basis: it.basis, issue_op_id: it.issue_op_id
                });
                it.status = 'in_stock';
                it.employee_id = null; it.employee_name = '';
                it.issue_date = ''; it.basis = ''; it.issue_op_id = null;
                it.last_return_date = op.date;
                s.serial_items.put(it);
              });
              // Снапшот сформировался после add — дозаписываем операцию
              op.id = opId;
              s.operations.put(op);
            }
          };
        }).then(function () { return op; });
      });
    });
  }

  /* ===================== Удаление операции с откатом ======================= */

  function describeReversal(op) {
    var t = TYPES[op.type] ? TYPES[op.type].label : op.type;
    var what;
    if (op.type === 'adjust') {
      what = 'остаток будет пересчитан обратно (Δ ' + (op.delta > 0 ? '+' : '') + op.delta + ').';
    } else if (op.delta > 0) {
      what = 'остаток будет уменьшен на ' + op.delta + '.';
    } else {
      what = 'остаток будет увеличен на ' + Math.abs(op.delta) + '.';
    }
    return 'Удалить операцию <b>«' + t + '»</b> от ' + UI.fmtDate(op.date) +
      ' для товара <b>«' + UI.esc(op.product_name) + '»</b>?<br>Остаток товара будет пересчитан: ' + what +
      (op.serials && op.serials.length ? '<br>Затронуто серийных номеров: ' + op.serials.length + '.' : '');
  }

  function deleteOperation(id) {
    var op, product;
    return DB.get('operations', id).then(function (o) {
      if (!o) throw new Error('Операция не найдена.');
      op = o;
      return DB.get('products', op.product_id);
    }).then(function (p) {
      product = p;

      var loadSerials = Promise.resolve([]);
      if (op.serial_ids && op.serial_ids.length) {
        loadSerials = Promise.all(op.serial_ids.map(function (sid) { return DB.get('serial_items', sid); }));
      }
      if (op.type === 'in' && op.serials && op.serials.length && !(op.serial_ids || []).length) {
        // Совместимость: ищем созданные этой операцией серийные номера
        loadSerials = DB.getByIndex('serial_items', 'product_id', op.product_id).then(function (items) {
          return items.filter(function (it) { return it.created_op_id === op.id; });
        });
      }

      return loadSerials.then(function (serialItems) {
        /* Проверки возможности отката */
        if (product) {
          var newQty = (+product.quantity || 0) - op.delta;
          if (newQty < 0) {
            throw new Error('Нельзя удалить операцию: остаток стал бы отрицательным (' + newQty + '). Сначала отмените последующие операции по этому товару.');
          }
        }

        if (op.type === 'in') {
          for (var i = 0; i < serialItems.length; i++) {
            if (serialItems[i] && serialItems[i].status !== 'in_stock') {
              throw new Error('Нельзя удалить приход: серийный номер «' + serialItems[i].serial + '» уже выдан или списан.');
            }
          }
        }
        if (op.type === 'out') {
          for (var j = 0; j < serialItems.length; j++) {
            var it = serialItems[j];
            if (!it || it.status !== 'issued' || it.issue_op_id !== op.id) {
              throw new Error('Нельзя удалить выдачу: состояние серийных номеров изменилось (был возврат/списание). Сначала отмените последующие операции.');
            }
          }
        }

        /* Откат в одной транзакции */
        return DB.writeTx(['products', 'operations', 'serial_items'], function (s) {
          if (product) {
            product.quantity = (+product.quantity || 0) - op.delta;
            s.products.put(product);
          }
          if (op.type === 'in') {
            serialItems.forEach(function (it) { if (it) s.serial_items.delete(it.id); });
          } else if (op.type === 'out') {
            serialItems.forEach(function (it) {
              it.status = 'in_stock';
              it.employee_id = null; it.employee_name = '';
              it.issue_date = ''; it.basis = ''; it.issue_op_id = null;
              s.serial_items.put(it);
            });
          } else if (op.type === 'writeoff') {
            serialItems.forEach(function (it) {
              if (it && it.status === 'written_off') {
                it.status = 'in_stock';
                it.writeoff_date = ''; it.writeoff_op_id = null; it.writeoff_reason = '';
                s.serial_items.put(it);
              }
            });
          } else if (op.type === 'return') {
            (op.return_snapshot || []).forEach(function (snap) {
              serialItems.forEach(function (it) {
                if (it && it.id === snap.id) {
                  it.status = 'issued';
                  it.employee_id = snap.employee_id; it.employee_name = snap.employee_name;
                  it.issue_date = snap.issue_date; it.basis = snap.basis; it.issue_op_id = snap.issue_op_id;
                  it.last_return_date = '';
                  s.serial_items.put(it);
                }
              });
            });
          }
          s.operations.delete(op.id);
        });
      });
    });
  }

  function confirmDelete(id, onDone) {
    DB.get('operations', id).then(function (op) {
      if (!op) return;
      UI.confirm(describeReversal(op), { title: 'Удаление операции', danger: true, okLabel: 'Удалить и пересчитать' })
        .then(function (ok) {
          if (!ok) return;
          deleteOperation(id)
            .then(function () { UI.toast('Операция удалена, остаток пересчитан.', 'success'); if (onDone) onDone(); })
            .catch(function (err) { UI.toast(err.message, 'error', 7000); });
        });
    });
  }

  /* ============================ Страница журнала =========================== */

  function renderPage(el) {
    container = el;
    Promise.all([DB.getAll('products')]).then(function (res) {
      productsCache = res[0].slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });

      container.innerHTML =
        '<div class="page-header"><h2>Журнал операций</h2>' +
          '<div class="page-actions">' +
            '<button class="btn btn-primary" data-newop="in">+ Приход</button>' +
            '<button class="btn btn-primary" data-newop="out">− Выдача</button>' +
            '<button class="btn btn-secondary" data-newop="return">Возврат</button>' +
            '<button class="btn btn-secondary" data-newop="writeoff">Списание</button>' +
            '<button class="btn btn-secondary" data-newop="adjust">Корректировка</button>' +
            '<button class="btn btn-secondary" id="op-export">Экспорт CSV</button>' +
          '</div>' +
        '</div>' +
        '<div class="toolbar">' +
          '<label>с <input type="date" id="f-from" value="' + state.from + '"></label>' +
          '<label>по <input type="date" id="f-to" value="' + state.to + '"></label>' +
          '<select id="f-type"><option value="">Все типы</option>' +
            Object.keys(TYPES).map(function (t) {
              return '<option value="' + t + '"' + (state.type === t ? ' selected' : '') + '>' + TYPES[t].label + '</option>';
            }).join('') +
          '</select>' +
          '<select id="f-product"><option value="">Все товары</option>' +
            productsCache.map(function (p) {
              return '<option value="' + p.id + '"' + (String(p.id) === String(state.product_id) ? ' selected' : '') + '>' +
                UI.esc(p.name) + ' (' + UI.esc(p.sku) + ')</option>';
            }).join('') +
          '</select>' +
          '<button class="btn btn-small btn-secondary" id="f-reset">Сбросить</button>' +
        '</div>' +
        '<div class="table-wrap"><table class="table" id="op-table"></table></div>';

      container.querySelectorAll('[data-newop]').forEach(function (b) {
        b.addEventListener('click', function () { openOpForm(b.getAttribute('data-newop')); });
      });
      container.querySelector('#op-export').addEventListener('click', exportJournal);
      ['f-from', 'f-to', 'f-type', 'f-product'].forEach(function (id) {
        container.querySelector('#' + id).addEventListener('change', function () {
          state.from = container.querySelector('#f-from').value;
          state.to = container.querySelector('#f-to').value;
          state.type = container.querySelector('#f-type').value;
          state.product_id = container.querySelector('#f-product').value;
          renderTable();
        });
      });
      container.querySelector('#f-reset').addEventListener('click', function () {
        state = { from: '', to: '', type: '', product_id: '' };
        renderPage(container);
      });

      renderTable();
    });
  }

  function filteredOps(ops) {
    return ops.filter(function (o) {
      if (state.type && o.type !== state.type) return false;
      if (state.product_id && String(o.product_id) !== String(state.product_id)) return false;
      if (state.from && o.date < state.from) return false;
      if (state.to && o.date > state.to) return false;
      return true;
    }).sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.created_at || 0) - (a.created_at || 0);
    });
  }

  function renderTable() {
    DB.getAll('operations').then(function (ops) {
      var rows = filteredOps(ops);
      var table = container.querySelector('#op-table');
      table.innerHTML =
        '<thead><tr>' +
          '<th>Дата</th><th>Тип</th><th>Товар</th><th class="num">Кол-во</th>' +
          '<th>Детали</th><th>Комментарий</th><th>Серийные №</th><th style="width:70px"></th>' +
        '</tr></thead><tbody>' +
        (rows.length ? rows.map(opRowHtml).join('') :
          '<tr><td colspan="8"><div class="empty">Операций не найдено.</div></td></tr>') +
        '</tbody>';

      table.querySelectorAll('button[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          confirmDelete(+b.getAttribute('data-del'), renderTable);
        });
      });
    });
  }

  function opRowHtml(o) {
    var t = TYPES[o.type] || { label: o.type, badge: 'badge-muted' };
    var qtyCell;
    if (o.type === 'adjust') {
      qtyCell = '<span class="nowrap">' + o.prev_qty + ' → ' + o.new_qty + '</span> ' +
        '<span class="' + (o.delta >= 0 ? 'qty-plus' : 'qty-minus') + '">(' + (o.delta >= 0 ? '+' : '') + o.delta + ')</span>';
    } else {
      qtyCell = '<span class="' + (o.delta > 0 ? 'qty-plus' : 'qty-minus') + '">' + (o.delta > 0 ? '+' : '') + o.delta + '</span>';
    }

    var details = [];
    if (o.supplier) details.push('Поставщик: ' + UI.esc(o.supplier));
    if (o.invoice_no) details.push('Накладная № ' + UI.esc(o.invoice_no));
    if (o.employee_name) details.push(UI.esc(o.employee_name));
    if (o.basis) details.push('Основание: ' + UI.esc(o.basis));
    if (o.reason) details.push('Причина: ' + UI.esc(o.reason));

    return '<tr>' +
      '<td class="nowrap">' + UI.fmtDate(o.date) + '</td>' +
      '<td><span class="badge ' + t.badge + '">' + t.label + '</span></td>' +
      '<td>' + UI.esc(o.product_name) + ' <span class="muted">' + UI.esc(o.product_sku) + '</span></td>' +
      '<td class="num">' + qtyCell + '</td>' +
      '<td>' + (details.join('<br>') || '—') + '</td>' +
      '<td>' + (o.comment ? UI.esc(o.comment) : '—') + '</td>' +
      '<td>' + (o.serials && o.serials.length ?
        '<span title="' + UI.esc(o.serials.join(', ')) + '">' + o.serials.length + ' шт.</span>' : '—') + '</td>' +
      '<td><button class="btn btn-small btn-outline-danger" data-del="' + o.id + '" title="Удалить операцию с пересчётом остатка">Удал.</button></td>' +
    '</tr>';
  }

  /* ============================ Формы операций ============================= */

  function productOptions(selectedId) {
    return productsCache.map(function (p) {
      return '<option value="' + p.id + '"' + (String(p.id) === String(selectedId) ? ' selected' : '') + '>' +
        UI.esc(p.name) + ' (' + UI.esc(p.sku) + ') — остаток: ' + (+p.quantity || 0) + ' ' + UI.esc(p.unit) + '</option>';
    }).join('');
  }

  function openOpForm(type, preset) {
    preset = preset || {};
    var title = TYPES[type].label;
    var needEmployee = (type === 'out');

    // Форма может вызываться вне страницы журнала (FAB в шапке) — подгружаем справочник
    var ensure = productsCache.length
      ? Promise.resolve()
      : DB.getAll('products').then(function (rows) {
          productsCache = rows.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
        });

    ensure.then(function () { return DB.getAll('employees'); }).then(function (employees) {
      employees.sort(function (a, b) { return a.full_name.localeCompare(b.full_name, 'ru'); });

      var empOptions = employees.map(function (e) {
        return '<option value="' + e.id + '">' + UI.esc(e.full_name) +
          (e.department ? ' — ' + UI.esc(e.department) : '') + '</option>';
      }).join('');

      var body =
        '<div class="form-grid">' +
          '<div class="form-errors"></div>' +
          '<div class="form-field full"><label>Товар <span class="req">*</span></label>' +
            '<select id="op-product">' + productOptions(preset.product_id) + '</select></div>' +

          (type !== 'adjust' ?
            '<div class="form-field"><label>Количество <span class="req">*</span></label>' +
            '<input id="op-qty" type="number" min="1" step="1" value="' + (preset.qty || 1) + '">' +
            '<div class="hint" id="op-avail"></div></div>'
          :
            '<div class="form-field"><label>Новый фактический остаток <span class="req">*</span></label>' +
            '<input id="op-newqty" type="number" min="0" step="1" value="0">' +
            '<div class="hint" id="op-avail"></div></div>'
          ) +

          '<div class="form-field"><label>Дата <span class="req">*</span></label>' +
            '<input id="op-date" type="date" value="' + UI.todayLocal() + '"></div>' +

          (type === 'in' ?
            '<div class="form-field"><label>Поставщик</label><input id="op-supplier" maxlength="150"></div>' +
            '<div class="form-field"><label>№ накладной</label><input id="op-invoice" maxlength="60"></div>' : '') +

          (needEmployee ?
            '<div class="form-field"><label>Получатель <span class="req">*</span></label>' +
              '<select id="op-employee"><option value="">— выберите сотрудника —</option>' + empOptions +
              '<option value="__new__">＋ Добавить нового сотрудника…</option></select></div>' +
            '<div class="form-field"><label>Основание (приказ, заявка)</label><input id="op-basis" maxlength="150"></div>' : '') +

          (type === 'return' && !preset.serial_ids ?
            '<div class="form-field"><label>Сотрудник (кто вернул)</label>' +
              '<select id="op-employee"><option value="">— не указан —</option>' + empOptions + '</select></div>' : '') +

          (type === 'writeoff' ?
            '<div class="form-field"><label>Причина <span class="req">*</span></label>' +
              '<select id="op-reason">' + WRITEOFF_REASONS.map(function (r) { return '<option>' + r + '</option>'; }).join('') + '</select></div>' : '') +

          '<div class="form-field full" id="op-serial-block"></div>' +

          '<div class="form-field full"><label>Комментарий' + (type === 'adjust' ? ' <span class="req">*</span>' : '') + '</label>' +
            '<textarea id="op-comment" rows="2" maxlength="500"></textarea></div>' +
        '</div>';

      var m = UI.modal({
        title: 'Новая операция: ' + title,
        wide: true,
        body: body,
        buttons: [
          { label: 'Отмена', class: 'btn-secondary', onClick: function () { return true; } },
          {
            label: 'Провести', class: 'btn-primary',
            onClick: function (ctx) { submitOp(ctx, type); }
          }
        ]
      });

      var el = m.el;
      var productSel = el.querySelector('#op-product');

      function refreshSerialBlock() {
        var pid = +productSel.value;
        var product = productsCache.find(function (p) { return p.id === pid; });
        var block = el.querySelector('#op-serial-block');
        var avail = el.querySelector('#op-avail');
        if (!product) { block.innerHTML = ''; return; }

        if (avail) {
          avail.textContent = product.serial_tracking
            ? (type === 'adjust' ? 'Товар с серийным учётом: корректировка недоступна.' : 'Учёт по серийным номерам')
            : 'Текущий остаток: ' + (+product.quantity || 0) + ' ' + product.unit;
        }

        if (!product.serial_tracking) { block.innerHTML = ''; return; }

        if (type === 'in') {
          block.innerHTML = '<label>Серийные номера (по одному в строке) <span class="req">*</span></label>' +
            '<textarea id="op-serials" rows="5" placeholder="SN-0001&#10;SN-0002"></textarea>' +
            '<div class="hint">Введено номеров: <b id="op-sn-count">0</b> — это и будет количеством прихода.</div>';
          var ta = block.querySelector('#op-serials');
          var qtyInput = el.querySelector('#op-qty');
          qtyInput.readOnly = true;
          ta.addEventListener('input', function () {
            var n = ta.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).length;
            block.querySelector('#op-sn-count').textContent = n;
            qtyInput.value = n || 0;
          });
          ta.dispatchEvent(new Event('input'));
        } else if (type === 'out' || type === 'writeoff' || type === 'return') {
          var status = type === 'return' ? 'issued' : 'in_stock';
          DB.getByIndex('serial_items', 'product_id', pid).then(function (items) {
            var list = items.filter(function (it) { return it.status === status; });
            if (!list.length) {
              block.innerHTML = '<div class="alert alert-warn" style="margin:0">' +
                (type === 'return' ? 'По этому товару ничего не выдано.' : 'Нет доступных серийных номеров на складе.') + '</div>';
              var qi = el.querySelector('#op-qty'); if (qi) { qi.value = 0; qi.readOnly = true; }
              return;
            }
            list.sort(function (a, b) { return a.serial.localeCompare(b.serial, 'ru'); });
            block.innerHTML = '<label>Серийные номера (выберите один или несколько, удерживая Ctrl) <span class="req">*</span></label>' +
              '<select id="op-serials" multiple size="' + Math.min(8, list.length) + '">' +
              list.map(function (it) {
                var label = it.serial;
                if (type === 'return' && it.employee_name) label += ' — ' + it.employee_name;
                return '<option value="' + it.id + '">' + UI.esc(label) + '</option>';
              }).join('') + '</select>' +
              '<div class="hint">Выбрано: <b id="op-sn-count">0</b></div>';
            var sel = block.querySelector('#op-serials');
            var qtyInput2 = el.querySelector('#op-qty');
            qtyInput2.readOnly = true;
            sel.addEventListener('change', function () {
              var n = sel.selectedOptions.length;
              block.querySelector('#op-sn-count').textContent = n;
              qtyInput2.value = n || 0;
            });
          });
        }
      }

      productSel.addEventListener('change', refreshSerialBlock);
      refreshSerialBlock();

      // Быстрое добавление сотрудника из формы выдачи
      var empSel = el.querySelector('#op-employee');
      if (empSel) {
        empSel.addEventListener('change', function () {
          if (empSel.value !== '__new__') return;
          AG.Employees.quickAddModal().then(function (emp) {
            if (emp) {
              var opt = document.createElement('option');
              opt.value = emp.id;
              opt.textContent = emp.full_name + (emp.department ? ' — ' + emp.department : '');
              empSel.insertBefore(opt, empSel.lastElementChild);
              empSel.value = String(emp.id);
            } else {
              empSel.value = '';
            }
          });
        });
      }

      // Для возврата по конкретному серийному номеру (со страницы «Выданное»)
      if (type === 'return' && preset.serial_ids) {
        // серийный блок заполнится через refreshSerialBlock; предустановим выбор после загрузки
        var check = setInterval(function () {
          var sel = el.querySelector('#op-serials');
          if (sel && sel.tagName === 'SELECT') {
            clearInterval(check);
            Array.prototype.forEach.call(sel.options, function (o) {
              if (preset.serial_ids.indexOf(+o.value) >= 0) o.selected = true;
            });
            sel.dispatchEvent(new Event('change'));
          }
        }, 60);
        setTimeout(function () { clearInterval(check); }, 3000);
      }
    });
  }

  function submitOp(ctx, type) {
    var el = ctx.modal;
    var v = function (id) { var n = el.querySelector('#' + id); return n ? n.value.trim() : ''; };

    var input = {
      type: type,
      product_id: +v('op-product'),
      date: v('op-date'),
      comment: v('op-comment')
    };
    var errors = [];

    if (!input.product_id) errors.push('Выберите товар.');
    if (!input.date || !UI.isValidISODate(input.date)) errors.push('Укажите корректную дату.');

    if (type === 'in') {
      input.supplier = v('op-supplier');
      input.invoice_no = v('op-invoice');
      var ta = el.querySelector('#op-serials');
      if (ta && ta.tagName === 'TEXTAREA') input.serials = ta.value.split(/\r?\n/);
      else input.qty = v('op-qty');
    }
    if (type === 'out') {
      input.employee_id = v('op-employee');
      input.basis = v('op-basis');
      if (!input.employee_id || input.employee_id === '__new__') errors.push('Выберите получателя.');
      collectQtyOrSerials(el, input);
    }
    if (type === 'writeoff') {
      input.reason = v('op-reason');
      collectQtyOrSerials(el, input);
    }
    if (type === 'return') {
      input.employee_id = v('op-employee');
      collectQtyOrSerials(el, input);
    }
    if (type === 'adjust') {
      input.new_qty = v('op-newqty');
      if (!input.comment) errors.push('Для корректировки обязателен комментарий.');
    }

    if (errors.length) { UI.showFormErrors(el, errors); return; }

    applyOperation(input).then(function () {
      UI.toast('Операция «' + TYPES[type].label + '» проведена.', 'success');
      ctx.close();
      // Обновляем кэш остатков и таблицу (если страница журнала открыта)
      DB.getAll('products').then(function (rows) {
        productsCache = rows.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
        if (container) renderTable();
      });
    }).catch(function (err) {
      UI.showFormErrors(el, [err && err.message ? err.message : String(err)]);
    });
  }

  function collectQtyOrSerials(el, input) {
    var sel = el.querySelector('#op-serials');
    if (sel && sel.tagName === 'SELECT') {
      input.serial_ids = Array.prototype.map.call(sel.selectedOptions, function (o) { return +o.value; });
    } else {
      input.qty = el.querySelector('#op-qty') ? el.querySelector('#op-qty').value : '';
    }
  }

  /* ================================ Экспорт ================================ */

  var JOURNAL_HEADERS = ['id', 'date', 'type', 'sku', 'product', 'qty', 'delta', 'supplier', 'invoice_no', 'employee', 'reason', 'basis', 'serials', 'comment'];

  function opsToRows(ops) {
    return ops.map(function (o) {
      return [o.id, o.date, (TYPES[o.type] || {}).label || o.type, o.product_sku, o.product_name,
        o.qty, o.delta, o.supplier || '', o.invoice_no || '', o.employee_name || '',
        o.reason || '', o.basis || '', (o.serials || []).join(', '), o.comment || ''];
    });
  }

  function exportJournal() {
    DB.getAll('operations').then(function (ops) {
      var rows = filteredOps(ops);
      CSV.download(CSV.filename('operations'), JOURNAL_HEADERS, opsToRows(rows));
      UI.toast('Экспортировано операций: ' + rows.length + ' (с учётом фильтров).', 'success');
    });
  }

  return {
    TYPES: TYPES,
    WRITEOFF_REASONS: WRITEOFF_REASONS,
    applyOperation: applyOperation,
    deleteOperation: deleteOperation,
    confirmDelete: confirmDelete,
    renderPage: renderPage,
    openOpForm: openOpForm,
    opsToRows: opsToRows,
    JOURNAL_HEADERS: JOURNAL_HEADERS
  };
})();
