import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import * as api from '../api/index.js'
import { normalizeFio, parseEmplCsv, flattenItem, personKey } from '../utils/emplUtils.js'
import { getTodayStr } from '../utils/format.js'
import { setProductWeights } from '../utils/statsCalc.js'
import { useNotify } from './NotifyContext.jsx'
import { useAuth } from './AuthContext.jsx'

let _autoFetchEnabled = false
try { _autoFetchEnabled = localStorage.getItem('vs_auto_fetch_enabled') === '1' } catch { /* ignore */ }

function lsGetNum(key, def) {
  try { const v = localStorage.getItem(key); return v !== null && v !== '' ? Number(v) : def } catch { return def }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, String(val)) } catch { /* ignore */ }
}

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const notify = useNotify()
  const { getToken, isTokenValid, forceRefresh } = useAuth()
  const [selectedDate, setSelectedDate] = useState(getTodayStr)
  const [shiftFilter, setShiftFilter] = useState('day')
  const [filterCompany, setFilterCompany] = useState('__all__')
  const [allItems, setAllItems] = useState([])
  const [dateSummary, setDateSummary] = useState(null)
  const [emplMap, setEmplMap] = useState(new Map())
  const [emplNameMap, setEmplNameMap] = useState(new Map()) // personKey → full original fio from empl.csv
  const [emplCompanies, setEmplCompanies] = useState([])
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(false)
  const [heTableMode, setHeTableMode] = useState('sz')
  const [idleThresholdMinutes, setIdleThresholdMinutesRaw] = useState(() => lsGetNum('vs_idle_threshold', 15))
  const [allowedIdleMinutes, setAllowedIdleMinutesRaw] = useState(() => lsGetNum('vs_allowed_idle', 0))

  const setIdleThresholdMinutes = useCallback(v => {
    setIdleThresholdMinutesRaw(v)
    if (v !== '' && !Number.isNaN(Number(v))) lsSet('vs_idle_threshold', v)
  }, [])
  const setAllowedIdleMinutes = useCallback(v => {
    setAllowedIdleMinutesRaw(v)
    if (v !== '' && !Number.isNaN(Number(v))) lsSet('vs_allowed_idle', v)
  }, [])
  const [fetchHourFrom, setFetchHourFrom] = useState(9)
  const [fetchHourTo, setFetchHourTo] = useState(21)
  const [engineNote, setEngineNote] = useState('')
  const [newEmployeesFromFetch, setNewEmployeesFromFetch] = useState([])
  const autoFetchEnabled = _autoFetchEnabled

  // refs so callbacks don't stale-close over state
  const selectedDateRef    = useRef(selectedDate)
  const shiftFilterRef     = useRef(shiftFilter)
  const fetchHourFromRef   = useRef(fetchHourFrom)
  const fetchHourToRef     = useRef(fetchHourTo)
  const lastKnownRunRef    = useRef(null)
  const autoFetchBusyRef   = useRef(false)
  useEffect(() => { selectedDateRef.current = selectedDate }, [selectedDate])
  useEffect(() => { shiftFilterRef.current  = shiftFilter  }, [shiftFilter])
  useEffect(() => { fetchHourFromRef.current = fetchHourFrom }, [fetchHourFrom])
  useEffect(() => { fetchHourToRef.current   = fetchHourTo   }, [fetchHourTo])

  const loadEmployees = useCallback(async () => {
    try {
      const data = await api.getEmployees()
      // Backend returns { employees: [{fio, company}], companies: [...] }
      if (data?.employees) {
        const map = new Map()
        const nameMap = new Map()
        const companySet = new Set()
        for (const { fio, company } of data.employees) {
          if (fio) {
            const norm = normalizeFio(fio)
            map.set(norm, company || '')
            const pk = personKey(norm)
            const existing = nameMap.get(pk)
            if (!existing || fio.split(/\s+/).length > existing.split(/\s+/).length) {
              nameMap.set(pk, fio)
            }
            if (company) companySet.add(company)
          }
        }
        setEmplMap(map)
        setEmplNameMap(nameMap)
        setEmplCompanies([...companySet].sort())
      } else {
        // fallback: CSV string
        const csv = typeof data === 'string' ? data : data.csv || data.data || ''
        const { map, companies } = parseEmplCsv(csv)
        setEmplMap(map)
        setEmplCompanies(companies)
      }
    } catch { /* ignore */ }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getStatus()
      setStatus(s)
      // Если lastRun изменился и смотрим сегодня — тихо обновляем сводку (как в оригинале)
      if (s?.lastRun && s.lastRun !== lastKnownRunRef.current) {
        lastKnownRunRef.current = s.lastRun
        if (selectedDateRef.current === getTodayStr()) {
          loadDateSummaryRef.current?.(selectedDateRef.current, shiftFilterRef.current)
        }
      }
    } catch { /* ignore */ }
  }, [])

  const loadDateSummaryRef = useRef(null)
  const loadDateSummary = useCallback(async (dateStr, shift) => {
    if (!dateStr) return
    setLoading(true)
    try {
      const res = await api.getDateSummary(dateStr, { shift, idleThresholdMinutes })
      setDateSummary(res)
      setAllItems([])
    } catch (err) {
      notify('Ошибка загрузки сводки: ' + err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [idleThresholdMinutes, notify])
  useEffect(() => { loadDateSummaryRef.current = loadDateSummary }, [loadDateSummary])

  const loadDateData = useCallback(async (dateStr, shift) => {
    if (!dateStr) return
    setLoading(true)
    try {
      const res = await api.getDateItems(dateStr, { shift })
      const raw = res.items || []
      const items = raw.map(i => (i.executor !== undefined && i.completedAt !== undefined ? i : flattenItem(i)))
      setAllItems(items)
      setDateSummary(null)
    } catch (err) {
      console.error('Ошибка загрузки данных:', err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const runFetchDataRef = useRef(null)
  const runFetchData = useCallback(async (forceRecheck = false, silent = false) => {
    const dateStr = selectedDateRef.current
    const shift   = shiftFilterRef.current
    const fromH   = fetchHourFromRef.current
    const toH     = fetchHourToRef.current
    if (!dateStr) return
    setLoading(true)
    setEngineNote('')
    try {
      const [y, m, d] = dateStr.split('-').map(Number)
      let fromDate, toDate
      const clampH = h => Math.max(0, Math.min(23, h))
      if (shift === 'night' && clampH(fromH) >= clampH(toH)) {
        // Ночь D: fromH на D → toH на D+1 (напр. 21:00 сегодня → 09:59 завтра)
        const next = new Date(y, m - 1, d)
        next.setDate(next.getDate() + 1)
        fromDate = new Date(y, m - 1, d, clampH(fromH), 0, 0, 0)
        toDate   = new Date(next.getFullYear(), next.getMonth(), next.getDate(), clampH(toH), 59, 59, 999)
      } else {
        fromDate = new Date(y, m - 1, d, clampH(fromH), 0, 0, 0)
        toDate   = new Date(y, m - 1, d, Math.max(clampH(fromH), clampH(toH) - 1), 59, 59, 999)
      }
      const opts = {
        operationCompletedAtFrom: fromDate.toISOString(),
        operationCompletedAtTo:   toDate.toISOString(),
      }
      // Как в оригинальном app.js: если есть WMS-токен — грузим через браузер
      let res
      let token = getToken()
      if (token) {
        if (!isTokenValid()) {
          await forceRefresh()
          token = getToken()
        }
        if (!token) throw new Error('WMS токен истёк. Войдите в систему заново.')
        try {
          res = await api.fetchDataViaBrowser(token, opts)
        } catch (err) {
          // Если 401/403 — обновляем токен и повторяем один раз
          if (/401|403|unauthorized/i.test(err.message)) {
            const refreshed = await forceRefresh()
            if (!refreshed) throw new Error('Сессия истекла. Войдите в систему заново.')
            token = getToken()
            if (!token) throw new Error('Не удалось получить токен после обновления.')
            res = await api.fetchDataViaBrowser(token, opts)
          } else {
            throw err
          }
        }
      } else {
        res = await api.fetchData(opts)
      }
      if (res.success === false) throw new Error(res.error)
      if (!silent) notify(`Получено ${res.fetched ?? '?'}, добавлено ${res.added ?? '?'}`, 'success')
      // Build engine note
      const t = res.timings || {}
      const ms = v => Number.isFinite(v) ? `${Math.round(v / 100) / 10}с` : ''
      const parts = []
      if (res.engine === 'dotnet') parts.push('.NET')
      else if (res.engine === 'node') { parts.push('Node'); if (res.dotnetError) parts.push('.NET err') }
      if (t.totalMs)    parts.push(`итого ${ms(t.totalMs)}`)
      if (t.rawWriteMs) parts.push(`raw ${ms(t.rawWriteMs)}`)
      setEngineNote(parts.join(' · '))
      if (res.newEmployees?.length > 0) setNewEmployeesFromFetch(res.newEmployees)
      await loadEmployees()
      await loadDateSummary(dateStr, shift)
      await loadStatus()
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
      throw err
    } finally {
      setLoading(false)
    }
  }, [loadDateSummary, loadStatus, loadEmployees])
  useEffect(() => { runFetchDataRef.current = runFetchData }, [runFetchData])

  // Тихий авто-фетч — как doAutoFetch() в оригинале
  const doAutoFetch = useCallback(async () => {
    if (selectedDateRef.current !== getTodayStr()) return
    if (autoFetchBusyRef.current) return
    const refreshed = await forceRefresh()
    if (!refreshed) return
    const token = getToken()
    if (!token) return
    autoFetchBusyRef.current = true
    try {
      await runFetchDataRef.current?.(false, true)
      await api.markUpdated()
      await loadStatus()
    } catch { /* ignore */ } finally {
      autoFetchBusyRef.current = false
    }
  }, [forceRefresh, getToken, loadStatus])

  // Обрабатываем очередь обновления ЕО (только на корп. устройстве с автофетчем)
  const doAutoEoRefresh = useCallback(async (queue) => {
    if (!queue || !queue.length) return
    const refreshed = await forceRefresh()
    if (!refreshed) return
    const token = getToken()
    if (!token) return
    for (const routeId of queue) {
      try {
        const wmsData = await api.fetchRouteFromWMS(token, routeId)
        await fetch(`/api/rk/routes/${encodeURIComponent(routeId)}/eos/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(wmsData),
        })
      } catch { /* ignore */ }
    }
  }, [forceRefresh, getToken])

  const doRequestFetch = useCallback(async () => {
    try {
      await api.requestFetch()
      notify('Запрос на обновление отправлен', 'info')
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }, [notify])

  const dismissNewEmployees = useCallback(() => setNewEmployeesFromFetch([]), [])

  const addNewEmployees = useCallback(async (names) => {
    try {
      const data = await api.addNewEmployees(names)
      if (!data?.ok) throw new Error(data?.error || 'Ошибка добавления')
      setNewEmployeesFromFetch([])
      await loadEmployees()
      notify(`Добавлено сотрудников: ${data.added}`, 'success')
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }, [loadEmployees, notify])

  useEffect(() => {
    api.getProductWeights().then(setProductWeights)
    loadEmployees()
    loadStatus()
  }, [])

  useEffect(() => {
    loadDateSummary(selectedDate, shiftFilter)
  }, [selectedDate, shiftFilter])

  // Перезагрузка сводки при смене порога простоя (с дебаунсом)
  useEffect(() => {
    const t = setTimeout(() => {
      loadDateSummaryRef.current?.(selectedDateRef.current, shiftFilterRef.current)
    }, 400)
    return () => clearTimeout(t)
  }, [idleThresholdMinutes])

  // Автоподстановка часов при смене shift
  useEffect(() => {
    if (shiftFilter === 'night') {
      setFetchHourFrom(21)
      setFetchHourTo(9)
    } else {
      setFetchHourFrom(9)
      setFetchHourTo(21)
    }
  }, [shiftFilter])

  // Статус каждые 10 сек + реакция на fetchRequested и eoRefreshQueue
  useEffect(() => {
    const t = setInterval(async () => {
      await loadStatus()
      setStatus(prev => {
        if (autoFetchEnabled) {
          // fetchRequested → немедленный фетч статистики
          if (prev?.fetchRequested && !autoFetchBusyRef.current) {
            doAutoFetch()
          }
          // eoRefreshQueue → обновляем ЕО по очереди
          if (prev?.eoRefreshQueue?.length) {
            doAutoEoRefresh(prev.eoRefreshQueue)
          }
        }
        return prev
      })
    }, 10_000)
    return () => clearInterval(t)
  }, [loadStatus, doAutoFetch, doAutoEoRefresh, autoFetchEnabled])

  // Авто-фетч каждые 3 минуты (если включён)
  useEffect(() => {
    if (!autoFetchEnabled) return
    const t = setInterval(() => doAutoFetch(), 3 * 60_000)
    return () => clearInterval(t)
  }, [autoFetchEnabled, doAutoFetch])

  // Авто-обновление сводки каждые 10 минут (если смотрим сегодня)
  useEffect(() => {
    const t = setInterval(() => {
      if (selectedDateRef.current === getTodayStr()) {
        loadDateSummaryRef.current?.(selectedDateRef.current, shiftFilterRef.current)
      }
    }, 10 * 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <AppContext.Provider value={{
      selectedDate, setSelectedDate,
      shiftFilter, setShiftFilter,
      filterCompany, setFilterCompany,
      allItems, setAllItems,
      dateSummary, setDateSummary,
      emplMap, emplNameMap, emplCompanies,
      status, loading,
      heTableMode, setHeTableMode,
      idleThresholdMinutes, setIdleThresholdMinutes,
      allowedIdleMinutes, setAllowedIdleMinutes,
      fetchHourFrom, setFetchHourFrom,
      fetchHourTo, setFetchHourTo,
      engineNote,
      autoFetchEnabled,
      loadDateSummary,
      loadDateData,
      runFetchData,
      doRequestFetch,
      loadEmployees,
      newEmployeesFromFetch,
      dismissNewEmployees,
      addNewEmployees,
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}
