import { useState } from 'react'
import * as api from '../../api/index.js'
import { ZONES } from '../../utils/statsCalc.js'
import styles from './StatsPage.module.css'

function getTodayStr() {
  return new Date().toISOString().slice(0, 10)
}

function getMonthStartStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}.${m}.${y}`
}

function enrichRows(rows) {
  return rows.map(r => ({
    ...r,
    szPerHour: r.workedMinutes > 0 ? +(r.total * 60 / r.workedMinutes).toFixed(1) : null,
    szPerMin:  r.workedMinutes > 0 ? +(r.total / r.workedMinutes).toFixed(2) : null,
  }))
}

export default function MonthlyEmployeeTable() {
  const [dateFrom,    setDateFrom]    = useState(getMonthStartStr)
  const [dateTo,      setDateTo]      = useState(getTodayStr)
  const [shift,       setShift]       = useState('')
  const [zone,        setZone]        = useState('')
  const [rows,        setRows]        = useState(null)
  const [loadedRange, setLoadedRange] = useState(null)
  const [loading,     setLoading]     = useState(false)
  const [sortCol,     setSortCol]     = useState('total')
  const [sortDir,     setSortDir]     = useState('desc')

  async function load() {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const res = await api.getMonthlyEmployees(dateFrom, dateTo, shift || undefined, zone || undefined)
      setRows(enrichRows(res.rows || []))
      setLoadedRange({ from: dateFrom, to: dateTo })
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir(col === 'name' || col === 'company' ? 'asc' : 'desc') }
  }

  const arrow = col => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const sorted = rows ? [...rows].sort((a, b) => {
    let va, vb
    if      (sortCol === 'company')   { va = a.company;   vb = b.company }
    else if (sortCol === 'name')      { va = a.name;      vb = b.name }
    else if (sortCol === 'total')     { va = a.total;     vb = b.total }
    else if (sortCol === 'szPerHour') { va = a.szPerHour ?? -1; vb = b.szPerHour ?? -1 }
    else                              { va = a.szPerMin  ?? -1; vb = b.szPerMin  ?? -1 }
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

  const selectedZone = ZONES.find(z => z.key === zone)

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Период:</span>
        <input type="date" className={styles.selectControl} style={{ fontSize: 13 }}
          value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
        <input type="date" className={styles.selectControl} style={{ fontSize: 13 }}
          value={dateTo} onChange={e => setDateTo(e.target.value)} />
        <select className={styles.selectControl} style={{ fontSize: 13 }}
          value={shift} onChange={e => setShift(e.target.value)}>
          <option value="">Все смены</option>
          <option value="day">День (9–21)</option>
          <option value="night">Ночь (21–9)</option>
        </select>
        <select
          className={styles.selectControl}
          style={{
            fontSize: 13,
            background: selectedZone ? selectedZone.bg : undefined,
            color:      selectedZone ? selectedZone.text : undefined,
          }}
          value={zone} onChange={e => setZone(e.target.value)}
        >
          <option value="">Все зоны</option>
          {ZONES.map(z => (
            <option key={z.key} value={z.key}>{z.label}</option>
          ))}
        </select>
        <button className="btn btn-secondary btn-sm"
          onClick={load} disabled={loading || !dateFrom || !dateTo}>
          {loading ? 'Загрузка...' : 'Загрузить'}
        </button>
        {loadedRange && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {fmtDate(loadedRange.from)} — {fmtDate(loadedRange.to)}
            {rows ? ` · ${rows.length} сотрудников` : ''}
          </span>
        )}
      </div>

      {rows === null && (
        <div className={styles.emptyRow}>Выберите период и нажмите «Загрузить»</div>
      )}
      {rows !== null && (!sorted || sorted.length === 0) && (
        <div className={styles.emptyRow}>Нет данных за выбранный период</div>
      )}
      {sorted && sorted.length > 0 && (
        <div className={styles.heScrollWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {th('company',   'Компания', 'Компания-подрядчик')}
                {th('name',      'ФИО',      'ФИО сотрудника')}
                {th('total',     'Итого СЗ', 'Суммарное кол-во СЗ за период')}
                {th('szPerHour', 'СЗ/ч',     'СЗ в час = Итого ÷ суммарное отработанное время (ч)')}
                {th('szPerMin',  'СЗ/мин',   'СЗ в минуту = Итого ÷ суммарное отработанное время (мин)')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i}>
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
