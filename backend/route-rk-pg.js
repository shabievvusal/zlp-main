/**
 * route-rk-pg.js — PostgreSQL-реализация того же интерфейса что и route-rk-storage.js
 *
 * Включается через USE_PG=true в .env
 * Настройки: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */

const pg   = require('pg');
const { Pool } = pg;
const fs   = require('fs');
const path = require('path');

// Возвращаем DATE как строку "YYYY-MM-DD" вместо объекта Date
pg.types.setTypeParser(1082, val => val);

const DATA_DIR  = path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'rk-photos');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS routes (
      route_id          TEXT PRIMARY KEY,
      route_number      TEXT,
      date              DATE,
      driver            JSONB,
      vehicle           JSONB,
      logistics_company TEXT,
      cfz_addresses     JSONB NOT NULL DEFAULT '[]',
      imported_at       TIMESTAMPTZ,
      shipment          JSONB,
      receiving         JSONB
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS routes_date_idx ON routes (date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS routes_route_number_idx ON routes (route_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS routes_driver_name_idx ON routes ((driver->>'name'))`);
}

// ─── Row ↔ object ──────────────────────────────────────────────────────────────

function rowToRoute(row) {
  return {
    routeId:          row.route_id,
    routeNumber:      row.route_number,
    date:             row.date ? String(row.date).slice(0, 10) : null,
    driver:           row.driver,
    vehicle:          row.vehicle,
    logisticsCompany: row.logistics_company,
    cfzAddresses:     row.cfz_addresses || [],
    importedAt:       row.imported_at,
    shipment:         row.shipment,
    receiving:        row.receiving,
  };
}

// ─── Вычисляемые поля (идентичны route-rk-storage.js) ───────────────────────

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
function shippedBoxesTotal(route) {
  return (route.shipment?.items || []).reduce((s, i) => s + (i.boxes || 0), 0);
}
function receivedBoxesTotal(route) {
  return (route.receiving?.items || []).reduce((s, i) => s + (i.boxes || 0), 0);
}
function calcDiff(route) {
  if (!route.shipment || !route.receiving) return null;
  return receivedTotal(route) - shippedTotal(route);
}

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
  const shipped     = route.shipment  ? shippedTotal(route)  : null;
  const received    = route.receiving ? receivedTotal(route) : null;
  const shipRokhlya = route.shipment?.rokhlya ?? 0;
  const recvRokhlya = route.receiving?.rokhlya ?? 0;
  return {
    ...route,
    shippedRK:       shipped,
    receivedRK:      received,
    shippedPallets:  route.shipment  ? shippedPalletsTotal(route)  : null,
    receivedPallets: route.receiving ? receivedPalletsTotal(route) : null,
    shippedBoxes:    route.shipment  ? shippedBoxesTotal(route)    : null,
    receivedBoxes:   route.receiving ? receivedBoxesTotal(route)   : null,
    shippedAt:  route.shipment?.at  || null,
    receivedAt: route.receiving?.at || null,
    diff:        calcDiff(route),
    rokhlyaDebt: route.shipment ? shipRokhlya - recvRokhlya : null,
  };
}

// ─── WMS импорт ───────────────────────────────────────────────────────────────

function parseWmsRoute(json) {
  const route = json?.value ?? json;
  if (!route || !Array.isArray(route.stores)) throw new Error('Неверный формат маршрута');

  const date   = (route.completedRouteDate || route.plannedRouteDate || '').slice(0, 10);
  const driver = route.vehicleDriver
    ? { name: [route.vehicleDriver.lastName, route.vehicleDriver.firstName].filter(Boolean).join(' '), phone: route.vehicleDriver.phone || '' }
    : null;
  const vehicle = route.vehicle
    ? { number: route.vehicle.number || '', model: route.vehicle.model || '' }
    : null;
  const logisticsCompany = route.logisticsCompany?.name || null;
  const cfzAddresses = (route.stores || [])
    .map(s => {
      const rawEos = Array.isArray(s.handlingUnits) ? s.handlingUnits
        : Array.isArray(s.parcels) ? s.parcels
        : Array.isArray(s.items)   ? s.items : [];
      const eos = rawEos.map(eo => ({
        barcode: eo.barcode || eo.id || eo.handlingUnitBarcode || eo.code || null,
        weight:  eo.weight ?? eo.grossWeight ?? null,
      })).filter(eo => eo.barcode);
      return { address: String(s.address || '').trim(), storeId: s.id || null, eos };
    })
    .filter(s => s.address);

  return { routeId: route.id || null, routeNumber: route.routeNumber || null, date, driver, vehicle, logisticsCompany, cfzAddresses };
}

async function importRoute(json) {
  const parsed = parseWmsRoute(json);
  if (!parsed.routeId) throw new Error('Маршрут без ID');

  const { rows } = await pool.query('SELECT * FROM routes WHERE route_id = $1', [parsed.routeId]);
  if (rows.length) {
    const existing = rowToRoute(rows[0]);
    const mergedCfz = parsed.cfzAddresses.map(c => {
      const old = (existing.cfzAddresses || []).find(o => o.storeId === c.storeId);
      return (c.eos && c.eos.length > 0) ? c : { ...c, eos: old?.eos || [] };
    });
    await pool.query(
      `UPDATE routes SET route_number=$2, date=$3, driver=$4, vehicle=$5, logistics_company=$6, cfz_addresses=$7 WHERE route_id=$1`,
      [parsed.routeId, parsed.routeNumber, parsed.date || null, JSON.stringify(parsed.driver), JSON.stringify(parsed.vehicle),
       parsed.logisticsCompany, JSON.stringify(mergedCfz)]
    );
    return { added: 0, updated: 1 };
  }

  await pool.query(
    `INSERT INTO routes (route_id, route_number, date, driver, vehicle, logistics_company, cfz_addresses, imported_at, shipment, receiving)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL)`,
    [parsed.routeId, parsed.routeNumber, parsed.date || null, JSON.stringify(parsed.driver), JSON.stringify(parsed.vehicle),
     parsed.logisticsCompany, JSON.stringify(parsed.cfzAddresses), new Date().toISOString()]
  );
  return { added: 1, updated: 0 };
}

async function importBulk(routeJsons) {
  let added = 0, updated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const json of routeJsons) {
      try {
        const parsed = parseWmsRoute(json);
        if (!parsed.routeId) continue;
        const { rows } = await client.query('SELECT cfz_addresses, shipment, receiving FROM routes WHERE route_id=$1', [parsed.routeId]);
        if (rows.length) {
          const existing = rowToRoute(rows[0]);
          const mergedCfz = parsed.cfzAddresses.map(c => {
            const old = (existing.cfzAddresses || []).find(o => o.storeId === c.storeId);
            return (c.eos && c.eos.length > 0) ? c : { ...c, eos: old?.eos || [] };
          });
          await client.query(
            `UPDATE routes SET route_number=$2, date=$3, driver=$4, vehicle=$5, logistics_company=$6, cfz_addresses=$7 WHERE route_id=$1`,
            [parsed.routeId, parsed.routeNumber, parsed.date || null, JSON.stringify(parsed.driver), JSON.stringify(parsed.vehicle),
             parsed.logisticsCompany, JSON.stringify(mergedCfz)]
          );
          updated++;
        } else {
          await client.query(
            `INSERT INTO routes (route_id, route_number, date, driver, vehicle, logistics_company, cfz_addresses, imported_at, shipment, receiving)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL)`,
            [parsed.routeId, parsed.routeNumber, parsed.date || null, JSON.stringify(parsed.driver), JSON.stringify(parsed.vehicle),
             parsed.logisticsCompany, JSON.stringify(parsed.cfzAddresses), new Date().toISOString()]
          );
          added++;
        }
      } catch { /* пропускаем */ }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { added, updated };
}

// ─── Отгрузка / Приёмка ───────────────────────────────────────────────────────

async function submitShipment(routeId, { by, gate, tempBefore, tempAfter, rokhlya, items, photos }) {
  const shipment = {
    by: by || null, gate: gate || null,
    tempBefore: tempBefore != null ? Number(tempBefore) : null,
    tempAfter:  tempAfter  != null ? Number(tempAfter)  : null,
    rokhlya:    rokhlya    != null ? Number(rokhlya)    : null,
    at: new Date().toISOString(),
    confirmed: false, confirmedAt: null,
    photos: photos || [],
    items: (items || []).map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0, boxes: i.boxes != null ? Number(i.boxes) : 0 })),
  };
  const { rows } = await pool.query(
    'UPDATE routes SET shipment=$2 WHERE route_id=$1 RETURNING *',
    [routeId, JSON.stringify(shipment)]
  );
  if (!rows.length) throw new Error('Маршрут не найден');
  return withTotals(rowToRoute(rows[0]));
}

async function submitReceiving(routeId, { by, gate, rokhlya, items, photos }) {
  const receiving = {
    by: by || null, gate: gate || null,
    rokhlya: rokhlya != null ? Number(rokhlya) : null,
    at: new Date().toISOString(),
    confirmed: false, confirmedAt: null,
    photos: photos || [],
    items: (items || []).map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0, boxes: i.boxes != null ? Number(i.boxes) : 0 })),
  };
  const { rows } = await pool.query(
    'UPDATE routes SET receiving=$2 WHERE route_id=$1 RETURNING *',
    [routeId, JSON.stringify(receiving)]
  );
  if (!rows.length) throw new Error('Маршрут не найден');
  return withTotals(rowToRoute(rows[0]));
}

async function updateShipment(routeId, { by, gate, tempBefore, tempAfter, rokhlya, items, photos }) {
  const { rows: cur } = await pool.query('SELECT shipment FROM routes WHERE route_id=$1', [routeId]);
  if (!cur.length) throw new Error('Маршрут не найден');

  if (!items || items.length === 0) {
    const { rows } = await pool.query('UPDATE routes SET shipment=NULL WHERE route_id=$1 RETURNING *', [routeId]);
    return withTotals(rowToRoute(rows[0]));
  }

  const ex = cur[0].shipment || {};
  const shipment = {
    by:        by        || ex.by        || null,
    gate:      gate      || ex.gate      || null,
    tempBefore: tempBefore != null ? Number(tempBefore) : (ex.tempBefore ?? null),
    tempAfter:  tempAfter  != null ? Number(tempAfter)  : (ex.tempAfter  ?? null),
    rokhlya:    rokhlya    != null ? Number(rokhlya)    : (ex.rokhlya    ?? null),
    at:         ex.at || new Date().toISOString(),
    confirmed:  ex.confirmed || false,
    confirmedAt: ex.confirmedAt || null,
    updatedAt:  new Date().toISOString(),
    photos: photos != null ? photos : (ex.photos || []),
    items: items.map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0, boxes: i.boxes != null ? Number(i.boxes) : 0 })),
  };
  const { rows } = await pool.query('UPDATE routes SET shipment=$2 WHERE route_id=$1 RETURNING *', [routeId, JSON.stringify(shipment)]);
  return withTotals(rowToRoute(rows[0]));
}

async function updateReceiving(routeId, { by, gate, rokhlya, items, photos }) {
  const { rows: cur } = await pool.query('SELECT receiving FROM routes WHERE route_id=$1', [routeId]);
  if (!cur.length) throw new Error('Маршрут не найден');

  if (!items || items.length === 0) {
    const { rows } = await pool.query('UPDATE routes SET receiving=NULL WHERE route_id=$1 RETURNING *', [routeId]);
    return withTotals(rowToRoute(rows[0]));
  }

  const ex = cur[0].receiving || {};
  const receiving = {
    by:      by      || ex.by      || null,
    gate:    gate    || ex.gate    || null,
    rokhlya: rokhlya != null ? Number(rokhlya) : (ex.rokhlya ?? null),
    at:      ex.at || new Date().toISOString(),
    confirmed:   ex.confirmed   || false,
    confirmedAt: ex.confirmedAt || null,
    updatedAt:   new Date().toISOString(),
    photos: photos != null ? photos : (ex.photos || []),
    items: items.map(i => ({ address: String(i.address), rk: Number(i.rk), pallets: i.pallets != null ? Number(i.pallets) : 0, boxes: i.boxes != null ? Number(i.boxes) : 0 })),
  };
  const { rows } = await pool.query('UPDATE routes SET receiving=$2 WHERE route_id=$1 RETURNING *', [routeId, JSON.stringify(receiving)]);
  return withTotals(rowToRoute(rows[0]));
}

async function confirmShipment(routeId, confirmedBy) {
  const { rows: cur } = await pool.query('SELECT shipment FROM routes WHERE route_id=$1', [routeId]);
  if (!cur.length) throw new Error('Маршрут не найден');
  if (!cur[0].shipment) throw new Error('Нет данных об отгрузке');
  const s = { ...cur[0].shipment, confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy: confirmedBy || null };
  const { rows } = await pool.query('UPDATE routes SET shipment=$2 WHERE route_id=$1 RETURNING *', [routeId, JSON.stringify(s)]);
  return withTotals(rowToRoute(rows[0]));
}

async function confirmReceiving(routeId, confirmedBy) {
  const { rows: cur } = await pool.query('SELECT receiving FROM routes WHERE route_id=$1', [routeId]);
  if (!cur.length) throw new Error('Маршрут не найден');
  if (!cur[0].receiving) throw new Error('Нет данных о приёмке');
  const r = { ...cur[0].receiving, confirmed: true, confirmedAt: new Date().toISOString(), confirmedBy: confirmedBy || null };
  const { rows } = await pool.query('UPDATE routes SET receiving=$2 WHERE route_id=$1 RETURNING *', [routeId, JSON.stringify(r)]);
  return withTotals(rowToRoute(rows[0]));
}

async function updateRouteDriver(routeId, { name, phone }) {
  const { rows: cur } = await pool.query('SELECT driver FROM routes WHERE route_id=$1', [routeId]);
  if (!cur.length) throw new Error('Маршрут не найден');
  const driver = {
    name:  (name || '').trim() || null,
    phone: (phone != null ? phone : cur[0].driver?.phone) || '',
  };
  const { rows } = await pool.query('UPDATE routes SET driver=$2 WHERE route_id=$1 RETURNING *', [routeId, JSON.stringify(driver)]);
  return withTotals(rowToRoute(rows[0]));
}

// ─── Запросы ──────────────────────────────────────────────────────────────────

async function getRoutes({ q, dateFrom, dateTo, receivedDateFrom, receivedDateTo, status } = {}) {
  let sql = 'SELECT * FROM routes WHERE 1=1';
  const params = [];

  // Фильтрация по статусу на уровне SQL — сильно сокращает выборку
  if (status === 'unshipped') {
    sql += ' AND shipment IS NULL';
  } else if (status === 'pending') {
    sql += ' AND shipment IS NOT NULL';
  } else if (status === 'done') {
    sql += ' AND shipment IS NOT NULL AND receiving IS NOT NULL';
  }

  if (dateFrom) { params.push(dateFrom); sql += ` AND date >= $${params.length}::date`; }
  if (dateTo)   { params.push(dateTo);   sql += ` AND date <= $${params.length}::date`; }
  if (receivedDateFrom) { params.push(receivedDateFrom); sql += ` AND (receiving->>'at')::date >= $${params.length}::date`; }
  if (receivedDateTo)   { params.push(receivedDateTo);   sql += ` AND (receiving->>'at')::date <= $${params.length}::date`; }

  // Для статусных запросов без явной даты — ограничиваем 90 днями
  if (status && !dateFrom && !dateTo) {
    params.push(90);
    sql += ` AND date >= (CURRENT_DATE - ($${params.length} || ' days')::interval)::date`;
  }

  sql += ' ORDER BY date DESC NULLS LAST';

  const { rows } = await pool.query(sql, params);
  let routes = rows.map(r => withTotals(rowToRoute(r)));

  // JS-фильтрация только там где SQL недостаточен (частичная приёмка/отгрузка)
  if (status === 'unshipped') routes = routes.filter(r => isPartialShipment(r));
  else if (status === 'pending') routes = routes.filter(r => !isPartialShipment(r) && isPartialReceiving(r));

  if (q) {
    const ql = String(q).trim().toLowerCase();
    routes = routes.filter(r =>
      (r.routeNumber || '').toLowerCase().includes(ql) ||
      (r.driver?.name || '').toLowerCase().includes(ql) ||
      (r.vehicle?.number || '').toLowerCase().includes(ql) ||
      (r.logisticsCompany || '').toLowerCase().includes(ql) ||
      (r.cfzAddresses || []).some(a => (a.address || '').toLowerCase().includes(ql))
    );
  }

  return routes;
}

async function getRouteById(routeId) {
  const { rows } = await pool.query('SELECT * FROM routes WHERE route_id=$1', [routeId]);
  return rows.length ? withTotals(rowToRoute(rows[0])) : null;
}

async function getByDriver({ q } = {}) {
  const { rows } = await pool.query('SELECT * FROM routes ORDER BY date DESC NULLS LAST');
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();

  for (const raw of rows) {
    const route = withTotals(rowToRoute(raw));
    const name  = route.driver?.name || '(без водителя)';
    if (ql && !name.toLowerCase().includes(ql)) continue;
    if (!map.has(name)) map.set(name, { name, routes: [] });
    map.get(name).routes.push(route);
  }

  return Array.from(map.values())
    .map(d => ({ ...d, routes: d.routes.sort((a, b) => (b.date || '').localeCompare(a.date || '')) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function getByCfz({ q } = {}) {
  const { rows } = await pool.query('SELECT * FROM routes ORDER BY date DESC NULLS LAST');
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();

  for (const raw of rows) {
    const route = withTotals(rowToRoute(raw));
    for (const cfz of (route.cfzAddresses || [])) {
      const addr = cfz.address || '';
      if (ql && !addr.toLowerCase().includes(ql) && !(route.driver?.name || '').toLowerCase().includes(ql)) continue;
      if (!map.has(addr)) map.set(addr, { address: addr, routes: [] });
      map.get(addr).routes.push(route);
    }
  }

  return Array.from(map.values())
    .map(c => ({ ...c, routes: c.routes.sort((a, b) => (b.date || '').localeCompare(a.date || '')) }))
    .sort((a, b) => a.address.localeCompare(b.address, 'ru'));
}

async function getDriversWithPending(q) {
  const { rows } = await pool.query(
    `SELECT * FROM routes WHERE shipment IS NOT NULL
     AND date >= (CURRENT_DATE - '90 days'::interval)::date`
  );
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();

  for (const raw of rows) {
    const route = rowToRoute(raw);
    if (isPartialShipment(route) || !isPartialReceiving(route) || !route.cfzAddresses?.length) continue;
    const name = route.driver?.name || '';
    if (ql && !name.toLowerCase().includes(ql)) continue;
    if (!map.has(name)) map.set(name, { name, phone: route.driver?.phone || '', routeCount: 0, latestDate: '' });
    const d = map.get(name);
    d.routeCount++;
    if ((route.date || '') > (d.latestDate || '')) d.latestDate = route.date;
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function getRoutesByDriverPending(driverName) {
  const { rows } = await pool.query(`SELECT * FROM routes WHERE driver->>'name' = $1`, [driverName]);
  return rows.map(rowToRoute).map(withTotals).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function getDriversUnshipped(q) {
  const { rows } = await pool.query(
    `SELECT * FROM routes WHERE shipment IS NULL
     AND date >= (CURRENT_DATE - '90 days'::interval)::date`
  );
  const ql = String(q || '').trim().toLowerCase();
  const map = new Map();

  for (const raw of rows) {
    const route = rowToRoute(raw);
    if (!isPartialShipment(route) || !route.cfzAddresses?.length) continue;
    const name = route.driver?.name || '';
    if (ql && !name.toLowerCase().includes(ql)) continue;
    if (!map.has(name)) map.set(name, { name, phone: route.driver?.phone || '', routeCount: 0, latestDate: '' });
    const d = map.get(name);
    d.routeCount++;
    if ((route.date || '') > (d.latestDate || '')) d.latestDate = route.date;
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function getRoutesByDriverUnshipped(driverName) {
  const { rows } = await pool.query(
    `SELECT * FROM routes WHERE driver->>'name' = $1 ORDER BY date DESC NULLS LAST`,
    [driverName]
  );
  return rows.map(rowToRoute).filter(r => isPartialShipment(r) && r.cfzAddresses?.length).map(withTotals);
}

async function getAddresses() {
  const { rows } = await pool.query('SELECT cfz_addresses FROM routes');
  const set = new Set();
  for (const row of rows) {
    for (const a of (row.cfz_addresses || [])) {
      if (a.address) set.add(a.address);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

async function getReportData(dateFrom, dateTo) {
  const { rows } = await pool.query('SELECT * FROM routes');
  const map = new Map();

  function ensureCell(addr, date) {
    if (!map.has(addr)) map.set(addr, new Map());
    const dm = map.get(addr);
    if (!dm.has(date)) dm.set(date, { shipped: 0, received: null });
    return dm.get(date);
  }

  for (const raw of rows) {
    const route = rowToRoute(raw);
    if (route.shipment) {
      const shipDate = (route.shipment.at || route.date || '').slice(0, 10);
      if (shipDate >= dateFrom && shipDate <= dateTo) {
        for (const item of (route.shipment.items || [])) ensureCell(item.address, shipDate).shipped += item.rk;
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

async function deleteRoutesByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM routes WHERE route_id = ANY($1::text[])`,
    [ids]
  );
  return rowCount;
}

async function deleteRoutesByDateRange(dateFrom, dateTo) {
  if (!dateFrom || !dateTo) throw new Error('Укажите период');
  const { rowCount } = await pool.query(
    `DELETE FROM routes WHERE date >= $1::date AND date <= $2::date`,
    [dateFrom, dateTo]
  );
  return rowCount;
}

// ─── ЕО ───────────────────────────────────────────────────────────────────────

async function getRouteEos(routeId) {
  const { rows } = await pool.query('SELECT cfz_addresses FROM routes WHERE route_id=$1', [routeId]);
  if (!rows.length) return null;
  const result = {};
  for (const cfz of (rows[0].cfz_addresses || [])) {
    result[cfz.storeId] = { address: cfz.address, eos: cfz.eos || [], removedEos: cfz.removedEos || [] };
  }
  return result;
}

async function updateStoreEos(routeId, storeId, newEos) {
  const { rows } = await pool.query('SELECT cfz_addresses FROM routes WHERE route_id=$1', [routeId]);
  if (!rows.length) throw new Error('Маршрут не найден');
  const cfzAddresses = rows[0].cfz_addresses || [];
  const cfz = cfzAddresses.find(c => c.storeId === storeId);
  if (!cfz) throw new Error('ЦФЗ не найден');

  const newBarcodes = new Set(newEos.map(e => e.barcode));
  const newlyRemoved = (cfz.eos || []).filter(e => !newBarcodes.has(e.barcode));
  const existingRemoved = cfz.removedEos || [];
  const existingRemovedBarcodes = new Set(existingRemoved.map(e => e.barcode));
  const allRemoved = [...existingRemoved, ...newlyRemoved.filter(e => !existingRemovedBarcodes.has(e.barcode))];

  cfz.eos = newEos;
  cfz.removedEos = allRemoved;

  await pool.query('UPDATE routes SET cfz_addresses=$2 WHERE route_id=$1', [routeId, JSON.stringify(cfzAddresses)]);
  return { current: newEos, removed: allRemoved };
}

async function updateRouteEosBatch(routeId, stores) {
  const { rows } = await pool.query('SELECT cfz_addresses FROM routes WHERE route_id=$1', [routeId]);
  if (!rows.length) throw new Error('Маршрут не найден');
  const cfzAddresses = rows[0].cfz_addresses || [];
  const results = {};

  for (const store of stores) {
    const storeId = store.id;
    if (!storeId) continue;
    const cfz = cfzAddresses.find(c => c.storeId === storeId);
    if (!cfz) continue;

    const rawEos = Array.isArray(store.handlingUnits) ? store.handlingUnits
      : Array.isArray(store.parcels) ? store.parcels
      : Array.isArray(store.items)   ? store.items : [];
    const newEos = rawEos.map(eo => ({
      barcode: eo.barcode || eo.id || eo.handlingUnitBarcode || eo.code || null,
      weight:  eo.weight ?? eo.grossWeight ?? null,
    })).filter(eo => eo.barcode);

    const newBarcodes = new Set(newEos.map(e => e.barcode));
    const newlyRemoved = (cfz.eos || []).filter(e => !newBarcodes.has(e.barcode));
    const existingRemoved = cfz.removedEos || [];
    const existingRemovedBarcodes = new Set(existingRemoved.map(e => e.barcode));
    const allRemoved = [...existingRemoved, ...newlyRemoved.filter(e => !existingRemovedBarcodes.has(e.barcode))];

    cfz.eos = newEos;
    cfz.removedEos = allRemoved;
    results[storeId] = { current: newEos, removed: allRemoved };
  }

  await pool.query('UPDATE routes SET cfz_addresses=$2 WHERE route_id=$1', [routeId, JSON.stringify(cfzAddresses)]);
  return results;
}

// ─── Фото ─────────────────────────────────────────────────────────────────────

function ensurePhotoDir() {
  if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

function savePhoto(filename, buffer) {
  ensurePhotoDir();
  fs.writeFileSync(path.join(PHOTO_DIR, filename), buffer);
  return `/rk-photos/${filename}`;
}

function getPhotoPath(filename) {
  return path.join(PHOTO_DIR, filename);
}

// ─── Поиск маршрутов (для страницы кладовщика) ────────────────────────────────

async function searchRoutes({ q, mode } = {}) {
  const { rows } = await pool.query('SELECT * FROM routes ORDER BY date DESC NULLS LAST');
  const ql = String(q || '').trim().toLowerCase();
  let routes = rows.map(rowToRoute);

  if (mode === 'unshipped') routes = routes.filter(r => isPartialShipment(r));
  else if (mode === 'pending') routes = routes.filter(r => !isPartialShipment(r) && isPartialReceiving(r));

  if (ql) {
    routes = routes.filter(r =>
      (r.routeNumber || '').toLowerCase().includes(ql) ||
      (r.driver?.name || '').toLowerCase().includes(ql) ||
      (r.vehicle?.number || '').toLowerCase().includes(ql) ||
      (r.cfzAddresses || []).some(a => (a.address || '').toLowerCase().includes(ql))
    );
  }

  return routes.map(withTotals);
}

module.exports = {
  init,
  importRoute, importBulk,
  submitShipment, submitReceiving,
  updateShipment, updateReceiving,
  updateRouteDriver,
  confirmShipment, confirmReceiving,
  getRoutes, getRouteById,
  getByDriver, getByCfz,
  getDriversWithPending, getRoutesByDriverPending,
  getDriversUnshipped, getRoutesByDriverUnshipped,
  searchRoutes,
  savePhoto, getPhotoPath, PHOTO_DIR,
  getAddresses,
  getReportData,
  deleteRoutesByIds, deleteRoutesByDateRange,
  getRouteEos, updateStoreEos, updateRouteEosBatch,
};
