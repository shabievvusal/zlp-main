import { useCallback, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getLiveMonitorViaBrowser, fetchLastKdkCompletedForExecutor } from '../../api/index.js'
import { useAuth } from '../../context/AuthContext.jsx'
import { useApp } from '../../context/AppContext.jsx'
import { getCompanyByFio, normalizeFio } from '../../utils/emplUtils.js'
import { formatTime, shortFio } from '../../utils/format.js'
import s from './KdkLayoutPage.module.css'

const IDLE_LIMIT_MS = 5 * 60 * 1000

function fullName(user) {
  if (!user) return ''
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ').trim()
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
  return `${min} мин назад`
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
    const eo = firstValue(entry, [
      'handlingUnitBarcode',
      'sourceHandlingUnitBarcode',
      'targetHandlingUnitBarcode',
      'sourceAddress.handlingUnitBarcode',
      'targetAddress.handlingUnitBarcode',
    ])
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
      key: `${executorId || executor}-${task}-${index}`,
      task,
      company,
      executor,
      executorId,
      eo,
      pieces,
      startedAt: entry.startedAt || null,
      lastPickAt: null,
      raw: entry,
    }
  })
}

export default function KdkLayoutPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const { emplMap, emplIdMap } = useApp()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState('')

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
      const live = await getLiveMonitorViaBrowser(token)
      const baseRows = parseKdkRows(live, emplMap, emplIdMap)
      const enriched = await Promise.all(baseRows.map(async row => {
        if (!row.executorId) return row
        try {
          const res = await fetchLastKdkCompletedForExecutor(token, row.executorId)
          const lastPickAt = res.maxCompletedAt ? new Date(res.maxCompletedAt).toISOString() : null
          return {
            ...row,
            pieces: res.remainingPieces ?? row.pieces,
            lastPickAt,
            idle: lastPickAt ? Date.now() - new Date(lastPickAt).getTime() > IDLE_LIMIT_MS : false,
          }
        } catch {
          return row
        }
      }))
      setRows(enriched)
      setLastUpdated(new Date().toISOString())
    } catch (err) {
      setRows([])
      setError(err.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [emplIdMap, emplMap, forceRefresh, getToken, isTokenValid])

  const sorted = useMemo(() => (
    [...rows].sort((a, b) =>
      (a.company || '').localeCompare(b.company || '', 'ru') ||
      (a.executor || '').localeCompare(b.executor || '', 'ru')
    )
  ), [rows])

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Раскладка КДК</h1>
          <div className={s.subtitle}>Кто сейчас в КДК-задаче, остаток и последний пик за смену</div>
        </div>
        <div className={s.meta}>{lastUpdated ? `Обновлено: ${formatTime(lastUpdated)}` : 'Данные не загружены'}</div>
      </div>

      <div className={s.toolbar}>
        <button type="button" className="btn btn-primary" onClick={load} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {loading ? 'Загрузка...' : 'Обновить'}
        </button>
        <span className={s.meta}>Автообновление можно подключить после проверки запроса</span>
      </div>

      {error && <div className={s.empty}>{error}</div>}

      <div className={s.card}>
        {!loading && !rows.length && !error && <div className={s.empty}>Нажмите «Обновить», чтобы проверить текущие КДК-задачи</div>}
        {loading && <div className={s.empty}>Загрузка КДК-задач...</div>}
        {!loading && rows.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Задача</th>
                  <th>Компания</th>
                  <th>Исполнитель</th>
                  <th className={s.num}>ЕО</th>
                  <th className={s.num}>Шт</th>
                  <th>Последний пик</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(row => (
                  <tr key={row.key} className={row.idle ? s.rowIdle : ''}>
                    <td>{row.task}</td>
                    <td>{row.company}</td>
                    <td title={row.executor}>{shortFio(row.executor)}</td>
                    <td className={s.num}>{fmtNum(row.eo)}</td>
                    <td className={s.num}>{fmtNum(row.pieces)}</td>
                    <td>
                      {row.lastPickAt ? (
                        <span className={row.idle ? s.idleText : ''}>
                          {formatTime(row.lastPickAt)}
                          <span className={s.muted}> · {fmtAgo(row.lastPickAt)}</span>
                        </span>
                      ) : '—'}
                    </td>
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
