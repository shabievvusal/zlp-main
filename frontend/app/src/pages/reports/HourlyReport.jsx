import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api/index.js'
import s from './HourlyReport.module.css'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

/** Окно для мониторинга отборки: дата-1 18:00Z → дата 18:00Z */
function shiftWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, d - 1, 18, 0, 0, 0))
  const to   = new Date(Date.UTC(y, m - 1, d,     18, 0, 0, 0))
  return { from: from.toISOString(), to: to.toISOString() }
}

/** Окно для приёмки: дата-1 21:00Z → дата 20:59:59.999Z (календарный день МСК) */
function inboundWindow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, d - 1, 21, 0, 0, 0))
  const to   = new Date(Date.UTC(y, m - 1, d,     20, 59, 59, 999))
  return { from: from.toISOString(), to: to.toISOString() }
}

function fmt(v) {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString('ru-RU')
}

function fmtPct(done, total) {
  if (!total) return '—'
  return Math.round(done / total * 100) + '%'
}

// ─── Manual fields persistence ───────────────────────────────────────────────

const MANUAL_DEFAULTS = {
  shiftTotal: '',
  shipPlan: '', shipPrepared: '', shipShipped: '', shipInProgress: '', shipDelay: '',
  rkTotal: '',
  rcpKdkPlan: '', rcpStorPlan: '',
}

function loadManual(dateStr) {
  try { return { ...MANUAL_DEFAULTS, ...JSON.parse(localStorage.getItem(`hr_manual_${dateStr}`) ?? '{}') } }
  catch { return { ...MANUAL_DEFAULTS } }
}

// ─── Process persistence ──────────────────────────────────────────────────────

const DEFAULT_PROC_NAMES = ['Кросс-докинг', 'Хранение']
const FIXED_PROC_NAMES  = new Set(['Кросс-докинг', 'Хранение'])

function loadProcData(dateStr) {
  try { return JSON.parse(localStorage.getItem(`hr_proc_${dateStr}`) ?? '{}') }
  catch { return {} }
}


// ─── Разбор ответа мониторинга в структуру picking ───────────────────────────

function parseMonitoringStats(data) {
  const v = data?.value
  if (!v) return null
  const pick = (block) => ({
    tasks: block?.totalTasks?.tasksCount     ?? 0,
    done:  block?.completedTasks?.tasksCount ?? 0,
    rest:  block?.remainingTasks?.tasksCount ?? 0,
  })
  return {
    kdk:     pick(v.pickByLineStats),
    storage: pick(v.pieceSelectionStats),
  }
}

const LS_ACCESS_KEY = 'wms_access_token'

/** Подсчёт статистики РК из массива маршрутов.
 *  Возвращает { perHourTC, perHourRK, deliveredRK } где:
 *  - perHourTC/perHourRK — за последний час, в котором были приёмки с rk > 0
 *  - deliveredRK — итого за все часы */
function calcRkStats(routes) {
  const byHour = new Map()
  for (const route of routes) {
    const recv = route.receiving
    if (!recv?.at) continue
    const totalRk = (recv.items || []).reduce((s, it) => s + (Number(it.rk) || 0), 0)
    if (totalRk === 0) continue
    const h = new Date(new Date(recv.at).getTime() + 3 * 3600 * 1000).getUTCHours()
    const cur = byHour.get(h) || { tc: 0, rk: 0 }
    cur.tc++
    cur.rk += totalRk
    byHour.set(h, cur)
  }
  const deliveredRK = [...byHour.values()].reduce((s, v) => s + v.rk, 0)
  const hours = [...byHour.keys()].sort((a, b) => a - b)
  const last = hours.length ? byHour.get(hours[hours.length - 1]) : null
  return { perHourTC: last?.tc ?? 0, perHourRK: last?.rk ?? 0, deliveredRK }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function HourlyReport() {
  const [date, setDate]           = useState(todayStr())
  const [picking, setPicking]     = useState(null)
  const [reception, setReception] = useState(null)
  const [repl, setRepl]           = useState(null)
  const [hourlyData, setHourlyData] = useState(null)
  const [rkStats, setRkStats]     = useState(null)
  const [upToHour, setUpToHour]   = useState('')   // '' = все доступные часы
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)

  // ── Процессы: имена глобально, счётчики по дате ──────────────────────────
  const [procNames, setProcNames] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('hr_proc_names') ?? 'null')
      if (!saved) return DEFAULT_PROC_NAMES
      // Фиксированные имена всегда идут первыми, даже если были удалены из localStorage
      const extra = saved.filter(n => !FIXED_PROC_NAMES.has(n))
      return [...DEFAULT_PROC_NAMES, ...extra]
    } catch { return DEFAULT_PROC_NAMES }
  })
  const [procData, setProcData] = useState(() => loadProcData(todayStr()))
  const [newProcName, setNewProcName] = useState('')

  useEffect(() => {
    localStorage.setItem('hr_proc_names', JSON.stringify(procNames))
  }, [procNames])

  useEffect(() => {
    localStorage.setItem(`hr_proc_${date}`, JSON.stringify(procData))
  }, [procData, date])

  // При смене даты — загружаем счётчики для той даты
  useEffect(() => { setProcData(loadProcData(date)) }, [date])

  // ── Ручные поля: отгрузка, РК, план приёмки ──────────────────────────────
  const [manual, setManual] = useState(() => loadManual(todayStr()))
  useEffect(() => {
    localStorage.setItem(`hr_manual_${date}`, JSON.stringify(manual))
  }, [manual, date])
  useEffect(() => { setManual(loadManual(date)) }, [date])

  function setM(field, val) { setManual(prev => ({ ...prev, [field]: val })) }
  function mi(field) {  // input props для числового ручного поля
    return {
      type: 'number', min: '0', className: s.procInput,
      value: manual[field], onChange: e => setM(field, e.target.value), placeholder: '—',
    }
  }

  const procs = procNames.map(name => ({ name, cnt: procData[name] ?? '' }))

  function setProcCnt(name, val) {
    setProcData(prev => ({ ...prev, [name]: val }))
  }
  function addProc() {
    const name = newProcName.trim()
    if (!name || procNames.includes(name)) return
    setProcNames(prev => [...prev, name])
    setNewProcName('')
  }
  function removeProc(name) {
    if (FIXED_PROC_NAMES.has(name)) return
    setProcNames(prev => prev.filter(n => n !== name))
  }

  const getToken = () => localStorage.getItem(LS_ACCESS_KEY)

  // Загрузка всех данных при смене даты
  const fetchAll = useCallback(async (dateStr) => {
    const token = getToken()
    if (!token) { setError('Токен не найден. Войдите в систему.'); return }
    setLoading(true)
    setError(null)
    try {
      const { from: monFrom, to: monTo } = shiftWindow(dateStr)
      const { from: rcpFrom, to: rcpTo } = inboundWindow(dateStr)

      const [monData, kdkDoneData, storDoneData, kdkInProgData, storInProgData, movData, movRestData, movPickData, movPickRestData, summaryData, rkRoutesData] = await Promise.all([
        api.getReportMonitoringStats(token, monFrom, monTo),
        api.getReportInboundCompleted(token,        { types: 'CROSSDOCK',                         completedAtDateFrom: rcpFrom, completedAtDateTo: rcpTo }),
        api.getReportInboundCompleted(token,        { types: ['STORAGE_DC', 'STORAGE', 'IMPORT'], completedAtDateFrom: rcpFrom, completedAtDateTo: rcpTo }),
        api.getReportInboundInProgress(token,       { types: 'CROSSDOCK' }),
        api.getReportInboundInProgress(token,       { types: ['STORAGE_DC', 'STORAGE', 'IMPORT'] }),
        api.getReportMovementsCount(token,          { dateFrom: rcpFrom, dateTo: rcpTo }),
        api.getReportMovementsRest(token,           { dateFrom: rcpFrom, dateTo: rcpTo }),
        api.getReportMoveToPickingCount(token,      { dateFrom: rcpFrom, dateTo: rcpTo }),
        api.getReportMoveToPickingRest(token,       { dateFrom: rcpFrom, dateTo: rcpTo }),
        api.getDateSummaryFull(dateStr),
        api.getRkRoutes({ dateFrom: dateStr, dateTo: dateStr }).catch(() => []),
      ])

      const parsed = parseMonitoringStats(monData)
      if (parsed) setPicking(parsed)

      setReception(prev => ({
        kdk:     { plan: prev?.kdk?.plan     ?? 0, waiting: prev?.kdk?.waiting     ?? 0,
                   received:  kdkDoneData?.value?.total   ?? 0,
                   receiving: kdkInProgData?.value?.total ?? 0 },
        storage: { plan: prev?.storage?.plan ?? 0, waiting: prev?.storage?.waiting ?? 0,
                   received:  storDoneData?.value?.total  ?? 0,
                   receiving: storInProgData?.value?.total ?? 0 },
      }))

      // Пополнение
      // Спуски: Задачи = total спусков, Выполнено = задачи − остаток, Остаток = новые/в работе
      // Перемещение: Задачи = то же число спусков (1:1), Выполнено = total перемещений − остаток,
      //              Остаток = остаток спусков + остаток перемещений
      const movTotal    = movData?.value?.total         ?? 0
      const movRest     = movRestData?.value?.total     ?? 0
      const movPickTotal = movPickData?.value?.total    ?? 0
      const movPickRest  = movPickRestData?.value?.total ?? 0
      setRepl({
        descents: { tasks: movTotal,  done: movTotal - movRest,         rest: movRest },
        moves:    { tasks: movTotal,  done: movPickTotal - movPickRest, rest: movRest + movPickRest },
      })

      // Почасовые строки из нашей статистики
      if (Array.isArray(summaryData?.hourly)) {
        // Индексируем по часу МСК
        const byHour = new Map()
        for (const h of summaryData.hourly) byHour.set(h.hour, h)

        // Ночной блок: бэкенд-часы 21,22,23 + 0..8 → отображается как "00:00 - 9:00"
        const BLOCK_HOURS = [21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8]
        let blkKdk = 0, blkStor = 0, blkEmpl = 0, blkDone = 0
        for (const h of BLOCK_HOURS) {
          const hd = byHour.get(h)
          if (!hd) continue
          blkKdk  += hd.kdkOps
          blkStor += hd.ops - hd.kdkOps
          blkDone += hd.ops
          blkEmpl  = Math.max(blkEmpl, hd.employeesKompl ?? hd.employees)
        }

        // Индивидуальные строки 10:00–20:00 (не трогаем, только реальные данные).
        // Строка "H:00" показывает бэкенд-час H-1 (сдвиг +1 для совпадения с WMS).
        const INDIVIDUAL_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
        const rows = INDIVIDUAL_HOURS.map(h => {
          const hd = byHour.get(h - 1)
          if (!hd || hd.ops === 0) return { time: `${String(h).padStart(2,'0')}:00`, kdk: null, stor: null, sotrud: null, done: 0, avg: 0, kdkEmp: null, storageEmp: null }
          const kdk  = hd.kdkOps
          const stor = hd.ops - hd.kdkOps
          const done = hd.ops
          const empl = hd.employeesKompl ?? hd.employees
          return {
            time:   `${String(h).padStart(2,'0')}:00`,
            kdk:    kdk  > 0 ? kdk  : null,
            stor:   stor > 0 ? stor : null,
            sotrud: empl > 0 ? empl : null,
            done,
            avg:    empl > 0 ? Math.round(done / empl) : 0,
            kdkEmp:     (hd.kdkEmployees     ?? 0) > 0 ? hd.kdkEmployees     : null,
            storageEmp: (hd.storageEmployees ?? 0) > 0 ? hd.storageEmployees : null,
          }
        })

        // Reconciliation: 21:00 — только если уже наступило (MSK ≥ 21:00) или просматриваем прошлое
        const moscowHourNow = new Date(Date.now() + 3 * 60 * 60 * 1000).getUTCHours()
        const isPastDate    = dateStr < todayStr()
        const show21        = isPastDate || moscowHourNow >= 21

        const wmsKdk  = parsed?.kdk.done  ?? 0
        const wmsStor = parsed?.storage.done ?? 0
        let sumKdk = blkKdk, sumStor = blkStor
        for (const r of rows) { sumKdk += r.kdk ?? 0; sumStor += r.stor ?? 0 }
        const adjKdk  = wmsKdk  - sumKdk
        const adjStor = wmsStor - sumStor
        if (show21 && (adjKdk > 0 || adjStor > 0)) {
          const hd21 = byHour.get(20)
          const empl = hd21 ? (hd21.employeesKompl ?? hd21.employees ?? 0) : 0
          const newKdk  = adjKdk  > 0 ? adjKdk  : null
          const newStor = adjStor > 0 ? adjStor : null
          const newDone = (adjKdk > 0 ? adjKdk : 0) + (adjStor > 0 ? adjStor : 0)
          rows.push({
            time:       '21:00',
            kdk:        newKdk,
            stor:       newStor,
            sotrud:     empl > 0 ? empl : null,
            done:       newDone,
            avg:        empl > 0 && newDone > 0 ? Math.round(newDone / empl) : 0,
            kdkEmp:     hd21 && (hd21.kdkEmployees     ?? 0) > 0 ? hd21.kdkEmployees     : null,
            storageEmp: hd21 && (hd21.storageEmployees ?? 0) > 0 ? hd21.storageEmployees : null,
          })
        }

        // Block row: sum kdk/storage employees across block hours
        let blkKdkEmp = 0, blkStorageEmp = 0
        for (const h of BLOCK_HOURS) {
          const hd = byHour.get(h)
          if (!hd) continue
          blkKdkEmp     += hd.kdkEmployees     ?? 0
          blkStorageEmp += hd.storageEmployees ?? 0
        }
        const blockRow = {
          time:       '00:00 - 9:00',
          kdk:        blkKdk  > 0 ? blkKdk  : null,
          stor:       blkStor > 0 ? blkStor : null,
          sotrud:     blkEmpl > 0 ? blkEmpl : null,
          done:       blkDone,
          avg:        0,
          kdkEmp:     blkKdkEmp     > 0 ? blkKdkEmp     : null,
          storageEmp: blkStorageEmp > 0 ? blkStorageEmp : null,
        }
        setHourlyData([blockRow, ...rows])
      }

      if (Array.isArray(rkRoutesData)) setRkStats(calcRkStats(rkRoutesData))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll(date) }, [date, fetchAll])

  // Отборка — итоги
  const kdkT = picking?.kdk.tasks   ?? 0, kdkD = picking?.kdk.done   ?? 0, kdkR = picking?.kdk.rest   ?? 0
  const storT = picking?.storage.tasks ?? 0, storD = picking?.storage.done ?? 0, storR = picking?.storage.rest ?? 0
  const totT = kdkT + storT, totD = kdkD + storD, totR = kdkR + storR

  // Приёмка — итоги
  const rk = reception?.kdk     ?? { plan: 0, received: 0, receiving: 0, waiting: 0 }
  const rs = reception?.storage ?? { plan: 0, received: 0, receiving: 0, waiting: 0 }
  const rt = {
    plan:      rk.plan      + rs.plan,
    received:  rk.received  + rs.received,
    receiving: rk.receiving + rs.receiving,
    waiting:   rk.waiting   + rs.waiting,
  }

  // Пополнение
  const replData = repl ?? { descents: { tasks: 0, done: 0, rest: 0 }, moves: { tasks: 0, done: 0, rest: 0 } }

  // Почасовые строки — скрываем пустые + обрезаем по upToHour
  const hourly = hourlyData
    ? hourlyData.filter(row => row.done > 0 && (!upToHour || row.time <= upToHour))
    : []

  // Часы для селекта — только те, где есть данные
  const availableHours = hourlyData ? hourlyData.filter(r => r.done > 0).map(r => r.time) : []

  // Кол-во людей в КДК/Хранении — последний час с данными в текущем фильтре
  const shiftKdkEmp     = [...hourly].reverse().find(r => r.kdkEmp     !== null)?.kdkEmp     ?? null
  const shiftStorageEmp = [...hourly].reverse().find(r => r.storageEmp !== null)?.storageEmp ?? null

  // Итого задействовано по процессам
  const totalAllocated = (shiftKdkEmp ?? 0)
    + (shiftStorageEmp ?? 0)
    + procs.filter(p => !FIXED_PROC_NAMES.has(p.name)).reduce((s, p) => s + (Number(p.cnt) || 0), 0)
  const unallocated = manual.shiftTotal !== '' ? (Number(manual.shiftTotal) || 0) - totalAllocated : null

  return (
    <div className={s.root}>
      {/* Тулбар */}
      <div className={s.toolbar}>
        <div className={s.field}>
          <label>Дата</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className={s.dateInput}
          />
        </div>
        {availableHours.length > 0 && (
          <div className={s.field}>
            <label>До</label>
            <select value={upToHour} onChange={e => setUpToHour(e.target.value)} className={s.dateInput}>
              <option value=''>Все</option>
              {availableHours.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        )}
        {loading && <span className={s.statusLoading}>Загрузка...</span>}
        {error   && <span className={s.statusError}>{error}</span>}
        {!loading && (
          <button className={'btn btn-secondary btn-sm'} onClick={() => fetchAll(date)}>
            Обновить
          </button>
        )}
      </div>

      {/* Основная таблица + панель ввода */}
      <div className={s.pageBody}>
      <div className={s.wrap}>
        <table className={s.t}>
          {/*
            Схема колонок (9 всего):
            C0 — метка/время (140px)
            C1 — КДК значение (82px)
            C2 — Хранение значение (82px)
            C3 — Итог / Кол-во сотр. в час (95px)
            C4 — Выполнено са в час (115px)
            C5 — Сред. кол-во СЗ (70px)
            C6 — Процесс (148px)
            C7 — Кол-во сотр. 1 (66px)
            C8 — Кол-во сотр. 2 (66px)
          */}
          <colgroup>
            <col style={{ width: '140px' }} />
            <col style={{ width: '82px'  }} />
            <col style={{ width: '82px'  }} />
            <col style={{ width: '95px'  }} />
            <col style={{ width: '115px' }} />
            <col style={{ width: '70px'  }} />
            <col style={{ width: '148px' }} />
            <col style={{ width: '66px'  }} />
            <col style={{ width: '66px'  }} />
          </colgroup>
          <tbody>

            {/* ══════════════ ОТБОРКА ══════════════════════════════════ */}
            {/* Заголовок */}
            <tr>
              <td className={s.e} />
              <td className={s.yh}>КДК</td>
              <td className={s.yh}>Хранение</td>
              <td className={s.yh} colSpan={3}>Итог</td>
              {/* Правая часть (процессы) отсутствует в блоке Отборки — скрытая область */}
              <td className={s.inv} colSpan={3} rowSpan={5} />
            </tr>
            <tr>
              <td className={s.lbl}>Задачи</td>
              <td className={s.v}>{fmt(kdkT)}</td>
              <td className={s.v}>{fmt(storT)}</td>
              <td className={s.v} colSpan={3}>{fmt(totT)}</td>
            </tr>
            <tr>
              <td className={s.lbl}>Выполнено</td>
              <td className={s.v}>{fmt(kdkD)}</td>
              <td className={s.v}>{fmt(storD)}</td>
              <td className={s.v} colSpan={3}>{fmt(totD)}</td>
            </tr>
            <tr>
              <td className={s.lbl}>Остаток</td>
              <td className={s.v}>{fmt(kdkR)}</td>
              <td className={s.v}>{fmt(storR)}</td>
              <td className={s.v} colSpan={3}>{fmt(totR)}</td>
            </tr>
            <tr>
              <td className={s.lbl}>% отборки</td>
              <td className={s.v}>{fmtPct(kdkD, kdkT)}</td>
              <td className={s.v}>{fmtPct(storD, storT)}</td>
              <td className={s.v} colSpan={3}>{fmtPct(totD, totT)}</td>
            </tr>

            {/* ══════════════ ЗАГОЛОВОК ЧАСОВОЙ ТАБЛИЦЫ ═══════════════ */}
            <tr>
              <td className={s.e} colSpan={3} />
              <td className={s.subh}>Кол-во<br />сотрудников<br />в час</td>
              <td className={s.subh}>Выполнено<br />са в час</td>
              <td className={s.subh}>Сред.<br />кол-во<br />СЗ</td>
              <td className={s.yh}>Процесс</td>
              <td className={s.yh} colSpan={2}>Кол-во сотр.</td>
            </tr>

            {/* ══════════════ ПОЧАСОВЫЕ ДАННЫЕ ════════════════════════ */}
            {hourly.map((row, i) => {
              const proc = procs[i]
              const isKdk     = proc?.name === 'Кросс-докинг'
              const isStorage = proc?.name === 'Хранение'
              const isFixed   = isKdk || isStorage
              // Auto value from stats (or manual if no stats data for that row)
              // Для фиксированных процессов — агрегат по всей смене (не привязан к конкретному часу)
              const autoVal = isKdk ? shiftKdkEmp : isStorage ? shiftStorageEmp : null
              return (
                <tr key={row.time}>
                  <td className={s.lbl}>{row.time}</td>
                  <td className={s.v}>{fmt(row.kdk)}</td>
                  <td className={s.v}>{fmt(row.stor)}</td>
                  <td className={s.v}>{fmt(row.sotrud)}</td>
                  <td className={s.v}>{row.done !== null ? (row.done === 0 ? '0' : fmt(row.done)) : ''}</td>
                  <td className={s.v}>{row.avg  !== null ? (row.avg  === 0 ? '0' : fmt(row.avg))  : ''}</td>
                  {proc ? (
                    <>
                      <td className={s.pn}>
                        <span className={s.procName}>{proc.name}</span>
                        {!isFixed && (
                          <button type="button" className={s.procRemove} onClick={() => removeProc(proc.name)} title="Удалить">×</button>
                        )}
                      </td>
                      <td className={s.v} colSpan={2}>
                        {isFixed ? (
                          <span>{autoVal !== null ? fmt(autoVal) : '—'}</span>
                        ) : (
                          <input
                            type="number"
                            min="0"
                            className={s.procInput}
                            value={proc.cnt}
                            onChange={e => setProcCnt(proc.name, e.target.value)}
                            placeholder="—"
                          />
                        )}
                      </td>
                    </>
                  ) : (
                    <td className={s.e} colSpan={3} />
                  )}
                </tr>
              )
            })}

            {/* Дополнительные процессы, которых больше чем почасовых строк */}
            {procs.slice(hourly.length).map(proc => {
              const isFixed = FIXED_PROC_NAMES.has(proc.name)
              const autoVal = proc.name === 'Кросс-докинг' ? shiftKdkEmp : proc.name === 'Хранение' ? shiftStorageEmp : null
              return (
                <tr key={proc.name}>
                  <td className={s.e} colSpan={6} />
                  <td className={s.pn}>
                    <span className={s.procName}>{proc.name}</span>
                    {!isFixed && (
                      <button type="button" className={s.procRemove} onClick={() => removeProc(proc.name)} title="Удалить">×</button>
                    )}
                  </td>
                  <td className={s.v} colSpan={2}>
                    {isFixed ? (
                      <span>{autoVal !== null ? fmt(autoVal) : '—'}</span>
                    ) : (
                      <input
                        type="number"
                        min="0"
                        className={s.procInput}
                        value={proc.cnt}
                        onChange={e => setProcCnt(proc.name, e.target.value)}
                        placeholder="—"
                      />
                    )}
                  </td>
                </tr>
              )
            })}

            {/* Итого по процессам */}
            <tr>
              <td className={s.e} colSpan={6} />
              <td className={s.subh}>Итого</td>
              <td className={s.v} colSpan={2} style={{ fontWeight: 600 }}>{fmt(totalAllocated)}</td>
            </tr>

            {/* Добавить процесс */}
            <tr>
              <td className={s.e} colSpan={6} />
              <td className={s.e} colSpan={3}>
                <div className={s.addProcRow}>
                  <input
                    type="text"
                    className={s.addProcInput}
                    placeholder="Новый процесс..."
                    value={newProcName}
                    onChange={e => setNewProcName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addProc()}
                  />
                  <button type="button" className={s.addProcBtn} onClick={addProc}>+</button>
                </div>
              </td>
            </tr>

            {/* ══════════════ ПОПОЛНЕНИЕ ══════════════════════════════ */}
            <tr>
              <td className={s.yh} colSpan={6}>Пополнение</td>
              <td className={s.e} colSpan={3} />
            </tr>
            <tr>
              <td className={s.e} />
              <td className={s.sh2} colSpan={2}>Спуски</td>
              <td className={s.sh2} colSpan={3}>Перемещение</td>
              <td className={s.e} colSpan={3} />
            </tr>
            {[
              ['Задачи',    replData.descents.tasks, replData.moves.tasks],
              ['Выполнено', replData.descents.done,  replData.moves.done ],
              ['Остаток',   replData.descents.rest,  replData.moves.rest ],
            ].map(([lbl, v1, v2]) => (
              <tr key={lbl}>
                <td className={s.lbl}>{lbl}</td>
                <td className={s.v} colSpan={2}>{fmt(v1)}</td>
                <td className={s.v} colSpan={3}>{fmt(v2)}</td>
                <td className={s.e} colSpan={3} />
              </tr>
            ))}

            {/* ══════════════ ОТГРУЗКА ════════════════════════════════ */}
            {/* ══════════════ ОТГРУЗКА ════════════════════════════════ */}
            <tr>
              <td className={s.yh} colSpan={6}>Отгрузка</td>
              <td className={s.e} colSpan={3} />
            </tr>
            {[
              ['План',            manual.shipPlan],
              ['Подготовлено ТС', manual.shipPrepared],
              ['Отгружено',       manual.shipShipped],
              ['Отгружается',     manual.shipInProgress],
              ['Задержка',        manual.shipDelay],
            ].map(([lbl, val]) => (
              <tr key={lbl}>
                <td className={s.lbl}>{lbl}</td>
                <td className={s.v} colSpan={5}>{fmt(val)}</td>
                <td className={s.e} colSpan={3} />
              </tr>
            ))}

            {/* ══════════════ РОЛЛКЕЙДЖИ ══════════════════════════════ */}
            <tr>
              <td className={s.yh} colSpan={6}>Роллкейджи</td>
              <td className={s.e} colSpan={3} />
            </tr>
            {[
              ['За час ТС',       rkStats?.perHourTC  ?? null],
              ['За час РК',       rkStats?.perHourRK  ?? null],
              ['Сдано РК',        rkStats?.deliveredRK ?? null],
              ['Общее кол-во РК', (rkStats?.deliveredRK ?? 0) + (Number(manual.rkTotal) || 0) || null],
            ].map(([lbl, val]) => (
              <tr key={lbl}>
                <td className={s.lbl}>{lbl}</td>
                <td className={s.v} colSpan={5}>{fmt(val)}</td>
                <td className={s.e} colSpan={3} />
              </tr>
            ))}

            {/* ══════════════ ПРИЁМКА ══════════════════════════════════ */}
            <tr>
              <td className={s.yh} colSpan={9}>Приёмка</td>
            </tr>
            <tr>
              <td className={s.e} />
              <td className={s.yh}>КДК</td>
              <td className={s.yh}>Хранение</td>
              <td className={s.yh} colSpan={6}>Итог</td>
            </tr>
            <tr>
              <td className={s.lbl}>План</td>
              <td className={s.v}>{fmt(manual.rcpKdkPlan)}</td>
              <td className={s.v}>{fmt(manual.rcpStorPlan)}</td>
              <td className={s.v} colSpan={6}>{fmt((Number(manual.rcpKdkPlan) || 0) + (Number(manual.rcpStorPlan) || 0)) || '—'}</td>
            </tr>
            {[
              ['Принято',     rk.received,  rs.received,  rt.received  ],
              ['Принимается', rk.receiving, rs.receiving, rt.receiving ],
              ['Ожидаем',     rk.waiting,   rs.waiting,   rt.waiting   ],
            ].map(([lbl, v1, v2, vt]) => (
              <tr key={lbl}>
                <td className={s.lbl}>{lbl}</td>
                <td className={s.v}>{fmt(v1)}</td>
                <td className={s.v}>{fmt(v2)}</td>
                <td className={s.v} colSpan={6}>{fmt(vt)}</td>
              </tr>
            ))}

          </tbody>
        </table>
      </div>

      {/* ── Панель ручного ввода справа ── */}
      <div className={s.inputPanel}>
        <div className={s.inputSection}>
          <div className={s.inputSectionTitle}>Смена</div>
          <div className={s.inputRow}>
            <span className={s.inputLbl}>Всего</span>
            <input {...mi('shiftTotal')} className={s.panelInput} />
          </div>
          <div className={s.inputRow}>
            <span className={s.inputLbl}>Задействовано</span>
            <span className={s.panelValue}>{fmt(totalAllocated) || '—'}</span>
          </div>
          <div className={s.inputRow}>
            <span className={s.inputLbl}>Не задействовано</span>
            <span className={s.panelValue} style={unallocated !== null && unallocated < 0 ? { color: '#d32f2f', fontWeight: 700 } : {}}>
              {unallocated !== null ? fmt(unallocated) || '0' : '—'}
            </span>
          </div>
        </div>

        <div className={s.inputSection}>
          <div className={s.inputSectionTitle}>Отгрузка</div>
          {[
            ['План',            'shipPlan'],
            ['Подготовлено ТС', 'shipPrepared'],
            ['Отгружено',       'shipShipped'],
            ['Отгружается',     'shipInProgress'],
            ['Задержка',        'shipDelay'],
          ].map(([lbl, field]) => (
            <div key={field} className={s.inputRow}>
              <span className={s.inputLbl}>{lbl}</span>
              <input {...mi(field)} className={s.panelInput} />
            </div>
          ))}
        </div>

        <div className={s.inputSection}>
          <div className={s.inputSectionTitle}>Роллкейджи</div>
          <div className={s.inputRow}>
            <span className={s.inputLbl}>Общее кол-во РК</span>
            <input {...mi('rkTotal')} className={s.panelInput} />
          </div>
        </div>

        <div className={s.inputSection}>
          <div className={s.inputSectionTitle}>Приёмка — план</div>
          {[
            ['КДК',     'rcpKdkPlan'],
            ['Хранение','rcpStorPlan'],
          ].map(([lbl, field]) => (
            <div key={field} className={s.inputRow}>
              <span className={s.inputLbl}>{lbl}</span>
              <input {...mi(field)} className={s.panelInput} />
            </div>
          ))}
        </div>
      </div>

      </div>
    </div>
  )
}
