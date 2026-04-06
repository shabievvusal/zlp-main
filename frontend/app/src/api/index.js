const credentials = 'include'

async function req(url, opts = {}) {
  const r = await fetch(url, { credentials, ...opts })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error(`Сервер вернул не JSON (${r.status}): ${text.slice(0, 150)}`)
  }
  if (!r.ok) throw new Error(data?.error || r.statusText || `HTTP ${r.status}`)
  return data
}

// ─── Auth ───────────────────────────────────────────────────────────────────

export async function loginVs(login, password) {
  return req('/api/vs/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
  })
}

export async function registerVs(data) {
  return req('/api/vs/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function getVsAdminRoles() {
  return req('/api/vs/admin/roles')
}

export async function addVsAdminRole(key, label, modules) {
  return req('/api/vs/admin/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, label, modules }),
  })
}

export async function updateVsAdminRole(key, label, modules) {
  return req(`/api/vs/admin/roles/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, modules }),
  })
}

export async function deleteVsAdminRole(key) {
  return req(`/api/vs/admin/roles/${encodeURIComponent(key)}`, { method: 'DELETE' })
}

export async function getVsAdminPending() {
  return req('/api/vs/admin/pending')
}

export async function approveVsPending(phone, role, modules) {
  return req('/api/vs/admin/pending/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, role, modules }),
  })
}

export async function rejectVsPending(phone) {
  return req(`/api/vs/admin/pending/${encodeURIComponent(phone)}`, { method: 'DELETE' })
}

export async function getVsMe() {
  const r = await fetch('/api/vs/auth/me', { credentials })
  if (!r.ok) return null
  return r.json()
}

export async function logoutVs() {
  await fetch('/api/vs/auth/logout', { method: 'POST', credentials })
}

export async function refreshSamokatToken(refreshToken) {
  const r = await fetch('https://api.samokat.ru/wmsin-wwh/auth/refresh', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
    },
    body: JSON.stringify({ refreshToken }),
  })
  if (!r.ok) throw new Error(`Ошибка обновления токена: ${r.status}`)
  return r.json()
}

// ─── Status ─────────────────────────────────────────────────────────────────

export async function getStatus() {
  return req('/api/status')
}

// ─── Data ───────────────────────────────────────────────────────────────────

export async function getDateSummary(date, opts = {}) {
  const params = new URLSearchParams({ shift: opts.shift || 'day' })
  if (opts.idleThresholdMinutes) params.set('idleThresholdMinutes', opts.idleThresholdMinutes)
  return req(`/api/date/${date}/summary?${params}`, { cache: 'no-store' })
}

/** Сводка за полную смену (21:00 пред. дня → 21:00 текущего, МСК) — для почасового отчёта. */
export async function getDateSummaryFull(date) {
  return req(`/api/date/${date}/summary`, { cache: 'no-store' })
}

export async function getDateItems(date, opts = {}) {
  const params = new URLSearchParams({ shift: opts.shift || 'day' })
  return req(`/api/date/${date}/items?${params}`)
}

// ─── Employees ──────────────────────────────────────────────────────────────

export async function getEmployees() {
  return req('/api/empl')
}

// ─── Product weights ────────────────────────────────────────────────────────

export async function getProductWeights() {
  try {
    const r = await fetch('/api/product-weights', { credentials })
    if (!r.ok) return {}
    return r.json()
  } catch {
    return {}
  }
}

export async function getProductWeightsInfo() {
  return req('/api/vs/admin/product-weights/info')
}

export async function uploadProductWeightsExcel(file) {
  const fd = new FormData()
  fd.append('file', file)
  const r = await fetch('/api/vs/admin/product-weights/upload', { method: 'POST', credentials: 'include', body: fd })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || 'Ошибка загрузки')
  return data
}

export async function deleteProductWeightsExcel() {
  return req('/api/vs/admin/product-weights', { method: 'DELETE' })
}

export async function getMissingWeight() {
  try {
    const r = await fetch('/api/missing-weight', { credentials })
    if (!r.ok) return []
    return r.json()
  } catch {
    return []
  }
}

export async function syncMissingWeight(missing, withWeight) {
  try {
    const r = await fetch('/api/missing-weight/sync', {
      method: 'POST',
      credentials,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missing, withWeight }),
    })
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

// ─── Monthly stats ──────────────────────────────────────────────────────────

export async function getMonthlyCompany(year, month, shift) {
  const params = new URLSearchParams({ year, month })
  if (shift) params.set('shift', shift)
  return req(`/api/stats/monthly-company?${params}`)
}

// ─── Fetch data ──────────────────────────────────────────────────────────────

export async function fetchData(payload) {
  return req('/api/fetch-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function _buildBodyForBrowser(options) {
  return {
    productId: null,
    parts: [],
    operationTypes: ['PICK_BY_LINE', 'PIECE_SELECTION_PICKING'],
    sourceCellId: null,
    targetCellId: null,
    sourceHandlingUnitBarcode: null,
    targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null,
    operationStartedAtTo: null,
    operationCompletedAtFrom: options.operationCompletedAtFrom,
    operationCompletedAtTo: options.operationCompletedAtTo,
    executorId: null,
    pageNumber: options.pageNumber || 1,
    pageSize: options.pageSize || 2000,
  }
}

function _groupItemsByHour(items) {
  const byHour = new Map()
  for (const item of items) {
    const ts = item.operationCompletedAt
    if (!ts) continue
    const d = new Date(ts)
    const dateStr = d.toISOString().slice(0, 10)
    const hour = d.getHours()
    const key = `${dateStr}\t${hour}`
    if (!byHour.has(key)) byHour.set(key, [])
    byHour.get(key).push(item)
  }
  return byHour
}

export async function fetchDataViaBrowser(token, options = {}) {
  const pageSize = Math.min(2000, Math.max(100, parseInt(options.pageSize, 10) || 2000))
  const first = await _fetchOnePageFromBrowser(token, _buildBodyForBrowser({ ...options, pageNumber: 1, pageSize }))
  let allItems = [...first.items]
  const total = first.total ?? allItems.length
  const totalPages = Math.ceil(total / pageSize)

  for (let p = 2; p <= totalPages; p++) {
    const next = await _fetchOnePageFromBrowser(token, _buildBodyForBrowser({ ...options, pageNumber: p, pageSize }))
    allItems = allItems.concat(next.items)
  }

  const byHour = _groupItemsByHour(allItems)
  let totalAdded = 0
  let totalSkipped = 0
  let lastEngine = null, lastTimings = null, lastDotnetError = null
  const allNewEmployees = []
  const seenNewNames = new Set()

  for (const [, items] of byHour) {
    const saveRes = await req('/api/save-fetched-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { items, total: items.length } }),
    })
    if (saveRes.ok !== true) throw new Error(saveRes.error || 'Ошибка сохранения')
    totalAdded += saveRes.added ?? 0
    totalSkipped += saveRes.skipped ?? 0
    lastEngine = saveRes.engine || lastEngine
    lastTimings = saveRes.timings || lastTimings
    lastDotnetError = saveRes.dotnetError || lastDotnetError
    for (const n of (saveRes.newEmployees || [])) {
      if (!seenNewNames.has(n)) { seenNewNames.add(n); allNewEmployees.push(n) }
    }
  }

  return {
    success: true,
    fetched: allItems.length,
    added: totalAdded,
    skipped: totalSkipped,
    engine: lastEngine,
    dotnetError: lastDotnetError,
    timings: lastTimings,
    newEmployees: allNewEmployees,
  }
}

export async function requestFetch() {
  return req('/api/vs/request-fetch', { method: 'POST' })
}

export async function requestEoRefresh(routeId) {
  return req(`/api/rk/routes/${encodeURIComponent(routeId)}/eos/request-refresh`, { method: 'POST' })
}

export async function markUpdated() {
  return req('/api/vs/mark-updated', { method: 'POST' })
}

// ─── Monitor / Rollcall ──────────────────────────────────────────────────────

export async function getRollcall() {
  return req('/api/rollcall')
}

export async function putRollcall(shiftKey, present) {
  return req('/api/rollcall', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shiftKey, present }),
  })
}

export async function saveEmplOne(fio, company) {
  return req('/api/empl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fio: (fio || '').trim(), company: (company != null ? String(company) : '').trim() }),
  })
}

export async function enrichEmplNames() {
  return req('/api/empl/enrich-names', { method: 'POST' })
}

export async function addNewEmployees(names) {
  return req('/api/empl/add-new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  })
}

export async function getLiveMonitor() {
  const r = await fetch('/api/monitor/live', { credentials })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(data?.error || r.statusText || `HTTP ${r.status}`)
  return data
}

const LIVE_MONITOR_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress'
const SAMOKAT_STOCKS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search'

export async function getLiveMonitorViaBrowser(token) {
  const r = await fetch(LIVE_MONITOR_URL, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    },
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Сервер вернул HTML вместо JSON. Проверьте вход или обновите страницу.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

async function _fetchOnePageFromBrowser(token, body) {
  const r = await fetch(SAMOKAT_STOCKS_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Сервер вернул HTML вместо JSON. Проверьте VPN или доступ.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  const value = data?.value || data
  const items = Array.isArray(value?.items) ? value.items : []
  const total = value?.total ?? data?.totalElements ?? null
  return { items, total }
}

export async function fetchLastCompletedForExecutor(token, executorId, fromIso, toIso) {
  const body = {
    productId: null,
    parts: [],
    operationTypes: [],
    sourceCellId: null,
    targetCellId: null,
    sourceHandlingUnitBarcode: null,
    targetHandlingUnitBarcode: null,
    operationStartedAtFrom: null,
    operationStartedAtTo: null,
    operationCompletedAtFrom: fromIso,
    operationCompletedAtTo: toIso,
    executorId: executorId || null,
    pageNumber: 1,
    pageSize: 100,
  }
  const { items } = await _fetchOnePageFromBrowser(token, body)
  let maxCompletedAt = null
  for (const item of items) {
    const at = item.operationCompletedAt
    if (!at) continue
    const ts = new Date(at).getTime()
    if (maxCompletedAt === null || ts > maxCompletedAt) maxCompletedAt = ts
  }
  return { items, maxCompletedAt }
}

// ─── Shipments / РК ──────────────────────────────────────────────────────────

export async function deleteRkRoutesBulk(ids) {
  const r = await fetch('/api/rk/routes/bulk', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
    credentials,
  })
  return r.json()
}

export async function getRkRoutes({ q, dateFrom, dateTo, status } = {}) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  if (status) params.set('status', status)
  const r = await fetch(`/api/rk/routes?${params}`, { credentials })
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка загрузки маршрутов')
  return r.json()
}

export async function uploadRkPhotos(files) {
  const form = new FormData()
  for (const f of files) form.append('photos', f)
  const r = await fetch('/api/rk/photos', { method: 'POST', body: form, credentials })
  return r.json()
}

export async function submitRkShipment(routeId, { by, gate, items, photos }) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by, gate, items, photos }),
    credentials,
  })
  return r.json()
}

export async function submitRkReceiving(routeId, { by, gate, items, photos }) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by, gate, items, photos }),
    credentials,
  })
  return r.json()
}

export async function updateRkDriver(routeId, { name, phone }) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/driver`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone }),
    credentials,
  })
  return r.json()
}

export async function updateRkShipment(routeId, payload) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/ship`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials,
  })
  return r.json()
}

export async function updateRkReceiving(routeId, payload) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/receive`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials,
  })
  return r.json()
}

export async function confirmRkShipment(routeId) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/confirm-ship`, {
    method: 'POST', credentials,
  })
  return r.json()
}

export async function confirmRkReceiving(routeId) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/confirm-receive`, {
    method: 'POST', credentials,
  })
  return r.json()
}

export async function getRkDrivers(q) {
  const r = await fetch(`/api/rk/drivers?q=${encodeURIComponent(q || '')}`, { credentials })
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка')
  return r.json()
}

export async function getRkCfz(q) {
  const r = await fetch(`/api/rk/cfz?q=${encodeURIComponent(q || '')}`, { credentials })
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка')
  return r.json()
}

export async function getShipmentsCodes() {
  const r = await fetch('/api/shipments/codes', { credentials })
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка')
  return r.json()
}

export async function getShipmentsMissingCodes() {
  const r = await fetch('/api/shipments/missing-codes', { credentials })
  if (!r.ok) throw new Error((await r.json()).error || 'Ошибка')
  return r.json()
}

export async function setShipmentRecipientCode(address, code) {
  const r = await fetch('/api/shipments/set-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, code }),
    credentials,
  })
  return r.json()
}

const WMS_ROUTES_BASE = 'https://api-p01.samokat.ru/wmsout-wwh/shipments/routes'

function _wmsHeaders(token) {
  return {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://wwh.samokat.ru',
    'Referer': 'https://wwh.samokat.ru/',
  }
}

async function _wmsGet(url, token) {
  const r = await fetch(url, { headers: _wmsHeaders(token) })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('WMS вернул HTML — токен устарел. Обновите страницу и войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('WMS вернул не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

// ─── Consolidation ───────────────────────────────────────────────────────────

export async function getConsolidationComplaints() {
  return req('/api/consolidation/complaints')
}

export async function updateComplaintStatus(id, status) {
  return req(`/api/consolidation/complaints/${encodeURIComponent(id)}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}

export async function deleteComplaint(id) {
  return req(`/api/consolidation/complaints/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function saveComplaintLookup(id, data) {
  return req(`/api/consolidation/complaints/${encodeURIComponent(id)}/lookup`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function sendComplaintsToTelegram(complaintIds) {
  return req('/api/consolidation/telegram/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ complaintIds }),
  })
}


// ─── Settings ────────────────────────────────────────────────────────────────

export async function getVsAdminUsers() {
  return req('/api/vs/admin/users')
}

export async function putVsAdminUser(login, payload) {
  return req('/api/vs/admin/users', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, ...payload }),
  })
}

export async function deleteVsAdminUser(login) {
  return req(`/api/vs/admin/users/${encodeURIComponent(login)}`, { method: 'DELETE' })
}

export async function getVsTelegramStatus() {
  return req('/api/vs/telegram/status')
}

export async function getConfig() {
  const r = await fetch('/api/config', { credentials })
  return r.json()
}

export async function putConfig(data) {
  return req('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function listShifts() {
  const r = await fetch('/api/shifts', { credentials })
  return r.json()
}

export async function saveEmployeesCsv(csv) {
  return req('/api/employees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  })
}

export async function fetchRkFromWms({ dateFrom, dateTo, token, onProgress }) {
  const fromIso = new Date(dateFrom + 'T00:00:00+03:00').toISOString()
  const toIso   = new Date(dateTo   + 'T23:59:59+03:00').toISOString()

  function buildParams(pageNumber, pageSize) {
    const p = new URLSearchParams({ dateFrom: fromIso, dateTo: toIso, pageNumber, pageSize })
    p.append('status', 'PACKAGING')
    p.append('status', 'COMPLETED')
    return p
  }

  const pageSize = 100
  const firstData = await _wmsGet(`${WMS_ROUTES_BASE}?${buildParams(1, pageSize)}`, token)
  const first = firstData?.value ?? firstData
  const total = first?.total || 0
  const rawItems = [...(first?.items || [])]
  const pages = Math.ceil(total / pageSize)
  for (let p = 2; p <= pages; p++) {
    const d = await _wmsGet(`${WMS_ROUTES_BASE}?${buildParams(p, pageSize)}`, token)
    rawItems.push(...((d?.value ?? d)?.items || []))
  }
  const seen = new Set()
  const items = rawItems.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true })

  if (onProgress) onProgress(`Маршрутов: ${items.length}. Загружаю детали...`)

  const routeDetails = []
  const BATCH = 5
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH)
    const details = await Promise.all(
      batch.map(item => _wmsGet(`${WMS_ROUTES_BASE}/${encodeURIComponent(item.id)}`, token).catch(e => ({ _error: e.message })))
    )
    for (const d of details) { if (!d._error) routeDetails.push(d) }
    if (onProgress) onProgress(`Загружено деталей: ${routeDetails.length} / ${items.length}...`)
  }

  const r = await fetch('/api/rk/import-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routes: routeDetails }),
    credentials,
  })
  return r.json()
}

export async function getAnalysisEmployeeRates({ dateFrom, dateTo, shift, idleThresholdMinutes } = {}) {
  const params = new URLSearchParams()
  if (dateFrom) params.set('dateFrom', String(dateFrom))
  if (dateTo) params.set('dateTo', String(dateTo))
  if (shift === 'day' || shift === 'night') params.set('shift', shift)
  if (idleThresholdMinutes != null && idleThresholdMinutes !== '') params.set('idleThresholdMinutes', String(idleThresholdMinutes))
  const qs = params.toString()
  const r = await fetch(`/api/analysis/employee-rates${qs ? '?' + qs : ''}`, { credentials })
  return r.json()
}

// ─── ЕО маршрутов (публичные, используются на /receive) ─────────────────────

const WMS_ROUTE_URL = 'https://api-p01.samokat.ru/wmsout-wwh/shipments/routes/'

/** Получить данные маршрута из WMS напрямую из браузера (аналог fetchDataViaBrowser) */
export async function fetchRouteFromWMS(token, routeId) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  let r
  try {
    r = await fetch(WMS_ROUTE_URL + encodeURIComponent(routeId), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://wwh.samokat.ru',
        Referer: 'https://wwh.samokat.ru/',
      },
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('WMS не ответил за 20 секунд. Проверьте интернет или попробуйте позже.')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`WMS HTTP ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

export async function getRouteEos(routeId) {
  const r = await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/eos`)
  return r.json()
}

export async function refreshStoreEos(routeId, storeId, eos) {
  const r = await fetch(
    `/api/rk/routes/${encodeURIComponent(routeId)}/stores/${encodeURIComponent(storeId)}/eos/refresh`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eos }) }
  )
  return r.json()
}

// ─── Reports ─────────────────────────────────────────────────────────────────

const MONITORING_STATS_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/stats'
const INBOUND_TASKS_URL    = 'https://api.samokat.ru/wmsin-wwh/inbound/tasks'
const MOVEMENTS_URL        = 'https://api-p01.samokat.ru/wmsout-wwh/movements/picking-refill/tasks'

/** Общий хелпер для прямых GET-запросов к api.samokat.ru */
async function samokatGet(token, url, params) {
  const r = await fetch(`${url}?${params}`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
  })
  const text = await r.text()
  const trimmed = (text || '').trim().toLowerCase()
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) {
    throw new Error('Нет доступа к API. Проверьте VPN или войдите заново.')
  }
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw new Error('Ответ не JSON: ' + (text || '').slice(0, 150))
  }
  if (!r.ok) throw new Error(`API ${r.status}: ${data?.message || data?.error || r.statusText}`)
  return data
}

/** Статистика отборки (КДК + Хранение). createdAtFrom/To — ISO UTC. */
export async function getReportMonitoringStats(token, createdAtFrom, createdAtTo) {
  return samokatGet(token, MONITORING_STATS_URL, new URLSearchParams({ createdAtFrom, createdAtTo }))
}

/**
 * Приёмка — принятые задания (COMPLETED_AS_PLANNED + COMPLETED_WITH_DISCREPANCY).
 * types: массив строк — 'CROSSDOCK' для КДК, ['STORAGE_DC','STORAGE','IMPORT'] для Хранения.
 * completedAtDateFrom/To — ISO UTC (окно: день-1 21:00Z → день 20:59:59.999Z).
 * Нам нужен только value.total.
 */
/**
 * Приёмка — задания в процессе (AWAITING_GATE + AWAITING_ACCEPTANCE + ACCEPTANCE_IN_PROGRESS).
 * types: массив — 'CROSSDOCK' для КДК, ['STORAGE_DC','STORAGE','IMPORT'] для Хранения.
 * Без фильтра по дате. Нам нужен только value.total.
 */
export async function getReportInboundInProgress(token, { types }) {
  const params = new URLSearchParams()
  params.append('status', 'AWAITING_GATE')
  params.append('status', 'AWAITING_ACCEPTANCE')
  params.append('status', 'ACCEPTANCE_IN_PROGRESS')
  for (const t of [].concat(types)) params.append('type', t)
  params.append('temperatureMode', 'MEDIUM_COLD')
  params.append('temperatureMode', 'ORDINARY')
  params.set('inboundSortFieldName', 'PLANNED_ARRIVAL_DATE')
  params.set('sortDirection', 'DESC')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, INBOUND_TASKS_URL, params)
}

/**
 * Пополнение — количество выполненных спусков (MOVE_DOWN) за смену.
 * dateFrom/dateTo — ISO UTC (окно: день-1 21:00Z → день 20:59:59.999Z).
 * Возвращает value.items.length (или value.total если есть).
 */
/** Пополнение — выполненные спуски MOVE_DOWN за смену. */
export async function getReportMovementsCount(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.set('taskType', 'MOVE_DOWN')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

/** Пополнение — остаток спусков MOVE_DOWN (CREATED + IN_PROGRESS) за смену. */
export async function getReportMovementsRest(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.append('status', 'CREATED')
  params.append('status', 'IN_PROGRESS')
  params.set('taskType', 'MOVE_DOWN')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

/** Пополнение — выполненные перемещения MOVE_TO_PICKING за смену (используется для столбца "Перемещение"). */
export async function getReportMoveToPickingCount(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.set('taskType', 'MOVE_TO_PICKING')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

/** Пополнение — остаток перемещений MOVE_TO_PICKING (CREATED + IN_PROGRESS) за смену. */
export async function getReportMoveToPickingRest(token, { dateFrom, dateTo }) {
  const params = new URLSearchParams()
  params.set('dateFrom', dateFrom)
  params.set('dateTo', dateTo)
  params.append('status', 'CREATED')
  params.append('status', 'IN_PROGRESS')
  params.set('taskType', 'MOVE_TO_PICKING')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, MOVEMENTS_URL, params)
}

export async function getReportInboundCompleted(token, { types, completedAtDateFrom, completedAtDateTo }) {
  const params = new URLSearchParams()
  params.append('status', 'COMPLETED_AS_PLANNED')
  params.append('status', 'COMPLETED_WITH_DISCREPANCY')
  params.set('completedAtDateFrom', completedAtDateFrom)
  params.set('completedAtDateTo', completedAtDateTo)
  for (const t of [].concat(types)) params.append('type', t)
  params.append('temperatureMode', 'MEDIUM_COLD')
  params.append('temperatureMode', 'ORDINARY')
  params.set('inboundSortFieldName', 'PLANNED_ARRIVAL_DATE')
  params.set('sortDirection', 'DESC')
  params.set('pageNumber', '1')
  params.set('pageSize', '1')
  return samokatGet(token, INBOUND_TASKS_URL, params)
}
