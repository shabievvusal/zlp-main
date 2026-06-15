import { useCallback, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAuth } from '../../context/AuthContext.jsx'
import { getPieceSelectionTasks } from '../../api/index.js'
import DatePicker from '../../components/ui/DatePicker.jsx'
import s from './PieceSelectionPage.module.css'

const PAGE_SIZE = 100
const DEFAULT_STATUSES = ['CREATED', 'PENDING', 'IN_PROGRESS', 'COMPLETED']

const TEMP_LABELS = {
  LOW_COLD: 'Низкий холод',
  MEDIUM_COLD: 'Средний холод',
  ORDINARY: 'Сухой',
}

const STATUS_LABELS = {
  CREATED: 'Новое',
  PENDING: 'Ждёт отбора',
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

const SORT_FIELDS = {
  cells: 'sourceCellsCount',
  weight: 'weightInGrams',
  volume: 'volumeInMilliliters',
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function tomorrowStr() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

function dateToApiFrom(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  return new Date(`${y}-${m}-${d}T00:00:00+03:00`).toISOString()
}

function dateToApiTo(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  return new Date(`${y}-${m}-${d}T23:59:59.999+03:00`).toISOString()
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

export default function PieceSelectionPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const [dateFrom, setDateFrom] = useState(todayStr)
  const [dateTo, setDateTo] = useState(tomorrowStr)
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
        dateFrom: dateToApiFrom(dateFrom),
        dateTo: dateToApiTo(dateTo),
        pageSize: PAGE_SIZE,
        status: status ? [status] : DEFAULT_STATUSES,
        sourceZoneId: zoneId || null,
        shipmentTemperatureMode: temperatureMode || null,
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
  }, [dateFrom, dateTo, forceRefresh, getToken, isTokenValid, status, temperatureMode, zoneId])

  const filtered = useMemo(() => {
    const list = rows || []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(row => [
      row.shipTo?.name,
      row.shipTo?.address,
      row.sourceZone?.name,
      ...(row.shipmentNumbers || []),
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
          <div className={s.subtitle}>Задания комплектации по магазинам, зонам и отгрузкам</div>
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
          placeholder="Поиск по магазину, адресу, зоне, отгрузке"
        />
        <DatePicker value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <DatePicker value={dateTo} onChange={e => setDateTo(e.target.value)} />
        <select className={s.select} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Все статусы</option>
          {DEFAULT_STATUSES.map(value => (
            <option key={value} value={value}>{STATUS_LABELS[value] || value}</option>
          ))}
        </select>
        <select className={s.select} value={zoneId} onChange={e => setZoneId(e.target.value)}>
          <option value="">Все зоны</option>
          {ZONE_OPTIONS.map(zone => (
            <option key={zone.label} value={zone.id} disabled={zone.disabled}>{zone.label}</option>
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
                    <th>Дата отгрузки</th>
                    <th>Исполнитель</th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map(row => (
                    <tr key={row.id}>
                      <td><span className={statusClass(row.status)}>{STATUS_LABELS[row.status] || row.status || '—'}</span></td>
                      <td>
                        <div>{row.shipTo?.name || '—'}</div>
                        <div className={s.muted}>{row.shipTo?.address || ''}</div>
                      </td>
                      <td className={s.num}>{fmtNum(row.sourceCellsCount)}</td>
                      <td className={s.num}>{fmtKg(row.weightInGrams)}</td>
                      <td className={s.num}>{fmtLiters(row.volumeInMilliliters)}</td>
                      <td>{row.targetHandlingUnitBarcode || '—'}</td>
                      <td>
                        <div>{row.sourceZone?.name || '—'}</div>
                        <div className={s.muted}>{(row.shipmentTemperatureModes || []).map(t => TEMP_LABELS[t] || t).join(', ') || ''}</div>
                      </td>
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
