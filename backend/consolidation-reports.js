/**
 * consolidation-reports.js — генерация Excel-отчётов по нарушениям консолидации.
 *
 * Отчёт 1 — детальный: по листам (компания), строки = нарушения с найденным нарушителем.
 * Отчёт 2 — сводный:   по листам (компания) ФИО / кол-во / штраф + лист «Анализ».
 */

'use strict';

const ExcelJS = require('exceljs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeSheetName(name) {
  return String(name || 'Лист').replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 31);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatStatus(status) {
  if (status === 'new')         return 'Новая';
  if (status === 'in_progress') return 'В работе';
  if (status === 'resolved')    return 'Решена';
  return status || '';
}

function getPhotos(c) {
  return Array.isArray(c.photoFilenames) && c.photoFilenames.length > 0
    ? c.photoFilenames
    : (c.photoFilename ? [c.photoFilename] : []);
}

/** Возвращает официальное название компании или само краткое, если маппинга нет. */
function resolveOfficialName(rawCompany, companyFullNames) {
  if (!rawCompany || !String(rawCompany).trim()) return 'Без компании';
  const full = (companyFullNames || {})[rawCompany];
  return full && String(full).trim() ? String(full).trim() : String(rawCompany).trim();
}

// ─── Стили ────────────────────────────────────────────────────────────────────

const COLORS = {
  header:  'FFB8CCE4',
  totals:  'FFD9E1F2',
  row0:    'FFFFFFFF',
  row1:    'FFF2F7FC',
  border:  'FF9DC3E6',
  link:    'FF0563C1',
  analysis:'FFE2EFDA',
};

const thinBorder = side => ({ style: 'thin', color: { argb: COLORS.border } });
const BORDER = { top: thinBorder(), left: thinBorder(), bottom: thinBorder(), right: thinBorder() };
const BOLD_FONT   = { bold: true, size: 10, name: 'Calibri' };
const NORMAL_FONT = { size: 10, name: 'Calibri' };
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
const LEFT   = { horizontal: 'left',   vertical: 'middle' };

function applyHeaderRow(ws) {
  ws.getRow(1).height = 26;
  ws.getRow(1).eachCell({ includeEmpty: true }, cell => {
    cell.font      = BOLD_FONT;
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.header } };
    cell.border    = BORDER;
    cell.alignment = CENTER;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function applyDataRows(ws, dataStart, dataEnd) {
  for (let r = dataStart; r <= dataEnd; r++) {
    const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: r % 2 === 0 ? COLORS.row1 : COLORS.row0 } };
    ws.getRow(r).eachCell({ includeEmpty: true }, cell => {
      if (!cell.font?.bold) cell.font = NORMAL_FONT;
      cell.fill   = fill;
      cell.border = BORDER;
      if (!cell.alignment) cell.alignment = LEFT;
    });
  }
}

function applyTotalsRow(row) {
  row.height = 20;
  row.eachCell({ includeEmpty: true }, cell => {
    cell.font   = BOLD_FONT;
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.totals } };
    cell.border = BORDER;
    cell.alignment = LEFT;
  });
}

// ─── Отчёт 1 — детальный ─────────────────────────────────────────────────────

/**
 * @param {Object[]} complaints   — список жалоб (уже отфильтрованных по датам; violator обязателен)
 * @param {Object}   companyFullNames — { краткое: 'официальное' }
 * @param {string}   photoBaseUrl  — базовый URL фото, напр. 'https://host/api/consolidation/uploads/'
 * @returns {Promise<Buffer>}
 */
async function generateReport1(complaints, companyFullNames, photoBaseUrl) {
  const found = complaints.filter(c => c.violator);

  const byCompany = new Map();
  for (const c of found) {
    const official = resolveOfficialName(c.company, companyFullNames);
    if (!byCompany.has(official)) byCompany.set(official, []);
    byCompany.get(official).push(c);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ZLP';

  if (byCompany.size === 0) {
    const ws = wb.addWorksheet('Нет данных');
    ws.addRow(['Нарушения с установленным нарушителем за выбранный период не найдены']);
    return wb.xlsx.writeBuffer();
  }

  const sortedCompanies = [...byCompany.keys()].sort((a, b) => a.localeCompare(b, 'ru'));

  for (const company of sortedCompanies) {
    const items = [...byCompany.get(company)].sort((a, b) =>
      (a.createdAt || '') < (b.createdAt || '') ? -1 : 1
    );

    const ws = wb.addWorksheet(sanitizeSheetName(company));
    ws.columns = [
      { header: 'Дата',           key: 'date',     width: 12 },
      { header: 'Время',          key: 'time',     width: 10 },
      { header: 'Ячейка',         key: 'cell',     width: 16 },
      { header: 'ФИО нарушителя', key: 'violator', width: 28 },
      { header: 'Товар',          key: 'product',  width: 34 },
      { header: 'Артикул',        key: 'article',  width: 18 },
      { header: 'Штрихкод',       key: 'barcode',  width: 18 },
      { header: 'Ссылка на фото', key: 'photoUrl', width: 48 },
    ];

    for (const c of items) {
      const photos = getPhotos(c);
      const url = photos.length > 0
        ? `${photoBaseUrl}${encodeURIComponent(photos[0])}`
        : '';

      const row = ws.addRow({
        date:     formatDate(c.createdAt),
        time:     formatTime(c.createdAt),
        cell:     c.cell || '',
        violator: c.violator || '',
        product:  c.productName || '',
        article:  c.nomenclatureCode || '',
        barcode:  c.barcode || '',
        photoUrl: url,
      });

      if (url) {
        const cell = row.getCell('photoUrl');
        cell.value     = { text: 'Открыть фото', hyperlink: url };
        cell.font      = { size: 10, name: 'Calibri', color: { argb: COLORS.link }, underline: true };
        cell.alignment = LEFT;
      }
    }

    applyHeaderRow(ws);
    if (items.length > 0) applyDataRows(ws, 2, items.length + 1);
  }

  return wb.xlsx.writeBuffer();
}

// ─── Отчёт 2 — сводный ───────────────────────────────────────────────────────

/**
 * @param {Object[]} complaints          — список жалоб (уже отфильтрованных по датам)
 * @param {Object}   companyFullNames    — { краткое: 'официальное' }
 * @param {number}   fineAmount          — штраф за одну ошибку (руб.)
 * @param {Object}   employeesByCompanyByDay — { 'YYYY-MM-DD': { rawCompanyName: { employees: string[] } } }
 * @param {string[]} dateRange           — массив дат 'YYYY-MM-DD' в диапазоне
 * @returns {Promise<Buffer>}
 */
async function generateReport2(complaints, companyFullNames, fineAmount, employeesByCompanyByDay, dateRange) {
  const fine = Number(fineAmount) || 0;
  const found = complaints.filter(c => c.violator);

  // byCompany: officialName -> Map<fio, count>
  const byCompany = new Map();
  for (const c of found) {
    const official = resolveOfficialName(c.company, companyFullNames);
    if (!byCompany.has(official)) byCompany.set(official, new Map());
    const vm = byCompany.get(official);
    vm.set(c.violator, (vm.get(c.violator) || 0) + 1);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ZLP';

  const sortedCompanies = [...byCompany.keys()].sort((a, b) => a.localeCompare(b, 'ru'));

  // ── Листы по компаниям ────────────────────────────────────────────────────
  for (const company of sortedCompanies) {
    const violators = byCompany.get(company);
    const ws = wb.addWorksheet(sanitizeSheetName(company));

    ws.columns = [
      { header: 'ФИО нарушителя',     key: 'fio',   width: 32 },
      { header: 'Количество ошибок',   key: 'count', width: 20 },
      { header: 'Сумма штрафа, руб.',  key: 'fine',  width: 22 },
    ];

    const sorted = [...violators.entries()].sort((a, b) => b[1] - a[1]);
    for (const [fio, count] of sorted) {
      ws.addRow({ fio, count, fine: count * fine });
    }

    const totalCount = sorted.reduce((s, [, c]) => s + c, 0);
    const totalsRow  = ws.addRow({ fio: 'ИТОГО', count: totalCount, fine: totalCount * fine });
    applyTotalsRow(totalsRow);

    applyHeaderRow(ws);
    if (sorted.length > 0) applyDataRows(ws, 2, sorted.length + 1);
  }

  // ── Лист «Анализ» ─────────────────────────────────────────────────────────
  const analysisWs = wb.addWorksheet('Анализ');
  analysisWs.columns = [
    { header: 'Дата',                 key: 'date',       width: 14 },
    { header: 'Компания',             key: 'company',    width: 34 },
    { header: 'Сотрудников',          key: 'employees',  width: 16 },
    { header: 'Количество ошибок',    key: 'violations', width: 20 },
    { header: '% нарушающих',         key: 'percent',    width: 18 },
    { header: 'Сумма штрафа, руб.',   key: 'fine',       width: 22 },
  ];

  // violations and unique violators per officialCompany per date
  const vMap = new Map(); // `dateStr|official` -> violations count
  const uMap = new Map(); // `dateStr|official` -> Set<violator fio>
  for (const c of found) {
    const official = resolveOfficialName(c.company, companyFullNames);
    const dateKey  = (c.createdAt || '').slice(0, 10);
    const key = `${dateKey}|${official}`;
    vMap.set(key, (vMap.get(key) || 0) + 1);
    if (!uMap.has(key)) uMap.set(key, new Set());
    uMap.get(key).add(c.violator);
  }

  // All official companies that appear anywhere in the data
  const allCompaniesSet = new Set(sortedCompanies);
  for (const dayData of Object.values(employeesByCompanyByDay || {})) {
    for (const rawComp of Object.keys(dayData)) {
      allCompaniesSet.add(resolveOfficialName(rawComp, companyFullNames));
    }
  }
  const allCompanies = [...allCompaniesSet].sort((a, b) => a.localeCompare(b, 'ru'));

  let analysisRows = 0;
  for (const dateStr of (dateRange || [])) {
    const dayData = (employeesByCompanyByDay || {})[dateStr] || {};

    // map raw company -> employee count for this day, then aggregate by official name
    const empByOfficial = {};
    for (const [rawComp, dc] of Object.entries(dayData)) {
      const official = resolveOfficialName(rawComp, companyFullNames);
      empByOfficial[official] = (empByOfficial[official] || 0) + (dc.employees || 0);
    }

    for (const company of allCompanies) {
      const employees  = empByOfficial[company] || 0;
      const violations = vMap.get(`${dateStr}|${company}`) || 0;
      if (employees === 0 && violations === 0) continue;

      const uniqueViolators = uMap.get(`${dateStr}|${company}`)?.size || 0;
      const pct = employees > 0
        ? `${(uniqueViolators / employees * 100).toFixed(1)}%`
        : '—';

      analysisWs.addRow({
        date:       formatDate(dateStr + 'T00:00:00'),
        company,
        employees,
        violations,
        percent:    pct,
        fine:       violations * fine,
      });
      analysisRows++;
    }
  }

  applyHeaderRow(analysisWs);
  if (analysisRows > 0) applyDataRows(analysisWs, 2, analysisRows + 1);

  return wb.xlsx.writeBuffer();
}

module.exports = { generateReport1, generateReport2 };
