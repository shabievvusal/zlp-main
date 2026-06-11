/**
 * product-weights.js — таблица весов товаров из Excel (PowerBI выгрузка).
 * Excel: backend/data.xlsx, строка 3 (индекс 2) — заголовки, с строки 4 — данные.
 * Ключ: "Артикул товара" (например "УТ-10579150"), значение: вес в граммах.
 */

const path = require('path');
const fs = require('fs');

const EXCEL_PATH = path.join(__dirname, 'data.xlsx');

let weightMap = null; // Map<article, grams>

function parseExcelWeight(val) {
  if (!val && val !== 0) return 0;
  const s = String(val).replace(',', '.').replace(/\u00a0|\u202f/g, ' ').trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(кг|г|kg|g|л|l|мл|ml)?$/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = (m[2] || '').toLowerCase();
  if (!u || u === 'кг' || u === 'kg') return v * 1000;
  if (u === 'г' || u === 'g') return v;
  if (u === 'л' || u === 'l') return v * 1000;
  if (u === 'мл' || u === 'ml') return v;
  return 0;
}

function loadWeightMap() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.warn('[product-weights] data.xlsx not found at', EXCEL_PATH);
    return new Map();
  }
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(EXCEL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });

  // Строка с заголовками — ищем среди первых 5 строк
  let headerRow = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].includes('Артикул товара')) { headerRow = i; break; }
  }
  if (headerRow < 0) {
    console.warn('[product-weights] Header row not found in data.xlsx');
    return new Map();
  }

  const headers = rows[headerRow];
  const artIdx = headers.indexOf('Артикул товара');
  const weightIdx = headers.indexOf('Вес товара');
  if (artIdx < 0 || weightIdx < 0) {
    console.warn('[product-weights] Required columns not found');
    return new Map();
  }

  const map = new Map();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const art = String(r[artIdx] || '').trim();
    if (!art) continue;
    if (map.has(art)) continue; // первое вхождение — единица товара
    const grams = parseExcelWeight(r[weightIdx]);
    if (grams > 0) map.set(art, grams);
  }

  console.log(`[product-weights] Loaded ${map.size} articles from data.xlsx`);
  return map;
}

function getMap() {
  if (!weightMap) weightMap = loadWeightMap();
  return weightMap;
}

/** Вернуть вес в граммах по артикулу товара. 0 если не найдено. */
function getWeightGrams(article) {
  if (!article) return 0;
  return getMap().get(String(article).trim()) || 0;
}

/** Перезагрузить таблицу из файла (при замене data.xlsx). */
function reload() {
  weightMap = null;
  return getMap();
}

module.exports = { getWeightGrams, getMap, reload };
