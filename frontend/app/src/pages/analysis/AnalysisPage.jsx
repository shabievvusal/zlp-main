import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import * as api from '../../api/index.js'
import { RefreshCw } from 'lucide-react'
import s from './AnalysisPage.module.css'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEMP_TO_ZONE = { ORDINARY: 'KDS', MEDIUM_COLD: 'KDH', LOW_COLD: 'KDM' }


function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function shiftWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, d - 1, 18, 0, 0, 0))
  const to   = new Date(Date.UTC(y, m - 1, d,     18, 0, 0, 0))
  return { from: from.toISOString(), to: to.toISOString() }
}

function fmt(v) {
  if (v == null) return '—'
  return Number(v).toLocaleString('ru-RU')
}

function fmtTime(date) {
  if (!date) return '—'
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function mskFrom(d) { return new Date(`${d}T00:00:00+03:00`).toISOString() }
function mskTo(d)   { return new Date(`${d}T23:59:59.999+03:00`).toISOString() }

function pieceQty(val) {
  if (val == null) return 0
  if (typeof val === 'number') return val
  return val.pieceProducts ?? val.weightProducts ?? 0
}

function buildSpeedMap(results) {
  const map = new Map()
  for (const r of (results || [])) {
    if (r.qtyPerPersonHour > 0 && r.nomenclatureCode) {
      const key  = `${r.nomenclatureCode}:${r.zone}`
      const prev = map.get(key)
      if (!prev || r.totalOps > prev.totalOps) map.set(key, r)
    }
  }
  return map
}

function calcForecastPH(personHours, people, shiftEnd) {
  if (!personHours || !people || people <= 0 || !shiftEnd) return null
  const projFinish = new Date(Date.now() + personHours / people * 3_600_000)
  const minDiff    = Math.round((shiftEnd - projFinish) / 60_000)
  const status     = minDiff >= 30 ? 'ok' : minDiff >= 0 ? 'warn' : 'over'
  return { projFinish, status, minDiff }
}

function calcForecastTasks(rest, people, speed, shiftEnd) {
  if (!rest || !people || !speed || people <= 0 || speed <= 0 || !shiftEnd) return null
  const projFinish = new Date(Date.now() + rest / (people * speed) * 3_600_000)
  const minDiff    = Math.round((shiftEnd - projFinish) / 60_000)
  const status     = minDiff >= 30 ? 'ok' : minDiff >= 0 ? 'warn' : 'over'
  return { projFinish, status, minDiff }
}

function loadOverrides() {
  try { const v = localStorage.getItem('analysis_overrides'); return v ? JSON.parse(v) : {} } catch { return {} }
}
function saveOverrides(val) { try { localStorage.setItem('analysis_overrides', JSON.stringify(val)) } catch {} }

function parseMonitoringStats(data) {
  const v = data?.value
  if (!v) return null
  const pick = block => ({
    tasks: block?.totalTasks?.tasksCount     ?? 0,
    done:  block?.completedTasks?.tasksCount ?? 0,
    rest:  block?.remainingTasks?.tasksCount ?? 0,
  })
  return { kdk: pick(v.pickByLineStats), storage: pick(v.pieceSelectionStats) }
}

function parseLivePeople(data) {
  const v = data?.value || data || {}
  const sections = [
    { key: 'pickByLineHandlingUnitsInProgress',    type: 'kdk'     },
    { key: 'pieceSelectionHandlingUnitsInProgress', type: 'storage' },
  ]
  const counts = { kdk: 0, storage: 0 }
  const seen   = new Set()
  for (const { key, type } of sections) {
    for (const entry of (v[key] || [])) {
      const u   = entry.user || {}
      const fio = [u.lastName, u.firstName].filter(Boolean).join(' ')
      if (!fio) continue
      const uid = fio + type
      if (seen.has(uid)) continue
      seen.add(uid)
      counts[type]++
    }
  }
  return counts
}

function calcAvgSpeed(rows, lastN = 3) {
  if (!rows?.length) return null
  const nonZero = rows.filter(r => r.avg > 0 && r.sotrud > 0)
  const recent  = nonZero.slice(-lastN)
  if (!recent.length) return null
  return Math.round(recent.reduce((s, r) => s + r.avg, 0) / recent.length)
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProgressBar({ done, total }) {
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0
  return (
    <div className={s.progressWrap}>
      <div className={s.progressFill} style={{ width: pct + '%' }} />
      <span className={s.progressLabel}>{pct}%</span>
    </div>
  )
}

function StatRow({ label, value, bold }) {
  return (
    <div className={s.statRow}>
      <span className={s.statLabel}>{label}</span>
      <span className={bold ? s.statValueBold : s.statValue}>{value}</span>
    </div>
  )
}

function ForecastBadge({ forecast, shiftEndTime }) {
  if (!forecast) return null
  const { status, projFinish, minDiff } = forecast
  const cls  = status === 'ok' ? s.badgeOk : status === 'warn' ? s.badgeWarn : s.badgeOver
  const icon = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✕'
  const hint = status === 'ok'
    ? `Запас ${Math.abs(minDiff)} мин до ${shiftEndTime}`
    : status === 'warn'
    ? `Буфер ${minDiff} мин до ${shiftEndTime}`
    : `Опоздание ~${Math.abs(minDiff)} мин`
  return (
    <div className={`${s.forecastBadge} ${cls}`}>
      <div className={s.forecastMain}>
        <span className={s.forecastIcon}>{icon}</span>
        <span className={s.forecastTime}>{fmtTime(projFinish)}</span>
        <span className={s.forecastHint}>{hint}</span>
      </div>
    </div>
  )
}

function ZoneCard({ zoneKey, label, rest, restUnit, personHours, people, speed, shiftEnd, shiftEndTime, loading, onPeople, onSpeed, speedPlaceholder }) {
  const forecast = personHours != null
    ? calcForecastPH(personHours, people, shiftEnd)
    : (rest != null && speed)
      ? calcForecastTasks(rest, people, speed, shiftEnd)
      : null

  const borderCls = !forecast ? ''
    : forecast.status === 'ok'   ? s.cardOk
    : forecast.status === 'warn' ? s.cardWarn
    : s.cardOver

  return (
    <div className={`${s.card} ${borderCls}`}>
      <div className={s.cardHeader}>
        <span className={s.cardTitle}>{zoneKey}</span>
        {people > 0 && <span className={s.peopleBadge}>{people} чел.</span>}
      </div>
      <div className={s.zoneSubLabel}>{label}</div>

      {rest != null && (
        <StatRow label="Остаток" value={`${fmt(Math.round(rest))} ${restUnit ?? 'СЗ'}`} bold />
      )}
      {personHours != null && personHours > 0 && (
        <StatRow label="Часов работы" value={personHours.toFixed(1)} />
      )}

      <div className={s.zoneInputs}>
        <label className={s.zoneInputField}>
          <span className={s.zoneInputLabel}>Людей</span>
          <input type="number" min="1" className={s.adjustInput}
            placeholder="—" value={people || ''}
            onChange={e => onPeople(e.target.value)} />
        </label>
        <label className={s.zoneInputField}>
          <span className={s.zoneInputLabel}>СЗ/ч</span>
          <input type="number" min="1" className={s.adjustInput}
            placeholder={speedPlaceholder ?? '—'} value={speed || ''}
            onChange={e => onSpeed(e.target.value)} />
        </label>
      </div>

      {!loading && <ForecastBadge forecast={forecast} shiftEndTime={shiftEndTime} />}
      {!loading && !forecast && people > 0 && rest == null && personHours == null && (
        <div className={s.forecastLoading}>Нет данных об остатке</div>
      )}
      {!loading && !people && (
        <div className={s.forecastLoading}>Укажите кол-во людей</div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AnalysisPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()

  const [date, setDate]                 = useState(todayStr)
  const [shiftEndTime, setShiftEndTime] = useState('21:00')
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState(null)
  const [lastUpdated, setLastUpdated]   = useState(null)

  const [picking,    setPicking]    = useState(null)
  const [people,     setPeople]     = useState(null)
  const [hourlyRows, setHourlyRows] = useState(null)
  const [overrides,  setOverrides]  = useState(loadOverrides)

  const [speedsMap,        setSpeedsMap]        = useState(new Map())
  const [pickFcast,        setPickFcast]        = useState(null)
  const [loadingPickFcast, setLoadingPickFcast] = useState(false)

  function updateOverride(key, val) {
    const next = { ...overrides }
    if (val === '') { delete next[key] }
    else { const n = Number(val); if (!isNaN(n) && n > 0) next[key] = n; else delete next[key] }
    setOverrides(next)
    saveOverrides(next)
  }

  const shiftEnd = useMemo(() => {
    const [h, m] = shiftEndTime.split(':').map(Number)
    const d = new Date(); d.setHours(h, m, 0, 0)
    return d
  }, [shiftEndTime])

  // ─── Основной fetch ────────────────────────────────────────────────────────
  const fetchAll = useCallback(async (dateStr) => {
    let token = getToken()
    if (!token || !isTokenValid()) {
      const ok = await forceRefresh()
      if (!ok) { setError('Нет токена WMS. Войдите заново.'); return }
      token = getToken()
    }
    setLoading(true); setError(null)
    try {
      const { from, to } = shiftWindow(dateStr)
      const [monData, liveData, summaryData] = await Promise.all([
        api.getReportMonitoringStats(token, from, to),
        api.getLiveMonitorViaBrowser(token).catch(() => null),
        api.getDateSummaryFull(dateStr),
      ])
      const parsed = parseMonitoringStats(monData)
      if (parsed) setPicking(parsed)
      if (liveData) setPeople(parseLivePeople(liveData))
      if (Array.isArray(summaryData?.hourly)) {
        const byHour = new Map()
        for (const h of summaryData.hourly) byHour.set(h.hour, h)
        const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
        const rows = HOURS.map(h => {
          const hd = byHour.get(h - 1)
          if (!hd || hd.ops === 0) return null
          const kdk  = hd.kdkOps
          const stor = hd.ops - hd.kdkOps
          const empl = hd.employeesKompl ?? hd.employees ?? 0
          return {
            time:   `${String(h).padStart(2, '0')}:00`,
            kdk:    kdk  > 0 ? kdk  : null,
            stor:   stor > 0 ? stor : null,
            sotrud: empl > 0 ? empl : null,
            done:   hd.ops,
            avg:    empl > 0 ? Math.round(hd.ops / empl) : 0,
          }
        }).filter(Boolean)
        setHourlyRows(rows)
      }
      setLastUpdated(new Date())
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [getToken, isTokenValid, forceRefresh])

  useEffect(() => { fetchAll(date) }, [date, fetchAll])

  // ─── Авто-загрузка скоростей артикулов ────────────────────────────────────
  useEffect(() => {
    const dateTo = date
    const d = new Date(date); d.setDate(d.getDate() - 14)
    const dateFrom = d.toISOString().slice(0, 10)
    api.getArticleSpeeds({ dateFrom, dateTo, opType: 'PICK_BY_LINE' })
      .then(res => setSpeedsMap(buildSpeedMap(res?.results)))
      .catch(() => {})
  }, [date])

  // ─── Авто-загрузка данных комплектации ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setPickFcast(null); setLoadingPickFcast(true)
    async function run() {
      try {
        let token = getToken()
        if (!token || !isTokenValid()) {
          const ok = await forceRefresh(); if (!ok) return
          token = getToken()
        }
        const res = await api.getInboundTasks(token, {
          types: ['CROSSDOCK'],
          statuses: ['COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY'],
          completedDateFrom: mskFrom(date), completedDateTo: mskTo(date),
          pageSize: 20,
        })
        const supplies = res?.value?.items ?? []
        if (!supplies.length || cancelled) return

        const details = await Promise.all(
          supplies.map(sup => api.getInboundTaskDetail(token, { taskType: 'CROSSDOCK', id: sup.id }))
        )
        if (cancelled) return

        const allProducts = []
        const barcodes = []; const seenBar = new Set()
        supplies.forEach((sup, i) => {
          const zone     = TEMP_TO_ZONE[sup.temperatureMode] || 'KDS'
          const products = details[i]?.value?.products ?? details[i]?.products ?? []
          for (const prod of products) {
            allProducts.push({ ...prod, zone, supplyNum: sup.taskNumber })
            for (const part of (prod.parts ?? [])) {
              for (const hu of (part.handlingUnits ?? [])) {
                if (hu.handlingUnitBarcode && !seenBar.has(hu.handlingUnitBarcode)) {
                  seenBar.add(hu.handlingUnitBarcode)
                  barcodes.push(hu.handlingUnitBarcode)
                }
              }
            }
          }
        })

        const remainings = await Promise.all(barcodes.map(b => api.getEoRemaining(token, b)))
        if (cancelled) return
        const remMap = {}
        barcodes.forEach((b, i) => { remMap[b] = remainings[i] })

        const rows = allProducts.map(prod => {
          const totalQty = pieceQty(prod.actualQuantity) || pieceQty(prod.plannedQuantity)
          let remainingQty = 0
          for (const part of (prod.parts ?? [])) {
            for (const hu of (part.handlingUnits ?? [])) {
              const rem = remMap[hu.handlingUnitBarcode]
              remainingQty += (rem === null || rem === undefined) ? pieceQty(hu.actualQuantity) : rem
            }
          }
          return {
            id: prod.id, name: prod.name || '', code: prod.nomenclatureCode || '',
            zone: prod.zone, supplyNum: prod.supplyNum,
            totalQty, remainingQty: Math.max(0, remainingQty),
          }
        })

        if (!cancelled) setPickFcast({ supplyCount: supplies.length, rows })
      } catch { /* не критично */ }
      finally { if (!cancelled) setLoadingPickFcast(false) }
    }
    run()
    return () => { cancelled = true }
  }, [date, getToken, isTokenValid, forceRefresh])

  // ─── Расчёты ───────────────────────────────────────────────────────────────

  const avgSpeed = calcAvgSpeed(hourlyRows)

  // Получить значение из overrides или null
  const ov = (key) => overrides[key] ?? null

  // Данные комплектации по зонам (только KDS и KDH — из поставок)
  const pickByZone = useMemo(() => {
    if (!pickFcast) return {}
    const result = {}
    for (const z of ['KDS', 'KDH']) {
      const rows = pickFcast.rows.filter(r => r.zone === z)
      const remaining = rows.reduce((a, r) => a + r.remainingQty, 0)
      const totalQty  = rows.reduce((a, r) => a + r.totalQty, 0)
      const speedRows = rows.map(r => {
        const record = speedsMap.get(`${r.code}:${r.zone}`)
        const speed  = record?.qtyPerPersonHour || ov(`${z}_speed`) || null
        const ph     = speed > 0 && r.remainingQty > 0 ? r.remainingQty / speed : null
        return { ...r, speed, personHours: ph }
      })
      const personHours = speedRows.reduce((a, r) => a + (r.personHours ?? 0), 0)
      result[z] = { remaining, totalQty, personHours, rows: speedRows }
    }
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickFcast, speedsMap, overrides])

  // Хранение: пропорциональный сплит SH/HH по людям
  const storageRest = picking?.storage.rest ?? 0
  const shPeople    = ov('SH_people') ?? 0
  const hhPeople    = ov('HH_people') ?? 0
  const storTotal   = shPeople + hhPeople
  const shRest      = storTotal > 0 ? Math.round(storageRest * shPeople / storTotal) : (shPeople > 0 ? storageRest : null)
  const hhRest      = storTotal > 0 ? storageRest - (shRest ?? 0) : (hhPeople > 0 ? storageRest : null)

  // Итого задач
  const totTasks = (picking?.kdk.tasks ?? 0) + (picking?.storage.tasks ?? 0)
  const totDone  = (picking?.kdk.done  ?? 0) + (picking?.storage.done  ?? 0)
  const totRest  = (picking?.kdk.rest  ?? 0) + (picking?.storage.rest  ?? 0)
  const totPct   = totTasks > 0 ? Math.round(totDone / totTasks * 100) : 0

  // Pick forecast таблица (для секции комплектации)
  const pickFcastRows = useMemo(() => {
    if (!pickFcast) return null
    return pickFcast.rows
      .map(r => {
        const record = speedsMap.get(`${r.code}:${r.zone}`)
        const speed  = record?.qtyPerPersonHour || ov(`${r.zone}_speed`) || null
        const ph     = speed > 0 && r.remainingQty > 0 ? r.remainingQty / speed : null
        return { ...r, speed, personHours: ph, fromFallback: !record && speed != null }
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickFcast, speedsMap, overrides])

  const pickTotalRemaining = pickFcastRows?.reduce((a, r) => a + r.remainingQty, 0) ?? 0
  const pickTotalQty       = pickFcastRows?.reduce((a, r) => a + r.totalQty, 0) ?? 0
  const pickPct            = pickTotalQty > 0 ? Math.round((pickTotalQty - pickTotalRemaining) / pickTotalQty * 100) : 0

  return (
    <div className={s.page}>

      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <h1 className={s.title}>Анализ смены</h1>
        <div className={s.controls}>
          <label className={s.field}>
            <span className={s.fieldLabel}>Дата</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className={s.input} />
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>Конец смены</span>
            <input type="time" value={shiftEndTime} onChange={e => setShiftEndTime(e.target.value)} className={s.input} />
          </label>
          <button className={s.refreshBtn} onClick={() => fetchAll(date)} disabled={loading}>
            <RefreshCw size={14} className={loading ? s.spinning : ''} />
            Обновить
          </button>
          {lastUpdated && !loading && (
            <span className={s.updatedAt}>Обновлено в {fmtTime(lastUpdated)}</span>
          )}
          {avgSpeed != null && (
            <span className={s.autoSpeed}>Авто скорость: <strong>{avgSpeed} СЗ/чел/час</strong></span>
          )}
        </div>
      </div>

      {error && <div className={s.error}>{error}</div>}

      {/* ── Зональные карточки ── */}
      <div className={s.zoneCards}>

        <ZoneCard
          zoneKey="KDS" label="Сухой КДК"
          rest={pickByZone.KDS?.remaining}
          restUnit="ед."
          personHours={pickByZone.KDS?.personHours || null}
          people={ov('KDS_people') ?? (loadingPickFcast ? null : null)}
          speed={ov('KDS_speed')}
          speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading || loadingPickFcast}
          onPeople={v => updateOverride('KDS_people', v)}
          onSpeed={v  => updateOverride('KDS_speed', v)}
        />

        <ZoneCard
          zoneKey="KDH" label="Холодный КДК"
          rest={pickByZone.KDH?.remaining}
          restUnit="ед."
          personHours={pickByZone.KDH?.personHours || null}
          people={ov('KDH_people')}
          speed={ov('KDH_speed')}
          speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading || loadingPickFcast}
          onPeople={v => updateOverride('KDH_people', v)}
          onSpeed={v  => updateOverride('KDH_speed', v)}
        />

        <ZoneCard
          zoneKey="SH" label="Сухое хранение"
          rest={shRest}
          restUnit="СЗ"
          personHours={null}
          people={ov('SH_people')}
          speed={ov('SH_speed')}
          speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading}
          onPeople={v => updateOverride('SH_people', v)}
          onSpeed={v  => updateOverride('SH_speed', v)}
        />

        <ZoneCard
          zoneKey="HH" label="Холодное хранение"
          rest={hhRest}
          restUnit="СЗ"
          personHours={null}
          people={ov('HH_people')}
          speed={ov('HH_speed')}
          speedPlaceholder={avgSpeed}
          shiftEnd={shiftEnd} shiftEndTime={shiftEndTime} loading={loading}
          onPeople={v => updateOverride('HH_people', v)}
          onSpeed={v  => updateOverride('HH_speed', v)}
        />

        {/* Итого */}
        <div className={s.card}>
          <div className={s.cardHeader}>
            <span className={s.cardTitle}>Итого</span>
          </div>
          <ProgressBar done={totDone} total={totTasks} />
          <div className={s.statsGrid}>
            <StatRow label="Всего задач" value={fmt(totTasks)} />
            <StatRow label="Выполнено"   value={fmt(totDone)}  />
            <StatRow label="Остаток"     value={fmt(totRest)}  bold />
            <StatRow label="Готово"      value={totPct + '%'}  />
          </div>
        </div>

      </div>

      {/* ── Прогноз комплектации КДК ── */}
      {(loadingPickFcast || pickFcast) && (
        <div className={s.section}>
          <div className={s.sectionTitle}>
            Комплектация КДК
            {pickFcast && (
              <span className={s.pickMeta}>
                · {pickFcast.supplyCount} {pickFcast.supplyCount === 1 ? 'поставка' : pickFcast.supplyCount < 5 ? 'поставки' : 'поставок'}
                · {pickPct}% скомплектовано
              </span>
            )}
          </div>

          {loadingPickFcast && !pickFcast && (
            <div className={s.pickLoading}>
              <RefreshCw size={13} className={s.spinning} /> Загрузка данных комплектации...
            </div>
          )}

          {pickFcastRows && (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>Зона</th>
                    <th className={s.th}>Артикул</th>
                    <th className={s.th}>Название</th>
                    <th className={`${s.th} ${s.thR}`}>Принято</th>
                    <th className={`${s.th} ${s.thR}`}>Осталось</th>
                    <th className={`${s.th} ${s.thR}`}>Скорость</th>
                    <th className={`${s.th} ${s.thR}`}>Часов работы</th>
                  </tr>
                </thead>
                <tbody>
                  {pickFcastRows
                    .filter(r => r.remainingQty > 0)
                    .sort((a, b) => (b.personHours ?? 0) - (a.personHours ?? 0))
                    .map(row => (
                      <tr key={row.id} className={s.tr}>
                        <td className={s.td}>
                          <span className={s.zoneBadge}>{row.zone}</span>
                        </td>
                        <td className={s.td}>{row.code || '—'}</td>
                        <td className={s.td}>{row.name || '—'}</td>
                        <td className={s.tdNum}>{fmt(row.totalQty)}</td>
                        <td className={s.tdNum}><strong>{fmt(Math.round(row.remainingQty))}</strong></td>
                        <td className={s.tdNum}>
                          {row.speed != null
                            ? <span className={row.fromFallback ? s.speedFallback : ''}>{row.speed}</span>
                            : <span className={s.pickNoSpeed}>—</span>}
                        </td>
                        <td className={s.tdNum}>{row.personHours != null ? row.personHours.toFixed(2) : '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Hourly table ── */}
      {hourlyRows && hourlyRows.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionTitle}>Почасовая динамика</div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th className={s.th}>Час</th>
                  <th className={s.th}>КДК</th>
                  <th className={s.th}>Хранение</th>
                  <th className={s.th}>Итого</th>
                  <th className={s.th}>Людей</th>
                  <th className={s.th}>Ср. СЗ/чел</th>
                  <th className={s.th}>Тренд</th>
                </tr>
              </thead>
              <tbody>
                {hourlyRows.map((row, i) => {
                  const prev     = hourlyRows[i - 1]
                  const trend    = prev && prev.avg > 0 && row.avg > 0
                    ? row.avg > prev.avg ? '↑' : row.avg < prev.avg ? '↓' : '→'
                    : ''
                  const trendCls = trend === '↑' ? s.trendUp : trend === '↓' ? s.trendDown : s.trendFlat
                  const isAvgRow = row.avg > 0 && avgSpeed != null && row.avg >= avgSpeed
                  return (
                    <tr key={row.time} className={s.tr}>
                      <td className={s.td}>{row.time}</td>
                      <td className={s.tdNum}>{row.kdk  != null ? fmt(row.kdk)  : '—'}</td>
                      <td className={s.tdNum}>{row.stor != null ? fmt(row.stor) : '—'}</td>
                      <td className={s.tdNum}>{row.done > 0 ? fmt(row.done) : '—'}</td>
                      <td className={s.tdNum}>{row.sotrud != null ? fmt(row.sotrud) : '—'}</td>
                      <td className={`${s.tdNum} ${isAvgRow ? s.avgGood : ''}`}>
                        {row.avg > 0 ? row.avg : '—'}
                      </td>
                      <td className={`${s.tdNum} ${trendCls}`}>{trend}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && !picking && !error && (
        <div className={s.empty}>Нет данных за выбранную дату</div>
      )}

    </div>
  )
}
