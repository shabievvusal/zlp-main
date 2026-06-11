import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { useNavigate } from 'react-router-dom'
import { getInboundTasks, getInboundTaskDetail, getEoRemaining, getInboundTaskResponsibleUsers } from '../../api/index.js'
import { Search, X, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, SlidersHorizontal } from 'lucide-react'
import s from './SuppliesPage.module.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 30

const ALL_STATUSES = [
  'TRANSPORTATION_NOT_ASSIGNED',
  'AWAITING_GATE',
  'AWAITING_ACCEPTANCE',
  'ACCEPTANCE_IN_PROGRESS',
  'NOT_VERIFIED',
  'CANCELLED',
  'COMPLETED_AS_PLANNED',
  'COMPLETED_WITH_DISCREPANCY',
]

const ALL_TYPES = ['IMPORT', 'CROSSDOCK', 'STORAGE', 'STORAGE_DC']
const ALL_TEMPS = ['LOW_COLD', 'MEDIUM_COLD', 'ORDINARY']


const STATUS_LABELS = {
  TRANSPORTATION_NOT_ASSIGNED: 'Не привязано',
  AWAITING_GATE:               'Ждёт ворот',
  AWAITING_ACCEPTANCE:         'Ждёт приёмку',
  ACCEPTANCE_IN_PROGRESS:      'Приёмка',
  NOT_VERIFIED:                'Не проверено',
  CANCELLED:                   'Отменено',
  COMPLETED_AS_PLANNED:        'Принято',
  COMPLETED_WITH_DISCREPANCY:  'Расхождения',
  PLANNED:                     'Запланировано',
}

const STATUS_CLASS = {
  COMPLETED_AS_PLANNED:        s.badgeAccepted,
  COMPLETED_WITH_DISCREPANCY:  s.badgeDiscrepancy,
  ACCEPTANCE_IN_PROGRESS:      s.badgeInProgress,
  AWAITING_ACCEPTANCE:         s.badgePlanned,
  AWAITING_GATE:               s.badgePlanned,
  CANCELLED:                   s.badgeDefault,
  TRANSPORTATION_NOT_ASSIGNED: s.badgeNotAssigned,
  NOT_VERIFIED:                s.badgeDefault,
  PLANNED:                     s.badgePlanned,
}

const TEMP_LABELS = {
  ORDINARY:    'Сухой',
  MEDIUM_COLD: 'Средний холод',
  LOW_COLD:    'Низкий холод',
}

const TYPE_LABELS = {
  IMPORT:     'Умный импорт',
  CROSSDOCK:  'Кросс-докинг',
  STORAGE:    'На хранение от поставщика',
  STORAGE_DC: 'На хранение от РЦ',
}

// Статусы приёмки, после которых для CROSSDOCK начинается комплектация
const CROSSDOCK_PICK_STATUSES = new Set(['COMPLETED_AS_PLANNED', 'COMPLETED_WITH_DISCREPANCY'])

// Статусы, при которых имеет смысл показывать «Кто принял»
const ACCEPTANCE_RELEVANT_STATUSES = new Set([
  'ACCEPTANCE_IN_PROGRESS',
  'NOT_VERIFIED',
  'COMPLETED_AS_PLANNED',
  'COMPLETED_WITH_DISCREPANCY',
])

// Логический порядок статусов для сортировки (активные → ожидание → завершённые)
// CROSSDOCK с завершённой приёмкой сортируется по статусу комплектации (60–62)
const STATUS_ORDER = {
  ACCEPTANCE_IN_PROGRESS:      0,
  AWAITING_ACCEPTANCE:         1,
  AWAITING_GATE:               2,
  TRANSPORTATION_NOT_ASSIGNED: 3,
  PLANNED:                     4,
  NOT_VERIFIED:                5,
  COMPLETED_AS_PLANNED:        6,
  COMPLETED_WITH_DISCREPANCY:  7,
  CANCELLED:                   8,
}
const PICK_STATUS_ORDER = { waiting: 60, in_progress: 61, done: 62 }

const RU_MONTHS    = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
const RU_DAYS_SHORT = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtUserName(user) {
  if (!user) return '—'
  const { lastName = '', firstName = '', middleName = '' } = user
  const initials = [firstName, middleName].filter(Boolean).map(n => n[0] + '.').join('')
  return [lastName, initials].filter(Boolean).join(' ') || '—'
}

function fmtNum(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('ru-RU')
}

function fmtKg(grams) {
  if (grams == null || grams === 0) return '—'
  const kg = grams / 1000
  return kg % 1 === 0 ? fmtNum(kg) : Number(kg.toFixed(3)).toLocaleString('ru-RU')
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const dd  = String(d.getDate()).padStart(2, '0')
  const mm  = String(d.getMonth() + 1).padStart(2, '0')
  const yy  = String(d.getFullYear()).slice(2)
  const hh  = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yy}, ${hh}:${min}`
}

function fmtDate(iso) {
  if (!iso) return '—'
  return fmtDateShort(new Date(iso))
}

function fmtDateShort(date) {
  if (!date) return '?'
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yy = String(date.getFullYear()).slice(2)
  return `${dd}.${mm}.${yy}`
}

function localDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function todayLocalDate() {
  return localDay(new Date())
}

function dateToApiFrom(d) {
  // 00:00 МСК (UTC+3) = 21:00 UTC предыдущего дня
  const y   = d.getFullYear()
  const m   = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${day}T00:00:00+03:00`).toISOString()
}

function dateToApiTo(d) {
  // 23:59:59.999 МСК (UTC+3) = 20:59:59.999 UTC
  const y   = d.getFullYear()
  const m   = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${day}T23:59:59.999+03:00`).toISOString()
}

function todayPlannedRange() {
  const t = todayLocalDate()
  return { fromDate: t, toDate: t }
}

// Извлечь число из { pieceProducts: N } или из числа
function qty(val) {
  if (val == null) return null
  if (typeof val === 'number') return val
  return val.pieceProducts ?? val.weightProducts ?? null
}

// Числовой ключ для сортировки по статусу с учётом комплектации
function statusSortKey(row, pickStatusMap) {
  if (row.type === 'CROSSDOCK' && CROSSDOCK_PICK_STATUSES.has(row.status)) {
    const ps = pickStatusMap[row.id]
    if (!ps || ps === 'loading') return PICK_STATUS_ORDER.waiting
    return PICK_STATUS_ORDER[ps.status] ?? PICK_STATUS_ORDER.waiting
  }
  return STATUS_ORDER[row.status] ?? 99
}

// Клиентская сортировка текущей страницы
function clientSort(rows, sort, pickStatusMap = {}) {
  if (!sort.key) return rows
  return [...rows].sort((a, b) => {
    // Статус: учитываем статус комплектации для CROSSDOCK
    if (sort.key === 'status') {
      const ao = statusSortKey(a, pickStatusMap)
      const bo = statusSortKey(b, pickStatusMap)
      return sort.dir === 'asc' ? ao - bo : bo - ao
    }
    let av = a[sort.key]
    let bv = b[sort.key]
    if (av == null && bv == null) return 0
    if (av == null) return sort.dir === 'asc' ? -1 : 1
    if (bv == null) return sort.dir === 'asc' ? 1 : -1
    if (typeof av === 'string') {
      return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    }
    return sort.dir === 'asc' ? av - bv : bv - av
  })
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  return (
    <span className={STATUS_CLASS[status] || s.badgeDefault}>
      {STATUS_LABELS[status] || status}
    </span>
  )
}

// ─── SortTh ───────────────────────────────────────────────────────────────────

function SortTh({ label, col, sort, onSort }) {
  const active = sort.key === col
  const arrow  = !active ? '⇅' : sort.dir === 'desc' ? '↓' : '↑'
  return (
    <th
      className={`${s.th} ${s.thSort} ${active ? s.thSortActive : ''}`}
      onClick={() => onSort(col)}
    >
      {label}<span className={s.sortArrow}>{arrow}</span>
    </th>
  )
}

// ─── FilterDropdown ───────────────────────────────────────────────────────────
// Пустой selected [] = фильтр не применён → кнопка-дропдаун.
// Непустой selected  = чип с X. X сбрасывает в [].
// Применить — применяет черновик. Сбросить — очищает в [].

function FilterDropdown({ label, options, selected, onChange }) {
  const [open, setOpen]   = useState(false)
  const [draft, setDraft] = useState(selected)
  const ref               = useRef(null)

  useEffect(() => {
    if (!open) return
    function onOut(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [open])

  function openMenu() {
    if (open) { setOpen(false); return }
    setDraft(selected)
    setOpen(true)
  }

  function toggleDraft(val) {
    setDraft(prev =>
      prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]
    )
  }

  function toggleAllDraft() {
    setDraft(draft.length === options.length ? [] : options.map(o => o.value))
  }

  function handleApply() {
    onChange(draft)
    setOpen(false)
  }

  // Сбросить = снять все чекбоксы (фильтр не применён)
  function handleReset() {
    setDraft([])
    onChange([])
    setOpen(false)
  }

  const hasSelection = selected.length > 0
  const first        = hasSelection ? (options.find(o => o.value === selected[0])?.label ?? selected[0]) : ''
  const rest         = selected.length > 1 ? selected.length - 1 : 0
  const chipLabel    = `${label}: ${first}${rest > 0 ? ` +${rest}` : ''}`

  return (
    <div className={s.dropdownWrap} ref={ref}>
      {/* Чип — только когда есть выбор */}
      {hasSelection ? (
        <span className={s.filterChip}>
          <span className={s.chipClickArea} onClick={openMenu}>{chipLabel}</span>
          <button type="button" className={s.chipRemove} onClick={handleReset}>
            <X size={12} />
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={`${s.filterDropdown} ${open ? s.filterDropdownOpen : ''}`}
          onClick={openMenu}
        >
          {label} <ChevronDown size={13} />
        </button>
      )}

      {/* Menu */}
      {open && (
        <div className={s.dropdownMenu}>
          <label className={`${s.dropdownItem} ${s.dropdownItemAll}`}>
            <input
              type="checkbox"
              checked={draft.length === options.length}
              onChange={toggleAllDraft}
            />
            Все
          </label>
          <div className={s.dropdownList}>
            {options.map(o => (
              <label key={o.value} className={s.dropdownItem}>
                <input
                  type="checkbox"
                  checked={draft.includes(o.value)}
                  onChange={() => toggleDraft(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
          <div className={s.dropdownActions}>
            <button type="button" className={s.btnReset} onClick={handleReset}>Сбросить</button>
            <button type="button" className={s.btnApply} onClick={handleApply}>Применить</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── DatePickerDropdown ───────────────────────────────────────────────────────

function DatePickerDropdown({ label, placeholder, dateRange, onChange, onRemove }) {
  const [open, setOpen]           = useState(false)
  const [draft, setDraft]         = useState(dateRange)
  const [step, setStep]           = useState('from') // 'from' | 'to'
  const [viewYear, setViewYear]   = useState(() => (dateRange?.fromDate || new Date()).getFullYear())
  const [viewMonth, setViewMonth] = useState(() => (dateRange?.fromDate || new Date()).getMonth())
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
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
    } else {
      const fd = draft.fromDate
      const range = day < fd
        ? { fromDate: day, toDate: fd }
        : { fromDate: fd, toDate: day }
      setDraft(range)
      setStep('from')
    }
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

  // Calendar grid
  const firstDay = new Date(viewYear, viewMonth, 1)
  const lastDay  = new Date(viewYear, viewMonth + 1, 0)
  let startDow   = firstDay.getDay()
  startDow = startDow === 0 ? 6 : startDow - 1
  const cells = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= lastDay.getDate(); d++) cells.push(new Date(viewYear, viewMonth, d))

  const dFrom = draft?.fromDate
  const dTo   = draft?.toDate

  function isInRange(day) { return day && dFrom && dTo && day > dFrom && day < dTo }
  function isStart(day)   { return day && dFrom && day.getTime() === dFrom.getTime() }
  function isEnd(day)     { return day && dTo   && day.getTime() === dTo.getTime() }
  function isToday(day)   { return day && day.getTime() === todayLocalDate().getTime() }

  const chipLabel = dateRange
    ? `${label}: ${fmtDateShort(dateRange.fromDate)}-${fmtDateShort(dateRange.toDate)}`
    : null

  return (
    <div className={s.dropdownWrap} ref={ref}>
      {/* Chip (когда дата задана) или кнопка-дропдаун */}
      {chipLabel ? (
        <span className={s.filterChip}>
          <span className={s.chipClickArea} onClick={openMenu}>{chipLabel}</span>
          {onRemove && (
            <button type="button" className={s.chipRemove} onClick={onRemove}>
              <X size={12} />
            </button>
          )}
        </span>
      ) : (
        <button
          type="button"
          className={`${s.filterDropdown} ${open ? s.filterDropdownOpen : ''}`}
          onClick={openMenu}
        >
          {placeholder || label}<ChevronDown size={13} />
        </button>
      )}

      {/* Calendar menu */}
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
            {RU_DAYS_SHORT.map(d => (
              <div key={d} className={s.calDayName}>{d}</div>
            ))}
            {cells.map((day, i) => (
              <div
                key={i}
                onClick={() => day && clickDay(day)}
                className={[
                  s.calCell,
                  !day             ? s.calCellEmpty : '',
                  day && isToday(day)   ? s.calCellToday : '',
                  day && isStart(day)   ? s.calCellStart : '',
                  day && isEnd(day)     ? s.calCellEnd   : '',
                  day && isInRange(day) ? s.calCellRange : '',
                ].filter(Boolean).join(' ')}
              >
                {day ? day.getDate() : ''}
              </div>
            ))}
          </div>

          {step === 'to' && (
            <div className={s.calHint}>Выберите конец периода</div>
          )}

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

// ─── Column visibility ────────────────────────────────────────────────────────

const LS_COLS_KEY = 'supplies_visible_cols'
const COLUMNS = [
  { key: 'status',      label: 'Статус',         fixed: true },
  { key: 'acceptedBy',  label: 'Кто принял' },
  { key: 'taskNumber',  label: 'Поставка' },
  { key: 'orderNumber', label: 'Заказ' },
  { key: 'plannedDate', label: 'Плановая дата' },
  { key: 'supplier',    label: 'Поставщик' },
  { key: 'type',        label: 'Тип' },
  { key: 'temperature', label: 'Температура' },
  { key: 'gate',        label: 'Ворота' },
  { key: 'planQty',     label: 'План. товары' },
  { key: 'planKg',      label: 'План, кг' },
  { key: 'factKg',      label: 'Факт, кг' },
  { key: 'eo',          label: 'ЕО' },
  { key: 'planPcs',     label: 'План шт.' },
  { key: 'condition',   label: 'Кондиция' },
  { key: 'defect',      label: 'Брак' },
  { key: 'startedAt',   label: 'Начало приёмки' },
  { key: 'completedAt', label: 'Окончание' },
]

// ─── Page-level cache — переживает навигацию (не сбрасывается при размонтировании) ──

const _cache = {
  allRows: null,
  loadKey: null,
  page: 1, sort: { key: 'plannedArrivalDate', dir: 'desc' },
  search: '', plannedRange: null, completedRange: null,
  statuses: [], types: [], temps: [],
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SuppliesPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const navigate = useNavigate()

  const [allRows, setAllRows]               = useState(() => _cache.allRows)
  const [loading, setLoading]               = useState(false)
  const [error, setError]                   = useState(null)
  const [page, setPage]                     = useState(() => _cache.page)
  const [sort, setSort]                     = useState(() => _cache.sort)
  const [search, setSearch]                 = useState(() => _cache.search)
  const [plannedRange, setPlannedRange]     = useState(() => _cache.plannedRange ?? todayPlannedRange())
  const [completedRange, setCompletedRange] = useState(() => _cache.completedRange)
  const [statuses, setStatuses]             = useState(() => _cache.statuses)
  const [types, setTypes]                   = useState(() => _cache.types)
  const [temps, setTemps]                   = useState(() => _cache.temps)
  const [acceptorSearch, setAcceptorSearch] = useState('')
  const [acceptorOpen, setAcceptorOpen]     = useState(false)
  const acceptorRef                         = useRef(null)

  const [visibleCols, setVisibleCols] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_COLS_KEY)
      if (saved) return new Set(JSON.parse(saved))
    } catch {}
    return new Set(COLUMNS.map(c => c.key))
  })
  const [colsOpen, setColsOpen] = useState(false)
  const colsRef                 = useRef(null)

  // { rowId: 'loading' | { status: 'waiting'|'in_progress'|'done', pct: number } }
  const [pickStatusMap, setPickStatusMap] = useState({})
  // { rowId: 'loading' | user-object | null }
  const [respUsersMap, setRespUsersMap]   = useState({})

  const abortRef       = useRef(null)
  const loadKeyRef     = useRef(_cache.loadKey)
  const fetchedPickRef = useRef(new Set())
  const fetchedRespRef = useRef(new Set())

  useEffect(() => {
    if (!colsOpen) return
    function onOut(e) {
      if (colsRef.current && !colsRef.current.contains(e.target)) setColsOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [colsOpen])

  // Уникальные имена принявших из загруженных данных — для подсказок
  const acceptorOptions = useMemo(() => {
    const seen = new Set()
    for (const u of Object.values(respUsersMap)) {
      if (!u || u === 'loading') continue
      const name = fmtUserName(u)
      if (name && name !== '—') seen.add(name)
    }
    return [...seen].sort()
  }, [respUsersMap])

  // Синхронизируем UI-состояние в кэш при каждом изменении
  useEffect(() => {
    _cache.page           = page
    _cache.sort           = sort
    _cache.search         = search
    _cache.plannedRange   = plannedRange
    _cache.completedRange = completedRange
    _cache.statuses       = statuses
    _cache.types          = types
    _cache.temps          = temps
  }, [page, sort, search, plannedRange, completedRange, statuses, types, temps])

  const load = useCallback(async (planned, completed) => {
    let token = getToken()
    if (!token || !isTokenValid()) {
      const ok = await forceRefresh()
      if (!ok) { setError('Нет токена WMS. Войдите заново.'); return }
      token = getToken()
    }
    if (!token) { setError('Нет токена WMS. Войдите заново.'); return }

    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()

    setLoading(true)
    setError(null)
    setAllRows(null)
    setPickStatusMap({})
    setRespUsersMap({})
    fetchedPickRef.current.clear()
    fetchedRespRef.current.clear()

    const base = {}
    if (planned?.fromDate) {
      base.dateFrom = dateToApiFrom(planned.fromDate)
      base.dateTo   = dateToApiTo(planned.toDate)
    }
    if (completed?.fromDate) {
      base.completedDateFrom = dateToApiFrom(completed.fromDate)
      base.completedDateTo   = dateToApiTo(completed.toDate)
    }

    try {
      const first      = await getInboundTasks(token, { ...base, pageNumber: 1, pageSize: 100 })
      const totalCount = first?.value?.total ?? 0
      let   items      = [...(first?.value?.items ?? [])]
      const pages      = Math.ceil(totalCount / 100)
      if (pages > 1) {
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) =>
            getInboundTasks(token, { ...base, pageNumber: i + 2, pageSize: 100 })
          )
        )
        for (const r of rest) items = items.concat(r?.value?.items ?? [])
      }
      setAllRows(items)
      _cache.allRows = items
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [getToken, isTokenValid, forceRefresh])

  // Перезагружаем только при смене диапазона дат
  useEffect(() => {
    const key = JSON.stringify({ plannedRange, completedRange })
    if (loadKeyRef.current === key) return
    loadKeyRef.current = key
    _cache.loadKey = key
    setPage(1)
    load(plannedRange, completedRange)
  }, [plannedRange, completedRange, load])

  useEffect(() => {
    const rows = allRows ?? []
    const toFetch = rows.filter(
      r => r.type === 'CROSSDOCK'
        && CROSSDOCK_PICK_STATUSES.has(r.status)
        && !fetchedPickRef.current.has(r.id)
    )
    if (toFetch.length === 0) return

    // Регистрируем как "запущено" — предотвращает дублирование при re-render
    toFetch.forEach(r => fetchedPickRef.current.add(r.id))
    setPickStatusMap(prev => {
      const next = { ...prev }
      toFetch.forEach(r => { next[r.id] = 'loading' })
      return next
    })

    let cancelled = false

    async function fetchAll() {
      let token = getToken()
      if (!token || !isTokenValid()) {
        const ok = await forceRefresh()
        if (!ok || cancelled) return
        token = getToken()
      }

      await Promise.all(toFetch.map(async row => {
        try {
          const res    = await getInboundTaskDetail(token, { taskType: row.type, id: row.id })
          const detail = res?.value ?? res

          const huByBarcode = {}
          for (const prod of (detail?.products ?? [])) {
            for (const part of (prod.parts ?? [])) {
              for (const hu of (part.handlingUnits ?? [])) {
                if (hu.handlingUnitBarcode) {
                  huByBarcode[hu.handlingUnitBarcode] =
                    (huByBarcode[hu.handlingUnitBarcode] ?? 0) + (qty(hu.actualQuantity) ?? 0)
                }
              }
            }
          }
          const uniqueHus = Object.entries(huByBarcode).map(([barcode, received]) => ({ barcode, received }))

          if (uniqueHus.length === 0) {
            if (!cancelled) setPickStatusMap(prev => ({ ...prev, [row.id]: { status: 'waiting', pct: 0 } }))
            return
          }

          const remainings = await Promise.all(uniqueHus.map(hu => getEoRemaining(token, hu.barcode)))
          if (cancelled) return

          const totalReceived = uniqueHus.reduce((s, hu) => s + hu.received, 0)
          const totalPicked   = uniqueHus.reduce((s, hu, i) => {
            const rem = remainings[i]
            return s + (rem === null ? 0 : Math.max(0, hu.received - rem))
          }, 0)
          const pct    = totalReceived > 0 ? Math.round(totalPicked / totalReceived * 100) : 0
          const allNone = remainings.every(r => r === null)
          const allDone = remainings.every(r => r === 0)
          const status  = allNone ? 'waiting' : allDone ? 'done' : 'in_progress'

          setPickStatusMap(prev => ({ ...prev, [row.id]: { status, pct } }))
        } catch {
          if (!cancelled) setPickStatusMap(prev => ({ ...prev, [row.id]: { status: 'waiting', pct: 0 } }))
        }
      }))
    }

    fetchAll()
    return () => { cancelled = true }
  }, [allRows]) // eslint-disable-line react-hooks/exhaustive-deps

  // Загружаем «Кто принял» для строк в статусах приёмки
  useEffect(() => {
    const rows = allRows ?? []
    const toFetch = rows.filter(
      r => ACCEPTANCE_RELEVANT_STATUSES.has(r.status) && !fetchedRespRef.current.has(r.id)
    )
    if (toFetch.length === 0) return

    toFetch.forEach(r => fetchedRespRef.current.add(r.id))
    setRespUsersMap(prev => {
      const next = { ...prev }
      toFetch.forEach(r => { next[r.id] = 'loading' })
      return next
    })

    let cancelled = false

    async function fetchAll() {
      let token = getToken()
      if (!token || !isTokenValid()) {
        const ok = await forceRefresh()
        if (!ok || cancelled) return
        token = getToken()
      }

      await Promise.all(toFetch.map(async row => {
        try {
          const res   = await getInboundTaskResponsibleUsers(token, { taskType: row.type, id: row.id })
          const users = res?.value?.responsibleUsers ?? []
          const accepted = users.find(u => u.type === 'ACCEPTANCE_COMPLETED')
            ?? users.find(u => u.type === 'ACCEPTANCE_STARTED')
          if (!cancelled) setRespUsersMap(prev => ({ ...prev, [row.id]: accepted?.user ?? null }))
        } catch {
          if (!cancelled) setRespUsersMap(prev => ({ ...prev, [row.id]: null }))
        }
      }))
    }

    fetchAll()
    return () => { cancelled = true }
  }, [allRows]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleSort(col) {
    setSort(prev =>
      prev.key === col
        ? { key: col, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { key: col, dir: 'desc' }
    )
    setPage(1)
  }

  function toggleCol(key) {
    const c = COLUMNS.find(c => c.key === key)
    if (c?.fixed) return
    setVisibleCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try { localStorage.setItem(LS_COLS_KEY, JSON.stringify([...next])) } catch {}
      return next
    })
  }

  // Все фильтры — мгновенно по уже загруженным данным
  const filtered = useMemo(() => {
    let rows = allRows ?? []
    if (statuses.length) rows = rows.filter(r => statuses.includes(r.status))
    if (types.length)    rows = rows.filter(r => types.includes(r.type))
    if (temps.length)    rows = rows.filter(r => temps.includes(r.temperatureMode))
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(r =>
        (r.taskNumber || '').toLowerCase().includes(q) ||
        (r.orderNumber || '').toLowerCase().includes(q) ||
        (r.supplier?.name || '').toLowerCase().includes(q)
      )
    }
    if (acceptorSearch.trim()) {
      rows = rows.filter(r => {
        if (!ACCEPTANCE_RELEVANT_STATUSES.has(r.status)) return false
        const u = respUsersMap[r.id]
        if (u === undefined || u === 'loading') return true
        if (!u) return false
        return fmtUserName(u).toLowerCase().includes(acceptorSearch.toLowerCase().trim())
      })
    }
    return rows
  }, [allRows, statuses, types, temps, search, acceptorSearch, respUsersMap])

  const sorted    = useMemo(() => clientSort(filtered, sort, pickStatusMap), [filtered, sort, pickStatusMap])
  const displayed = useMemo(() => sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [sorted, page])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)

  function renderPages() {
    if (totalPages <= 1) return []
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1)
    }
    // Собираем «ядро» — первая, последняя и окно вокруг текущей
    const core = new Set([1, totalPages])
    for (let i = Math.max(1, page - 1); i <= Math.min(totalPages, page + 1); i++) core.add(i)
    const sorted = [...core].sort((a, b) => a - b)
    // Вставляем '...' в разрывы
    const result = []
    let prev = 0
    for (const p of sorted) {
      if (p - prev > 1) result.push('...')
      result.push(p)
      prev = p
    }
    return result
  }

  const pageStart = filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const pageEnd   = Math.min(page * PAGE_SIZE, filtered.length)

  const isVis         = key => visibleCols.has(key)
  const activeColCount = COLUMNS.filter(c => visibleCols.has(c.key)).length

  return (
    <div className={s.page}>
      <h1 className={s.title}>Поставки</h1>

      {/* ── Filters bar ── */}
      <div className={s.filtersBar}>
        <div className={s.filtersLeft}>
          <span className={s.listLabel}>Список поставок</span>
          <div className={s.filterChips}>

            {/* Плановая дата (всегда задана, X → сегодня) */}
            <DatePickerDropdown
              label="Плановая дата"
              dateRange={plannedRange}
              onChange={r => { setPlannedRange(r); setPage(1) }}
              onRemove={() => { setPlannedRange(null); setPage(1) }}
            />

            {/* Дата завершения (опционально) */}
            <DatePickerDropdown
              label="Дата завершения"
              placeholder="Дата завершения"
              dateRange={completedRange}
              onChange={r => { setCompletedRange(r); setPage(1) }}
              onRemove={() => { setCompletedRange(null); setPage(1) }}
            />

            {/* Статус */}
            <FilterDropdown
              label="Статус"
              options={ALL_STATUSES.map(v => ({ value: v, label: STATUS_LABELS[v] || v }))}
              selected={statuses}
              onChange={v => { setStatuses(v); setPage(1) }}
            />

            {/* Тип поставки */}
            <FilterDropdown
              label="Тип поставки"
              options={ALL_TYPES.map(v => ({ value: v, label: TYPE_LABELS[v] || v }))}
              selected={types}
              onChange={v => { setTypes(v); setPage(1) }}
            />

            {/* Температура */}
            <FilterDropdown
              label="Температура"
              options={ALL_TEMPS.map(v => ({ value: v, label: TEMP_LABELS[v] || v }))}
              selected={temps}
              onChange={v => { setTemps(v); setPage(1) }}
            />

            {/* Кто принял — autocomplete */}
            <div className={s.acceptorWrap} ref={acceptorRef}>
              <input
                className={`${s.acceptorInput} ${acceptorSearch ? s.acceptorInputActive : ''}`}
                placeholder="Кто принял..."
                value={acceptorSearch}
                onChange={e => { setAcceptorSearch(e.target.value); setPage(1); setAcceptorOpen(true) }}
                onFocus={() => setAcceptorOpen(true)}
                onBlur={e => {
                  // закрываем только если фокус ушёл за пределы враппера
                  if (!acceptorRef.current?.contains(e.relatedTarget)) setAcceptorOpen(false)
                }}
              />
              {acceptorSearch && (
                <button
                  type="button"
                  className={s.acceptorClear}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { setAcceptorSearch(''); setPage(1); setAcceptorOpen(false) }}
                >
                  <X size={11} />
                </button>
              )}
              {acceptorOpen && (() => {
                const q = acceptorSearch.toLowerCase().trim()
                const suggestions = q
                  ? acceptorOptions.filter(n => n.toLowerCase().includes(q))
                  : acceptorOptions
                if (suggestions.length === 0) return null
                return (
                  <div className={`${s.dropdownMenu} ${s.acceptorMenu}`}>
                    {suggestions.map(name => (
                      <div
                        key={name}
                        className={s.dropdownItem}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { setAcceptorSearch(name); setPage(1); setAcceptorOpen(false) }}
                      >
                        {name}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>

          </div>
        </div>

        <div className={s.filtersRight}>
          <div className={s.searchWrap}>
            <Search size={14} className={s.searchIcon} />
            <input
              className={s.searchInput}
              placeholder="Номер поставки"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={s.refreshBtn}
            onClick={() => {
              loadKeyRef.current = null
              _cache.loadKey = null
              load(plannedRange, completedRange)
            }}
            disabled={loading}
            title="Обновить"
          >
            <RefreshCw size={15} className={loading ? s.spinning : ''} />
          </button>
          <div className={s.colsWrap} ref={colsRef}>
            <button
              type="button"
              className={`${s.filterBtn} ${colsOpen ? s.filterBtnOpen : ''} ${visibleCols.size < COLUMNS.length ? s.filterBtnActive : ''}`}
              title="Настройка колонок"
              onClick={() => setColsOpen(v => !v)}
            >
              <SlidersHorizontal size={16} />
            </button>
            {colsOpen && (
              <div className={s.colsMenu}>
                <div className={s.colsMenuTitle}>Колонки</div>
                {COLUMNS.map(c => (
                  <label
                    key={c.key}
                    className={`${s.dropdownItem} ${c.fixed ? s.dropdownItemDisabled : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={visibleCols.has(c.key)}
                      disabled={c.fixed}
                      onChange={() => toggleCol(c.key)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Error ── */}
      {error && <div className={s.error}>{error}</div>}

      {/* ── Table ── */}
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              {isVis('status')      && <SortTh label="Статус"         col="status"               sort={sort} onSort={handleSort} />}
              {isVis('acceptedBy')  && <th className={s.th}>Кто принял</th>}
              {isVis('taskNumber')  && <SortTh label="Поставка"       col="taskNumber"            sort={sort} onSort={handleSort} />}
              {isVis('orderNumber') && <th className={s.th}>Заказ</th>}
              {isVis('plannedDate') && <SortTh label="План. дата"     col="plannedArrivalDate"    sort={sort} onSort={handleSort} />}
              {isVis('supplier')    && <th className={s.th}>Поставщик</th>}
              {isVis('type')        && <th className={s.th}>Тип</th>}
              {isVis('temperature') && <th className={s.th}>Температура</th>}
              {isVis('gate')        && <th className={s.th}>Ворота</th>}
              {isVis('planQty')     && <SortTh label="План. товары"   col="productsQuantity"      sort={sort} onSort={handleSort} />}
              {isVis('planKg')      && <SortTh label="План, кг"       col="plannedTotalWeight"    sort={sort} onSort={handleSort} />}
              {isVis('factKg')      && <th className={s.th}>Факт, кг</th>}
              {isVis('eo')          && <SortTh label="ЕО"             col="handlingUnitsQuantity" sort={sort} onSort={handleSort} />}
              {isVis('planPcs')     && <th className={s.th}>План шт.</th>}
              {isVis('condition')   && <th className={s.th}>Кондиция</th>}
              {isVis('defect')      && <th className={s.th}>Брак</th>}
              {isVis('startedAt')   && <SortTh label="Начало приёмки" col="startedAt"             sort={sort} onSort={handleSort} />}
              {isVis('completedAt') && <th className={s.th}>Окончание</th>}
            </tr>
          </thead>
          <tbody>
            {loading && displayed.length === 0 ? (
              <tr><td colSpan={activeColCount} className={s.stateRow}>Загрузка...</td></tr>
            ) : !loading && displayed.length === 0 ? (
              <tr><td colSpan={activeColCount} className={s.stateRow}>Нет данных</td></tr>
            ) : displayed.map(row => (
              <tr key={row.id} className={s.tr} style={{ cursor: 'pointer' }} onClick={() => navigate(`/supplies/${row.type}/${row.id}`)}>
                {isVis('status') && (
                  <td className={s.td}>
                    {row.type === 'CROSSDOCK' && CROSSDOCK_PICK_STATUSES.has(row.status)
                      ? (() => {
                          const ps = pickStatusMap[row.id]
                          if (!ps || ps === 'loading') return <span className={s.badgePickWaiting}>...</span>
                          if (ps.status === 'done')        return <span className={s.badgeAccepted}>Скомплектована</span>
                          if (ps.status === 'in_progress') return <span className={s.badgeDiscrepancy}>Комплектация {ps.pct}%</span>
                          return <span className={s.badgePickWaiting}>Ждёт комплектацию</span>
                        })()
                      : <StatusBadge status={row.status} />
                    }
                  </td>
                )}
                {isVis('acceptedBy') && (
                  <td className={`${s.td} ${s.tdMuted}`}>
                    {ACCEPTANCE_RELEVANT_STATUSES.has(row.status)
                      ? (() => {
                          const u = respUsersMap[row.id]
                          if (u === undefined || u === 'loading') return <span style={{ color: 'var(--text-light)' }}>...</span>
                          return fmtUserName(u)
                        })()
                      : '—'
                    }
                  </td>
                )}
                {isVis('taskNumber')  && <td className={`${s.td} ${s.tdMono}`}>{row.taskNumber}</td>}
                {isVis('orderNumber') && <td className={s.td}><span className={s.orderName}>{row.orderNumber || '—'}</span></td>}
                {isVis('plannedDate') && <td className={`${s.td} ${s.tdDate}`}>{fmtDate(row.plannedArrivalDate)}</td>}
                {isVis('supplier')    && <td className={`${s.td} ${s.tdMuted}`}><span className={s.supplierName}>{row.supplier?.name || '—'}</span></td>}
                {isVis('type')        && <td className={`${s.td} ${s.tdMuted}`}>{TYPE_LABELS[row.type] || row.type || '—'}</td>}
                {isVis('temperature') && <td className={s.td}>{TEMP_LABELS[row.temperatureMode] || row.temperatureMode || '—'}</td>}
                {isVis('gate')        && <td className={`${s.td} ${s.tdGate}`}>{row.gateInfo?.gateNumber || '—'}</td>}
                {isVis('planQty')     && <td className={`${s.td} ${s.tdNum}`}>{row.productsQuantity ?? '—'}</td>}
                {isVis('planKg')      && <td className={`${s.td} ${s.tdNum}`}>{fmtKg(row.plannedTotalWeightInGrams)}</td>}
                {isVis('factKg')      && <td className={`${s.td} ${s.tdNum}`}>{fmtKg(row.actualTotalWeight)}</td>}
                {isVis('eo')          && <td className={`${s.td} ${s.tdNum}`}>{row.handlingUnitsQuantity || '—'}</td>}
                {isVis('planPcs')     && <td className={`${s.td} ${s.tdNum}`}>{fmtNum(row.plannedQuantities?.pieceProducts)}</td>}
                {isVis('condition')   && <td className={`${s.td} ${s.tdNum}`}>{fmtNum(row.actualQuantities?.pieceProducts)}</td>}
                {isVis('defect')      && <td className={`${s.td} ${s.tdNum}`}>{fmtNum(row.actualDefectiveQuantities?.pieceProducts) || '—'}</td>}
                {isVis('startedAt')   && <td className={`${s.td} ${s.tdDate}`}>{fmtDateTime(row.startedAt)}</td>}
                {isVis('completedAt') && <td className={`${s.td} ${s.tdDate}`}>{fmtDateTime(row.completedAt)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      <div className={s.pagination}>
        <span className={s.pageInfo}>
          {loading ? 'Загрузка...' : filtered.length > 0 ? `${pageStart}–${pageEnd} из ${fmtNum(filtered.length)}` : ''}
        </span>
        <div className={s.pageButtons}>
          <button
            type="button"
            className={s.pageBtn}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={loading || page <= 1}
          >
            ←
          </button>

          {renderPages().map((p, i) =>
            p === '...'
              ? <span key={`d${i}`} className={s.pageDots}>…</span>
              : (
                <button
                  key={p}
                  type="button"
                  className={`${s.pageBtn} ${p === page ? s.pageBtnActive : ''}`}
                  onClick={() => setPage(p)}
                  disabled={loading}
                >
                  {p}
                </button>
              )
          )}

          <button
            type="button"
            className={s.pageBtn}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={loading || page >= totalPages}
          >
            →
          </button>
        </div>
      </div>
    </div>
  )
}
