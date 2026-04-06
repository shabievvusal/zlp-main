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

// ─── Mock data (replace with API) ────────────────────────────────────────────

const MOCK = {
  picking: {
    kdk:     { tasks: 17237, done: 3423,  rest: 13814 },
    storage: { tasks: 38409, done: 21821, rest: 16588 },
  },
  // Hourly rows: time + КДК выполнено + Хранение выполнено + Сотрудников в час + Итого выполнено + Сред СЗ
  hourly: [
    { time: '00:00 - 9:00', kdk: null, stor: 12526, sotrud: null, done: 12526, avg: 0  },
    { time: '10:00',        kdk: 19,   stor: 3053,  sotrud: 65,   done: 3072,  avg: 47 },
    { time: '11:00',        kdk: 1460, stor: 2460,  sotrud: 82,   done: 3920,  avg: 60 },
    { time: '12:00',        kdk: 1944, stor: 3782,  sotrud: 82,   done: 5726,  avg: 70 },
    { time: '13:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '14:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '15:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '16:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '17:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '18:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '19:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '20:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
    { time: '21:00',        kdk: null, stor: null,  sotrud: null, done: 0,     avg: 0  },
  ],
  // 21 процессов — выровнены по строкам таблицы:
  // 0–12: строки почасовой (00:00 - 21:00)
  // 13: Пополнение header
  // 14: Пополнение sub-header
  // 15–17: Пополнение данные
  // 18: Отгрузка header
  // 19: Отгрузка — план
  // 20: Отгрузка — подготовлено
  processes: [
    { name: 'Комплектация',         cnt: 82,  cnt2: null },
    { name: 'Паллеты',              cnt: 2,   cnt2: null },
    { name: 'Уборка',               cnt: 3,   cnt2: null },
    { name: 'ВП',                   cnt: 6,   cnt2: null },
    { name: 'Спуски',               cnt: 0,   cnt2: null },
    { name: 'Приёмка',              cnt: 9,   cnt2: null },
    { name: 'Размиксовка',          cnt: 5,   cnt2: null },
    { name: 'Заморозка',            cnt: 8,   cnt2: null },
    { name: 'Бригадиры',            cnt: 2,   cnt2: null },
    { name: 'Обед',                 cnt: 0,   cnt2: null },
    { name: 'Полки',                cnt: 0,   cnt2: null },
    { name: 'Работают с 8:00',      cnt: 0,   cnt2: null },
    { name: 'Замотка РК',           cnt: 0,   cnt2: null },
    { name: 'Отгрузка ТС',          cnt: 4,   cnt2: null },
    { name: 'Обучение новых сотр.', cnt: 0,   cnt2: null },
    { name: 'Консолидация',         cnt: 0,   cnt2: null },
    { name: 'Пресс',                cnt: 0,   cnt2: null },
    { name: 'Проверка РК',          cnt: 0,   cnt2: null },
    { name: 'Переупаковка',         cnt: 0,   cnt2: null },
    { name: 'Коробки',              cnt: 2,   cnt2: 0    },
    { name: 'Итого',                cnt: 123, cnt2: 123  },
  ],
  replenishment: {
    descents: { tasks: 254, done: 254, rest: 0 },
    moves:    { tasks: 254, done: 254, rest: 0 },
  },
  shipment: {
    plan: 84, prepared: 84, shipped: 79, inProgress: 3, delay: 0,
    perHourTC: 2, perHourRK: 37, deliveredRK: 220, totalRK: 526,
  },
  reception: {
    kdk:     { plan: 59, received: 24, receiving: 13, waiting: 0 },
    storage: { plan: 68, received: 36, receiving: 22, waiting: 0 },
  },
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function HourlyReport() {
  const [date, setDate]           = useState(todayStr())
  const [picking, setPicking]     = useState(null)
  const [reception, setReception] = useState(null)
  const [repl, setRepl]           = useState(null)
  const [hourlyData, setHourlyData] = useState(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)

  // Остальные блоки пока из мока
  const { processes: procs, shipment: ship } = MOCK

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

      const [monData, kdkDoneData, storDoneData, kdkInProgData, storInProgData, movData, movRestData, movPickData, movPickRestData, summaryData] = await Promise.all([
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
      ])

      const parsed = parseMonitoringStats(monData)
      if (parsed) setPicking(parsed)

      setReception(prev => ({
        kdk:     { ...(prev?.kdk     ?? MOCK.reception.kdk),
                   received:  kdkDoneData?.value?.total   ?? 0,
                   receiving: kdkInProgData?.value?.total ?? 0 },
        storage: { ...(prev?.storage ?? MOCK.reception.storage),
                   received:  storDoneData?.value?.total  ?? 0,
                   receiving: storInProgData?.value?.total ?? 0 },
      }))

      // Пополнение — спуски и перемещения (выполнено + остаток)
      const movDone     = movData?.value?.total         ?? 0
      const movRest     = movRestData?.value?.total     ?? 0
      const movPickDone = movPickData?.value?.total     ?? 0
      const movPickRest = movPickRestData?.value?.total ?? 0
      setRepl({
        descents: { done: movDone,     rest: movRest,     tasks: movDone     + movRest     },
        moves:    { done: movPickDone, rest: movPickRest, tasks: movPickDone + movPickRest },
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

        // Индивидуальные строки 10:00..21:00.
        // Строка "H:00" показывает бэкенд-час H-1 (сдвиг +1 для совпадения с WMS)
        const INDIVIDUAL_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
        const rows = INDIVIDUAL_HOURS.map(h => {
          const hd = byHour.get(h - 1)
          if (!hd || hd.ops === 0) return { time: `${String(h).padStart(2,'0')}:00`, kdk: null, stor: null, sotrud: null, done: 0, avg: 0 }
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
          }
        })

        // Reconciliation: подгоняем последний активный час под WMS-итог
        // чтобы сумма строк точно совпадала с выполнено/остаток из WMS
        const wmsKdk  = parsed?.kdk.done  ?? 0
        const wmsStor = parsed?.storage.done ?? 0
        if (wmsKdk > 0 || wmsStor > 0) {
          let sumKdk  = blkKdk
          let sumStor = blkStor
          for (const r of rows) { sumKdk += r.kdk ?? 0; sumStor += r.stor ?? 0 }
          const diffKdk  = wmsKdk  - sumKdk
          const diffStor = wmsStor - sumStor
          if (diffKdk !== 0 || diffStor !== 0) {
            // Последний час с ненулевыми данными
            let lastIdx = -1
            for (let i = rows.length - 1; i >= 0; i--) {
              if ((rows[i].kdk ?? 0) !== 0 || (rows[i].stor ?? 0) !== 0 || rows[i].done > 0) { lastIdx = i; break }
            }
            if (lastIdx >= 0) {
              const r = rows[lastIdx]
              const newKdk  = (r.kdk  ?? 0) + diffKdk
              const newStor = (r.stor ?? 0) + diffStor
              const newDone = newKdk + newStor
              const empl    = r.sotrud ?? 0
              rows[lastIdx] = {
                ...r,
                kdk:  newKdk,
                stor: newStor,
                done: newDone,
                avg:  empl > 0 ? Math.round(newDone / empl) : 0,
              }
            }
          }
        }

        const blockRow = {
          time:   '00:00 - 9:00',
          kdk:    blkKdk  > 0 ? blkKdk  : null,
          stor:   blkStor > 0 ? blkStor : null,
          sotrud: blkEmpl > 0 ? blkEmpl : null,
          done:   blkDone,
          avg:    0,
        }
        setHourlyData([blockRow, ...rows])
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll(date) }, [date, fetchAll])

  // Отборка — итоги
  const pick = picking ?? MOCK.picking
  const kdkT = pick.kdk.tasks,   kdkD = pick.kdk.done,   kdkR = pick.kdk.rest
  const storT = pick.storage.tasks, storD = pick.storage.done, storR = pick.storage.rest
  const totT = kdkT + storT, totD = kdkD + storD, totR = kdkR + storR

  // Приёмка — итоги
  const rcpt = reception ?? MOCK.reception
  const rk = rcpt.kdk, rs = rcpt.storage
  const rt = {
    plan:      rk.plan      + rs.plan,
    received:  rk.received  + rs.received,
    receiving: rk.receiving + rs.receiving,
    waiting:   rk.waiting   + rs.waiting,
  }

  // Пополнение — реальные или мок
  const replData = repl ?? MOCK.replenishment

  // Почасовые строки — реальные или мок
  const hourly = hourlyData ?? MOCK.hourly

  // Хелпер для процессов
  const p = (i) => procs[i] || { name: '', cnt: null, cnt2: null }
  const c2 = (i) => p(i).cnt2 !== null && p(i).cnt2 !== undefined ? fmt(p(i).cnt2) : ''

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
        {loading && <span className={s.statusLoading}>Загрузка...</span>}
        {error   && <span className={s.statusError}>{error}</span>}
        {!loading && (
          <button className={'btn btn-secondary btn-sm'} onClick={() => fetchAll(date)}>
            Обновить
          </button>
        )}
      </div>

      {/* Основная таблица */}
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
            {hourly.map((row, i) => (
              <tr key={row.time}>
                <td className={s.lbl}>{row.time}</td>
                <td className={s.v}>{fmt(row.kdk)}</td>
                <td className={s.v}>{fmt(row.stor)}</td>
                <td className={s.v}>{fmt(row.sotrud)}</td>
                <td className={s.v}>{row.done !== null ? (row.done === 0 ? '0' : fmt(row.done)) : ''}</td>
                <td className={s.v}>{row.avg  !== null ? (row.avg  === 0 ? '0' : fmt(row.avg))  : ''}</td>
                <td className={s.pn}>{p(i).name}</td>
                <td className={s.v}>{fmt(p(i).cnt)}</td>
                <td className={s.v}>{c2(i)}</td>
              </tr>
            ))}

            {/* ══════════════ ПОПОЛНЕНИЕ ══════════════════════════════ */}
            <tr>
              <td className={s.yh} colSpan={6}>Пополнение</td>
              <td className={s.pn}>{p(13).name}</td>
              <td className={s.v}>{fmt(p(13).cnt)}</td>
              <td className={s.v}>{c2(13)}</td>
            </tr>
            <tr>
              <td className={s.e} />
              <td className={s.sh2} colSpan={2}>Спуски</td>
              <td className={s.sh2} colSpan={3}>Перемещение</td>
              <td className={s.pn}>{p(14).name}</td>
              <td className={s.v}>{fmt(p(14).cnt)}</td>
              <td className={s.v}>{c2(14)}</td>
            </tr>
            {[
              ['Задачи',    replData.descents.tasks, replData.moves.tasks, 15],
              ['Выполнено', replData.descents.done,  replData.moves.done,  16],
              ['Остаток',   replData.descents.rest,  replData.moves.rest,  17],
            ].map(([lbl, v1, v2, pi]) => (
              <tr key={lbl}>
                <td className={s.lbl}>{lbl}</td>
                <td className={s.v} colSpan={2}>{fmt(v1)}</td>
                <td className={s.v} colSpan={3}>{fmt(v2)}</td>
                <td className={s.pn}>{p(pi).name}</td>
                <td className={s.v}>{fmt(p(pi).cnt)}</td>
                <td className={s.v}>{c2(pi)}</td>
              </tr>
            ))}

            {/* ══════════════ ОТГРУЗКА ════════════════════════════════ */}
            <tr>
              <td className={s.yh} colSpan={6}>Отгрузка</td>
              <td className={s.pn}>{p(18).name}</td>
              <td className={s.v}>{fmt(p(18).cnt)}</td>
              <td className={s.v}>{c2(18)}</td>
            </tr>
            <tr>
              <td className={s.lbl}>План</td>
              <td className={s.v} colSpan={5}>{fmt(ship.plan)}</td>
              <td className={s.pn}>{p(19).name}</td>
              <td className={s.v}>{fmt(p(19).cnt)}</td>
              <td className={s.v}>{c2(19)}</td>
            </tr>
            <tr>
              <td className={s.lbl}>Подготовлено ТС</td>
              <td className={s.v} colSpan={5}>{fmt(ship.prepared)}</td>
              <td className={s.pn}>{p(20).name}</td>
              <td className={s.v}>{fmt(p(20).cnt)}</td>
              <td className={s.v}>{c2(20)}</td>
            </tr>
            <tr>
              <td className={s.lbl}>Отгружено</td>
              <td className={s.v} colSpan={5}>{fmt(ship.shipped)}</td>
              <td className={s.e} colSpan={3} />
            </tr>
            <tr>
              <td className={s.lbl}>Отгружается</td>
              <td className={s.v} colSpan={5}>{fmt(ship.inProgress)}</td>
              <td className={s.e} colSpan={3} />
            </tr>
            <tr>
              <td className={s.lbl}>Задержка</td>
              <td className={s.v} colSpan={5}>{fmt(ship.delay)}</td>
              <td className={s.e} colSpan={3} />
            </tr>
            {/* Разделитель */}
            <tr>
              <td className={s.sep} colSpan={9} />
            </tr>
            <tr>
              <td className={s.lbl}>За час ТС</td>
              <td className={s.v} colSpan={5}>{fmt(ship.perHourTC)}</td>
              <td className={s.e} colSpan={3} />
            </tr>
            <tr>
              <td className={s.lbl}>За час РК</td>
              <td className={s.v} colSpan={5}>{fmt(ship.perHourRK)}</td>
              <td className={s.e} colSpan={3} />
            </tr>
            <tr>
              <td className={s.lbl}>Сдано РК</td>
              <td className={s.v} colSpan={5}>{fmt(ship.deliveredRK)}</td>
              <td className={s.e} colSpan={3} />
            </tr>
            <tr>
              <td className={s.lbl}>Общее кол-во. РК</td>
              <td className={s.v} colSpan={5}>{fmt(ship.totalRK)}</td>
              <td className={s.e} colSpan={3} />
            </tr>

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
            {[
              ['План',         rk.plan,      rs.plan,      rt.plan      ],
              ['Принято',      rk.received,  rs.received,  rt.received  ],
              ['Принимается',  rk.receiving, rs.receiving, rt.receiving ],
              ['Ожидаем',      rk.waiting,   rs.waiting,   rt.waiting   ],
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
    </div>
  )
}
