import { useState } from 'react'
import { formatTime, shortFio } from '../../utils/format.js'
import styles from './StatsPage.module.css'

export default function ExecutorTable({ executors }) {
  const [sortCol, setSortCol] = useState('ops')
  const [sortDir, setSortDir] = useState('desc')

  if (!executors?.length) return <div className={styles.empty}>Нет данных</div>

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('desc') }
  }
  const sortArrow = col => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ' ↕'
  const thS = { cursor: 'pointer', userSelect: 'none' }

  const sorted = [...executors].sort((a, b) => {
    let av, bv
    if (sortCol === 'ops') { av = a.ops; bv = b.ops }
    else if (sortCol === 'qty') { av = a.qty; bv = b.qty }
    else if (sortCol === 'name') { return (sortDir === 'asc' ? 1 : -1) * a.name.localeCompare(b.name, 'ru') }
    else if (sortCol === 'company') { return (sortDir === 'asc' ? 1 : -1) * (a.company||'').localeCompare(b.company||'', 'ru') }
    else { av = a.ops; bv = b.ops }
    return sortDir === 'desc' ? bv - av : av - bv
  })

  const maxOps = Math.max(...executors.map(e => e.ops), 1)

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>#</th>
            <th style={thS} onClick={() => handleSort('company')}>Компания{sortArrow('company')}</th>
            <th style={thS} onClick={() => handleSort('name')}>Сотрудник{sortArrow('name')}</th>
            <th className={styles.tdRight} style={thS} onClick={() => handleSort('qty')}>Единиц{sortArrow('qty')}</th>
            <th style={thS} onClick={() => handleSort('ops')}>Операций{sortArrow('ops')}</th>
            <th className={styles.tdRight}>Время</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e, i) => (
            <tr key={e.name}>
              <td className={styles.rank}>{i + 1}</td>
              <td className={styles.tdMuted}>{e.company || '—'}</td>
              <td className={styles.tdBold} title={e.name}>{shortFio(e.name)}</td>
              <td className={styles.tdRight}>{e.qty.toLocaleString('ru-RU')}</td>
              <td>
                <div className={styles.barWrap}>
                  <div
                    className={styles.bar}
                    style={{ width: `${Math.round((e.ops / maxOps) * 100)}%` }}
                  />
                  <span className={styles.barValue}>{e.ops.toLocaleString('ru-RU')}</span>
                </div>
              </td>
              <td className={styles.tdRight}>
                {e.firstAt ? formatTime(e.firstAt) : '—'} – {e.lastAt ? formatTime(e.lastAt) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
