import { normalizeFio, getCompanyByFio, hasMatchInEmplKeys } from './emplUtils.js'
import { formatWeight, getTodayStr } from './format.js'

export const ZONES = [
  { key: 'HH',  label: 'Хол. хранение', bg: '#1d4ed8', text: '#fff' },
  { key: 'KDH', label: 'КДК холод',       bg: '#93c5fd', text: '#1e3a5f' },
  { key: 'SH',  label: 'Сух. хранение',  bg: '#c2410c', text: '#fff' },
  { key: 'KDS', label: 'КДК сухой',       bg: '#fdba74', text: '#7c2d12' },
  { key: 'MH',  label: 'Хр. заморозка',  bg: '#6d28d9', text: '#fff' },
  { key: 'KDM', label: 'КДК заморозка',   bg: '#c4b5fd', text: '#3b0764' },
]

export function getZoneFromCell(cell) {
  const prefix = String(cell || '').split('-')[0].toUpperCase()
  return ZONES.find(z => z.key === prefix) || null
}

// ─── Internal weight utils ───────────────────────────────────────────────────

let _productWeights = {}
export function setProductWeights(w) { _productWeights = w || {} }

function normalizeNameWeight(str) {
  return String(str || '').replace(/\u00a0|\u202f/g, ' ').trim()
}

function parseNumber(val) {
  const n = Number(String(val || '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function gramsFromUnit(value, unit) {
  const v = parseNumber(value)
  if (!v) return 0
  const u = String(unit || '').toLowerCase()
  if (u === 'кг' || u === 'kg') return v * 1000
  if (u === 'г'  || u === 'g')  return v
  if (u === 'л'  || u === 'l')  return v * 1000
  if (u === 'мл' || u === 'ml') return v
  return 0
}

function parseWeightGramsFromName(name) {
  const s = normalizeNameWeight(name)
  if (!s) return 0
  const combo = s.match(/(\d+(?:[.,]\d+)?)\s*[xх×]\s*(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i)
  if (combo) return parseNumber(combo[1]) * gramsFromUnit(combo[2], combo[3])
  const simple = s.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i)
  if (simple) return gramsFromUnit(simple[1], simple[2])
  return 0
}

function resolveWeightGrams(article, name) {
  if (article) {
    const w = _productWeights[String(article).trim()]
    if (w > 0) return w
  }
  return parseWeightGramsFromName(name)
}

function addWeight(map, key, grams, isKdk) {
  if (!key || grams <= 0) return
  const cur = map.get(key) || { storage: 0, kdk: 0, total: 0 }
  if (isKdk) cur.kdk += grams
  else cur.storage += grams
  cur.total = cur.storage + cur.kdk
  map.set(key, cur)
}

function getTaskKey(item) {
  const type = (item.operationType || '').toUpperCase()
  if (type === 'PICK_BY_LINE') {
    const exec = item.executorId || item.executor || ''
    const cell = item.cell || ''
    const product = item.nomenclatureCode || item.productName || ''
    return `kdk|${exec}|${cell}|${product}`
  }
  return item.id
    ? `op|${item.id}`
    : `op|${item.completedAt || item.startedAt || ''}|${item.executor || ''}|${item.cell || ''}`
}

export function filterByCompany(items, emplMap, filterCompany) {
  if (!emplMap || !filterCompany || filterCompany === '__all__') return items
  if (filterCompany === '__none__') {
    return items.filter(i => !hasMatchInEmplKeys(normalizeFio(i.executor), emplMap))
  }
  return items.filter(i => getCompanyByFio(emplMap, normalizeFio(i.executor)) === filterCompany)
}

// ─── DAY/NIGHT hours ─────────────────────────────────────────────────────────

export const DAY_HOURS   = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
export const NIGHT_HOURS = [22, 23, 0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10]

// ─── Core stats calculation ──────────────────────────────────────────────────

export function calcStats(items, emplMap, filterCompany) {
  const filtered = filterByCompany(items, emplMap, filterCompany)

  const totalTaskKeys = new Set(filtered.map(i => getTaskKey(i)))
  const totalOps = totalTaskKeys.size
  const totalQty = filtered.reduce((s, i) => s + (Number(i.quantity) || 0), 0)
  let totalWeightStorageGrams = 0
  let totalWeightKdkGrams = 0
  const missingWeightMap = new Map()
  const withWeightKeys = new Set()

  const byExecutor = new Map()
  for (const item of filtered) {
    const key = item.executor || 'Неизвестно'
    if (!byExecutor.has(key)) byExecutor.set(key, { name: key, taskKeys: new Set(), qty: 0, firstAt: null, lastAt: null })
    const e = byExecutor.get(key)
    e.taskKeys.add(getTaskKey(item))
    e.qty += Number(item.quantity) || 0
    const ts = item.completedAt || item.startedAt
    if (ts) {
      if (!e.firstAt || ts < e.firstAt) e.firstAt = ts
      if (!e.lastAt  || ts > e.lastAt)  e.lastAt  = ts
    }
  }
  const executors = [...byExecutor.values()].map(e => ({
    ...e,
    ops: e.taskKeys.size,
    company: emplMap ? (getCompanyByFio(emplMap, normalizeFio(e.name)) || '—') : '—',
  })).sort((a, b) => b.ops - a.ops)

  const byHour = new Map()
  for (const item of filtered) {
    const ts = item.completedAt
    if (!ts) continue
    const h = new Date(ts).getHours()
    if (!byHour.has(h)) byHour.set(h, { hour: h, taskKeys: new Set(), kdkTaskKeys: new Set(), employees: new Set(), storageOps: 0, kdkOps: 0 })
    const hh = byHour.get(h)
    const type = (item.operationType || '').toUpperCase()
    const isKdk = type === 'PICK_BY_LINE'
    const tk = getTaskKey(item)
    hh.taskKeys.add(tk)
    if (isKdk) hh.kdkTaskKeys.add(tk)
    else if (type === 'PIECE_SELECTION_PICKING') hh.storageOps++
    hh.kdkOps = hh.kdkTaskKeys.size
    if (item.executorId || item.executor) hh.employees.add(item.executorId || item.executor)

    const name = item.productName || item.product || item.name
    if (name) {
      const article = String(item.nomenclatureCode || item.article || '').trim()
      const gramsPerUnit = resolveWeightGrams(article, name)
      const qty = Math.max(1, Number(item.quantity) || 1)
      const weight = gramsPerUnit * qty
      const wkey = article || String(name).trim()
      if (weight > 0) {
        if (isKdk) totalWeightKdkGrams += weight
        else if (type === 'PIECE_SELECTION_PICKING') totalWeightStorageGrams += weight
        withWeightKeys.add(wkey)
      } else {
        if (!missingWeightMap.has(wkey)) missingWeightMap.set(wkey, { name: String(name).trim(), article })
      }
    }
  }

  const hourly = [...byHour.values()].map(x => ({
    hour: x.hour,
    ops: x.taskKeys.size,
    employees: x.employees.size,
    storageOps: x.storageOps,
    kdkOps: x.kdkOps,
  })).sort((a, b) => a.hour - b.hour)

  let firstAt = null, lastAt = null
  for (const item of filtered) {
    const ts = item.completedAt
    if (!ts) continue
    if (!firstAt || ts < firstAt) firstAt = ts
    if (!lastAt  || ts > lastAt)  lastAt  = ts
  }

  return {
    totalOps,
    totalQty,
    executors,
    filteredCount: filtered.length,
    hourly,
    firstAt,
    lastAt,
    totalWeightStorageGrams,
    totalWeightKdkGrams,
    totalWeightGrams: totalWeightStorageGrams + totalWeightKdkGrams,
    missingWeightNames: Array.from(missingWeightMap.values()).map(v => v.name),
    missingWeightItems: Array.from(missingWeightMap.values()),
    withWeightKeys: Array.from(withWeightKeys),
  }
}

// ─── Hourly layout ────────────────────────────────────────────────────────────

export function getHourlyForShift(hourly, shiftFilter) {
  const byHour = new Map()
  if (Array.isArray(hourly)) {
    for (const h of hourly) byHour.set(h.hour, { ...h })
  }
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS
  return order.map(col => {
    const dataHour = shiftFilter === 'day' ? col - 1 : (col - 1 + 24) % 24
    const h = byHour.get(dataHour) || { hour: dataHour, ops: 0, employees: 0, storageOps: 0, kdkOps: 0 }
    return { ...h, hour: col }
  })
}

export function filterHoursToPassed(selectedDate, shiftFilter) {
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS
  const today = selectedDate === getTodayStr()
  if (!today) return order
  const now = new Date()
  const currentHour = now.getHours()
  if (shiftFilter === 'day') return order.filter(col => col <= currentHour)
  return order.filter(col => col >= 22 || col <= currentHour)
}

export function getHoursPassedIncludingCurrent(selectedDate, shiftFilter) {
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS
  const passed = filterHoursToPassed(selectedDate, shiftFilter)
  const today = selectedDate === getTodayStr()
  if (!today) return passed
  const now = new Date()
  const currentHour = now.getHours()
  const currentCol = shiftFilter === 'day' ? currentHour + 1 : (currentHour + 1) % 24
  if (order.includes(currentCol) && !passed.includes(currentCol)) {
    return shiftFilter === 'day'
      ? [...passed, currentCol].sort((a, b) => a - b)
      : order.filter(col => passed.includes(col) || col === currentCol)
  }
  return passed
}

// ─── Hourly by employee ───────────────────────────────────────────────────────

export function calcHourlyByEmployee(items, shiftFilter = 'day', enrichFn = null) {
  const order = shiftFilter === 'night' ? NIGHT_HOURS : DAY_HOURS
  const byEmployee = new Map()
  const resolveName = enrichFn || (n => n)

  for (const item of items) {
    const ts = item.completedAt
    if (!ts) continue
    const h = new Date(ts).getHours()
    const col = (h + 1) % 24
    const name = resolveName(item.executor || 'Неизвестно')
    if (!byEmployee.has(name)) byEmployee.set(name, { hourMap: new Map(), firstAt: null, lastAt: null })
    const emp = byEmployee.get(name)
    if (!emp.firstAt || ts < emp.firstAt) emp.firstAt = ts
    if (!emp.lastAt  || ts > emp.lastAt)  emp.lastAt  = ts
    const hourMap = emp.hourMap
    if (!hourMap.has(col)) hourMap.set(col, { pieceSelectionCount: 0, kdkSet: new Set(), weightGrams: 0, zoneCounts: {}, zoneWeights: {} })
    const cell = hourMap.get(col)

    const type = (item.operationType || '').toUpperCase()
    if (type === 'PIECE_SELECTION_PICKING') {
      cell.pieceSelectionCount++
    } else if (type === 'PICK_BY_LINE') {
      const productId = item.nomenclatureCode || item.productName || 'no-product'
      const targetCell = item.cell || 'no-target-cell'
      cell.kdkSet.add(`${productId}||${targetCell}`)
    }

    const isWeightOp = type === 'PIECE_SELECTION_PICKING' || type === 'PICK_BY_LINE'
    if (isWeightOp) {
      const zone = getZoneFromCell(item.cell)
      if (zone) cell.zoneCounts[zone.key] = (cell.zoneCounts[zone.key] || 0) + 1
      const productName = item.productName || item.product || item.name
      if (productName) {
        const itemArticle = String(item.nomenclatureCode || item.article || '').trim()
        const gramsPerUnit = resolveWeightGrams(itemArticle, productName)
        if (gramsPerUnit > 0) {
          const qty = Math.max(1, Number(item.quantity) || 1)
          const grams = gramsPerUnit * qty
          cell.weightGrams += grams
          if (zone) cell.zoneWeights[zone.key] = (cell.zoneWeights[zone.key] || 0) + grams
        }
      }
    }
  }

  const rows = []
  for (const [name, emp] of byEmployee) {
    const { hourMap, firstAt, lastAt } = emp
    const byHour = {}, weightByHour = {}, byHourZone = {}, byZone = {}
    let total = 0
    for (const col of order) {
      const cell = hourMap.get(col)
      if (!cell) { byHour[col] = 0; weightByHour[col] = 0; byHourZone[col] = null; continue }
      const sz = cell.pieceSelectionCount + (cell.kdkSet ? cell.kdkSet.size : 0)
      byHour[col] = sz
      weightByHour[col] = cell.weightGrams
      const totalCnt = Object.values(cell.zoneCounts).reduce((s, v) => s + v, 0)
      const totalWg  = Object.values(cell.zoneWeights).reduce((s, v) => s + v, 0)
      const allZk = new Set([...Object.keys(cell.zoneCounts), ...Object.keys(cell.zoneWeights)])
      let domKey = null, domScore = -1
      for (const zk of allZk) {
        const scoreCnt = totalCnt > 0 ? (cell.zoneCounts[zk] || 0) / totalCnt : 0
        const scoreWg  = totalWg  > 0 ? (cell.zoneWeights[zk] || 0) / totalWg  : 0
        const score = totalWg > 0 ? (scoreCnt + scoreWg) / 2 : scoreCnt
        if (score > domScore) { domScore = score; domKey = zk }
      }
      byHourZone[col] = domKey
      for (const [zk, cnt] of Object.entries(cell.zoneCounts)) {
        if (!byZone[zk]) byZone[zk] = { count: 0, weightGrams: 0 }
        byZone[zk].count += cnt
      }
      for (const [zk, wg] of Object.entries(cell.zoneWeights)) {
        if (!byZone[zk]) byZone[zk] = { count: 0, weightGrams: 0 }
        byZone[zk].weightGrams += wg
      }
      total += sz
    }
    rows.push({ name, byHour, weightByHour, byHourZone, byZone, total, firstAt, lastAt })
  }
  return { hours: order, rows }
}

// ─── Company summary ──────────────────────────────────────────────────────────

export function getHourlyByEmployeeGroupedByCompany(items, shiftFilter, emplMap, selectedDate, enrichFn = null) {
  const { rows } = calcHourlyByEmployee(items, shiftFilter, enrichFn)
  const hours = getHoursPassedIncludingCurrent(selectedDate, shiftFilter)
  const getCompany = name => emplMap && name ? (getCompanyByFio(emplMap, normalizeFio(name)) || '—') : '—'
  const withCompany = rows.map(r => ({ ...r, company: getCompany(r.name) }))
  const byCompany = new Map()
  for (const r of withCompany) {
    const c = r.company || '—'
    if (!byCompany.has(c)) byCompany.set(c, [])
    byCompany.get(c).push(r)
  }
  for (const arr of byCompany.values()) arr.sort((a, b) => b.total - a.total)
  const companyTotals = new Map()
  for (const [c, arr] of byCompany) companyTotals.set(c, arr.reduce((s, r) => s + r.total, 0))
  const companiesOrder = [...byCompany.keys()].sort((a, b) => (companyTotals.get(b) || 0) - (companyTotals.get(a) || 0))
  const allRows = companiesOrder.flatMap(c => byCompany.get(c) || [])
  return { hours, byCompany: Object.fromEntries(byCompany), allRows, companiesOrder }
}

export function getCompanySummaryTableData(items, shiftFilter, emplMap, selectedDate) {
  const { hours, byCompany, companiesOrder } = getHourlyByEmployeeGroupedByCompany(items, shiftFilter, emplMap, selectedDate)
  const hoursDisplay = getHoursPassedIncludingCurrent(selectedDate, shiftFilter)
  const passedHours = hours.length
  const weightByCompany = new Map()
  const szByCompany = new Map()

  for (const item of items || []) {
    const type = (item.operationType || '').toUpperCase()
    const isKdk = type === 'PICK_BY_LINE'
    if (!isKdk && type !== 'PIECE_SELECTION_PICKING') continue
    const company = emplMap ? (getCompanyByFio(emplMap, normalizeFio(item.executor)) || '—') : '—'
    if (!szByCompany.has(company)) szByCompany.set(company, { storage: 0, kdk: 0 })
    const szEntry = szByCompany.get(company)
    if (isKdk) szEntry.kdk += 1; else szEntry.storage += 1
    const name = item.productName || item.product || item.name
    if (!name) continue
    const art = String(item.nomenclatureCode || item.article || '').trim()
    const gramsPerUnit = resolveWeightGrams(art, name)
    if (gramsPerUnit <= 0) continue
    const qty = Math.max(1, Number(item.quantity) || 1)
    addWeight(weightByCompany, company, gramsPerUnit * qty, isKdk)
  }

  // ─── weightByEmployee (for HE table columns Вес ХР/КДК/итог) ───
  const weightByEmployee = new Map()
  for (const item of items || []) {
    const type = (item.operationType || '').toUpperCase()
    const isKdk = type === 'PICK_BY_LINE'
    if (!isKdk && type !== 'PIECE_SELECTION_PICKING') continue
    const name = item.productName || item.product || item.name
    if (!name) continue
    const art = String(item.nomenclatureCode || item.article || '').trim()
    const grams = resolveWeightGrams(art, name)
    if (grams <= 0) continue
    const qty = Math.max(1, Number(item.quantity) || 1)
    const empName = item.executor || item.executorId || 'Неизвестно'
    addWeight(weightByEmployee, empName, grams * qty, isKdk)
  }

  const rows = companiesOrder.map(c => {
    const companyRows = byCompany[c] || []
    const employeesCount = companyRows.length
    const totalTasks = companyRows.reduce((s, r) => s + r.total, 0)
    const szch = passedHours > 0 && employeesCount > 0 ? Math.round(totalTasks / employeesCount / passedHours) : 0
    const byHour = {}
    for (const col of hoursDisplay) {
      byHour[col] = companyRows.reduce((s, r) => s + (r.byHour?.[col] || 0), 0)
    }
    const w = weightByCompany.get(c) || { storage: 0, kdk: 0, total: 0 }
    const sz = szByCompany.get(c) || { storage: 0, kdk: 0 }
    const vezch = passedHours > 0 && employeesCount > 0 ? Math.round(w.total / employeesCount / passedHours) : 0
    const firstAtC = companyRows.reduce((min, r) => !r.firstAt ? min : (!min || r.firstAt < min ? r.firstAt : min), null)
    const lastAtC  = companyRows.reduce((max, r) => !r.lastAt  ? max : (!max || r.lastAt  > max ? r.lastAt  : max), null)
    return { companyName: c, employeesCount, szch, vezch, totalTasks, szStorage: sz.storage, szKdk: sz.kdk, byHour, weightStorageGrams: w.storage, weightKdkGrams: w.kdk, weightTotalGrams: w.total, firstAt: firstAtC, lastAt: lastAtC }
  })
  return { rows, hoursDisplay }
}

// ─── Idle calculations ────────────────────────────────────────────────────────

export function getShiftBoundaryMs(dateStr, shiftFilter) {
  if (!dateStr) return { startMs: 0, endMs: 0 }
  const [y, m, d] = dateStr.split('-').map(Number)
  if (shiftFilter === 'day') {
    return {
      startMs: Date.UTC(y, m - 1, d, 6, 0, 0),
      endMs:   Date.UTC(y, m - 1, d, 18, 0, 0),
    }
  }
  return {
    startMs: Date.UTC(y, m - 1, d, 18, 0, 0),
    endMs:   Date.UTC(y, m - 1, d + 1, 6, 0, 0),
  }
}

export function calcIdlesByEmployee(items, thresholdMs = 15 * 60 * 1000, shiftStartMs = 0, shiftEndMs = 0) {
  const byExecutor = new Map()
  for (const item of items) {
    const name = item.executor || ''
    if (!name || !item.completedAt) continue
    if (!byExecutor.has(name)) byExecutor.set(name, [])
    byExecutor.get(name).push(new Date(item.completedAt).getTime())
  }
  const out = {}
  const fmt = iso => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }
  for (const [name, times] of byExecutor) {
    times.sort((a, b) => a - b)
    const idles = []
    if (shiftStartMs > 0 && times[0] - shiftStartMs >= thresholdMs)
      idles.push(fmt(shiftStartMs) + '–' + fmt(times[0]))
    for (let i = 1; i < times.length; i++)
      if (times[i] - times[i - 1] >= thresholdMs)
        idles.push(fmt(times[i - 1]) + '–' + fmt(times[i]))
    if (shiftEndMs > 0 && shiftEndMs - times[times.length - 1] >= thresholdMs)
      idles.push(fmt(times[times.length - 1]) + '–' + fmt(shiftEndMs))
    if (idles.length) out[name] = idles.join(', ')
  }
  return out
}

export function calcIdleTotalsByEmployee(items, thresholdMs, shiftFilter, shiftStartMs, shiftEndMs) {
  const idlesMap = calcIdlesByEmployee(items, thresholdMs, shiftStartMs, shiftEndMs)
  const out = {}
  for (const [name, raw] of Object.entries(idlesMap)) {
    const totalMinutes = parseIdleTotalMinutes(raw, shiftFilter)
    out[name] = { intervals: raw, totalMinutes, totalMs: totalMinutes * 60 * 1000 }
  }
  return out
}

export function computeWorkedMinutesInShift(totalIdleMinutes, allowedIdleMinutes = 0, shiftMinutes = 12 * 60) {
  const effective = Math.max(0, (Number(totalIdleMinutes) || 0) - (Number(allowedIdleMinutes) || 0))
  return Math.max(0, shiftMinutes - effective)
}

export function getElapsedShiftMinutes(selectedDate, shiftFilter) {
  if (!selectedDate) return 12 * 60
  const { startMs, endMs } = getShiftBoundaryMs(selectedDate, shiftFilter)
  const nowMs = Date.now()
  if (nowMs <= startMs) return 0
  if (nowMs >= endMs) return 12 * 60
  return Math.floor((nowMs - startMs) / 60000)
}

function parseIdleTotalMinutes(raw, shiftFilter = 'day') {
  if (!raw) return 0
  const re = /(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/g
  const mapMin = (h, m) => {
    if (shiftFilter === 'night') {
      if (h >= 21) return (h - 21) * 60 + m
      if (h < 9) return 3 * 60 + h * 60 + m
      return null
    }
    if (h < 9 || h >= 21) return null
    return (h - 9) * 60 + m
  }
  let total = 0, match
  while ((match = re.exec(raw)) !== null) {
    const s = mapMin(Number(match[1]), Number(match[2]))
    const e = mapMin(Number(match[3]), Number(match[4]))
    if (s != null && e != null && e > s) total += e - s
  }
  return total
}

export function parseIdleIntervalsForTimeline(raw, shiftFilter = 'day') {
  if (!raw) return []
  const re = /(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/g
  const mapMin = (h, m) => {
    if (shiftFilter === 'night') {
      if (h >= 21) return (h - 21) * 60 + m
      if (h < 9) return 3 * 60 + h * 60 + m
      return null
    }
    if (h < 9 || h >= 21) return null
    return (h - 9) * 60 + m
  }
  const out = []
  const parts = String(raw).split(',').map(p => p.trim())
  for (const part of parts) {
    const m = part.match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/)
    if (!m) continue
    const s = mapMin(Number(m[1]), Number(m[2]))
    const e = mapMin(Number(m[3]), Number(m[4]))
    if (s != null && e != null && e > s) out.push({ start: s, end: e, label: part })
  }
  return out
}

export function getWeightByEmployee(items) {
  const map = new Map()
  for (const item of items || []) {
    const type = (item.operationType || '').toUpperCase()
    const isKdk = type === 'PICK_BY_LINE'
    if (!isKdk && type !== 'PIECE_SELECTION_PICKING') continue
    const name = item.productName || item.product || item.name
    if (!name) continue
    const art = String(item.nomenclatureCode || item.article || '').trim()
    const grams = resolveWeightGrams(art, name)
    if (grams <= 0) continue
    const qty = Math.max(1, Number(item.quantity) || 1)
    const empName = item.executor || item.executorId || 'Неизвестно'
    addWeight(map, empName, grams * qty, isKdk)
  }
  return Object.fromEntries(map)
}
