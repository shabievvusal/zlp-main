/**
 * storage.js — хранилище операций для страницы /vs
 * Почасовые файлы: data/YYYY-MM-DD/HH.json (лёгкий формат, только нужные поля)
 * Обратная совместимость: при отсутствии почасовых данных читаем shift_YYYY-MM-DD_day|night.json
 */

const fs = require('fs');
const path = require('path');
const productWeights = require('./product-weights');

const DATA_DIR = path.join(__dirname, 'data');

/** Часовой пояс смен: Москва (UTC+3), без перехода на летнее время */
const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

function normalizeNameWeight(str) {
  return String(str || '').replace(/\u00a0|\u202f/g, ' ').trim();
}

function parseNumber(val) {
  const n = Number(String(val || '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function gramsFromUnit(value, unit) {
  const v = parseNumber(value);
  if (!v) return 0;
  const u = String(unit || '').toLowerCase();
  if (u === 'кг' || u === 'kg') return v * 1000;
  if (u === 'г' || u === 'g') return v;
  if (u === 'л' || u === 'l') return v * 1000;
  if (u === 'мл' || u === 'ml') return v;
  return 0;
}

function parseWeightGramsFromName(name) {
  const s = normalizeNameWeight(name);
  if (!s) return 0;
  const combo = s.match(/(\d+(?:[.,]\d+)?)\s*[xх×]\s*(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i);
  if (combo) {
    const count = parseNumber(combo[1]);
    const per = gramsFromUnit(combo[2], combo[3]);
    return count * per;
  }
  const simple = s.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i);
  if (simple) {
    return gramsFromUnit(simple[1], simple[2]);
  }
  return 0;
}

function addWeight(map, key, grams, isKdk) {
  if (!key || grams <= 0) return;
  const cur = map.get(key) || { storage: 0, kdk: 0, total: 0 };
  if (isKdk) cur.kdk += grams;
  else cur.storage += grams;
  cur.total = cur.storage + cur.kdk;
  map.set(key, cur);
}

/** Возвращает { dateStr, hour } в московском времени для timestamp (ISO/UTC). */
function getMoscowDateHour(ts) {
  const d = new Date(ts);
  const moscow = new Date(d.getTime() + MOSCOW_UTC_OFFSET_MS);
  const dateStr = moscow.toISOString().slice(0, 10);
  const hour = moscow.getUTCHours();
  return { dateStr, hour };
}

/** Ключ смены по (dateStr, hour) в московском времени: день 9–20, ночь 21–8. */
function getShiftKeyFromMoscowDateHour(dateStr, hour) {
  if (hour >= 9 && hour < 21) return `${dateStr}_day`;
  if (hour >= 21) return `${dateStr}_night`;
  const prev = new Date(dateStr + 'T12:00:00Z');
  prev.setUTCDate(prev.getUTCDate() - 1);
  return `${prev.toISOString().slice(0, 10)}_night`;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getShiftKey(isoDate) {
  const d = new Date(isoDate);
  const { dateStr, hour } = getMoscowDateHour(d.toISOString());
  return getShiftKeyFromMoscowDateHour(dateStr, hour);
}

function getCurrentShiftKey() {
  return getShiftKey(new Date().toISOString());
}

/** Получить mergeKey из полного объекта операции (API) */
function getMergeKey(item) {
  const type = (item.operationType || item.type || '').toUpperCase();
  const isTaskType = type === 'PICK_BY_LINE' || type === 'PIECE_SELECTION_PICKING';
  if (isTaskType) {
    const exec = (item.responsibleUser && (item.responsibleUser.id || [item.responsibleUser.lastName, item.responsibleUser.firstName].filter(Boolean).join(' '))) || '';
    const cell = (item.targetAddress && item.targetAddress.cellAddress) || (item.sourceAddress && item.sourceAddress.cellAddress) || '';
    const product = (item.product && (item.product.nomenclatureCode || item.product.name)) || '';
    return `task|${exec}|${cell}|${product}`;
  }
  return `id|${item.id || ''}`;
}

/** MergeKey для уже облегчённого объекта (поля верхнего уровня) */
function getMergeKeyFromLight(light) {
  const type = (light.operationType || light.type || '').toUpperCase();
  const isTaskType = type === 'PICK_BY_LINE' || type === 'PIECE_SELECTION_PICKING';
  if (isTaskType) {
    const exec = light.executor || '';
    const cell = light.cell || '';
    const product = light.nomenclatureCode || light.productName || '';
    return `task|${exec}|${cell}|${product}`;
  }
  return `id|${light.id || ''}`;
}

/** Привести полный объект операции с API к лёгкому формату (как flattenItem на клиенте) */
function toLightItem(item) {
  const ru = item.responsibleUser || {};
  const executor = [ru.lastName, ru.firstName, ru.middleName].filter(p => p && p.trim() !== '-').join(' ').trim() || '';
  const product = item.product || {};
  return {
    id: item.id || '',
    type: item.type || '',
    operationType: item.operationType || '',
    productName: product.name || '',
    nomenclatureCode: product.nomenclatureCode || '',
    barcodes: (product.barcodes || []).join(', '),
    productionDate: item.part?.productionDate || '',
    bestBeforeDate: item.part?.bestBeforeDate || '',
    sourceBarcode: item.sourceAddress?.handlingUnitBarcode || '',
    cell: (item.targetAddress && item.targetAddress.cellAddress) || (item.sourceAddress && item.sourceAddress.cellAddress) || '',
    targetBarcode: item.targetAddress?.handlingUnitBarcode || '',
    startedAt: item.operationStartedAt || '',
    completedAt: item.operationCompletedAt || '',
    executor,
    executorId: ru.id || '',
    srcOld: item.sourceQuantity?.oldQuantity ?? '',
    srcNew: item.sourceQuantity?.newQuantity ?? '',
    tgtOld: item.targetQuantity?.oldQuantity ?? '',
    tgtNew: item.targetQuantity?.newQuantity ?? '',
    quantity: item.targetQuantity?.newQuantity ?? item.sourceQuantity?.oldQuantity ?? '',
  };
}

// ─── Почасовое хранение (лёгкий формат) ─────────────────────────────────────

function hourlyDir(dateStr) {
  return path.join(DATA_DIR, dateStr);
}

function hourlyFilePath(dateStr, hour) {
  return path.join(hourlyDir(dateStr), `${String(hour).padStart(2, '0')}.json`);
}

function ensureHourlyDir(dateStr) {
  const dir = hourlyDir(dateStr);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Загрузить один почасовой файл. Возвращает Map(mergeKey -> lightItem). */
function loadHourly(dateStr, hour) {
  const fp = hourlyFilePath(dateStr, hour);
  if (!fs.existsSync(fp)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const items = new Map();
    const list = Array.isArray(raw.items) ? raw.items : Object.values(raw.items || {});
    for (const item of list) {
      const k = getMergeKeyFromLight(item);
      if (!items.has(k)) items.set(k, item);
    }
    return items;
  } catch {
    return new Map();
  }
}

/** Сохранить один почасовой файл (только лёгкие объекты). */
function saveHourly(dateStr, hour, itemsMap) {
  ensureDataDir();
  ensureHourlyDir(dateStr);
  const fp = hourlyFilePath(dateStr, hour);
  const items = Array.from(itemsMap.values());
  const obj = {
    date: dateStr,
    hour: Number(hour),
    updatedAt: new Date().toISOString(),
    items,
  };
  fs.writeFileSync(fp, JSON.stringify(obj), 'utf8');
}

/** Есть ли почасовые данные за дату (хотя бы один файл). */
function hasHourlyDataForDate(dateStr) {
  const dir = hourlyDir(dateStr);
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir).filter(f => /^\d{2}\.json$/.test(f));
  return files.length > 0;
}

/** Есть ли почасовые данные за предыдущую дату (для ночной смены). */
function hasAnyHourlyData(dateStr) {
  const prev = new Date(dateStr);
  prev.setDate(prev.getDate() - 1);
  const prevStr = prev.toISOString().slice(0, 10);
  return hasHourlyDataForDate(dateStr) || hasHourlyDataForDate(prevStr);
}

// ─── Мерж: сохраняем по часам в лёгком формате ──────────────────────────────

function mergeOperations(newItems) {
  if (!Array.isArray(newItems) || newItems.length === 0) {
    return { added: 0, skipped: 0, byShift: {} };
  }
  const byDateHour = new Map();
  for (const item of newItems) {
    const ts = item.operationCompletedAt;
    if (!ts) continue;
    const { dateStr, hour } = getMoscowDateHour(ts);
    const key = `${dateStr}\t${hour}`;
    if (!byDateHour.has(key)) byDateHour.set(key, []);
    byDateHour.get(key).push(item);
  }

  let totalAdded = 0;
  let totalSkipped = 0;
  const byShift = {};

  for (const [dateHourKey, items] of byDateHour) {
    const [dateStr, hourStr] = dateHourKey.split('\t');
    const hour = parseInt(hourStr, 10);
    const shiftKey = getShiftKeyFromMoscowDateHour(dateStr, hour);
    if (!byShift[shiftKey]) byShift[shiftKey] = { added: 0, skipped: 0, total: 0 };

    const existing = loadHourly(dateStr, hour);
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      const light = toLightItem(item);
      const mergeKey = getMergeKey(item);
      if (existing.has(mergeKey)) skipped++;
      else {
        existing.set(mergeKey, light);
        added++;
      }
    }
    saveHourly(dateStr, hour, existing);
    byShift[shiftKey].added += added;
    byShift[shiftKey].skipped += skipped;
    byShift[shiftKey].total = existing.size;
    totalAdded += added;
    totalSkipped += skipped;
  }

  return { added: totalAdded, skipped: totalSkipped, byShift };
}

// ─── Чтение: почасовые файлы или fallback на смены ───────────────────────────

/** Список (dateStr, hour) для загрузки.
 * Ночь для даты D = 21:00–09:00, начиная с D: часы 21,22,23 по D и 0..8 по D+1.
 * День для даты D = 09:00–21:00 по D: часы 9..20.
 */
function getHoursToLoad(dateStr, fromHour, toHour, shift) {
  const pairs = [];

  if (shift === 'night') {
    const next = new Date(dateStr + 'T12:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    const nextStr = next.toISOString().slice(0, 10);
    for (const h of [21, 22, 23]) pairs.push([dateStr, h]);
    for (let h = 0; h <= 8; h++) pairs.push([nextStr, h]);
    return pairs;
  }
  if (shift === 'day') {
    for (let h = 9; h <= 20; h++) pairs.push([dateStr, h]);
    return pairs;
  }

  if (fromHour !== undefined || toHour !== undefined) {
    const from = fromHour == null ? 0 : Math.max(0, fromHour);
    const to = toHour == null ? 23 : Math.min(23, toHour);
    for (let h = from; h <= to; h++) pairs.push([dateStr, h]);
    return pairs;
  }
  // Полный день (без фильтра смены): ночь предыдущего (21–23) + все часы текущей даты (0–23)
  const prev = new Date(dateStr + 'T12:00:00Z');
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevStr = prev.toISOString().slice(0, 10);
  for (const h of [21, 22, 23]) pairs.push([prevStr, h]);
  for (let h = 0; h <= 23; h++) pairs.push([dateStr, h]);
  return pairs;
}

function getDateItemsFromHourly(dateStr, options = {}) {
  const { fromHour, toHour, shift } = options;
  const pairs = getHoursToLoad(dateStr, fromHour, toHour, shift);
  const byId = new Map();
  for (const [d, hour] of pairs) {
    const map = loadHourly(d, hour);
    for (const item of map.values()) {
      const k = item.id || (item.completedAt + item.executor + item.cell);
      if (!byId.has(k)) byId.set(k, item);
    }
  }
  const items = Array.from(byId.values());
  const ts = item => item.completedAt || item.startedAt || '';
  items.sort((a, b) => ts(a).localeCompare(ts(b)));
  return items;
}

const DAY_HOURS_SUMMARY = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const NIGHT_HOURS_SUMMARY = [22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function getMoscowTodayStr() {
  const m = new Date(Date.now() + MOSCOW_UTC_OFFSET_MS);
  return m.toISOString().slice(0, 10);
}

function getHoursDisplayForSummary(dateStr, shift) {
  const order = shift === 'night' ? NIGHT_HOURS_SUMMARY : DAY_HOURS_SUMMARY;
  const todayStr = getMoscowTodayStr();
  if (dateStr !== todayStr) return order;
  const m = new Date(Date.now() + MOSCOW_UTC_OFFSET_MS);
  const currentHour = m.getUTCHours();
  const currentCol = shift === 'day' ? currentHour + 1 : (currentHour + 1) % 24;
  if (shift === 'day') {
    const passed = order.filter(col => col <= currentHour);
    return order.filter(col => col <= currentCol).length > passed.length ? [...passed, currentCol].sort((a, b) => a - b) : passed;
  }
  const passed = order.filter(col => col >= 22 || col <= currentHour);
  return order.filter(col => passed.includes(col) || col === currentCol);
}

/** Ключ задачи: КДК — один вклад в ячейку одним товаром = одна задача; остальные — по id/времени. */
function getTaskKeySummary(item) {
  const type = (item.operationType || '').toUpperCase();
  if (type === 'PICK_BY_LINE') {
    const exec = item.executorId || item.executor || '';
    const cell = item.cell || '';
    const product = item.nomenclatureCode || item.productName || '';
    return `kdk|${exec}|${cell}|${product}`;
  }
  return item.id ? `op|${item.id}` : `op|${(item.completedAt || item.startedAt || '')}|${item.executor || ''}|${item.cell || ''}`;
}

/** Считает задачи и рабочие минуты по сотрудникам из массива items (light). */
function computeEmployeeStatsForItems(items, idleThresholdMs = IDLE_THRESHOLD_MS) {
  const threshold = Number.isFinite(idleThresholdMs) && idleThresholdMs >= 0 ? idleThresholdMs : IDLE_THRESHOLD_MS;
  const byExecutor = new Map();
  for (const item of items || []) {
    const name = item.executor || '';
    if (!name) continue;
    const ts = item.completedAt || item.startedAt;
    if (!ts) continue;
    if (!byExecutor.has(name)) {
      byExecutor.set(name, { times: [], taskKeys: new Set() });
    }
    const rec = byExecutor.get(name);
    rec.times.push(new Date(ts).getTime());
    rec.taskKeys.add(getTaskKeySummary(item));
  }
  const out = new Map();
  for (const [name, rec] of byExecutor) {
    const times = rec.times;
    if (!times.length) continue;
    times.sort((a, b) => a - b);
    let idleMs = 0;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap >= threshold) idleMs += gap;
    }
    const totalMs = Math.max(0, (times[times.length - 1] - times[0]) - idleMs);
    const workMinutes = totalMs / 60000;
    const tasksCount = rec.taskKeys.size;
    out.set(name, { tasksCount, workMinutes });
  }
  return out;
}

function normalizeFioSummary(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Время HH:MM по Москве для timestamp (ISO). */
function formatTimeMoscow(ts) {
  if (!ts) return '—';
  const m = new Date(new Date(ts).getTime() + MOSCOW_UTC_OFFSET_MS);
  const h = m.getUTCHours();
  const min = m.getUTCMinutes();
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

const IDLE_THRESHOLD_MS = 15 * 60 * 1000;

/** Простои по сотрудникам: паузы до первой операции, между операциями и после последней >= threshold. */
function calcIdlesByEmployeeSummary(items, idleThresholdMs = IDLE_THRESHOLD_MS, shiftStartMs = 0, shiftEndMs = 0) {
  const threshold = Number.isFinite(idleThresholdMs) && idleThresholdMs >= 0 ? idleThresholdMs : IDLE_THRESHOLD_MS;
  const byExecutor = new Map();
  for (const item of items) {
    const name = item.executor || '';
    if (!name) continue;
    const ts = item.completedAt;
    if (!ts) continue;
    if (!byExecutor.has(name)) byExecutor.set(name, []);
    byExecutor.get(name).push(new Date(ts).getTime());
  }
  const out = {};
  for (const [name, times] of byExecutor) {
    if (!times.length) continue;
    times.sort((a, b) => a - b);
    const idles = [];
    let totalMs = 0;
    if (shiftStartMs > 0 && times[0] - shiftStartMs >= threshold) {
      idles.push(formatTimeMoscow(shiftStartMs) + '–' + formatTimeMoscow(times[0]));
      totalMs += times[0] - shiftStartMs;
    }
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap >= threshold) {
        idles.push(formatTimeMoscow(times[i - 1]) + '–' + formatTimeMoscow(times[i]));
        totalMs += gap;
      }
    }
    if (shiftEndMs > 0 && shiftEndMs - times[times.length - 1] >= threshold) {
      idles.push(formatTimeMoscow(times[times.length - 1]) + '–' + formatTimeMoscow(shiftEndMs));
      totalMs += shiftEndMs - times[times.length - 1];
    }
    if (idles.length) out[name] = { intervals: idles.join(', '), totalMinutes: Math.round(totalMs / 60000) };
  }
  return out;
}

/** Сводка по массиву операций. opts: { shift, getCompany, dateStr } для companySummary и hourlyByEmployee. */
function buildSummaryFromItems(items, opts = {}) {
  const { shift, getCompany, dateStr, idleThresholdMs } = opts;
  const taskKeys = new Set(items.map(i => getTaskKeySummary(i)));
  const totalOps = taskKeys.size;
  const totalQty = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  let totalWeightStorageGrams = 0;
  let totalWeightKdkGrams = 0;
  const weightByEmployee = new Map();
  const weightByCompany = new Map();
  const missingWeightMap = new Map(); // key -> {name, article}

  for (const item of items) {
    const type = (item.operationType || '').toUpperCase();
    const isKdk = type === 'PICK_BY_LINE';
    if (!isKdk && type !== 'PIECE_SELECTION_PICKING') continue;
    const name = item.productName || item.product || item.name;
    if (!name) continue;
    const article = String(item.nomenclatureCode || item.article || '').trim();
    const gramsPerUnit = productWeights.getWeightGrams(article) || parseWeightGramsFromName(name);
    if (gramsPerUnit <= 0) {
      const key = article || String(name).trim();
      if (!missingWeightMap.has(key)) missingWeightMap.set(key, { name: String(name).trim(), article });
      continue;
    }
    const qty = Math.max(1, Number(item.quantity) || 1);
    const grams = gramsPerUnit * qty;
    const emp = item.executor || 'Неизвестно';
    addWeight(weightByEmployee, emp, grams, isKdk);
    if (getCompany) {
      const c = getCompany(emp) || '—';
      addWeight(weightByCompany, c, grams, isKdk);
    }
    if (isKdk) totalWeightKdkGrams += grams;
    else totalWeightStorageGrams += grams;
  }

  const byExecutor = new Map();
  for (const item of items) {
    const key = item.executor || 'Неизвестно';
    if (!byExecutor.has(key)) byExecutor.set(key, { name: key, taskKeys: new Set(), qty: 0, firstAt: null, lastAt: null });
    const e = byExecutor.get(key);
    e.taskKeys.add(getTaskKeySummary(item));
    e.qty += Number(item.quantity) || 0;
    const ts = item.completedAt || item.startedAt;
    if (ts) {
      if (!e.firstAt || ts < e.firstAt) e.firstAt = ts;
      if (!e.lastAt || ts > e.lastAt) e.lastAt = ts;
    }
  }
  const executors = [...byExecutor.values()].map(e => ({
    name: e.name,
    ops: e.taskKeys.size,
    qty: e.qty,
    firstAt: e.firstAt,
    lastAt: e.lastAt,
  })).sort((a, b) => b.ops - a.ops);

  const FREEZER_ZONES = new Set(['KDM', 'MH']);
  const byHour = new Map();
  for (const item of items) {
    const ts = item.completedAt;
    if (!ts) continue;
    const moscow = new Date(new Date(ts).getTime() + MOSCOW_UTC_OFFSET_MS);
    const h = moscow.getUTCHours();
    if (!byHour.has(h)) byHour.set(h, { hour: h, taskKeys: new Set(), kdkTaskKeys: new Set(), employees: new Set(), komplEmployees: new Set(), employeeOpCounts: new Map(), storageOps: 0, kdkOps: 0 });
    const hh = byHour.get(h);
    const type = (item.operationType || '').toUpperCase();
    const isKdk = type === 'PICK_BY_LINE';
    const isStor = type === 'PIECE_SELECTION_PICKING';
    const tk = getTaskKeySummary(item);
    hh.taskKeys.add(tk);
    if (isKdk) hh.kdkTaskKeys.add(tk);
    else if (isStor) hh.storageOps++;
    hh.kdkOps = hh.kdkTaskKeys.size;
    const exec = item.executorId || item.executor;
    if (exec) {
      hh.employees.add(exec);
      const zone = (item.cell || '').split('-')[0].toUpperCase();
      if (!FREEZER_ZONES.has(zone)) hh.komplEmployees.add(exec);
      // Track per-employee op counts for dominant-operation assignment
      // kdkNonFreezer = PICK_BY_LINE в не-заморозочных зонах (KDS, KDH)
      // kdkFreezer    = PICK_BY_LINE в KDM (КДК заморозка) — исключается из обоих счётчиков
      // storage       = PIECE_SELECTION (все зоны, включая MH)
      if (isKdk || isStor) {
        if (!hh.employeeOpCounts.has(exec)) hh.employeeOpCounts.set(exec, { kdkNonFreezer: 0, kdkFreezer: 0, storage: 0, storageFreezer: 0 });
        const counts = hh.employeeOpCounts.get(exec);
        if (isStor && zone === 'MH') counts.storageFreezer++;
        else if (isStor) counts.storage++;
        else if (isKdk && zone === 'KDM') counts.kdkFreezer++;
        else if (isKdk) counts.kdkNonFreezer++;
      }
    }
  }
  const hourly = [...byHour.values()].map(x => {
    // Dominant-operation assignment:
    // kdkNonFreezer dominant → kdkEmployees (Кросс-докинг без заморозки)
    // storage dominant       → storageEmployees (Хранение)
    // kdkFreezer dominant    → не входит ни в один счётчик
    let kdkEmpCount = 0, storageEmpCount = 0;
    for (const counts of x.employeeOpCounts.values()) {
      const maxCount = Math.max(counts.kdkNonFreezer, counts.kdkFreezer, counts.storage, counts.storageFreezer);
      if (maxCount === 0) continue;
      if (counts.kdkNonFreezer === maxCount) kdkEmpCount++;
      else if (counts.storage === maxCount) storageEmpCount++;
      // kdkFreezer или storageFreezer dominant → excluded from both
    }
    return {
      hour: x.hour,
      ops: x.taskKeys.size,
      employees: x.employees.size,
      employeesKompl: x.komplEmployees.size,
      kdkEmployees: kdkEmpCount,
      storageEmployees: storageEmpCount,
      storageOps: x.storageOps,
      kdkOps: x.kdkOps,
    };
  }).sort((a, b) => a.hour - b.hour);

  let firstAt = null;
  let lastAt = null;
  for (const item of items) {
    const ts = item.completedAt;
    if (!ts) continue;
    if (!firstAt || ts < firstAt) firstAt = ts;
    if (!lastAt || ts > lastAt) lastAt = ts;
  }

  let companySummary = { rows: [], hoursDisplay: [] };
  let hourlyByEmployee = { hours: [], rows: [] };

  if (shift && dateStr) {
    const order = shift === 'night' ? NIGHT_HOURS_SUMMARY : DAY_HOURS_SUMMARY;
    const resolveCompany = (name) => (getCompany && name ? (getCompany(name) || '—') : '—');

    const byEmployeeHour = new Map();
    for (const item of items) {
      const ts = item.completedAt;
      if (!ts) continue;
      const moscow = new Date(new Date(ts).getTime() + MOSCOW_UTC_OFFSET_MS);
      const h = moscow.getUTCHours();
      const col = (h + 1) % 24;
      const name = item.executor || 'Неизвестно';
      if (!byEmployeeHour.has(name)) byEmployeeHour.set(name, new Map());
      const hourMap = byEmployeeHour.get(name);
      if (!hourMap.has(col)) hourMap.set(col, { pieceSelectionCount: 0, kdkSet: new Set(), weightGrams: 0, zoneCounts: {}, zoneWeights: {} });
      const cell = hourMap.get(col);
      const type = (item.operationType || '').toUpperCase();
      if (type === 'PIECE_SELECTION_PICKING') {
        cell.pieceSelectionCount++;
      } else if (type === 'PICK_BY_LINE') {
        const productId = item.nomenclatureCode || item.productName || 'no-product';
        const targetCell = item.cell || 'no-target-cell';
        cell.kdkSet.add(`${productId}||${targetCell}`);
      }
      if (type === 'PIECE_SELECTION_PICKING' || type === 'PICK_BY_LINE') {
        const zoneKey = (item.cell || '').split('-')[0].toUpperCase() || null;
        if (zoneKey) cell.zoneCounts[zoneKey] = (cell.zoneCounts[zoneKey] || 0) + 1;
        const productName = item.productName || item.product || item.name;
        if (productName) {
          const itemArticle = String(item.nomenclatureCode || item.article || '').trim();
          const gramsPerUnit = productWeights.getWeightGrams(itemArticle) || parseWeightGramsFromName(productName);
          if (gramsPerUnit > 0) {
            const qty = Math.max(1, parseNumber(item.quantity) || 1);
            const grams = gramsPerUnit * qty;
            cell.weightGrams += grams;
            if (zoneKey) cell.zoneWeights[zoneKey] = (cell.zoneWeights[zoneKey] || 0) + grams;
          }
        }
      }
    }

    const heRows = [];
    for (const [name, hourMap] of byEmployeeHour) {
      const byHourRow = {};
      const weightByHour = {};
      const byHourZone = {};
      const byZone = {};
      let total = 0;
      for (const col of order) {
        const cell = hourMap.get(col);
        if (!cell) { byHourRow[col] = 0; weightByHour[col] = 0; byHourZone[col] = null; continue; }
        const sz = cell.pieceSelectionCount + (cell.kdkSet ? cell.kdkSet.size : 0);
        byHourRow[col] = sz;
        weightByHour[col] = cell.weightGrams;
        // доминирующая зона: взвешенный скор = 0.5×(count/total) + 0.5×(weight/total)
        {
          const totalCnt = Object.values(cell.zoneCounts).reduce((s, v) => s + v, 0);
          const totalWg  = Object.values(cell.zoneWeights).reduce((s, v) => s + v, 0);
          const allZk = new Set([...Object.keys(cell.zoneCounts), ...Object.keys(cell.zoneWeights)]);
          let domKey = null, domScore = -1;
          for (const zk of allZk) {
            const scoreCnt = totalCnt > 0 ? (cell.zoneCounts[zk] || 0) / totalCnt : 0;
            const scoreWg  = totalWg  > 0 ? (cell.zoneWeights[zk] || 0) / totalWg  : 0;
            const score = totalWg > 0 ? (scoreCnt + scoreWg) / 2 : scoreCnt;
            if (score > domScore) { domScore = score; domKey = zk; }
          }
          byHourZone[col] = domKey;
        }
        for (const [zk, cnt] of Object.entries(cell.zoneCounts)) {
          if (!byZone[zk]) byZone[zk] = { count: 0, weightGrams: 0 };
          byZone[zk].count += cnt;
        }
        for (const [zk, wg] of Object.entries(cell.zoneWeights)) {
          if (!byZone[zk]) byZone[zk] = { count: 0, weightGrams: 0 };
          byZone[zk].weightGrams += wg;
        }
        total += sz;
      }
      const execInfo = byExecutor.get(name) || {};
      heRows.push({ name, company: resolveCompany(name), byHour: byHourRow, weightByHour, byHourZone, byZone, total, firstAt: execInfo.firstAt || null, lastAt: execInfo.lastAt || null });
    }

    hourlyByEmployee = { hours: order, rows: heRows };

    const byCompany = new Map();
    for (const r of heRows) {
      const c = r.company || '—';
      if (!byCompany.has(c)) byCompany.set(c, []);
      byCompany.get(c).push(r);
    }
    for (const arr of byCompany.values()) {
      arr.sort((a, b) => b.total - a.total);
    }

    // СЗ по типам на компанию
    const szByCompany = new Map();
    for (const item of items) {
      const type = (item.operationType || '').toUpperCase();
      const isKdk = type === 'PICK_BY_LINE';
      if (!isKdk && type !== 'PIECE_SELECTION_PICKING') continue;
      const c = resolveCompany(item.executor || 'Неизвестно');
      if (!szByCompany.has(c)) szByCompany.set(c, { storage: 0, kdk: 0 });
      const entry = szByCompany.get(c);
      if (isKdk) entry.kdk += 1; else entry.storage += 1;
    }

    const companyTotals = new Map();
    for (const [c, arr] of byCompany) {
      companyTotals.set(c, arr.reduce((s, r) => s + r.total, 0));
    }
    const companiesOrder = [...byCompany.keys()].sort((a, b) => (companyTotals.get(b) || 0) - (companyTotals.get(a) || 0));
    const hoursDisplay = getHoursDisplayForSummary(dateStr, shift);
    const passedHours = hoursDisplay.length;
    const rows = companiesOrder.map(c => {
      const companyRows = byCompany.get(c) || [];
      const employeesCount = companyRows.length;
      const totalTasks = companyRows.reduce((s, r) => s + r.total, 0);
      const szch = passedHours > 0 && employeesCount > 0 ? Math.round(totalTasks / employeesCount / passedHours) : 0;
      const byHour = {};
      for (const col of hoursDisplay) {
        byHour[col] = companyRows.reduce((s, r) => s + (r.byHour && r.byHour[col] ? r.byHour[col] : 0), 0);
      }
      const w = weightByCompany.get(c) || { storage: 0, kdk: 0, total: 0 };
      const sz = szByCompany.get(c) || { storage: 0, kdk: 0 };
      const vezch = passedHours > 0 && employeesCount > 0 ? Math.round(w.total / employeesCount / passedHours) : 0;
      const firstAtC = companyRows.reduce((min, r) => !r.firstAt ? min : (!min || r.firstAt < min ? r.firstAt : min), null);
      const lastAtC = companyRows.reduce((max, r) => !r.lastAt ? max : (!max || r.lastAt > max ? r.lastAt : max), null);
      return {
        companyName: c,
        employeesCount,
        szch,
        vezch,
        totalTasks,
        szStorage: sz.storage,
        szKdk: sz.kdk,
        byHour,
        weightStorageGrams: w.storage,
        weightKdkGrams: w.kdk,
        weightTotalGrams: w.total,
        firstAt: firstAtC,
        lastAt: lastAtC,
      };
    });
    companySummary = { rows, hoursDisplay };
  }

  let idleShiftStartMs = 0, idleShiftEndMs = 0;
  if (dateStr && shift) {
    const parts = dateStr.split('-').map(Number);
    const [y, m, d] = parts;
    const todayStr = getMoscowTodayStr();
    const isToday = dateStr === todayStr;
    if (shift === 'day') {
      idleShiftStartMs = Date.UTC(y, m - 1, d, 6, 0, 0);
      idleShiftEndMs = isToday ? Date.now() : Date.UTC(y, m - 1, d, 18, 0, 0);
    } else {
      // dateStr — дата НАЧАЛА ночной смены (часы 21–23 этой даты + часы 0–8 следующей)
      idleShiftStartMs = Date.UTC(y, m - 1, d, 18, 0, 0);
      const shiftEndFullMs = Date.UTC(y, m - 1, d + 1, 6, 0, 0);
      const shiftEndDateStr = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      idleShiftEndMs = shiftEndDateStr === todayStr ? Date.now() : shiftEndFullMs;
    }
  }
  const idlesByEmployee = calcIdlesByEmployeeSummary(items, idleThresholdMs, idleShiftStartMs, idleShiftEndMs);

  return {
    totalOps,
    totalQty,
    executors,
    hourly,
    firstAt,
    lastAt,
    companySummary,
    hourlyByEmployee,
    idlesByEmployee,
    totalWeightStorageGrams,
    totalWeightKdkGrams,
    totalWeightGrams: totalWeightStorageGrams + totalWeightKdkGrams,
    weightByEmployee: Object.fromEntries(weightByEmployee),
    weightByCompany: Object.fromEntries(weightByCompany),
    missingWeightNames: Array.from(missingWeightMap.values()).map(v => v.name),
    missingWeightItems: Array.from(missingWeightMap.values()),
  };
}

function getDateItems(dateStr, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return [];
  if (hasAnyHourlyData(dateStr)) {
    return getDateItemsFromHourly(dateStr, options);
  }
  // Fallback: смены из shift_YYYY-MM-DD_day|night (ночь для D = смена, начинающаяся в D 21:00)
  const nightShift = loadShift(dateStr + '_night');
  const dayShift = loadShift(dateStr + '_day');
  const byId = new Map();
  if (options.shift !== 'day') {
    for (const item of nightShift.items.values()) byId.set(item.id, item);
  }
  if (options.shift !== 'night') {
    for (const item of dayShift.items.values()) byId.set(item.id, item);
  }
  let items = Array.from(byId.values());
  items = items.map(i => (i.executor !== undefined ? i : toLightItem(i)));
  const ts = item => item.operationCompletedAt || item.operationStartedAt || '';
  items.sort((a, b) => ts(a).localeCompare(ts(b)));
  return items;
}

/** Файл с данными хранения (picking-selection) за дату и смену: data/YYYY-MM-DD/storage_day|night.json */
function storageDataFilePath(dateStr, shift) {
  const name = shift === 'night' ? 'storage_night.json' : 'storage_day.json';
  return path.join(hourlyDir(dateStr), name);
}

/** Сохранить данные хранения за дату и смену. payload: { totalStorageCount, storageByHour, totalWeightGrams, weightByEmployee }. */
function saveStorageForDate(dateStr, shift, payload) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !payload) return;
  ensureHourlyDir(dateStr);
  const fp = storageDataFilePath(dateStr, shift || 'day');
  const obj = {
    dateStr,
    shift: shift || 'day',
    totalStorageCount: Number(payload.totalStorageCount) || 0,
    storageByHour: payload.storageByHour && typeof payload.storageByHour === 'object' ? payload.storageByHour : {},
    totalWeightGrams: Number(payload.totalWeightGrams) || 0,
    weightByEmployee: payload.weightByEmployee && typeof payload.weightByEmployee === 'object' ? payload.weightByEmployee : {},
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(fp, JSON.stringify(obj), 'utf8');
}

/** Загрузить сохранённые данные хранения за дату и смену. */
function getStorageForDate(dateStr, shift) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const fp = storageDataFilePath(dateStr, shift || 'day');
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return {
      totalStorageCount: Number(raw.totalStorageCount) || 0,
      storageByHour: raw.storageByHour && typeof raw.storageByHour === 'object' ? raw.storageByHour : {},
      totalWeightGrams: Number(raw.totalWeightGrams) || 0,
      weightByEmployee: raw.weightByEmployee && typeof raw.weightByEmployee === 'object' ? raw.weightByEmployee : {},
    };
  } catch {
    return null;
  }
}

/** Колонки в таблицах: col = (hour + 1) % 24. Обратно: hour = (col - 1 + 24) % 24. */
function storageByHourToCols(storageByHour, cols) {
  const byHour = {};
  for (const col of cols) {
    const hour = (col - 1 + 24) % 24;
    byHour[col] = (storageByHour[hour] ?? 0) + (storageByHour[String(hour)] ?? 0);
  }
  return byHour;
}

/** Быстрая сводка за дату и смену. context: { getCompany(fio) } опционально для companySummary. */
function getDateSummary(dateStr, options = {}, context = {}) {
  let items = getDateItems(dateStr, options);
  if (options.filterExecutorNorm) {
    items = items.filter(it => normalizeFioSummary(it.executor) === options.filterExecutorNorm);
  }
  if (Array.isArray(options.filterCompanies) && options.filterCompanies.length > 0 && context.getCompany) {
    const allowed = new Set(options.filterCompanies.map(c => c.trim().toLowerCase()));
    items = items.filter(it => {
      const company = context.getCompany(it.executor);
      return company && allowed.has(company.trim().toLowerCase());
    });
  }
  return buildSummaryFromItems(items, {
    shift: options.shift,
    idleThresholdMs: options.idleThresholdMs,
    getCompany: context.getCompany,
    dateStr,
  });
}

// ─── Старые смены (для совместимости) ────────────────────────────────────────

function shiftFilePath(shiftKey) {
  return path.join(DATA_DIR, `shift_${shiftKey}.json`);
}

function loadShift(shiftKey) {
  const fp = shiftFilePath(shiftKey);
  if (!fs.existsSync(fp)) {
    return { shiftKey, updatedAt: null, items: new Map() };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const items = new Map();
    for (const item of Object.values(raw.items || {})) {
      const k = getMergeKey(item);
      if (!items.has(k)) items.set(k, item);
    }
    return { shiftKey, updatedAt: raw.updatedAt || null, items };
  } catch {
    return { shiftKey, updatedAt: null, items: new Map() };
  }
}

function saveShift(shiftData) {
  ensureDataDir();
  const { shiftKey, items } = shiftData;
  const fp = shiftFilePath(shiftKey);
  const obj = {
    shiftKey,
    updatedAt: new Date().toISOString(),
    items: Object.fromEntries(items),
  };
  fs.writeFileSync(fp, JSON.stringify(obj), 'utf8');
}

function getShiftItems(shiftKey) {
  const shift = loadShift(shiftKey);
  return Array.from(shift.items.values());
}

function listShifts() {
  ensureDataDir();
  if (!fs.existsSync(DATA_DIR)) return [];
  const result = [];
  const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name));
  for (const dir of dirs) {
    const dateStr = dir.name;
    const hourFiles = fs.readdirSync(path.join(DATA_DIR, dateStr)).filter(f => /^\d{2}\.json$/.test(f));
    let dayCount = 0;
    let nightCount = 0;
    let lastUpdated = null;
    for (const f of hourFiles) {
      const hour = parseInt(f.replace('.json', ''), 10);
      const fp = path.join(DATA_DIR, dateStr, f);
      const stat = fs.statSync(fp);
      if (lastUpdated === null || stat.mtime > lastUpdated) lastUpdated = stat.mtime;
      try {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const n = Array.isArray(raw.items) ? raw.items.length : Object.keys(raw.items || {}).length;
        if (hour >= 9 && hour < 21) dayCount += n;
        else if (hour >= 21) nightCount += n; // ночь для D: 21–23 по D (0–8 по D+1 добавляем ниже)
      } catch {}
    }
    const next = new Date(dateStr + 'T12:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    const nextStr = next.toISOString().slice(0, 10);
    if (fs.existsSync(hourlyDir(nextStr))) {
      for (const h of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        const m = loadHourly(nextStr, h);
        nightCount += m.size; // ночь для dateStr: 0–8 по dateStr+1
      }
    }
    if (dayCount > 0) result.push({ shiftKey: `${dateStr}_day`, date: dateStr, type: 'day', count: dayCount, updatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null, fileSize: null });
    if (nightCount > 0) result.push({ shiftKey: `${dateStr}_night`, date: dateStr, type: 'night', count: nightCount, updatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null, fileSize: null });
  }
  const shiftFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('shift_') && f.endsWith('.json'));
  for (const f of shiftFiles) {
    const shiftKey = f.replace('shift_', '').replace('.json', '');
    if (result.some(r => r.shiftKey === shiftKey)) continue;
    const stat = fs.statSync(path.join(DATA_DIR, f));
    const shift = loadShift(shiftKey);
    result.push({
      shiftKey,
      date: shiftKey.split('_')[0],
      type: shiftKey.split('_')[1],
      count: shift.items.size,
      updatedAt: shift.updatedAt,
      fileSize: stat.size,
    });
  }
  return result.sort((a, b) => (b.shiftKey || '').localeCompare(a.shiftKey || ''));
}

module.exports = {
  mergeOperations,
  getShiftItems,
  getDateItems,
  getDateSummary,
  listShifts,
  getCurrentShiftKey,
  getShiftKey,
  saveStorageForDate,
  getStorageForDate,
  DATA_DIR,
  ensureDataDir,
  toLightItem,
  getMergeKeyFromLight,
  getTaskKeySummary,
  computeEmployeeStatsForItems,
};
