/* ==========================================================================
 * csv.js — собственный парсер/сериализатор CSV по RFC 4180.
 *   - разделитель «;» или «,» (при импорте определяется автоматически
 *     по первой строке файла);
 *   - экранирование полей кавычками, удвоение кавычек внутри поля;
 *   - выгрузка всегда в UTF-8 с BOM (для корректного открытия в Excel);
 *   - имена файлов: agrogard_sklad_[раздел]_YYYY-MM-DD.csv.
 * Также здесь встроены шаблоны импорта (скачиваются как Blob, без fetch —
 * это важно для работы по протоколу file://).
 * Пространство имён: AG.CSV
 * ========================================================================== */
window.AG = window.AG || {};

AG.CSV = (function () {
  'use strict';

  /** Определение разделителя по первой строке (вне кавычек). */
  function detectDelimiter(text) {
    var semi = 0, comma = 0, inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { i++; } else { inQ = false; }
        }
      } else {
        if (c === '"') inQ = true;
        else if (c === ';') semi++;
        else if (c === ',') comma++;
        else if (c === '\n' || c === '\r') break;
      }
    }
    return comma > semi ? ',' : ';';
  }

  /**
   * Парсинг CSV-текста. Возвращает массив строк, каждая строка — массив полей.
   * Поддерживает поля в кавычках с переносами строк и удвоенными кавычками.
   */
  function parse(text) {
    if (text == null) return [];
    text = String(text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // срезаем BOM

    var d = detectDelimiter(text);
    var rows = [];
    var row = [];
    var field = '';
    var inQ = false;

    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else {
          field += c;
        }
      } else {
        if (c === '"') inQ = true;
        else if (c === d) { row.push(field); field = ''; }
        else if (c === '\r') { /* пропускаем, конец строки ловим по \n */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

    // Отбрасываем полностью пустые строки (в т.ч. хвостовой перевод строки)
    return rows.filter(function (r) {
      return !(r.length === 1 && String(r[0]).trim() === '');
    });
  }

  /** Экранирование одного поля по RFC 4180. */
  function escapeField(v, d) {
    var s = v == null ? '' : String(v);
    if (s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0 || s.indexOf(d) >= 0) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /** Сериализация: headers — массив строк, rows — массив массивов. */
  function serialize(headers, rows, delimiter) {
    var d = delimiter || ';';
    var lines = [];
    lines.push(headers.map(function (h) { return escapeField(h, d); }).join(d));
    (rows || []).forEach(function (r) {
      lines.push(r.map(function (c) { return escapeField(c, d); }).join(d));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /** Скачивание произвольного текста как файла (UTF-8 с BOM). */
  function downloadText(filename, text, mime) {
    var blob = new Blob(['﻿' + text], { type: (mime || 'text/csv') + ';charset=utf-8' }); // '﻿' — BOM (U+FEFF)
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 300);
  }

  /** Скачивание CSV. */
  function download(filename, headers, rows) {
    downloadText(filename, serialize(headers, rows), 'text/csv');
  }

  /** Имя файла по шаблону agrogard_sklad_[раздел]_YYYY-MM-DD.csv */
  function filename(section) {
    return 'agrogard_sklad_' + section + '_' + AG.UI.todayLocal() + '.csv';
  }

  /** Чтение выбранного пользователем файла как текста UTF-8. */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error || new Error('Не удалось прочитать файл')); };
      r.readAsText(file, 'UTF-8');
    });
  }

  /* ------------------------------------------------------------------
   * Встроенные шаблоны импорта. Дублируют файлы из папки templates/
   * (скачивание генерируется в браузере, т.к. fetch по file:// запрещён).
   * ------------------------------------------------------------------ */
  var TEMPLATES = {
    products: [
      'sku;name;category;manufacturer;model;unit;quantity;min_stock;serial_tracking;warranty_until;comment;tags',
      'MON-DELL-2422;Монитор Dell P2422H;Оборудование;Dell;P2422H;шт.;5;1;0;2028-01-15;Пример: монитор 24 дюйма;новое',
      'TONER-KYO-TK1150;Картридж Kyocera TK-1150;Расходники;Kyocera;TK-1150;шт.;10;3;0;;Для принтеров ECOSYS P2235dn;'
    ].join('\r\n') + '\r\n',
    employees: [
      'full_name;position;department;contacts',
      'Смирнов Олег Викторович;Системный администратор;ИТ-отдел;+7 (900) 123-45-67',
      'Кузнецова Мария Ивановна;Главный бухгалтер;Бухгалтерия;вн. 214'
    ].join('\r\n') + '\r\n',
    initial_stock: [
      'sku;quantity',
      'MON-DELL-2422;5',
      'TONER-KYO-TK1150;10'
    ].join('\r\n') + '\r\n'
  };

  var TEMPLATE_FILES = {
    products: 'template_products.csv',
    employees: 'template_employees.csv',
    initial_stock: 'template_initial_stock.csv'
  };

  function downloadTemplate(kind) {
    if (!TEMPLATES[kind]) return;
    downloadText(TEMPLATE_FILES[kind], TEMPLATES[kind], 'text/csv');
  }

  /* ------------------------------------------------------------------
   * Сопоставление заголовков колонок: принимаются английские ключи
   * и русские синонимы.
   * ------------------------------------------------------------------ */
  var HEADER_ALIASES = {
    sku: ['sku', 'артикул', 'код', 'код_товара'],
    name: ['name', 'наименование', 'название', 'товар'],
    category: ['category', 'категория'],
    manufacturer: ['manufacturer', 'производитель', 'бренд'],
    model: ['model', 'модель'],
    unit: ['unit', 'ед_изм', 'ед_изм_', 'единица', 'единица_измерения'],
    quantity: ['quantity', 'количество', 'кол_во', 'остаток'],
    min_stock: ['min_stock', 'мин_остаток', 'минимальный_остаток', 'минимум'],
    serial_tracking: ['serial_tracking', 'серийный_учёт', 'серийный_учет', 'учёт_по_серийным', 'серийные_номера'],
    warranty_until: ['warranty_until', 'гарантия_до', 'гарантия'],
    comment: ['comment', 'комментарий', 'примечание'],
    tags: ['tags', 'метки', 'ярлыки'],
    full_name: ['full_name', 'фио', 'сотрудник'],
    position: ['position', 'должность'],
    department: ['department', 'подразделение', 'отдел'],
    contacts: ['contacts', 'контакты', 'телефон', 'email']
  };

  function normalizeHeader(h) {
    return String(h == null ? '' : h).trim().toLowerCase().replace(/[\s.\-]+/g, '_');
  }

  /** Возвращает {поле: индексКолонки} по массиву заголовков файла. */
  function mapHeaders(headers) {
    var map = {};
    (headers || []).forEach(function (h, i) {
      var n = normalizeHeader(h);
      Object.keys(HEADER_ALIASES).forEach(function (field) {
        if (map[field] === undefined && HEADER_ALIASES[field].indexOf(n) >= 0) map[field] = i;
      });
    });
    return map;
  }

  return {
    parse: parse,
    serialize: serialize,
    detectDelimiter: detectDelimiter,
    download: download,
    downloadText: downloadText,
    filename: filename,
    readFile: readFile,
    downloadTemplate: downloadTemplate,
    mapHeaders: mapHeaders
  };
})();
