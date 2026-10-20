/* ==========================================================================
 * ui.js — базовые UI-компоненты: тосты, модальные окна, подтверждения,
 * форматирование дат, мастер импорта CSV, утилиты.
 * Пространство имён: AG.UI
 * ========================================================================== */
window.AG = window.AG || {};

AG.UI = (function () {
  'use strict';

  /* ------------------------------- Утилиты ------------------------------ */

  /** Экранирование HTML для безопасной вставки пользовательских данных. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** Сегодняшняя дата в формате YYYY-MM-DD (локальная таймзона). */
  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** YYYY-MM-DD -> DD.MM.YYYY (прочие значения возвращаются как есть). */
  function fmtDate(iso) {
    if (!iso) return '—';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? m[3] + '.' + m[2] + '.' + m[1] : String(iso);
  }

  function fmtDateTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return fmtDate(d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** Строгий разбор целого числа; при неудаче — null. */
  function parseIntStrict(s) {
    s = String(s == null ? '' : s).trim().replace(/\s+/g, '');
    if (!/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  }

  /** Нормализация даты: принимает YYYY-MM-DD или DD.MM.YYYY, вернёт YYYY-MM-DD или null. */
  function normalizeDate(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return s;
    m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return null;
  }

  function isValidISODate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00');
    return !isNaN(d.getTime());
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* -------------------------------- Тосты ------------------------------- */

  function toast(message, type, ms) {
    type = type || 'info';
    ms = ms || 4200;
    var container = document.getElementById('toast-container');
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = message;
    el.title = 'Нажмите, чтобы закрыть';
    var remove = function () {
      el.classList.add('fade');
      setTimeout(function () { el.remove(); }, 320);
    };
    el.addEventListener('click', remove);
    container.appendChild(el);
    setTimeout(remove, ms);
  }

  /* ---------------------------- Модальные окна -------------------------- */

  /**
   * modal({title, body, buttons, wide, onClose})
   *  - body: строка HTML или HTMLElement;
   *  - buttons: [{label, class, onClick({close, modal})}]; если onClick
   *    ничего не вернул — окно НЕ закрывается автоматически (закрывайте сами),
   *    либо верните true/false — по возврату true окно закрывается.
   * Возвращает {el, close}.
   */
  function modal(opts) {
    var root = document.getElementById('modal-root');
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
      '<div class="modal' + (opts.wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-header"><h3>' + esc(opts.title || '') + '</h3>' +
        '<button class="modal-close" title="Закрыть" aria-label="Закрыть">&times;</button></div>' +
        '<div class="modal-body"></div>' +
        '<div class="modal-footer"></div>' +
      '</div>';

    var bodyEl = overlay.querySelector('.modal-body');
    if (typeof opts.body === 'string') bodyEl.innerHTML = opts.body;
    else if (opts.body) bodyEl.appendChild(opts.body);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (opts.onClose) opts.onClose();
    }

    var footer = overlay.querySelector('.modal-footer');
    (opts.buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn ' + (b.class || 'btn-secondary');
      btn.textContent = b.label;
      btn.addEventListener('click', function () {
        var r = b.onClick ? b.onClick({ close: close, modal: overlay, button: btn }) : true;
        if (r === true) close();
      });
      footer.appendChild(btn);
    });
    if (!(opts.buttons || []).length) footer.remove();

    overlay.querySelector('.modal-close').addEventListener('click', close);
    // Клик по затемнению закрывает только верхнее окно
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    function onKey(e) {
      if (e.key === 'Escape' && root.lastElementChild === overlay) close();
    }
    document.addEventListener('keydown', onKey, true);

    root.appendChild(overlay);
    var firstInput = overlay.querySelector('.modal-body input, .modal-body select, .modal-body textarea');
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 30);
    return { el: overlay, close: close };
  }

  /** Подтверждение. Возвращает Promise<boolean>. */
  function confirmDlg(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      modal({
        title: opts.title || 'Подтверждение',
        body: '<div style="font-size:14px;line-height:1.5">' + message + '</div>',
        onClose: function () { finish(false); },
        buttons: [
          { label: 'Отмена', class: 'btn-secondary', onClick: function () { finish(false); return true; } },
          {
            label: opts.okLabel || 'Подтвердить',
            class: opts.danger ? 'btn-danger' : 'btn-primary',
            onClick: function () { finish(true); return true; }
          }
        ]
      });
    });
  }

  /** Показать список ошибок внутри формы (div.form-errors). */
  function showFormErrors(modalEl, errors) {
    var box = modalEl.querySelector('.form-errors');
    if (!box) return;
    if (!errors || !errors.length) {
      box.classList.remove('visible');
      box.innerHTML = '';
      return;
    }
    box.innerHTML = '<b>Исправьте ошибки:</b><ul>' +
      errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>';
    box.classList.add('visible');
  }

  /* ------------------------- Мастер импорта CSV ------------------------- */

  /**
   * importWizard(opts) — единый сценарий импорта:
   *   opts.title          — заголовок окна;
   *   opts.templateKind   — ключ шаблона AG.CSV.downloadTemplate;
   *   opts.requiredFields — массив обязательных колонок (ключи mapHeaders);
   *   opts.note           — HTML-подсказка о формате;
   *   opts.mapRow(arr, headerMap) -> объект строки (синхронно);
   *   opts.validate(obj)  -> строка ошибки | null (синхронно);
   *   opts.apply(obj)     -> Promise<'created'|'updated'> (ошибка = пропуск);
   *   opts.onDone()       — вызывается после успешной загрузки.
   */
  function importWizard(opts) {
    var evalRows = [];
    var rawHeaders = [];

    var body =
      '<div class="form-grid">' +
        '<div class="form-field full">' +
          '<label>Файл CSV (UTF-8, разделитель «;» или «,» — определяется автоматически)</label>' +
          '<input type="file" id="imp-file" accept=".csv,text/csv,text/plain">' +
          '<div class="hint">' + (opts.note || '') + '</div>' +
        '</div>' +
        '<div class="form-field full">' +
          '<button type="button" class="btn btn-secondary btn-small" id="imp-template">Скачать шаблон</button>' +
        '</div>' +
        '<div class="form-errors" id="imp-fatal"></div>' +
        '<div class="form-field full" id="imp-preview-wrap" style="display:none">' +
          '<label>Предпросмотр (первые 10 строк данных)</label>' +
          '<div class="import-preview" id="imp-preview"></div>' +
          '<div class="import-summary" id="imp-summary"></div>' +
          '<div class="import-errors" id="imp-errors" style="display:none"></div>' +
        '</div>' +
      '</div>';

    var m = modal({
      title: opts.title,
      wide: true,
      body: body,
      buttons: [
        { label: 'Отмена', class: 'btn-secondary', onClick: function () { return true; } },
        {
          label: 'Загрузить валидные (0)',
          class: 'btn-primary',
          onClick: function (ctx) { doApply(ctx.button); }
        }
      ]
    });

    var el = m.el;
    var applyBtn = el.querySelectorAll('.modal-footer .btn-primary')[0];
    applyBtn.disabled = true;

    el.querySelector('#imp-template').addEventListener('click', function () {
      AG.CSV.downloadTemplate(opts.templateKind);
    });

    el.querySelector('#imp-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      AG.CSV.readFile(file).then(function (text) {
        processFile(text);
      }).catch(function (err) {
        fatal('Не удалось прочитать файл: ' + (err && err.message ? err.message : err));
      });
    });

    function fatal(msg) {
      var box = el.querySelector('#imp-fatal');
      box.innerHTML = '<b>Ошибка:</b> ' + esc(msg);
      box.classList.add('visible');
      el.querySelector('#imp-preview-wrap').style.display = 'none';
      applyBtn.disabled = true;
    }

    function processFile(text) {
      el.querySelector('#imp-fatal').classList.remove('visible');
      var rows;
      try {
        rows = AG.CSV.parse(text);
      } catch (err) {
        fatal('Файл не похож на CSV: ' + err.message);
        return;
      }
      if (rows.length < 2) {
        fatal('Файл пуст или содержит только заголовок.');
        return;
      }
      rawHeaders = rows[0];
      var headerMap = AG.CSV.mapHeaders(rawHeaders);

      var missing = (opts.requiredFields || []).filter(function (f) { return headerMap[f] === undefined; });
      if (missing.length) {
        fatal('Не найдены обязательные колонки: ' + missing.join(', ') +
          '. Заголовки файла: ' + rawHeaders.join(' | '));
        return;
      }

      // Построчная валидация (строка N — номер строки данных, начиная с 1)
      evalRows = rows.slice(1).map(function (arr, i) {
        var line = i + 1;
        var obj = null, error = null;
        try {
          obj = opts.mapRow(arr, headerMap);
          error = opts.validate(obj) || null;
        } catch (err) {
          error = err && err.message ? err.message : String(err);
        }
        return { line: line, arr: arr, obj: obj, error: error };
      });

      renderPreview();
    }

    function renderPreview() {
      var wrap = el.querySelector('#imp-preview-wrap');
      wrap.style.display = '';

      var previewRows = evalRows.slice(0, 10);
      var html = '<table><thead><tr><th>№</th>' +
        rawHeaders.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        previewRows.map(function (r) {
          var cells = r.arr.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('');
          return '<tr' + (r.error ? ' style="background:#FFEBEE"' : '') + '><td>' + r.line + '</td>' + cells + '</tr>';
        }).join('') +
        '</tbody></table>';
      el.querySelector('#imp-preview').innerHTML = html;

      var errors = evalRows.filter(function (r) { return r.error; });
      var valid = evalRows.length - errors.length;
      el.querySelector('#imp-summary').textContent =
        'Всего строк: ' + evalRows.length + '. Валидных: ' + valid + '. С ошибками: ' + errors.length + '.';

      var errBox = el.querySelector('#imp-errors');
      if (errors.length) {
        errBox.style.display = '';
        errBox.innerHTML = '<b>Ошибки (строки будут пропущены):</b><ul>' +
          errors.map(function (r) { return '<li>строка ' + r.line + ': ' + esc(r.error) + '</li>'; }).join('') +
          '</ul>';
      } else {
        errBox.style.display = 'none';
        errBox.innerHTML = '';
      }

      applyBtn.disabled = valid === 0;
      applyBtn.textContent = 'Загрузить валидные (' + valid + ')';
    }

    function doApply(btn) {
      var validRows = evalRows.filter(function (r) { return !r.error; });
      if (!validRows.length) return;
      btn.disabled = true;
      btn.textContent = 'Загрузка…';

      var created = 0, updated = 0, failed = [];
      var chain = Promise.resolve();
      validRows.forEach(function (r) {
        chain = chain.then(function () {
          return opts.apply(r.obj).then(function (res) {
            if (res === 'created') created++;
            else updated++;
          }).catch(function (err) {
            failed.push('строка ' + r.line + ': ' + (err && err.message ? err.message : String(err)));
          });
        });
      });

      chain.then(function () {
        m.close();
        var msg = 'Импорт завершён. Создано: ' + created + ', обновлено: ' + updated +
          ', пропущено: ' + (evalRows.length - validRows.length + failed.length) + '.';
        AG.UI.toast(msg, failed.length ? 'warning' : 'success', 6000);
        if (failed.length) {
          modal({
            title: 'Ошибки при загрузке строк',
            body: '<div class="import-errors" style="display:block"><ul>' +
              failed.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>',
            buttons: [{ label: 'Закрыть', class: 'btn-secondary', onClick: function () { return true; } }]
          });
        }
        if (opts.onDone) opts.onDone();
      });
    }
  }

  return {
    esc: esc,
    todayLocal: todayLocal,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    parseIntStrict: parseIntStrict,
    normalizeDate: normalizeDate,
    isValidISODate: isValidISODate,
    debounce: debounce,
    toast: toast,
    modal: modal,
    confirm: confirmDlg,
    showFormErrors: showFormErrors,
    importWizard: importWizard
  };
})();
