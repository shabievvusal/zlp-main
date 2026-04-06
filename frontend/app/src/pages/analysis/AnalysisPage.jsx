import { useState, useEffect, useCallback, useRef } from 'react'
import { useApp as useAppContext } from '../../context/AppContext.jsx'
import * as api from '../../api/index.js'
import s from './AnalysisPage.module.css'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowDateStr() {
  return new Date().toISOString().slice(0, 10)
}

function parseNum(val) {
  const n = Number(val)
  return Number.isFinite(n) ? n : 0
}

function formatHours(h) {
  const totalMin = Math.round(h * 60)
  if (!Number.isFinite(totalMin) || totalMin <= 0) return '—'
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  if (hours <= 0) return `${mins}м`
  return `${hours}ч ${String(mins).padStart(2, '0')}м`
}

function formatTime(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function buildDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null
  const [hh, mm] = String(timeStr).split(':').map(Number)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  const d = new Date(dateStr + 'T00:00:00')
  d.setHours(hh, mm, 0, 0)
  return d
}

function toDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getBreakMinutesBetween(start, end, breaks) {
  if (!start || !end || !breaks || !breaks.length) return 0
  if (end <= start) return 0
  let minutes = 0
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= endDay; d.setDate(d.getDate() + 1)) {
    const dateStr = toDateStr(d)
    for (const br of breaks) {
      if (!br || !br.start || !br.duration) continue
      const dur = Number(br.duration) || 0
      if (dur <= 0) continue
      const bStart = buildDateTime(dateStr, br.start)
      if (!bStart) continue
      const bEnd = new Date(bStart.getTime() + dur * 60 * 1000)
      const from = Math.max(start.getTime(), bStart.getTime())
      const to = Math.min(end.getTime(), bEnd.getTime())
      if (to > from) minutes += (to - from) / 60000
    }
  }
  return minutes
}

function computeFinishWithBreaks(start, workHours, breaks) {
  if (!start || !Number.isFinite(workHours) || workHours <= 0) return null
  let finish = new Date(start.getTime() + workHours * 60 * 60 * 1000)
  let prevBreak = -1
  for (let i = 0; i < 3; i++) {
    const breakMinutes = getBreakMinutesBetween(start, finish, breaks)
    if (breakMinutes === prevBreak) break
    prevBreak = breakMinutes
    finish = new Date(start.getTime() + workHours * 60 * 60 * 1000 + breakMinutes * 60 * 1000)
  }
  return finish
}

function getHoursAvailable(start, target) {
  if (!start || !target) return null
  let diff = target.getTime() - start.getTime()
  if (diff <= 0) diff += 24 * 60 * 60 * 1000
  return diff / (60 * 60 * 1000)
}

function computeRow(row, dateStr, startTime, breaks) {
  const volume = parseNum(row.volume)
  const avgRate = parseNum(row.peak)
  const people = parseNum(row.people)
  const start = buildDateTime(dateStr, row.start || startTime)
  const target = buildDateTime(dateStr, row.target)
  const hoursAvailableRaw = getHoursAvailable(start, target)
  const breakMinutes = hoursAvailableRaw ? getBreakMinutesBetween(start, target, breaks) : 0
  const hoursAvailable = hoursAvailableRaw ? Math.max(0, hoursAvailableRaw - breakMinutes / 60) : null
  const canCalc = volume > 0 && avgRate > 0
  const workHoursNeeded = canCalc && people > 0 ? volume / (avgRate * people) : (canCalc ? volume / avgRate : 0)
  const finish = canCalc && people > 0 && start ? computeFinishWithBreaks(start, workHoursNeeded, breaks) : null

  let duration = '—'
  if (canCalc && people > 0 && finish && start) {
    duration = formatHours((finish.getTime() - start.getTime()) / (60 * 60 * 1000))
  }
  const finishStr = finish ? formatTime(finish) : '—'
  let required = '—'
  if (volume > 0 && hoursAvailable && hoursAvailable > 0) {
    required = String(Math.ceil(volume / hoursAvailable))
  }
  let needPeople = '—'
  if (canCalc && hoursAvailable && hoursAvailable > 0) {
    needPeople = String(Math.ceil(volume / (avgRate * hoursAvailable)))
  }
  return { duration, finishStr, required, needPeople }
}

const OP_ZONES = {
  storage_dry: ['SH'],
  storage_cold: ['HH'],
  crossdock_dry: ['KDS'],
  crossdock_cold: ['KDH'],
}

function calcZoneAffinity(emp, zones) {
  if (!zones || !zones.length) return 0
  const bz = emp.byZone && typeof emp.byZone === 'object' ? emp.byZone : {}
  let totalCount = 0, totalWg = 0, zoneCount = 0, zoneWg = 0
  for (const [zk, zv] of Object.entries(bz)) {
    const cnt = Number(zv.count) || 0
    const wg = Number(zv.weightGrams) || 0
    totalCount += cnt; totalWg += wg
    if (zones.includes(zk)) { zoneCount += cnt; zoneWg += wg }
  }
  if (totalCount === 0) return 0
  const scoreCnt = zoneCount / totalCount
  const scoreWg = totalWg > 0 ? zoneWg / totalWg : scoreCnt
  return (scoreCnt + scoreWg) / 2
}

function pickStaffForOperations(ops, employees, dateStr, defaultStartTime) {
  const opOrder = ops
    .filter(o => o.requiredPeople > 0)
    .map(o => {
      const start = buildDateTime(dateStr, o.startTime || defaultStartTime)
      const target = buildDateTime(dateStr, o.targetTime || '')
      return { ...o, hoursAvailable: getHoursAvailable(start, target) || null }
    })
    .sort((a, b) => {
      const aStorage = String(a.key || '').startsWith('storage')
      const bStorage = String(b.key || '').startsWith('storage')
      if (aStorage !== bStorage) return aStorage ? -1 : 1
      const ta = a.hoursAvailable || Infinity, tb = b.hoursAvailable || Infinity
      if (ta !== tb) return ta - tb
      return b.requiredWeightPerHour - a.requiredWeightPerHour
    })

  const assigned = new Set()
  const results = []
  for (const op of opOrder) {
    const zones = OP_ZONES[op.key] || []
    const hasZoneData = employees.some(e => e.byZone && Object.keys(e.byZone).length > 0)
    const candidates = employees
      .filter(e => !assigned.has(e.name))
      .map(e => ({ ...e, _affinity: hasZoneData ? calcZoneAffinity(e, zones) : 0 }))
      .sort((a, b) => {
        if (Math.abs(b._affinity - a._affinity) > 0.01) return b._affinity - a._affinity
        return b.szPerHour - a.szPerHour
      })
    const picked = []
    for (const emp of candidates) {
      if (picked.length >= op.requiredPeople) break
      assigned.add(emp.name)
      picked.push({ ...emp })
    }
    results.push({ name: op.name, requiredPeople: op.requiredPeople, requiredWeightPerHour: op.requiredWeightPerHour, picked, sumPeople: picked.length, ok: picked.length >= op.requiredPeople })
  }
  return results
}

function getAllowedTargets(sourceKey) {
  if (sourceKey === 'storage_dry') return new Set(['crossdock_dry', 'crossdock_cold'])
  if (sourceKey === 'storage_cold') return new Set(['crossdock_cold'])
  return new Set()
}

function buildTransferBuckets(assignment, normSzPerHour, weakMovePercent) {
  const people = assignment.picked || []
  const passed = people.filter(p => (Number(p.szPerHour) || 0) >= normSzPerHour)
  const weak = people.filter(p => (Number(p.szPerHour) || 0) < normSzPerHour)
  const moveWeakCount = Math.max(0, Math.floor(weak.length * (Math.max(0, Math.min(100, weakMovePercent)) / 100)))
  const weakSorted = weak.slice().sort((x, y) => y.szPerHour - x.szPerHour)
  return {
    passed, weakMove: weakSorted.slice(0, moveWeakCount), weakStay: weakSorted.slice(moveWeakCount),
    move: [...passed, ...weakSorted.slice(0, moveWeakCount)], stay: weakSorted.slice(moveWeakCount),
  }
}

function computeFinishTime(op, assignment, dateStr, defaultStartTime, breaks) {
  const peopleCount = assignment?.picked?.length || 0
  if (!op || !op.volume || !op.avgRate || peopleCount <= 0) return null
  const start = buildDateTime(dateStr, (op.startTime || '') || defaultStartTime)
  if (!start) return null
  return computeFinishWithBreaks(start, op.volume / (op.avgRate * peopleCount), breaks)
}

function autoRedistribute(assignments, ops, dateStr, defaultStartTime, normSzPerHour, weakMovePercent, breaks) {
  const opsByName = new Map(ops.map(o => [o.name, o]))
  const work = assignments.map(a => ({ ...a, picked: [...(a.picked || [])], sumPeople: (a.picked || []).length }))
  const finishList = work.map(a => {
    const op = opsByName.get(a.name)
    return { name: a.name, finish: computeFinishTime(op, a, dateStr, defaultStartTime, breaks) }
  }).filter(x => x.finish).sort((a, b) => a.finish - b.finish)

  const byName = new Map(work.map(w => [w.name, w]))
  const remaining = new Set(work.map(w => w.name))

  const prioritizeOps = () => {
    return [...remaining].map(name => {
      const op = opsByName.get(name)
      const start = buildDateTime(dateStr, (op?.startTime || '') || defaultStartTime)
      const target = buildDateTime(dateStr, op?.targetTime || '')
      return { name, hoursAvailable: getHoursAvailable(start, target) || Infinity }
    }).sort((a, b) => {
      if (a.hoursAvailable !== b.hoursAvailable) return a.hoursAvailable - b.hoursAvailable
      return (byName.get(b.name)?.requiredWeightPerHour || 0) - (byName.get(a.name)?.requiredWeightPerHour || 0)
    }).map(x => x.name)
  }

  for (const done of finishList) {
    const finished = byName.get(done.name)
    if (!finished) continue
    remaining.delete(done.name)
    const sourceOp = opsByName.get(done.name)
    const allowedTargets = getAllowedTargets(sourceOp?.key || '')
    if (!allowedTargets.size) continue
    const sourceTarget = buildDateTime(dateStr, sourceOp?.targetTime || '')
    if (sourceTarget && done.finish && done.finish > sourceTarget) continue
    const transferable = [...buildTransferBuckets(finished, normSzPerHour, weakMovePercent).move]
    for (const opName of prioritizeOps()) {
      const targetOp = opsByName.get(opName)
      if (!targetOp || !allowedTargets.has(targetOp.key)) continue
      const targetAssign = byName.get(opName)
      if (!targetAssign) continue
      while (transferable.length && targetAssign.sumPeople < targetAssign.requiredPeople) {
        targetAssign.picked.push({ ...transferable.shift() })
        targetAssign.sumPeople++
      }
    }
  }
  return work
}

function buildTransferPlan(assignments, ops, dateStr, defaultStartTime, normSzPerHour, weakMovePercent, breaks) {
  const opsByName = new Map(ops.map(o => [o.name, o]))
  return assignments.map(a => {
    const op = opsByName.get(a.name)
    const people = a.picked || []
    const buckets = buildTransferBuckets(a, normSzPerHour, weakMovePercent)
    let finishTime = ''
    if (op && op.volume > 0 && people.length > 0 && op.avgRate > 0) {
      const start = buildDateTime(dateStr, (op.startTime || '') || defaultStartTime)
      if (start) {
        const finish = computeFinishWithBreaks(start, op.volume / (op.avgRate * people.length), breaks)
        if (finish) finishTime = formatTime(finish)
      }
    }
    return { name: a.name, finishTime, passedCount: buckets.passed.length, totalCount: people.length, stay: buckets.stay, move: buckets.move }
  })
}

function getCompanyByFio(emplMap, normalizedFio) {
  return emplMap?.get(normalizedFio) || ''
}

function normalizeFio(fio) {
  return String(fio || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function simulatePlan(assignments, ops, dateStr, defaultStartTime, normSzPerHour, weakMovePercent, breaks, lunchRules, emplMap) {
  const opsByName = new Map(ops.map(o => [o.name, o]))
  const state = new Map()
  const peopleByOp = new Map()
  const finishTimes = new Map()
  const empPersonalTarget = new Map()

  for (const a of assignments) {
    const op = opsByName.get(a.name)
    const volume = Number(op?.volume) || 0
    const numPeople = (a.picked || []).length
    const perPerson = numPeople > 0 && volume > 0 ? volume / numPeople : Infinity
    state.set(a.name, {
      remaining: volume,
      start: buildDateTime(dateStr, (op?.startTime || '') || defaultStartTime),
      target: buildDateTime(dateStr, op?.targetTime || ''),
      rate: Number(op?.avgRate) || 0,
      key: op?.key || '',
    })
    peopleByOp.set(a.name, [...(a.picked || [])])
    for (const emp of (a.picked || [])) {
      empPersonalTarget.set(emp.name, { target: perPerson, accumulated: 0, sourceOpName: a.name })
    }
  }

  const startTimes = [...state.values()].map(s => s.start).filter(Boolean)
  const simStart = startTimes.length ? new Date(Math.min(...startTimes.map(d => d.getTime()))) : buildDateTime(dateStr, defaultStartTime) || new Date()
  const simEnd = new Date(simStart.getTime() + 24 * 60 * 60 * 1000)
  const timeline = []

  const getAllowed = (sourceKey) => getAllowedTargets(sourceKey)

  const prioritizeOps = (remainingNames) => {
    return [...remainingNames].map(name => {
      const st = state.get(name)
      return { name, hoursAvailable: getHoursAvailable(st?.start, st?.target) || Infinity, isStorage: String(st?.key || '').startsWith('storage') }
    }).sort((a, b) => {
      if (a.isStorage !== b.isStorage) return a.isStorage ? -1 : 1
      if (a.hoursAvailable !== b.hoursAvailable) return a.hoursAvailable - b.hoursAvailable
      return (assignments.find(x => x.name === b.name)?.requiredWeightPerHour || 0) - (assignments.find(x => x.name === a.name)?.requiredWeightPerHour || 0)
    }).map(x => x.name)
  }

  let t = new Date(simStart)
  while (t <= simEnd) {
    const counts = {}
    for (const [name, list] of peopleByOp) counts[name] = (list || []).length
    timeline.push({ time: new Date(t), counts })

    const hourEnd = new Date(t.getTime() + 60 * 60 * 1000)
    const breakFactor = Math.max(0, 1 - getBreakMinutesBetween(t, hourEnd, breaks) / 60)
    for (const [name, st] of state) {
      if (st.remaining <= 0 || !st.start || t < st.start) continue
      const people = peopleByOp.get(name) || []
      let sum = 0
      for (const p of people) {
        const company = getCompanyByFio(emplMap, normalizeFio(p.name || ''))
        const rule = company ? lunchRules.get(company) : null
        let factor = 1
        if (rule) {
          const lunchStart = buildDateTime(dateStr, rule.start)
          const lunchEnd = lunchStart ? new Date(lunchStart.getTime() + rule.duration * 60 * 1000) : null
          if (lunchStart && lunchEnd && t >= lunchStart && t < lunchEnd) factor = 1 - (rule.percent / 100)
        }
        const contrib = st.rate * factor * breakFactor
        sum += contrib
        const ep = empPersonalTarget.get(p.name)
        if (ep && ep.sourceOpName === name) ep.accumulated += contrib
      }
      st.remaining = Math.max(0, st.remaining - sum)
      if (st.remaining <= 0 && !finishTimes.has(name)) finishTimes.set(name, new Date(t.getTime() + 60 * 60 * 1000))
    }

    for (const [name, st] of state) {
      if (!st.start || t < st.start) continue
      const allowedTargets = getAllowed(st.key)
      if (!allowedTargets.size) continue
      const people = peopleByOp.get(name) || []
      const toKeep = [], toTransfer = []
      for (const emp of people) {
        const ep = empPersonalTarget.get(emp.name)
        if (ep && ep.target < Infinity && ep.accumulated >= ep.target) toTransfer.push(emp)
        else toKeep.push(emp)
      }
      if (!toTransfer.length) continue
      peopleByOp.set(name, toKeep)
      const kdkNames = [...state.keys()].filter(n => n !== name && (state.get(n)?.remaining || 0) > 0 && allowedTargets.has(state.get(n)?.key || ''))
      let pool = [...toTransfer]
      for (const opName of prioritizeOps(kdkNames)) {
        if (!pool.length) break
        const targetList = peopleByOp.get(opName)
        if (!targetList) continue
        while (pool.length) {
          const emp = pool.shift()
          targetList.push({ ...emp })
          const ep = empPersonalTarget.get(emp.name)
          if (ep) { ep.accumulated = 0; ep.target = Infinity; ep.sourceOpName = opName }
        }
      }
    }

    for (const [name, st] of state) {
      if (st.remaining > 0) continue
      if (!finishTimes.has(name)) continue
      const finishedAt = finishTimes.get(name)
      if (finishedAt && finishedAt.getTime() !== t.getTime() + 60 * 60 * 1000) continue
      if (st.target && finishedAt && finishedAt > st.target) continue
      const currentPeople = peopleByOp.get(name) || []
      if (!currentPeople.length) continue
      const allowedTargets = getAllowed(st.key)
      if (!allowedTargets.size) continue
      const pool = [...buildTransferBuckets({ picked: currentPeople }, normSzPerHour, weakMovePercent).move]
      const remainingNames = [...state.keys()].filter(n => n !== name && (state.get(n)?.remaining || 0) > 0)
      for (const opName of prioritizeOps(remainingNames)) {
        const targetState = state.get(opName)
        if (!targetState || !allowedTargets.has(targetState.key) || !pool.length) continue
        while (pool.length) peopleByOp.get(opName)?.push({ ...pool.shift() })
      }
    }

    t = new Date(t.getTime() + 60 * 60 * 1000)
    if (![...state.values()].some(s => s.remaining > 0)) break
  }

  const results = new Map()
  for (const [name, st] of state) {
    const finish = finishTimes.get(name) || null
    results.set(name, { finish, okByTarget: st.target ? (finish && finish <= st.target) : (st.remaining <= 0) })
  }
  return { results, timeline }
}

const BREAK_TEMPLATES_KEY = 'analysis_break_templates'

function loadBreakTemplates() {
  try { return JSON.parse(localStorage.getItem(BREAK_TEMPLATES_KEY) || '[]') || [] } catch { return [] }
}
function saveBreakTemplates(list) {
  try { localStorage.setItem(BREAK_TEMPLATES_KEY, JSON.stringify(list || [])) } catch { /* ignore */ }
}
function getPlanKey(dateStr) { return `analysis_plan_${dateStr}` }
function loadPlanFromStorage(dateStr) {
  try { return JSON.parse(localStorage.getItem(getPlanKey(dateStr)) || 'null') } catch { return null }
}
function savePlanToStorage(dateStr, startTime, rows, breaks) {
  try { localStorage.setItem(getPlanKey(dateStr), JSON.stringify({ startTime, rows, breaks })) } catch { /* ignore */ }
}

// ─── Row data defaults ────────────────────────────────────────────────────────

const OPS_DEF = [
  { key: 'storage_dry',   name: 'Сухое хранение' },
  { key: 'crossdock_dry', name: 'Кроссдокинг (сухой)' },
  { key: 'storage_cold',  name: 'Холодное хранение' },
  { key: 'crossdock_cold',name: 'Кроссдокинг (холодный)' },
]

function emptyRow() { return { volume: '', peak: '', people: '', start: '', target: '' } }

// ─── AnalysisPage ─────────────────────────────────────────────────────────────

export default function AnalysisPage() {
  const { emplMap, emplCompanies } = useAppContext()

  const today = nowDateStr()
  const [dateStr, setDateStr] = useState(today)
  const [startTime, setStartTime] = useState('09:00')
  const [rows, setRows] = useState(() => OPS_DEF.map(emptyRow))
  const [breaks, setBreaks] = useState([])
  const [breakTemplates, setBreakTemplates] = useState(() => loadBreakTemplates())
  const [breakTemplateName, setBreakTemplateName] = useState('')
  const [selectedTemplateIdx, setSelectedTemplateIdx] = useState('')
  const [historyFrom, setHistoryFrom] = useState(today)
  const [historyTo, setHistoryTo] = useState(today)
  const [historyShift, setHistoryShift] = useState('day')
  const [historyIdle, setHistoryIdle] = useState('15')
  const [normSz, setNormSz] = useState('0')
  const [weakMove, setWeakMove] = useState('0')
  const [selectedCompanies, setSelectedCompanies] = useState(new Set())
  const [lunchSettings, setLunchSettings] = useState({}) // company -> { start, duration, percent, enabled }
  const [pickStatus, setPickStatus] = useState('')
  const [assignments, setAssignments] = useState(null)
  const [transferPlan, setTransferPlan] = useState(null)
  const [scheduleTimeline, setScheduleTimeline] = useState(null)
  const historyTouched = useRef(false)

  // ── Load saved plan on date change ──
  useEffect(() => {
    const saved = loadPlanFromStorage(dateStr)
    if (saved) {
      if (saved.startTime) setStartTime(saved.startTime)
      if (Array.isArray(saved.rows)) {
        setRows(saved.rows.map(r => ({
          volume: r.volume || '', peak: r.peak || '', people: r.people || '',
          start: r.start || '', target: r.target || '',
        })))
      }
      if (Array.isArray(saved.breaks)) setBreaks(saved.breaks)
    }
  }, [dateStr])

  // ── Auto-save plan ──
  useEffect(() => {
    savePlanToStorage(dateStr, startTime, rows, breaks)
  }, [dateStr, startTime, rows, breaks])

  // ── Computed columns per row ──
  const computed = rows.map(r => computeRow(r, dateStr, startTime, breaks))

  // ── Row input handler ──
  function setRowField(idx, field, value) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r))
  }

  // ── Breaks ──
  function addBreak() {
    setBreaks(prev => [...prev, { start: '', duration: 10 }])
  }
  function removeBreak(idx) {
    setBreaks(prev => prev.filter((_, i) => i !== idx))
  }
  function setBreakField(idx, field, value) {
    setBreaks(prev => prev.map((b, i) => i === idx ? { ...b, [field]: value } : b))
  }
  function saveTemplate() {
    const name = breakTemplateName.trim()
    if (!name) return
    const list = breakTemplates.filter(t => t.name !== name)
    list.push({ name, breaks })
    saveBreakTemplates(list)
    setBreakTemplates(list)
    setBreakTemplateName('')
  }
  function applyTemplate() {
    const idx = Number(selectedTemplateIdx)
    const tpl = breakTemplates[idx]
    if (tpl && Array.isArray(tpl.breaks)) setBreaks(tpl.breaks)
  }

  // ── Fill from day stats ──
  async function fillFromStats() {
    try {
      const summary = await api.getDateSummary(dateStr, { shift: historyShift, idleThresholdMinutes: parseNum(historyIdle) })
      if (!summary || summary.error) return
      const hourly = Array.isArray(summary.hourly) ? summary.hourly : []
      const totalStorage = hourly.reduce((s, h) => s + (Number(h.storageOps) || 0), 0)
      const totalKdk = hourly.reduce((s, h) => s + (Number(h.kdkOps) || 0), 0)
      setRows(prev => prev.map((r, i) => {
        if (OPS_DEF[i].key === 'storage_dry') return { ...r, volume: String(totalStorage) }
        if (OPS_DEF[i].key === 'crossdock_dry') return { ...r, volume: String(totalKdk) }
        return r
      }))
    } catch { /* ignore */ }
  }

  // ── Lunch settings helpers ──
  function getLunch(company) {
    return lunchSettings[company] || { start: '', duration: '60', percent: '100', enabled: false }
  }
  function setLunchField(company, field, value) {
    setLunchSettings(prev => ({ ...prev, [company]: { ...getLunch(company), [field]: value } }))
  }
  function readLunchRules() {
    const rules = new Map()
    for (const company of emplCompanies) {
      const l = getLunch(company)
      if (!l.enabled || !l.start || parseNum(l.duration) <= 0 || parseNum(l.percent) <= 0) continue
      rules.set(company, { start: l.start, duration: parseNum(l.duration), percent: parseNum(l.percent) })
    }
    return rules
  }

  // ── Get ops from rows ──
  function getOps() {
    return OPS_DEF.map((def, i) => {
      const r = rows[i]
      const volume = parseNum(r.volume)
      const avgRate = parseNum(r.peak)
      const manualPeople = parseNum(r.people)
      const start = buildDateTime(dateStr, r.start || startTime)
      const target = buildDateTime(dateStr, r.target)
      const hoursAvailableRaw = getHoursAvailable(start, target)
      const breakMinutes = hoursAvailableRaw ? getBreakMinutesBetween(start, target, breaks) : 0
      const hoursAvailable = hoursAvailableRaw ? Math.max(0, hoursAvailableRaw - breakMinutes / 60) : null
      const requiredWeightPerHour = volume > 0 && hoursAvailable && hoursAvailable > 0 ? Math.ceil(volume / hoursAvailable) : 0
      const calcPeople = volume > 0 && hoursAvailable && hoursAvailable > 0 && avgRate > 0 ? Math.ceil(volume / (avgRate * hoursAvailable)) : 0
      return {
        name: def.name, key: def.key, volume, avgRate,
        manualPeople, targetTime: r.target, startTime: r.start,
        requiredWeightPerHour, requiredPeople: calcPeople > 0 ? calcPeople : manualPeople,
      }
    })
  }

  // ── Pick staff ──
  async function handlePickStaff() {
    const from = historyFrom || dateStr
    const to = historyTo || dateStr
    const res = await api.getAnalysisEmployeeRates({ dateFrom: from, dateTo: to, shift: historyShift, idleThresholdMinutes: parseNum(historyIdle) })
    if (!res || res.error) { setPickStatus(`Ошибка API: ${res?.error || 'нет ответа'}`); setAssignments([]); return }
    let employees = Array.isArray(res.employees) ? res.employees : []
    if (!employees.length) { setPickStatus(`Нет данных за период ${from} — ${to}`); setAssignments([]); setTransferPlan([]); return }
    if (selectedCompanies.size && emplMap?.size) {
      const allowed = new Set([...selectedCompanies].map(c => c.trim().toLowerCase()))
      employees = employees.filter(emp => {
        const company = getCompanyByFio(emplMap, normalizeFio(emp.name || ''))
        return company && allowed.has(company.trim().toLowerCase())
      })
    }
    if (!employees.length) { setPickStatus('Нет сотрудников после фильтра по компании'); setAssignments([]); setTransferPlan([]); return }

    // auto-fill people/peak if empty
    const ZONE_TO_OP = { SH: 'storage_dry', HH: 'storage_cold', KDS: 'crossdock_dry', KDH: 'crossdock_cold' }
    const empCountByOp = {}, ratesByOp = {}
    for (const emp of employees) {
      let domZone = null, domKg = 0
      if (emp.kgPerHourByZone) {
        for (const [zk, kg] of Object.entries(emp.kgPerHourByZone)) {
          if (Number(kg) > domKg) { domKg = Number(kg); domZone = zk }
        }
      }
      const opKey = domZone ? (ZONE_TO_OP[domZone] || null) : null
      if (!opKey) continue
      empCountByOp[opKey] = (empCountByOp[opKey] || 0) + 1
      if (!ratesByOp[opKey]) ratesByOp[opKey] = []
      const zoneKg = Number(emp.kgPerHourByZone?.[domZone]) || Number(emp.kgPerHour) || 0
      if (zoneKg > 0) ratesByOp[opKey].push(zoneKg)
    }

    const updatedRows = rows.map((r, i) => {
      const key = OPS_DEF[i].key
      const volume = parseNum(r.volume)
      const rowStart = buildDateTime(dateStr, r.start || startTime)
      const rowTarget = buildDateTime(dateStr, r.target)
      const hoursAvailableRaw = getHoursAvailable(rowStart, rowTarget)
      const brkMin = hoursAvailableRaw ? getBreakMinutesBetween(rowStart, rowTarget, breaks) : 0
      const hoursAvailable = hoursAvailableRaw ? Math.max(0, hoursAvailableRaw - brkMin / 60) : null
      let people = r.people
      if (parseNum(r.people) === 0 && (empCountByOp[key] || 0) > 0) people = String(empCountByOp[key])
      let peak = r.peak
      const pNum = parseNum(people)
      if (parseNum(r.peak) === 0 && volume > 0 && pNum > 0 && hoursAvailable && hoursAvailable > 0) {
        peak = (volume / (pNum * hoursAvailable)).toFixed(1)
      }
      return { ...r, people, peak }
    })
    setRows(updatedRows)

    const ops = OPS_DEF.map((def, i) => {
      const r = updatedRows[i]
      const volume = parseNum(r.volume), avgRate = parseNum(r.peak), manualPeople = parseNum(r.people)
      const start = buildDateTime(dateStr, r.start || startTime), target = buildDateTime(dateStr, r.target)
      const hoursAvailableRaw = getHoursAvailable(start, target)
      const brkMin = hoursAvailableRaw ? getBreakMinutesBetween(start, target, breaks) : 0
      const hoursAvailable = hoursAvailableRaw ? Math.max(0, hoursAvailableRaw - brkMin / 60) : null
      const requiredWeightPerHour = volume > 0 && hoursAvailable && hoursAvailable > 0 ? Math.ceil(volume / hoursAvailable) : 0
      const calcPeople = volume > 0 && hoursAvailable && hoursAvailable > 0 && avgRate > 0 ? Math.ceil(volume / (avgRate * hoursAvailable)) : 0
      return { name: def.name, key: def.key, volume, avgRate, manualPeople, targetTime: r.target, startTime: r.start, requiredWeightPerHour, requiredPeople: calcPeople > 0 ? calcPeople : manualPeople }
    })

    const opsWithPeople = ops.filter(o => o.requiredPeople > 0)
    if (!opsWithPeople.length) { setPickStatus('Не заданы операции: укажите объём и кол-во человек'); setAssignments([]); setTransferPlan([]); return }

    setPickStatus(`Подобрано из ${employees.length} сотрудников`)
    const picked = pickStaffForOperations(ops, employees, dateStr, startTime)
    const normSzNum = Math.max(0, parseNum(normSz))
    const weakMoveNum = Math.max(0, parseNum(weakMove))
    const lunchRules = readLunchRules()
    const redistributed = autoRedistribute(picked, ops, dateStr, startTime, normSzNum, weakMoveNum, breaks)
    const sim = simulatePlan(redistributed, ops, dateStr, startTime, normSzNum, weakMoveNum, breaks, lunchRules, emplMap || new Map())
    const withStatus = redistributed.map(a => {
      const st = sim.results.get(a.name)
      return { ...a, ok: st ? !!st.okByTarget : a.ok }
    })
    setAssignments(withStatus)
    setTransferPlan(buildTransferPlan(picked, ops, dateStr, startTime, normSzNum, weakMoveNum, breaks))
    setScheduleTimeline({ timeline: sim.timeline, ops })
  }

  // ── Render ──
  const companies = emplCompanies || []

  return (
    <div className="main-content">
      <div className="card">
        <div className="card-header">
          <span>Анализ нагрузки</span>
          <span className="card-header-sub">Прогноз по вес/час и подбор персонала</span>
        </div>

        {/* Toolbar */}
        <div className={s.toolbar}>
          <div className={s.field}>
            <label>Дата</label>
            <input type="date" className="select-control" value={dateStr}
              onChange={e => {
                setDateStr(e.target.value)
                if (!historyTouched.current) {
                  setHistoryFrom(e.target.value)
                  setHistoryTo(e.target.value)
                }
              }} />
          </div>
          <div className={s.field}>
            <label>Старт</label>
            <input type="time" className="select-control" value={startTime} onChange={e => setStartTime(e.target.value)} />
          </div>
          <div className={s.hint}>Цели по времени задаются по каждой операции ниже.</div>
          <button className="btn btn-secondary" type="button" onClick={fillFromStats}>Заполнить по статистике дня</button>
        </div>

        {/* Breaks */}
        <div className={s.breaks}>
          <div className={s.breaksTitle}>Перекуры (простой)</div>
          <div className={s.breaksControls}>
            {breaks.map((br, idx) => (
              <div key={idx} className={s.breakRow}>
                <input type="time" className="form-control" value={br.start} onChange={e => setBreakField(idx, 'start', e.target.value)} />
                <input type="number" className="form-control" min="0" step="5" value={br.duration} onChange={e => setBreakField(idx, 'duration', e.target.value)} style={{ width: 70 }} />
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => removeBreak(idx)}>Удалить</button>
              </div>
            ))}
            <button className="btn btn-secondary btn-sm" type="button" onClick={addBreak}>+ Добавить перекур</button>
          </div>
          <div className={s.breaksTemplates}>
            <div className={s.field}>
              <label>Шаблон перекуров</label>
              <select className="select-control" value={selectedTemplateIdx} onChange={e => setSelectedTemplateIdx(e.target.value)}>
                {breakTemplates.length === 0 && <option value="">Нет шаблонов</option>}
                {breakTemplates.map((t, i) => <option key={i} value={i}>{t.name || `Шаблон ${i + 1}`}</option>)}
              </select>
            </div>
            <div className={s.field}>
              <label>Название шаблона</label>
              <input type="text" className="select-control" placeholder="Например: Стандарт" value={breakTemplateName} onChange={e => setBreakTemplateName(e.target.value)} />
            </div>
            <button className="btn btn-secondary btn-sm" type="button" onClick={saveTemplate}>Сохранить шаблон</button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={applyTemplate}>Применить шаблон</button>
          </div>
          <div className={s.hint}>Перекуры учитываются в расчёте времени завершения и потребности по людям.</div>
        </div>

        {/* Ops table */}
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Операция</th>
                <th>Объём, кг</th>
                <th>Средний вес/час</th>
                <th>Людей в работе</th>
                <th>Старт</th>
                <th>Цель (к скольки)</th>
                <th>Нужно кг/час</th>
                <th>Нужно часов</th>
                <th>Завершим к</th>
                <th>Нужно людей к цели</th>
              </tr>
            </thead>
            <tbody>
              {OPS_DEF.map((def, i) => {
                const r = rows[i]
                const c = computed[i]
                return (
                  <tr key={def.key}>
                    <td>{def.name}</td>
                    <td><input type="number" className="form-control" min="0" step="1" placeholder="0" value={r.volume} onChange={e => setRowField(i, 'volume', e.target.value)} /></td>
                    <td><input type="number" className="form-control" min="0" step="0.1" placeholder="0" value={r.peak} onChange={e => setRowField(i, 'peak', e.target.value)} /></td>
                    <td><input type="number" className="form-control" min="0" step="1" placeholder="0" value={r.people} onChange={e => setRowField(i, 'people', e.target.value)} /></td>
                    <td><input type="time" className="form-control" value={r.start} onChange={e => setRowField(i, 'start', e.target.value)} /></td>
                    <td><input type="time" className="form-control" value={r.target} onChange={e => setRowField(i, 'target', e.target.value)} /></td>
                    <td className={s.computed}>{c.required}</td>
                    <td className={s.computed}>{c.duration}</td>
                    <td className={s.computed}>{c.finishStr}</td>
                    <td className={s.computed}>{c.needPeople}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Staff pick section */}
        <div className={s.history}>
          <div className={s.historyTitle}>Подбор персонала по прошлым сменам</div>
          <div className={s.historyControls}>
            <div className={s.field}>
              <label>История с</label>
              <input type="date" className="select-control" value={historyFrom} onChange={e => { historyTouched.current = true; setHistoryFrom(e.target.value) }} />
            </div>
            <div className={s.field}>
              <label>по</label>
              <input type="date" className="select-control" value={historyTo} onChange={e => { historyTouched.current = true; setHistoryTo(e.target.value) }} />
            </div>
            <div className={s.field}>
              <label>Смена</label>
              <select className="select-control" value={historyShift} onChange={e => setHistoryShift(e.target.value)}>
                <option value="day">День</option>
                <option value="night">Ночь</option>
              </select>
            </div>
            <div className={s.field}>
              <label>Порог простоя, мин</label>
              <input type="number" className="select-control" min="0" value={historyIdle} onChange={e => setHistoryIdle(e.target.value)} />
            </div>
            <div className={s.field}>
              <label>Норма, кг/час</label>
              <input type="number" className="select-control" min="0" step="1" value={normSz} onChange={e => setNormSz(e.target.value)} />
            </div>
            <div className={s.field}>
              <label>Слабые на перевод, %</label>
              <input type="number" className="select-control" min="0" max="100" step="5" value={weakMove} onChange={e => setWeakMove(e.target.value)} />
            </div>
            {companies.length > 0 && (
              <div className={`${s.field} ${s.fieldWide}`}>
                <label>Компании (подбор)</label>
                <div className={s.companiesList}>
                  {companies.map(c => (
                    <label key={c} className={s.companyItem}>
                      <input type="checkbox" checked={selectedCompanies.has(c)}
                        onChange={e => setSelectedCompanies(prev => {
                          const next = new Set(prev)
                          e.target.checked ? next.add(c) : next.delete(c)
                          return next
                        })} />
                      {c}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <button className="btn btn-primary" type="button" onClick={handlePickStaff}>Подобрать персонал</button>
            {pickStatus && <span className={s.pickStatus}>{pickStatus}</span>}
          </div>

          {/* Lunch settings */}
          {companies.length > 0 && (
            <div className={s.assignWrap}>
              <div className={s.historyTitle}>Обеды по компаниям</div>
              <div className={s.lunchGrid}>
                <div className={s.lunchHead}>Компания</div>
                <div className={s.lunchHead}>Старт</div>
                <div className={s.lunchHead}>Длительность, мин</div>
                <div className={s.lunchHead}>Доля, %</div>
                <div className={s.lunchHead}>Вкл</div>
                {companies.map(c => {
                  const l = getLunch(c)
                  return (
                    <>
                      <div key={c + '_name'}>{c}</div>
                      <input key={c + '_start'} type="time" className="form-control" value={l.start} onChange={e => setLunchField(c, 'start', e.target.value)} />
                      <input key={c + '_dur'} type="number" className="form-control" min="0" step="5" value={l.duration} onChange={e => setLunchField(c, 'duration', e.target.value)} />
                      <input key={c + '_pct'} type="number" className="form-control" min="0" max="100" step="10" value={l.percent} onChange={e => setLunchField(c, 'percent', e.target.value)} />
                      <label key={c + '_en'} className={s.companyItem}>
                        <input type="checkbox" checked={!!l.enabled} onChange={e => setLunchField(c, 'enabled', e.target.checked)} />
                        включить
                      </label>
                    </>
                  )
                })}
              </div>
            </div>
          )}

          {/* Assignments table */}
          <div className={s.assignWrap}>
            <table className={s.assignTable}>
              <thead>
                <tr>
                  <th>Операция</th><th>Нужно людей</th><th>Подбор персонала</th><th>Подобрано, чел</th><th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {!assignments || assignments.length === 0 ? (
                  <tr><td colSpan="5" className={s.empty}>{assignments === null ? 'Нажмите «Подобрать персонал»' : 'Нет данных для подбора'}</td></tr>
                ) : assignments.map((a, i) => {
                  const requiredKgPerPerson = a.requiredWeightPerHour > 0 && a.sumPeople > 0 ? a.requiredWeightPerHour / a.sumPeople : 0
                  return (
                    <tr key={i}>
                      <td>{a.name}</td>
                      <td>{a.requiredPeople}</td>
                      <td>
                        {(a.picked || []).map((p, pi) => {
                          const aff = Number(p._affinity || 0)
                          const affStr = aff > 0 ? ` · з${Math.round(aff * 100)}%` : ''
                          const empKg = Number(p.kgPerHour || 0)
                          const behind = !a.ok && requiredKgPerPerson > 0 && empKg > 0 && empKg < requiredKgPerPerson
                          return (
                            <span key={pi}>
                              <span className={s.chip}>{p.name} · {empKg > 0 ? `${empKg.toFixed(1)} кг/ч` : Number(p.szPerHour || 0).toFixed(1)}{affStr}</span>
                              {behind && <span className={s.chipWarn}>нужно {requiredKgPerPerson.toFixed(1)}</span>}
                            </span>
                          )
                        })}
                        {!a.picked?.length && '—'}
                      </td>
                      <td>{a.sumPeople}</td>
                      <td>
                        {a.ok ? (
                          <span className={s.statusOk}>Хватает</span>
                        ) : (
                          <>
                            <span className={s.statusWarn}>Не хватает</span>
                            {(() => {
                              const behind = (a.picked || []).filter(p => {
                                const empKg = Number(p.kgPerHour || 0)
                                return requiredKgPerPerson > 0 && empKg > 0 && empKg < requiredKgPerPerson
                              })
                              return behind.length ? (
                                <div className={s.statusDetail}>Ускорить: {behind.map(p => `${p.name.split(' ')[0]} (нужно ${requiredKgPerPerson.toFixed(1)} кг/ч)`).join(', ')}</div>
                              ) : null
                            })()}
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Transfer plan table */}
          <div className={s.assignWrap} style={{ marginTop: 12 }}>
            <table className={s.assignTable}>
              <thead>
                <tr>
                  <th>Операция</th><th>Завершим к</th><th>Прошли норму</th><th>Останутся добивать</th><th>Переводятся</th>
                </tr>
              </thead>
              <tbody>
                {!transferPlan || transferPlan.length === 0 ? (
                  <tr><td colSpan="5" className={s.empty}>{transferPlan === null ? 'Нажмите «Подобрать персонал»' : 'Нет данных для подбора'}</td></tr>
                ) : transferPlan.map((p, i) => (
                  <tr key={i}>
                    <td>{p.name}</td>
                    <td>{p.finishTime || '—'}</td>
                    <td>{p.passedCount}/{p.totalCount}</td>
                    <td>{p.stay.map((x, xi) => <div key={xi} className={`${s.chip} ${s.chipMuted}`}>{x.name}</div>)}{!p.stay.length && '—'}</td>
                    <td>{p.move.map((x, xi) => <div key={xi} className={s.chip}>{x.name}</div>)}{!p.move.length && '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Schedule chart */}
          <div className={s.assignWrap} style={{ marginTop: 12 }}>
            <div className={s.historyTitle}>График распределения по часам</div>
            {!scheduleTimeline ? (
              <div className={s.empty}>Нажмите «Подобрать персонал»</div>
            ) : (
              <div className={s.scheduleChart}>
                {scheduleTimeline.ops.map(op => {
                  const maxCount = scheduleTimeline.timeline.reduce((m, t) => Math.max(m, Number(t.counts?.[op.name] || 0), 1), 1)
                  return (
                    <div key={op.key} className={s.scheduleRow}>
                      <div className={s.scheduleOp}>{op.name}</div>
                      <div className={s.scheduleBars}>
                        {scheduleTimeline.timeline.map((t, ti) => {
                          const v = Number(t.counts?.[op.name] || 0)
                          const pct = Math.round((v / maxCount) * 100)
                          const h = String(t.time.getHours()).padStart(2, '0')
                          return (
                            <div key={ti} className={s.hour}>
                              <div className={s.hourLabel}>{h}:00</div>
                              <div className={s.hourBar}>
                                <div className={s.hourFill} style={{ height: `${pct}%` }} />
                                <div className={s.hourValue}>{v}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
