/**
 * empl-pg.js — PostgreSQL-хранилище сотрудников.
 *
 * Таблица employees:
 *   executor_id  TEXT PRIMARY KEY  — UUID из WMS (executorId из часовых JSON)
 *   fio          TEXT NOT NULL     — ФИО сотрудника
 *   company      TEXT DEFAULT ''   — компания / подрядчик
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

// ─── In-memory cache ───────────────────────────────────────────────────────────
// Позволяет вызывать getEmplMapFioToCompany() синхронно во всех route-хэндлерах.

let _cache = new Map(); // normFio → company

async function refreshCache() {
  try {
    const { rows } = await pool.query('SELECT fio, company FROM employees');
    const map = new Map();
    for (const row of rows) {
      const key = normFio(row.fio);
      if (key && !map.has(key)) map.set(key, row.company || '');
    }
    _cache = map;
  } catch (err) {
    console.error('empl-pg refreshCache:', err.message);
  }
}

/** Синхронная версия — возвращает кэш */
function getEmplMapFioToCompany() {
  return _cache;
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      executor_id  TEXT PRIMARY KEY,
      fio          TEXT NOT NULL,
      company      TEXT NOT NULL DEFAULT ''
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS employees_fio_idx ON employees (lower(fio))`);
  await refreshCache();
}

// ─── Нормализация ФИО ──────────────────────────────────────────────────────────

function normFio(fio) {
  return String(fio || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Ключ реестра: "фамилия и" (совпадает с normPkForRegistry в server.js)
function normPkForRegistry(fio) {
  const norm = normFio(fio);
  const parts = norm.split(' ').filter(Boolean);
  if (!parts.length) return norm;
  const init = parts.length > 1 ? parts[1].charAt(0) : '';
  return (parts[0] + ' ' + init).trim();
}

// ─── Чтение ────────────────────────────────────────────────────────────────────

/** Нечёткий поиск компании по ФИО (точное совпадение / подстрока) */
function getCompanyByFio(emplMap, executorFio) {
  const norm = normFio(executorFio);
  if (!norm) return null;
  for (const [key, company] of emplMap) {
    if (norm === key || norm.includes(key) || key.includes(norm)) return company;
  }
  return null;
}

/** Возвращает [{fio, company}] + [companies] */
async function listEmployees() {
  const { rows } = await pool.query('SELECT executor_id, fio, company FROM employees ORDER BY fio');
  const employees = rows.map(r => ({ executorId: r.executor_id, fio: r.fio, company: r.company || '' }));
  const companySet = new Set(employees.map(e => e.company).filter(Boolean));
  return { employees, companies: [...companySet].sort() };
}

// ─── Запись ────────────────────────────────────────────────────────────────────

/**
 * Добавить или обновить сотрудника.
 * Если executor_id известен — upsert по нему.
 * Если executor_id не передан — upsert по нормализованному ФИО (используем ФИО как pk).
 */
async function upsertEmployee({ executorId, fio, company }) {
  const id = (executorId || '').trim() || ('fio:' + normFio(fio));
  const f  = String(fio || '').trim();
  const c  = String(company != null ? company : '').trim();
  await pool.query(
    `INSERT INTO employees (executor_id, fio, company)
     VALUES ($1, $2, $3)
     ON CONFLICT (executor_id) DO UPDATE SET fio = $2, company = $3`,
    [id, f, c]
  );
  await refreshCache();
}

/**
 * Добавить сотрудников, которых ещё нет в таблице (по executor_id и по нормализованному ФИО).
 * names — строки ФИО (без компании, взяты из WMS).
 * executors — массив [{executorId, fio}]
 * Возвращает количество новых записей.
 */
async function addNewEmployees(executors) {
  if (!executors || !executors.length) return 0;
  // Получаем существующие id и нормализованные ФИО
  const { rows } = await pool.query('SELECT executor_id, fio FROM employees');
  const existingIds  = new Set(rows.map(r => r.executor_id));
  const existingFios = new Set(rows.map(r => normFio(r.fio)));

  let added = 0;
  for (const { executorId, fio } of executors) {
    const id  = (executorId || '').trim();
    const f   = String(fio || '').trim();
    if (!f) continue;
    if (id && existingIds.has(id)) continue;
    if (existingFios.has(normFio(f))) continue;
    const pk = id || ('fio:' + normFio(f));
    await pool.query(
      `INSERT INTO employees (executor_id, fio, company) VALUES ($1, $2, '')
       ON CONFLICT (executor_id) DO NOTHING`,
      [pk, f]
    );
    existingIds.add(pk);
    existingFios.add(normFio(f));
    added++;
  }
  if (added > 0) await refreshCache();
  return added;
}

/**
 * Обогатить ФИО — заменить краткое имя полным, если в registry есть более длинное.
 * registry — объект { normPk: fullFio }
 * Возвращает количество обновлённых строк.
 */
async function enrichNames(registry) {
  if (!registry || !Object.keys(registry).length) return 0;
  const { rows } = await pool.query('SELECT executor_id, fio FROM employees');
  let updated = 0;
  for (const row of rows) {
    const fullFio = registry[normPkForRegistry(row.fio)];
    if (!fullFio) continue;
    if (fullFio.split(/\s+/).length <= row.fio.split(/\s+/).length) continue;
    const titled = fullFio.replace(/\S+/g, w => w.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-'));
    await pool.query('UPDATE employees SET fio = $1 WHERE executor_id = $2', [titled, row.executor_id]);
    updated++;
  }
  if (updated > 0) await refreshCache();
  return updated;
}

/** Сохранить весь список сотрудников целиком (заменяет таблицу). */
async function saveAll(employees) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE employees');
    for (const { executorId, fio, company } of employees) {
      const id = (executorId || '').trim() || ('fio:' + normFio(fio));
      const f  = String(fio || '').trim();
      const c  = String(company != null ? company : '').trim();
      if (!f) continue;
      await client.query(
        'INSERT INTO employees (executor_id, fio, company) VALUES ($1, $2, $3) ON CONFLICT (executor_id) DO UPDATE SET fio=$2, company=$3',
        [id, f, c]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await refreshCache();
}

module.exports = { init, getEmplMapFioToCompany, getCompanyByFio, listEmployees, upsertEmployee, addNewEmployees, enrichNames, saveAll };
