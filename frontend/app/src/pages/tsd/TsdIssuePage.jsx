import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Printer, RefreshCw, RotateCcw, ScanLine } from 'lucide-react'
import QrCodeSvg from '../../components/QrCodeSvg.jsx'
import { assignTsd, getEmployees, getTsdAssignments, returnTsdByBarcode } from '../../api/index.js'
import { formatTime, shortFio } from '../../utils/format.js'
import s from './TsdIssuePage.module.css'

function assignmentsToEmployeeMap(list) {
  const map = {}
  for (const rec of list || []) {
    if (!rec.executorId) continue
    if (!map[rec.executorId]) map[rec.executorId] = []
    map[rec.executorId].push(rec)
  }
  return map
}

function assignmentsToTsdMap(list) {
  const map = {}
  for (const rec of list || []) {
    if (rec.tsd) map[rec.tsd] = rec
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
  const [assignments, setAssignments] = useState([])
  const [tsdSettings, setTsdSettings] = useState({ totalCount: 0 })
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [company, setCompany] = useState('')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [scanValue, setScanValue] = useState('')
  const [pendingTsd, setPendingTsd] = useState(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [printItems, setPrintItems] = useState([])
  const [printRequested, setPrintRequested] = useState(false)
  const [activeTab, setActiveTab] = useState('issue')
  const [sort, setSort] = useState({ key: 'company', dir: 'asc' })
  const scanRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [employeesData, assignmentsData] = await Promise.all([getEmployees(), getTsdAssignments()])
      setEmployees((employeesData?.employees || []).filter(e => e.executorId))
      setAssignments(assignmentsData?.assignments || [])
      setTsdSettings(assignmentsData?.settings || { totalCount: 0 })
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

  useEffect(() => {
    if (activeTab !== 'issue') return
    scanRef.current?.focus()
  }, [activeTab, pendingTsd])

  useEffect(() => {
    if (!printRequested || !printItems.length) return
    schedulePrint()
    setPrintRequested(false)
  }, [printItems, printRequested])

  const employeesById = useMemo(() => {
    const map = new Map()
    for (const emp of employees) map.set(emp.executorId, emp)
    return map
  }, [employees])

  const companies = useMemo(() => {
    return [...new Set(employees.map(e => e.company).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [employees])

  const assignmentsByEmployee = useMemo(() => assignmentsToEmployeeMap(assignments), [assignments])
  const assignmentsByTsd = useMemo(() => assignmentsToTsdMap(assignments), [assignments])
  const issuedCount = assignments.length
  const totalTsdCount = Number(tsdSettings.totalCount) || 0
  const remainingTsdCount = Math.max(0, totalTsdCount - issuedCount)

  const getEmployeeStatus = useCallback((emp) => assignmentsByEmployee[emp.executorId]?.length ? 'not_returned' : 'returned', [assignmentsByEmployee])

  const toggleSort = (key) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }
    )
  }

  const sortMark = key => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'

  const sortEmployees = useCallback((list) => {
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const listA = assignmentsByEmployee[a.executorId] || []
      const listB = assignmentsByEmployee[b.executorId] || []
      let diff = 0
      if (sort.key === 'company') diff = (a.company || '').localeCompare(b.company || '', 'ru')
      else if (sort.key === 'fio') diff = (a.fio || '').localeCompare(b.fio || '', 'ru')
      else if (sort.key === 'tsd') diff = (listA.map(x => x.tsd).join(', ') || '').localeCompare(listB.map(x => x.tsd).join(', ') || '', 'ru')
      else if (sort.key === 'status') diff = getEmployeeStatus(a).localeCompare(getEmployeeStatus(b), 'ru')
      else if (sort.key === 'assignedAt') {
        diff = (listA[0]?.assignedAt ? new Date(listA[0].assignedAt).getTime() : 0) -
          (listB[0]?.assignedAt ? new Date(listB[0].assignedAt).getTime() : 0)
      }
      return diff * direction || (a.company || '').localeCompare(b.company || '', 'ru') || (a.fio || '').localeCompare(b.fio || '', 'ru')
    })
  }, [assignmentsByEmployee, getEmployeeStatus, sort])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = employees
      .filter(emp => !company || emp.company === company)
      .filter(emp => statusFilter === 'all' || getEmployeeStatus(emp) === statusFilter)
      .filter(emp => !q || `${emp.fio} ${emp.company}`.toLowerCase().includes(q))
    return sortEmployees(list)
  }, [company, employees, getEmployeeStatus, query, sortEmployees, statusFilter])

  const statusEmployees = useMemo(() => {
    const list = employees
      .filter(emp => !company || emp.company === company)
      .filter(emp => statusFilter === 'all' || getEmployeeStatus(emp) === statusFilter)
    return sortEmployees(list)
  }, [company, employees, getEmployeeStatus, sortEmployees, statusFilter])

  const statusRows = useMemo(() => {
    return statusEmployees.flatMap(emp => {
      const activeList = assignmentsByEmployee[emp.executorId] || []
      if (!activeList.length) return [{ key: emp.executorId, employee: emp, assignment: null }]
      return activeList.map(rec => ({ key: `${emp.executorId}-${rec.tsd}`, employee: emp, assignment: rec }))
    })
  }, [assignmentsByEmployee, statusEmployees])

  const selectedEmployees = useMemo(() => {
    return [...selectedIds].map(id => employeesById.get(id)).filter(Boolean)
  }, [employeesById, selectedIds])

  const visibleSelected = filtered.length > 0 && filtered.every(emp => selectedIds.has(emp.executorId))

  const reloadAssignments = useCallback(async () => {
    const data = await getTsdAssignments()
    setAssignments(data?.assignments || [])
    setTsdSettings(data?.settings || { totalCount: 0 })
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
      if (pendingTsd.mode === 'return') {
        const res = await returnTsdByBarcode({
          tsd: pendingTsd.tsd,
          returnedByExecutorId: employee.executorId,
          returnedByFio: employee.fio,
          returnedByCompany: employee.company || '',
        })
        await reloadAssignments()
        if (res.foreignReturn) {
          setMessage(`Внимание: ТСД ${pendingTsd.tsd} числился за ${pendingTsd.assignment?.fio || 'другим сотрудником'}, вернул ${employee.fio}`)
        } else {
          setMessage(`ТСД ${pendingTsd.tsd} возвращен: ${employee.fio}`)
        }
        setPendingTsd(null)
        return
      }

      await assignTsd({
        executorId: employee.executorId,
        fio: employee.fio,
        company: employee.company || '',
        tsd: pendingTsd.tsd,
      })
      await reloadAssignments()
      setMessage(`ТСД ${pendingTsd.tsd} выдан: ${employee.fio}`)
      setPendingTsd(null)
      return
    }

    if (employee?.executorId) {
      setMessage('Для возврата сначала сканируйте ТСД')
      return
    }

    const activeAssignment = assignmentsByTsd[code]
    if (activeAssignment) {
      setPendingTsd({ tsd: code, mode: 'return', assignment: activeAssignment })
      setMessage(`ТСД ${code} числится за ${activeAssignment.fio}. Сканируйте QR того, кто вернул`)
    } else {
      setPendingTsd({ tsd: code, mode: 'assign' })
      setMessage(`ТСД ${code}`)
    }
  }, [assignmentsByTsd, employeesById, pendingTsd, reloadAssignments])

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
    setPrintRequested(true)
  }

  const handleReturn = async (emp, active) => {
    if (!active) return
    try {
      await returnTsdByBarcode({
        tsd: active.tsd,
        returnedByExecutorId: emp.executorId,
        returnedByFio: emp.fio,
        returnedByCompany: emp.company || '',
      })
      await reloadAssignments()
      setMessage(`ТСД ${active.tsd} возвращен: ${emp.fio}`)
    } catch (err) {
      setMessage(err.message || 'Не удалось вернуть ТСД')
    }
  }

  const printLayer = (
    <div className={s.printPortal}>
      {printItems.map(emp => (
        <div key={emp.executorId} className={s.printLabel}>
          <QrCodeSvg value={employeeCode(emp.executorId)} className={s.printQr} title={emp.fio} />
          <div className={s.printCompany}>{emp.company || '—'}</div>
          <div className={s.printName}>{shortFio(emp.fio)}</div>
        </div>
      ))}
    </div>
  )

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Выдача ТСД</h1>
        </div>
        <button type="button" className="btn btn-primary" onClick={load} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {loading ? 'Загрузка...' : 'Обновить'}
        </button>
      </div>

      <div className={s.tabs}>
        <button type="button" className={`${s.tab} ${activeTab === 'issue' ? s.tabActive : ''}`} onClick={() => setActiveTab('issue')}>Выдача</button>
        <button type="button" className={`${s.tab} ${activeTab === 'print' ? s.tabActive : ''}`} onClick={() => setActiveTab('print')}>Печать QR</button>
        <button type="button" className={`${s.tab} ${activeTab === 'status' ? s.tabActive : ''}`} onClick={() => setActiveTab('status')}>Статусы</button>
      </div>

      <div className={s.counters}>
        <div className={s.counter}><span>Рабочих ТСД</span><strong>{totalTsdCount}</strong></div>
        <div className={s.counter}><span>Выдано</span><strong>{issuedCount}</strong></div>
        <div className={s.counter}><span>Остаток</span><strong>{remainingTsdCount}</strong></div>
      </div>

      {activeTab === 'issue' && (
        <div className={s.issueCard} onClick={() => scanRef.current?.focus()}>
          <form className={s.scanForm} onSubmit={handleScanSubmit}>
            <input
              ref={scanRef}
              className={s.scanInput}
              value={scanValue}
              onChange={e => setScanValue(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" className={s.hiddenSubmit}>ОК</button>
          </form>
          <div className={s.scanVisual}>
            <div className={s.scanIcon}>
              <ScanLine size={72} strokeWidth={1.7} />
            </div>
            <div className={s.scanTitle}>{pendingTsd ? 'Сканируйте QR сотрудника' : 'Сканируйте ТСД'}</div>
            <div className={s.scanHint}>
              {pendingTsd ? `ТСД ${pendingTsd.tsd} считан` : 'Сканер готов к работе'}
            </div>
          </div>
          <div className={s.issueHint}>
            {message || (pendingTsd
              ? (pendingTsd.mode === 'return' ? 'После QR сотрудника ТСД будет возвращён' : 'После QR сотрудника ТСД будет закреплён за ним')
              : 'Для возврата сначала сканируйте ТСД')}
          </div>
        </div>
      )}

      {activeTab === 'print' && (
        <>
          <div className={s.toolbar}>
            <select className={s.input} value={company} onChange={e => setCompany(e.target.value)}>
              <option value="">Все компании</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={s.input} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">Все статусы</option>
              <option value="not_returned">Не сдал</option>
              <option value="returned">Сдал</option>
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
              <table className={`${s.table} ${s.printTable}`}>
                <thead>
                  <tr>
                    <th></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('company')}>Компания <span>{sortMark('company')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('fio')}>Исполнитель <span>{sortMark('fio')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('tsd')}>ТСД <span>{sortMark('tsd')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('status')}>Статус <span>{sortMark('status')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('assignedAt')}>Выдан <span>{sortMark('assignedAt')}</span></button></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(emp => {
                    const activeList = assignmentsByEmployee[emp.executorId] || []
                    return (
                      <tr key={emp.executorId}>
                        <td>
                          <button type="button" className={s.iconBtn} onClick={() => toggleOne(emp.executorId)} aria-label="Выбрать">
                            <span className={`${s.checkBox} ${selectedIds.has(emp.executorId) ? s.checkBoxOn : ''}`} />
                          </button>
                        </td>
                        <td>{emp.company || '—'}</td>
                        <td>{emp.fio}</td>
                        <td title={activeList.map(x => x.tsd).join(', ')}>{activeList.length ? activeList.map(x => x.tsd).join(', ') : '—'}</td>
                        <td><span className={activeList.length ? s.badgeWarn : s.badgeOk}>{activeList.length ? 'Не сдал' : 'Сдал'}</span></td>
                        <td>{activeList[0]?.assignedAt ? formatTime(activeList[0].assignedAt) : '—'}</td>
                        <td className={s.actions}>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => printEmployees([emp])}>
                            <Printer size={13} />
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
        </>
      )}

      {activeTab === 'status' && (
        <>
          <div className={s.toolbar}>
            <select className={s.input} value={company} onChange={e => setCompany(e.target.value)}>
              <option value="">Все компании</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={s.input} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">Все статусы</option>
              <option value="not_returned">Не сдал</option>
              <option value="returned">Сдал</option>
            </select>
          </div>
          <div className={s.card}>
            <div className={s.tableWrap}>
              <table className={`${s.table} ${s.statusTable}`}>
                <thead>
                  <tr>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('company')}>Компания <span>{sortMark('company')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('fio')}>Исполнитель <span>{sortMark('fio')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('tsd')}>ТСД <span>{sortMark('tsd')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('status')}>Статус <span>{sortMark('status')}</span></button></th>
                    <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('assignedAt')}>Выдан <span>{sortMark('assignedAt')}</span></button></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {statusRows
                    .map(row => {
                      const emp = row.employee
                      const active = row.assignment
                      return (
                        <tr key={row.key}>
                          <td>{emp.company || '—'}</td>
                          <td>{emp.fio}</td>
                          <td>{active?.tsd || '—'}</td>
                          <td><span className={active ? s.badgeWarn : s.badgeOk}>{active ? 'Не сдал' : 'Сдал'}</span></td>
                          <td>{active?.assignedAt ? formatTime(active.assignedAt) : '—'}</td>
                          <td className={s.actions}>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleReturn(emp, active)} disabled={!active}>
                              <RotateCcw size={13} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {createPortal(printLayer, document.body)}
    </div>
  )
}
