/* ==========================================================================
 * products.js — справочник номенклатуры: таблица с поиском, фильтром,
 * сортировкой и пагинацией; CRUD; импорт/экспорт CSV.
 * Пространство имён: AG.Products
 * ========================================================================== */
window.AG = window.AG || {};

AG.Products = (function () {
  'use strict';

  var CATEGORIES = ['Оборудование', 'Расходники', 'Комплектующие', 'ПО/Лицензии'];
  var UNITS = ['шт.', 'компл.', 'уп.'];
  // Метки состояния товара (множественный выбор)
  var TAGS = ['новое', 'б/у', 'сломана'];
  var TAG_CLASSES = { 'новое': 'tag-new', 'б/у': 'tag-used', 'сломана': 'tag-broken' };

  var UI = AG.UI, DB = AG.DB, CSV = AG.CSV;

  // Состояние страницы (сохраняется при переходах между разделами)
  var state = {
    search: '',
    category: '',
    tag: '',
    lowOnly: false,
    sortKey: 'name',
    sortDir: 1,
    page: 1,
    pageSize: 25
  };

  var all = [];       // кэш всех товаров
  var container = null;

  /* ------------------------------ Страница ------------------------------ */

  function renderPage(el) {
    container = el;
    container.innerHTML =
      '<div class="page-header"><h2>Номенклатура</h2>' +
        '<div class="page-actions">' +
          '<button class="btn btn-primary" id="prod-add">+ Добавить товар</button>' +
          '<button class="btn btn-secondary" id="prod-import">Импорт номенклатуры</button>' +
          '<button class="btn btn-secondary" id="prod-import-stock">Импорт остатков</button>' +
          '<button class="btn btn-secondary" id="prod-export">Экспорт CSV</button>' +
        '</div>' +
      '</div>' +
      '<div class="toolbar">' +
        '<input type="search" id="prod-search" placeholder="Поиск: наименование, артикул, производитель" value="' + UI.esc(state.search) + '">' +
        '<select id="prod-cat"><option value="">Все категории</option>' +
          CATEGORIES.map(function (c) { return '<option' + (state.category === c ? ' selected' : '') + '>' + UI.esc(c) + '</option>'; }).join('') +
        '</select>' +
        '<select id="prod-tag"><option value="">Все метки</option>' +
          TAGS.map(function (t) { return '<option' + (state.tag === t ? ' selected' : '') + '>' + UI.esc(t) + '</option>'; }).join('') +
        '</select>' +
        '<label class="check"><input type="checkbox" id="prod-low"' + (state.lowOnly ? ' checked' : '') + '> только ниже минимума</label>' +
        '<span class="spacer"></span>' +
        '<label>Строк на странице: <select id="prod-size">' +
          [25, 50, 100].map(function (n) { return '<option' + (state.pageSize === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
        '</select></label>' +
      '</div>' +
      '<div class="table-wrap"><table class="table" id="prod-table"></table></div>' +
      '<div class="pager" id="prod-pager"></div>';

    // Обработчики панели инструментов
    container.querySelector('#prod-search').addEventListener('input', UI.debounce(function (e) {
      state.search = e.target.value; state.page = 1; renderTable();
    }, 200));
    container.querySelector('#prod-cat').addEventListener('change', function (e) {
      state.category = e.target.value; state.page = 1; renderTable();
    });
    container.querySelector('#prod-tag').addEventListener('change', function (e) {
      state.tag = e.target.value; state.page = 1; renderTable();
    });
    container.querySelector('#prod-low').addEventListener('change', function (e) {
      state.lowOnly = e.target.checked; state.page = 1; renderTable();
    });
    container.querySelector('#prod-size').addEventListener('change', function (e) {
      state.pageSize = parseInt(e.target.value, 10); state.page = 1; renderTable();
    });

    container.querySelector('#prod-add').addEventListener('click', function () { openForm(null); });
    container.querySelector('#prod-export').addEventListener('click', exportProducts);
    container.querySelector('#prod-import').addEventListener('click', openImportProducts);
    container.querySelector('#prod-import-stock').addEventListener('click', openImportStock);

    reload();
  }

  function reload() {
    return DB.getAll('products').then(function (rows) {
      all = rows;
      // Страница может быть не открыта (например, вызов из FAB в шапке)
      if (container) renderTable();
    });
  }

  /* --------------------- Фильтрация, сортировка, пейджер --------------------- */

  function isLow(p) { return (+p.quantity || 0) <= (+p.min_stock || 0); }

  function filtered() {
    var q = state.search.trim().toLowerCase();
    var rows = all.filter(function (p) {
      if (state.category && p.category !== state.category) return false;
      if (state.tag && (p.tags || []).indexOf(state.tag) < 0) return false;
      if (state.lowOnly && !isLow(p)) return false;
      if (q) {
        var hay = (p.name + ' ' + p.sku + ' ' + (p.manufacturer || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var k = state.sortKey, dir = state.sortDir;
    rows.sort(function (a, b) {
      var va = a[k], vb = b[k];
      if (k === 'quantity' || k === 'min_stock') {
        va = +va || 0; vb = +vb || 0;
        return (va - vb) * dir;
      }
      va = (va == null ? '' : String(va)).toLowerCase();
      vb = (vb == null ? '' : String(vb)).toLowerCase();
      return va.localeCompare(vb, 'ru') * dir;
    });
    return rows;
  }

  function thHtml(key, label) {
    var arrow = '';
    if (state.sortKey === key) arrow = '<span class="sort-arrow">' + (state.sortDir > 0 ? '▲' : '▼') + '</span>';
    return '<th class="sortable" data-sort="' + key + '">' + label + arrow + '</th>';
  }

  function renderTable() {
    var rows = filtered();
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    var from = (state.page - 1) * state.pageSize;
    var slice = rows.slice(from, from + state.pageSize);

    var table = container.querySelector('#prod-table');
    table.innerHTML =
      '<thead><tr>' +
        thHtml('sku', 'Артикул') + thHtml('name', 'Наименование') + thHtml('category', 'Категория') +
        thHtml('manufacturer', 'Производитель') + thHtml('unit', 'Ед.') +
        thHtml('quantity', 'Остаток') + thHtml('min_stock', 'Мин.') +
        thHtml('warranty_until', 'Гарантия') + '<th>Сер. учёт</th><th>Метки</th><th style="width:120px">Действия</th>' +
      '</tr></thead>' +
      '<tbody>' +
        (slice.length ? slice.map(rowHtml).join('') :
          '<tr><td colspan="11"><div class="empty">Ничего не найдено. Измените фильтры или добавьте товар.</div></td></tr>') +
      '</tbody>';

    // Сортировка по клику на заголовок
    table.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-sort');
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else { state.sortKey = k; state.sortDir = 1; }
        renderTable();
      });
    });

    // Кнопки строк
    table.querySelectorAll('tbody tr[data-id]').forEach(function (tr) {
      var id = +tr.getAttribute('data-id');
      tr.querySelector('[data-act="edit"]').addEventListener('click', function () {
        openForm(all.find(function (p) { return p.id === id; }));
      });
      tr.querySelector('[data-act="del"]').addEventListener('click', function () {
        deleteProduct(all.find(function (p) { return p.id === id; }));
      });
    });

    renderPager(total, from, slice.length, pages);
  }

  /** Бейджи меток товара. */
  function tagsHtml(tags) {
    tags = tags || [];
    if (!tags.length) return '—';
    return tags.map(function (t) {
      return '<span class="tag ' + (TAG_CLASSES[t] || 'tag-muted') + '">' + UI.esc(t) + '</span>';
    }).join(' ');
  }

  function rowHtml(p) {
    var low = isLow(p);
    return '<tr class="' + (low ? 'row-low' : '') + '" data-id="' + p.id + '">' +
      '<td class="nowrap">' + UI.esc(p.sku) + '</td>' +
      '<td><span title="' + UI.esc(p.comment || '') + '">' + UI.esc(p.name) + '</span>' +
        (p.model ? ' <span class="muted">' + UI.esc(p.model) + '</span>' : '') + '</td>' +
      '<td>' + UI.esc(p.category) + '</td>' +
      '<td>' + UI.esc(p.manufacturer || '—') + '</td>' +
      '<td>' + UI.esc(p.unit) + '</td>' +
      '<td class="num"><b>' + (+p.quantity || 0) + '</b>' +
        (low ? ' <span class="badge badge-warn">ниже мин.</span>' : '') + '</td>' +
      '<td class="num">' + (+p.min_stock || 0) + '</td>' +
      '<td class="nowrap">' + UI.fmtDate(p.warranty_until) + '</td>' +
      '<td>' + (p.serial_tracking ? 'да' : 'нет') + '</td>' +
      '<td>' + tagsHtml(p.tags) + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-small btn-secondary" data-act="edit">Изм.</button> ' +
        '<button class="btn btn-small btn-outline-danger" data-act="del">Удал.</button>' +
      '</td></tr>';
  }

  function renderPager(total, from, shown, pages) {
    var pager = container.querySelector('#prod-pager');
    var html = '<span class="pager-info">Показано ' + (total ? from + 1 : 0) + '–' + (from + shown) + ' из ' + total + '</span>';
    html += '<button data-p="prev"' + (state.page <= 1 ? ' disabled' : '') + '>‹</button>';

    var nums = [];
    for (var p = 1; p <= pages; p++) {
      if (p === 1 || p === pages || Math.abs(p - state.page) <= 2) nums.push(p);
    }
    var prev = 0;
    nums.forEach(function (p) {
      if (p - prev > 1) html += '<span class="muted">…</span>';
      html += '<button data-p="' + p + '"' + (p === state.page ? ' class="cur"' : '') + '>' + p + '</button>';
      prev = p;
    });

    html += '<button data-p="next"' + (state.page >= pages ? ' disabled' : '') + '>›</button>';
    pager.innerHTML = html;

    pager.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-p');
        if (v === 'prev') state.page--;
        else if (v === 'next') state.page++;
        else state.page = parseInt(v, 10);
        renderTable();
      });
    });
  }

  /* ----------------------------- Форма товара ----------------------------- */

  function openForm(product) {
    var isEdit = !!product;
    var p = product || {
      sku: '', name: '', category: CATEGORIES[0], manufacturer: '', model: '',
      unit: 'шт.', quantity: 0, min_stock: 0, serial_tracking: 0, warranty_until: '', comment: '', tags: []
    };

    var body =
      '<div class="form-grid">' +
        '<div class="form-errors"></div>' +
        field('f-sku', 'Артикул (SKU) <span class="req">*</span>', '<input id="f-sku" value="' + UI.esc(p.sku) + '"' + (isEdit ? ' disabled' : '') + ' maxlength="64">') +
        field('f-name', 'Наименование <span class="req">*</span>', '<input id="f-name" value="' + UI.esc(p.name) + '" maxlength="200">') +
        field('f-category', 'Категория <span class="req">*</span>',
          '<select id="f-category">' + CATEGORIES.map(function (c) {
            return '<option' + (p.category === c ? ' selected' : '') + '>' + c + '</option>';
          }).join('') + '</select>') +
        field('f-unit', 'Единица измерения <span class="req">*</span>',
          '<select id="f-unit">' + UNITS.map(function (u) {
            return '<option' + (p.unit === u ? ' selected' : '') + '>' + u + '</option>';
          }).join('') + '</select>') +
        field('f-manufacturer', 'Производитель', '<input id="f-manufacturer" value="' + UI.esc(p.manufacturer || '') + '" maxlength="120">') +
        field('f-model', 'Модель', '<input id="f-model" value="' + UI.esc(p.model || '') + '" maxlength="120">') +
        field('f-quantity', 'Остаток' + (isEdit ? ' (меняется операциями)' : ''),
          '<input id="f-quantity" type="number" min="0" step="1" value="' + (+p.quantity || 0) + '"' + (isEdit ? ' disabled' : '') + '>',
          isEdit ? '' : 'При создании с остатком &gt; 0 будет сформирован приход «Начальный остаток».') +
        field('f-min', 'Минимальный остаток', '<input id="f-min" type="number" min="0" step="1" value="' + (+p.min_stock || 0) + '">') +
        field('f-warranty', 'Гарантия до', '<input id="f-warranty" type="date" value="' + UI.esc(p.warranty_until || '') + '">') +
        '<div class="form-field"><label>Серийный учёт</label>' +
          '<label class="form-check" style="padding-top:6px"><input type="checkbox" id="f-serial"' + (p.serial_tracking ? ' checked' : '') + (isEdit ? ' disabled' : '') + '> вести учёт по серийным номерам</label>' +
          (isEdit ? '<div class="hint">Флаг задаётся при создании карточки.</div>' : '') +
        '</div>' +
        '<div class="form-field"><label>Метки</label>' +
          '<div style="padding-top:6px;display:flex;gap:14px;flex-wrap:wrap">' +
          TAGS.map(function (t) {
            var checked = (p.tags || []).indexOf(t) >= 0;
            return '<label class="check"><input type="checkbox" class="f-tag" value="' + UI.esc(t) + '"' + (checked ? ' checked' : '') + '> ' + UI.esc(t) + '</label>';
          }).join('') +
          '</div>' +
        '</div>' +
        field('f-comment', 'Комментарий', '<textarea id="f-comment" rows="2" maxlength="500">' + UI.esc(p.comment || '') + '</textarea>', '', true) +
      '</div>';

    function field(id, label, inputHtml, hint, full) {
      return '<div class="form-field' + (full ? ' full' : '') + '"><label for="' + id + '">' + label + '</label>' +
        inputHtml + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
    }

    var m = UI.modal({
      title: isEdit ? 'Редактирование товара' : 'Новый товар',
      body: body,
      buttons: [
        { label: 'Отмена', class: 'btn-secondary', onClick: function () { return true; } },
        {
          label: 'Сохранить', class: 'btn-primary',
          onClick: function (ctx) {
            var errors = [];
            var v = function (id) { return ctx.modal.querySelector('#' + id).value.trim(); };
            var sku = v('f-sku'), name = v('f-name');
            var category = v('f-category'), unit = v('f-unit');
            var manufacturer = v('f-manufacturer'), model = v('f-model');
            var qty = UI.parseIntStrict(isEdit ? String(p.quantity) : v('f-quantity'));
            var minStock = UI.parseIntStrict(v('f-min'));
            var serial = isEdit ? (p.serial_tracking ? 1 : 0) : (ctx.modal.querySelector('#f-serial').checked ? 1 : 0);
            var warranty = v('f-warranty');
            var comment = v('f-comment');
            var tags = Array.prototype.map.call(ctx.modal.querySelectorAll('.f-tag:checked'), function (cb) { return cb.value; });

            if (!sku) errors.push('Поле «Артикул (SKU)» обязательно.');
            if (!name) errors.push('Поле «Наименование» обязательно.');
            if (CATEGORIES.indexOf(category) < 0) errors.push('Недопустимая категория.');
            if (UNITS.indexOf(unit) < 0) errors.push('Недопустимая единица измерения.');
            if (qty === null || qty < 0) errors.push('Остаток должен быть целым числом ≥ 0.');
            if (minStock === null || minStock < 0) errors.push('Минимальный остаток должен быть целым числом ≥ 0.');
            if (warranty && !UI.isValidISODate(warranty)) errors.push('Некорректная дата гарантии.');
            if (serial && !isEdit && qty > 0) errors.push('Для товара с серийным учётом начальный остаток формируется приходной операцией с серийными номерами — укажите остаток 0.');

            var finish = function () {
              if (!isEdit) {
                // Проверка уникальности SKU
                return DB.getByIndex('products', 'sku', sku).then(function (dup) {
                  if (dup.length) { UI.showFormErrors(ctx.modal, ['Товар с артикулом «' + sku + '» уже существует.']); return; }
                  var rec = {
                    sku: sku, name: name, category: category, manufacturer: manufacturer, model: model,
                    unit: unit, quantity: 0, min_stock: minStock, serial_tracking: serial,
                    warranty_until: warranty || '', comment: comment, tags: tags, created_at: Date.now()
                  };
                  return DB.add('products', rec).then(function (newId) {
                    if (qty > 0) {
                      return AG.Operations.applyOperation({
                        type: 'in', product_id: newId, qty: qty, date: UI.todayLocal(),
                        supplier: '', invoice_no: '', comment: 'Начальный остаток при создании карточки'
                      });
                    }
                  }).then(function () {
                    UI.toast('Товар «' + name + '» добавлен.', 'success');
                    ctx.close();
                    reload();
                  });
                });
              }
              // Редактирование (остаток и флаг серийного учёта не меняются)
              var rec = product;
              rec.name = name; rec.category = category; rec.unit = unit;
              rec.manufacturer = manufacturer; rec.model = model;
              rec.min_stock = minStock; rec.warranty_until = warranty || ''; rec.comment = comment;
              rec.tags = tags;
              return DB.put('products', rec).then(function () {
                UI.toast('Изменения сохранены.', 'success');
                ctx.close();
                reload();
              });
            };

            if (errors.length) { UI.showFormErrors(ctx.modal, errors); return; }
            finish().catch(function (err) {
              UI.showFormErrors(ctx.modal, [err && err.message ? err.message : String(err)]);
            });
          }
        }
      ]
    });
    return m;
  }

  /* ---------------------------- Удаление товара --------------------------- */

  function deleteProduct(p) {
    if (!p) return;
    DB.getByIndex('serial_items', 'product_id', p.id).then(function (serials) {
      var issued = serials.filter(function (s) { return s.status === 'issued'; });
      if (issued.length) {
        UI.toast('Нельзя удалить товар: по нему числится выданное оборудование (' + issued.length + ' серийных номеров). Сначала оформите возврат.', 'error', 6500);
        return;
      }
      UI.confirm(
        'Удалить товар <b>«' + UI.esc(p.name) + '»</b> (' + UI.esc(p.sku) + ')?<br>' +
        '<span class="muted">Записи журнала операций сохранятся (с наименованием товара).' +
        (serials.length ? ' Серийные номера (' + serials.length + ' шт.) будут удалены.' : '') + '</span>',
        { title: 'Удаление товара', danger: true, okLabel: 'Удалить' }
      ).then(function (ok) {
        if (!ok) return;
        var chain = Promise.resolve();
        serials.forEach(function (s) {
          chain = chain.then(function () { return DB.del('serial_items', s.id); });
        });
        chain.then(function () { return DB.del('products', p.id); })
          .then(function () { UI.toast('Товар удалён.', 'success'); reload(); })
          .catch(function (err) { UI.toast('Ошибка удаления: ' + err.message, 'error'); });
      });
    });
  }

  /* ------------------------------- Экспорт -------------------------------- */

  var EXPORT_HEADERS = ['sku', 'name', 'category', 'manufacturer', 'model', 'unit', 'quantity', 'min_stock', 'serial_tracking', 'warranty_until', 'comment', 'tags'];

  function productToRow(p) {
    return [p.sku, p.name, p.category, p.manufacturer || '', p.model || '', p.unit,
      +p.quantity || 0, +p.min_stock || 0, p.serial_tracking ? 1 : 0, p.warranty_until || '', p.comment || '',
      (p.tags || []).join(',')];
  }

  function exportProducts() {
    DB.getAll('products').then(function (rows) {
      rows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'ru'); });
      CSV.download(CSV.filename('nomenklatura'), EXPORT_HEADERS, rows.map(productToRow));
      UI.toast('Экспортировано позиций: ' + rows.length + '.', 'success');
    });
  }

  /* --------------------- Импорт номенклатуры из CSV ----------------------- */

  function parseSerialFlag(s) {
    s = String(s == null ? '' : s).trim().toLowerCase();
    if (s === '' || s === '0' || s === 'нет' || s === 'false' || s === 'no') return 0;
    if (s === '1' || s === 'да' || s === 'true' || s === 'yes') return 1;
    return -1;
  }

  /** Разбор строки меток из CSV: «новое,б/у» → ['новое','б/у']; ошибка на неизвестной метке. */
  function parseTags(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return [];
    var parts = s.split(/[,|]/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var found = null;
      for (var j = 0; j < TAGS.length; j++) {
        if (TAGS[j].toLowerCase() === parts[i]) { found = TAGS[j]; break; }
      }
      if (found === null) return null; // сигнал ошибки
      parts[i] = found;
    }
    // убираем дубли
    return parts.filter(function (t, i) { return parts.indexOf(t) === i; });
  }

  function openImportProducts() {
    var bySku = null;
    DB.getAll('products').then(function (existing) {
      bySku = new Map(existing.map(function (p) { return [p.sku, p]; }));
      UI.importWizard({
        title: 'Импорт номенклатуры из CSV',
        templateKind: 'products',
        requiredFields: ['sku', 'name', 'category', 'unit', 'quantity'],
        note: 'Обязательные колонки: <b>sku, name, category, unit, quantity</b>. Необязательные: manufacturer, model, min_stock, serial_tracking (1/0), warranty_until (ГГГГ-ММ-ДД), comment, tags (метки через запятую: ' + TAGS.join(', ') + '). Записи с существующим sku будут обновлены.',
        mapRow: function (arr, map) {
          var g = function (f) { return map[f] !== undefined ? String(arr[map[f]] == null ? '' : arr[map[f]]).trim() : ''; };
          return {
            sku: g('sku'), name: g('name'), category: g('category'), manufacturer: g('manufacturer'),
            model: g('model'), unit: g('unit'), quantity: g('quantity'), min_stock: g('min_stock'),
            serial_tracking: g('serial_tracking'), warranty_until: g('warranty_until'), comment: g('comment'),
            tags: g('tags')
          };
        },
        validate: function (o) {
          if (!o.sku) return 'пустой sku';
          if (!o.name) return 'пустое наименование';
          if (CATEGORIES.indexOf(o.category) < 0) return 'недопустимая категория «' + o.category + '» (допустимы: ' + CATEGORIES.join(', ') + ')';
          if (UNITS.indexOf(o.unit) < 0) return 'недопустимая единица измерения «' + o.unit + '» (допустимы: ' + UNITS.join(', ') + ')';
          var q = UI.parseIntStrict(o.quantity);
          if (q === null || q < 0) return 'некорректное количество «' + o.quantity + '»';
          if (o.min_stock !== '') {
            var ms = UI.parseIntStrict(o.min_stock);
            if (ms === null || ms < 0) return 'некорректный минимальный остаток «' + o.min_stock + '»';
          }
          if (parseSerialFlag(o.serial_tracking) < 0) return 'некорректный флаг serial_tracking «' + o.serial_tracking + '» (используйте 1/0)';
          if (o.warranty_until !== '' && UI.normalizeDate(o.warranty_until) === null) return 'некорректная дата гарантии «' + o.warranty_until + '»';
          if (parseTags(o.tags) === null) return 'неизвестная метка в «' + o.tags + '» (допустимы: ' + TAGS.join(', ') + ')';
          return null;
        },
        apply: function (o) {
          var qty = UI.parseIntStrict(o.quantity) || 0;
          var minStock = o.min_stock === '' ? 0 : UI.parseIntStrict(o.min_stock);
          var serial = parseSerialFlag(o.serial_tracking);
          var warranty = o.warranty_until === '' ? '' : UI.normalizeDate(o.warranty_until);
          var tags = parseTags(o.tags) || [];
          var exist = bySku.get(o.sku);

          if (!exist) {
            var rec = {
              sku: o.sku, name: o.name, category: o.category, manufacturer: o.manufacturer, model: o.model,
              unit: o.unit, quantity: 0, min_stock: minStock, serial_tracking: serial,
              warranty_until: warranty, comment: o.comment, tags: tags, created_at: Date.now()
            };
            return DB.add('products', rec).then(function (newId) {
              rec.id = newId;
              bySku.set(o.sku, rec);
              // Начальный остаток — только для товаров без серийного учёта
              if (qty > 0 && !serial) {
                return AG.Operations.applyOperation({
                  type: 'in', product_id: newId, qty: qty, date: UI.todayLocal(),
                  supplier: '', invoice_no: '', comment: 'Импорт CSV: начальный остаток'
                });
              }
            }).then(function () { return 'created'; });
          }

          // Обновление существующей карточки
          var p = exist;
          p.name = o.name; p.category = o.category; p.unit = o.unit;
          p.manufacturer = o.manufacturer; p.model = o.model;
          p.min_stock = minStock; p.warranty_until = warranty; p.comment = o.comment;
          p.tags = tags;
          var needQty = qty;
          var chain = DB.put('products', p);
          // Разницу остатков проводим корректировкой, чтобы сохранить журнал
          if (!p.serial_tracking && needQty !== (+p.quantity || 0)) {
            chain = chain.then(function () {
              return AG.Operations.applyOperation({
                type: 'adjust', product_id: p.id, new_qty: needQty, date: UI.todayLocal(),
                comment: 'Импорт CSV: обновление остатка'
              });
            });
          }
          return chain.then(function () { return 'updated'; });
        },
        onDone: reload
      });
    });
  }

  /* --------------------- Импорт начальных остатков ------------------------ */

  function openImportStock() {
    var bySku = null;
    DB.getAll('products').then(function (existing) {
      bySku = new Map(existing.map(function (p) { return [p.sku, p]; }));
      UI.importWizard({
        title: 'Импорт начальных остатков',
        templateKind: 'initial_stock',
        requiredFields: ['sku', 'quantity'],
        note: 'Формат: <b>sku;quantity</b>. Для каждой строки создаётся приходная операция. Товары с серийным учётом пропускаются (используйте «Операции → Приход» с серийными номерами).',
        mapRow: function (arr, map) {
          var g = function (f) { return map[f] !== undefined ? String(arr[map[f]] == null ? '' : arr[map[f]]).trim() : ''; };
          return { sku: g('sku'), quantity: g('quantity') };
        },
        validate: function (o) {
          if (!o.sku) return 'пустой sku';
          var q = UI.parseIntStrict(o.quantity);
          if (q === null || q < 0) return 'некорректное количество «' + o.quantity + '»';
          if (!bySku.has(o.sku)) return 'товар с sku «' + o.sku + '» не найден в справочнике';
          if (bySku.get(o.sku).serial_tracking) return 'товар «' + o.sku + '» с серийным учётом — остаток заводится приходом с серийными номерами';
          return null;
        },
        apply: function (o) {
          var p = bySku.get(o.sku);
          var qty = UI.parseIntStrict(o.quantity);
          if (qty === 0) return Promise.resolve('updated');
          return AG.Operations.applyOperation({
            type: 'in', product_id: p.id, qty: qty, date: UI.todayLocal(),
            supplier: '', invoice_no: '', comment: 'Импорт начальных остатков'
          }).then(function () { return 'updated'; });
        },
        onDone: reload
      });
    });
  }

  return {
    CATEGORIES: CATEGORIES,
    UNITS: UNITS,
    TAGS: TAGS,
    renderPage: renderPage,
    isLow: isLow,
    exportProducts: exportProducts,
    openCreate: function () { openForm(null); },
    setLowFilter: function (v) { state.lowOnly = !!v; state.page = 1; }
  };
})();
