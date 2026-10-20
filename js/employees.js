/* ==========================================================================
 * employees.js — справочник сотрудников: CRUD, импорт/экспорт CSV,
 * быстрое добавление из формы выдачи.
 * Пространство имён: AG.Employees
 * ========================================================================== */
window.AG = window.AG || {};

AG.Employees = (function () {
  'use strict';

  var UI = AG.UI, DB = AG.DB, CSV = AG.CSV;

  var container = null;
  var state = { search: '' };
  var all = [];

  function renderPage(el) {
    container = el;
    container.innerHTML =
      '<div class="page-header"><h2>Сотрудники</h2>' +
        '<div class="page-actions">' +
          '<button class="btn btn-primary" id="emp-add">+ Добавить сотрудника</button>' +
          '<button class="btn btn-secondary" id="emp-import">Импорт CSV</button>' +
          '<button class="btn btn-secondary" id="emp-export">Экспорт CSV</button>' +
        '</div>' +
      '</div>' +
      '<div class="toolbar">' +
        '<input type="search" id="emp-search" placeholder="Поиск: ФИО, должность, подразделение" value="' + UI.esc(state.search) + '">' +
      '</div>' +
      '<div class="table-wrap"><table class="table" id="emp-table"></table></div>';

    container.querySelector('#emp-search').addEventListener('input', UI.debounce(function (e) {
      state.search = e.target.value; renderTable();
    }, 200));
    container.querySelector('#emp-add').addEventListener('click', function () { openForm(null); });
    container.querySelector('#emp-import').addEventListener('click', openImport);
    container.querySelector('#emp-export').addEventListener('click', exportEmployees);

    reload();
  }

  function reload() {
    return DB.getAll('employees').then(function (rows) {
      all = rows;
      renderTable();
    });
  }

  function renderTable() {
    var q = state.search.trim().toLowerCase();
    var rows = all.filter(function (e) {
      if (!q) return true;
      return (e.full_name + ' ' + (e.position || '') + ' ' + (e.department || '')).toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) { return a.full_name.localeCompare(b.full_name, 'ru'); });

    var table = container.querySelector('#emp-table');
    table.innerHTML =
      '<thead><tr><th>ФИО</th><th>Должность</th><th>Подразделение</th><th>Контакты</th><th style="width:120px">Действия</th></tr></thead>' +
      '<tbody>' +
      (rows.length ? rows.map(rowHtml).join('') :
        '<tr><td colspan="5"><div class="empty">Сотрудники не найдены.</div></td></tr>') +
      '</tbody>';

    table.querySelectorAll('tr[data-id]').forEach(function (tr) {
      var id = +tr.getAttribute('data-id');
      tr.querySelector('[data-act="edit"]').addEventListener('click', function () {
        openForm(all.find(function (e) { return e.id === id; }));
      });
      tr.querySelector('[data-act="del"]').addEventListener('click', function () {
        deleteEmployee(all.find(function (e) { return e.id === id; }));
      });
    });
  }

  function rowHtml(e) {
    return '<tr data-id="' + e.id + '">' +
      '<td><b>' + UI.esc(e.full_name) + '</b></td>' +
      '<td>' + UI.esc(e.position || '—') + '</td>' +
      '<td>' + UI.esc(e.department || '—') + '</td>' +
      '<td>' + UI.esc(e.contacts || '—') + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-small btn-secondary" data-act="edit">Изм.</button> ' +
        '<button class="btn btn-small btn-outline-danger" data-act="del">Удал.</button>' +
      '</td></tr>';
  }

  /* --------------------------------- Форма -------------------------------- */

  function formHtml(e) {
    return '<div class="form-grid">' +
      '<div class="form-errors"></div>' +
      '<div class="form-field full"><label>ФИО <span class="req">*</span></label>' +
        '<input id="e-name" value="' + UI.esc(e.full_name || '') + '" maxlength="150"></div>' +
      '<div class="form-field"><label>Должность</label><input id="e-position" value="' + UI.esc(e.position || '') + '" maxlength="120"></div>' +
      '<div class="form-field"><label>Подразделение</label><input id="e-department" value="' + UI.esc(e.department || '') + '" maxlength="120"></div>' +
      '<div class="form-field full"><label>Контакты</label><input id="e-contacts" value="' + UI.esc(e.contacts || '') + '" maxlength="200"></div>' +
    '</div>';
  }

  function readForm(modal) {
    return {
      full_name: modal.querySelector('#e-name').value.trim(),
      position: modal.querySelector('#e-position').value.trim(),
      department: modal.querySelector('#e-department').value.trim(),
      contacts: modal.querySelector('#e-contacts').value.trim()
    };
  }

  function openForm(emp) {
    var isEdit = !!emp;
    UI.modal({
      title: isEdit ? 'Редактирование сотрудника' : 'Новый сотрудник',
      body: formHtml(emp || {}),
      buttons: [
        { label: 'Отмена', class: 'btn-secondary', onClick: function () { return true; } },
        {
          label: 'Сохранить', class: 'btn-primary',
          onClick: function (ctx) {
            var data = readForm(ctx.modal);
            if (!data.full_name) { UI.showFormErrors(ctx.modal, ['Поле «ФИО» обязательно.']); return; }
            var rec = isEdit ? emp : { created_at: Date.now() };
            rec.full_name = data.full_name; rec.position = data.position;
            rec.department = data.department; rec.contacts = data.contacts;
            DB.put('employees', rec).then(function () {
              UI.toast(isEdit ? 'Изменения сохранены.' : 'Сотрудник добавлен.', 'success');
              ctx.close();
              if (container) reload();
            }).catch(function (err) {
              UI.showFormErrors(ctx.modal, [err.message]);
            });
          }
        }
      ]
    });
  }

  function deleteEmployee(emp) {
    if (!emp) return;
    DB.getByIndex('serial_items', 'employee_id', emp.id).then(function (items) {
      var issued = items.filter(function (it) { return it.status === 'issued'; });
      if (issued.length) {
        UI.toast('Нельзя удалить сотрудника: за ним числится выданное оборудование (' + issued.length + ' шт.). Сначала оформите возврат.', 'error', 6500);
        return;
      }
      UI.confirm('Удалить сотрудника <b>«' + UI.esc(emp.full_name) + '»</b>?<br><span class="muted">Записи журнала операций сохранятся с ФИО сотрудника.</span>',
        { title: 'Удаление сотрудника', danger: true, okLabel: 'Удалить' }
      ).then(function (ok) {
        if (!ok) return;
        DB.del('employees', emp.id)
          .then(function () { UI.toast('Сотрудник удалён.', 'success'); reload(); })
          .catch(function (err) { UI.toast('Ошибка удаления: ' + err.message, 'error'); });
      });
    });
  }

  /* ------------- Быстрое добавление (из формы выдачи операции) ------------ */

  /** Возвращает Promise<employee|null>. */
  function quickAddModal() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      UI.modal({
        title: 'Новый сотрудник',
        body: formHtml({}),
        onClose: function () { finish(null); },
        buttons: [
          { label: 'Отмена', class: 'btn-secondary', onClick: function () { return true; } },
          {
            label: 'Добавить', class: 'btn-primary',
            onClick: function (ctx) {
              var data = readForm(ctx.modal);
              if (!data.full_name) { UI.showFormErrors(ctx.modal, ['Поле «ФИО» обязательно.']); return; }
              data.created_at = Date.now();
              DB.add('employees', data).then(function (id) {
                data.id = id;
                UI.toast('Сотрудник «' + data.full_name + '» добавлен в справочник.', 'success');
                finish(data);
                ctx.close();
              }).catch(function (err) {
                UI.showFormErrors(ctx.modal, [err.message]);
              });
            }
          }
        ]
      });
    });
  }

  /* --------------------------- Импорт / экспорт --------------------------- */

  var EXPORT_HEADERS = ['full_name', 'position', 'department', 'contacts'];

  function exportEmployees() {
    DB.getAll('employees').then(function (rows) {
      rows.sort(function (a, b) { return a.full_name.localeCompare(b.full_name, 'ru'); });
      CSV.download(CSV.filename('employees'), EXPORT_HEADERS,
        rows.map(function (e) { return [e.full_name, e.position || '', e.department || '', e.contacts || '']; }));
      UI.toast('Экспортировано сотрудников: ' + rows.length + '.', 'success');
    });
  }

  function openImport() {
    var byName = null;
    DB.getAll('employees').then(function (existing) {
      byName = new Map(existing.map(function (e) { return [e.full_name.toLowerCase(), e]; }));
      UI.importWizard({
        title: 'Импорт сотрудников из CSV',
        templateKind: 'employees',
        requiredFields: ['full_name'],
        note: 'Обязательная колонка: <b>full_name</b>. Необязательные: position, department, contacts. Записи с существующим ФИО будут обновлены.',
        mapRow: function (arr, map) {
          var g = function (f) { return map[f] !== undefined ? String(arr[map[f]] == null ? '' : arr[map[f]]).trim() : ''; };
          return { full_name: g('full_name'), position: g('position'), department: g('department'), contacts: g('contacts') };
        },
        validate: function (o) {
          if (!o.full_name) return 'пустое ФИО';
          return null;
        },
        apply: function (o) {
          var exist = byName.get(o.full_name.toLowerCase());
          if (exist) {
            exist.position = o.position; exist.department = o.department; exist.contacts = o.contacts;
            return DB.put('employees', exist).then(function () { return 'updated'; });
          }
          return DB.add('employees', {
            full_name: o.full_name, position: o.position, department: o.department,
            contacts: o.contacts, created_at: Date.now()
          }).then(function (id) {
            o.id = id;
            byName.set(o.full_name.toLowerCase(), o);
            return 'created';
          });
        },
        onDone: reload
      });
    });
  }

  return {
    renderPage: renderPage,
    quickAddModal: quickAddModal,
    exportEmployees: exportEmployees
  };
})();
