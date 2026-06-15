import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useAuth } from '../../context/AuthContext.jsx'
import { getPieceSelectionTasks } from '../../api/index.js'
import s from './PieceSelectionPage.module.css'

const PAGE_SIZE = 100
const DEFAULT_STATUSES = ['COMPLETED', 'CREATED', 'IN_PROGRESS', 'PENDING']

const TEMP_LABELS = {
  LOW_COLD: 'Низкий холод',
  MEDIUM_COLD: 'Средний холод',
  ORDINARY: 'Сухой',
}

const STATUS_LABELS = {
  PENDING: 'Новое',
  CREATED: 'Ждёт отбора',
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Выполнено',
}

const ZONE_OPTIONS = [
  { id: 'c976ff6d-865c-472c-a754-cee17e93e63d', label: 'Холод' },
  { id: '0b29f9ce-9549-435e-b7c2-ecdd3e937057', label: 'Сухой' },
  { id: '4cdf0cb7-9361-43b6-abd7-cc98f594765b', label: 'Морозилка' },
]

const TEMP_OPTIONS = [
  { value: 'LOW_COLD', label: TEMP_LABELS.LOW_COLD },
  { value: 'MEDIUM_COLD', label: TEMP_LABELS.MEDIUM_COLD },
  { value: 'ORDINARY', label: TEMP_LABELS.ORDINARY },
]

const RU_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
const RU_DAYS_SHORT = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']

const SORT_FIELDS = {
  cells: 'sourceCellsCount',
  weight: 'weightInGrams',
  volume: 'volumeInMilliliters',
}

function localDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function todayLocalDate() {
  return localDay(new Date())
}

function dateToApiFrom(date) {
  if (!date) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${d}T00:00:00+03:00`).toISOString()
}

function dateToApiTo(date) {
  if (!date) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${d}T23:59:59.999+03:00`).toISOString()
}

function fmtDateShort(date) {
  if (!date) return '?'
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yy = String(date.getFullYear()).slice(2)
  return `${dd}.${mm}.${yy}`
}

function fmtDay(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = String(dateStr).slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

function fmtNum(n) {
  if (n == null || n === '') return '—'
  return Number(n).toLocaleString('ru-RU')
}

function fmtKg(grams) {
  const n = Number(grams) || 0
  if (!n) return '—'
  return (n / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' кг'
}

function fmtLiters(ml) {
  const n = Number(ml) || 0
  if (!n) return '—'
  return (n / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' л'
}

function userName(user) {
  if (!user) return '—'
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || '—'
}

function statusClass(status) {
  if (status === 'CREATED') return `${s.badge} ${s.badgeCreated}`
  if (status === 'COMPLETED') return `${s.badge} ${s.badgeCompleted}`
  if (status === 'IN_PROGRESS') return `${s.badge} ${s.badgeProgress}`
  return s.badge
}

function sortValue(row, key) {
  return Number(row?.[SORT_FIELDS[key]]) || 0
}

function selectedOrAll(selected, options, valueKey) {
  return selected ? [selected] : options.map(option => option[valueKey])
}

function DateRangeDropdown({ label, dateRange, onChange }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(dateRange)
  const [step, setStep] = useState('from')
  const [viewYear, setViewYear] = useState(() => (dateRange?.fromDate || new Date()).getFullYear())
  const [viewMonth, setViewMonth] = useState(() => (dateRange?.fromDate || new Date()).getMonth())
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    function onOut(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [open])

  function openMenu() {
    if (open) { setOpen(false); return }
    setDraft(dateRange)
    setStep('from')
    const base = dateRange?.fromDate || new Date()
    setViewYear(base.getFullYear())
    setViewMonth(base.getMonth())
    setOpen(true)
  }

  function clickDay(day) {
    if (step === 'from') {
      setDraft({ fromDate: day, toDate: day })
      setStep('to')
      return
    }
    const fd = draft.fromDate
    setDraft(day < fd ? { fromDate: day, toDate: fd } : { fromDate: fd, toDate: day })
    setStep('from')
  }

  function handleApply() {
    if (draft?.fromDate) { onChange(draft); setOpen(false) }
  }

  function handleReset() {
    const t = todayLocalDate()
    const d = { fromDate: t, toDate: t }
    setDraft(d)
    onChange(d)
    setOpen(false)
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }

  const firstDay = new Date(viewYear, viewMonth, 1)
  const lastDay = new Date(viewYear, viewMonth + 1, 0)
  let startDow = firstDay.getDay()
  startDow = startDow === 0 ? 6 : startDow - 1
  const cells = []
  for (let i = 0; i < startDow; i += 1) cells.push(null)
  for (let d = 1; d <= lastDay.getDate(); d += 1) cells.push(new Date(viewYear, viewMonth, d))

  const dFrom = draft?.fromDate
  const dTo = draft?.toDate
  const isInRange = day => day && dFrom && dTo && day > dFrom && day < dTo
  const isStart = day => day && dFrom && day.getTime() === dFrom.getTime()
  const isEnd = day => day && dTo && day.getTime() === dTo.getTime()
  const isToday = day => day && day.getTime() === todayLocalDate().getTime()
  const chipLabel = `${label}: ${fmtDateShort(dateRange.fromDate)}-${fmtDateShort(dateRange.toDate)}`

  return (
    <div className={s.dropdownWrap} ref={ref}>
      <button
        type="button"
        className={`${s.filterDropdown} ${open ? s.filterDropdownOpen : ''}`}
        onClick={openMenu}
      >
        {chipLabel}<ChevronDown size={13} />
      </button>
      {open && (
        <div className={`${s.dropdownMenu} ${s.calendarMenu}`}>
          <div className={s.calHeader}>
            <button type="button" className={s.calNavBtn} onClick={prevMonth}>
              <ChevronLeft size={14} />
            </button>
            <span className={s.calMonthLabel}>{RU_MONTHS[viewMonth]} {viewYear}</span>
            <button type="button" className={s.calNavBtn} onClick={nextMonth}>
              <ChevronRight size={14} />
            </button>
          </div>
          <div className={s.calGrid}>
            {RU_DAYS_SHORT.map(d => <div key={d} className={s.calDayName}>{d}</div>)}
            {cells.map((day, i) => (
              <div
                key={i}
                onClick={() => day && clickDay(day)}
                className={[
                  s.calCell,
                  !day ? s.calCellEmpty : '',
                  day && isToday(day) ? s.calCellToday : '',
                  day && isStart(day) ? s.calCellStart : '',
                  day && isEnd(day) ? s.calCellEnd : '',
                  day && isInRange(day) ? s.calCellRange : '',
                ].filter(Boolean).join(' ')}
              >
                {day ? day.getDate() : ''}
              </div>
            ))}
          </div>
          {step === 'to' && <div className={s.calHint}>Выберите конец периода</div>}
          <div className={s.dropdownActions}>
            <button type="button" className={s.btnReset} onClick={handleReset}>Сбросить</button>
            <button type="button" className={s.btnApply} onClick={handleApply} disabled={!draft?.fromDate}>
              Применить
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function PieceSelectionPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const [dateRange, setDateRange] = useState(() => {
    const t = todayLocalDate()
    return { fromDate: t, toDate: t }
  })
  const [status, setStatus] = useState('')
  const [zoneId, setZoneId] = useState('')
  const [temperatureMode, setTemperatureMode] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState({ key: '', dir: 'desc' })

  const toggleSort = (key) => {
    setPage(1)
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: 'desc' }
    )
  }

  const load = useCallback(async () => {
    let token = getToken()
    if (!token || !isTokenValid()) {
      const ok = await forceRefresh()
      if (!ok) { setError('Нет токена WMS. Войдите заново.'); return }
      token = getToken()
    }
    if (!token) { setError('Нет токена WMS. Войдите заново.'); return }

    setLoading(true)
    setError('')
    setRows(null)
    setPage(1)
    try {
      const base = {
        dateFrom: dateToApiFrom(dateRange.fromDate),
        dateTo: dateToApiTo(dateRange.toDate),
        pageSize: PAGE_SIZE,
        status: status ? [status] : DEFAULT_STATUSES,
        sourceZoneId: selectedOrAll(zoneId, ZONE_OPTIONS, 'id'),
        shipmentTemperatureMode: selectedOrAll(temperatureMode, TEMP_OPTIONS, 'value'),
      }
      const first = await getPieceSelectionTasks(token, { ...base, pageNumber: 1 })
      const firstValue = first?.value ?? first
      const totalCount = firstValue?.total ?? 0
      let items = [...(firstValue?.items ?? [])]
      const pages = Math.ceil(totalCount / PAGE_SIZE)
      if (pages > 1) {
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) =>
            getPieceSelectionTasks(token, { ...base, pageNumber: i + 2 })
          )
        )
        for (const r of rest) items = items.concat((r?.value ?? r)?.items ?? [])
      }
      setRows(items)
      setTotal(totalCount || items.length)
    } catch (err) {
      setError(err.message || 'Ошибка загрузки')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [dateRange, forceRefresh, getToken, isTokenValid, status, temperatureMode, zoneId])

  const filtered = useMemo(() => {
    const list = rows || []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(row => [
      row.shipTo?.name,
    ].some(v => String(v || '').toLowerCase().includes(q)))
  }, [rows, search])

  const sorted = useMemo(() => {
    if (!sort.key) return filtered
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => (sortValue(a, sort.key) - sortValue(b, sort.key)) * direction)
  }, [filtered, sort])

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const displayed = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const sortMark = key => sort.key === key ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Штучный отбор</h1>
          <div className={s.subtitle}>Задания комплектации по штучному отбору</div>
        </div>
        <div className={s.meta}>
          {rows ? `Загружено: ${fmtNum(rows.length)} из ${fmtNum(total)}` : 'Данные не загружены'}
        </div>
      </div>

      <div className={s.toolbar}>
        <input
          className={s.search}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          placeholder="Поиск по ЦФЗ"
        />
        <DateRangeDropdown label="Период" dateRange={dateRange} onChange={setDateRange} />
        <select className={s.select} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Все статусы</option>
          {DEFAULT_STATUSES.map(value => (
            <option key={value} value={value}>{STATUS_LABELS[value] || value}</option>
          ))}
        </select>
        <select className={s.select} value={zoneId} onChange={e => setZoneId(e.target.value)}>
          <option value="">Все зоны</option>
          {ZONE_OPTIONS.map(zone => (
            <option key={zone.label} value={zone.id}>{zone.label}</option>
          ))}
        </select>
        <select className={s.select} value={temperatureMode} onChange={e => setTemperatureMode(e.target.value)}>
          <option value="">Все температуры</option>
          {TEMP_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={load} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {loading ? 'Загрузка...' : 'Загрузить'}
        </button>
      </div>

      {error && <div className={s.empty}>{error}</div>}

      <div className={s.card}>
        {!rows && !loading && <div className={s.empty}>Выберите период и нажмите «Загрузить»</div>}
        {loading && <div className={s.empty}>Загрузка заданий...</div>}
        {rows && !loading && displayed.length === 0 && <div className={s.empty}>Нет данных</div>}
        {rows && !loading && displayed.length > 0 && (
          <>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Статус</th>
                    <th>ЦФЗ</th>
                    <th className={s.num}>
                      <button type="button" className={s.sortBtn} onClick={() => toggleSort('cells')}>
                        Ячеек <span>{sortMark('cells')}</span>
                      </button>
                    </th>
                    <th className={s.num}>
                      <button type="button" className={s.sortBtn} onClick={() => toggleSort('weight')}>
                        Вес <span>{sortMark('weight')}</span>
                      </button>
                    </th>
                    <th className={s.num}>
                      <button type="button" className={s.sortBtn} onClick={() => toggleSort('volume')}>
                        Объем <span>{sortMark('volume')}</span>
                      </button>
                    </th>
                    <th>ШК ЕО</th>
                    <th>Зона</th>
                    <th>Температура</th>
                    <th>Дата отгрузки</th>
                    <th>Исполнитель</th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map(row => (
                    <tr key={row.id}>
                      <td><span className={statusClass(row.status)}>{STATUS_LABELS[row.status] || row.status || '—'}</span></td>
                      <td>{row.shipTo?.name || '—'}</td>
                      <td className={s.num}>{fmtNum(row.sourceCellsCount)}</td>
                      <td className={s.num}>{fmtKg(row.weightInGrams)}</td>
                      <td className={s.num}>{fmtLiters(row.volumeInMilliliters)}</td>
                      <td>{row.targetHandlingUnitBarcode || '—'}</td>
                      <td>{row.sourceZone?.name || '—'}</td>
                      <td>{(row.shipmentTemperatureModes || []).map(t => TEMP_LABELS[t] || t).join(', ') || '—'}</td>
                      <td>{fmtDay(row.logisticDate)}</td>
                      <td>{userName(row.responsibleUser)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={s.pager}>
              <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Назад</button>
              <span className={s.meta}>{page} / {pages}</span>
              <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))}>Вперед</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
