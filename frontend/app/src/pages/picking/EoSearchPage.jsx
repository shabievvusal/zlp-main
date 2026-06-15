import { useCallback, useState } from 'react'
import { Printer, RefreshCw, Search } from 'lucide-react'
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

const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]

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

function getCode128Codes(value) {
  const text = String(value || '').trim()
  if (!text) return []

  if (/^\d+$/.test(text) && text.length % 2 === 0) {
    const codes = [105]
    for (let i = 0; i < text.length; i += 2) codes.push(Number(text.slice(i, i + 2)))
    let checksum = codes[0]
    for (let i = 1; i < codes.length; i += 1) checksum += codes[i] * i
    return [...codes, checksum % 103, 106]
  }

  const codes = [104]
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 32
    if (code < 0 || code > 95) return []
    codes.push(code)
  }
  let checksum = codes[0]
  for (let i = 1; i < codes.length; i += 1) checksum += codes[i] * i
  return [...codes, checksum % 103, 106]
}

function buildCode128Bars(value) {
  const quiet = 10
  let x = quiet
  const bars = []
  for (const code of getCode128Codes(value)) {
    const pattern = CODE128_PATTERNS[code]
    if (!pattern) continue
    for (let i = 0; i < pattern.length; i += 1) {
      const width = Number(pattern[i])
      if (i % 2 === 0) bars.push({ x, width })
      x += width
    }
  }
  return { bars, width: x + quiet, height: 58 }
}

function Code128Barcode({ value }) {
  const { bars, width, height } = buildCode128Bars(value)
  if (!bars.length) return <div className={s.barcodeError}>Не удалось построить barcode</div>
  return (
    <svg className={s.barcodeSvg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Barcode ${value}`}>
      <rect width={width} height={height} fill="#fff" />
      {bars.map((bar, index) => (
        <rect key={`${bar.x}-${index}`} x={bar.x} y="0" width={bar.width} height="42" fill="#111827" />
      ))}
      <text x={width / 2} y="55" textAnchor="middle" fontSize="8" fontFamily="Arial, sans-serif" fill="#111827">
        {value}
      </text>
    </svg>
  )
}

function printBarcode() {
  const body = document.body
  const cleanup = () => body.classList.remove('eo-printing')
  body.classList.add('eo-printing')
  window.addEventListener('afterprint', cleanup, { once: true })
  window.print()
  window.setTimeout(cleanup, 1500)
}

function schedulePrint() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => printBarcode())
  })
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
  const [printValue, setPrintValue] = useState('')

  const openPrintPreview = useCallback((value) => {
    if (!value) return
    setPrintValue(value)
    schedulePrint()
  }, [])

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

      {printValue && (
        <div className={s.printPanel}>
          <Code128Barcode value={printValue} />
        </div>
      )}

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
                    <td>
                      <button
                        type="button"
                        className={s.eoButton}
                        onClick={() => openPrintPreview(row.match.eoBarcode)}
                        title="Печать barcode 128"
                      >
                        <span>{row.match.eoBarcode || '—'}</span>
                        <Printer size={13} strokeWidth={2} />
                      </button>
                    </td>
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
