import { useState } from 'react'
import { formatTime, formatMinutesToHours, formatWeight, shortFio } from '../../utils/format.js'
import { ZONES, parseIdleIntervalsForTimeline, computeWorkedMinutesInShift, getElapsedShiftMinutes } from '../../utils/statsCalc.js'
import styles from './StatsPage.module.css'

function szCellStyle(v) {
  if (v < 50) return { background: '#fecaca', color: '#1d1d1b' }
  if (v <= 75) return { background: 'linear-gradient(135deg,#fecaca 0%,#fef08a 100%)', color: '#1d1d1b' }
  return { background: '#fff', color: '#1d1d1b' }
}

function hourlyBg(zoneKey) {
  const zone = zoneKey ? ZONES.find(z => z.key === zoneKey) : null
  return zone ? { background: zone.bg, color: zone.text } : { background: '#f3f4f6', color: '#374151' }
}

function IdleTimeline({ raw, shiftFilter }) {
  const intervalsRaw = raw && typeof raw === 'object' ? (raw.intervals || '') : (raw || '')
  const intervals = parseIdleIntervalsForTimeline(intervalsRaw, shiftFilter)
  const totalMinutes = 12 * 60
  return (
    <div className={styles.heIdlesTimeline}>
      {intervals.map((iv, i) => {
        const left = Math.max(0, Math.min(100, (iv.start / totalMinutes) * 100))
        const width = Math.max(1, ((iv.end - iv.start) / totalMinutes) * 100)
        const mins = iv.end - iv.start
        return (
          <div
            key={i}
            className={styles.heIdleBlock}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={iv.label}
          >
            {width >= 3 && (
              <span className={styles.heIdleBlockLabel}>{mins} м</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Legend({ mode }) {
  if (mode === 'sz') {
    return (
      <div className={styles.heLegend}>
        <span className={styles.heLegendItem}>
          <span className={styles.heLegendSwatch} style={{ background: '#fecaca' }} />
          &lt;50 задач/ч
        </span>
        <span className={styles.heLegendItem}>
          <span className={styles.heLegendSwatch} style={{ background: 'linear-gradient(135deg,#fecaca,#fef08a)' }} />
          50–75 задач/ч
        </span>
        <span className={styles.heLegendItem}>
          <span className={styles.heLegendSwatch} style={{ background: '#fff', border: '1px solid #e5e7eb' }} />
          &gt;75 задач/ч
        </span>
      </div>
    )
  }
  if (mode === 'hourly') {
    return (
      <div className={styles.heLegend}>
        {ZONES.map(z => (
          <span key={z.key} className={styles.heLegendItem}>
            <span className={styles.heLegendSwatch} style={{ background: z.bg }} />
            <span style={{ color: z.text === '#fff' ? 'var(--text)' : z.text }}>{z.label}</span>
          </span>
        ))}
      </div>
    )
  }
  return null
}

export default function HourlyEmployeeTable({
  allRows, hours, mode = 'sz',
  idlesByEmployee = {}, weightByEmployee = {},
  allowedIdleMinutes = 0, shiftFilter = 'day', selectedDate = null,
  compact = false,
}) {
  const [sortCol, setSortCol] = useState('total')
  const [sortDir, setSortDir] = useState('desc')

  if (!allRows?.length) return <div className={styles.emptyRow}>Нет данных</div>

  const shiftMinutes = getElapsedShiftMinutes(selectedDate, shiftFilter)

  const hourLabel = col => {
    const start = (col + 23) % 24
    return `${String(start).padStart(2,'0')}–${String(col).padStart(2,'0')}`
  }

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const sortArrow = col => sortCol === col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ' ↕'

  // ── Zones mode ─────────────────────────────────────────────────────────────
  if (mode === 'zones') {
    const sorted = [...allRows].sort((a, b) => {
      const wa = ZONES.reduce((s, z) => s + ((a.byZone?.[z.key]?.weightGrams) || 0), 0)
      const wb = ZONES.reduce((s, z) => s + ((b.byZone?.[z.key]?.weightGrams) || 0), 0)
      return wb - wa
    })
    return (
      <div className={styles.heScrollWrap}>
        <table className={styles.zwTable}>
          <thead>
            <tr>
              <th className={`${styles.zwTh} ${styles.zwThCompany}`}>Компания</th>
              <th className={`${styles.zwTh} ${styles.zwThEmployee}`}>Сотрудник</th>
              {ZONES.map(z => (
                <th key={z.key} className={styles.zwTh} style={{ background: z.bg, color: z.text }} title={z.label}>
                  {z.label}
                </th>
              ))}
              <th className={`${styles.zwTh} ${styles.zwThTotal}`}>Итого</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const totalGrams = ZONES.reduce((s, z) => s + ((r.byZone?.[z.key]?.weightGrams) || 0), 0)
              return (
                <tr key={r.name}>
                  <td className={styles.zwTd}>{r.company || '—'}</td>
                  <td className={`${styles.zwTd} ${styles.zwTdName}`} title={r.name}>{shortFio(r.name)}</td>
                  {ZONES.map(z => {
                    const wg = r.byZone?.[z.key]?.weightGrams || 0
                    const cnt = r.byZone?.[z.key]?.count || 0
                    return (
                      <td key={z.key} className={styles.zwTd} style={wg > 0 ? { background: z.bg + '22' } : {}}>
                        {wg > 0 ? (
                          <>
                            <span className={styles.zwCount}>{cnt}</span>
                            <span className={styles.zwWeight}>{formatWeight(wg)}</span>
                          </>
                        ) : '—'}
                      </td>
                    )
                  })}
                  <td className={`${styles.zwTd} ${styles.zwTdTotal}`}>
                    {totalGrams > 0 ? formatWeight(totalGrams) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  // ── sz / hourly / idles modes ───────────────────────────────────────────────
  const showIdlesCol = mode === 'idles'

  // Pre-compute worked minutes for sorting
  const workedByName = {}
  for (const r of allRows) {
    const hasIdleData = r.name in idlesByEmployee
    const idleData = idlesByEmployee[r.name] || {}
    const idleMin = typeof idleData === 'object' ? (Number(idleData.totalMinutes) || 0) : 0
    workedByName[r.name] = hasIdleData ? computeWorkedMinutesInShift(idleMin, allowedIdleMinutes, shiftMinutes) : null
  }

  const sortedRows = [...allRows].sort((a, b) => {
    let av, bv
    if (sortCol === 'total') { av = a.total; bv = b.total }
    else if (sortCol === 'worked') { av = workedByName[a.name] || 0; bv = workedByName[b.name] || 0 }
    else if (sortCol === 'weight') { av = (weightByEmployee[a.name]?.total || 0); bv = (weightByEmployee[b.name]?.total || 0) }
    else if (sortCol === 'weightStorage') { av = (weightByEmployee[a.name]?.storage || 0); bv = (weightByEmployee[b.name]?.storage || 0) }
    else if (sortCol === 'weightKdk') { av = (weightByEmployee[a.name]?.kdk || 0); bv = (weightByEmployee[b.name]?.kdk || 0) }
    else if (sortCol === 'name') { return (sortDir === 'asc' ? 1 : -1) * a.name.localeCompare(b.name, 'ru') }
    else if (sortCol === 'company') { return (sortDir === 'asc' ? 1 : -1) * (a.company||'').localeCompare(b.company||'', 'ru') }
    else { av = a.total; bv = b.total }
    return sortDir === 'desc' ? bv - av : av - bv
  })

  const thSort = col => ({
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  })

  return (
    <div>
      <Legend mode={mode} />
      <div className={styles.heScrollWrap}>
        <table className={styles.heTable}>
          <thead>
            <tr>
              <th className={styles.heTdCompany} style={thSort('company')} onClick={() => handleSort('company')}>
                Компания{sortArrow('company')}
              </th>
              <th className={`${styles.heTdName} ${styles.heThName}`} style={thSort('name')} onClick={() => handleSort('name')}>
                Сотрудник{sortArrow('name')}
              </th>
              {!showIdlesCol && hours.map(col => (
                <th key={col} className={styles.heThHour} title={hourLabel(col)}>
                  {String(col).padStart(2, '0')}
                </th>
              ))}
              {showIdlesCol && (
                <th className={styles.heThIdles} title="Паузы между задачами">
                  Простои
                </th>
              )}
              <th className={styles.heThTotal} style={thSort('total')} onClick={() => handleSort('total')}>
                Итого{sortArrow('total')}
              </th>
              <th className={styles.heThTotal} title="Время в работе (смена − простои)" style={thSort('worked')} onClick={() => handleSort('worked')}>
                В работе{sortArrow('worked')}
              </th>
              <th className={styles.heThTotal} title="Первая / последняя операция">
                Старт
                <div style={{ fontSize: 10, fontWeight: 400, borderTop: '1px solid currentColor', marginTop: 1 }}>Пик</div>
              </th>
              <th className={styles.heThTotal} title="Вес в хранении" style={thSort('weightStorage')} onClick={() => handleSort('weightStorage')}>
                Вес ХР{sortArrow('weightStorage')}
              </th>
              <th className={styles.heThTotal} title="Вес в КДК" style={thSort('weightKdk')} onClick={() => handleSort('weightKdk')}>
                Вес КДК{sortArrow('weightKdk')}
              </th>
              <th className={styles.heThTotal} title="Вес итого" style={thSort('weight')} onClick={() => handleSort('weight')}>
                Вес итог{sortArrow('weight')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(r => {
              const idleData = idlesByEmployee[r.name] || {}
              const idleMin = typeof idleData === 'object' ? (Number(idleData.totalMinutes) || 0) : 0
              const workedMin = workedByName[r.name]
              const w = weightByEmployee[r.name] || { storage: 0, kdk: 0, total: 0 }
              return (
                <tr key={r.name}>
                  <td className={styles.heTdCompany}>{r.company || '—'}</td>
                  <td className={styles.heTdName} title={r.name}>{shortFio(r.name)}</td>
                  {!showIdlesCol && hours.map(col => {
                    const v = r.byHour?.[col] || 0
                    const wg = r.weightByHour?.[col] || 0
                    const zoneKey = r.byHourZone?.[col]
                    const zoneName = zoneKey ? (ZONES.find(z => z.key === zoneKey)?.label || zoneKey) : null
                    let cellStyle = {}
                    if (v > 0) {
                      cellStyle = mode === 'hourly'
                        ? hourlyBg(zoneKey)
                        : szCellStyle(v)
                    }
                    const cellTitle = [
                      hourLabel(col),
                      `${v} оп.`,
                      zoneName,
                      wg > 0 ? formatWeight(wg) : null,
                    ].filter(Boolean).join(' — ')
                    return (
                      <td key={col} className={styles.heTdVal} style={cellStyle} title={cellTitle}>
                        {v > 0 && (
                          <>
                            <span className={styles.heCellSz}>{v}</span>
                            {wg > 0 && <span className={styles.heCellWeight}>{formatWeight(wg)}</span>}
                          </>
                        )}
                      </td>
                    )
                  })}
                  {showIdlesCol && (
                    <td className={styles.heTdIdles}>
                      <IdleTimeline raw={idleData} shiftFilter={shiftFilter} />
                      {idleMin > 0 && (
                        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                          Простои: {formatMinutesToHours(idleMin)} · Отработано: {workedMin != null ? formatMinutesToHours(workedMin) : '—'}
                        </div>
                      )}
                    </td>
                  )}
                  <td className={styles.heTdTotal}>{r.total}</td>
                  <td className={styles.heTdTotal} title="Время в работе (смена − простои)">
                    {workedMin != null && workedMin > 0 ? formatMinutesToHours(workedMin) : '—'}
                  </td>
                  <td className={styles.heTdTotal} title="Первая / последняя операция">
                    {r.firstAt ? formatTime(r.firstAt) : '—'}
                    <div className={styles.hePeak}>{r.lastAt ? formatTime(r.lastAt) : '—'}</div>
                  </td>
                  <td className={styles.heTdTotal} title="Вес в хранении">
                    {w.storage > 0 ? formatWeight(w.storage) : '—'}
                  </td>
                  <td className={styles.heTdTotal} title="Вес в КДК">
                    {w.kdk > 0 ? formatWeight(w.kdk) : '—'}
                  </td>
                  <td className={styles.heTdTotal} title="Вес итого">
                    {w.total > 0 ? formatWeight(w.total) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
