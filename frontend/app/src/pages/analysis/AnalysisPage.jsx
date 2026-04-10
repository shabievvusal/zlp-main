import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import * as api from '../../api/index.js'
import { RefreshCw } from 'lucide-react'
import s from './AnalysisPage.module.css'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Разбираем ответ monitoring stats → { kdk, storage }
function parseMonitoringStats(data) {
  const v = data?.value
  if (!v) return null
  const pick = block => ({
    tasks: block?.totalTasks?.tasksCount     ?? 0,
    done:  block?.completedTasks?.tasksCount ?? 0,
    rest:  block?.remainingTasks?.tasksCount ?? 0,
  })
  return {
    kdk:     pick(v.pickByLineStats),
    storage: pick(v.pieceSelectionStats),
  }
}

// Считаем людей по операциям из live-данных мониторинга
function parseLivePeople(data) {
  const v = data?.value || data || {}
  const sections = [
    { key: 'pickByLineHandlingUnitsInProgress',    type: 'kdk' },
    { key: 'pieceSelectionHandlingUnitsInProgress', type: 'storage' },
  ]
  const counts = { kdk: 0, storage: 0 }
  const seen = new Set()
  for (const { key, type } of sections) {
    for (const entry of (v[key] || [])) {
      const u = entry.user || {}
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

// Средняя скорость по последним lastN ненулевым часам
function calcAvgSpeed(rows, lastN = 3) {
  if (!rows?.length) return null
  const nonZero = rows.filter(r => r.avg > 0 && r.sotrud > 0)
  const recent  = nonZero.slice(-lastN)
  if (!recent.length) return null
  return Math.round(recent.reduce((s, r) => s + r.avg, 0) / recent.length)
}

// Прогноз завершения и нужное кол-во людей
function calcForecast(rest, people, avgSpeed, shiftEnd) {
  if (!rest || !people || !avgSpeed || people <= 0 || avgSpeed <= 0 || !shiftEnd) return null
  const now          = new Date()
  const hoursNeeded  = rest / (people * avgSpeed)
  const projFinish   = new Date(now.getTime() + hoursNeeded * 3_600_000)
  const hoursLeft    = (shiftEnd - now) / 3_600_000
  const reqPeople    = hoursLeft > 0 ? Math.ceil(rest / (avgSpeed * hoursLeft)) : null
  const minDiff      = Math.round((shiftEnd - projFinish) / 60_000)
  const status       = minDiff >= 30 ? 'ok' : minDiff >= 0 ? 'warn' : 'over'
  return { projFinish, reqPeople, status, minDiff }
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
  const { status, projFinish, minDiff, reqPeople } = forecast
  const cls = status === 'ok' ? s.badgeOk : status === 'warn' ? s.badgeWarn : s.badgeOver
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
      {reqPeople != null && (
        <div className={s.forecastPeople}>
          Нужно людей: <strong>{reqPeople}</strong>
        </div>
      )}
    </div>
  )
}

function OperationCard({ title, data, people, forecast, shiftEndTime, loading }) {
  const done  = data?.done  ?? 0
  const total = data?.tasks ?? 0
  const rest  = data?.rest  ?? 0
  const pct   = total > 0 ? Math.round(done / total * 100) : 0

  const borderCls = !forecast ? ''
    : forecast.status === 'ok'   ? s.cardOk
    : forecast.status === 'warn' ? s.cardWarn
    : s.cardOver

  return (
    <div className={`${s.card} ${borderCls}`}>
      <div className={s.cardHeader}>
        <span className={s.cardTitle}>{title}</span>
        {people != null && (
          <span className={s.peopleBadge}>
            {people} чел.
          </span>
        )}
      </div>

      <ProgressBar done={done} total={total} />

      <div className={s.statsGrid}>
        <StatRow label="Всего задач"  value={fmt(total)} />
        <StatRow label="Выполнено"    value={fmt(done)}  />
        <StatRow label="Остаток"      value={fmt(rest)}  bold />
        <StatRow label="Готово"       value={pct + '%'}  />
      </div>

      {!loading && <ForecastBadge forecast={forecast} shiftEndTime={shiftEndTime} />}
      {loading && <div className={s.forecastLoading}>Расчёт...</div>}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AnalysisPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()

  const [date, setDate]               = useState(todayStr)
  const [shiftEndTime, setShiftEndTime] = useState('21:00')
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const [picking, setPicking]       = useState(null)  // { kdk, storage }
  const [people, setPeople]         = useState(null)  // { kdk: N, storage: N }
  const [hourlyRows, setHourlyRows] = useState(null)


  // Время конца смены как объект Date (сегодня)
  const shiftEnd = useMemo(() => {
    const [h, m] = shiftEndTime.split(':').map(Number)
    const d = new Date()
    d.setHours(h, m, 0, 0)
    return d
  }, [shiftEndTime])

  const fetchAll = useCallback(async (dateStr) => {
    let token = getToken()
    if (!token || !isTokenValid()) {
      const ok = await forceRefresh()
      if (!ok) { setError('Нет токена WMS. Войдите заново.'); return }
      token = getToken()
    }
    setLoading(true)
    setError(null)
    try {
      const { from, to } = shiftWindow(dateStr)
      const [monData, liveData, summaryData] = await Promise.all([
        api.getReportMonitoringStats(token, from, to),
        api.getLiveMonitorViaBrowser(token).catch(() => null),
        api.getDateSummaryFull(dateStr),
      ])

      // Задачи КДК / Хранение
      const parsed = parseMonitoringStats(monData)
      if (parsed) setPicking(parsed)

      // Люди по операциям
      if (liveData) setPeople(parseLivePeople(liveData))

      // Почасовые строки (бэкенд-час H → отображается как H+1:00)
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
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [getToken, isTokenValid, forceRefresh])

  useEffect(() => { fetchAll(date) }, [date, fetchAll])

  // Расчёты
  const avgSpeed  = calcAvgSpeed(hourlyRows)
  const kdkFcast  = picking && people?.kdk  != null && avgSpeed
    ? calcForecast(picking.kdk.rest,     people.kdk,     avgSpeed, shiftEnd)
    : null
  const storFcast = picking && people?.storage != null && avgSpeed
    ? calcForecast(picking.storage.rest, people.storage, avgSpeed, shiftEnd)
    : null

  const totTasks = (picking?.kdk.tasks ?? 0) + (picking?.storage.tasks ?? 0)
  const totDone  = (picking?.kdk.done  ?? 0) + (picking?.storage.done  ?? 0)
  const totRest  = (picking?.kdk.rest  ?? 0) + (picking?.storage.rest  ?? 0)
  const totPct   = totTasks > 0 ? Math.round(totDone / totTasks * 100) : 0

  return (
    <div className={s.page}>

      {/* ── Toolbar ── */}
      <div className={s.toolbar}>
        <h1 className={s.title}>Анализ смены</h1>
        <div className={s.controls}>
          <label className={s.field}>
            <span className={s.fieldLabel}>Дата</span>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className={s.input}
            />
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>Конец смены</span>
            <input
              type="time"
              value={shiftEndTime}
              onChange={e => setShiftEndTime(e.target.value)}
              className={s.input}
            />
          </label>
          <button
            className={s.refreshBtn}
            onClick={() => fetchAll(date)}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? s.spinning : ''} />
            Обновить
          </button>
          {lastUpdated && !loading && (
            <span className={s.updatedAt}>
              Обновлено в {fmtTime(lastUpdated)}
            </span>
          )}
        </div>
      </div>

      {error && <div className={s.error}>{error}</div>}

      {/* ── Speed / people info ── */}
      {avgSpeed != null && (
        <div className={s.speedBar}>
          <span>Средняя скорость (последние 3 часа):</span>
          <strong>{avgSpeed} СЗ / чел / час</strong>
          {people != null && (
            <>
              <span className={s.speedSep}>·</span>
              <span>КДК: <strong>{people.kdk} чел</strong></span>
              <span className={s.speedSep}>·</span>
              <span>Хранение: <strong>{people.storage} чел</strong></span>
            </>
          )}
        </div>
      )}

      {/* ── Operation cards ── */}
      <div className={s.cards}>

        <OperationCard
          title="Кроссдокинг"
          data={picking?.kdk}
          people={people?.kdk}
          forecast={kdkFcast}
          shiftEndTime={shiftEndTime}
          loading={loading}
        />

        <OperationCard
          title="Хранение"
          data={picking?.storage}
          people={people?.storage}
          forecast={storFcast}
          shiftEndTime={shiftEndTime}
          loading={loading}
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
                  const prev    = hourlyRows[i - 1]
                  const trend   = prev && prev.avg > 0 && row.avg > 0
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

      {/* Пустое состояние */}
      {!loading && !picking && !error && (
        <div className={s.empty}>Нет данных за выбранную дату</div>
      )}

    </div>
  )
}
