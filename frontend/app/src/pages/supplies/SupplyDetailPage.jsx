import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext.jsx'
import { getInboundTaskDetail, getEoRemaining } from '../../api/index.js'
import { Search, Copy, ChevronDown, ChevronUp, X, Users } from 'lucide-react'
import s from './SupplyDetailPage.module.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  TRANSPORTATION_NOT_ASSIGNED: 'Не привязано',
  AWAITING_GATE:               'Ждёт ворот',
  AWAITING_ACCEPTANCE:         'Ждёт приёмку',
  ACCEPTANCE_IN_PROGRESS:      'Приёмка',
  NOT_VERIFIED:                'Не проверено',
  CANCELLED:                   'Отменено',
  COMPLETED_AS_PLANNED:        'Принято',
  COMPLETED_WITH_DISCREPANCY:  'Расхождения',
  PLANNED:                     'Запланировано',
}

const STATUS_CLASS = {
  COMPLETED_AS_PLANNED:        s.badgeAccepted,
  COMPLETED_WITH_DISCREPANCY:  s.badgeDiscrepancy,
  ACCEPTANCE_IN_PROGRESS:      s.badgeInProgress,
  AWAITING_ACCEPTANCE:         s.badgePlanned,
  AWAITING_GATE:               s.badgePlanned,
  CANCELLED:                   s.badgeDefault,
  TRANSPORTATION_NOT_ASSIGNED: s.badgeNotAssigned,
  NOT_VERIFIED:                s.badgeDefault,
  PLANNED:                     s.badgePlanned,
}

const TEMP_LABELS = {
  ORDINARY:    'Сухой',
  MEDIUM_COLD: 'Средний холод',
  LOW_COLD:    'Низкий холод',
}

const TYPE_LABELS = {
  IMPORT:     'Умный импорт',
  CROSSDOCK:  'Кросс-докинг',
  STORAGE:    'На хранение от поставщика',
  STORAGE_DC: 'На хранение от РЦ',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('ru-RU')
}

function fmtKg(grams) {
  if (grams == null || grams === 0) return '—'
  const kg = grams / 1000
  return (kg % 1 === 0 ? fmtNum(kg) : Number(kg.toFixed(1)).toLocaleString('ru-RU')) + ' кг'
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d   = new Date(iso)
  const dd  = String(d.getDate()).padStart(2, '0')
  const mm  = String(d.getMonth() + 1).padStart(2, '0')
  const yy  = String(d.getFullYear()).slice(2)
  const hh  = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yy}, ${hh}:${min}`
}

function fmtDate(iso) {
  if (!iso) return '—'
  // Может быть "2026-04-08" или ISO
  const parts = iso.split('T')[0].split('-')
  if (parts.length === 3) {
    const [y, m, d] = parts
    return `${d}.${m}.${String(y).slice(2)}`
  }
  return iso
}

// Извлечь число из { pieceProducts: N } или из числа
function qty(val) {
  if (val == null) return null
  if (typeof val === 'number') return val
  return val.pieceProducts ?? val.weightProducts ?? null
}

function diffVal(actual, planned) {
  const a = qty(actual)
  const p = qty(planned)
  if (a == null || p == null) return null
  return a - p
}

function fmtDiff(d) {
  if (d == null) return '—'
  if (d === 0) return '—'
  return d > 0 ? `+${fmtNum(d)}` : fmtNum(d)
}

function diffCls(d) {
  if (d == null || d === 0) return ''
  return d > 0 ? s.diffPos : s.diffNeg
}

// Транспортировка: номер машины + водитель
function fmtTransport(transportation) {
  if (!transportation) return '—'
  const v = transportation.vehicle
  const d = transportation.driver
  const parts = []
  if (v?.number) parts.push(v.number)
  if (d?.lastName) parts.push(`${d.lastName} ${d.firstName || ''}`.trim())
  return parts.join(', ') || '—'
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  return (
    <span className={STATUS_CLASS[status] || s.badgeDefault}>
      {STATUS_LABELS[status] || status}
    </span>
  )
}

// ─── SideField ────────────────────────────────────────────────────────────────

function SideField({ label, value }) {
  if (!value || value === '—') {
    return (
      <div className={s.sideField}>
        <span className={s.sideLabel}>{label}</span>
        <span className={`${s.sideValue} ${s.sideValueMuted}`}>—</span>
      </div>
    )
  }
  return (
    <div className={s.sideField}>
      <span className={s.sideLabel}>{label}</span>
      <span className={s.sideValue}>{value}</span>
    </div>
  )
}

// ─── EO Panel ─────────────────────────────────────────────────────────────────
// Структура: products[].parts[].handlingUnits[]
// У каждого ЕО: handlingUnitBarcode, actualQuantity, productionDate, bestBeforeDate

function EoPanel({ products, remainingMap, onClose }) {
  const [expanded, setExpanded] = useState({})

  // Собираем все ЕО: { barcode, productName, imageUrl, productionDate, bestBeforeDate, qty }
  const allEo = []
  for (const prod of products) {
    for (const part of (prod.parts || [])) {
      for (const hu of (part.handlingUnits || [])) {
        allEo.push({
          barcode:         hu.handlingUnitBarcode || hu.id,
          productName:     prod.name,
          imageUrl:        prod.imageUrl,
          productionDate:  part.productionDate,
          bestBeforeDate:  part.bestBeforeDate,
          qty:             qty(hu.actualQuantity),
        })
      }
    }
  }

  // Группируем по штрихкоду ЕО
  const grouped = {}
  for (const eo of allEo) {
    const key = eo.barcode
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(eo)
  }
  const keys = Object.keys(grouped)

  function toggle(key) { setExpanded(p => ({ ...p, [key]: !p[key] })) }

  function copy(text) { navigator.clipboard.writeText(text).catch(() => {}) }

  return (
    <div className={s.eoPanel}>
      <div className={s.eoPanelHeader}>
        <span className={s.eoPanelTitle}>Группировка товаров по ЕО</span>
        <button type="button" className={s.eoPanelClose} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className={s.eoPanelCount}>
        Количество ЕО: <strong>{keys.length} шт.</strong>
      </div>
      <div className={s.eoList}>
        {keys.length === 0 && (
          <div className={s.eoEmpty}>Нет данных о ЕО</div>
        )}
        {keys.map(key => {
          const units      = grouped[key]
          const isOpen     = !!expanded[key]
          // Процент комплектации этого ЕО (только если remainingMap заполнен)
          const showPick   = remainingMap && key in remainingMap
          const rem        = showPick ? remainingMap[key] : undefined
          const totalQty   = units.reduce((s, u) => s + (u.qty ?? 0), 0)
          let pickBadge    = null
          if (showPick) {
            if (rem === null) {
              pickBadge = <span className={s.eoBadgeWaiting}>Не начато</span>
            } else if (rem === 0) {
              pickBadge = <span className={s.eoBadgeDone}>100%</span>
            } else {
              const pct = totalQty > 0 ? Math.round((totalQty - rem) / totalQty * 100) : 0
              pickBadge = <span className={s.eoBadgeInProgress}>{pct}%</span>
            }
          }
          return (
            <div key={key} className={s.eoItem}>
              <div className={s.eoItemHeader}>
                <span className={s.eoNumber}>{key}</span>
                {pickBadge}
                <button type="button" className={s.eoCopyBtn} onClick={() => copy(key)} title="Копировать">
                  <Copy size={13} />
                </button>
                <button type="button" className={s.eoExpandBtn} onClick={() => toggle(key)}>
                  {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
              {isOpen && (
                <div className={s.eoItemBody}>
                  {units.map((u, idx) => (
                    <div key={idx} className={s.eoUnitRow}>
                      <div className={s.eoUnitTop}>
                        {u.imageUrl ? (
                          <img src={u.imageUrl} alt="" className={s.eoUnitImg}
                            onError={e => { e.target.style.display = 'none' }} />
                        ) : (
                          <div className={s.eoUnitImgPlaceholder} />
                        )}
                        <div className={s.eoUnitName}>{u.productName || '—'}</div>
                      </div>
                      <div className={s.eoUnitMetas}>
                        {u.productionDate != null && (
                          <div className={s.eoUnitMetaCol}>
                            <span className={s.eoUnitMetaLabel}>Изготовлен</span>
                            <span className={s.eoUnitMetaValue}>{fmtDate(u.productionDate)}</span>
                          </div>
                        )}
                        {u.bestBeforeDate != null && (
                          <div className={s.eoUnitMetaCol}>
                            <span className={s.eoUnitMetaLabel}>Годен до</span>
                            <span className={s.eoUnitMetaValue}>{fmtDate(u.bestBeforeDate)}</span>
                          </div>
                        )}
                        {u.qty != null && (
                          <div className={s.eoUnitMetaCol}>
                            <span className={s.eoUnitMetaLabel}>Факт на ЕО</span>
                            <span className={s.eoUnitMetaValue}>{fmtNum(u.qty)} шт.</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SupplyDetailPage() {
  const { taskType, id } = useParams()
  const navigate         = useNavigate()
  const { getToken, isTokenValid, forceRefresh } = useAuth()

  const [data, setData]                     = useState(null)
  const [loading, setLoading]               = useState(true)
  const [error, setError]                   = useState(null)
  const [search, setSearch]                 = useState('')
  const [eoOpen, setEoOpen]                 = useState(false)
  const [pickStatus, setPickStatus]         = useState(null)  // null | 'waiting' | 'in_progress' | 'done'
  const [pickPct, setPickPct]               = useState(null)  // 0–100
  const [remainingMap, setRemainingMap]     = useState({})    // { barcode → remaining | null }
  const [pickLoading, setPickLoading]       = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        let token = getToken()
        if (!token || !isTokenValid()) {
          const ok = await forceRefresh()
          if (!ok) { setError('Нет токена WMS. Войдите заново.'); setLoading(false); return }
          token = getToken()
        }
        if (!token) { setError('Нет токена WMS. Войдите заново.'); setLoading(false); return }
        const res = await getInboundTaskDetail(token, { taskType, id })
        if (!cancelled) setData(res?.value ?? res)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [taskType, id, getToken, isTokenValid, forceRefresh])

  // Статус комплектации — только для CROSSDOCK
  useEffect(() => {
    if (!data || data.type !== 'CROSSDOCK') return

    // Собираем все ЕО-штрихкоды и суммируем принятые количества.
    // Один штрихкод ЕО может встречаться у нескольких товаров — дедупликация.
    const huByBarcode = {}
    for (const prod of (data.products ?? [])) {
      for (const part of (prod.parts ?? [])) {
        for (const hu of (part.handlingUnits ?? [])) {
          if (hu.handlingUnitBarcode) {
            huByBarcode[hu.handlingUnitBarcode] =
              (huByBarcode[hu.handlingUnitBarcode] ?? 0) + (qty(hu.actualQuantity) ?? 0)
          }
        }
      }
    }
    const uniqueHus = Object.entries(huByBarcode).map(([barcode, received]) => ({ barcode, received }))
    if (uniqueHus.length === 0) return

    let cancelled = false
    async function loadPickStatus() {
      setPickLoading(true)
      try {
        let token = getToken()
        if (!token || !isTokenValid()) {
          const ok = await forceRefresh()
          if (!ok) return
          token = getToken()
        }
        // Параллельно запрашиваем остаток по каждому уникальному ЕО
        // null  = изменений нет (ещё не начали комплектовать)
        // 0     = остаток = 0 (полностью скомплектовано)
        // N > 0 = ещё осталось (идёт комплектация)
        const remainings = await Promise.all(
          uniqueHus.map(hu => getEoRemaining(token, hu.barcode))
        )
        if (cancelled) return

        // Карта { barcode → remaining } для отображения % в панели ЕО
        const map = {}
        uniqueHus.forEach((hu, i) => { map[hu.barcode] = remainings[i] })
        setRemainingMap(map)

        // Общий процент скомплектованности
        const totalReceived = uniqueHus.reduce((s, hu) => s + hu.received, 0)
        const totalPicked   = uniqueHus.reduce((s, hu, i) => {
          const rem = remainings[i]
          return s + (rem === null ? 0 : Math.max(0, hu.received - rem))
        }, 0)
        const pct = totalReceived > 0 ? Math.round(totalPicked / totalReceived * 100) : 0
        setPickPct(pct)

        const allNoPicks = remainings.every(r => r === null)
        const allDone    = remainings.every(r => r === 0)
        if (allNoPicks)   setPickStatus('waiting')
        else if (allDone) setPickStatus('done')
        else              setPickStatus('in_progress')
      } catch { /* не критично */ } finally {
        if (!cancelled) setPickLoading(false)
      }
    }
    loadPickStatus()
    return () => { cancelled = true }
  }, [data, getToken, isTokenValid, forceRefresh])

  // Товары: поле products[] с реальной структурой API
  const products = data?.products ?? []

  const filtered = search.trim()
    ? products.filter(p => {
        const q = search.toLowerCase()
        return (p.name || '').toLowerCase().includes(q)
          || (p.nomenclatureCode || '').toLowerCase().includes(q)
      })
    : products

  // Итоги
  const totalPlanned = products.reduce((acc, p) => acc + (qty(p.plannedQuantity) ?? 0), 0)
  const totalActual  = products.reduce((acc, p) => acc + (qty(p.actualQuantity)  ?? 0), 0)
  const totalHu      = products.reduce((acc, p) => acc + (p.handlingUnitQuantity ?? 0), 0)
  const totalDiff    = totalActual - totalPlanned

  return (
    <div className={s.pageWrap}>
      {/* ── Main area ── */}
      <div className={s.main}>
        {/* Header */}
        <div className={s.header}>
          <button type="button" className={s.backBtn} onClick={() => navigate('/supplies')}>
            ← Назад
          </button>
          {data && (
            <>
              <span className={s.taskTitle}>Поставка {data.taskNumber || id}</span>
              {/* Для кросс-докинга "Принято" → статус комплектации (с % по мере работы) */}
              {data.type === 'CROSSDOCK' && (data.status === 'COMPLETED_AS_PLANNED' || data.status === 'COMPLETED_WITH_DISCREPANCY') ? (
                pickLoading
                  ? <span className={s.pickBadgeLoading}>комплектация...</span>
                  : pickStatus === 'waiting'     ? <span className={`${s.pickBadge} ${s.pickWaiting}`}>Ждёт комплектацию</span>
                  : pickStatus === 'in_progress' ? <span className={`${s.pickBadge} ${s.pickInProgress}`}>Комплектация {pickPct != null ? `${pickPct}%` : ''}</span>
                  : pickStatus === 'done'        ? <span className={`${s.pickBadge} ${s.pickDone}`}>Скомплектована 100%</span>
                  : <span className={s.pickBadgeLoading}>комплектация...</span>
              ) : (
                <StatusBadge status={data.status} />
              )}
            </>
          )}
          {loading && !data && <span className={s.loadingText}>Загрузка...</span>}
        </div>

        {error && <div className={s.error}>{error}</div>}

        {data && (
          <>
            {/* Toolbar */}
            <div className={s.tableToolbar}>
              <div className={s.searchWrap}>
                <Search size={14} className={s.searchIcon} />
                <input
                  className={s.searchInput}
                  placeholder="Поиск по товарам..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <button type="button" className={s.eoLink} onClick={() => setEoOpen(o => !o)}>
                Посмотреть ЕО в поставке
              </button>
            </div>

            {/* Table */}
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th className={s.th}>Фото</th>
                    <th className={s.th}>Название</th>
                    <th className={`${s.th} ${s.thNum}`}>План</th>
                    <th className={`${s.th} ${s.thNum}`}>Факт</th>
                    <th className={`${s.th} ${s.thNum}`}>Разница</th>
                    <th className={`${s.th} ${s.thNum}`}>ЕО</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className={s.stateRow}>
                        {search ? 'Ничего не найдено' : 'Нет товаров'}
                      </td>
                    </tr>
                  )}
                  {filtered.map(prod => {
                    const d = diffVal(prod.actualQuantity, prod.plannedQuantity)
                    return (
                      <tr key={prod.id} className={s.tr}>
                        <td className={s.td}>
                          {prod.imageUrl ? (
                            <img src={prod.imageUrl} alt="" className={s.prodImg}
                              onError={e => { e.target.style.display = 'none' }} />
                          ) : (
                            <div className={s.prodImgPlaceholder} />
                          )}
                        </td>
                        <td className={s.td}>
                          <div className={s.prodName}>{prod.name || '—'}</div>
                          {prod.nomenclatureCode && (
                            <div className={s.prodArticle}>{prod.nomenclatureCode}</div>
                          )}
                        </td>
                        <td className={`${s.td} ${s.tdNum}`}>{fmtNum(qty(prod.plannedQuantity))}</td>
                        <td className={`${s.td} ${s.tdNum}`}>{fmtNum(qty(prod.actualQuantity))}</td>
                        <td className={`${s.td} ${s.tdNum} ${diffCls(d)}`}>{fmtDiff(d)}</td>
                        <td className={`${s.td} ${s.tdNum}`}>{prod.handlingUnitQuantity ?? '—'}</td>
                      </tr>
                    )
                  })}
                  {filtered.length > 0 && (
                    <tr className={s.totalRow}>
                      <td className={s.td} colSpan={2}><strong>Итого</strong></td>
                      <td className={`${s.td} ${s.tdNum}`}><strong>{fmtNum(totalPlanned)}</strong></td>
                      <td className={`${s.td} ${s.tdNum}`}><strong>{fmtNum(totalActual)}</strong></td>
                      <td className={`${s.td} ${s.tdNum} ${diffCls(totalDiff)}`}>
                        <strong>{fmtDiff(totalDiff)}</strong>
                      </td>
                      <td className={`${s.td} ${s.tdNum}`}><strong>{fmtNum(totalHu)}</strong></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── Sidebar ── */}
      {data && (
        <div className={s.sidebar}>
          <div className={s.sideSection}>
            <SideField label="Плановая дата"      value={fmtDate(data.plannedArrivalDate)} />
            <SideField label="Номер поставки"     value={data.taskNumber} />
            <SideField label="Номер заказа"       value={data.orderNumber} />
            <SideField label="Поставщик"          value={data.supplier?.name} />
            <SideField label="Тип"                value={TYPE_LABELS[data.type] || data.type} />
            <SideField label="Температура"        value={TEMP_LABELS[data.temperatureMode] || data.temperatureMode} />
            <SideField label="Транспортировка"    value={fmtTransport(data.transportation)} />
            <SideField label="Ворота"             value={data.gateInfo?.gateNumber} />
            <SideField label="Начало приёмки"     value={fmtDateTime(data.startedAt)} />
            <SideField label="Завершение приёмки" value={fmtDateTime(data.completedAt)} />
            <SideField label="Принятый вес"       value={fmtKg(data.actualTotalWeight)} />
            <SideField label="Принятые ЕО"        value={data.handlingUnitsQuantity != null ? `${data.handlingUnitsQuantity} шт.` : null} />
          </div>

          <button type="button" className={s.executorsBtn}>
            <Users size={14} />
            Посмотреть исполнителей
          </button>
        </div>
      )}

      {/* ── EO overlay (поверх всего, с затемнением) ── */}
      {eoOpen && (
        <>
          <div className={s.eoBackdrop} onClick={() => setEoOpen(false)} />
          <EoPanel products={products} remainingMap={remainingMap} onClose={() => setEoOpen(false)} />
        </>
      )}
    </div>
  )
}
