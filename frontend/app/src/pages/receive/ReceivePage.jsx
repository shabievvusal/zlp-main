import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { requestEoRefresh, fetchRouteFromWMS } from '../../api/index.js'
import { shortFio } from '../../utils/format.js'
import { Package, Truck, PackageOpen, ClipboardList, RefreshCw, Loader2 } from 'lucide-react'
import s from './ReceivePage.module.css'



function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

async function apiFetch(url, options = {}) {
  const { headers: extraHeaders = {}, ...rest } = options
  const r = await fetch(url, {
    credentials: 'include',
    ...rest,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
  let data
  try { data = await r.json() } catch { throw new Error(`Ошибка сервера (${r.status})`) }
  if (!r.ok) throw new Error(data.error || `Ошибка сервера (${r.status})`)
  return data
}

// ─── Name Screen ──────────────────────────────────────────────────────────────

function NameScreen({ onSave }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  function save() {
    const val = value.trim()
    if (!val) { setError('Введите фамилию и инициалы'); return }
    setError('')
    onSave(val)
  }

  return (
    <div className={s.nameScreen}>
      <div className={s.nameBox}>
        <div className={s.nameLogo}><Package size={36} strokeWidth={1.5}/></div>
        <h1 className={s.nameTitle}>РК — Склад</h1>
        <p className={s.nameHint}>Введите свою фамилию и инициалы — сохранится на устройстве</p>
        <div className={s.field}>
          <label>Фамилия и инициалы</label>
          <input
            className={s.inp}
            type="text"
            placeholder="Иванов И.И."
            autoComplete="name"
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
          />
        </div>
        {error && <div className={s.errorMsg}>{error}</div>}
        <button className={s.btnPrimary} onClick={save}>Продолжить</button>
      </div>
    </div>
  )
}

// ─── Step: Type ───────────────────────────────────────────────────────────────

function StepType({ onSelect }) {
  return (
    <div className={s.typeCards}>
      <button className={s.typeCard} onClick={() => onSelect('ship')}>
        <div className={s.typeCardIcon}><Truck size={28} strokeWidth={1.5}/></div>
        <div className={s.typeCardLabel}>Отгрузка</div>
        <div className={s.typeCardDesc}>Маршрут уходит со склада</div>
      </button>
      <button className={s.typeCard} onClick={() => onSelect('receive')}>
        <div className={s.typeCardIcon}><PackageOpen size={28} strokeWidth={1.5}/></div>
        <div className={s.typeCardLabel}>Приёмка</div>
        <div className={s.typeCardDesc}>Возврат РК с маршрута</div>
      </button>
      <button className={s.typeCard} onClick={() => onSelect('eo_list')}>
        <div className={s.typeCardIcon}><ClipboardList size={28} strokeWidth={1.5}/></div>
        <div className={s.typeCardLabel}>Список ЕО</div>
        <div className={s.typeCardDesc}>ЕО по ЦФЗ в маршруте</div>
      </button>
    </div>
  )
}

// ─── Step: Search ─────────────────────────────────────────────────────────────

function StepSearch({ opType, onSelect }) {
  const [query, setQuery] = useState('')
  const [routes, setRoutes] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(null)

  const doSearch = useCallback(async (q) => {
    const mode = opType === 'ship' ? 'unshipped' : opType === 'receive' ? 'pending' : ''
    const url = `/api/rk/routes-search?mode=${mode}${q ? `&q=${encodeURIComponent(q)}` : ''}`
    try {
      const list = await apiFetch(url)
      setRoutes(list)
      setError('')
    } catch (err) {
      setError(err.message)
      setRoutes([])
    }
  }, [opType])

  useEffect(() => { doSearch('') }, [doSearch])

  function onQueryChange(e) {
    const val = e.target.value
    setQuery(val)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => doSearch(val.trim()), 300)
  }

  return (
    <>
      <div className={s.searchRow}>
        <input
          className={s.inp}
          type="text"
          placeholder="Водитель, маршрут, адрес ЦФЗ..."
          value={query}
          onChange={onQueryChange}
          autoFocus
        />
      </div>
      <div className={s.results}>
        {routes === null && <div className={s.loading}>Загрузка...</div>}
        {error && <div className={s.errorMsg}>{error}</div>}
        {routes !== null && !error && routes.length === 0 && <div className={s.empty}>Маршруты не найдены</div>}
        {routes && routes.map((r, i) => {
          const cfz = r.cfzAddresses || []
          const cfzStr = cfz.slice(0, 3).map(a => a.address).join(', ') + (cfz.length > 3 ? '…' : '')
          const done = opType === 'ship' && r.shipment ? (r.shipment.items || []).length : null
          return (
            <div key={r.routeId || i} className={s.routeCard} onClick={() => onSelect(r)}>
              <div className={s.routeCardTop}>
                <span className={s.cardDate}>{fmtDate(r.date)}</span>
                <span className={s.cardMain}>{r.routeNumber || '—'}</span>
                {r.vehicle && <span className={s.cardVehicle}>{r.vehicle.number || ''}</span>}
              </div>
              {r.driver && <div className={s.cardDriver}>{r.driver.name || ''}</div>}
              {cfzStr && <div className={s.cardCfz}>{cfzStr}</div>}
              {done !== null && <div className={s.cardPartial}>Заполнено {done} из {cfz.length} адресов</div>}
            </div>
          )
        })}
      </div>
    </>
  )
}

// ─── Step: Data ───────────────────────────────────────────────────────────────

function StepData({ opType, route, onDone, byName }) {
  const cfz = route.cfzAddresses || []
  const existingItems = opType === 'ship' ? route.shipment?.items : route.receiving?.items
  const [driverDebt, setDriverDebt] = useState(null) // { rokhlyaDebt, debtSince }

  useEffect(() => {
    if (opType !== 'receive' || !route.driver?.name) return
    apiFetch(`/api/rk/driver-rokhlya-debt?name=${encodeURIComponent(route.driver.name)}`)
      .then(d => setDriverDebt(d))
      .catch(() => {})
  }, [opType, route.driver?.name])
  const existingMap = Object.fromEntries((existingItems || []).map(i => [i.address, i.rk]))

  const existingSection = opType === 'ship' ? route.shipment : route.receiving
  const [gate, setGate] = useState(existingSection?.gate || '')
  const [tempBefore, setTempBefore] = useState(existingSection?.tempBefore != null ? String(existingSection.tempBefore) : '')
  const [tempAfter, setTempAfter] = useState(existingSection?.tempAfter != null ? String(existingSection.tempAfter) : '')
  const [rokhlya, setRokhlya] = useState(existingSection?.rokhlya != null ? String(existingSection.rokhlya) : '')
  const [cfzValues, setCfzValues] = useState(() => Object.fromEntries(cfz.map(a => [a.address, String(existingMap[a.address] ?? '')])))
  const existingPalletsMap = Object.fromEntries((existingItems || []).map(i => [i.address, i.pallets ?? '']))
  const [palletsValues, setPalletsValues] = useState(() => Object.fromEntries(cfz.map(a => [a.address, String(existingPalletsMap[a.address] ?? '')])))
  const [photos, setPhotos] = useState([]) // { file, url }
  const [status, setStatus] = useState(null) // { type: 'success'|'error', msg }
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef(null)

  function onPhotoSelected(e) {
    const files = Array.from(e.target.files || [])
    setPhotos(prev => [...prev, ...files.map(f => ({ file: f, url: URL.createObjectURL(f) }))])
    e.target.value = ''
  }

  function removePhoto(idx) {
    setPhotos(prev => prev.filter((_, i) => i !== idx))
  }

  async function submit() {
    const parseNum = v => { const s = String(v ?? '').replace(',', '.'); return s !== '' && !isNaN(parseFloat(s)) ? parseFloat(s) : 0 }

    const items = cfz.map(a => ({
      address: a.address,
      rk: parseNum(cfzValues[a.address]),
      pallets: parseNum(palletsValues[a.address]),
    }))

    setSaving(true)
    setStatus(null)

    try {
      let uploadedPhotos = []
      if (photos.length) {
        const fd = new FormData()
        photos.forEach(p => fd.append('photos', p.file))
        const r = await fetch('/api/rk/photos', { method: 'POST', credentials: 'include', body: fd })
        let d
        try { d = await r.json() } catch { throw new Error(`Ошибка загрузки фото (${r.status})`) }
        if (!d.ok) throw new Error(d.error || 'Ошибка загрузки фото')
        uploadedPhotos = d.urls
      }

      const parseTemp = v => { const s = String(v ?? '').replace(',', '.'); return s !== '' && !isNaN(parseFloat(s)) ? parseFloat(s) : null }

      const action = opType === 'ship' ? 'ship' : 'receive'
      await apiFetch(`/api/rk/routes/${encodeURIComponent(route.routeId)}/${action}`, {
        method: 'POST',
        body: JSON.stringify({
        by: byName || '',
        gate,
        tempBefore: opType === 'ship' ? parseTemp(tempBefore) : null,
        tempAfter: opType === 'ship' ? parseTemp(tempAfter) : null,
        rokhlya: rokhlya !== '' ? Number(rokhlya) : null,
        items,
        photos: uploadedPhotos,
      }),
      })

      setStatus({ type: 'success', msg: opType === 'ship' ? 'Отгрузка сохранена!' : 'Приёмка сохранена!' })
      setTimeout(onDone, 2000)
    } catch (err) {
      setStatus({ type: 'error', msg: err.message })
      setSaving(false)
    }
  }

  return (
    <>
      <div className={s.routeInfoBox}>
        <div className={s.routeInfoNum}>{route.routeNumber || '—'}</div>
        <div className={s.routeInfoMeta}>
          {fmtDate(route.date)}
          {route.driver ? ` · ${route.driver.name}` : ''}
          {route.vehicle ? ` · ${route.vehicle.number}` : ''}
        </div>
        {opType === 'receive' && route.shippedRK != null && (
          <div className={s.routeInfoShipped}>Отгружено РК: {route.shippedRK}</div>
        )}
        {opType === 'receive' && driverDebt?.rokhlyaDebt > 0 && (
          <div className={s.routeInfoDebt}>
            Долг рохлей: {driverDebt.rokhlyaDebt} шт.
            {driverDebt.debtSince && ` · с ${fmtDate(driverDebt.debtSince.date)} (${driverDebt.debtSince.routeNumber})`}
          </div>
        )}
      </div>

      <div className={s.field}>
        <label>Ворота</label>
        <input className={s.inp} type="text" placeholder="Номер ворот" inputMode="numeric" value={gate} onChange={e => setGate(e.target.value)} />
      </div>

      {opType === 'ship' && (
        <>
          <div className={s.field}>
            <label>Температура ДО отгрузки (°C)</label>
            <input className={s.inp} type="text" placeholder="-18" value={tempBefore} onChange={e => setTempBefore(e.target.value)} />
          </div>
          <div className={s.field}>
            <label>Температура ПОСЛЕ отгрузки (°C)</label>
            <input className={s.inp} type="text" placeholder="-18" value={tempAfter} onChange={e => setTempAfter(e.target.value)} />
          </div>
        </>
      )}

      <div className={s.fieldLabel}>Рохли</div>
      <div className={s.cfzList}>
        <div className={s.cfzRow}>
          <span className={s.cfzAddr}>{opType === 'ship' ? 'Отдано водителю' : 'Возврат от водителя'}</span>
          {opType === 'receive' && route.shipment?.rokhlya != null && (
            <span className={s.cfzShipped}>выдано: {route.shipment.rokhlya}</span>
          )}
          <input
            className={s.cfzInput}
            type="number"
            inputMode="numeric"
            min="0"
            placeholder="0"
            value={rokhlya}
            onChange={e => setRokhlya(e.target.value)}
          />
        </div>
      </div>

      <div className={s.fieldLabel}>РК и паллеты по ЦФЗ</div>
      <div className={s.cfzList}>
        {cfz.length === 0 && <div className={s.empty}>Нет адресов ЦФЗ</div>}
        {cfz.map(a => {
          const shipItem = route.shipment?.items?.find(x => x.address === a.address)
          const shippedRk = opType === 'receive' ? (shipItem?.rk ?? null) : null
          const shippedPallets = opType === 'receive' ? (shipItem?.pallets ?? null) : null
          return (
            <div key={a.address} className={s.cfzRow}>
              <span className={s.cfzAddr}>{a.address}</span>
              {shippedRk != null && <span className={s.cfzShipped}>отгр. {shippedRk} РК{shippedPallets ? ` / ${shippedPallets} пал.` : ''}</span>}
              <input
                className={s.cfzInput}
                type="number"
                inputMode="numeric"
                min="0"
                placeholder="РК"
                value={cfzValues[a.address] ?? ''}
                onChange={e => setCfzValues(prev => ({ ...prev, [a.address]: e.target.value }))}
              />
              <input
                className={s.cfzInputSm}
                type="number"
                inputMode="numeric"
                min="0"
                placeholder="пал."
                value={palletsValues[a.address] ?? ''}
                onChange={e => setPalletsValues(prev => ({ ...prev, [a.address]: e.target.value }))}
              />
            </div>
          )
        })}
      </div>

      <div className={s.photosSection}>
        <div className={s.fieldLabel}>Фотографии</div>
        {photos.length > 0 && (
          <div className={s.photosPreview}>
            {photos.map((p, i) => (
              <div key={i} className={s.photoItem}>
                <img src={p.url} className={s.photoThumb} alt="" />
                <button className={s.photoRemove} type="button" onClick={() => removePhoto(i)}>×</button>
              </div>
            ))}
          </div>
        )}
        <button className={s.btnPhoto} type="button" onClick={() => fileInputRef.current?.click()}>+ Добавить фото</button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onPhotoSelected} />
      </div>

      {status && <div className={status.type === 'success' ? s.successMsg : s.errorMsg}>{status.msg}</div>}
      {!status?.type?.includes('success') && (
        <button className={`${s.btnPrimary} ${s.btnSave}`} disabled={saving} onClick={submit}>
          {saving ? 'Сохраняю...' : opType === 'ship' ? 'Сохранить отгрузку' : 'Сохранить приёмку'}
        </button>
      )}
    </>
  )
}

// ─── Step: EO List ────────────────────────────────────────────────────────────

function CfzEoPanel({ routeId, store, onCountsUpdate }) {
  const [storeData, setStoreData] = useState(null) // null = loading
  const [removedEos, setRemovedEos] = useState([])
  const [requested, setRequested] = useState(false)
  const [error, setError] = useState('')
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const pollRef = useRef(null)
  const pollCountRef = useRef(0)
  const eosSnapshotRef = useRef(null) // { eosLen, removedLen } на момент запроса

  function applyData(cfzData) {
    const eos = cfzData?.eos || []
    const removed = cfzData?.removedEos || []
    setStoreData(cfzData || { address: store.address, eos: [] })
    setRemovedEos(removed)
    onCountsUpdate?.(store.storeId, eos.length, removed.length)
  }

  function loadEos() {
    apiFetch(`/api/rk/routes/${encodeURIComponent(routeId)}/eos`)
      .then(data => applyData(data[store.storeId]))
      .catch(err => setError(err.message))
  }

  useEffect(() => {
    setStoreData(null)
    setRemovedEos([])
    setError('')
    setRequested(false)
    loadEos()
  }, [routeId, store.storeId, store.address])

  // Поллинг после запроса — ждём пока корп. устройство обновит
  useEffect(() => {
    if (!requested) { clearInterval(pollRef.current); return }
    pollCountRef.current = 0
    pollRef.current = setInterval(() => {
      pollCountRef.current += 1
      if (pollCountRef.current > 12) { // 60 сек — нет ответа
        clearInterval(pollRef.current)
        setRequested(false)
        setError('Обновление не получено. Нет активного устройства с доступом к WMS.')
        return
      }
      apiFetch(`/api/rk/routes/${encodeURIComponent(routeId)}/eos`)
        .then(data => {
          const cfzData = data[store.storeId]
          if (!cfzData) return
          const snap = eosSnapshotRef.current
          const eosLen = (cfzData.eos || []).length
          const removedLen = (cfzData.removedEos || []).length
          if (!snap || eosLen !== snap.eosLen || removedLen !== snap.removedLen) {
            applyData(cfzData)
            setRequested(false)
          }
        })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(pollRef.current)
  }, [requested, routeId, store.storeId])

  async function handleRefresh() {
    setError('')
    let token = getToken()
    if (!token || !isTokenValid()) {
      const ok = await forceRefresh()
      token = ok ? getToken() : null
    }

    eosSnapshotRef.current = { eosLen: (storeData?.eos || []).length, removedLen: removedEos.length }

    if (token) {
      // Запускаем WMS-запрос в фоне — UI не ждёт, сразу показываем "⏳"
      fetchRouteFromWMS(token, routeId)
        .then(wmsData => apiFetch(
          `/api/rk/routes/${encodeURIComponent(routeId)}/eos/refresh`,
          { method: 'POST', body: JSON.stringify(wmsData) }
        ))
        .catch(err => {
          if (/401|403|unauthorized/i.test(err.message)) {
            forceRefresh().then(ok => {
              if (!ok) { setError('Сессия истекла. Войдите заново.'); setRequested(false); return }
              const newToken = getToken()
              fetchRouteFromWMS(newToken, routeId)
                .then(wmsData => apiFetch(
                  `/api/rk/routes/${encodeURIComponent(routeId)}/eos/refresh`,
                  { method: 'POST', body: JSON.stringify(wmsData) }
                ))
                .catch(err2 => { setError(err2.message); setRequested(false) })
            })
          } else {
            setError(err.message)
            setRequested(false)
          }
        })
    } else {
      requestEoRefresh(routeId).catch(err => { setError(err.message); setRequested(false) })
    }

    setRequested(true)
  }

  const eos = storeData?.eos || []

  return (
    <div className={s.eoPanel}>
      {storeData === null && !error && <div className={s.loading}>Загрузка...</div>}
      {error && <div className={s.errorMsg}>{error}</div>}
      {storeData !== null && (
        <>
          <div className={s.eoRefreshRow}>
            <span className={s.eoCount}>
              {eos.length} ЕО{removedEos.length > 0 ? ` · ${removedEos.length} удалено` : ''}
            </span>
            <button className={s.btnRefresh} onClick={handleRefresh} disabled={requested}>
              {requested ? <><Loader2 size={13} strokeWidth={2} style={{marginRight:5}}/>Ожидание обновления...</> : <><RefreshCw size={13} strokeWidth={2} style={{marginRight:5}}/>Обновить из WMS</>}
            </button>
          </div>
          {requested && <div className={s.mutedText} style={{ fontSize: 12, marginBottom: 4 }}>Запрос отправлен. Данные обновятся автоматически.</div>}
          {eos.length === 0 && removedEos.length === 0 && <div className={s.empty}>ЕО не найдены</div>}
          <div className={s.eoList}>
            {eos.map((eo, i) => (
              <div key={i} className={s.eoItem}>
                <span className={s.eoBarcode}>{eo.barcode}</span>
                {eo.weight != null && <span className={s.eoWeight}>{Number(eo.weight).toFixed(2)} кг</span>}
              </div>
            ))}
            {removedEos.map((eo, i) => (
              <div key={`rm-${i}`} className={`${s.eoItem} ${s.eoItemRemoved}`}>
                <span className={s.eoBarcode}>{eo.barcode}</span>
                {eo.weight != null && <span className={s.eoWeight}>{Number(eo.weight).toFixed(2)} кг</span>}
                <span className={s.eoRemovedTag}>удалено</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function StepEoList({ route }) {
  const [openStoreId, setOpenStoreId] = useState(null)
  const cfz = route.cfzAddresses || []

  // Счётчики ЕО: инициализируем из данных маршрута, обновляем через колбэк из панели
  const [eoCounts, setEoCounts] = useState(() =>
    Object.fromEntries(cfz.map(a => [a.storeId, { eos: a.eos?.length || 0, removed: 0 }]))
  )

  // Загружаем актуальные счётчики (включая removed) для всех ЦФЗ сразу
  useEffect(() => {
    apiFetch(`/api/rk/routes/${encodeURIComponent(route.routeId)}/eos`)
      .then(data => {
        setEoCounts(prev => {
          const next = { ...prev }
          for (const [storeId, d] of Object.entries(data)) {
            next[storeId] = { eos: d.eos?.length || 0, removed: d.removedEos?.length || 0 }
          }
          return next
        })
      })
      .catch(() => {})
  }, [route.routeId])

  function handleCountsUpdate(storeId, eosCount, removedCount) {
    setEoCounts(prev => ({ ...prev, [storeId]: { eos: eosCount, removed: removedCount } }))
  }

  const totalEos     = Object.values(eoCounts).reduce((s, c) => s + c.eos, 0)
  const totalRemoved = Object.values(eoCounts).reduce((s, c) => s + c.removed, 0)

  function toggle(storeId) {
    setOpenStoreId(prev => prev === storeId ? null : storeId)
  }

  return (
    <>
      <div className={s.routeInfoBox}>
        <div className={s.routeInfoNum}>{route.routeNumber || '—'}</div>
        <div className={s.routeInfoMeta}>
          {fmtDate(route.date)}
          {route.driver ? ` · ${route.driver.name}` : ''}
          {route.vehicle ? ` · ${route.vehicle.number}` : ''}
        </div>
        {(totalEos > 0 || totalRemoved > 0) && (
          <div className={s.routeEoTotal}>
            {totalEos} ЕО{totalRemoved > 0 ? ` · ${totalRemoved} удалено` : ''}
          </div>
        )}
      </div>

      <div className={s.fieldLabel}>Нажмите на ЦФЗ для просмотра ЕО</div>

      {cfz.length === 0 && <div className={s.empty}>Нет адресов ЦФЗ</div>}

      <div className={s.cfzList}>
        {cfz.map(a => {
          const isOpen = openStoreId === a.storeId
          const counts = eoCounts[a.storeId] || { eos: 0, removed: 0 }
          return (
            <div key={a.address}>
              <div
                className={`${s.cfzRow} ${s.cfzRowClickable} ${isOpen ? s.cfzRowOpen : ''}`}
                onClick={() => toggle(a.storeId)}
              >
                <span className={s.cfzAddr}>{a.address}</span>
                {(counts.eos > 0 || counts.removed > 0) && (
                  <span className={s.cfzEoCount}>
                    {counts.eos} ЕО{counts.removed > 0 ? ` · ${counts.removed} удал.` : ''}
                  </span>
                )}
                <span className={s.cfzChevron}>{isOpen ? '▲' : '▼'}</span>
              </div>
              {isOpen && (
                <CfzEoPanel
                  routeId={route.routeId}
                  store={a}
                  onCountsUpdate={handleCountsUpdate}
                />
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReceivePage() {
  const { user } = useAuth()
  const name = user?.name ? shortFio(user.name) : ''
  const [step, setStep] = useState('type') // 'type' | 'search' | 'data'
  const [opType, setOpType] = useState(null) // 'ship' | 'receive'
  const [selectedRoute, setSelectedRoute] = useState(null)

  function goBack() {
    if (step === 'data') { setStep('search'); setSelectedRoute(null) }
    else { setStep('type'); setOpType(null) }
  }

  function selectType(type) {
    setOpType(type)
    setStep('search')
  }

  function selectRoute(route) {
    setSelectedRoute(route)
    setStep('data')
  }

  function resetToType() {
    setStep('type')
    setOpType(null)
    setSelectedRoute(null)
  }

  const headerTitle =
    step === 'type' ? 'РК — Склад' :
    step === 'search' ? (opType === 'ship' ? 'Отгрузка' : opType === 'eo_list' ? 'Список ЕО' : 'Приёмка') :
    selectedRoute?.routeNumber || fmtDate(selectedRoute?.date) || '—'

  return (
    <div className={s.page}>
      <header className={s.header}>
        {step !== 'type' && (
          <button className={s.headerBack} onClick={goBack}>←</button>
        )}
        <span className={s.headerTitle}>{headerTitle}</span>
        {name && <span className={s.headerNameBtn}>{name}</span>}
      </header>

      <div className={s.container}>
        {step === 'type' && <StepType onSelect={selectType} />}
        {step === 'search' && <StepSearch opType={opType} onSelect={selectRoute} />}
        {step === 'data' && selectedRoute && opType !== 'eo_list' && <StepData opType={opType} route={selectedRoute} onDone={resetToType} byName={name} />}
        {step === 'data' && selectedRoute && opType === 'eo_list' && <StepEoList route={selectedRoute} />}
      </div>
    </div>
  )
}
