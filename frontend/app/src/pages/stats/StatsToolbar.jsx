import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../context/AppContext.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import { getTodayStr, formatDateTime } from '../../utils/format.js'
import { ChevronDown, RefreshCw, Radio, RotateCcw } from 'lucide-react'
import DatePicker from '../../components/ui/DatePicker.jsx'
import styles from './StatsPage.module.css'

const STATS_OPERATIONS = [
  { key: 'selection', label: 'Комплектация' },
  { key: 'placement', label: 'Размещение' },
  { key: 'receiving', label: 'Приёмка' },
  { key: 'remains', label: 'Остатки' },
]

export default function StatsToolbar() {
  const {
    selectedDate, setSelectedDate,
    shiftFilter, setShiftFilter,
    statsOperation, setStatsOperation,
    fetchHourFrom, setFetchHourFrom,
    fetchHourTo, setFetchHourTo,
    loading,
    runFetchData, doRequestFetch,
    engineNote, autoFetchEnabled,
    status,
  } = useApp()
  const { user } = useAuth()
  const canFetch   = user?.actions?.includes('fetch_data')
  const canRecheck = user?.actions?.includes('recheck_data')
  const canRequest = user?.actions?.includes('request_fetch')

  const [fetchLabel, setFetchLabel] = useState(null)
  const [fetchDisabled, setFetchDisabled] = useState(false)
  const [recheckDisabled, setRecheckDisabled] = useState(false)
  const [operationOpen, setOperationOpen] = useState(false)
  const operationRef = useRef(null)
  const activeOperation = STATS_OPERATIONS.find(op => op.key === statsOperation) || STATS_OPERATIONS[0]

  useEffect(() => {
    if (!operationOpen) return
    function onPointerDown(e) {
      if (operationRef.current && !operationRef.current.contains(e.target)) setOperationOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [operationOpen])

  const handleFetch = async () => {
    setFetchLabel('Загрузка...')
    setFetchDisabled(true)
    try { await runFetchData(false) } catch { /* notify уже показан в AppContext */ }
    setFetchLabel(null)
    setFetchDisabled(false)
  }

  const handleRecheck = async () => {
    setRecheckDisabled(true)
    try { await runFetchData(true) } catch { /* notify уже показан */ }
    setRecheckDisabled(false)
  }

  const handleRequestFetch = () => doRequestFetch()

  return (
    <div className={styles.toolbar}>
      <div className={styles.shiftSelectWrap}>
        <label>Дата:</label>
        <DatePicker
          value={selectedDate}
          max={getTodayStr()}
          onChange={e => setSelectedDate(e.target.value)}
        />
      </div>

      <div className={styles.shiftToggleWrap}>
        <span className={styles.shiftToggleLabel}>Смена:</span>
        <button
          className={`${styles.filterChip} ${shiftFilter === 'day' ? styles.filterChipActive : ''}`}
          onClick={() => setShiftFilter('day')}
        >
          День (9–21)
        </button>
        <button
          className={`${styles.filterChip} ${shiftFilter === 'night' ? styles.filterChipActive : ''}`}
          onClick={() => setShiftFilter('night')}
        >
          Ночь (21–9)
        </button>
      </div>

      <div className={styles.operationToggleWrap} ref={operationRef}>
        <span className={styles.shiftToggleLabel}>Операция:</span>
        <button
          type="button"
          className={styles.operationMenuButton}
          onClick={() => setOperationOpen(v => !v)}
          aria-haspopup="menu"
          aria-expanded={operationOpen}
        >
          <span>{activeOperation.label}</span>
          <ChevronDown size={14} strokeWidth={2} />
        </button>
        {operationOpen && (
          <div className={styles.operationMenu} role="menu">
            {STATS_OPERATIONS.map(op => (
              <button
                key={op.key}
                type="button"
                className={`${styles.operationMenuItem} ${statsOperation === op.key ? styles.operationMenuItemActive : ''}`}
                onClick={() => {
                  if (op.disabled) return
                  setStatsOperation(op.key)
                  setOperationOpen(false)
                }}
                disabled={op.disabled}
                role="menuitem"
              >
                {op.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.fetchRangeWrap}>
        <label htmlFor="fetch-hour-from">Выгрузить с</label>
        <input
          type="number"
          id="fetch-hour-from"
          className={styles.fetchHourInput}
          min="0" max="23"
          value={fetchHourFrom}
          onChange={e => setFetchHourFrom(Number(e.target.value))}
          title="Час начала (0–23)"
        />
        <label htmlFor="fetch-hour-to">до</label>
        <input
          type="number"
          id="fetch-hour-to"
          className={styles.fetchHourInput}
          min="0" max="23"
          value={fetchHourTo}
          onChange={e => setFetchHourTo(Number(e.target.value))}
          title="Час конца (исключительно, 0–23)"
        />
        <span className={styles.mutedText} style={{ marginLeft: 4 }}>ч</span>
      </div>

      <div className={styles.toolbarRight}>
        {status?.lastRun && (
          <span className={styles.mutedText} title="Последнее обновление статистики">
            Обновлено: {formatDateTime(status.lastRun)}
          </span>
        )}

        {canFetch && (
          <button
            className="btn btn-primary"
            onClick={handleFetch}
            disabled={fetchDisabled || loading}
            style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}
          >
            <RefreshCw size={14} strokeWidth={2} />
            {fetchLabel || 'Обновить данные'}
          </button>
        )}

        {canRequest && !autoFetchEnabled && (
          <button
            className="btn btn-secondary"
            onClick={handleRequestFetch}
            title="Попросить корп. устройство обновить данные"
            style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}
          >
            <Radio size={14} strokeWidth={2} />
            Запросить обновление
          </button>
        )}

        {canRecheck && (
          <button
            type="button"
            className="btn btn-secondary btn-square"
            title="Перепроверить данные с указанного часа"
            onClick={handleRecheck}
            disabled={recheckDisabled || loading}
          >
            <RotateCcw size={15} strokeWidth={2} />
          </button>
        )}

        {engineNote && (
          <span className={styles.mutedText}>{engineNote}</span>
        )}
      </div>
    </div>
  )
}
