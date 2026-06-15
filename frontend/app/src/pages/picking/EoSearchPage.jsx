import { useCallback, useState } from 'react'
import { Search, RefreshCw } from 'lucide-react'
import {
  getInboundTasks,
  getInboundTaskDetail,
  getInboundTaskResponsibleUsers,
  getEoChangeInfo,
} from '../../api/index.js'
import { useAuth } from '../../context/AuthContext.jsx'
import s from './EoSearchPage.module.css'

const PAGE_SIZE = 100

const TYPE_LABELS = {
  IMPORT: 'Умный импорт',
  CROSSDOCK: 'Кросс-докинг',
  STORAGE: 'На хранение от поставщика',
  STORAGE_DC: 'На хранение от РЦ',
}

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function dateToApiFrom(dateStr) {
  return new Date(`${dateStr}T00:00:00+03:00`).toISOString()
}

function dateToApiTo(dateStr) {
  return new Date(`${dateStr}T23:59:59.999+03:00`).toISOString()
}

function qty(val) {
  if (val == null) return null
  if (typeof val === 'number') return val
  return val.pieceProducts ?? val.weightProducts ?? null
}

function fullName(user) {
  if (!user) return '—'
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ') || '—'
}

function typeLabel(type) {
  return TYPE_LABELS[type] || type || '—'
}

function pickAcceptedUser(responsibleUsers = []) {
  const accepted = responsibleUsers.find(u => u.type === 'ACCEPTANCE_COMPLETED')
    ?? responsibleUsers.find(u => u.type === 'ACCEPTANCE_STARTED')
  return accepted?.user || null
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function eoPickStatus(change, receivedQty) {
  if (!change || change.total === 0 || change.remaining === null) return 'Не в работе'
  if (Number(change.remaining) === 0) return 'Скомплектована'
  const picked = Math.max(0, Number(receivedQty || 0) - Number(change.remaining || 0))
  return `Комплектуется${receivedQty ? ` ${Math.round(picked / receivedQty * 100)}%` : ''}`
}

function findProductBarcodeInDetail(detail, barcode) {
  const products = detail?.products || []
  const matches = []
  for (const product of products) {
    const productBarcodes = [
      product.productBarcode,
      ...(Array.isArray(product.barcodes) ? product.barcodes : []),
    ].filter(Boolean).map(String)
    if (!productBarcodes.includes(barcode)) continue
    for (const part of product.parts || []) {
      for (const hu of part.handlingUnits || []) {
        const eoBarcode = hu.handlingUnitBarcode || hu.id || ''
        if (!eoBarcode) continue
        matches.push({
          eoBarcode,
          productName: product.name || '—',
          productBarcode: product.productBarcode || '',
          quantity: qty(hu.actualQuantity) ?? 0,
          productionDate: part.productionDate || '',
          bestBeforeDate: part.bestBeforeDate || '',
        })
      }
    }
  }
  return matches
}

export default function EoSearchPage() {
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const [barcode, setBarcode] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')

  const search = useCallback(async () => {
    const clean = barcode.trim()
    if (!clean) { setError('Введите ШК продукта'); return }

    let token = getToken()
    if (!token || !isTokenValid()) {
      const ok = await forceRefresh()
      if (!ok) { setError('Нет токена WMS. Войдите заново.'); return }
      token = getToken()
    }
    if (!token) { setError('Нет токена WMS. Войдите заново.'); return }

    setLoading(true)
    setError('')
    setRows([])
    setProgress('Загружаю поставки за сегодня...')
    try {
      const today = todayStr()
      const base = {
        dateFrom: dateToApiFrom(today),
        dateTo: dateToApiTo(today),
        pageSize: PAGE_SIZE,
      }
      const first = await getInboundTasks(token, { ...base, pageNumber: 1 })
      const total = first?.value?.total ?? 0
      let supplies = [...(first?.value?.items ?? [])]
      const pages = Math.ceil(total / PAGE_SIZE)
      if (pages > 1) {
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) => getInboundTasks(token, { ...base, pageNumber: i + 2 }))
        )
        for (const r of rest) supplies = supplies.concat(r?.value?.items ?? [])
      }

      const found = []
      for (let i = 0; i < supplies.length; i += 1) {
        const supply = supplies[i]
        setProgress(`Проверяю поставки: ${i + 1} из ${supplies.length}`)
        try {
          const detailRes = await getInboundTaskDetail(token, { taskType: supply.type, id: supply.id })
          const detail = detailRes?.value ?? detailRes
          const matches = findProductBarcodeInDetail(detail, clean)
          if (matches.length === 0) continue

          const responsiblePromise = getInboundTaskResponsibleUsers(token, { taskType: supply.type, id: supply.id }).catch(() => null)
          const changeResults = await Promise.all(matches.map(match =>
            getEoChangeInfo(token, match.eoBarcode).catch(() => null)
          ))
          const responsibleRes = await responsiblePromise
          const acceptedUser = pickAcceptedUser(responsibleRes?.value?.responsibleUsers || [])

          matches.forEach((match, index) => {
            const change = changeResults[index]
            const receivedQty = Number(match.quantity) || 0
            found.push({
              id: `${supply.id}-${match.eoBarcode}-${index}`,
              supply,
              match,
              receivedQty,
              status: eoPickStatus(change, receivedQty),
              remaining: change?.remaining,
              picker: change?.executor,
              acceptedUser,
              lastPickAt: change?.completedAt,
            })
          })
        } catch {
          // Одна проблемная поставка не должна ломать поиск.
        }
      }
      setRows(found)
      setProgress(found.length ? `Найдено ЕО: ${found.length}` : 'Товар не найден в сегодняшних поставках')
    } catch (err) {
      setError(err.message || 'Ошибка поиска')
      setProgress('')
    } finally {
      setLoading(false)
    }
  }, [barcode, forceRefresh, getToken, isTokenValid])

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>Поиск ЕО</h1>
          <div className={s.subtitle}>Введите ШК продукта, чтобы найти его ЕО в сегодняшних поставках</div>
        </div>
      </div>

      <div className={s.toolbar}>
        <div className={s.searchBox}>
          <Search size={14} className={s.searchIcon} />
          <input
            className={s.input}
            value={barcode}
            onChange={e => setBarcode(e.target.value.replace(/\s/g, ''))}
            onKeyDown={e => { if (e.key === 'Enter') search() }}
            placeholder="ШК продукта"
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={search} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} style={{ marginRight: 6 }} />
          {loading ? 'Поиск...' : 'Найти'}
        </button>
        {progress && <span className={s.meta}>{progress}</span>}
      </div>

      {error && <div className={s.empty}>{error}</div>}

      <div className={s.card}>
        {!loading && rows.length === 0 && !error && <div className={s.empty}>Введите ШК продукта и нажмите «Найти»</div>}
        {rows.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Тип поставки</th>
                  <th>Поставка</th>
                  <th>ЕО</th>
                  <th>Статус ЕО</th>
                  <th className={s.num}>Принято</th>
                  <th className={s.num}>Остаток</th>
                  <th>Комплектует</th>
                  <th>Последний пик</th>
                  <th>Принял</th>
                  <th>Товары</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id}>
                    <td>{typeLabel(row.supply.type)}</td>
                    <td>{row.supply.taskNumber || row.supply.id}</td>
                    <td>{row.match.eoBarcode || '—'}</td>
                    <td>{row.status}</td>
                    <td className={s.num}>{row.receivedQty || '—'}</td>
                    <td className={s.num}>{row.remaining ?? '—'}</td>
                    <td>{fullName(row.picker)}</td>
                    <td>{fmtTime(row.lastPickAt)}</td>
                    <td>{fullName(row.acceptedUser)}</td>
                    <td>
                      <div className={s.productLine}>
                        <span>{row.match.productName}</span>
                        {row.match.productBarcode && <span className={s.muted}>ШК {row.match.productBarcode}</span>}
                      </div>
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
