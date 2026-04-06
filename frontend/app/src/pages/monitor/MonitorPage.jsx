import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import * as api from '../../api/index.js'
import { useApp } from '../../context/AppContext.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import { normalizeFio } from '../../utils/emplUtils.js'
import { X, ClipboardList, RefreshCw } from 'lucide-react'
import { formatTime, shortFio } from '../../utils/format.js'
import styles from './MonitorPage.module.css'

// ─── Constants ───────────────────────────────────────────────────────────────

const EXECUTOR_ID_CACHE_KEY = 'monitorExecutorIdCache'
const LS_ACCESS_KEY = 'wms_access_token'
const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry'
const EXPIRY_MARGIN_MS = 60 * 1000
const IDLE_WORK_MIN = 10
const REFRESH_INTERVAL_MS = 3 * 60 * 1000

// ─── Module-level utilities ───────────────────────────────────────────────────

function personKey(norm) {
  return (norm || '').split(/\s+/).slice(0, 2).join(' ') || norm
}

function findByPersonKey(map, normFio) {
  if (map.has(normFio)) return map.get(normFio)
  const pk = personKey(normFio)
  for (const [k, v] of map) {
    if (personKey(k) === pk) return v
  }
  return undefined
}

function hasByPersonKey(set, normFio) {
  if (set.has(normFio)) return true
  const pk = personKey(normFio)
  for (const v of set) {
    if (personKey(v) === pk) return true
  }
  return false
}

function titleCase(s) {
  return (s || '').split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ')
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h} ч ${m} мин`
  return `${m} мин`
}

function parseLiveData(data) {
  const result = new Map()
  const value = data?.value || data || {}
  const sections = [
    { key: 'pickByLineHandlingUnitsInProgress',     type: 'КДК' },
    { key: 'pieceSelectionHandlingUnitsInProgress',  type: 'ХР' },
    { key: 'palletSelectionHandlingUnitsInProgress', type: 'Паллет' },
  ]
  for (const { key, type } of sections) {
    for (const entry of (value[key] || [])) {
      const u = entry.user || {}
      const displayFio = [u.lastName, u.firstName, u.middleName].filter(Boolean).join(' ')
      if (!displayFio) continue
      const normFio = normalizeFio(displayFio)
      if (!result.has(normFio)) {
        result.set(normFio, { displayFio, userId: u.id || '', taskType: type, startedAt: entry.startedAt || null })
      }
    }
  }
  return result
}

function getStoredToken() {
  try {
    const token = localStorage.getItem(LS_ACCESS_KEY)
    const expiry = parseInt(localStorage.getItem(LS_ACCESS_EXPIRY_KEY) || '0', 10)
    if (token && (!expiry || Date.now() < expiry - EXPIRY_MARGIN_MS)) return token
  } catch {}
  return null
}

/** Applies absent state logic to refs (modifies absentStateRef.current, sets lastLiveSnapshotRef.current) */
function applyAbsentState(newSnapshot, rollcall, absentStateRef, lastLiveSnapshotRef) {
  const now = Date.now()
  const absentState = absentStateRef.current
  const lastSnapshot = lastLiveSnapshotRef.current

  const oldPKs = new Set([...lastSnapshot.keys()].map(personKey))
  const newPKs = new Set([...newSnapshot.keys()].map(personKey))

  for (const normFio of rollcall) {
    const pk = personKey(normFio)
    const wasInLive = lastSnapshot.has(normFio) || oldPKs.has(pk)
    const isInLive  = newSnapshot.has(normFio)  || newPKs.has(pk)
    let state = absentState.get(normFio)
    if (!state) { state = { absentSince: null, wasAbsentMs: null }; absentState.set(normFio, state) }

    if (isInLive) {
      if (state.absentSince !== null) {
        state.wasAbsentMs = now - state.absentSince
        state.absentSince = null
      }
    } else {
      if (wasInLive && state.absentSince === null) {
        state.absentSince = now
        state.wasAbsentMs = null
      } else if (!wasInLive && state.absentSince === null) {
        state.absentSince = now
      }
    }
  }

  lastLiveSnapshotRef.current = newSnapshot
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TaskTypeBadge({ type }) {
  if (!type) return <span>—</span>
  const cls = type === 'КДК' ? styles.taskTypeKdk : type === 'ХР' ? styles.taskTypeKhr : styles.taskTypePallet
  return <span className={`${styles.opBadge} ${cls}`}>{type}</span>
}

function OperationSummary({ rows }) {
  const totalByType = { 'КДК': 0, 'ХР': 0, 'Паллет': 0 }
  const byCompanyType = new Map()

  for (const r of rows) {
    if (!r.isActive || !r.taskType) continue
    totalByType[r.taskType] = (totalByType[r.taskType] || 0) + 1
    if (!byCompanyType.has(r.company)) byCompanyType.set(r.company, { 'КДК': 0, 'ХР': 0, 'Паллет': 0 })
    const ct = byCompanyType.get(r.company)
    ct[r.taskType] = (ct[r.taskType] || 0) + 1
  }

  const totalActive = totalByType['КДК'] + totalByType['ХР'] + totalByType['Паллет']
  if (totalActive === 0) return null

  const companyRows = [...byCompanyType.entries()]
    .filter(([, ct]) => ct['КДК'] + ct['ХР'] + ct['Паллет'] > 0)
    .sort((a, b) => {
      const aSum = a[1]['КДК'] + a[1]['ХР'] + a[1]['Паллет']
      const bSum = b[1]['КДК'] + b[1]['ХР'] + b[1]['Паллет']
      return bSum - aSum
    })

  return (
    <div className={styles.opSummary}>
      <div className={styles.opSummaryHeader}>
        <span className={styles.opSummaryTitle}>В работе: <b>{totalActive}</b></span>
        <span className={styles.opBadges}>
          {totalByType['КДК'] > 0 && <span className={`${styles.opBadge} ${styles.taskTypeKdk}`}>КДК <b>{totalByType['КДК']}</b></span>}
          {totalByType['ХР'] > 0 && <span className={`${styles.opBadge} ${styles.taskTypeKhr}`}>ХР <b>{totalByType['ХР']}</b></span>}
          {totalByType['Паллет'] > 0 && <span className={`${styles.opBadge} ${styles.taskTypePallet}`}>Паллет <b>{totalByType['Паллет']}</b></span>}
        </span>
      </div>
      <div className={styles.opCompanyList}>
        {companyRows.map(([company, ct]) => {
          const sum = ct['КДК'] + ct['ХР'] + ct['Паллет']
          return (
            <div key={company} className={styles.opCompanyRow}>
              <span className={styles.opCompanyName}>{company}</span>
              <span className={styles.opCompanyTotal}>{sum}</span>
              <span className={styles.opBadges}>
                {ct['КДК'] > 0 && <span className={`${styles.opBadge} ${styles.taskTypeKdk}`}>КДК <b>{ct['КДК']}</b></span>}
                {ct['ХР'] > 0 && <span className={`${styles.opBadge} ${styles.taskTypeKhr}`}>ХР <b>{ct['ХР']}</b></span>}
                {ct['Паллет'] > 0 && <span className={`${styles.opBadge} ${styles.taskTypePallet}`}>Паллет <b>{ct['Паллет']}</b></span>}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EmployeeRow({ r, onClick }) {
  const wasAbsent = r.wasAbsentMs
    ? <span className={styles.wasAbsent}>вернулся (был {formatDuration(r.wasAbsentMs)})</span>
    : null
  const szVal = r.sz != null && r.sz > 0 ? String(r.sz) : '—'
  const lastTaskStr = r.lastTaskMs != null ? formatDuration(r.lastTaskMs) : '—'

  if (r.inWorkByTask) {
    const taskStr = r.taskDurationMs ? formatDuration(r.taskDurationMs) : '—'
    const durationHint = r.isActive && r.taskDurationMs
      ? <span className={styles.idleHint}>(задача {taskStr})</span>
      : null
    return (
      <tr
        className={`${styles.rowActive} ${styles.rowClickable}`}
        onClick={() => onClick(r)}
        title="Нажмите, чтобы изменить компанию и статус на смене"
      >
        <td className={styles.tdName} title={r.displayFio}>{shortFio(r.displayFio)}</td>
        <td><TaskTypeBadge type={r.taskType} /></td>
        <td className={styles.tdStatus}><span className={styles.dotGreen} /> в работе {wasAbsent}</td>
        <td className={styles.tdIdle}>
          <span className={`${styles.idleTime} ${styles.idleTimeWork}`}>{lastTaskStr} назад</span>
          {durationHint}
        </td>
        <td className={styles.tdSz}>{szVal}</td>
      </tr>
    )
  } else {
    const sinceStr = r.lastTaskMs != null ? `${lastTaskStr} назад` : 'нет данных'
    return (
      <tr
        className={`${styles.rowInactive} ${styles.rowClickable}`}
        onClick={() => onClick(r)}
        title="Нажмите, чтобы изменить компанию и статус на смене"
      >
        <td className={styles.tdName} title={r.displayFio}>{shortFio(r.displayFio)}</td>
        <td><TaskTypeBadge type={r.taskType} /></td>
        <td className={styles.tdStatus}><span className={styles.dotRed} /> не в работе</td>
        <td className={styles.tdIdle}>
          <span className={`${styles.idleTime} ${styles.idleTimeIdle}`}>{sinceStr}</span>
        </td>
        <td className={styles.tdSz}>{szVal}</td>
      </tr>
    )
  }
}

function CompanyCard({ g, isExpanded, onToggle, onRowClick }) {
  const total = g.active + g.inactive
  const cardCls = `${styles.companyCard} ${g.inactive === 0 ? styles.companyCardOk : styles.companyCardWarn}`

  const tableHead = (
    <thead>
      <tr>
        <th>ФИО</th>
        <th>Тип задачи</th>
        <th>Статус</th>
        <th>В задаче / Простой</th>
        <th className={styles.thSz}>СЗ</th>
      </tr>
    </thead>
  )

  const activeRows = g.rows.filter(r => r.inWorkByTask)
  const inactiveRows = g.rows.filter(r => !r.inWorkByTask)

  return (
    <div className={cardCls}>
      <div className={styles.companyHeader} onClick={onToggle}>
        <div className={styles.companyTitle}>
          <span className={styles.companyName}>{g.company}</span>
          <span className={styles.companyCount}>{total} чел.</span>
        </div>
        <div className={styles.companyBadges}>
          <span className={`${styles.badge} ${styles.badgeActive}`}>{g.active} в работе</span>
          {g.inactive > 0 && (
            <span className={`${styles.badge} ${styles.badgeInactive}`}>{g.inactive} не работают</span>
          )}
        </div>
        <span className={styles.expandIcon}>{isExpanded ? '▲' : '▼'}</span>
      </div>
      {isExpanded && (
        <div className={styles.employeeList}>
          <div className={styles.twoCol}>
            <div className={styles.colActive}>
              <div className={`${styles.colHeader} ${styles.colHeaderActive}`}>
                В работе ({activeRows.length})
              </div>
              {activeRows.length > 0 ? (
                <table className={styles.empTable}>
                  {tableHead}
                  <tbody>
                    {activeRows.map(r => (
                      <EmployeeRow key={r.normFio} r={r} onClick={onRowClick} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className={styles.colEmpty}>Нет активных</div>
              )}
            </div>
            <div>
              <div className={`${styles.colHeader} ${styles.colHeaderInactive}`}>
                Не работают ({inactiveRows.length})
              </div>
              {inactiveRows.length > 0 ? (
                <table className={styles.empTable}>
                  {tableHead}
                  <tbody>
                    {inactiveRows.map(r => (
                      <EmployeeRow key={r.normFio} r={r} onClick={onRowClick} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className={styles.colEmpty}>Все в работе</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SuggestionsSection({ suggestions, onAdd, onAddAll }) {
  if (!suggestions.length) return null
  return (
    <div className={styles.suggestions}>
      <div className={styles.suggestionsHeader}>
        Обнаружены в системе, но не в перекличке ({suggestions.length})
      </div>
      <div className={styles.suggestionsList}>
        {suggestions.map(s => (
          <div key={s.normFio} className={styles.suggestionItem}>
            <span className={styles.suggestionName} title={s.displayFio}>{shortFio(s.displayFio)}</span>
            <span className={styles.suggestionCompany}>{s.company}</span>
            <span className={styles.suggestionTask}>{s.taskType || ''}</span>
            <button className={styles.suggestionAdd} onClick={() => onAdd(s.normFio)}>
              + Добавить
            </button>
          </div>
        ))}
      </div>
      <div className={styles.suggestionsFooter}>
        <button className={styles.suggestionAddAll} onClick={onAddAll}>
          Добавить всех ({suggestions.length})
        </button>
      </div>
    </div>
  )
}

function RollcallModal({ open, onClose, emplMap, liveSnapshot, rollcallPresent, todayExecutorNames, onSave, userRole, userCompanyIds }) {
  const [checks, setChecks] = useState({}) // canonical normFio → bool

  // Build deduplicated list when modal opens
  const deduped = useMemo(() => {
    if (!open) return []

    const allFios = new Map() // normFio -> { displayFio, company }
    for (const [normFio, company] of emplMap) {
      allFios.set(normFio, { displayFio: titleCase(normFio), company: company || '—' })
    }
    for (const [normFio, entry] of liveSnapshot) {
      if (!allFios.has(normFio)) allFios.set(normFio, { displayFio: entry.displayFio, company: '—' })
    }
    for (const normFio of rollcallPresent) {
      if (!allFios.has(normFio)) {
        const displayFio = todayExecutorNames.find(n => normalizeFio(n) === normFio) || titleCase(normFio)
        const company = findByPersonKey(emplMap, normFio) || '—'
        allFios.set(normFio, { displayFio, company })
      }
    }

    // Deduplicate by personKey
    const byPK = new Map()
    for (const [normFio, info] of allFios) {
      const pk = personKey(normFio)
      if (!byPK.has(pk)) byPK.set(pk, [])
      byPK.get(pk).push({ normFio, ...info })
    }

    const result = []
    for (const [, group] of byPK) {
      group.sort((a, b) => b.normFio.length - a.normFio.length)
      const canonical = group[0].normFio
      const displayFio = group[0].displayFio
      const company = group.find(g => g.company !== '—')?.company || group[0].company
      const aliases = group.map(g => g.normFio)
      const isChecked = aliases.some(a => rollcallPresent.has(a))
      result.push({ canonical, displayFio, company, aliases, isChecked })
    }
    return result
  }, [open, emplMap, liveSnapshot, rollcallPresent, todayExecutorNames])

  // Initialize checks when deduped changes
  useEffect(() => {
    const init = {}
    for (const item of deduped) init[item.canonical] = item.isChecked
    setChecks(init)
  }, [deduped])

  const groupedSorted = useMemo(() => {
    const groups = new Map()
    for (const item of deduped) {
      if (!groups.has(item.company)) groups.set(item.company, [])
      groups.get(item.company).push(item)
    }
    let sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))

    // Manager sees only allowed companies
    if (userRole === 'manager' && userCompanyIds?.length > 0) {
      const allowedSet = new Set(userCompanyIds.map(c => String(c).trim().toLowerCase()))
      sorted = sorted.filter(([company]) => allowedSet.has(String(company).trim().toLowerCase()))
    }
    return sorted
  }, [deduped, userRole, userCompanyIds])

  const setGroupAll = (company, val) => {
    const updates = {}
    for (const [c, items] of groupedSorted) {
      if (c === company) {
        for (const item of items) updates[item.canonical] = val
      }
    }
    setChecks(prev => ({ ...prev, ...updates }))
  }

  const setAllGlobal = (val) => {
    const updates = {}
    for (const [, items] of groupedSorted) {
      for (const item of items) updates[item.canonical] = val
    }
    setChecks(updates)
  }

  const handleSave = () => {
    const present = Object.entries(checks)
      .filter(([, v]) => v)
      .map(([k]) => k)
    onSave(present)
  }

  if (!open) return null

  return (
    <div className={`${styles.modalOverlay} ${styles.modalOverlayOpen}`} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modalWindow}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}><ClipboardList size={15} strokeWidth={2} style={{marginRight:6,verticalAlign:'middle'}}/>Перекличка — кто на смене</span>
          <div className={styles.modalHeaderActions}>
            <button className="btn btn-ghost btn-sm" onClick={() => setAllGlobal(true)}>Все</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAllGlobal(false)}>Никого</button>
            <button className={styles.btnIcon} onClick={onClose} title="Закрыть"><X size={16} strokeWidth={2}/></button>
          </div>
        </div>
        <div className={styles.modalBody}>
          {groupedSorted.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>Список сотрудников пуст. Добавьте сотрудников в настройках.</p>
          ) : (
            groupedSorted.map(([company, items]) => (
              <div key={company} className={styles.rcGroup}>
                <div className={styles.rcGroupHeader}>
                  <span className={styles.rcGroupName}>{company}</span>
                  <button className={styles.rcBtnAll} onClick={() => setGroupAll(company, true)}>Все</button>
                  <button className={styles.rcBtnNone} onClick={() => setGroupAll(company, false)}>Никого</button>
                </div>
                <div className={styles.rcGroupRows}>
                  {[...items].sort((a, b) => a.displayFio.localeCompare(b.displayFio)).map(item => (
                    <label key={item.canonical} className={styles.rcRow}>
                      <input
                        type="checkbox"
                        className={styles.rcCheck}
                        checked={!!checks[item.canonical]}
                        onChange={e => setChecks(prev => ({ ...prev, [item.canonical]: e.target.checked }))}
                      />
                      <span title={item.displayFio}>{shortFio(item.displayFio)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
        <div className={styles.modalFooter}>
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}

function EmployeeEditModal({ modal, onClose, onSave, emplCompanies }) {
  const [company, setCompany] = useState('')
  const [onShift, setOnShift] = useState(false)

  useEffect(() => {
    if (modal) {
      setCompany(modal.company === '—' ? '' : (modal.company || ''))
      setOnShift(!!modal.onShift)
    }
  }, [modal])

  if (!modal) return null

  const handleSave = () => onSave({ company, onShift })

  return (
    <div className={`${styles.modalOverlay} ${styles.modalOverlayOpen}`} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`${styles.modalWindow} ${styles.modalWindowSm}`}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>Сотрудник</span>
          <button className={styles.btnIcon} onClick={onClose} title="Закрыть"><X size={16} strokeWidth={2}/></button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.settingRow}>
            <label className={styles.settingLabel}>ФИО</label>
            <div className={styles.settingDesc}>{modal.displayFio || modal.normFio || '—'}</div>
          </div>
          <div className={styles.settingRow}>
            <label className={styles.settingLabel} htmlFor="empl-edit-company">Компания</label>
            <select
              id="empl-edit-company"
              className={styles.formControl}
              style={{ maxWidth: 220 }}
              value={company}
              onChange={e => setCompany(e.target.value)}
            >
              <option value="">— не указана —</option>
              {emplCompanies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className={styles.settingRow}>
            <label className={styles.settingLabel}>На смене</label>
            <label className={styles.checkboxLabel}>
              <input type="checkbox" checked={onShift} onChange={e => setOnShift(e.target.checked)} />
              <span>На смене</span>
            </label>
            <span className={styles.settingDesc} style={{ marginLeft: 8 }}>Снять — «Нет на смене»</span>
          </div>
        </div>
        <div className={styles.modalFooter}>
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Вернуть дату и смену для текущего момента в московском времени (UTC+3).
 * Ночная смена: 21:00 дня D → 09:00 дня D+1.
 * После полуночи (00:00–08:59 МСК) текущая смена — ночная смена ВЧЕРАШНЕЙ московской даты. */
function getCurrentShiftInfo() {
  const MOSCOW_MS = 3 * 60 * 60 * 1000
  const moscow = new Date(Date.now() + MOSCOW_MS)
  const h = moscow.getUTCHours()                    // час по Москве
  const todayMsk = moscow.toISOString().slice(0, 10) // дата по Москве

  if (h >= 9 && h < 21) return { dateStr: todayMsk, shift: 'day' }
  if (h >= 21)           return { dateStr: todayMsk, shift: 'night' }
  // 00:00–08:59 МСК — смена началась вчера в 21:00
  const prev = new Date(moscow.getTime() - 24 * 60 * 60 * 1000)
  return { dateStr: prev.toISOString().slice(0, 10), shift: 'night' }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MonitorPage() {
  const { emplMap, emplCompanies, loadEmployees } = useApp()
  const { user } = useAuth()

  // ── Refs (mutable, no re-render on change) ───────────────────────────────
  const absentStateRef        = useRef(new Map())
  const lastLiveSnapshotRef   = useRef(new Map())
  const executorIdCacheRef    = useRef(new Map())
  const lastCompletedAtRef    = useRef(new Map())
  const rollcallShiftKeyRef   = useRef(null)
  const rollcallPresentRef    = useRef(new Set())
  const allItemsRef           = useRef([])

  // ── Local items for current shift (не зависит от выбранной даты в AppContext) ──
  const [monitorItems, setMonitorItems] = useState([])
  useEffect(() => { allItemsRef.current = monitorItems }, [monitorItems])

  const loadMonitorItems = useCallback(async () => {
    try {
      const { dateStr, shift } = getCurrentShiftInfo()
      const res = await api.getDateItems(dateStr, { shift })
      setMonitorItems(res.items || [])
    } catch { /* ignore, will retry on next refresh */ }
  }, [])

  // ── State (triggers re-render) ────────────────────────────────────────────
  const [rollcallPresent, setRollcallPresent]             = useState(() => new Set())
  const [liveSnapshot, setLiveSnapshot]                   = useState(() => new Map())
  const [absentSnapshot, setAbsentSnapshot]               = useState(() => new Map())
  const [lastCompletedAtSnapshot, setLastCompletedAtSnapshot] = useState(() => new Map())
  const [error, setError]         = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [expandedCompanies, setExpandedCompanies] = useState(() => new Set())
  const [rollcallOpen, setRollcallOpen] = useState(false)
  const [employeeModal, setEmployeeModal] = useState(null)

  // Keep ref in sync with state
  useEffect(() => { rollcallPresentRef.current = rollcallPresent }, [rollcallPresent])

  // ── Load executor ID cache from localStorage ─────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem(EXECUTOR_ID_CACHE_KEY)
      if (saved) {
        const cache = executorIdCacheRef.current
        for (const [k, v] of Object.entries(JSON.parse(saved))) cache.set(k, v)
      }
    } catch {}
  }, [])

  const saveExecutorIdCache = useCallback(() => {
    try {
      localStorage.setItem(EXECUTOR_ID_CACHE_KEY, JSON.stringify(Object.fromEntries(executorIdCacheRef.current)))
    } catch {}
  }, [])

  // ── Today executor names — из items текущей смены ─────────────────────────
  const todayExecutorNames = useMemo(() =>
    [...new Set(monitorItems.map(i => i.executor).filter(Boolean))],
    [monitorItems]
  )

  // ── Load rollcall ──────────────────────────────────────────────────────────
  const loadRollcall = useCallback(async () => {
    try {
      const data = await api.getRollcall()
      const { dateStr, shift } = getCurrentShiftInfo()
      const currentShiftKey = `${dateStr}_${shift}`
      // Если перекличка от другой смены — не загружаем, чтобы не показывать вчерашних людей
      if (data.shiftKey && data.shiftKey !== currentShiftKey) {
        rollcallShiftKeyRef.current = null
        rollcallPresentRef.current = new Set()
        setRollcallPresent(new Set())
        return new Set()
      }
      const present = new Set((data.present || []).map(f => normalizeFio(f)))
      rollcallShiftKeyRef.current = data.shiftKey || null
      rollcallPresentRef.current = present
      setRollcallPresent(present)
      return present
    } catch {
      return new Set()
    }
  }, [])

  // ── doRender: apply absent state to refs and push to state ────────────────
  const doRender = useCallback((snapshot) => {
    applyAbsentState(snapshot, rollcallPresentRef.current, absentStateRef, lastLiveSnapshotRef)
    setLiveSnapshot(new Map(snapshot))
    setAbsentSnapshot(new Map(absentStateRef.current))
    setLastCompletedAtSnapshot(new Map(lastCompletedAtRef.current))
    setLastUpdated(new Date().toISOString())
  }, [])

  // ── refreshMonitor ─────────────────────────────────────────────────────────
  const doRefresh = useCallback(async () => {
    setError(null)
    // Обновляем items для текущей смены (с правильной датой, включая переход через полночь)
    await loadMonitorItems()
    let snapshot
    try {
      const token = getStoredToken()
      const data = token
        ? await api.getLiveMonitorViaBrowser(token)
        : await api.getLiveMonitor()
      if (data?.error) throw new Error(data.error)
      snapshot = parseLiveData(data || {})
    } catch (err) {
      setError('Ошибка загрузки live-данных: ' + err.message)
      snapshot = new Map(lastLiveSnapshotRef.current)
    }

    const token = getStoredToken()
    const rollcall = rollcallPresentRef.current

    if (token && rollcall.size > 0) {
      // Update executor ID cache from live snapshot + items
      let cacheChanged = false
      const cache = executorIdCacheRef.current
      for (const [norm, entry] of snapshot) {
        if (entry.userId && !cache.has(norm)) { cache.set(norm, entry.userId); cacheChanged = true }
      }
      const items = allItemsRef.current
      for (const item of items) {
        if (!item.executorId) continue
        const norm = normalizeFio(item.executor)
        if (norm && !cache.has(norm)) { cache.set(norm, item.executorId); cacheChanged = true }
      }
      if (cacheChanged) saveExecutorIdCache()

      // Shift start (в московском времени UTC+3)
      const now = new Date()
      const toIso = now.toISOString()
      const MOSCOW_MS = 3 * 60 * 60 * 1000
      const moscow = new Date(now.getTime() + MOSCOW_MS)
      const hMsk = moscow.getUTCHours()
      let shiftStart
      if (hMsk >= 9 && hMsk < 21) {
        // Дневная смена: сегодня 09:00 МСК = 06:00 UTC
        const d = moscow.toISOString().slice(0, 10)
        shiftStart = new Date(d + 'T06:00:00.000Z') // 09:00 МСК
      } else {
        // Ночная смена: 21:00 МСК = 18:00 UTC
        const base = hMsk < 9
          ? new Date(moscow.getTime() - 24 * 60 * 60 * 1000) // вчера
          : moscow
        const d = base.toISOString().slice(0, 10)
        shiftStart = new Date(d + 'T18:00:00.000Z') // 21:00 МСК
      }
      const fromShift = shiftStart.toISOString()

      // Build itemsCompletedAt
      const itemsCompletedAt = new Map()
      for (const item of items) {
        const at = item.completedAt
        if (!at) continue
        const norm = normalizeFio(item.executor)
        const ts = new Date(at).getTime()
        if (!itemsCompletedAt.has(norm) || itemsCompletedAt.get(norm) < ts) itemsCompletedAt.set(norm, ts)
      }

      const prevQueries = new Map(lastCompletedAtRef.current)
      lastCompletedAtRef.current = new Map()

      const hasAnyData = (normFio) =>
        findByPersonKey(itemsCompletedAt, normFio) != null ||
        findByPersonKey(prevQueries, normFio) != null

      const noDataGroup = []
      const hasDataGroup = []
      for (const normFio of rollcall) {
        if (findByPersonKey(cache, normFio)) {
          ;(hasAnyData(normFio) ? hasDataGroup : noDataGroup).push(normFio)
        }
      }

      // First pass: no-data group
      for (const normFio of noDataGroup) {
        const executorId = findByPersonKey(cache, normFio)
        try {
          const res = await api.fetchLastCompletedForExecutor(token, executorId, fromShift, toIso)
          if (res.maxCompletedAt != null) lastCompletedAtRef.current.set(normFio, res.maxCompletedAt)
        } catch { /* one failure shouldn't break the whole monitor */ }
      }

      // Intermediate render
      if (noDataGroup.length > 0) {
        doRender(snapshot)
      }

      // Second pass: has-data group
      for (const normFio of hasDataGroup) {
        const executorId = findByPersonKey(cache, normFio)
        try {
          const res = await api.fetchLastCompletedForExecutor(token, executorId, fromShift, toIso)
          if (res.maxCompletedAt != null) lastCompletedAtRef.current.set(normFio, res.maxCompletedAt)
        } catch { /* one failure shouldn't break the whole monitor */ }
      }
    } else {
      lastCompletedAtRef.current = new Map()
    }

    doRender(snapshot)
  }, [doRender, saveExecutorIdCache, loadMonitorItems])

  // ── Polling interval ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(doRefresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [doRefresh])

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    loadRollcall().then(() => doRefresh())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Compute rows for rendering ─────────────────────────────────────────────
  const { rows, groups, suggestions } = useMemo(() => {
    const now = Date.now()

    // Last completed at: merge items + point queries
    const lastCompletedAtMap = new Map()
    for (const item of monitorItems) {
      const at = item.completedAt
      if (!at) continue
      const norm = normalizeFio(item.executor)
      const ts = new Date(at).getTime()
      if (!lastCompletedAtMap.has(norm) || lastCompletedAtMap.get(norm) < ts) {
        lastCompletedAtMap.set(norm, ts)
      }
    }
    for (const normFio of rollcallPresent) {
      const fromQuery = findByPersonKey(lastCompletedAtSnapshot, normFio)
      if (fromQuery != null) lastCompletedAtMap.set(normFio, fromQuery)
    }

    // SZ by norm FIO
    const szByNorm = new Map()
    for (const item of monitorItems) {
      const norm = normalizeFio(item.executor)
      if (!norm) continue
      const type = (item.operationType || '').toUpperCase()
      // PICK_BY_LINE — КДК, дедупликация по исполнителю+ячейке+номенклатуре
      // PALLET_SELECTION_MOVE_TO_PICK_BY_LINE — Паллет, дедупликация по id
      // PIECE_SELECTION_PICKING — ХР, дедупликация по id
      const key = type === 'PICK_BY_LINE'
        ? `kdk|${item.executorId || ''}|${item.cell || ''}|${item.nomenclatureCode || item.productName || ''}`
        : (item.id ? `op|${item.id}` : `op|${item.completedAt || ''}|${item.executor || ''}|${item.cell || ''}`)
      if (!szByNorm.has(norm)) szByNorm.set(norm, new Set())
      szByNorm.get(norm).add(key)
    }

    // Deduplicate rollcall by personKey
    const byPersonKey = new Map()
    for (const normFio of rollcallPresent) {
      const key = personKey(normFio)
      if (!byPersonKey.has(key)) byPersonKey.set(key, [])
      byPersonKey.get(key).push(normFio)
    }
    const rollcallDeduped = []
    for (const [, aliases] of byPersonKey) {
      const inLive = aliases.find(a => liveSnapshot.has(a))
      const canonical = inLive || aliases.sort((a, b) => b.length - a.length)[0]
      rollcallDeduped.push({ canonical, aliases })
    }

    // Build rows
    const computedRows = []
    for (const { canonical, aliases } of rollcallDeduped) {
      const liveEntry = aliases.map(a => liveSnapshot.get(a)).find(Boolean)
      const isActive = !!liveEntry
      const company = findByPersonKey(emplMap, canonical) || aliases.map(a => findByPersonKey(emplMap, a)).find(Boolean) || '—'
      const state = absentSnapshot.get(canonical) || aliases.map(a => absentSnapshot.get(a)).find(Boolean) || { absentSince: null, wasAbsentMs: null }

      let lastTs = null
      for (const a of aliases) {
        const t = findByPersonKey(lastCompletedAtMap, a)
        if (t != null && (lastTs == null || t > lastTs)) lastTs = t
      }
      const minutesSinceLastTask = lastTs != null ? (now - lastTs) / 60000 : null
      const lastTaskMs = lastTs != null ? now - lastTs : null
      const inWorkByTask = minutesSinceLastTask != null && minutesSinceLastTask <= IDLE_WORK_MIN

      const taskDurationMs = (isActive && liveEntry?.startedAt)
        ? now - new Date(liveEntry.startedAt).getTime()
        : null

      const wasAbsentMs = (isActive && state.wasAbsentMs && state.wasAbsentMs > 60000)
        ? state.wasAbsentMs
        : null

      const displayFio = liveEntry?.displayFio || titleCase(canonical)
      const sz = aliases.reduce((s, a) => s + (findByPersonKey(szByNorm, a)?.size || 0), 0)

      computedRows.push({
        normFio: canonical,
        displayFio,
        company,
        isActive,
        aliases,
        sz,
        taskType: liveEntry?.taskType || null,
        startedAt: liveEntry?.startedAt || null,
        taskDurationMs,
        idleMs: (!isActive && state.absentSince) ? now - state.absentSince : null,
        wasAbsentMs,
        lastTaskMs,
        minutesSinceLastTask,
        inWorkByTask,
      })
    }

    // Group by company
    const byCompany = new Map()
    for (const row of computedRows) {
      const c = row.company
      if (!byCompany.has(c)) byCompany.set(c, { company: c, rows: [], active: 0, inactive: 0 })
      const g = byCompany.get(c)
      g.rows.push(row)
      if (row.inWorkByTask) g.active++; else g.inactive++
    }

    // Sort groups
    const computedGroups = [...byCompany.values()].sort((a, b) => {
      if (b.inactive !== a.inactive) return b.inactive - a.inactive
      return a.company.localeCompare(b.company)
    })

    // Sort rows within each group
    for (const g of computedGroups) {
      g.rows.sort((a, b) => {
        const aMin = a.minutesSinceLastTask
        const bMin = b.minutesSinceLastTask
        if (aMin != null && bMin != null && aMin !== bMin) return bMin - aMin
        if (aMin != null && bMin == null) return -1
        if (aMin == null && bMin != null) return 1
        return (b.idleMs || 0) - (a.idleMs || 0)
      })
    }

    // Compute suggestions
    const suggestionsOut = []
    const seenPKs = new Set()
    const rollcallPKs = new Set([...rollcallPresent].map(personKey))

    for (const [normFio, entry] of liveSnapshot) {
      const pk = personKey(normFio)
      if (rollcallPKs.has(pk) || seenPKs.has(pk)) continue
      seenPKs.add(pk)
      const company = findByPersonKey(emplMap, normFio) || '—'
      suggestionsOut.push({ normFio, displayFio: entry.displayFio, company, taskType: entry.taskType })
    }

    const executorSource = monitorItems.length > 0
      ? monitorItems.map(i => i.executor).filter(Boolean)
      : todayExecutorNames
    const seenExecutors = new Set()
    for (const executor of executorSource) {
      if (!executor || seenExecutors.has(executor)) continue
      seenExecutors.add(executor)
      const normFio = normalizeFio(executor)
      const pk = personKey(normFio)
      if (rollcallPKs.has(pk) || seenPKs.has(pk)) continue
      seenPKs.add(pk)
      const company = findByPersonKey(emplMap, normFio) || '—'
      suggestionsOut.push({ normFio, displayFio: executor, company, taskType: null })
    }

    return { rows: computedRows, groups: computedGroups, suggestions: suggestionsOut }
  }, [rollcallPresent, liveSnapshot, absentSnapshot, lastCompletedAtSnapshot, monitorItems, emplMap, todayExecutorNames])

  // ── Rollcall handlers ──────────────────────────────────────────────────────
  const handleRollcallSave = useCallback(async (present) => {
    const { dateStr, shift } = getCurrentShiftInfo()
    const shiftKey = rollcallShiftKeyRef.current || `${dateStr}_${shift}`
    const presentSet = new Set(present)

    // Clear absent state for removed people
    for (const [normFio] of absentStateRef.current) {
      if (!hasByPersonKey(presentSet, normFio)) absentStateRef.current.delete(normFio)
    }

    rollcallShiftKeyRef.current = shiftKey
    rollcallPresentRef.current = presentSet
    setRollcallPresent(presentSet)
    setRollcallOpen(false)

    try {
      await api.putRollcall(shiftKey, present)
    } catch { /* work locally */ }

    doRefresh()
  }, [doRefresh])

  // ── Add to rollcall (from suggestions) ────────────────────────────────────
  const handleAddSuggestion = useCallback(async (normFio) => {
    const present = [...rollcallPresentRef.current]
    if (!present.includes(normFio)) present.push(normFio)
    const presentSet = new Set(present)
    rollcallPresentRef.current = presentSet
    setRollcallPresent(presentSet)
    const { dateStr, shift } = getCurrentShiftInfo()
    const shiftKey = rollcallShiftKeyRef.current || `${dateStr}_${shift}`
    try { await api.putRollcall(shiftKey, present) } catch {}
    doRefresh()
  }, [doRefresh])

  const handleAddAllSuggestions = useCallback(async () => {
    const present = [...rollcallPresentRef.current]
    for (const s of suggestions) {
      if (!present.includes(s.normFio)) present.push(s.normFio)
    }
    const presentSet = new Set(present)
    rollcallPresentRef.current = presentSet
    setRollcallPresent(presentSet)
    const { dateStr, shift } = getCurrentShiftInfo()
    const shiftKey = rollcallShiftKeyRef.current || `${dateStr}_${shift}`
    try { await api.putRollcall(shiftKey, present) } catch {}
    doRefresh()
  }, [suggestions, doRefresh])

  // ── Employee modal handlers ────────────────────────────────────────────────
  const handleRowClick = useCallback((row) => {
    setEmployeeModal({
      displayFio: row.displayFio,
      normFio: row.normFio,
      company: row.company,
      onShift: hasByPersonKey(rollcallPresentRef.current, row.normFio) ||
        (row.aliases && row.aliases.some(a => hasByPersonKey(rollcallPresentRef.current, a))),
      aliases: row.aliases || [row.normFio],
    })
  }, [])

  const handleEmployeeModalSave = useCallback(async ({ company, onShift }) => {
    const row = employeeModal
    if (!row) { setEmployeeModal(null); return }

    const currentCompany = row.company === '—' ? '' : (row.company || '')
    const newCompany = (company || '').trim()
    if (currentCompany !== newCompany) {
      try {
        await api.saveEmplOne(row.displayFio || row.normFio, newCompany)
        await loadEmployees()
      } catch (e) {
        console.error('Сохранение компании', e)
      }
    }

    const aliases = row.aliases || [row.normFio]
    const wasOnShift = hasByPersonKey(rollcallPresentRef.current, row.normFio) ||
      aliases.some(a => hasByPersonKey(rollcallPresentRef.current, a))

    if (onShift !== wasOnShift) {
      let present = [...rollcallPresentRef.current]
      if (onShift) {
        for (const a of aliases) { if (!present.includes(a)) present.push(a) }
      } else {
        present = present.filter(p => !aliases.includes(p))
      }
      const presentSet = new Set(present)
      rollcallPresentRef.current = presentSet
      setRollcallPresent(presentSet)
      const { dateStr: _d, shift: _s } = getCurrentShiftInfo()
      try { await api.putRollcall(rollcallShiftKeyRef.current || `${_d}_${_s}`, present) } catch {}
      await loadRollcall()
    }

    setEmployeeModal(null)
    doRefresh()
  }, [employeeModal, loadEmployees, loadRollcall, doRefresh])

  // ── Toggle company expand ─────────────────────────────────────────────────
  const handleToggleCompany = useCallback((company) => {
    setExpandedCompanies(prev => {
      const next = new Set(prev)
      if (next.has(company)) next.delete(company)
      else next.add(company)
      return next
    })
  }, [])

  // ── Rollcall info text ─────────────────────────────────────────────────────
  const rollcallInfoText = rollcallPresent.size > 0
    ? `${rollcallPresent.size} чел. на смене`
    : ''

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.mainContent}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <button className="btn btn-primary" onClick={() => setRollcallOpen(true)}>
            <ClipboardList size={14} strokeWidth={2} style={{marginRight:6}}/>Перекличка
          </button>
          {rollcallInfoText && (
            <span className={styles.mutedText}>{rollcallInfoText}</span>
          )}
        </div>
        <div className={styles.toolbarRight}>
          <button className="btn btn-secondary" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={doRefresh}>
            <RefreshCw size={14} strokeWidth={2}/>Обновить
          </button>
          {lastUpdated && (
            <span className={styles.mutedText}>Обновлено: {formatTime(lastUpdated)}</span>
          )}
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      {rollcallPresent.size === 0 ? (
        <>
          <SuggestionsSection
            suggestions={suggestions}
            onAdd={handleAddSuggestion}
            onAddAll={handleAddAllSuggestions}
          />
          <div className={styles.monitorEmpty}>
            Перекличка не проведена.<br />
            Нажмите <strong>«Перекличка»</strong> чтобы отметить сотрудников на смене.
          </div>
        </>
      ) : (
        <>
          <SuggestionsSection
            suggestions={suggestions}
            onAdd={handleAddSuggestion}
            onAddAll={handleAddAllSuggestions}
          />
          <OperationSummary rows={rows} />
          {groups.map(g => (
            <CompanyCard
              key={g.company}
              g={g}
              isExpanded={expandedCompanies.has(g.company)}
              onToggle={() => handleToggleCompany(g.company)}
              onRowClick={handleRowClick}
            />
          ))}
        </>
      )}

      <RollcallModal
        open={rollcallOpen}
        onClose={() => setRollcallOpen(false)}
        emplMap={emplMap}
        liveSnapshot={liveSnapshot}
        rollcallPresent={rollcallPresent}
        todayExecutorNames={todayExecutorNames}
        onSave={handleRollcallSave}
        userRole={user?.role}
        userCompanyIds={user?.companyIds}
      />

      <EmployeeEditModal
        modal={employeeModal}
        onClose={() => setEmployeeModal(null)}
        onSave={handleEmployeeModalSave}
        emplCompanies={emplCompanies}
      />
    </div>
  )
}
