import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Users } from 'lucide-react'
import * as api from '../../api/index.js'
import { useApp } from '../../context/AppContext.jsx'
import { getCompanyByFio, normalizeFio } from '../../utils/emplUtils.js'
import s from './ShiftPlanPage.module.css'

const RU_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
const RU_DAYS_SHORT = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysAgoStr(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number)
  return y && m && d ? new Date(y, m - 1, d) : new Date()
}

function dateToStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function fmtDateShort(date) {
  if (!date) return '?'
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yy = String(date.getFullYear()).slice(2)
  return `${dd}.${mm}.${yy}`
}

function fmtNum(value, digits = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('ru-RU', { maximumFractionDigits: digits })
}

function planStatus(projected, target) {
  if (!target) return 'neutral'
  if (projected >= target) return 'ok'
  if (projected >= target * 0.9) return 'warn'
  return 'bad'
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
    const fromDate = parseLocalDate(daysAgoStr(14))
    const toDate = parseLocalDate(todayStr())
    const next = { fromDate, toDate }
    setDraft(next)
    onChange(next)
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
  const today = parseLocalDate(todayStr())
  const isInRange = day => day && dFrom && dTo && day > dFrom && day < dTo
  const isStart = day => day && dFrom && day.getTime() === dFrom.getTime()
  const isEnd = day => day && dTo && day.getTime() === dTo.getTime()
  const isToday = day => day && day.getTime() === today.getTime()
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

export default function ShiftPlanPage() {
  const { emplMap, emplCompanies } = useApp()
  const [company, setCompany] = useState('')
  const [shift, setShift] = useState('day')
  const [dateRange, setDateRange] = useState(() => ({
    fromDate: parseLocalDate(daysAgoStr(14)),
    toDate: parseLocalDate(todayStr()),
  }))
  const [peopleCount, setPeopleCount] = useState(28)
  const [targetTasks, setTargetTasks] = useState(750)
  const [shiftRows, setShiftRows] = useState([])
  const [loadedRange, setLoadedRange] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const dateFrom = dateToStr(dateRange.fromDate)
  const dateTo = dateToStr(dateRange.toDate)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getMonthlyEmployees(dateFrom, dateTo, shift)
      if (data?.error) throw new Error(data.error)
      setShiftRows(data?.rows || [])
      setLoadedRange({ dateFrom, dateTo, shift })
    } catch (err) {
      setError(err.message || 'Ошибка расчета')
      setShiftRows([])
      setLoadedRange(null)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, shift])

  const companyRates = useMemo(() => {
    const byEmployee = new Map()
    for (const row of shiftRows) {
      const name = row.name || row.executor || ''
      if (!name) continue
      const rowCompany = row.company || getCompanyByFio(emplMap, normalizeFio(name)) || '—'
      if (company && rowCompany !== company) continue
      if (!byEmployee.has(name)) {
        byEmployee.set(name, {
          name,
          company: rowCompany,
          tasksCount: 0,
          shiftsWorked: 0,
          bestShift: 0,
        })
      }
      const item = byEmployee.get(name)
      const total = Number(row.total) || 0
      item.tasksCount += total
      item.shiftsWorked += 1
      item.bestShift = Math.max(item.bestShift, total)
    }
    return [...byEmployee.values()]
      .map(row => ({
        ...row,
        avgPerShift: row.shiftsWorked > 0 ? row.tasksCount / row.shiftsWorked : 0,
        projectedTasks: row.shiftsWorked > 0 ? row.tasksCount / row.shiftsWorked : 0,
      }))
      .sort((a, b) =>
        (b.avgPerShift - a.avgPerShift) ||
        (b.tasksCount - a.tasksCount) ||
        a.name.localeCompare(b.name, 'ru')
      )
  }, [company, emplMap, shiftRows])

  const plan = useMemo(() => {
    const requested = Math.max(0, Number(peopleCount) || 0)
    const target = Math.max(0, Number(targetTasks) || 0)
    const selected = companyRates.slice(0, requested)
    let cumulative = 0
    let required = 0
    for (const row of selected) {
      cumulative += row.projectedTasks
      required += 1
      if (target && cumulative >= target) break
    }
    const projected = selected.reduce((sum, row) => sum + row.projectedTasks, 0)
    return {
      selected,
      required: target ? required : selected.length,
      projected,
      gap: Math.max(0, target - projected),
      status: planStatus(projected, target),
    }
  }, [companyRates, peopleCount, targetTasks])

  const canLoad = Boolean(company && dateFrom && dateTo)
  const loadedShiftLabel = loadedRange?.shift === 'night' ? 'Ночь' : 'День'

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>План смены</h1>
          <div className={s.subtitle}>Рекомендованный состав по компании на основе среднего результата за смену</div>
        </div>
        <div className={s.headerBadge}>
          <Users size={15} strokeWidth={2} />
          {company || 'Выберите компанию'}
        </div>
      </div>

      <div className={s.panel}>
        <label className={s.field}>
          <span>Компания</span>
          <select className={s.input} value={company} onChange={e => setCompany(e.target.value)}>
            <option value="">Выберите компанию</option>
            {emplCompanies.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className={s.field}>
          <span>Смена</span>
          <select className={s.input} value={shift} onChange={e => setShift(e.target.value)}>
            <option value="day">День</option>
            <option value="night">Ночь</option>
          </select>
        </label>
        <div className={s.field}>
          <span>Период истории</span>
          <DateRangeDropdown label="Период" dateRange={dateRange} onChange={setDateRange} />
        </div>
        <label className={s.field}>
          <span>Заявка, чел.</span>
          <input className={s.input} type="number" min="1" value={peopleCount} onChange={e => setPeopleCount(e.target.value)} />
        </label>
        <label className={s.field}>
          <span>План СЗ</span>
          <input className={s.input} type="number" min="0" value={targetTasks} onChange={e => setTargetTasks(e.target.value)} />
        </label>
        <button type="button" className="btn btn-primary" onClick={load} disabled={loading || !canLoad}>
          <RefreshCw size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {loading ? 'Считаю...' : 'Подобрать'}
        </button>
      </div>

      {error && <div className={s.empty}>{error}</div>}

      {loadedRange && (
        <div className={s.cards}>
          <div className={`${s.card} ${s[`card_${plan.status}`] || ''}`}>
            <span>Прогноз состава</span>
            <strong>{fmtNum(plan.projected)} СЗ</strong>
            <small>{loadedShiftLabel} · {loadedRange.dateFrom} — {loadedRange.dateTo}</small>
          </div>
          <div className={s.card}>
            <span>План</span>
            <strong>{fmtNum(targetTasks)} СЗ</strong>
            <small>{plan.gap > 0 ? `Не хватает ${fmtNum(plan.gap)} СЗ` : 'План закрывается'}</small>
          </div>
          <div className={s.card}>
            <span>Достаточно людей</span>
            <strong>{plan.required || 0} из {fmtNum(peopleCount)}</strong>
            <small>{companyRates.length ? `Есть статистика по ${companyRates.length} сотрудникам` : 'Нет сотрудников со статистикой'}</small>
          </div>
        </div>
      )}

      <div className={s.tableCard}>
        {!loadedRange && !loading && (
          <div className={s.empty}>Заполните заявку и нажмите «Подобрать»</div>
        )}
        {loading && <div className={s.empty}>Загружаю статистику сотрудников...</div>}
        {loadedRange && !loading && plan.selected.length === 0 && (
          <div className={s.empty}>По выбранной компании нет сотрудников со статистикой за период</div>
        )}
        {loadedRange && !loading && plan.selected.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Роль</th>
                  <th>ФИО</th>
                  <th className={s.num}>СЗ/смена</th>
                  <th className={s.num}>Прогноз СЗ</th>
                  <th className={s.num}>Лучший итог</th>
                  <th className={s.num}>СЗ в истории</th>
                  <th className={s.num}>Смен</th>
                </tr>
              </thead>
              <tbody>
                {plan.selected.map((row, index) => (
                  <tr key={row.name}>
                    <td>{index + 1}</td>
                    <td>
                      <span className={index < plan.required ? s.badgeMain : s.badgeReserve}>
                        {index < plan.required ? 'Основной' : 'Резерв'}
                      </span>
                    </td>
                    <td>{row.name}</td>
                    <td className={s.num}>{fmtNum(row.avgPerShift, 1)}</td>
                    <td className={s.num}>{fmtNum(row.projectedTasks)}</td>
                    <td className={s.num}>{fmtNum(row.bestShift)}</td>
                    <td className={s.num}>{fmtNum(row.tasksCount)}</td>
                    <td className={s.num}>{fmtNum(row.shiftsWorked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
