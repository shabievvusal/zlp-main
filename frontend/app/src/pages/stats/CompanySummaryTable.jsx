import { useState } from 'react'
import { formatWeight } from '../../utils/format.js'
import styles from './StatsPage.module.css'

export function CompanySummaryToggle({ showHours, onChange }) {
  return (
    <label className={styles.summaryToggle} title="Показать колонки по часам">
      <input type="checkbox" checked={showHours} onChange={e => onChange(e.target.checked)} />
      <span className={`${styles.summaryToggleSlider} ${showHours ? styles.summaryToggleChecked : ''}`} />
      <span>по часам</span>
    </label>
  )
}

export default function CompanySummaryTable({ rows, hoursDisplay, showHours }) {
  const [sortCol, setSortCol] = useState('totalTasks')
  const [sortDir, setSortDir] = useState('desc')

  if (!rows?.length) return (
    <div className={styles.emptyRow}>Нет данных</div>
  )

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('desc') }
  }
  const sortArrow = col => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ' ↕'
  const thS = { cursor: 'pointer', userSelect: 'none' }

  const sorted = [...rows].sort((a, b) => {
    let av, bv
    if (sortCol === 'totalTasks') { av = a.totalTasks; bv = b.totalTasks }
    else if (sortCol === 'szch') { av = a.szch; bv = b.szch }
    else if (sortCol === 'vezch') { av = a.vezch || 0; bv = b.vezch || 0 }
    else if (sortCol === 'employeesCount') { av = a.employeesCount; bv = b.employeesCount }
    else if (sortCol === 'weightTotal') { av = a.weightTotalGrams || 0; bv = b.weightTotalGrams || 0 }
    else if (sortCol === 'szStorage') { av = a.szStorage || 0; bv = b.szStorage || 0 }
    else if (sortCol === 'szKdk') { av = a.szKdk || 0; bv = b.szKdk || 0 }
    else if (sortCol === 'company') { return (sortDir === 'asc' ? 1 : -1) * (a.companyName||'').localeCompare(b.companyName||'', 'ru') }
    else { av = a.totalTasks; bv = b.totalTasks }
    return sortDir === 'desc' ? bv - av : av - bv
  })

  return (
    <div>
      <div className={styles.tableWrap}>
        <table className={styles.companySummaryTable}>
          <thead>
            <tr>
              <th className={styles.csThCompany} style={thS} onClick={() => handleSort('company')}>Компания{sortArrow('company')}</th>
              <th className={styles.csThNum} style={thS} onClick={() => handleSort('employeesCount')}>Сотрудников{sortArrow('employeesCount')}</th>
              <th className={styles.csThNum} style={thS} onClick={() => handleSort('szch')}>СЗ/Ч{sortArrow('szch')}</th>
              <th className={styles.csThNum} style={thS} onClick={() => handleSort('vezch')}>ВЕС/Ч{sortArrow('vezch')}</th>
              {showHours && hoursDisplay?.map(col => (
                <th key={col} className={styles.csThHour} title={`${String(col).padStart(2,'0')}:00`}>
                  {col}
                </th>
              ))}
              <th className={styles.csThNum} style={thS} onClick={() => handleSort('totalTasks')}>Итог{sortArrow('totalTasks')}</th>
              <th className={styles.csThNum} style={thS} onClick={() => handleSort('weightTotal')}>Вес итог{sortArrow('weightTotal')}</th>
              <th className={styles.csThNum} title="СЗ в хранении" style={thS} onClick={() => handleSort('szStorage')}>СЗ хранение{sortArrow('szStorage')}</th>
              <th className={styles.csThNum} title="СЗ в КДК" style={thS} onClick={() => handleSort('szKdk')}>СЗ КДК{sortArrow('szKdk')}</th>
              <th className={styles.csThNum}>Вес хранение</th>
              <th className={styles.csThNum}>Вес КДК</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.companyName}>
                <td className={styles.csTdCompany}>{r.companyName}</td>
                <td className={styles.csTdNum}>{r.employeesCount}</td>
                <td className={styles.csTdNum}>{r.szch}</td>
                <td className={styles.csTdNum}>{formatWeight(r.vezch || 0)}</td>
                {showHours && hoursDisplay?.map(col => (
                  <td key={col} className={styles.csTdHour}>{r.byHour?.[col] ?? ''}</td>
                ))}
                <td className={styles.csTdNum}>{r.totalTasks}</td>
                <td className={styles.csTdNum}>{formatWeight(r.weightTotalGrams)}</td>
                <td className={styles.csTdNum}>{r.szStorage ?? 0}</td>
                <td className={styles.csTdNum}>{r.szKdk ?? 0}</td>
                <td className={styles.csTdNum}>{formatWeight(r.weightStorageGrams ?? 0)}</td>
                <td className={styles.csTdNum}>{formatWeight(r.weightKdkGrams ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.companySummaryFormulas}>
        <div className={styles.csFormulaRow}>
          <span className={styles.csFormulaLabel}>СЗ/Ч — среднее задач в час на сотрудника:</span>
          <span className={styles.csFormulaText}>Итог ÷ Сотрудников ÷ прошедших часов</span>
        </div>
        <div className={styles.csFormulaRow}>
          <span className={styles.csFormulaLabel}>ВЕС/Ч — средний вес в час на сотрудника:</span>
          <span className={styles.csFormulaText}>Вес итог ÷ Сотрудников ÷ прошедших часов</span>
        </div>
        {showHours && (
          <div className={styles.csFormulaRow}>
            <span className={styles.csFormulaLabel}>Колонки по часам — сумма выполненных задач за каждый час (прошедшие + текущий). Итог — СЗ за все часы у компании.</span>
          </div>
        )}
      </div>
    </div>
  )
}
