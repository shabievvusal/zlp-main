/**
 * route-rk-storage.js — учёт отгрузки/приёмки РК по маршрутам
 *
 * Структура data/route-rk.json:
 * {
 *   "routeId": {
 *     "routeId": "uuid",
 *     "routeNumber": "20260321-1",
 *     "date": "2026-03-21",
 *     "driver": { "name": "Иванов И.И.", "phone": "..." },
 *     "vehicle": { "number": "А001АА78", "model": "Газель" },
 *     "logisticsCompany": "...",
 *     "cfzAddresses": [{ "address": "...", "storeId": "uuid" }],
 *     "importedAt": "ISO",
 *
 *     "shipment": null | {
 *       "by": "Фамилия И.О.",           // кладовщик
 *       "gate": "3",                    // ворота
 *       "at": "ISO",
 *       "photos": ["/rk-photos/x.jpg"],
 *       "items": [{ "address": "...", "rk": 5 }]
 *     },
 *     "receiving": null | {
 *       "by": "Фамилия И.О.",
 *       "gate": "2",
 *       "at": "ISO",
 *       "photos": ["/rk-photos/x.jpg"],
 *       "items": [{ "address": "...", "rk": 4 }]
 *     }
 *   }
 * }
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, 'data');
const RK_PATH   = path.join(DATA_DIR, 'route-rk.json');
const PHOTO_DIR = path.join(DATA_DIR, 'rk-photos');

function load() {
  try {
    if (!fs.existsSync(RK_PATH)) return {};
    return JSON.parse(fs.readFileSync(RK_PATH, 'utf-8'));
  } catch { return {}; }
}

function save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RK_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function ensurePhotoDir() {
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

// ─── WMS импорт ───────────────────────────────────────────────────────────────

function parseWmsRoute(json) {
  const route = json?.value ?? json;
  if (!route || !Array.isArray(route.stores)) throw new Error('Неверный формат маршрута');

  const date = (route.completedRouteDate || route.plannedRouteDate || '').slice(0, 10);
  const driver = route.vehicleDriver
    ? {
        name: [route.vehicleDriver.lastName, route.vehicleDriver.firstName].filter(Boolean).join(' '),
        phone: route.vehicleDriver.phone || '',
      }
    : null;
  const vehicle = route.vehicle
    ? { number: route.vehicle.number || '', model: route.vehicle.model || '' }
    : null;
  const logisticsCompany = route.logisticsCompany?.name || null;
  const cfzAddresses = (route.stores || [])
    .map(s => {
      const rawEos = Array.isArray(s.handlingUnits) ? s.handlingUnits
        : Array.isArray(s.parcels) ? s.parcels
        : Array.isArray(s.items) ? s.items : [];
      const eos = rawEos.map(eo => ({
        barcode: eo.barcode || eo.id || eo.handlingUnitBarcode || eo.code || null,
        weight: eo.weight ?? eo.grossWeight ?? null,
      })).filter(eo => eo.barcode);
      return { address: String(s.address || '').trim(), storeId: s.id || null, eos };
    })
    .filter(s => s.address);

  return { routeId: route.id || null, routeNumber: route.routeNumber || null, date, driver, vehicle, logisticsCompany, cfzAddresses };
}

function importRoute(json) {
  const parsed = parseWmsRoute(json);
  if (!parsed.routeId) throw new Error('Маршрут без ID');
  const data = load();
  const existing = data[parsed.routeId];
  if (existing) {
    // Preserve existing EOs if new import has none (e.g. re-import without WMS EO data)
    const mergedCfz = parsed.cfzAddresses.map(c => {
      const old = (existing.cfzAddresses || []).find(o => o.storeId === c.storeId);
      return (c.eos && c.eos.length > 0) ? c : { ...c, eos: old?.eos || [] };
    });
    data[parsed.routeId] = { ...existing, ...parsed, cfzAddresses: mergedCfz, shipment: existing.shipment, receiving: existing.receiving };
    save(data);
    return { added: 0, updated: 1 };
  }
  data[parsed.routeId] = { ...parsed, importedAt: new Date().toISOString(), shipment: null, receiving: null };
  save(data);
  return { added: 1, updated: 0 };
}

function importBulk(routeJsons) {
  const data = load();
  let added = 0, updated = 0;
  for (const json of routeJsons) {
    try {
      const parsed = parseWmsRoute(json);
      if (!parsed.routeId) continue;
      const existing = data[parsed.routeId];
      if (existing) {
        const mergedCfz = parsed.cfzAddresses.map(c => {
          const old = (existing.cfzAddresses || []).find(o => o.storeId === c.storeId);
          return (c.eos && c.eos.length > 0) ? c : { ...c, eos: old?.eos || [] };
        });
        data[parsed.routeId] = { ...existing, ...parsed, cfzAddresses: mergedCfz, shipment: existing.shipment, receiving: existing.receiving };
        updated++;
      } else {
        data[parsed.routeId] = { ...parsed, importedAt: new Date().toISOString(), shipment: null, receiving: null };
        added++;
      }
    } catch { /* пропускаем */ }
  }
  save(data);
  return { added, updated };
}

// ─── Отгрузка / Приёмка ───────────────────────────────────────────────────────

/**
 * Записать отгрузку по маршруту.
 * items: [{ address, rk }]
 * photos: массив имён файлов (уже сохранённых через savePhoto)
 */
function submitShipment(routeId, { by, gate, tempBefore, tempAfter, rokhlya, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  data[routeId].shipment = {
    by: by || null,
    gate: gate || null,
    tempBefore: tempBefore != null ? Number(tempBefore) : null,
    tempAfter: tempAfter != null ? Number(tempAfter) : null,
    rokhlya: rokhlya != null ? Number(rokhlya) : null,
    at: new Date().toISOString(),
    confirmed: false,
    confirmedAt: null,
    photos: photos || [],
    items: (items || []).map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0 })),
  };
  save(data);
  return withTotals(data[routeId]);
}

/**
 * Записать приёмку (возврат РК) по маршруту.
 */
function submitReceiving(routeId, { by, gate, rokhlya, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  data[routeId].receiving = {
    by: by || null,
    gate: gate || null,
    rokhlya: rokhlya != null ? Number(rokhlya) : null,
    at: new Date().toISOString(),
    confirmed: false,
    confirmedAt: null,
    photos: photos || [],
    items: (items || []).map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0 })),
  };
  save(data);
  return withTotals(data[routeId]);
}

// ─── Вычисляемые поля ─────────────────────────────────────────────────────────

function shippedTotal(route) {
  return (route.shipment?.items || []).reduce((s, i) => s + (i.rk || 0), 0);
}
function receivedTotal(route) {
  return (route.receiving?.items || []).reduce((s, i) => s + (i.rk || 0), 0);
}
function shippedPalletsTotal(route) {
  return (route.shipment?.items || []).reduce((s, i) => s + (i.pallets || 0), 0);
}
function receivedPalletsTotal(route) {
  return (route.receiving?.items || []).reduce((s, i) => s + (i.pallets || 0), 0);
}
function calcDiff(route) {
  if (!route.shipment || !route.receiving) return null;
  return receivedTotal(route) - shippedTotal(route);
}

// Маршрут считается не до конца отгруженным, если хотя бы один адрес ЦФЗ не имеет записи в items
function isPartialShipment(route) {
  if (!route.shipment) return true;
  const shipped = new Set((route.shipment.items || []).map(i => i.address));
  return (route.cfzAddresses || []).some(a => !shipped.has(a.address));
}

function isPartialReceiving(route) {
  if (!route.receiving) return true;
  const received = new Set((route.receiving.items || []).map(i => i.address));
  return (route.cfzAddresses || []).some(a => !received.has(a.address));
}

function withTotals(route) {
  const shipped  = route.shipment  ? shippedTotal(route)  : null;
  const received = route.receiving ? receivedTotal(route) : null;
  const shipRokhlya = route.shipment?.rokhlya ?? 0;
  const recvRokhlya = route.receiving?.rokhlya ?? 0;
  return {
    ...route,
    shippedRK:      shipped,
    receivedRK:     received,
    shippedPallets:  route.shipment  ? shippedPalletsTotal(route)  : null,
    receivedPallets: route.receiving ? receivedPalletsTotal(route) : null,
    shippedAt:  route.shipment?.at  || null,
    receivedAt: route.receiving?.at || null,
    diff: calcDiff(route),
    rokhlyaDebt: route.shipment ? shipRokhlya - recvRokhlya : null,
  };
}

// ─── Запросы ──────────────────────────────────────────────────────────────────

function getRoutes({ q, dateFrom, dateTo, status } = {}) {
  const data = load();
  let routes = Object.values(data).map(withTotals);

  if (status === 'unshipped') routes = routes.filter(r => isPartialShipment(r));
  else if (status === 'pending') routes = routes.filter(r => !isPartialShipment(r) && isPartialReceiving(r));
  else if (status === 'done')    routes = routes.filter(r => !isPartialShipment(r) && !isPartialReceiving(r));

  if (dateFrom) routes = routes.filter(r => r.date >= dateFrom);
  if (dateTo)   routes = routes.filter(r => r.date <= dateTo);

  if (q) {
    const ql = q.toLowerCase();
    routes = routes.filter(r =>
      (r.routeNumber || '').toLowerCase().includes(ql) ||
      (r.driver?.name || '').toLowerCase().includes(ql) ||
      (r.vehicle?.number || '').toLowerCase().includes(ql) ||
      (r.cfzAddresses || []).some(a => a.address.toLowerCase().includes(ql))
    );
  }

  return routes.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.routeNumber || '').localeCompare(a.routeNumber || '')
  );
}

function getByDriver({ q } = {}) {
  const data = load();
  const map = new Map();

  for (const raw of Object.values(data)) {
    const route = withTotals(raw);
    const name  = route.driver?.name || 'Неизвестно';
    if (q && !name.toLowerCase().includes(q.toLowerCase())) continue;

    if (!map.has(name)) {
      map.set(name, { name, phone: route.driver?.phone || '', routeCount: 0, shippedTotal: 0, receivedTotal: 0, shippedPallets: 0, receivedPallets: 0, shippedRokhlya: 0, receivedRokhlya: 0, routes: [] });
    }
    const d = map.get(name);
    d.routeCount++;
    if (route.shippedRK  != null) d.shippedTotal  += route.shippedRK;
    if (route.receivedRK != null) d.receivedTotal += route.receivedRK;
    if (route.shippedPallets  != null) d.shippedPallets  += route.shippedPallets;
    if (route.receivedPallets != null) d.receivedPallets += route.receivedPallets;
    if (route.shipment)  d.shippedRokhlya  += route.shipment.rokhlya  ?? 0;
    if (route.receiving) d.receivedRokhlya += route.receiving.rokhlya ?? 0;
    d.routes.push({
      routeId: route.routeId, routeNumber: route.routeNumber, date: route.date,
      vehicle: route.vehicle, cfzAddresses: route.cfzAddresses || [],
      shippedRK: route.shippedRK, receivedRK: route.receivedRK, diff: route.diff,
      shippedAt: route.shippedAt, receivedAt: route.receivedAt,
      shippedPallets: route.shippedPallets, receivedPallets: route.receivedPallets,
      shippedRokhlya: route.shipment?.rokhlya ?? 0,
      receivedRokhlya: route.receiving?.rokhlya ?? 0,
    });
  }

  return Array.from(map.values())
    .map(d => ({
      ...d,
      diff: d.shippedTotal > 0 || d.receivedTotal > 0 ? d.receivedTotal - d.shippedTotal : null,
      rokhlyaDebt: d.shippedRokhlya - d.receivedRokhlya,
      routes: d.routes.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getByCfz({ q } = {}) {
  const data = load();
  const map = new Map();

  for (const raw of Object.values(data)) {
    const route = withTotals(raw);
    for (const { address, storeId } of route.cfzAddresses || []) {
      if (!address) continue;
      if (q && !address.toLowerCase().includes(q.toLowerCase())) continue;

      if (!map.has(address)) {
        map.set(address, { address, storeId, routeCount: 0, shippedTotal: 0, receivedTotal: 0, shippedPallets: 0, receivedPallets: 0, routes: [] });
      }
      const c = map.get(address);
      c.routeCount++;

      // Per-CFZ shipped/received from items
      const shippedItem  = route.shipment?.items?.find(i => i.address === address);
      const receivedItem = route.receiving?.items?.find(i => i.address === address);
      const cfzShipped  = shippedItem?.rk  ?? null;
      const cfzReceived = receivedItem?.rk ?? null;
      const cfzShippedPallets = shippedItem?.pallets ?? null;
      const cfzReceivedPallets = receivedItem?.pallets ?? null;

      if (cfzShipped  != null) c.shippedTotal  += cfzShipped;
      if (cfzReceived != null) c.receivedTotal += cfzReceived;
      if (cfzShippedPallets != null) c.shippedPallets += cfzShippedPallets;
      if (cfzReceivedPallets != null) c.receivedPallets += cfzReceivedPallets;
      c.routes.push({
        routeId: route.routeId, routeNumber: route.routeNumber, date: route.date,
        driver: route.driver, vehicle: route.vehicle,
        shippedRK: cfzShipped, receivedRK: cfzReceived,
        shippedAt: route.shipment?.at  || null,
        receivedAt: route.receiving?.at || null,
        diff: cfzShipped != null && cfzReceived != null ? cfzReceived - cfzShipped : null,
        shippedPallets: cfzShippedPallets, receivedPallets: cfzReceivedPallets,
      });
    }
  }

  return Array.from(map.values())
    .map(c => ({
      ...c,
      diff: c.shippedTotal > 0 || c.receivedTotal > 0 ? c.receivedTotal - c.shippedTotal : null,
      routes: c.routes.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    }))
    .sort((a, b) => a.address.localeCompare(b.address, 'ru'));
}

function getDriversWithPending(q) {
  const data = load();
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();
  for (const raw of Object.values(data)) {
    if (isPartialShipment(raw) || !isPartialReceiving(raw) || !raw.cfzAddresses?.length) continue;
    const name = raw.driver?.name || 'Неизвестно';
    if (ql && !name.toLowerCase().includes(ql)) continue;
    if (!map.has(name)) map.set(name, { name, routeCount: 0, latestDate: raw.date });
    const d = map.get(name);
    d.routeCount++;
    if ((raw.date || '') > (d.latestDate || '')) d.latestDate = raw.date;
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getDriversUnshipped(q) {
  const data = load();
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();
  for (const raw of Object.values(data)) {
    if (!isPartialShipment(raw) || !raw.cfzAddresses?.length) continue;
    const name = raw.driver?.name || 'Неизвестно';
    if (ql && !name.toLowerCase().includes(ql)) continue;
    if (!map.has(name)) map.set(name, { name, routeCount: 0, latestDate: raw.date });
    const d = map.get(name);
    d.routeCount++;
    if ((raw.date || '') > (d.latestDate || '')) d.latestDate = raw.date;
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function getRoutesByDriverUnshipped(driverName) {
  const data = load();
  const name = String(driverName || '').trim();
  return Object.values(data)
    .filter(r => isPartialShipment(r) && r.driver?.name === name && r.cfzAddresses?.length)
    .map(withTotals)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function getRoutesByDriverPending(driverName) {
  const data = load();
  const name = String(driverName || '').trim();
  return Object.values(data)
    .filter(r => r.driver?.name === name)
    .map(withTotals)
    .filter(r => !isPartialShipment(r) && isPartialReceiving(r))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function getRouteById(routeId) {
  const data = load();
  return data[routeId] ? withTotals(data[routeId]) : null;
}

// ─── Редактирование ───────────────────────────────────────────────────────────

function updateShipment(routeId, { by, gate, tempBefore, tempAfter, rokhlya, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  // Если позиции не переданы или пусты — удаляем отгрузку
  if (!items || items.length === 0) {
    data[routeId].shipment = null;
    save(data);
    return withTotals(data[routeId]);
  }
  const ex = data[routeId].shipment;
  data[routeId].shipment = {
    by: by || ex?.by || null,
    gate: gate || ex?.gate || null,
    tempBefore: tempBefore != null ? Number(tempBefore) : (ex?.tempBefore ?? null),
    tempAfter: tempAfter != null ? Number(tempAfter) : (ex?.tempAfter ?? null),
    rokhlya: rokhlya != null ? Number(rokhlya) : (ex?.rokhlya ?? null),
    at: ex?.at || new Date().toISOString(),
    confirmed: ex?.confirmed || false,
    confirmedAt: ex?.confirmedAt || null,
    updatedAt: new Date().toISOString(),
    photos: photos != null ? photos : (ex?.photos || []),
    items: items.map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0 })),
  };
  save(data);
  return withTotals(data[routeId]);
}

function updateReceiving(routeId, { by, gate, rokhlya, items, photos }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  // Если позиции не переданы или пусты — удаляем приёмку
  if (!items || items.length === 0) {
    data[routeId].receiving = null;
    save(data);
    return withTotals(data[routeId]);
  }
  const ex = data[routeId].receiving;
  data[routeId].receiving = {
    by: by || ex?.by || null,
    gate: gate || ex?.gate || null,
    rokhlya: rokhlya != null ? Number(rokhlya) : (ex?.rokhlya ?? null),
    at: ex?.at || new Date().toISOString(),
    confirmed: ex?.confirmed || false,
    confirmedAt: ex?.confirmedAt || null,
    updatedAt: new Date().toISOString(),
    photos: photos != null ? photos : (ex?.photos || []),
    items: items.map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0 })),
  };
  save(data);
  return withTotals(data[routeId]);
}

// ─── Подтверждение ────────────────────────────────────────────────────────────

function confirmShipment(routeId, confirmedBy) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  if (!data[routeId].shipment) throw new Error('Нет данных об отгрузке');
  data[routeId].shipment.confirmed = true;
  data[routeId].shipment.confirmedAt = new Date().toISOString();
  data[routeId].shipment.confirmedBy = confirmedBy || null;
  save(data);
  return withTotals(data[routeId]);
}

function confirmReceiving(routeId, confirmedBy) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  if (!data[routeId].receiving) throw new Error('Нет данных о приёмке');
  data[routeId].receiving.confirmed = true;
  data[routeId].receiving.confirmedAt = new Date().toISOString();
  data[routeId].receiving.confirmedBy = confirmedBy || null;
  save(data);
  return withTotals(data[routeId]);
}

// ─── Фото ─────────────────────────────────────────────────────────────────────

function savePhoto(filename, buffer) {
  ensurePhotoDir();
  const filePath = path.join(PHOTO_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return `/rk-photos/${filename}`;
}

function getPhotoPath(filename) {
  return path.join(PHOTO_DIR, filename);
}

// ─── Список всех уникальных ЦФЗ-адресов ──────────────────────────────────────

function getAddresses() {
  const data = load();
  const set = new Set();
  for (const route of Object.values(data)) {
    for (const a of (route.cfzAddresses || [])) {
      if (a.address) set.add(a.address);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

// ─── Данные для Excel-отчёта ─────────────────────────────────────────────────

function getReportData(dateFrom, dateTo) {
  const data = load();
  // address -> shipDate -> { shipped }
  // address -> recvDate -> { received }
  // Отгрузка и приёмка могут быть в разные дни, поэтому храним раздельно
  // итоговая структура: address -> date -> { shipped, received }
  const map = new Map(); // address -> date -> { shipped: 0, received: null }

  function ensureCell(addr, date) {
    if (!map.has(addr)) map.set(addr, new Map());
    const dm = map.get(addr);
    if (!dm.has(date)) dm.set(date, { shipped: 0, received: null });
    return dm.get(date);
  }

  for (const route of Object.values(data)) {
    if (route.shipment) {
      const shipDate = (route.shipment.at || route.date || '').slice(0, 10);
      if (shipDate >= dateFrom && shipDate <= dateTo) {
        for (const item of (route.shipment.items || [])) {
          ensureCell(item.address, shipDate).shipped += item.rk;
        }
      }
    }

    if (route.receiving) {
      const recvDate = (route.receiving.at || route.date || '').slice(0, 10);
      if (recvDate >= dateFrom && recvDate <= dateTo) {
        for (const item of (route.receiving.items || [])) {
          const cell = ensureCell(item.address, recvDate);
          cell.received = (cell.received || 0) + item.rk;
        }
      }
    }
  }

  return [...map.entries()]
    .map(([address, dm]) => ({
      address,
      records: [...dm.entries()]
        .filter(([, v]) => v.shipped > 0 || v.received != null)
        .map(([date, v]) => ({ date, shipped: v.shipped, received: v.received }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .filter(e => e.records.length > 0)
    .sort((a, b) => String(a.address).localeCompare(String(b.address), 'ru'));
}

// ─── Удаление маршрутов за период ────────────────────────────────────────────

function deleteRoutesByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const data = load();
  let deleted = 0;
  for (const id of ids) {
    if (data[id]) { delete data[id]; deleted++; }
  }
  if (deleted) save(data);
  return deleted;
}

function deleteRoutesByDateRange(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) throw new Error('Укажите период');
  const data = load();
  let deleted = 0;
  for (const [id, route] of Object.entries(data)) {
    const d = (route.date || '').slice(0, 10);
    if (d >= dateFrom && d <= dateTo) {
      delete data[id];
      deleted++;
    }
  }
  save(data);
  return deleted;
}

// ─── ЕО (единицы отправления) ─────────────────────────────────────────────────

/**
 * Получить ЕО по маршруту: { storeId: { address, eos: [...] } }
 */
function getRouteEos(routeId) {
  const data = load();
  const route = data[routeId];
  if (!route) return null;
  const result = {};
  for (const cfz of (route.cfzAddresses || [])) {
    result[cfz.storeId] = { address: cfz.address, eos: cfz.eos || [], removedEos: cfz.removedEos || [] };
  }
  return result;
}

/**
 * Обновить ЕО одного ЦФЗ (после объединения в WMS).
 * Возвращает { current: [...], removed: [...] } — removed = были раньше, нет сейчас.
 */
function updateStoreEos(routeId, storeId, newEos) {
  const data = load();
  const route = data[routeId];
  if (!route) throw new Error('Маршрут не найден');
  const cfz = (route.cfzAddresses || []).find(c => c.storeId === storeId);
  if (!cfz) throw new Error('ЦФЗ не найден');

  const newBarcodes = new Set(newEos.map(e => e.barcode));
  const newlyRemoved = (cfz.eos || []).filter(e => !newBarcodes.has(e.barcode));

  // Накапливаем удалённые ЕО — не заменяем, а добавляем новые
  const existingRemoved = cfz.removedEos || [];
  const existingRemovedBarcodes = new Set(existingRemoved.map(e => e.barcode));
  const additionalRemoved = newlyRemoved.filter(e => !existingRemovedBarcodes.has(e.barcode));
  const allRemoved = [...existingRemoved, ...additionalRemoved];

  cfz.eos = newEos;
  cfz.removedEos = allRemoved;
  save(data);
  return { current: newEos, removed: allRemoved };
}

/**
 * Батчевое обновление ЕО по всем ЦФЗ маршрута за один load+save.
 * stores — массив объектов из WMS (store.id, store.handlingUnits/parcels/items).
 * Возвращает { storeId: { current, removed } }.
 */
function updateRouteEosBatch(routeId, stores) {
  const data = load();
  const route = data[routeId];
  if (!route) throw new Error('Маршрут не найден');

  const results = {};
  for (const store of stores) {
    const storeId = store.id;
    if (!storeId) continue;
    const cfz = (route.cfzAddresses || []).find(c => c.storeId === storeId);
    if (!cfz) continue;

    const rawEos = Array.isArray(store.handlingUnits) ? store.handlingUnits
      : Array.isArray(store.parcels) ? store.parcels
      : Array.isArray(store.items) ? store.items : [];
    const newEos = rawEos.map(eo => ({
      barcode: eo.barcode || eo.id || eo.handlingUnitBarcode || eo.code || null,
      weight: eo.weight ?? eo.grossWeight ?? null,
    })).filter(eo => eo.barcode);

    const newBarcodes = new Set(newEos.map(e => e.barcode));
    const newlyRemoved = (cfz.eos || []).filter(e => !newBarcodes.has(e.barcode));
    const existingRemoved = cfz.removedEos || [];
    const existingRemovedBarcodes = new Set(existingRemoved.map(e => e.barcode));
    const additionalRemoved = newlyRemoved.filter(e => !existingRemovedBarcodes.has(e.barcode));
    const allRemoved = [...existingRemoved, ...additionalRemoved];

    cfz.eos = newEos;
    cfz.removedEos = allRemoved;
    results[storeId] = { current: newEos, removed: allRemoved };
  }

  save(data);
  return results;
}

function updateRouteDriver(routeId, { name, phone }) {
  const data = load();
  if (!data[routeId]) throw new Error('Маршрут не найден');
  data[routeId].driver = {
    name: (name || '').trim() || null,
    phone: (phone != null ? phone : data[routeId].driver?.phone) || '',
  };
  save(data);
  return withTotals(data[routeId]);
}

module.exports = {
  importRoute, importBulk,
  submitShipment, submitReceiving,
  updateShipment, updateReceiving,
  updateRouteDriver,
  confirmShipment, confirmReceiving,
  getRoutes, getByDriver, getByCfz,
  getDriversWithPending, getRoutesByDriverPending, getRouteById,
  getDriversUnshipped, getRoutesByDriverUnshipped,
  savePhoto, getPhotoPath, PHOTO_DIR,
  deleteRoutesByIds, deleteRoutesByDateRange, getReportData, getAddresses,
  getRouteEos, updateStoreEos, updateRouteEosBatch,
};
