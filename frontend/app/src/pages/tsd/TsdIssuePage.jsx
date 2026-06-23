import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Printer, RefreshCw, RotateCcw, ScanLine } from 'lucide-react'
import QrCodeSvg from '../../components/QrCodeSvg.jsx'
import { assignTsd, getEmployees, getTsdAssignments, returnTsd } from '../../api/index.js'
import { formatTime, shortFio } from '../../utils/format.js'
import s from './TsdIssuePage.module.css'

function assignmentsToMap(list) {
  const map = {}
  for (const rec of list || []) {
    if (rec.executorId) map[rec.executorId] = rec
  }
  return map
}

function employeeCode(executorId) {
  return executorId ? `EMP:${executorId}` : ''
}

function extractEmployeeCode(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  return value.startsWith('EMP:') ? value.slice(4).trim() : value
}

function printQr() {
  const body = document.body
  const cleanup = () => body.classList.remove('tsd-printing')
  body.classList.add('tsd-printing')
  window.addEventListener('afterprint', cleanup, { once: true })
  window.print()
  window.setTimeout(cleanup, 1500)
}

function schedulePrint() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => printQr())
  })
}

export default function TsdIssuePage() {
  const [employees, setEmployees] = useState([])
  const [assignments, setAssignments] = useState({})
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [company, setCompany] = useState('')
  const [query, setQuery] = useState('')
  const [scanValue, setScanValue] = useState('')
  const [pendingTsd, setPendingTsd] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [printItems, setPrintItems] = useState([])
  const scanRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [employeesData, assignmentsData] = await Promise.all([getEmployees(), getTsdAssignments()])
      setEmployees((employeesData?.employees || []).filter(e => e.executorId))
      setAssignments(assignmentsToMap(assignmentsData?.assignments || []))
      setMessage('')
    } catch (err) {
      setMessage(err.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const employeesById = useMemo(() => {
    const map = new Map()
    for (const emp of employees) map.set(emp.executorId, emp)
    return map
  }, [employees])

  const companies = useMemo(() => {
    return [...new Set(employees.map(e => e.company).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [employees])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return employees
      .filter(emp => !company || emp.company === company)
      .filter(emp => !q || `${emp.fio} ${emp.company}`.toLowerCase().includes(q))
      .sort((a, b) => (a.company || '').localeCompare(b.company || '', 'ru') || a.fio.localeCompare(b.fio, 'ru'))
  }, [company, employees, query])

  const selectedEmployees = useMemo(() => {
    return [...selectedIds].map(id => employeesById.get(id)).filter(Boolean)
  }, [employeesById, selectedIds])

  const visibleSelected = filtered.length > 0 && filtered.every(emp => selectedIds.has(emp.executorId))

  const reloadAssignments = useCallback(async () => {
    const data = await getTsdAssignments()
    setAssignments(assignmentsToMap(data?.assignments || []))
  }, [])

  const processScan = useCallback(async (raw) => {
    const code = String(raw || '').trim()
    if (!code) return
    const employee = employeesById.get(extractEmployeeCode(code))

    if (pendingTsd) {
      if (!employee?.executorId) {
        setMessage('После ТСД нужен QR сотрудника')
        return
      }
      await assignTsd({
        executorId: employee.executorId,
        fio: employee.fio,
        company: employee.company || '',
        tsd: pendingTsd,
      })
      await reloadAssignments()
      setMessage(`ТСД ${pendingTsd} выдан: ${employee.fio}`)
      setPendingTsd('')
      return
    }

    if (employee?.executorId) {
      const active = assignments[employee.executorId]
      if (!active) {
        setMessage('Нет активной выдачи')
        return
      }
      await returnTsd(employee.executorId)
      await reloadAssignments()
      setMessage(`ТСД ${active.tsd} возвращен: ${employee.fio}`)
      return
    }

    setPendingTsd(code)
    setMessage(`ТСД ${code}`)
  }, [assignments, employeesById, pendingTsd, reloadAssignments])

  const handleScanSubmit = async (event) => {
    event.preventDefault()
    try {
      await processScan(scanValue)
      setScanValue('')
    } catch (err) {
      setMessage(err.message || 'Ошибка операции')
    } finally {
      scanRef.current?.focus()
    }
  }

  const toggleOne = (executorId) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(executorId)) next.delete(executorId)
      else next.add(executorId)
      return next
    })
  }

  const toggleVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (visibleSelected) filtered.forEach(emp => next.delete(emp.executorId))
      else filtered.forEach(emp => next.add(emp.executorId))
      return next
    })
  }

  const printEmployees = (list) => {
    const prepared = (list || []).filter(emp => emp?.executorId)
    if (!prepared.length) {
      setMessage('Выберите сотрудников для печати')
      return
    }
    setPrintItems(prepared)
    schedulePrint()
  }

  const handleReturn = async (emp) => {
    const active = assignments[emp.executorId]
    if (!active) return
    try {
      await returnTsd(emp.executorId)
      await reloadAssignments()
      setMessage(`ТСД ${active.tsd} возвращен: ${emp.fio}`)
    } catch (err) {
      setMessage(err.message || 'Не удалось вернуть ТСД')
    }
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Выдача ТСД</h1>
          <div className={s.subtitle}>QR сотрудников, выдача, возврат и печать</div>
        </div>
        <button type="button" className="btn btn-primary" onClick={load} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {loading ? 'Загрузка...' : 'Обновить'}
        </button>
      </div>

      <div className={s.scanPanel}>
        <form className={s.scanForm} onSubmit={handleScanSubmit}>
          <ScanLine size={16} />
          <input
            ref={scanRef}
            className={s.scanInput}
            value={scanValue}
            onChange={e => setScanValue(e.target.value)}
            placeholder={pendingTsd ? 'QR сотрудника' : 'ТСД или QR сотрудника'}
            autoComplete="off"
          />
          <button type="submit" className="btn btn-primary btn-sm">ОК</button>
        </form>
        <span className={pendingTsd ? s.badgeWarn : s.badgeOk}>{pendingTsd ? `ТСД ${pendingTsd}` : 'Готово'}</span>
        {message && <span className={s.meta}>{message}</span>}
      </div>

      <div className={s.toolbar}>
        <select className={s.input} value={company} onChange={e => setCompany(e.target.value)}>
          <option value="">Все компании</option>
          {companies.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className={s.input} value={query} onChange={e => setQuery(e.target.value)} placeholder="ФИО" />
        <button type="button" className="btn btn-secondary" onClick={toggleVisible}>
          <span className={`${s.checkBox} ${visibleSelected ? s.checkBoxOn : ''}`} />
          <span>Видимые</span>
        </button>
        <button type="button" className="btn btn-primary" onClick={() => printEmployees(selectedEmployees)}>
          <Printer size={14} />
          <span>Печать выбранных</span>
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => printEmployees(filtered)}>
          <Printer size={14} />
          <span>{company ? 'Печать компании' : 'Печать списка'}</span>
        </button>
        <span className={s.meta}>Выбрано: {selectedIds.size}</span>
      </div>

      <div className={s.card}>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th></th>
                <th>Компания</th>
                <th>Исполнитель</th>
                <th>ТСД</th>
                <th>Статус</th>
                <th>Выдан</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(emp => {
                const active = assignments[emp.executorId]
                return (
                  <tr key={emp.executorId}>
                    <td>
                      <button type="button" className={s.iconBtn} onClick={() => toggleOne(emp.executorId)} aria-label="Выбрать">
                        <span className={`${s.checkBox} ${selectedIds.has(emp.executorId) ? s.checkBoxOn : ''}`} />
                      </button>
                    </td>
                    <td>{emp.company || '—'}</td>
                    <td>{emp.fio}</td>
                    <td>{active?.tsd || '—'}</td>
                    <td><span className={active ? s.badgeWarn : s.badgeOk}>{active ? 'Не сдал' : 'Сдал'}</span></td>
                    <td>{active?.assignedAt ? formatTime(active.assignedAt) : '—'}</td>
                    <td className={s.actions}>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => printEmployees([emp])}>
                        <Printer size={13} />
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleReturn(emp)} disabled={!active}>
                        <RotateCcw size={13} />
                      </button>
                    </td>
                  </tr>
                )
              })}
              {!filtered.length && (
                <tr><td colSpan="7" className={s.empty}>Нет сотрудников</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={s.printSheet}>
        {printItems.map(emp => (
          <div key={emp.executorId} className={s.printLabel}>
            <QrCodeSvg value={employeeCode(emp.executorId)} className={s.printQr} title={emp.fio} />
            <div className={s.printCompany}>{emp.company || '—'}</div>
            <div className={s.printName}>{shortFio(emp.fio)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
