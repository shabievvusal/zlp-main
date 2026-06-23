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
      returned_at TIMESTAMPTZ NULL
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tsd_assignments_active_executor_idx
    ON tsd_assignments (executor_id)
    WHERE returned_at IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tsd_assignments_active_tsd_idx
    ON tsd_assignments (tsd)
    WHERE returned_at IS NULL
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS tsd_assignments_assigned_at_idx ON tsd_assignments (assigned_at DESC)');
}

async function listActive() {
  const { rows } = await pool.query(`
    SELECT id, executor_id, fio, company, tsd, assigned_at, returned_at
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
       WHERE returned_at IS NULL AND (executor_id = $1 OR tsd = $2)`,
      [id, device]
    );
    const { rows } = await client.query(
      `INSERT INTO tsd_assignments (executor_id, fio, company, tsd)
       VALUES ($1, $2, $3, $4)
       RETURNING id, executor_id, fio, company, tsd, assigned_at, returned_at`,
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
     RETURNING id, executor_id, fio, company, tsd, assigned_at, returned_at`,
    [id]
  );
  return rows[0] ? toAssignment(rows[0]) : null;
}

module.exports = { init, listActive, assign, returnByExecutor };
