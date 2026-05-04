import { useState } from 'react'
import * as api from '../../api/index.js'
import styles from './StatsPage.module.css'

function getDefaultMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}.${m}.${y}`
}

function enrichRows(rows) {
  return rows.map(r => {
    const firstMs = r.firstAt ? new Date(r.firstAt).getTime() : null
    const lastMs  = r.lastAt  ? new Date(r.lastAt).getTime()  : null
    const workedMin = (firstMs && lastMs && lastMs > firstMs) ? (lastMs - firstMs) / 60000 : null
    return {
      ...r,
      workedMin,
      szPerHour: workedMin ? +(r.total * 60 / workedMin).toFixed(1) : null,
      szPerMin:  workedMin ? +(r.total / workedMin).toFixed(2) : null,
    }
  })
}

export default function MonthlyEmployeeTable() {
  const [month,   setMonth]   = useState(getDefaultMonth)
  const [shift,   setShift]   = useState('')
  const [rows,    setRows]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [sortCol, setSortCol] = useState('date')
  const [sortDir, setSortDir] = useState('asc')

  async function load() {
    if (!month) return
    const [year, mon] = month.split('-')
    setLoading(true)
    try {
      const res = await api.getMonthlyEmployees(year, mon, shift || undefined)
      setRows(enrichRows(res.rows || []))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const arrow = col => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const sorted = rows ? [...rows].sort((a, b) => {
    let va, vb
    if      (sortCol === 'date')      { va = a.date;      vb = b.date }
    else if (sortCol === 'company')   { va = a.company;   vb = b.company }
    else if (sortCol === 'name')      { va = a.name;      vb = b.name }
    else if (sortCol === 'total')     { va = a.total;     vb = b.total }
    else if (sortCol === 'szPerHour') { va = a.szPerHour ?? -1; vb = b.szPerHour ?? -1 }
    else if (sortCol === 'szPerMin')  { va = a.szPerMin  ?? -1; vb = b.szPerMin  ?? -1 }
    else return 0
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb, 'ru') : vb.localeCompare(va, 'ru')
    return sortDir === 'asc' ? va - vb : vb - va
  }) : null

  const th = (col, label, title) => (
    <th
      className={styles.tdCenter}
      onClick={() => handleSort(col)}
      style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
      title={title}
    >
      {label}{arrow(col)}
    </th>
  )

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
        <input
          type="month"
          className={styles.selectControl}
          style={{ fontSize: 13 }}
          value={month}
          onChange={e => setMonth(e.target.value)}
        />
        <select
          className={styles.selectControl}
          style={{ fontSize: 13 }}
          value={shift}
          onChange={e => setShift(e.target.value)}
        >
          <option value="">Все смены</option>
          <option value="day">День (9–21)</option>
          <option value="night">Ночь (21–9)</option>
        </select>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? '...' : 'Загрузить'}
        </button>
        {rows && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{rows.length} строк</span>}
      </div>

      {rows === null && (
        <div className={styles.emptyRow}>Выберите месяц и нажмите «Загрузить»</div>
      )}
      {rows !== null && sorted.length === 0 && (
        <div className={styles.emptyRow}>Нет данных за выбранный период</div>
      )}
      {sorted !== null && sorted.length > 0 && (
        <div className={styles.heScrollWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {th('date',      'Дата',     'Дата смены')}
                {th('company',   'Компания', 'Компания-подрядчик')}
                {th('name',      'ФИО',      'ФИО сотрудника')}
                {th('total',     'Итого СЗ', 'Суммарное количество складских заданий за смену')}
                {th('szPerHour', 'СЗ/ч',     'СЗ в час = Итого ÷ отработанное время (ч)')}
                {th('szPerMin',  'СЗ/мин',   'СЗ в минуту = Итого ÷ отработанное время (мин)')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i}>
                  <td className={styles.tdCenter}>{fmtDate(r.date)}</td>
                  <td>{r.company}</td>
                  <td className={styles.tdBold}>{r.name}</td>
                  <td className={styles.tdCenter}>{r.total}</td>
                  <td className={styles.tdCenter}>{r.szPerHour ?? '—'}</td>
                  <td className={styles.tdCenter}>{r.szPerMin  ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
