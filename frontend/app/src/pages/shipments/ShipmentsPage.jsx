import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import * as api from '../../api/index.js'
import styles from './ShipmentsPage.module.css'
import { useNotify } from '../../context/NotifyContext.jsx'
import { shortFio } from '../../utils/format.js'
import {
  X, Check, Pencil, Search, Trash2, AlertTriangle, Download, Upload,
  Camera, Truck, PackageOpen, Car, CheckCircle2,
} from 'lucide-react'

const ROUTES_PER_PAGE = 50
const LS_ACCESS_KEY   = 'wms_access_token'
const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStoredToken() {
  const token  = localStorage.getItem(LS_ACCESS_KEY)
  const expiry = localStorage.getItem(LS_ACCESS_EXPIRY_KEY)
  if (!token) return null
  if (expiry && Date.now() > Number(expiry) - 60000) return null
  return token
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.slice(0, 10).split('-')
  return `${day}.${m}.${y}`
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function DiffVal({ diff }) {
  if (diff == null) return <span className={styles.naVal}>—</span>
  if (diff > 0) return <span className={styles.diffPlus}>+{diff}</span>
  if (diff < 0) return <span className={styles.diffMinus}>{diff}</span>
  return <span className={styles.diffZero}>0</span>
}

function SortArrow({ sort, col }) {
  if (sort.key !== col) return <span className={`${styles.sortArrow} ${styles.sortNone}`}>⇅</span>
  return <span className={`${styles.sortArrow} ${styles.sortActive}`}>{sort.dir === 'desc' ? '↓' : '↑'}</span>
}

function toggleSortState(sort, key) {
  if (sort.key === key) {
    const dir = sort.dir === 'desc' ? 'asc' : sort.dir === 'asc' ? null : 'desc'
    return dir === null ? { key: null, dir: null } : { key, dir }
  }
  return { key, dir: 'desc' }
}

function sortedData(data, sort) {
  if (!sort.key || !sort.dir) return data
  return [...data].sort((a, b) => {
    const av = a[sort.key] ?? 0
    const bv = b[sort.key] ?? 0
    return sort.dir === 'desc' ? bv - av : av - bv
  })
}

// Persists state in localStorage — drop-in replacement for useState
function useLocalState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s !== null ? JSON.parse(s) : defaultValue
    } catch { return defaultValue }
  })
  const set = useCallback(valOrFn => {
    setValue(prev => {
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn
      try { localStorage.setItem(key, JSON.stringify(next)) } catch {}
      return next
    })
  }, [key])
  return [value, set]
}

// Persists a Set in localStorage (serialized as array)
function useLocalSet(key) {
  const [value, setValue] = useState(() => {
    try {
      const s = localStorage.getItem(key)
      return s !== null ? new Set(JSON.parse(s)) : new Set()
    } catch { return new Set() }
  })
  const set = useCallback(valOrFn => {
    setValue(prev => {
      const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn
      try { localStorage.setItem(key, JSON.stringify([...next])) } catch {}
      return next
    })
  }, [key])
  return [value, set]
}

function thumbUrl(url) {
  if (url.startsWith('http')) {
    return url.replace('/rk-photos/', '/rk-photos/thumbs/').replace(/\.\w+$/, '.jpg')
  }
  return url.replace('/rk-photos/', '/rk-photos/thumb/')
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

function Lightbox({ photos, idx, onClose, onNav }) {
  // fullSrc: null пока грузится полный размер, затем — URL оригинала
  const [fullSrc, setFullSrc] = useState(null)

  // При смене фото: сразу показываем thumb, в фоне грузим оригинал
  useEffect(() => {
    setFullSrc(null)
    const img = new Image()
    img.src = photos[idx]
    img.onload = () => setFullSrc(photos[idx])
    return () => { img.onload = null }
  }, [photos, idx])

  // Предзагрузка соседних фото
  useEffect(() => {
    const neighbors = [photos[idx - 1], photos[idx + 1]].filter(Boolean)
    const preloaded = neighbors.map(src => { const i = new Image(); i.src = src; return i })
    return () => { preloaded.forEach(i => { i.src = '' }) }
  }, [photos, idx])

  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape')     onClose()
      if (e.key === 'ArrowLeft')  onNav(-1)
      if (e.key === 'ArrowRight') onNav(+1)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, onNav])

  return (
    <div className={styles.lightbox} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <button className={styles.lbClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
      <button className={styles.lbPrev} disabled={photos.length <= 1} onClick={() => onNav(-1)}>‹</button>
      <div className={styles.lbImgWrap} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <img
          className={`${styles.lbImg} ${!fullSrc ? styles.lbImgPreview : ''}`}
          src={fullSrc || thumbUrl(photos[idx])}
          alt=""
        />
      </div>
      <button className={styles.lbNext} disabled={photos.length <= 1} onClick={() => onNav(+1)}>›</button>
      <div className={styles.lbCounter}>{idx + 1} / {photos.length}</div>
    </div>
  )
}

// ─── Missing codes banner ──────────────────────────────────────────────────────

function MissingCodesBanner({ missing, onSaved }) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState({})
  const [saving, setSaving] = useState({})
  const [saved, setSaved] = useState({})

  if (!missing.length) return null

  const handleSave = async addr => {
    const code = (values[addr] || '').trim()
    if (!code) return
    setSaving(s => ({ ...s, [addr]: true }))
    try {
      await api.setShipmentRecipientCode(addr, code)
      setSaved(s => ({ ...s, [addr]: code }))
      onSaved(addr)
    } finally {
      setSaving(s => ({ ...s, [addr]: false }))
    }
  }

  const n = missing.length
  const word = n === 1 ? '' : n < 5 ? 'а' : 'ов'

  return (
    <div className={styles.missingBanner}>
      <div className={styles.missingHeader}>
        <AlertTriangle size={14} strokeWidth={2} style={{marginRight:5,verticalAlign:'middle'}}/>{n} адрес{word} ЦФЗ без кода получателя
        <button className={styles.missingToggle} onClick={() => setOpen(o => !o)}>
          {open ? 'Скрыть' : 'Показать'}
        </button>
      </div>
      {open && (
        <div className={styles.missingList}>
          {missing.map(addr => (
            <div key={addr} className={styles.missingRow}>
              <span className={styles.missingAddr}>{addr}</span>
              {saved[addr]
                ? <span className={styles.codeSaved}><Check size={12} strokeWidth={2.5}/> {saved[addr]}</span>
                : <>
                    <input
                      className={styles.codeInput}
                      placeholder="Код получателя"
                      value={values[addr] || ''}
                      onChange={e => setValues(v => ({ ...v, [addr]: e.target.value }))}
                    />
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={saving[addr]}
                      onClick={() => handleSave(addr)}
                    >Сохранить</button>
                  </>
              }
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Routes view ──────────────────────────────────────────────────────────────

// Comparator for route sort — nulls always to the end
function routeSortCmp(a, b, key, dir) {
  let av, bv
  switch (key) {
    case 'date':        av = a.date || '';              bv = b.date || '';              break
    case 'routeNumber': av = a.routeNumber || '';       bv = b.routeNumber || '';       break
    case 'driver':      av = a.driver?.name || '';      bv = b.driver?.name || '';      break
    case 'shippedRK':   av = a.shippedRK;               bv = b.shippedRK;               break
    case 'shippedAt':   av = a.shippedAt || null;       bv = b.shippedAt || null;       break
    case 'receivedRK':  av = a.receivedRK;              bv = b.receivedRK;              break
    case 'receivedAt':  av = a.receivedAt || null;      bv = b.receivedAt || null;      break
    case 'diff':        av = a.diff;                    bv = b.diff;                    break
    default:            return 0
  }
  // nulls/undefined to end always
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  const cmp = typeof av === 'string' ? av.localeCompare(bv, 'ru') : av - bv
  return dir === 'desc' ? -cmp : cmp
}

function RoutesView({ data, loading, error, onOpenLightbox, onOpenEdit, onDataUpdate, onBulkDelete }) {
  const [page, setPage] = useLocalState('sh_routes_page', 1)
  const [sort, setSort] = useLocalState('sh_routes_sort', { key: null, dir: null })
  const [expanded, setExpanded] = useLocalSet('sh_routes_expanded')
  const [selected, setSelected] = useLocalSet('sh_routes_selected')
  const [bulkMsg, setBulkMsg] = useState(null)
  const [confirming, setConfirming] = useState({})

  const toggleSort = col => { setSort(s => toggleSortState(s, col)); setPage(1) }

  // Сбрасываем страницу при смене фильтра/поиска, но не при первой загрузке
  const isFirstData = useRef(true)
  useEffect(() => {
    if (isFirstData.current) { isFirstData.current = false; return }
    setPage(1)
  }, [data])

  const sortedData = useMemo(() => sort.key && sort.dir
    ? [...data].sort((a, b) => routeSortCmp(a, b, sort.key, sort.dir))
    : data
  , [data, sort.key, sort.dir])

  const totalPages = Math.max(1, Math.ceil(sortedData.length / ROUTES_PER_PAGE))
  const curPage = Math.min(page, totalPages)
  const pageData = useMemo(
    () => sortedData.slice((curPage - 1) * ROUTES_PER_PAGE, curPage * ROUTES_PER_PAGE),
    [sortedData, curPage]
  )

  const toggleExpand = useCallback(id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }), [])
  const toggleSelect = useCallback(id => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }), [])

  const allOnPageChecked = pageData.length > 0 && pageData.every(r => selected.has(r.routeId))
  const toggleSelectAll = checked => {
    setSelected(s => {
      const n = new Set(s)
      pageData.forEach(r => checked ? n.add(r.routeId) : n.delete(r.routeId))
      return n
    })
  }

  const confirmSingle = useCallback(async (routeId, atype) => {
    setConfirming(c => ({ ...c, [routeId + atype]: true }))
    try {
      const res = atype === 'ship' ? await api.confirmRkShipment(routeId) : await api.confirmRkReceiving(routeId)
      if (!res.ok) throw new Error(res.error || 'Ошибка')
      onDataUpdate(routeId, res.route)
    } catch (err) { alert('Ошибка: ' + err.message) }
    finally { setConfirming(c => ({ ...c, [routeId + atype]: false })) }
  }, [onDataUpdate])

  const bulkConfirm = async baction => {
    const ids = [...selected]
    const fn = baction === 'confirm-ship' ? api.confirmRkShipment : api.confirmRkReceiving
    let done = 0
    for (const id of ids) {
      try {
        const res = await fn(id)
        if (res.ok) { onDataUpdate(id, res.route); setSelected(s => { const n = new Set(s); n.delete(id); return n }) }
      } catch { /* skip */ }
      done++
      setBulkMsg(`Подтверждаю: ${done}/${ids.length}`)
    }
    setBulkMsg(null)
  }

  const bulkDelete = async () => {
    const ids = [...selected]
    if (!confirm(`Удалить ${ids.length} маршрут${ids.length === 1 ? '' : ids.length < 5 ? 'а' : 'ов'}? Это действие нельзя отменить.`)) return
    setBulkMsg(`Удаляю...`)
    try {
      const res = await api.deleteRkRoutesBulk(ids)
      if (res.ok) {
        onBulkDelete(ids)
        setSelected(new Set())
      } else {
        alert('Ошибка: ' + (res.error || 'неизвестная ошибка'))
      }
    } catch (err) { alert('Ошибка: ' + err.message) }
    finally { setBulkMsg(null) }
  }

  if (loading) return <div className={styles.loading}>Загрузка...</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!data.length) return <div className={styles.empty}>Нет маршрутов. Загрузите из WMS.</div>

  return (
    <>
      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{bulkMsg || `Выбрано: ${selected.size}`}</span>
          <button className="btn btn-sm btn-primary" style={{display:'inline-flex',alignItems:'center',gap:5}} onClick={() => bulkConfirm('confirm-ship')}><Check size={13} strokeWidth={2.5}/>Подтвердить отгрузку</button>
          <button className="btn btn-sm btn-primary" style={{display:'inline-flex',alignItems:'center',gap:5}} onClick={() => bulkConfirm('confirm-receive')}><Check size={13} strokeWidth={2.5}/>Подтвердить приёмку</button>
          <button className="btn btn-sm btn-secondary" style={{ color: '#c62828', borderColor: '#c62828', display:'inline-flex', alignItems:'center', gap:5 }} onClick={bulkDelete}><Trash2 size={13} strokeWidth={2}/>Удалить выбранные</button>
          <button className="btn btn-sm btn-secondary" style={{display:'inline-flex',alignItems:'center',gap:5}} onClick={() => setSelected(new Set())}><X size={13} strokeWidth={2}/>Снять выбор</button>
        </div>
      )}

      {/* Mobile cards */}
      <div className={styles.mCardList}>
        {pageData.map(r => (
          <MobileRouteCard
            key={r.routeId}
            route={r}
            confirming={confirming}
            onConfirm={confirmSingle}
            onEdit={onOpenEdit}
            onLightbox={onOpenLightbox}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div className={styles.desktopOnly}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thCheck}>
                <input type="checkbox" checked={allOnPageChecked} onChange={e => toggleSelectAll(e.target.checked)} />
              </th>
              <th className={styles.thSort} onClick={() => toggleSort('date')}>Дата <SortArrow sort={sort} col="date" /></th>
              <th className={styles.thSort} onClick={() => toggleSort('routeNumber')}>Маршрут <SortArrow sort={sort} col="routeNumber" /></th>
              <th className={styles.thSort} onClick={() => toggleSort('driver')}>Водитель <SortArrow sort={sort} col="driver" /></th>
              <th>ТС</th><th>ЦФЗ</th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('shippedRK')}>РК отгр. <SortArrow sort={sort} col="shippedRK" /></th>
              <th className={styles.thNum}>Пал.↗</th>
              <th className={styles.thNum}>Ящ.↗</th>
              <th className={styles.thNum}>Рохли↗</th>
              <th>Кто отгрузил</th>
              <th className={styles.thNum}>Темп.до°</th>
              <th className={styles.thNum}>Темп.пос.°</th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('shippedAt')}>Дата отгр. <SortArrow sort={sort} col="shippedAt" /></th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('receivedRK')}>РК принято <SortArrow sort={sort} col="receivedRK" /></th>
              <th className={styles.thNum}>Пал.↙</th>
              <th className={styles.thNum}>Ящ.↙</th>
              <th className={styles.thNum}>Рохли↙</th>
              <th className={styles.thNum}>Долг рохлей</th>
              <th>Кто принял</th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('receivedAt')}>Дата прин. <SortArrow sort={sort} col="receivedAt" /></th>
              <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort('diff')}>Разница <SortArrow sort={sort} col="diff" /></th>
              <th>Подтв. отгр.</th><th>Подтв. пр.</th>
              <th className={styles.thActions}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map(r => (
              <RouteRows
                key={r.routeId}
                route={r}
                expanded={expanded.has(r.routeId)}
                selected={selected.has(r.routeId)}
                confirming={confirming}
                onToggleExpand={toggleExpand}
                onToggleSelect={toggleSelect}
                onConfirm={confirmSingle}
                onEdit={onOpenEdit}
                onLightbox={onOpenLightbox}
              />
            ))}
          </tbody>
        </table>
      </div>{/* end desktopOnly */}
      {totalPages > 1
        ? <div className={styles.pagination}>
            <button className={styles.pageBtn} disabled={curPage === 1} onClick={() => setPage(1)}>«</button>
            <button className={styles.pageBtn} disabled={curPage === 1} onClick={() => setPage(p => p - 1)}>‹</button>
            <span className={styles.pageInfo}>Стр. {curPage} из {totalPages} · всего {data.length}</span>
            <button className={styles.pageBtn} disabled={curPage === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <button className={styles.pageBtn} disabled={curPage === totalPages} onClick={() => setPage(totalPages)}>»</button>
          </div>
        : <div className={styles.pageInfoSimple}>Всего: {data.length}</div>
      }
    </>
  )
}

const RouteRows = memo(function RouteRows({ route: r, expanded, selected, confirming, onToggleExpand, onToggleSelect, onConfirm, onEdit, onLightbox }) {
  const cfzList = r.cfzAddresses || []

  const hasShipment = !!r.shipment
  const hasReceiving = !!r.receiving
  const shipConfirmed = !!r.shipment?.confirmed
  const recvConfirmed = !!r.receiving?.confirmed

  let rowStatusClass = ''
  if (hasShipment && !hasReceiving) rowStatusClass = styles.rowPending
  else if (hasShipment && hasReceiving) rowStatusClass = (shipConfirmed && recvConfirmed)
    ? styles.rowCompleted
    : styles.rowAwaitConfirm
  else if (!hasShipment && hasReceiving) rowStatusClass = styles.rowAwaitConfirm

  const shipConfirmEl = r.shipment
    ? (!r.shipment.confirmed
        ? <button className={`${styles.actBtn} ${styles.actConfirmBtn}`} disabled={confirming[r.routeId + 'ship']} title="Подтвердить отгрузку" onClick={e => { e.stopPropagation(); onConfirm(r.routeId, 'ship') }}>
            {confirming[r.routeId + 'ship'] ? '...' : 'Отгр.'}
          </button>
        : <span className={styles.actDone} title="Отгрузка подтверждена"><Check size={11} strokeWidth={2.5}/> Отгр.</span>)
    : null

  const recvConfirmEl = r.receiving
    ? (!r.receiving.confirmed
        ? <button className={`${styles.actBtn} ${styles.actConfirmBtn}`} disabled={confirming[r.routeId + 'receive']} title="Подтвердить приёмку" onClick={e => { e.stopPropagation(); onConfirm(r.routeId, 'receive') }}>
            {confirming[r.routeId + 'receive'] ? '...' : 'Пр.'}
          </button>
        : <span className={styles.actDone} title="Приёмка подтверждена"><Check size={11} strokeWidth={2.5}/> Пр.</span>)
    : null

  return (
    <>
      <tr
        className={`${styles.trMain} ${rowStatusClass}`}
        onClick={e => { if (!e.target.closest('[data-noexpand]')) onToggleExpand(r.routeId) }}
      >
        <td className={styles.tdCheck} data-noexpand="1" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={() => onToggleSelect(r.routeId)} />
        </td>
        <td>{fmtDate(r.date)}</td>
        <td className={styles.tdBold}>{r.routeNumber || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.driver?.name || ''}>{shortFio(r.driver?.name) || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : ''}>{r.vehicle ? `${r.vehicle.model} ${r.vehicle.number}` : '—'}</td>
        <td className={styles.tdMuted}>{cfzList.length ? `${cfzList.length}` : '—'}</td>
        <td className={styles.tdNum}>{r.shippedRK != null ? r.shippedRK : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.shippedPallets != null && r.shippedPallets > 0 ? r.shippedPallets : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.shippedBoxes != null && r.shippedBoxes > 0 ? r.shippedBoxes : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.shipment?.rokhlya != null ? r.shipment.rokhlya : <span className={styles.naVal}>—</span>}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.shipment?.by || ''}>{r.shipment?.by || '—'}</td>
        <td className={styles.tdNum}>{r.shipment?.tempBefore != null ? `${r.shipment.tempBefore}°` : '—'}</td>
        <td className={styles.tdNum}>{r.shipment?.tempAfter != null ? `${r.shipment.tempAfter}°` : '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.shippedAt)}</td>
        <td className={styles.tdNum}>{r.receivedRK != null ? r.receivedRK : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.receivedPallets != null && r.receivedPallets > 0 ? r.receivedPallets : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.receivedBoxes != null && r.receivedBoxes > 0 ? r.receivedBoxes : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.receiving?.rokhlya != null ? r.receiving.rokhlya : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}>{r.rokhlyaDebt != null && r.rokhlyaDebt !== 0 ? r.rokhlyaDebt : <span className={styles.naVal}>—</span>}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.receiving?.by || ''}>{r.receiving?.by || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.receivedAt)}</td>
        <td className={styles.tdNum}><DiffVal diff={r.diff} /></td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.shipment?.confirmedBy || ''}>{shortFio(r.shipment?.confirmedBy) || '—'}</td>
        <td className={`${styles.tdMuted} ${styles.tdTrunc}`} title={r.receiving?.confirmedBy || ''}>{shortFio(r.receiving?.confirmedBy) || '—'}</td>
        <td className={`${styles.tdActions}`} data-noexpand="1">
          {shipConfirmEl}
          {recvConfirmEl}
          <button className={`${styles.actBtn} ${styles.actEditBtn}`} title="Редактировать" onClick={e => { e.stopPropagation(); onEdit(r.routeId) }}><Pencil size={13} strokeWidth={2}/></button>
        </td>
      </tr>
      {expanded && <RouteDetailRow route={r} onLightbox={onLightbox} />}
    </>
  )
})

function RouteDetailRow({ route: r, onLightbox }) {

  const shipItems = r.shipment?.items || []
  const recvItems = r.receiving?.items || []
  const cfzList   = r.cfzAddresses || []
  const addrs = useMemo(() => cfzList.length
    ? cfzList.map(a => a.address)
    : [...new Set([...shipItems.map(i => i.address), ...recvItems.map(i => i.address)])]
  , [cfzList, shipItems, recvItems])

  const meta = [
    r.shipment ? <>
      Отгрузил: <b>{r.shipment.by || '—'}</b>
      {r.shipment.gate ? <> · Ворота: <b>{r.shipment.gate}</b></> : ''}
      {r.shipment.tempBefore != null ? <> · Темп.до: <b>{r.shipment.tempBefore}°</b></> : ''}
      {r.shipment.tempAfter != null ? <> · Темп.после: <b>{r.shipment.tempAfter}°</b></> : ''}
      {r.shipment.rokhlya != null ? <> · Рохли: <b>{r.shipment.rokhlya}</b></> : ''}
      {r.shipment.confirmed ? <span className={styles.badgeOk}><Check size={11} strokeWidth={2.5}/></span> : ''}
    </> : null,
    r.receiving ? <>
      Принял: <b>{r.receiving.by || '—'}</b>
      {r.receiving.gate ? <> · Ворота: <b>{r.receiving.gate}</b></> : ''}
      {r.receiving.rokhlya != null ? <> · Рохли возвр.: <b>{r.receiving.rokhlya}</b></> : ''}
      {r.rokhlyaDebt != null && r.rokhlyaDebt !== 0 ? <> · Долг рохлей: <b style={{color:'#e65100'}}>{r.rokhlyaDebt}</b></> : ''}
      {r.receiving.confirmed ? <span className={styles.badgeOk}><Check size={11} strokeWidth={2.5}/></span> : ''}
    </> : null,
  ].filter(Boolean)

  const shipPhotos = r.shipment?.photos  || []
  const recvPhotos = r.receiving?.photos || []

  return (
    <tr>
      <td colSpan={99} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
        <div className={styles.detailBlock}>
          {meta.length > 0 && (
            <div className={styles.detailMeta}>
              {meta.map((m, i) => <span key={i}>{i > 0 ? ' · ' : ''}{m}</span>)}
            </div>
          )}
          {addrs.length > 0
            ? <table className={styles.detailTable}>
                <thead><tr>
                  <th>Адрес ЦФЗ</th>
                  <th className={styles.thNum}>РК отгр.</th>
                  <th className={styles.thNum}>Пал. отгр.</th>
                  <th className={styles.thNum}>Ящ. отгр.</th>
                  <th className={styles.thNum}>РК прин.</th>
                  <th className={styles.thNum}>Пал. прин.</th>
                  <th className={styles.thNum}>Ящ. прин.</th>
                  <th className={styles.thNum}>Разница РК</th>
                </tr></thead>
                <tbody>
                  {addrs.map(addr => {
                    const s  = shipItems.find(i => i.address === addr)
                    const rv = recvItems.find(i => i.address === addr)
                    const d  = s && rv ? rv.rk - s.rk : null
                    return (
                      <tr key={addr}>
                        <td>{addr}</td>
                        <td className={styles.tdNum}>{s ? s.rk : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{s?.pallets > 0 ? s.pallets : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{s?.boxes > 0 ? s.boxes : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{rv ? rv.rk : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{rv?.pallets > 0 ? rv.pallets : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}>{rv?.boxes > 0 ? rv.boxes : <span className={styles.naVal}>—</span>}</td>
                        <td className={styles.tdNum}><DiffVal diff={d} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            : <div className={styles.empty}>Данные по ЦФЗ отсутствуют</div>
          }
          {(shipPhotos.length > 0 || recvPhotos.length > 0) && (
            <div className={styles.photoCols}>
              {shipPhotos.length > 0 && (
                <div className={styles.photoCol}>
                  <div className={styles.photoColLabel}>Отгрузил</div>
                  <div className={styles.photosRow}>
                    {shipPhotos.map((u, i) => (
                      <span key={u} className={styles.photoThumb} onClick={() => onLightbox(shipPhotos, i)}>
                        <img src={thumbUrl(u)} alt="фото" decoding="async" />
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {recvPhotos.length > 0 && (
                <div className={styles.photoCol}>
                  <div className={styles.photoColLabel}>Принял</div>
                  <div className={styles.photosRow}>
                    {recvPhotos.map((u, i) => (
                      <span key={u} className={styles.photoThumb} onClick={() => onLightbox(recvPhotos, i)}>
                        <img src={thumbUrl(u)} alt="фото" decoding="async" />
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ─── Mobile route card ────────────────────────────────────────────────────────

const MobileRouteCard = memo(function MobileRouteCard({ route: r, confirming, onConfirm, onEdit, onLightbox }) {
  const [expanded, setExpanded] = useState(false)

  const hasShipment  = !!r.shipment
  const hasReceiving = !!r.receiving
  const shipConfirmed = !!r.shipment?.confirmed
  const recvConfirmed = !!r.receiving?.confirmed

  let statusLabel = 'Не отгружен'
  let statusClass = styles.mCardStatusNew
  if (hasShipment && !hasReceiving) { statusLabel = 'Ожидает приёмки'; statusClass = styles.mCardStatusPending }
  else if (hasShipment && hasReceiving && shipConfirmed && recvConfirmed) { statusLabel = 'Завершён'; statusClass = styles.mCardStatusDone }
  else if (hasShipment && hasReceiving) { statusLabel = 'Ждёт подтверждения'; statusClass = styles.mCardStatusAwait }

  const shipPhotos = r.shipment?.photos || []
  const recvPhotos = r.receiving?.photos || []

  return (
    <div className={styles.mCard}>
      <div className={styles.mCardTop} onClick={() => setExpanded(e => !e)}>
        <div className={styles.mCardMain}>
          <div className={styles.mCardRoute}>{r.routeNumber || '—'}</div>
          <div className={styles.mCardDate}>{fmtDate(r.date)}</div>
        </div>
        <span className={`${styles.mCardStatus} ${statusClass}`}>{statusLabel}</span>
      </div>

      <div className={styles.mCardMeta} onClick={() => setExpanded(e => !e)}>
        <span style={{display:'inline-flex',alignItems:'center',gap:4}}><Car size={13} strokeWidth={2}/>{r.driver?.name || '—'}</span>
        {r.vehicle && <span>· {r.vehicle.number}</span>}
        {r.cfzAddresses?.length ? <span>· ЦФЗ: {r.cfzAddresses.length}</span> : null}
      </div>

      <div className={styles.mCardMetrics}>
        <div className={styles.mCardMetric}>
          <span className={styles.mCardMetricLabel}>Отгружено РК</span>
          <span className={styles.mCardMetricVal}>{r.shippedRK != null ? r.shippedRK : '—'}</span>
        </div>
        <div className={styles.mCardMetricDivider} />
        <div className={styles.mCardMetric}>
          <span className={styles.mCardMetricLabel}>Принято РК</span>
          <span className={styles.mCardMetricVal}>{r.receivedRK != null ? r.receivedRK : '—'}</span>
        </div>
        <div className={styles.mCardMetricDivider} />
        <div className={styles.mCardMetric}>
          <span className={styles.mCardMetricLabel}>Разница</span>
          <span className={styles.mCardMetricVal}><DiffVal diff={r.diff} /></span>
        </div>
      </div>

      {expanded && (
        <div className={styles.mCardDetail}>
          {r.shipment && (
            <div className={styles.mCardDetailRow}>
              <span className={styles.mCardDetailLabel}>Отгрузил</span>
              <span>{r.shipment.by || '—'}{r.shipment.gate ? `, ворота ${r.shipment.gate}` : ''}{r.shipment.tempBefore != null ? `, ${r.shipment.tempBefore}°→${r.shipment.tempAfter}°` : ''}</span>
            </div>
          )}
          {r.receiving && (
            <div className={styles.mCardDetailRow}>
              <span className={styles.mCardDetailLabel}>Принял</span>
              <span>{r.receiving.by || '—'}{r.receiving.gate ? `, ворота ${r.receiving.gate}` : ''}</span>
            </div>
          )}
          {r.cfzAddresses?.map(a => {
            const s = r.shipment?.items?.find(i => i.address === a.address)
            const rv = r.receiving?.items?.find(i => i.address === a.address)
            return (
              <div key={a.address} className={styles.mCardCfzRow}>
                <span className={styles.mCardCfzAddr}>{a.address}</span>
                <span className={styles.mCardCfzNums}>
                  {s ? `↗${s.rk}` : '—'} / {rv ? `↙${rv.rk}` : '—'}
                </span>
              </div>
            )
          })}
          {(shipPhotos.length > 0 || recvPhotos.length > 0) && (
            <div className={styles.mCardPhotos}>
              {shipPhotos.map((u, i) => (
                <span key={u} className={styles.photoThumb} onClick={() => onLightbox(shipPhotos, i)}>
                  <img src={thumbUrl(u)} alt="фото" decoding="async" />
                </span>
              ))}
              {recvPhotos.map((u, i) => (
                <span key={u} className={styles.photoThumb} onClick={() => onLightbox(recvPhotos, i)}>
                  <img src={thumbUrl(u)} alt="фото" decoding="async" />
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.mCardActions}>
        {r.shipment && !r.shipment.confirmed && (
          <button className={`btn btn-sm btn-secondary ${styles.mCardActBtn}`} style={{display:'inline-flex',alignItems:'center',gap:4}} disabled={confirming[r.routeId + 'ship']} onClick={() => onConfirm(r.routeId, 'ship')}>
            <Check size={13} strokeWidth={2.5}/>Отгрузка
          </button>
        )}
        {r.receiving && !r.receiving.confirmed && (
          <button className={`btn btn-sm btn-secondary ${styles.mCardActBtn}`} style={{display:'inline-flex',alignItems:'center',gap:4}} disabled={confirming[r.routeId + 'receive']} onClick={() => onConfirm(r.routeId, 'receive')}>
            <Check size={13} strokeWidth={2.5}/>Приёмка
          </button>
        )}
        <button className={`btn btn-sm btn-secondary ${styles.mCardActBtn}`} style={{display:'inline-flex',alignItems:'center',gap:5}} onClick={() => onEdit(r.routeId)}><Pencil size={13} strokeWidth={2}/>Изменить</button>
      </div>
    </div>
  )
})

// ─── Drivers view ─────────────────────────────────────────────────────────────

function DriversView({ data, loading, error }) {
  const [sort, setSort] = useLocalState('sh_drivers_sort', { key: null, dir: null })
  const [detailSort, setDetailSort] = useState(new Map())
  const [expanded, setExpanded] = useState(new Set())

  const toggleExpand = id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSort   = col => setSort(s => toggleSortState(s, col))
  const toggleDetailSort = (owner, col) => {
    setDetailSort(m => {
      const n = new Map(m)
      const cur = n.get(owner) || { key: null, dir: null }
      n.set(owner, toggleSortState(cur, col))
      return n
    })
  }

  if (loading) return <div className={styles.loading}>Загрузка...</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!data.length) return <div className={styles.empty}>Нет данных.</div>

  const sorted = sortedData(data, sort)

  return (
    <div>
      {/* Mobile cards */}
      <div className={styles.mCardList}>
        {sorted.map(d => (
          <div key={d.name} className={styles.mCard}>
            <div className={styles.mCardTop} onClick={() => toggleExpand(d.name)}>
              <div className={styles.mCardMain}>
                <div className={styles.mCardRoute}>{d.name}</div>
                {d.phone ? <div className={styles.mCardDate}>{d.phone}</div> : null}
              </div>
              <span className={styles.mCardStatus} style={{background:'var(--bg)',color:'var(--text-muted)'}}>
                {d.routeCount} марш.
              </span>
            </div>
            <div className={styles.mCardMetrics}>
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК отгр.</span>
                <span className={styles.mCardMetricVal}>{d.shippedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК прин.</span>
                <span className={styles.mCardMetricVal}>{d.receivedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>Разница</span>
                <span className={styles.mCardMetricVal}><DiffVal diff={d.diff} /></span>
              </div>
              {d.rokhlyaDebt != null && d.rokhlyaDebt !== 0 && (() => {
                const debtRoute = (d.routes || [])
                  .filter(r => (r.shippedRokhlya - r.receivedRokhlya) > 0)
                  .sort((a, b) => a.date.localeCompare(b.date))[0] || null
                return <>
                  <div className={styles.mCardMetricDivider} />
                  <div className={styles.mCardMetric}>
                    <span className={styles.mCardMetricLabel}>Долг рохлей</span>
                    <span className={styles.mCardMetricVal} style={{color: d.rokhlyaDebt > 0 ? '#e65100' : '#388e3c'}}>
                      {d.rokhlyaDebt}
                      {debtRoute && <span style={{fontSize:11, fontWeight:400, display:'block', color:'#e65100'}}>
                        с {fmtDate(debtRoute.date)} · {debtRoute.routeNumber}
                      </span>}
                    </span>
                  </div>
                </>
              })()}
            </div>
            {expanded.has(d.name) && (
              <div className={styles.mCardDetail}>
                {(d.routes || []).map(r => (
                  <div key={r.routeId} className={styles.mCardCfzRow}>
                    <span className={styles.mCardCfzAddr}>{r.routeNumber} · {fmtDate(r.date)}</span>
                    <span className={styles.mCardCfzNums}>↗{r.shippedRK ?? '—'} / ↙{r.receivedRK ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className={styles.desktopOnly}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Водитель</th>
              {['routeCount','shippedTotal','shippedPallets','shippedBoxes','shippedRokhlya','receivedTotal','receivedPallets','receivedBoxes','receivedRokhlya','rokhlyaDebt','diff'].map(col => (
                <th key={col} className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort(col)}>
                  {{ routeCount:'Маршрутов', shippedTotal:'РК отгр.', shippedPallets:'Пал. отгр.', shippedBoxes:'Ящ. отгр.', shippedRokhlya:'Рохли↗', receivedTotal:'РК прин.', receivedPallets:'Пал. прин.', receivedBoxes:'Ящ. прин.', receivedRokhlya:'Рохли↙', rokhlyaDebt:'Долг рохлей', diff:'Разница РК' }[col]}
                  {' '}<SortArrow sort={sort} col={col} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(d => (
              <DriverRows
                key={d.name}
                driver={d}
                expanded={expanded.has(d.name)}
                detailSort={detailSort.get(d.name) || { key: null, dir: null }}
                onToggle={() => toggleExpand(d.name)}
                onDetailSort={col => toggleDetailSort(d.name, col)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DriverRows({ driver: d, expanded, detailSort: ds, onToggle, onDetailSort }) {
  return (
    <>
      <tr className={styles.trMain} onClick={onToggle}>
        <td className={styles.tdBold}>{d.name}</td>
        <td className={styles.tdNum}>{d.routeCount}</td>
        <td className={styles.tdNum}>{d.shippedTotal || 0}</td>
        <td className={styles.tdNum}>{d.shippedPallets || 0}</td>
        <td className={styles.tdNum}>{d.shippedBoxes || 0}</td>
        <td className={styles.tdNum}>{d.shippedRokhlya || 0}</td>
        <td className={styles.tdNum}>{d.receivedTotal || 0}</td>
        <td className={styles.tdNum}>{d.receivedPallets || 0}</td>
        <td className={styles.tdNum}>{d.receivedBoxes || 0}</td>
        <td className={styles.tdNum}>{d.receivedRokhlya || 0}</td>
        <td className={styles.tdNum}>{d.rokhlyaDebt != null && d.rokhlyaDebt !== 0 ? (() => {
          const debtRoute = (d.routes || []).filter(r => (r.shippedRokhlya - r.receivedRokhlya) > 0).sort((a, b) => a.date.localeCompare(b.date))[0] || null
          return <span style={{color: d.rokhlyaDebt > 0 ? '#e65100' : '#388e3c', fontWeight:600}}>
            {d.rokhlyaDebt}
            {debtRoute && <span style={{fontSize:11, fontWeight:400, display:'block'}}>с {fmtDate(debtRoute.date)}<br/>{debtRoute.routeNumber}</span>}
          </span>
        })() : <span className={styles.naVal}>—</span>}</td>
        <td className={styles.tdNum}><DiffVal diff={d.diff} /></td>
      </tr>
      {expanded && <DriverDetailRow driver={d} detailSort={ds} onDetailSort={onDetailSort} />}
    </>
  )
}

function DriverDetailRow({ driver: d, detailSort: ds, onDetailSort }) {
  const cfzMap = new Map()
  for (const route of d.routes || []) {
    for (const { address } of route.cfzAddresses || []) {
      if (!address) continue
      if (!cfzMap.has(address)) cfzMap.set(address, { address, routeCount: 0, shipped: 0, received: 0, shippedPallets: 0, receivedPallets: 0 })
      const e = cfzMap.get(address)
      e.routeCount++
      if (route.shippedRK  != null) e.shipped  += route.shippedRK
      if (route.receivedRK != null) e.received += route.receivedRK
      if (route.shippedPallets  != null) e.shippedPallets  += route.shippedPallets
      if (route.receivedPallets != null) e.receivedPallets += route.receivedPallets
    }
  }
  let cfzList = Array.from(cfzMap.values()).map(e => ({
    ...e,
    diff: (e.shipped > 0 || e.received > 0) ? e.received - e.shipped : null,
  }))
  if (ds.key && ds.dir) {
    cfzList = cfzList.sort((a, b) => {
      const av = a[ds.key] ?? 0, bv = b[ds.key] ?? 0
      return ds.dir === 'desc' ? bv - av : av - bv
    })
  } else {
    cfzList.sort((a, b) => a.address.localeCompare(b.address, 'ru'))
  }

  return (
    <tr>
      <td colSpan={10} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
        <div className={styles.detailBlock}>
          {cfzList.length > 0
            ? <table className={styles.detailTable}>
                <thead>
                  <tr>
                    <th>Адрес ЦФЗ</th>
                    {['routeCount','shipped','received','diff'].map(col => (
                      <th key={col} className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort(col)}>
                        {{ routeCount:'Маршрутов', shipped:'Отгружено', received:'Принято', diff:'Разница' }[col]}
                        {' '}<SortArrow sort={ds} col={col} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cfzList.map(e => (
                    <tr key={e.address}>
                      <td>{e.address}</td>
                      <td className={styles.tdNum}>{e.routeCount}</td>
                      <td className={styles.tdNum}>{e.shipped}</td>
                      <td className={styles.tdNum}>{e.received}</td>
                      <td className={styles.tdNum}><DiffVal diff={e.diff} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            : <div className={styles.empty}>Адреса ЦФЗ не указаны в маршрутах этого водителя</div>
          }
        </div>
      </td>
    </tr>
  )
}

// ─── CFZ view ─────────────────────────────────────────────────────────────────

function CfzView({ data, loading, error }) {
  const [sort, setSort] = useLocalState('sh_cfz_sort', { key: null, dir: null })
  const [detailSort, setDetailSort] = useState(new Map())
  const [expanded, setExpanded] = useState(new Set())

  const toggleExpand = id => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSort   = col => setSort(s => toggleSortState(s, col))
  const toggleDetailSort = (owner, col) => {
    setDetailSort(m => {
      const n = new Map(m)
      const cur = n.get(owner) || { key: null, dir: null }
      n.set(owner, toggleSortState(cur, col))
      return n
    })
  }

  if (loading) return <div className={styles.loading}>Загрузка...</div>
  if (error)   return <div className={styles.error}>{error}</div>
  if (!data.length) return <div className={styles.empty}>Нет данных.</div>

  const sorted = sortedData(data, sort)

  return (
    <div>
      {/* Mobile cards */}
      <div className={styles.mCardList}>
        {sorted.map(entry => (
          <div key={entry.address} className={styles.mCard}>
            <div className={styles.mCardTop} onClick={() => toggleExpand(entry.address)}>
              <div className={styles.mCardMain}>
                <div className={styles.mCardRoute} style={{fontSize:13}}>{entry.address}</div>
              </div>
              <span className={styles.mCardStatus} style={{background:'var(--bg)',color:'var(--text-muted)'}}>
                {entry.routeCount} марш.
              </span>
            </div>
            <div className={styles.mCardMetrics}>
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК отгр.</span>
                <span className={styles.mCardMetricVal}>{entry.shippedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>РК прин.</span>
                <span className={styles.mCardMetricVal}>{entry.receivedTotal || 0}</span>
              </div>
              <div className={styles.mCardMetricDivider} />
              <div className={styles.mCardMetric}>
                <span className={styles.mCardMetricLabel}>Разница</span>
                <span className={styles.mCardMetricVal}><DiffVal diff={entry.diff} /></span>
              </div>
            </div>
            {expanded.has(entry.address) && (
              <div className={styles.mCardDetail}>
                {(entry.routes || []).map(r => (
                  <div key={r.routeId} className={styles.mCardCfzRow}>
                    <span className={styles.mCardCfzAddr}>{r.routeNumber} · {fmtDate(r.date)} · {shortFio(r.driver?.name)}</span>
                    <span className={styles.mCardCfzNums}>↗{r.shippedRK ?? '—'} / ↙{r.receivedRK ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className={styles.desktopOnly}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Адрес ЦФЗ</th>
              {['routeCount','shippedTotal','shippedPallets','shippedBoxes','receivedTotal','receivedPallets','receivedBoxes','diff'].map(col => (
                <th key={col} className={`${styles.thNum} ${styles.thSort}`} onClick={() => toggleSort(col)}>
                  {{ routeCount:'Маршрутов', shippedTotal:'РК отгр.', shippedPallets:'Пал. отгр.', shippedBoxes:'Ящ. отгр.', receivedTotal:'РК прин.', receivedPallets:'Пал. прин.', receivedBoxes:'Ящ. прин.', diff:'Разница' }[col]}
                  {' '}<SortArrow sort={sort} col={col} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(entry => (
              <CfzRows
                key={entry.address}
                entry={entry}
                expanded={expanded.has(entry.address)}
                detailSort={detailSort.get(entry.address) || { key: null, dir: null }}
                onToggle={() => toggleExpand(entry.address)}
                onDetailSort={col => toggleDetailSort(entry.address, col)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CfzRows({ entry, expanded, detailSort: ds, onToggle, onDetailSort }) {
  return (
    <>
      <tr className={styles.trMain} onClick={onToggle}>
        <td className={styles.tdBold}>{entry.address}</td>
        <td className={styles.tdNum}>{entry.routeCount}</td>
        <td className={styles.tdNum}>{entry.shippedTotal || 0}</td>
        <td className={styles.tdNum}>{entry.shippedPallets || 0}</td>
        <td className={styles.tdNum}>{entry.shippedBoxes || 0}</td>
        <td className={styles.tdNum}>{entry.receivedTotal || 0}</td>
        <td className={styles.tdNum}>{entry.receivedPallets || 0}</td>
        <td className={styles.tdNum}>{entry.receivedBoxes || 0}</td>
        <td className={styles.tdNum}><DiffVal diff={entry.diff} /></td>
      </tr>
      {expanded && <CfzDetailRow entry={entry} detailSort={ds} onDetailSort={onDetailSort} />}
    </>
  )
}

function CfzDetailRow({ entry, detailSort: ds, onDetailSort }) {
  let routes = [...(entry.routes || [])]
  if (ds.key && ds.dir) {
    routes.sort((a, b) => {
      if (ds.key === 'date') { const av = a.date || '', bv = b.date || ''; return ds.dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv) }
      const av = a[ds.key] ?? 0, bv = b[ds.key] ?? 0
      return ds.dir === 'desc' ? bv - av : av - bv
    })
  }

  return (
    <tr>
      <td colSpan={9} style={{ padding: 0, borderBottom: '1px solid var(--border)' }}>
        <div className={styles.detailBlock}>
          {routes.length > 0
            ? <table className={styles.detailTable}>
                <thead>
                  <tr>
                    <th className={styles.thSort} onClick={() => onDetailSort('date')}>Дата <SortArrow sort={ds} col="date" /></th>
                    <th>Маршрут</th><th>Водитель</th>
                    <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort('shippedRK')}>РК отгр. <SortArrow sort={ds} col="shippedRK" /></th>
                    <th className={styles.thNum}>Пал. отгр.</th>
                    <th className={styles.thNum}>Ящ. отгр.</th>
                    <th className={styles.thNum}>Дата отгр.</th>
                    <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort('receivedRK')}>РК прин. <SortArrow sort={ds} col="receivedRK" /></th>
                    <th className={styles.thNum}>Пал. прин.</th>
                    <th className={styles.thNum}>Ящ. прин.</th>
                    <th className={styles.thNum}>Дата прин.</th>
                    <th className={`${styles.thNum} ${styles.thSort}`} onClick={() => onDetailSort('diff')}>Разница <SortArrow sort={ds} col="diff" /></th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map(r => (
                    <tr key={r.routeId}>
                      <td>{fmtDate(r.date)}</td>
                      <td>{r.routeNumber || '—'}</td>
                      <td title={r.driver?.name || ''}>{shortFio(r.driver?.name) || '—'}</td>
                      <td className={styles.tdNum}>{r.shippedRK != null ? r.shippedRK : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.shippedPallets > 0 ? r.shippedPallets : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.shippedBoxes > 0 ? r.shippedBoxes : <span className={styles.naVal}>—</span>}</td>
                      <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.shippedAt)}</td>
                      <td className={styles.tdNum}>{r.receivedRK != null ? r.receivedRK : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.receivedPallets > 0 ? r.receivedPallets : <span className={styles.naVal}>—</span>}</td>
                      <td className={styles.tdNum}>{r.receivedBoxes > 0 ? r.receivedBoxes : <span className={styles.naVal}>—</span>}</td>
                      <td className={`${styles.tdMuted} ${styles.tdDate}`}>{fmtDateTime(r.receivedAt)}</td>
                      <td className={styles.tdNum}><DiffVal diff={r.diff} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            : <div className={styles.empty}>Маршруты не найдены</div>
          }
        </div>
      </td>
    </tr>
  )
}

// ─── Fetch WMS modal ───────────────────────────────────────────────────────────

function FetchModal({ onClose, onDone }) {
  const moscowNow = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const moscowDate = d => { const t = new Date(moscowNow); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10) }

  const [dateFrom, setDateFrom] = useState(moscowDate(-1))
  const [dateTo,   setDateTo]   = useState(moscowDate(+1))
  const [result, setResult]     = useState('')
  const [loading, setLoading]   = useState(false)

  const handleFetch = async () => {
    if (!dateFrom || !dateTo) { setResult('Выберите даты'); return }
    const token = getStoredToken()
    if (!token) { setResult('Нет токена — войдите в систему заново'); return }
    setLoading(true)
    setResult('Загружаю маршруты из WMS...')
    try {
      const res = await api.fetchRkFromWms({ dateFrom, dateTo, token, onProgress: msg => setResult(msg) })
      if (res.ok) {
        setResult(`Маршрутов: ${res.routes}, добавлено: ${res.added}, обновлено: ${res.updated}`)
        setTimeout(() => { onClose(); onDone() }, 2000)
      } else {
        setResult(`Ошибка: ${res.error}`)
      }
    } catch (err) {
      setResult(`Ошибка: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modalBox}>
        <div className={styles.modalHeader}>
          <span>Загрузка из WMS</span>
          <button className={styles.modalClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
        </div>
        <p className={styles.modalHint}>Загрузит маршруты из WMS за указанный период и сохранит в базу.</p>
        <div className={styles.fetchForm}>
          <label className={styles.fetchFormLabel}>
            С
            <input type="date" className={styles.shInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </label>
          <label className={styles.fetchFormLabel}>
            По
            <input type="date" className={styles.shInput} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </label>
        </div>
        <div className={styles.modalResult}>{result}</div>
        <div className={styles.modalFooter}>
          <button className="btn btn-secondary" onClick={onClose}>Закрыть</button>
          <button className="btn btn-primary" disabled={loading} onClick={handleFetch}>Загрузить</button>
        </div>
      </div>
    </div>
  )
}

// ─── Form modal (4 steps) ──────────────────────────────────────────────────────

function FormModal({ initialRoute, onClose, onSaved }) {
  const isEdit = !!initialRoute

  const [step, setStep] = useState(isEdit ? 4 : 1)
  const [formType, setFormType] = useState(null)   // 'ship' | 'receive'
  const [formWorker, setFormWorker] = useState('')
  const [formRoute, setFormRoute] = useState(isEdit ? initialRoute : null)
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  // Create mode: photos
  const [formPhotos, setFormPhotos] = useState([])

  // Edit mode: driver
  const [editDriverName, setEditDriverName] = useState(isEdit ? (initialRoute.driver?.name || '') : '')

  // Edit mode: ship/recv sections
  const [editShip, setEditShip] = useState(isEdit ? {
    by: initialRoute.shipment?.by || '',
    gate: initialRoute.shipment?.gate || '',
    tempBefore: initialRoute.shipment?.tempBefore ?? '',
    tempAfter: initialRoute.shipment?.tempAfter ?? '',
    pallets: initialRoute.shipment?.pallets ?? '',
    rokhlya: initialRoute.shipment?.rokhlya ?? '',
    existingPhotos: [...(initialRoute.shipment?.photos || [])],
    newPhotos: [],
  } : null)
  const [editRecv, setEditRecv] = useState(isEdit ? {
    by: initialRoute.receiving?.by || '',
    gate: initialRoute.receiving?.gate || '',
    pallets: initialRoute.receiving?.pallets ?? '',
    rokhlya: initialRoute.receiving?.rokhlya ?? '',
    existingPhotos: [...(initialRoute.receiving?.photos || [])],
    newPhotos: [],
  } : null)

  // Step 3: route search
  const [routesList, setRoutesList] = useState([])
  const [routesLoading, setRoutesLoading] = useState(false)
  const [routeSearch, setRouteSearch] = useState('')

  // Step 4 create: gate + cfz inputs
  const gateRef  = useRef('')
  const [manualCfz, setManualCfz] = useState([])
  const [manualAddr, setManualAddr] = useState('')
  const [manualRk,   setManualRk]   = useState('')
  const cfzInputsRef = useRef({})

  const overlayRef = useRef(null)
  const [mdOnBg, setMdOnBg] = useState(false)

  const loadRoutes = useCallback(async q => {
    const status = formType === 'ship' ? 'unshipped' : 'pending'
    setRoutesLoading(true)
    try {
      const routes = await api.getRkRoutes({ q, status })
      setRoutesList(routes)
    } catch (err) {
      setRoutesList([])
    } finally { setRoutesLoading(false) }
  }, [formType])

  useEffect(() => {
    if (step === 3) { loadRoutes('') }
  }, [step, loadRoutes])

  useEffect(() => {
    if (step !== 3) return
    const timer = setTimeout(() => loadRoutes(routeSearch), 300)
    return () => clearTimeout(timer)
  }, [routeSearch, step, loadRoutes])

  const validateStep = () => {
    if (step === 1 && !formWorker.trim()) return 'Введите ФИО кладовщика'
    if (step === 2 && !formType)          return 'Выберите тип операции'
    if (step === 3 && !formRoute)         return 'Выберите маршрут'
    return null
  }

  const goNext = () => {
    const err = validateStep()
    if (err) { setFormError(err); return }
    setFormError('')
    setStep(s => s + 1)
  }

  const goBack = () => {
    if (isEdit) { onClose(); return }
    setFormError('')
    setStep(s => s - 1)
  }

  const collectCfzInputs = cls => {
    const out = []
    document.querySelectorAll(`.${cls}`).forEach(inp => {
      const v = inp.value.trim()
      if (v !== '' && !isNaN(Number(v)) && inp.dataset.addr) {
        out.push({ address: inp.dataset.addr, rk: Number(v) })
      }
    })
    return out
  }

  const handleSubmit = async () => {
    if (!isEdit) {
      // Collect gate + items from DOM
      const gate  = document.getElementById('sh-react-gate')?.value.trim() || null
      const items = collectCfzInputs('sh-react-cfz-rk')
      // Also include manual items
      manualCfz.forEach(m => items.push(m))
      const dedupe = []
      const seen = new Set()
      for (const it of items) { if (!seen.has(it.address)) { dedupe.push(it); seen.add(it.address) } }
      if (!dedupe.length) { setFormError('Введите количество РК хотя бы для одного ЦФЗ'); return }

      setSubmitting(true)
      setFormError('Сохраняю...')
      try {
        let photoUrls = []
        if (formPhotos.length) {
          const r = await api.uploadRkPhotos(formPhotos)
          if (r.ok) photoUrls = r.urls
        }
        const payload = { by: formWorker, gate, items: dedupe, photos: photoUrls }
        const res = formType === 'ship'
          ? await api.submitRkShipment(formRoute.routeId, payload)
          : await api.submitRkReceiving(formRoute.routeId, payload)
        if (!res.ok) { setFormError(res.error); setSubmitting(false); return }
        onSaved(formRoute.routeId, res.route)
        setSuccess(true)
        setFormError('')
        setTimeout(() => onClose(), 1500)
      } catch (e) { setFormError(e.message); setSubmitting(false) }
    } else {
      // Edit mode
      const shipItems = collectCfzInputs('sh-react-ship-rk')
      const shipPalletsRaw = collectCfzInputs('sh-react-ship-pallets')
      const shipPalletsLookup = Object.fromEntries(shipPalletsRaw.map(i => [i.address, i.rk]))
      shipItems.forEach(i => { i.pallets = shipPalletsLookup[i.address] ?? 0 })
      const shipBoxesRaw = collectCfzInputs('sh-react-ship-boxes')
      const shipBoxesLookup = Object.fromEntries(shipBoxesRaw.map(i => [i.address, i.rk]))
      shipItems.forEach(i => { i.boxes = shipBoxesLookup[i.address] ?? 0 })
      const recvItems = collectCfzInputs('sh-react-recv-rk')
      const recvPalletsRaw = collectCfzInputs('sh-react-recv-pallets')
      const recvPalletsLookup = Object.fromEntries(recvPalletsRaw.map(i => [i.address, i.rk]))
      recvItems.forEach(i => { i.pallets = recvPalletsLookup[i.address] ?? 0 })
      const recvBoxesRaw = collectCfzInputs('sh-react-recv-boxes')
      const recvBoxesLookup = Object.fromEntries(recvBoxesRaw.map(i => [i.address, i.rk]))
      recvItems.forEach(i => { i.boxes = recvBoxesLookup[i.address] ?? 0 })
      const shipBy   = document.getElementById('sh-react-edit-ship-by')?.value.trim() || ''
      const shipGate = document.getElementById('sh-react-edit-ship-gate')?.value.trim() || ''
      const parseTemp = v => { const s = String(v ?? '').replace(',', '.'); return s !== '' && !isNaN(parseFloat(s)) ? parseFloat(s) : null }
      const shipTempBefore = parseTemp(document.getElementById('sh-react-edit-ship-temp-before')?.value)
      const shipTempAfter  = parseTemp(document.getElementById('sh-react-edit-ship-temp-after')?.value)
      const shipRokhlyaRaw = document.getElementById('sh-react-edit-ship-rokhlya')?.value.trim()
      const shipRokhlya    = shipRokhlyaRaw !== '' && shipRokhlyaRaw != null ? Number(shipRokhlyaRaw) : null
      const recvBy   = document.getElementById('sh-react-edit-recv-by')?.value.trim() || ''
      const recvGate = document.getElementById('sh-react-edit-recv-gate')?.value.trim() || ''
      const recvRokhlyaRaw = document.getElementById('sh-react-edit-recv-rokhlya')?.value.trim()
      const recvRokhlya    = recvRokhlyaRaw !== '' && recvRokhlyaRaw != null ? Number(recvRokhlyaRaw) : null

      setSubmitting(true)
      setFormError('Сохраняю...')
      try {
        let shipPhotos = [...editShip.existingPhotos]
        if (editShip.newPhotos.length) {
          const r = await api.uploadRkPhotos(editShip.newPhotos)
          if (r.ok) shipPhotos = [...shipPhotos, ...r.urls]
        }
        let recvPhotos = [...editRecv.existingPhotos]
        if (editRecv.newPhotos.length) {
          const r = await api.uploadRkPhotos(editRecv.newPhotos)
          if (r.ok) recvPhotos = [...recvPhotos, ...r.urls]
        }

        let lastRoute = null
        const origDriverName = formRoute.driver?.name || ''
        if (editDriverName.trim() !== origDriverName) {
          const r = await api.updateRkDriver(formRoute.routeId, { name: editDriverName.trim() })
          if (r.ok) lastRoute = r.route
        }
        if (formRoute.shipment || shipItems.length) {
          const r = await api.updateRkShipment(formRoute.routeId, { by: shipBy, gate: shipGate, tempBefore: shipTempBefore, tempAfter: shipTempAfter, rokhlya: shipRokhlya, items: shipItems, photos: shipPhotos })
          if (r.ok) lastRoute = r.route
        }
        if (formRoute.receiving || recvItems.length) {
          const r = await api.updateRkReceiving(formRoute.routeId, { by: recvBy, gate: recvGate, rokhlya: recvRokhlya, items: recvItems, photos: recvPhotos })
          if (r.ok) lastRoute = r.route
        }
        if (lastRoute) onSaved(formRoute.routeId, lastRoute)
        setSuccess(true)
        setFormError('')
        setTimeout(() => onClose(), 1500)
      } catch (e) { setFormError(e.message); setSubmitting(false) }
    }
  }

  const title = isEdit ? 'Редактировать маршрут' : (step === 1 ? 'Шаг 1 — Кладовщик' : step === 2 ? 'Шаг 2 — Тип операции' : step === 3 ? 'Шаг 3 — Маршрут' : (formType === 'ship' ? 'Шаг 4 — Данные отгрузки' : 'Шаг 4 — Данные приёмки'))

  return (
    <div
      className={styles.modalOverlay}
      ref={overlayRef}
      onMouseDown={e => setMdOnBg(e.target === e.currentTarget)}
      onClick={e => { if (e.target === e.currentTarget && mdOnBg) onClose() }}
    >
      <div className={`${styles.modalBox} ${styles.modalBoxLg}`}>
        <div className={styles.modalHeader}>
          <span>{title}</span>
          <button className={styles.modalClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
        </div>

        {!isEdit && (
          <div className={styles.formSteps}>
            {[1,2,3,4].map((n, i) => (
              <>
                {i > 0 && <div key={`line-${n}`} className={styles.formStepLine} />}
                <div
                  key={n}
                  className={`${styles.formStepDot} ${step === n ? styles.formStepDotActive : ''} ${step > n ? styles.formStepDotDone : ''}`}
                >{n}</div>
              </>
            ))}
          </div>
        )}

        <div id="sh-react-form-body">
          {success
            ? <div className={styles.formSuccess}>
                <div className={styles.formSuccessIcon}><CheckCircle2 size={40} strokeWidth={1.5} style={{color:'var(--green)'}}/></div>
                <div>{isEdit ? 'Данные обновлены' : (formType === 'ship' ? 'Отгрузка' : 'Приёмка') + ' сохранена'}</div>
              </div>
            : <>
                {step === 1 && (
                  <label className={styles.formLabel}>
                    Фамилия и инициалы кладовщика
                    <input autoFocus type="text" className={styles.shInput} placeholder="Иванов И.И." value={formWorker} onChange={e => setFormWorker(e.target.value)} onKeyDown={e => e.key === 'Enter' && goNext()} />
                  </label>
                )}

                {step === 2 && (
                  <div className={styles.typeCards}>
                    {[
                      { type: 'ship',    Icon: Truck,       label: 'Отгрузка',  desc: 'РК уезжают с водителем' },
                      { type: 'receive', Icon: PackageOpen, label: 'Приёмка',   desc: 'Водитель вернул РК' },
                    ].map(({ type, Icon, label, desc }) => (
                      <div
                        key={type}
                        className={`${styles.typeCard} ${formType === type ? styles.typeCardSelected : ''}`}
                        onClick={() => { setFormType(type); setFormError('') }}
                      >
                        <div className={styles.typeIcon}><Icon size={24} strokeWidth={1.5}/></div>
                        <div className={styles.typeLabel}>{label}</div>
                        <div className={styles.typeDesc}>{desc}</div>
                      </div>
                    ))}
                  </div>
                )}

                {step === 3 && (
                  <>
                    <input
                      autoFocus
                      type="text"
                      className={styles.shInput}
                      placeholder="Поиск по водителю, маршруту..."
                      style={{ width: '100%', boxSizing: 'border-box', marginBottom: 10 }}
                      value={routeSearch}
                      onChange={e => setRouteSearch(e.target.value)}
                    />
                    {routesLoading
                      ? <div className={styles.loading}>Загрузка...</div>
                      : !routesList.length
                        ? <div className={styles.empty}>Нет маршрутов</div>
                        : <div className={styles.routeCards}>
                            {routesList.map(r => (
                              <div
                                key={r.routeId}
                                className={`${styles.routeCard} ${formRoute?.routeId === r.routeId ? styles.routeCardSelected : ''}`}
                                onClick={() => { setFormRoute(r); setFormError('') }}
                              >
                                <span className={styles.routeCardDate}>{fmtDate(r.date)}</span>
                                <span className={styles.routeCardNum}>{r.routeNumber || '—'}</span>
                                <span className={styles.routeCardDriver} title={r.driver?.name || ''}>{shortFio(r.driver?.name) || '—'}</span>
                                {r.vehicle && <span className={styles.routeCardVehicle}>{r.vehicle.model} {r.vehicle.number}</span>}
                                {(r.cfzAddresses || []).length > 0 && <span className={styles.routeCardCfz}>{r.cfzAddresses.length} ЦФЗ</span>}
                              </div>
                            ))}
                          </div>
                    }
                  </>
                )}

                {step === 4 && !isEdit && formRoute && (
                  <FormStep4Create
                    route={formRoute}
                    formType={formType}
                    formPhotos={formPhotos}
                    manualCfz={manualCfz}
                    manualAddr={manualAddr}
                    manualRk={manualRk}
                    onPhotosChange={setFormPhotos}
                    onManualCfzChange={setManualCfz}
                    onManualAddrChange={setManualAddr}
                    onManualRkChange={setManualRk}
                  />
                )}

                {step === 4 && isEdit && (
                  <FormStep4Edit
                    route={formRoute}
                    editShip={editShip}
                    editRecv={editRecv}
                    editDriverName={editDriverName}
                    onEditShipChange={setEditShip}
                    onEditRecvChange={setEditRecv}
                    onEditDriverNameChange={setEditDriverName}
                  />
                )}
              </>
          }
        </div>

        {!success && <div className={styles.formError}>{formError}</div>}

        {!success && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {step > 1 && <button className="btn btn-secondary" onClick={goBack}>{isEdit ? 'Отмена' : '← Назад'}</button>}
            {step < 4  && <button className="btn btn-primary" onClick={goNext}>Далее →</button>}
            {step === 4 && <button className="btn btn-primary" disabled={submitting} onClick={handleSubmit}>Сохранить</button>}
          </div>
        )}
      </div>
    </div>
  )
}

function FormStep4Create({ route, formType, formPhotos, manualCfz, manualAddr, manualRk, onPhotosChange, onManualCfzChange, onManualAddrChange, onManualRkChange }) {
  const cfzList   = route.cfzAddresses || []
  const shipItems = route.shipment?.items || []

  const addManual = () => {
    if (!manualAddr.trim() || !manualRk.trim()) return
    onManualCfzChange(prev => [...prev, { address: manualAddr.trim(), rk: Number(manualRk) }])
    onManualAddrChange('')
    onManualRkChange('')
  }

  return (
    <>
      <div className={styles.formRouteSummary}>
        <span className={styles.formRouteNum}>{route.routeNumber || '—'}</span>
        <span className={styles.formRouteDriver} title={route.driver?.name || ''}>{shortFio(route.driver?.name) || '—'}</span>
        <span className={styles.formRouteDate}>{fmtDate(route.date)}</span>
      </div>

      <label className={styles.formLabel}>
        Ворота
        <input id="sh-react-gate" type="text" className={`${styles.shInput} ${styles.inputSm}`} placeholder="Номер ворот" />
      </label>

      <div className={styles.formCfzSection}>
        <div className={styles.formSectionTitle}>Количество РК по каждому ЦФЗ</div>
        {cfzList.length > 0
          ? cfzList.map(a => {
              const prevRk = shipItems.find(x => x.address === a.address)?.rk ?? ''
              const curRk  = formType === 'receive' ? prevRk : ''
              return (
                <div key={a.address} className={styles.formCfzRow}>
                  <span className={styles.formCfzAddr}>{a.address}</span>
                  {formType === 'receive' && prevRk !== '' && <span className={styles.formCfzHint}>отгружено: {prevRk}</span>}
                  <input
                    type="number"
                    className={`${styles.shInput} ${styles.inputRk} sh-react-cfz-rk`}
                    data-addr={a.address}
                    min="0"
                    placeholder="0"
                    defaultValue={curRk}
                  />
                </div>
              )
            })
          : <>
              <div className={styles.empty}>ЦФЗ не указаны — введите вручную</div>
              <div className={styles.formCfzRow}>
                <input type="text" className={styles.shInput} placeholder="Адрес ЦФЗ" value={manualAddr} onChange={e => onManualAddrChange(e.target.value)} />
                <input type="number" className={`${styles.shInput} ${styles.inputRk}`} min="0" placeholder="РК" value={manualRk} onChange={e => onManualRkChange(e.target.value)} />
                <button className="btn btn-sm btn-secondary" onClick={addManual}>+</button>
              </div>
              {manualCfz.map((m, i) => (
                <div key={i} className={styles.formCfzRow}>
                  <span className={styles.formCfzAddr}>{m.address}</span>
                  <input
                    type="number"
                    className={`${styles.shInput} ${styles.inputRk} sh-react-cfz-rk`}
                    data-addr={m.address}
                    min="0"
                    defaultValue={m.rk}
                  />
                  <button className="btn btn-xs btn-secondary" onClick={() => onManualCfzChange(prev => prev.filter((_, j) => j !== i))}><X size={12} strokeWidth={2}/></button>
                </div>
              ))}
            </>
        }
      </div>

      <div className={styles.formPhotoSection}>
        <div className={styles.formSectionTitle}>Фотографии</div>
        <label className={styles.photoUploadLabel}>
          <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => onPhotosChange(prev => [...prev, ...Array.from(e.target.files)])} />
          <span className="btn btn-sm btn-secondary" style={{display:'inline-flex',alignItems:'center',gap:5}}><Camera size={13} strokeWidth={2}/>Добавить фото</span>
        </label>
        <div className={styles.photoPreviewRow}>
          {formPhotos.map((f, i) => (
            <div key={i} className={styles.photoPreviewItem}>
              <img src={URL.createObjectURL(f)} className={styles.photoThumbImg} alt="" />
              <button className={styles.photoRemoveBtn} onClick={() => onPhotosChange(prev => prev.filter((_, j) => j !== i))}><X size={13} strokeWidth={2}/></button>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function FormStep4Edit({ route, editShip, editRecv, editDriverName, onEditShipChange, onEditRecvChange, onEditDriverNameChange }) {
  const cfzList    = route.cfzAddresses || []
  const shipItemMap    = Object.fromEntries((route.shipment?.items  || []).map(i => [i.address, i.rk]))
  const shipPalletsMap = Object.fromEntries((route.shipment?.items  || []).map(i => [i.address, i.pallets ?? '']))
  const shipBoxesMap   = Object.fromEntries((route.shipment?.items  || []).map(i => [i.address, i.boxes ?? '']))
  const recvItemMap    = Object.fromEntries((route.receiving?.items || []).map(i => [i.address, i.rk]))
  const recvPalletsMap = Object.fromEntries((route.receiving?.items || []).map(i => [i.address, i.pallets ?? '']))
  const recvBoxesMap   = Object.fromEntries((route.receiving?.items || []).map(i => [i.address, i.boxes ?? '']))

  const removeExistingPhoto = (section, idx) => {
    const setter = section === 'ship' ? onEditShipChange : onEditRecvChange
    setter(prev => ({ ...prev, existingPhotos: prev.existingPhotos.filter((_, i) => i !== idx) }))
  }
  const removeNewPhoto = (section, idx) => {
    const setter = section === 'ship' ? onEditShipChange : onEditRecvChange
    setter(prev => ({ ...prev, newPhotos: prev.newPhotos.filter((_, i) => i !== idx) }))
  }
  const addNewPhotos = (section, files) => {
    const setter = section === 'ship' ? onEditShipChange : onEditRecvChange
    setter(prev => ({ ...prev, newPhotos: [...prev.newPhotos, ...Array.from(files)] }))
  }

  const CfzRows = ({ sectionClass, palletsSectionClass, boxesSectionClass, itemMap, palletsMap, boxesMap, hintMap, hintPalletsMap, hintBoxesMap }) => cfzList.length > 0
    ? cfzList.map(a => {
        const cur = itemMap[a.address] ?? ''
        const curPallets = palletsMap?.[a.address] ?? ''
        const curBoxes = boxesMap?.[a.address] ?? ''
        return (
          <div key={a.address} className={styles.formCfzRow}>
            <span className={styles.formCfzAddr}>{a.address}</span>
            {hintMap && hintMap[a.address] != null && (
              <span className={styles.formCfzHint}>
                отгр: {hintMap[a.address]} РК{hintPalletsMap?.[a.address] ? ` / ${hintPalletsMap[a.address]} пал.` : ''}{hintBoxesMap?.[a.address] ? ` / ${hintBoxesMap[a.address]} ящ.` : ''}
              </span>
            )}
            <input
              type="number"
              className={`${styles.shInput} ${styles.inputRk} ${sectionClass}`}
              data-addr={a.address}
              min="0"
              placeholder="РК"
              defaultValue={cur}
            />
            <input
              type="number"
              className={`${styles.shInput} ${styles.inputRk} ${palletsSectionClass}`}
              data-addr={a.address}
              min="0"
              placeholder="пал."
              defaultValue={curPallets}
            />
            <input
              type="number"
              className={`${styles.shInput} ${styles.inputRk} ${boxesSectionClass}`}
              data-addr={a.address}
              min="0"
              placeholder="ящ."
              defaultValue={curBoxes}
            />
          </div>
        )
      })
    : <div className={styles.empty}>ЦФЗ не указаны</div>

  const PhotoBlock = ({ section, state }) => (
    <div className={styles.photoPreviewRow}>
      {state.existingPhotos.map((u, i) => (
        <div key={`e-${i}`} className={styles.photoPreviewItem}>
          <a href={u} target="_blank" rel="noreferrer"><img src={u} className={styles.photoThumbImg} alt="фото" /></a>
          <button className={styles.photoRemoveBtn} onClick={() => removeExistingPhoto(section, i)}><X size={13} strokeWidth={2}/></button>
        </div>
      ))}
      {state.newPhotos.map((f, i) => (
        <div key={`n-${i}`} className={styles.photoPreviewItem}>
          <img src={URL.createObjectURL(f)} className={styles.photoThumbImg} alt="" />
          <button className={styles.photoRemoveBtn} onClick={() => removeNewPhoto(section, i)}><X size={13} strokeWidth={2}/></button>
        </div>
      ))}
    </div>
  )

  return (
    <>
      <div className={styles.formRouteSummary}>
        <span className={styles.formRouteNum}>{route.routeNumber || '—'}</span>
        <span className={styles.formRouteDate}>{fmtDate(route.date)}</span>
      </div>

      <label className={styles.formLabel}>
        Водитель
        <input
          type="text"
          className={styles.shInput}
          placeholder="Фамилия И.О."
          value={editDriverName}
          onChange={e => onEditDriverNameChange(e.target.value)}
        />
      </label>

      <div className={styles.editSection}>
        <div className={styles.editSectionHdr}><Truck size={14} strokeWidth={2} style={{marginRight:5}}/>Отгрузка{route.shipment?.confirmed ? <span className={styles.badgeOk}><Check size={12} strokeWidth={2.5}/></span> : ''}</div>
        <div className={styles.editRow2}>
          <label className={`${styles.formLabel} ${styles.editLabelWide}`}>Кладовщик<input id="sh-react-edit-ship-by" type="text" className={styles.shInput} defaultValue={editShip.by} placeholder="Иванов И.И." /></label>
          <label className={styles.formLabel}>Ворота<input id="sh-react-edit-ship-gate" type="text" className={`${styles.shInput} ${styles.inputSm}`} defaultValue={editShip.gate} placeholder="№" /></label>
        </div>
        <div className={styles.editRow2}>
          <label className={styles.formLabel}>Темп. до (°C)<input id="sh-react-edit-ship-temp-before" type="number" className={`${styles.shInput} ${styles.inputSm}`} defaultValue={editShip.tempBefore ?? ''} placeholder="-18" /></label>
          <label className={styles.formLabel}>Темп. после (°C)<input id="sh-react-edit-ship-temp-after" type="number" className={`${styles.shInput} ${styles.inputSm}`} defaultValue={editShip.tempAfter ?? ''} placeholder="-18" /></label>
          <label className={styles.formLabel}>Рохли (отд.)<input id="sh-react-edit-ship-rokhlya" type="number" className={`${styles.shInput} ${styles.inputSm}`} defaultValue={editShip.rokhlya ?? ''} min="0" placeholder="0" /></label>
        </div>
        <div className={styles.formCfzSection}>
          <div className={styles.formSectionTitle}>РК по ЦФЗ <span className={styles.hintClear}>(оставьте пустым — запись удалится)</span></div>
          <CfzRows sectionClass="sh-react-ship-rk" palletsSectionClass="sh-react-ship-pallets" boxesSectionClass="sh-react-ship-boxes" itemMap={shipItemMap} palletsMap={shipPalletsMap} boxesMap={shipBoxesMap} hintMap={null} />
        </div>
        <div className={styles.formPhotoSection}>
          <PhotoBlock section="ship" state={editShip} />
          <label className={styles.photoUploadLabel} style={{ marginTop: 4 }}>
            <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addNewPhotos('ship', e.target.files)} />
            <span className="btn btn-sm btn-secondary" style={{display:'inline-flex',alignItems:'center',gap:5}}><Camera size={13} strokeWidth={2}/>Добавить фото</span>
          </label>
        </div>
      </div>

      <div className={styles.editSection}>
        <div className={styles.editSectionHdr}><PackageOpen size={14} strokeWidth={2} style={{marginRight:5}}/>Приёмка{route.receiving?.confirmed ? <span className={styles.badgeOk}><Check size={12} strokeWidth={2.5}/></span> : ''}</div>
        <div className={styles.editRow2}>
          <label className={`${styles.formLabel} ${styles.editLabelWide}`}>Кладовщик<input id="sh-react-edit-recv-by" type="text" className={styles.shInput} defaultValue={editRecv.by} placeholder="Иванов И.И." /></label>
          <label className={styles.formLabel}>Ворота<input id="sh-react-edit-recv-gate" type="text" className={`${styles.shInput} ${styles.inputSm}`} defaultValue={editRecv.gate} placeholder="№" /></label>
          <label className={styles.formLabel}>Рохли (возвр.)<input id="sh-react-edit-recv-rokhlya" type="number" className={`${styles.shInput} ${styles.inputSm}`} defaultValue={editRecv.rokhlya ?? ''} min="0" placeholder="0" /></label>
        </div>
        <div className={styles.formCfzSection}>
          <div className={styles.formSectionTitle}>РК по ЦФЗ <span className={styles.hintClear}>(оставьте пустым — запись удалится)</span></div>
          <CfzRows sectionClass="sh-react-recv-rk" palletsSectionClass="sh-react-recv-pallets" boxesSectionClass="sh-react-recv-boxes" itemMap={recvItemMap} palletsMap={recvPalletsMap} boxesMap={recvBoxesMap} hintMap={shipItemMap} hintPalletsMap={shipPalletsMap} hintBoxesMap={shipBoxesMap} />
        </div>
        <div className={styles.formPhotoSection}>
          <PhotoBlock section="recv" state={editRecv} />
          <label className={styles.photoUploadLabel} style={{ marginTop: 4 }}>
            <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => addNewPhotos('recv', e.target.files)} />
            <span className="btn btn-sm btn-secondary" style={{display:'inline-flex',alignItems:'center',gap:5}}><Camera size={13} strokeWidth={2}/>Добавить фото</span>
          </label>
        </div>
      </div>
    </>
  )
}

// ─── Codes modal ───────────────────────────────────────────────────────────────

function CodesModal({ onClose, onMissingUpdated }) {
  const [codes, setCodes]   = useState([])
  const [query, setQuery]   = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')
  const [saving, setSaving] = useState({})
  const [status, setStatus] = useState({})
  const [importResult, setImportResult] = useState('')

  useEffect(() => {
    api.getShipmentsCodes()
      .then(data => { setCodes(data); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [])

  const filtered = query
    ? codes.filter(e => e.address.toLowerCase().includes(query.toLowerCase()) || (e.code || '').toLowerCase().includes(query.toLowerCase()))
    : codes

  const handleSave = async (addr, code, inputRef) => {
    if (!code.trim()) return
    setSaving(s => ({ ...s, [addr]: true }))
    try {
      await api.setShipmentRecipientCode(addr, code.trim())
      setCodes(c => c.map(e => e.address === addr ? { ...e, code: code.trim() } : e))
      setStatus(s => ({ ...s, [addr]: 'ok' }))
      onMissingUpdated()
      setTimeout(() => setStatus(s => ({ ...s, [addr]: '' })), 2000)
    } catch {
      setStatus(s => ({ ...s, [addr]: 'err' }))
    } finally {
      setSaving(s => ({ ...s, [addr]: false }))
    }
  }

  const handleExport = async () => {
    try {
      const r = await fetch('/api/shipments/codes/export', { credentials: 'include' })
      if (!r.ok) throw new Error((await r.json()).error)
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'Коды получателей ЦФЗ.xlsx'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (err) { alert('Ошибка: ' + err.message) }
  }

  const handleImport = async e => {
    const file = e.target.files[0]
    if (!file) return
    setImportResult('Загружаю...')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/shipments/codes/import', { method: 'POST', body: fd, credentials: 'include' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error)
      setImportResult(`Сохранено: ${data.saved}`)
      const fresh = await api.getShipmentsCodes()
      setCodes(fresh)
      onMissingUpdated()
    } catch (err) { setImportResult(`Ошибка: ${err.message}`) }
    finally { e.target.value = '' }
  }

  return (
    <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`${styles.modalBox} ${styles.modalBoxWide}`}>
        <div className={styles.modalHeader}>
          <span>Коды получателей ЦФЗ</span>
          <button className={styles.modalClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
        </div>
        <input
          className={styles.codesSearch}
          placeholder="Поиск по адресу или коду..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        {loading ? <div className={styles.loading}>Загрузка...</div>
          : error ? <div className={styles.error}>{error}</div>
          : !filtered.length ? <div className={styles.empty}>{query ? 'Ничего не найдено' : 'Нет адресов ЦФЗ'}</div>
          : <div className={styles.codesList}>
              {filtered.map(e => (
                <CodesRow
                  key={e.address}
                  entry={e}
                  saving={!!saving[e.address]}
                  status={status[e.address] || ''}
                  onSave={(code, ref) => handleSave(e.address, code, ref)}
                />
              ))}
            </div>
        }
        <div className={styles.codesExportRow}>
          <button className="btn btn-sm btn-secondary" style={{display:'inline-flex',alignItems:'center',gap:5}} onClick={handleExport}><Download size={13} strokeWidth={2}/>Экспорт</button>
          <label className="btn btn-sm btn-secondary" style={{ cursor: 'pointer', display:'inline-flex', alignItems:'center', gap:5 }}>
            <Upload size={13} strokeWidth={2}/>Импорт
            <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImport} />
          </label>
          <span className={styles.codesImportResult}>{importResult}</span>
        </div>
        <div className={styles.modalFooter}>
          <button className="btn btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  )
}

function CodesRow({ entry, saving, status, onSave }) {
  const [value, setValue] = useState(entry.code || '')
  return (
    <div className={styles.missingRow}>
      <span className={styles.missingAddr}>{entry.address}</span>
      <input className={styles.codeInput} placeholder="Код получателя" value={value} onChange={e => setValue(e.target.value)} />
      <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => onSave(value)}>Сохранить</button>
      <span className={styles.codeStatus} style={{ color: status === 'ok' ? '#2e7d32' : '#c62828' }}>
        {status === 'ok' ? <Check size={13} strokeWidth={2.5}/> : status === 'err' ? <X size={13} strokeWidth={2}/> : status}
      </span>
    </div>
  )
}

// ─── Report modal ──────────────────────────────────────────────────────────────

function ReportModal({ onClose }) {
  const now = new Date()
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0')
  const [dateFrom, setDateFrom] = useState(`${y}-${m}-01`)
  const [dateTo,   setDateTo]   = useState(now.toISOString().slice(0, 10))
  const [result, setResult]     = useState('')
  const [loading, setLoading]   = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDownload = async () => {
    if (!dateFrom || !dateTo) { setResult('Выберите период'); return }
    setLoading(true)
    setResult('Формирую отчёт...')
    try {
      const r = await fetch(`/api/shipments/report?dateFrom=${dateFrom}&dateTo=${dateTo}`, { credentials: 'include' })
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Ошибка') }
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'Отчет по РК.xlsx'
      a.click()
      URL.revokeObjectURL(a.href)
      setResult('Отчёт скачан')
    } catch (err) { setResult(`Ошибка: ${err.message}`) }
    finally { setLoading(false) }
  }

  const handleDelete = async () => {
    if (!dateFrom || !dateTo) { setResult('Выберите период'); return }
    const from = dateFrom.split('-').reverse().join('.')
    const to   = dateTo.split('-').reverse().join('.')
    if (!confirm(`Удалить все данные за период ${from} — ${to}?\nЭто действие нельзя отменить.`)) return
    setDeleting(true)
    setResult('Удаляю...')
    try {
      const r = await fetch(`/api/rk/routes?dateFrom=${dateFrom}&dateTo=${dateTo}`, { method: 'DELETE', credentials: 'include' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Ошибка удаления')
      setResult(`Удалено маршрутов: ${data.deleted}`)
    } catch (err) { setResult(`Ошибка: ${err.message}`) }
    finally { setDeleting(false) }
  }

  return (
    <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modalBox}>
        <div className={styles.modalHeader}>
          <span>Отчёт и управление данными</span>
          <button className={styles.modalClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
        </div>
        <div className={styles.reportForm}>
          <label className={styles.reportFormLabel}>
            С
            <input type="date" className={styles.shInput} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </label>
          <label className={styles.reportFormLabel}>
            По
            <input type="date" className={styles.shInput} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </label>
        </div>
        <div className={styles.modalResult}>{result}</div>
        <div className={styles.modalFooter}>
          <button className="btn btn-secondary" style={{ color: '#c62828', borderColor: '#c62828' }} disabled={deleting} onClick={handleDelete}>Удалить за период</button>
          <button className="btn btn-secondary" onClick={onClose}>Закрыть</button>
          <button className="btn btn-primary" disabled={loading} onClick={handleDownload}>Скачать отчёт</button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function ShipmentsPage() {
  const notify = useNotify()
  const [activeView, setActiveView] = useLocalState('sh_activeView', 'routes')

  const [routesData, setRoutesData]   = useState([])
  const [driversData, setDriversData] = useState([])
  const [cfzData, setCfzData]         = useState([])

  const [routesLoading, setRoutesLoading]   = useState(false)
  const [driversLoading, setDriversLoading] = useState(false)
  const [cfzLoading, setCfzLoading]         = useState(false)

  const [routesError, setRoutesError]   = useState('')
  const [driversError, setDriversError] = useState('')
  const [cfzError, setCfzError]         = useState('')

  const [routesStatusFilter, setRoutesStatusFilter] = useLocalState('sh_statusFilter', 'all')
  const [routesDateFrom, setRoutesDateFrom] = useLocalState('sh_dateFrom', '')
  const [routesDateTo,   setRoutesDateTo]   = useLocalState('sh_dateTo', '')
  const [routesSearch,  setRoutesSearch]  = useLocalState('sh_routesSearch', '')
  const [driversSearch, setDriversSearch] = useLocalState('sh_driversSearch', '')
  const [cfzSearch,     setCfzSearch]     = useLocalState('sh_cfzSearch', '')

  const [missingCodes, setMissingCodes] = useState([])

  const [fetchModalOpen,  setFetchModalOpen]  = useState(false)
  const [codesModalOpen,  setCodesModalOpen]  = useState(false)
  const [reportModalOpen, setReportModalOpen] = useState(false)
  const [formModal, setFormModal]             = useState(null) // null | { route: null|routeObj }

  const [lightbox, setLightbox] = useState(null) // null | { photos, idx }

  // Refs для актуальных значений поиска и вкладки — нужны в SSE-обработчике
  const activeViewRef   = useRef(activeView)
  const routesSearchRef = useRef(routesSearch)
  const driversSearchRef = useRef(driversSearch)
  const cfzSearchRef    = useRef(cfzSearch)
  useEffect(() => { activeViewRef.current = activeView },     [activeView])
  useEffect(() => { routesSearchRef.current = routesSearch }, [routesSearch])
  useEffect(() => { driversSearchRef.current = driversSearch }, [driversSearch])
  useEffect(() => { cfzSearchRef.current = cfzSearch },       [cfzSearch])

  const loadMissingCodes = useCallback(async () => {
    try { setMissingCodes(await api.getShipmentsMissingCodes()) } catch { /* silent */ }
  }, [])

  const loadRoutes = useCallback(async q => {
    setRoutesLoading(true); setRoutesError('')
    try { setRoutesData(await api.getRkRoutes({ q })) }
    catch (err) { setRoutesError(err.message) }
    finally { setRoutesLoading(false) }
  }, [])

  const loadDrivers = useCallback(async q => {
    setDriversLoading(true); setDriversError('')
    try { setDriversData(await api.getRkDrivers(q)) }
    catch (err) { setDriversError(err.message) }
    finally { setDriversLoading(false) }
  }, [])

  const loadCfz = useCallback(async q => {
    setCfzLoading(true); setCfzError('')
    try { setCfzData(await api.getRkCfz(q)) }
    catch (err) { setCfzError(err.message) }
    finally { setCfzLoading(false) }
  }, [])

  // Initial load
  useEffect(() => {
    loadRoutes('')
    loadMissingCodes()
  }, [loadRoutes, loadMissingCodes])

  // SSE: авто-обновление при изменениях кладовщика + переподключение при обрыве
  useEffect(() => {
    let sse
    let reconnectTimer

    function connect() {
      sse = new EventSource('/api/rk/events', { withCredentials: true })

      sse.addEventListener('routes-updated', () => {
        const view = activeViewRef.current
        if (view === 'routes')  loadRoutes(routesSearchRef.current)
        if (view === 'drivers') loadDrivers(driversSearchRef.current)
        if (view === 'cfz')     loadCfz(cfzSearchRef.current)
        notify('Данные обновлены', 'success')
      })

      sse.onerror = () => {
        sse.close()
        reconnectTimer = setTimeout(connect, 5000)
      }
    }

    connect()
    return () => { sse?.close(); clearTimeout(reconnectTimer) }
  }, [loadRoutes, loadDrivers, loadCfz, notify])

  // Debounced searches
  useEffect(() => {
    const t = setTimeout(() => { if (activeView === 'routes')  loadRoutes(routesSearch) },  350)
    return () => clearTimeout(t)
  }, [routesSearch]) // eslint-disable-line

  useEffect(() => {
    const t = setTimeout(() => { if (activeView === 'drivers') loadDrivers(driversSearch) }, 350)
    return () => clearTimeout(t)
  }, [driversSearch]) // eslint-disable-line

  useEffect(() => {
    const t = setTimeout(() => { if (activeView === 'cfz')     loadCfz(cfzSearch) },      350)
    return () => clearTimeout(t)
  }, [cfzSearch]) // eslint-disable-line

  const switchView = view => {
    setActiveView(view)
    if (view === 'routes')  loadRoutes(routesSearch)
    if (view === 'drivers') loadDrivers(driversSearch)
    if (view === 'cfz')     loadCfz(cfzSearch)
  }

  const handleRouteUpdate = useCallback((routeId, newRoute) => {
    setRoutesData(prev => prev.map(r => r.routeId === routeId ? newRoute : r))
  }, [])

  const handleBulkDelete = useCallback(ids => {
    const idSet = new Set(ids)
    setRoutesData(prev => prev.filter(r => !idSet.has(r.routeId)))
  }, [])

  const openEditModal = routeId => {
    const route = routesData.find(r => r.routeId === routeId)
    if (route) setFormModal({ route })
  }

  const openLightbox = useCallback((photos, idx) => setLightbox({ photos, idx }), [])

  const filteredRoutesData = useMemo(() => routesData.filter(r => {
    if (routesStatusFilter === 'shipped')     { if (!r.shipment)  return false }
    else if (routesStatusFilter === 'received')    { if (!r.receiving) return false }
    else if (routesStatusFilter === 'unconfirmed') { if (!((r.shipment && !r.shipment.confirmed) || (r.receiving && !r.receiving.confirmed))) return false }
    else if (routesStatusFilter === 'pending')     { if (r.shipment || r.receiving) return false }
    if (routesDateFrom && r.date && r.date < routesDateFrom) return false
    if (routesDateTo   && r.date && r.date > routesDateTo)   return false
    return true
  }), [routesData, routesStatusFilter, routesDateFrom, routesDateTo])

  return (
    <div className={styles.mainContent}>
      <div className={styles.toolbar}>
        <button className="btn btn-secondary" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={() => setFetchModalOpen(true)}><Download size={14} strokeWidth={2}/>Загрузить из WMS</button>
        <button className="btn btn-secondary" onClick={() => setCodesModalOpen(true)}>Коды ЦФЗ</button>
        <button className="btn btn-secondary" onClick={() => setReportModalOpen(true)}>Отчёт</button>
      </div>

      <MissingCodesBanner
        missing={missingCodes}
        onSaved={addr => setMissingCodes(prev => prev.filter(a => a !== addr))}
      />

      <div className={styles.subtabs}>
        {[
          { id: 'routes',  label: 'По маршрутам' },
          { id: 'drivers', label: 'По водителям' },
          { id: 'cfz',     label: 'По ЦФЗ' },
        ].map(tab => (
          <button
            key={tab.id}
            className={`${styles.subtab} ${activeView === tab.id ? styles.subtabActive : ''}`}
            onClick={() => switchView(tab.id)}
          >{tab.label}</button>
        ))}
      </div>

      {activeView === 'routes' && (
        <div className={styles.viewAnim}>
          <div className={styles.searchRow}>
            <input className={styles.searchInput} placeholder="Поиск по маршруту, водителю, адресу ЦФЗ..." value={routesSearch} onChange={e => setRoutesSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadRoutes(routesSearch)} />
          </div>
          <div className={styles.filterRow}>
            {[
              { id: 'all',      label: 'Все' },
              { id: 'shipped',  label: 'Отгружены' },
              { id: 'received', label: 'Приняты' },
              { id: 'unconfirmed', label: 'Не подтверждены' },
              { id: 'pending',  label: 'Не обработаны' },
            ].map(f => (
              <button
                key={f.id}
                className={`${styles.filterChip} ${routesStatusFilter === f.id ? styles.filterChipActive : ''}`}
                onClick={() => setRoutesStatusFilter(f.id)}
              >{f.label}</button>
            ))}
            <div className={styles.dateFilter}>
              <input
                type="date"
                className={styles.dateInput}
                value={routesDateFrom}
                onChange={e => setRoutesDateFrom(e.target.value)}
                title="Дата от"
              />
              <span className={styles.dateSep}>—</span>
              <input
                type="date"
                className={styles.dateInput}
                value={routesDateTo}
                onChange={e => setRoutesDateTo(e.target.value)}
                title="Дата до"
              />
              {(routesDateFrom || routesDateTo) && (
                <button
                  className={styles.dateClear}
                  onClick={() => { setRoutesDateFrom(''); setRoutesDateTo('') }}
                  title="Сбросить даты"
                ><X size={13} strokeWidth={2}/></button>
              )}
            </div>
          </div>
          <RoutesView
            data={filteredRoutesData}
            loading={routesLoading}
            error={routesError}
            onOpenLightbox={openLightbox}
            onOpenEdit={openEditModal}
            onDataUpdate={handleRouteUpdate}
            onBulkDelete={handleBulkDelete}
          />
        </div>
      )}

      {activeView === 'drivers' && (
        <div className={styles.viewAnim}>
          <div className={styles.searchRow}>
            <input className={styles.searchInput} placeholder="Поиск по водителю..." value={driversSearch} onChange={e => setDriversSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadDrivers(driversSearch)} />
          </div>
          <DriversView data={driversData} loading={driversLoading} error={driversError} />
        </div>
      )}

      {activeView === 'cfz' && (
        <div className={styles.viewAnim}>
          <div className={styles.searchRow}>
            <input className={styles.searchInput} placeholder="Поиск по адресу ЦФЗ..." value={cfzSearch} onChange={e => setCfzSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadCfz(cfzSearch)} />
          </div>
          <CfzView data={cfzData} loading={cfzLoading} error={cfzError} />
        </div>
      )}

      {fetchModalOpen && (
        <FetchModal
          onClose={() => setFetchModalOpen(false)}
          onDone={() => loadRoutes(routesSearch)}
        />
      )}

      {formModal !== null && (
        <FormModal
          initialRoute={formModal.route}
          onClose={() => setFormModal(null)}
          onSaved={(routeId, newRoute) => {
            handleRouteUpdate(routeId, newRoute)
            setFormModal(null)
          }}
        />
      )}

      {codesModalOpen && (
        <CodesModal
          onClose={() => setCodesModalOpen(false)}
          onMissingUpdated={loadMissingCodes}
        />
      )}

      {reportModalOpen && (
        <ReportModal onClose={() => setReportModalOpen(false)} />
      )}

      {lightbox && (
        <Lightbox
          photos={lightbox.photos}
          idx={lightbox.idx}
          onClose={() => setLightbox(null)}
          onNav={dir => setLightbox(prev => ({ ...prev, idx: (prev.idx + dir + prev.photos.length) % prev.photos.length }))}
        />
      )}
    </div>
  )
}
