/**
 * migrate-json-to-pg.js — переносит данные из route-rk.json в PostgreSQL
 *
 * Запуск:
 *   docker exec zlp-main-node-1 node /app/backend/migrate-json-to-pg.js
 *
 * Переменные окружения: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const RK_PATH = path.join(__dirname, 'data', 'route-rk.json');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

async function main() {
  if (!fs.existsSync(RK_PATH)) {
    console.error('route-rk.json не найден:', RK_PATH);
    process.exit(1);
  }

  console.log('Читаем route-rk.json...');
  const data = JSON.parse(fs.readFileSync(RK_PATH, 'utf-8'));
  const routes = Object.values(data);
  console.log(`Найдено маршрутов: ${routes.length}`);

  console.log('Создаём таблицу...');
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

  console.log('Мигрируем данные...');
  const BATCH = 100;
  let inserted = 0, updated = 0, errors = 0;

  for (let i = 0; i < routes.length; i += BATCH) {
    const batch = routes.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of batch) {
        const routeId = r.routeId || r.id;
        if (!routeId) { errors++; continue; }
        try {
          const { rowCount } = await client.query(
            `INSERT INTO routes (route_id, route_number, date, driver, vehicle, logistics_company, cfz_addresses, imported_at, shipment, receiving)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (route_id) DO UPDATE SET
               route_number      = EXCLUDED.route_number,
               date              = EXCLUDED.date,
               driver            = EXCLUDED.driver,
               vehicle           = EXCLUDED.vehicle,
               logistics_company = EXCLUDED.logistics_company,
               cfz_addresses     = EXCLUDED.cfz_addresses,
               imported_at       = EXCLUDED.imported_at,
               shipment          = EXCLUDED.shipment,
               receiving         = EXCLUDED.receiving`,
            [
              routeId,
              r.routeNumber || null,
              r.date ? r.date.slice(0, 10) : null,
              JSON.stringify(r.driver || null),
              JSON.stringify(r.vehicle || null),
              r.logisticsCompany || null,
              JSON.stringify(r.cfzAddresses || []),
              r.importedAt || null,
              r.shipment ? JSON.stringify(r.shipment) : null,
              r.receiving ? JSON.stringify(r.receiving) : null,
            ]
          );
          if (rowCount) inserted++;
        } catch (e) {
          console.error(`Ошибка для маршрута ${routeId}:`, e.message);
          errors++;
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Ошибка батча:', e.message);
    } finally {
      client.release();
    }

    const done = Math.min(i + BATCH, routes.length);
    process.stdout.write(`\r${done}/${routes.length} (ошибок: ${errors})`);
  }

  const { rows } = await pool.query('SELECT COUNT(*) FROM routes');
  console.log(`\nГотово. В таблице routes: ${rows[0].count} записей, ошибок при вставке: ${errors}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
