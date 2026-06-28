/**
 * tsd-pg.js — PostgreSQL-хранилище выдачи ТСД.
 *
 * Активная выдача: returned_at IS NULL.
 * История сохраняется строками, чтобы позже можно было строить журнал.
 */

const pg = require('pg');
const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function toAssignment(row) {
  return {
    id: row.id,
    executorId: row.executor_id,
    fio: row.fio || '',
    company: row.company || '',
    tsd: row.tsd,
    assignedAt: row.assigned_at instanceof Date ? row.assigned_at.toISOString() : row.assigned_at,
    returnedAt: row.returned_at instanceof Date ? row.returned_at.toISOString() : row.returned_at,
    returnedByExecutorId: row.returned_by_executor_id || '',
    returnedByFio: row.returned_by_fio || '',
    returnedByCompany: row.returned_by_company || '',
  };
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tsd_assignments (
      id          BIGSERIAL PRIMARY KEY,
      executor_id TEXT NOT NULL,
      fio         TEXT NOT NULL DEFAULT '',
      company     TEXT NOT NULL DEFAULT '',
      tsd         TEXT NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      returned_at TIMESTAMPTZ NULL,
      returned_by_executor_id TEXT NOT NULL DEFAULT '',
      returned_by_fio TEXT NOT NULL DEFAULT '',
      returned_by_company TEXT NOT NULL DEFAULT ''
    )
  `);
  await pool.query('ALTER TABLE tsd_assignments ADD COLUMN IF NOT EXISTS returned_by_executor_id TEXT NOT NULL DEFAULT \'\'');
  await pool.query('ALTER TABLE tsd_assignments ADD COLUMN IF NOT EXISTS returned_by_fio TEXT NOT NULL DEFAULT \'\'');
  await pool.query('ALTER TABLE tsd_assignments ADD COLUMN IF NOT EXISTS returned_by_company TEXT NOT NULL DEFAULT \'\'');
  await pool.query('DROP INDEX IF EXISTS tsd_assignments_active_executor_idx');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tsd_assignments_active_tsd_idx
    ON tsd_assignments (tsd)
    WHERE returned_at IS NULL
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS tsd_assignments_assigned_at_idx ON tsd_assignments (assigned_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tsd_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
}

async function listActive() {
  const { rows } = await pool.query(`
    SELECT id, executor_id, fio, company, tsd, assigned_at, returned_at,
           returned_by_executor_id, returned_by_fio, returned_by_company
    FROM tsd_assignments
    WHERE returned_at IS NULL
    ORDER BY assigned_at DESC
  `);
  return rows.map(toAssignment);
}

async function assign({ executorId, fio, company, tsd }) {
  const id = clean(executorId);
  const name = clean(fio);
  const comp = clean(company);
  const device = clean(tsd);
  if (!id) throw new Error('executorId обязателен');
  if (!device) throw new Error('Номер ТСД обязателен');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tsd_assignments
       SET returned_at = now()
       WHERE returned_at IS NULL AND tsd = $1`,
      [device]
    );
    const { rows } = await client.query(
      `INSERT INTO tsd_assignments (executor_id, fio, company, tsd)
       VALUES ($1, $2, $3, $4)
       RETURNING id, executor_id, fio, company, tsd, assigned_at, returned_at,
                 returned_by_executor_id, returned_by_fio, returned_by_company`,
      [id, name, comp, device]
    );
    await client.query('COMMIT');
    return toAssignment(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function returnByExecutor(executorId) {
  const id = clean(executorId);
  if (!id) throw new Error('executorId обязателен');
  const { rows } = await pool.query(
    `UPDATE tsd_assignments
     SET returned_at = now()
     WHERE executor_id = $1 AND returned_at IS NULL
     RETURNING id, executor_id, fio, company, tsd, assigned_at, returned_at,
               returned_by_executor_id, returned_by_fio, returned_by_company`,
    [id]
  );
  return rows[0] ? toAssignment(rows[0]) : null;
}

async function returnByTsd({ tsd, returnedByExecutorId, returnedByFio, returnedByCompany }) {
  const device = clean(tsd);
  if (!device) throw new Error('Номер ТСД обязателен');
  const byId = clean(returnedByExecutorId);
  const byFio = clean(returnedByFio);
  const byCompany = clean(returnedByCompany);
  const { rows } = await pool.query(
    `UPDATE tsd_assignments
     SET returned_at = now(),
         returned_by_executor_id = $2,
         returned_by_fio = $3,
         returned_by_company = $4
     WHERE tsd = $1 AND returned_at IS NULL
     RETURNING id, executor_id, fio, company, tsd, assigned_at, returned_at,
               returned_by_executor_id, returned_by_fio, returned_by_company`,
    [device, byId, byFio, byCompany]
  );
  const assignment = rows[0] ? toAssignment(rows[0]) : null;
  return {
    assignment,
    foreignReturn: !!(assignment && byId && assignment.executorId && byId !== assignment.executorId),
  };
}

async function getSettings() {
  const { rows } = await pool.query("SELECT value FROM tsd_settings WHERE key = 'total_count'");
  const totalCount = rows[0] ? Math.max(0, parseInt(rows[0].value, 10) || 0) : 0;
  return { totalCount };
}

async function setSettings({ totalCount }) {
  const count = Math.max(0, parseInt(totalCount, 10) || 0);
  await pool.query(
    `INSERT INTO tsd_settings (key, value)
     VALUES ('total_count', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [String(count)]
  );
  return getSettings();
}

module.exports = { init, listActive, assign, returnByExecutor, returnByTsd, getSettings, setSettings };
