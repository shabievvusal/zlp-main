import { useCallback, useMemo, useState } from 'react'
import { RefreshCw, Users } from 'lucide-react'
import * as api from '../../api/index.js'
import DatePicker from '../../components/ui/DatePicker.jsx'
import { useApp } from '../../context/AppContext.jsx'
import { getCompanyByFio, normalizeFio } from '../../utils/emplUtils.js'
import s from './ShiftPlanPage.module.css'

const DEFAULT_SHIFT_HOURS = 10.5

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysAgoStr(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

export default function ShiftPlanPage() {
  const { emplMap, emplCompanies, idleThresholdMinutes } = useApp()
  const [company, setCompany] = useState('')
  const [shift, setShift] = useState('day')
  const [dateFrom, setDateFrom] = useState(daysAgoStr(14))
  const [dateTo, setDateTo] = useState(todayStr)
  const [peopleCount, setPeopleCount] = useState(28)
  const [targetTasks, setTargetTasks] = useState(750)
  const [shiftHours, setShiftHours] = useState(DEFAULT_SHIFT_HOURS)
  const [rates, setRates] = useState([])
  const [loadedRange, setLoadedRange] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getAnalysisEmployeeRates({
        dateFrom,
        dateTo,
        shift,
        idleThresholdMinutes,
      })
      if (data?.error) throw new Error(data.error)
      setRates(data?.employees || [])
      setLoadedRange({ dateFrom, dateTo, shift })
    } catch (err) {
      setError(err.message || 'Ошибка расчета')
      setRates([])
      setLoadedRange(null)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, idleThresholdMinutes, shift])

  const companyRates = useMemo(() => {
    return rates
      .map(row => {
        const rowCompany = getCompanyByFio(emplMap, normalizeFio(row.name)) || '—'
        const projectedTasks = Number(row.szPerHour || 0) * Number(shiftHours || 0)
        return { ...row, company: rowCompany, projectedTasks }
      })
      .filter(row => !company || row.company === company)
      .sort((a, b) =>
        (b.szPerHour - a.szPerHour) ||
        (b.tasksCount - a.tasksCount) ||
        a.name.localeCompare(b.name, 'ru')
      )
  }, [company, emplMap, rates, shiftHours])

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
          <div className={s.subtitle}>Рекомендованный состав по компании на основе исторической скорости СЗ/час</div>
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
        <label className={s.field}>
          <span>История с</span>
          <DatePicker value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </label>
        <label className={s.field}>
          <span>История по</span>
          <DatePicker value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </label>
        <label className={s.field}>
          <span>Заявка, чел.</span>
          <input className={s.input} type="number" min="1" value={peopleCount} onChange={e => setPeopleCount(e.target.value)} />
        </label>
        <label className={s.field}>
          <span>План СЗ</span>
          <input className={s.input} type="number" min="0" value={targetTasks} onChange={e => setTargetTasks(e.target.value)} />
        </label>
        <label className={s.field}>
          <span>Рабочих часов</span>
          <input className={s.input} type="number" min="1" step="0.5" value={shiftHours} onChange={e => setShiftHours(e.target.value)} />
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
                  <th className={s.num}>СЗ/час</th>
                  <th className={s.num}>Прогноз СЗ</th>
                  <th className={s.num}>Пик/час</th>
                  <th className={s.num}>СЗ в истории</th>
                  <th className={s.num}>Часов</th>
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
                    <td className={s.num}>{fmtNum(row.szPerHour, 2)}</td>
                    <td className={s.num}>{fmtNum(row.projectedTasks)}</td>
                    <td className={s.num}>{fmtNum(row.peakPerHour, 1)}</td>
                    <td className={s.num}>{fmtNum(row.tasksCount)}</td>
                    <td className={s.num}>{fmtNum(row.hoursWorked)}</td>
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
