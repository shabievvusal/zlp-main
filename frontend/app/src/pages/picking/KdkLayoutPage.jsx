import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, RotateCcw, ScanLine } from 'lucide-react'
import Code128Barcode from '../../components/Code128Barcode.jsx'
import {
  assignTsd,
  fetchLastKdkCompletedForExecutor,
  getEmployees,
  getLiveMonitorViaBrowser,
  getPieceSelectionTasks,
  getTsdAssignments,
  returnTsd,
} from '../../api/index.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { useApp } from '../../context/AppContext.jsx'
import { getCompanyByFio, normalizeFio } from '../../utils/emplUtils.js'
import { formatTime, shortFio } from '../../utils/format.js'
import s from './KdkLayoutPage.module.css'

const IDLE_LIMIT_MS = 5 * 60 * 1000
const PIECE_SOURCE_ZONES = [
  'c976ff6d-865c-472c-a754-cee17e93e63d',
  '0b29f9ce-9549-435e-b7c2-ecdd3e937057',
  '4cdf0cb7-9361-43b6-abd7-cc98f594765b',
]
const PIECE_TEMPS = ['LOW_COLD', 'MEDIUM_COLD', 'ORDINARY']

function fullName(user) {
  if (!user) return ''
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ').trim()
}

function localDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function dateToApiFrom(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${d}T00:00:00+03:00`).toISOString()
}

function dateToApiTo(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return new Date(`${y}-${m}-${d}T23:59:59.999+03:00`).toISOString()
}

function getByPath(obj, path) {
  return path.split('.').reduce((cur, key) => cur?.[key], obj)
}

function firstValue(obj, paths) {
  for (const path of paths) {
    const value = getByPath(obj, path)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function fmtNum(value) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('ru-RU') : String(value)
}

function fmtAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff) || diff < 0) return ''
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'только что'
  return `${min} мин`
}

function extractEmployeeCode(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  return value.startsWith('EMP:') ? value.slice(4).trim() : value
}

function assignmentsToMap(list) {
  const map = {}
  for (const rec of list || []) {
    if (!rec.executorId) continue
    map[rec.executorId] = rec
  }
  return map
}

function parseKdkRows(data, emplMap, emplIdMap) {
  const value = data?.value || data || {}
  const entries = value.pickByLineHandlingUnitsInProgress || []
  return entries.map((entry, index) => {
    const user = entry.user || entry.responsibleUser || entry.executor || {}
    const executor = fullName(user) || entry.executorName || entry.userName || '—'
    const executorId = user.id || entry.executorId || entry.userId || ''
    const norm = normalizeFio(executor)
    const company = (executorId && emplIdMap.get(executorId)) || getCompanyByFio(emplMap, norm) || '—'
    const task = firstValue(entry, [
      'taskNumber',
      'taskId',
      'selectionTaskNumber',
      'handlingUnitBarcode',
      'targetHandlingUnitBarcode',
      'sourceHandlingUnitBarcode',
      'id',
    ]) || `КДК-${index + 1}`
    const pieces = firstValue(entry, [
      'itemsLeft',
      'piecesLeft',
      'quantityLeft',
      'restQuantity',
      'productsQuantity',
      'itemsQuantity',
      'quantity',
    ])
    return {
      key: `kdk-${executorId || executor}-${task}-${index}`,
      operation: 'КДК',
      company,
      executor,
      executorId,
      task,
      pieces,
      lastActionAt: null,
      raw: entry,
    }
  })
}

function parsePieceRows(items, emplMap, emplIdMap) {
  return (items || []).map((row, index) => {
    const executor = fullName(row.responsibleUser) || '—'
    const executorId = row.responsibleUser?.id || ''
    const norm = normalizeFio(executor)
    const company = (executorId && emplIdMap.get(executorId)) || getCompanyByFio(emplMap, norm) || '—'
    const task = row.targetHandlingUnitBarcode || row.id || `ШО-${index + 1}`
    return {
      key: `piece-${row.id || task}-${index}`,
      operation: 'Штучный отбор',
      company,
      executor,
      executorId,
      task,
      pieces: null,
      lastActionAt: row.updatedAt || row.createdAt || null,
      raw: row,
    }
  })
}

export default function KdkLayoutPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const { emplMap, emplIdMap } = useApp()
  const [rows, setRows] = useState([])
  const [employees, setEmployees] = useState([])
  const [assignments, setAssignments] = useState({})
  const [pendingTsd, setPendingTsd] = useState('')
  const [scanValue, setScanValue] = useState('')
  const [scanMessage, setScanMessage] = useState('')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')
  const [sort, setSort] = useState({ key: 'lastActionAt', dir: 'asc' })
  const scanRef = useRef(null)

  useEffect(() => {
    getEmployees()
      .then(data => setEmployees((data?.employees || []).filter(e => e.executorId)))
      .catch(() => setEmployees([]))
  }, [])

  const reloadAssignments = useCallback(async () => {
    const data = await getTsdAssignments()
    setAssignments(assignmentsToMap(data?.assignments || []))
    return data?.assignments || []
  }, [])

  useEffect(() => {
    reloadAssignments().catch(err => setScanMessage(err.message || 'Не удалось загрузить выдачи ТСД'))
  }, [reloadAssignments])

  const employeesById = useMemo(() => {
    const map = new Map()
    for (const emp of employees) map.set(emp.executorId, emp)
    return map
  }, [employees])

  const toggleSort = (key) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'lastActionAt' ? 'asc' : 'desc' }
    )
  }

  const findEmployeeByScan = useCallback((raw) => {
    const code = extractEmployeeCode(raw)
    return employeesById.get(code) || null
  }, [employeesById])

  const processScan = useCallback(async (raw) => {
    const code = String(raw || '').trim()
    if (!code) return
    const employee = findEmployeeByScan(code)

    if (pendingTsd) {
      if (!employee?.executorId) {
        setScanMessage('После штрихкода ТСД нужно сканировать код сотрудника')
        return
      }
      await assignTsd({
        executorId: employee.executorId,
        fio: employee.fio,
        company: employee.company || '',
        tsd: pendingTsd,
      })
      await reloadAssignments()
      setScanMessage(`ТСД ${pendingTsd} выдан: ${employee.fio}`)
      setPendingTsd('')
      return
    }

    if (employee?.executorId) {
      if (!assignments[employee.executorId]) {
        setScanMessage('У сотрудника нет активной выдачи. Для выдачи сначала сканируйте ТСД')
        return
      }
      const tsd = assignments[employee.executorId].tsd
      await returnTsd(employee.executorId)
      await reloadAssignments()
      setScanMessage(`ТСД ${tsd} возвращен: ${employee.fio}`)
      return
    }

    setPendingTsd(code)
    setScanMessage(`ТСД ${code} считан. Теперь сканируйте код сотрудника`)
  }, [assignments, findEmployeeByScan, pendingTsd, reloadAssignments])

  const handleScanSubmit = async (event) => {
    event.preventDefault()
    try {
      await processScan(scanValue)
      setScanValue('')
    } catch (err) {
      setScanMessage(err.message || 'Ошибка операции с ТСД')
    } finally {
      scanRef.current?.focus()
    }
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
    try {
      const today = localDay(new Date())
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      const livePromise = getLiveMonitorViaBrowser(token)
      const piecePromise = getPieceSelectionTasks(token, {
        dateFrom: dateToApiFrom(today),
        dateTo: dateToApiTo(tomorrow),
        status: ['IN_PROGRESS'],
        sourceZoneId: PIECE_SOURCE_ZONES,
        shipmentTemperatureMode: PIECE_TEMPS,
        pageNumber: 1,
        pageSize: 500,
      })
      const [live, piece] = await Promise.all([livePromise, piecePromise])
      await reloadAssignments()
      const kdkBaseRows = parseKdkRows(live, emplMap, emplIdMap)
      const kdkRows = await Promise.all(kdkBaseRows.map(async row => {
        if (!row.executorId) return row
        try {
          const res = await fetchLastKdkCompletedForExecutor(token, row.executorId)
          const lastActionAt = res.maxCompletedAt ? new Date(res.maxCompletedAt).toISOString() : null
          return {
            ...row,
            pieces: res.remainingPieces ?? row.pieces,
            lastActionAt,
          }
        } catch {
          return row
        }
      }))
      const pieceItems = (piece?.value ?? piece)?.items ?? []
      setRows([...kdkRows, ...parsePieceRows(pieceItems, emplMap, emplIdMap)])
      setLastUpdated(new Date().toISOString())
    } catch (err) {
      setRows([])
      setError(err.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [emplIdMap, emplMap, forceRefresh, getToken, isTokenValid, reloadAssignments])

  const rowsWithTsd = useMemo(() => rows.map(row => {
    const assignment = row.executorId ? assignments[row.executorId] : null
    const idleMs = row.lastActionAt ? Date.now() - new Date(row.lastActionAt).getTime() : null
    return {
      ...row,
      tsd: assignment?.tsd || '',
      tsdStatus: assignment ? 'Не сдал' : 'Сдал',
      idle: idleMs == null ? false : idleMs > IDLE_LIMIT_MS,
      idleMs,
    }
  }), [assignments, rows])

  const sorted = useMemo(() => {
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...rowsWithTsd].sort((a, b) => {
      let diff = 0
      if (sort.key === 'operation') diff = (a.operation || '').localeCompare(b.operation || '', 'ru')
      else if (sort.key === 'company') diff = (a.company || '').localeCompare(b.company || '', 'ru')
      else if (sort.key === 'executor') diff = (a.executor || '').localeCompare(b.executor || '', 'ru')
      else if (sort.key === 'lastActionAt') {
        diff = (a.lastActionAt ? new Date(a.lastActionAt).getTime() : 0) - (b.lastActionAt ? new Date(b.lastActionAt).getTime() : 0)
      }
      return diff * direction || (a.company || '').localeCompare(b.company || '', 'ru') || (a.executor || '').localeCompare(b.executor || '', 'ru')
    })
  }, [rowsWithTsd, sort])

  const activeAssignments = Object.entries(assignments)
  const selectedEmployee = selectedEmployeeId ? employeesById.get(selectedEmployeeId) : null
  const employeeCode = selectedEmployee?.executorId ? `EMP:${selectedEmployee.executorId}` : ''
  const sortMark = key => sort.key === key ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'

  const handleManualReturn = async (executorId, rec) => {
    try {
      await returnTsd(executorId)
      await reloadAssignments()
      setScanMessage(`ТСД ${rec.tsd} возвращен: ${rec.fio || executorId}`)
    } catch (err) {
      setScanMessage(err.message || 'Не удалось вернуть ТСД')
    }
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Зависшие задачи</h1>
          <div className={s.subtitle}>КДК и штучный отбор: исполнитель, ТСД, последний пик и простой</div>
        </div>
        <div className={s.meta}>{lastUpdated ? `Обновлено: ${formatTime(lastUpdated)}` : 'Данные не загружены'}</div>
      </div>

      <div className={s.scanPanel}>
        <form className={s.scanForm} onSubmit={handleScanSubmit}>
          <ScanLine size={16} />
          <input
            ref={scanRef}
            className={s.scanInput}
            value={scanValue}
            onChange={e => setScanValue(e.target.value)}
            placeholder={pendingTsd ? 'Сканируйте код сотрудника' : 'Сканируйте ТСД или код сотрудника'}
            autoComplete="off"
          />
          <button type="submit" className="btn btn-primary btn-sm">ОК</button>
        </form>
        <div className={s.scanState}>
          {pendingTsd ? <span className={s.badgeWarn}>ТСД {pendingTsd}: ждём сотрудника</span> : <span className={s.badgeOk}>Готов к сканированию</span>}
          {scanMessage && <span className={s.meta}>{scanMessage}</span>}
        </div>
      </div>

      <div className={s.toolbar}>
        <button type="button" className="btn btn-primary" onClick={load} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {loading ? 'Загрузка...' : 'Обновить'}
        </button>
        <select className={s.employeeSelect} value={selectedEmployeeId} onChange={e => setSelectedEmployeeId(e.target.value)}>
          <option value="">Код сотрудника</option>
          {employees.map(emp => (
            <option key={emp.executorId} value={emp.executorId}>{emp.fio} · {emp.company || '—'}</option>
          ))}
        </select>
        {selectedEmployee && employeeCode && (
          <div className={s.employeeCode}>
            <div className={s.employeeCodeInfo}>
              <strong>{shortFio(selectedEmployee.fio)}</strong>
              <span>{selectedEmployee.company || '—'}</span>
            </div>
            <Code128Barcode value={employeeCode} className={s.employeeBarcode} />
          </div>
        )}
        <span className={s.meta}>Код сотрудника содержит EMP:UUID, его можно сканировать после ТСД</span>
      </div>

      {activeAssignments.length > 0 && (
        <div className={s.assignments}>
          {activeAssignments.map(([executorId, rec]) => (
            <span key={executorId} className={s.assignmentChip}>
              {rec.tsd} · {shortFio(rec.fio || executorId)}
              <button type="button" onClick={() => handleManualReturn(executorId, rec)} title="Вернуть ТСД">
                <RotateCcw size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <div className={s.empty}>{error}</div>}

      <div className={s.card}>
        {!loading && !rows.length && !error && <div className={s.empty}>Нажмите «Обновить», чтобы проверить зависшие задачи</div>}
        {loading && <div className={s.empty}>Загрузка задач...</div>}
        {!loading && rows.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('operation')}>Операция <span>{sortMark('operation')}</span></button></th>
                  <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('company')}>Компания <span>{sortMark('company')}</span></button></th>
                  <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('executor')}>Исполнитель <span>{sortMark('executor')}</span></button></th>
                  <th>ТСД</th>
                  <th>Статус ТСД</th>
                  <th>Задача / ЕО</th>
                  <th className={s.num}>Остаток</th>
                  <th><button type="button" className={s.sortBtn} onClick={() => toggleSort('lastActionAt')}>Последнее действие <span>{sortMark('lastActionAt')}</span></button></th>
                  <th>Простой</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(row => (
                  <tr key={row.key} className={row.idle ? s.rowIdle : ''}>
                    <td>{row.operation}</td>
                    <td>{row.company}</td>
                    <td title={row.executor}>{shortFio(row.executor)}</td>
                    <td>{row.tsd || '—'}</td>
                    <td><span className={row.tsd ? s.badgeWarn : s.badgeOk}>{row.tsdStatus}</span></td>
                    <td className={s.tdEo}>{row.task || '—'}</td>
                    <td className={s.num}>{row.pieces == null ? '—' : fmtNum(row.pieces)}</td>
                    <td>
                      {row.lastActionAt ? (
                        <span className={row.idle ? s.idleText : ''}>
                          {formatTime(row.lastActionAt)}
                        </span>
                      ) : '—'}
                    </td>
                    <td>{row.lastActionAt ? <span className={row.idle ? s.idleText : ''}>{fmtAgo(row.lastActionAt)}</span> : '—'}</td>
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
