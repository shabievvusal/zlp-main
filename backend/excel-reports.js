/**
 * excel-reports.js — работа с Excel-отчётом по РК
 *
 * Привязки WMS-адрес → код получателя хранятся в data/address-codes.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CODES_PATH = path.join(DATA_DIR, 'address-codes.json');
const REPORT_PATH = path.join(DATA_DIR, 'Отчет по РК.xlsx');

// ─── Ручные привязки для новых ЦФЗ ───────────────────────

function loadCodes() {
  try {
    if (!fs.existsSync(CODES_PATH)) return {};
    return JSON.parse(fs.readFileSync(CODES_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCodes(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CODES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Сохраняет привязку: WMS-адрес → код получателя.
 */
function setAddressCode(wmsAddress, recipientCode) {
  const codes = loadCodes();
  codes[wmsAddress] = {
    sapCode: String(recipientCode).trim(),
    updatedAt: new Date().toISOString(),
  };
  saveCodes(codes);
}

/**
 * Возвращает все ручные привязки.
 */
function getAddressCodes() {
  return loadCodes();
}

/**
 * Из списка WMS-адресов возвращает те, у которых нет SAP-кода в address-codes.json.
 */
function getMissingCodes(wmsAddresses) {
  const codes = loadCodes();
  return wmsAddresses.filter(a => !codes[a]);
}

// ─── Генерация отчёта (ExcelJS со стилями) ───────────────

const ExcelJS = require('exceljs');

const MONTH_NAMES_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                        'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

/**
 * Открывает существующий Excel из reports/, добавляет новый лист с данными месяца.
 * Если файл не найден — создаёт новый.
 *
 * @param {Object[]} summaryByAddress — [{address, records: [{date, shipped, received}]}]
 * @param {string[]} dates — массив дат 'YYYY-MM-DD'
 * @param {string} dateFrom — 'YYYY-MM-DD' (для названия листа)
 * @returns {Promise<Buffer>}
 */
async function generateReport(summaryByAddress, dates, dateFrom, knownAddresses = []) {
  const codes = loadCodes();

  function getRecipientCode(addr) {
    return codes[addr]?.sapCode || '';
  }

  // Индексируем данные по адресу для быстрого поиска
  const dataByAddress = new Map();
  for (const entry of summaryByAddress) {
    dataByAddress.set(entry.address, entry.records);
  }

  // Объединяем все источники адресов: все известные ЦФЗ + активные в периоде + имеющие код
  const allAddressSet = new Set([
    ...knownAddresses,
    ...summaryByAddress.map(e => e.address),
    ...Object.keys(codes),
  ]);

  // Сортировка: сначала с кодом (по числовому значению), потом без кода (по алфавиту)
  const allAddresses = [...allAddressSet].sort((a, b) => {
    const ca = codes[a]?.sapCode;
    const cb = codes[b]?.sapCode;
    const na = parseInt(ca) || 0;
    const nb = parseInt(cb) || 0;
    if (ca && cb) return na - nb;
    if (ca) return -1;
    if (cb) return 1;
    return a.localeCompare(b, 'ru');
  });

  const sortedDates = [...dates].sort();
  const [y, m] = (dateFrom || sortedDates[0]).split('-');
  const sheetName = `${MONTH_NAMES_RU[parseInt(m, 10) - 1]} ${y}`;

  // Открываем существующий файл или создаём новый
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(REPORT_PATH)) {
    await wb.xlsx.readFile(REPORT_PATH);
  }

  // Удаляем лист с тем же именем если уже есть (перезапись месяца)
  const existingSheet = wb.getWorksheet(sheetName);
  if (existingSheet) wb.removeWorksheet(existingSheet.id);

  const ws = wb.addWorksheet(sheetName);

  // ── Стили ──────────────────────────────────────────────
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB8CCE4' } }; // синеватый
  const totalsFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }; // светлее
  const shippedFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
  const returnFill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } }; // зеленоватый
  const debtPosFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } }; // красный — долг
  const debtZeroFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } }; // зелёный — ноль

  const thinBorder = {
    top:    { style: 'thin', color: { argb: 'FF9DC3E6' } },
    left:   { style: 'thin', color: { argb: 'FF9DC3E6' } },
    bottom: { style: 'thin', color: { argb: 'FF9DC3E6' } },
    right:  { style: 'thin', color: { argb: 'FF9DC3E6' } },
  };
  const boldFont = { bold: true, size: 10, name: 'Calibri' };
  const normalFont = { size: 10, name: 'Calibri' };
  const centerAlign = { horizontal: 'center', vertical: 'middle', wrapText: true };
  const leftAlign   = { horizontal: 'left',   vertical: 'middle' };

  // ── Ширина колонок ─────────────────────────────────────
  ws.getColumn(1).width = 9;   // Код получателя
  ws.getColumn(2).width = 44;  // Адрес
  for (let i = 0; i < sortedDates.length; i++) {
    ws.getColumn(3 + i * 2).width = 10;
    ws.getColumn(4 + i * 2).width = 10;
  }
  ws.getColumn(3 + sortedDates.length * 2).width = 14; // итого

  // ── Строка 1: заголовки дат ────────────────────────────
  ws.getRow(1).height = 28;
  const r1 = ws.getRow(1);

  function styleHeaderCell(cell, value) {
    cell.value = value;
    cell.font = boldFont;
    cell.fill = headerFill;
    cell.alignment = centerAlign;
    cell.border = thinBorder;
  }

  styleHeaderCell(r1.getCell(1), '');
  styleHeaderCell(r1.getCell(2), 'Адрес получателя');
  ws.mergeCells(1, 1, 2, 1);
  ws.mergeCells(1, 2, 2, 2);

  for (let i = 0; i < sortedDates.length; i++) {
    const [y, m, day] = sortedDates[i].split('-');
    const col = 3 + i * 2;
    styleHeaderCell(r1.getCell(col), `${day}.${m}.${y}`);
    styleHeaderCell(r1.getCell(col + 1), '');
    ws.mergeCells(1, col, 1, col + 1);
  }
  const lastCol = 3 + sortedDates.length * 2;
  styleHeaderCell(r1.getCell(lastCol), 'итого долг по ЦФЗ');
  ws.mergeCells(1, lastCol, 2, lastCol);

  // ── Строка 2: подзаголовки (отгружено / возвращено) ───
  ws.getRow(2).height = 28;
  const r2 = ws.getRow(2);
  styleHeaderCell(r2.getCell(1), '');
  styleHeaderCell(r2.getCell(2), '');
  for (let i = 0; i < sortedDates.length; i++) {
    const col = 3 + i * 2;
    const c1 = r2.getCell(col);
    c1.value = 'отгружено';
    c1.font = boldFont; c1.fill = shippedFill; c1.alignment = centerAlign; c1.border = thinBorder;
    const c2 = r2.getCell(col + 1);
    c2.value = 'возвращено';
    c2.font = boldFont; c2.fill = returnFill; c2.alignment = centerAlign; c2.border = thinBorder;
  }

  // ── Строки данных ──────────────────────────────────────
  allAddresses.forEach((addr, rowIdx) => {
    const records = dataByAddress.get(addr) || [];
    const excelRow = ws.getRow(3 + rowIdx);
    excelRow.height = 18;
    const rowFill = rowIdx % 2 === 0
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F7FC' } };

    const sapCell = excelRow.getCell(1);
    sapCell.value = getRecipientCode(addr) || '';
    sapCell.font = normalFont; sapCell.fill = rowFill;
    sapCell.alignment = centerAlign; sapCell.border = thinBorder;

    const addrCell = excelRow.getCell(2);
    addrCell.value = addr;
    addrCell.font = normalFont; addrCell.fill = rowFill;
    addrCell.alignment = leftAlign; addrCell.border = thinBorder;

    let totalDebt = 0;
    for (let i = 0; i < sortedDates.length; i++) {
      const rec = records.find(r => r.date === sortedDates[i]);
      const shipped  = rec?.shipped  != null ? rec.shipped  : null;
      const returned = rec?.received != null ? rec.received : null;
      const col = 3 + i * 2;

      const sc = excelRow.getCell(col);
      sc.value = shipped;
      sc.font = normalFont; sc.fill = shipped != null ? shippedFill : rowFill;
      sc.alignment = centerAlign; sc.border = thinBorder;

      const rc = excelRow.getCell(col + 1);
      rc.value = returned;
      rc.font = normalFont; rc.fill = returned != null ? returnFill : rowFill;
      rc.alignment = centerAlign; rc.border = thinBorder;

      if (shipped  != null) totalDebt += shipped;
      if (returned != null) totalDebt -= returned;
    }

    const debtCell = excelRow.getCell(lastCol);
    debtCell.value = totalDebt !== 0 ? totalDebt : 0;
    debtCell.font = { ...boldFont };
    debtCell.fill = totalDebt > 0 ? debtPosFill : debtZeroFill;
    debtCell.alignment = centerAlign;
    debtCell.border = thinBorder;
  });

  // ── Итоговая строка ────────────────────────────────────
  const totalsRow = ws.getRow(3 + allAddresses.length);
  totalsRow.height = 20;

  const tc1 = totalsRow.getCell(1);
  tc1.value = ''; tc1.fill = totalsFill; tc1.border = thinBorder;
  const tc2 = totalsRow.getCell(2);
  tc2.value = 'ИТОГО'; tc2.font = boldFont; tc2.fill = totalsFill;
  tc2.alignment = leftAlign; tc2.border = thinBorder;

  for (let i = 0; i < sortedDates.length; i++) {
    const col = 3 + i * 2;
    const sh = allAddresses.reduce((s, addr) => {
      const recs = dataByAddress.get(addr) || [];
      const rec = recs.find(r => r.date === sortedDates[i]);
      return s + (rec?.shipped ?? 0);
    }, 0);
    const re = allAddresses.reduce((s, addr) => {
      const recs = dataByAddress.get(addr) || [];
      const rec = recs.find(r => r.date === sortedDates[i]);
      return s + (rec?.received ?? 0);
    }, 0);

    const sc = totalsRow.getCell(col);
    sc.value = sh || null; sc.font = boldFont; sc.fill = totalsFill;
    sc.alignment = centerAlign; sc.border = thinBorder;

    const rc = totalsRow.getCell(col + 1);
    rc.value = re || null; rc.font = boldFont; rc.fill = totalsFill;
    rc.alignment = centerAlign; rc.border = thinBorder;
  }
  const tc = totalsRow.getCell(lastCol);
  tc.fill = totalsFill; tc.border = thinBorder;

  // ── Закрепить первые 2 строки ──────────────────────────
  ws.views = [{ state: 'frozen', ySplit: 2 }];

  // Сохраняем на сервере и возвращаем буфер
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await wb.xlsx.writeFile(REPORT_PATH);
  return wb.xlsx.writeBuffer();
}

module.exports = { setAddressCode, getAddressCodes, getMissingCodes, generateReport };
