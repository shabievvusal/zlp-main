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

function isKdkZone(zoneKey) {
  return String(zoneKey || '').toUpperCase().startsWith('KD')
}

function getRowWeightFallback(row) {
  const out = { storage: 0, kdk: 0, total: 0 }

  for (const [zoneKey, data] of Object.entries(row.byZone || {})) {
    const grams = Number(data?.weightGrams) || 0
    if (!grams) continue
    if (isKdkZone(zoneKey)) out.kdk += grams
    else out.storage += grams
    out.total += grams
  }

  if (out.total > 0) return out

  for (const [col, rawGrams] of Object.entries(row.weightByHour || {})) {
    const grams = Number(rawGrams) || 0
    if (!grams) continue
    const zoneKey = row.byHourZone?.[col]
    if (isKdkZone(zoneKey)) out.kdk += grams
    else if (zoneKey) out.storage += grams
    out.total += grams
  }

  return out
}

function resolveEmployeeWeight(row, weightByEmployee) {
  if (!row.executorId) return { storage: 0, kdk: 0, total: 0 }
  const direct = weightByEmployee[row.executorId]
  if (direct && (direct.storage || direct.kdk || direct.total)) return direct
  return getRowWeightFallback(row)
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
  operation = 'selection',
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
                <tr key={r.executorId || r.name}>
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
  const isReceiving = operation === 'receiving'

  // Pre-compute worked minutes for sorting
  const workedByExecutor = {}
  for (const r of allRows) {
    const idleKey = r.executorId || ''
    const hasIdleData = !!idleKey && idleKey in idlesByEmployee
    const idleData = hasIdleData ? idlesByEmployee[idleKey] : {}
    const idleMin = typeof idleData === 'object' ? (Number(idleData.totalMinutes) || 0) : 0
    workedByExecutor[idleKey] = hasIdleData ? computeWorkedMinutesInShift(idleMin, allowedIdleMinutes, shiftMinutes) : null
  }

  const sortedRows = [...allRows].sort((a, b) => {
    let av, bv
    if (sortCol === 'total') { av = a.total; bv = b.total }
    else if (sortCol === 'worked') { av = workedByExecutor[a.executorId || ''] || 0; bv = workedByExecutor[b.executorId || ''] || 0 }
    else if (sortCol === 'weight') { av = resolveEmployeeWeight(a, weightByEmployee).total; bv = resolveEmployeeWeight(b, weightByEmployee).total }
    else if (sortCol === 'weightStorage') { av = resolveEmployeeWeight(a, weightByEmployee).storage; bv = resolveEmployeeWeight(b, weightByEmployee).storage }
    else if (sortCol === 'weightKdk') { av = resolveEmployeeWeight(a, weightByEmployee).kdk; bv = resolveEmployeeWeight(b, weightByEmployee).kdk }
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
              const idleKey = r.executorId || ''
              const idleData = idleKey ? (idlesByEmployee[idleKey] || {}) : {}
              const idleMin = typeof idleData === 'object' ? (Number(idleData.totalMinutes) || 0) : 0
              const workedMin = workedByExecutor[idleKey]
              const w = resolveEmployeeWeight(r, weightByEmployee)
              return (
                <tr key={r.executorId || r.name}>
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
                      isReceiving ? `${v} поставок` : `${v} оп.`,
                      isReceiving ? `${r.secondaryByHour?.[col] || 0} ЕО` : null,
                      zoneName,
                      wg > 0 ? formatWeight(wg) : null,
                    ].filter(Boolean).join(' — ')
                    return (
                      <td key={col} className={styles.heTdVal} style={cellStyle} title={cellTitle}>
                        {v > 0 && (
                          <>
                            <span className={styles.heCellSz}>{v}</span>
                            {isReceiving
                              ? <span className={styles.heCellWeight}>{(r.secondaryByHour?.[col] || 0).toLocaleString('ru-RU')} ЕО</span>
                              : wg > 0 && <span className={styles.heCellWeight}>{formatWeight(wg)}</span>}
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
                  <td className={styles.heTdTotal}>
                    {r.total}
                    {isReceiving && <div className={styles.hePeak}>{(r.secondaryTotal || 0).toLocaleString('ru-RU')} ЕО</div>}
                  </td>
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
