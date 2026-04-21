import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { useApp } from '../../context/AppContext.jsx'
import {
  getCompanySummaryTableData,
  getHourlyByEmployeeGroupedByCompany,
  calcIdleTotalsByEmployee,
  getShiftBoundaryMs,
  getWeightByEmployee,
} from '../../utils/statsCalc.js'
import { normalizeFio, personKey } from '../../utils/emplUtils.js'
import CompanySummaryTable from '../stats/CompanySummaryTable.jsx'
import HourlyEmployeeTable from '../stats/HourlyEmployeeTable.jsx'
import { getViolations } from '../../api/index.js'
import s from './TvPage.module.css'

const REFRESH_SEC   = 180  // 3 минуты до обновления данных
const SCROLL_PPS    = 35   // пикселей в секунду
const PAUSE_SEC     = 5    // пауза внизу перед сменой слайда
const MIN_SLIDE_SEC = 12   // минимум если контент без скролла

const TABS = [
  { id: 'summary',    label: 'Сводка по компаниям' },
  { id: 'stats',      label: 'По СЗ' },
  { id: 'idles',      label: 'Простои' },
  { id: 'violations', label: 'Нарушения' },
]

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

export default function TvPage() {
  const {
    allItems, dateSummary, emplMap, emplNameMap,
    selectedDate, shiftFilter,
    idleThresholdMinutes, allowedIdleMinutes,
    loading, status,
  } = useApp()

  const [tabIdx, setTabIdx]           = useState(0)
  const [slideLeft, setSlideLeft]     = useState(MIN_SLIDE_SEC)
  const [refresh, setRefresh]         = useState(REFRESH_SEC)
  const [violations, setViolations]   = useState([])
  const [violationIdx, setViolationIdx] = useState(0)
  const now = useClock()

  const bodyRef        = useRef(null)
  const zoomRef        = useRef(null)
  const measureRefs    = useRef({ summary: null, stats: null, idles: null })
  const zoomMapRef     = useRef({})
  const needsRefreshRef = useRef(false)
  const scrollAnimRef  = useRef(null)
  const headClonesRef  = useRef([])
  const slideTimerRef  = useRef(null)
  const slideCountRef  = useRef(null)
  const slideTotalRef  = useRef(MIN_SLIDE_SEC)
  const refreshRef     = useRef(null)
  const violationTimerRef = useRef(null)
  const typewriterRef    = useRef(null)
  const damageRafRef     = useRef(null)

  const [typewriterText,    setTypewriterText]    = useState('')
  const [typewriterDone,    setTypewriterDone]    = useState(false)
  const [damageDisplay,     setDamageDisplay]     = useState(0)

  // ── Enrich FIO ─────────────────────────────────────────────────────────────
  const enrich = (name) => {
    const fromMap = emplNameMap.get(personKey(normalizeFio(name)))
    if (!fromMap) return name
    return fromMap.split(/\s+/).length >= name.split(/\s+/).length ? fromMap : name
  }

  const items = useMemo(() => {
    if (allItems.length) return allItems
    if (dateSummary?.items) return dateSummary.items
    return []
  }, [allItems, dateSummary])

  const isSummaryOnly = !allItems.length && !!dateSummary

  // ── Company summary ─────────────────────────────────────────────────────────
  const companySummary = useMemo(() => {
    if (isSummaryOnly && dateSummary?.companySummary) return dateSummary.companySummary
    if (!items.length) return null
    return getCompanySummaryTableData(items, shiftFilter, emplMap, selectedDate)
  }, [isSummaryOnly, dateSummary, items, shiftFilter, emplMap, selectedDate])

  // ── Hourly by employee ──────────────────────────────────────────────────────
  const heDataAll = useMemo(() => {
    if (isSummaryOnly && dateSummary?.hourlyByEmployee) {
      const { hours, rows } = dateSummary.hourlyByEmployee
      const enrichedRows = (rows || []).map(r => ({ ...r, name: enrich(r.name) }))
      const merged = new Map()
      for (const r of enrichedRows) {
        if (!merged.has(r.name)) {
          merged.set(r.name, { ...r, byHour: { ...r.byHour }, weightByHour: { ...r.weightByHour }, byHourZone: { ...r.byHourZone }, byZone: { ...r.byZone } })
          continue
        }
        const m = merged.get(r.name)
        for (const col of Object.keys(r.byHour)) m.byHour[col] = (m.byHour[col] || 0) + (r.byHour[col] || 0)
        for (const col of Object.keys(r.weightByHour)) m.weightByHour[col] = (m.weightByHour[col] || 0) + (r.weightByHour[col] || 0)
        m.total += r.total
        if (r.firstAt && (!m.firstAt || r.firstAt < m.firstAt)) m.firstAt = r.firstAt
        if (r.lastAt && r.lastAt > m.lastAt) m.lastAt = r.lastAt
      }
      return { hours: hours || [], allRows: [...merged.values()] }
    }
    if (!items.length) return null
    return getHourlyByEmployeeGroupedByCompany(items, shiftFilter, emplMap, selectedDate, enrich)
  }, [isSummaryOnly, dateSummary, items, shiftFilter, emplMap, selectedDate])

  // ── Idles ───────────────────────────────────────────────────────────────────
  const idlesByEmployee = useMemo(() => {
    let raw
    if (isSummaryOnly && dateSummary?.idlesByEmployee) {
      raw = dateSummary.idlesByEmployee
    } else if (!items.length) {
      return {}
    } else {
      const { startMs, endMs } = getShiftBoundaryMs(selectedDate, shiftFilter)
      const thresholdMs = idleThresholdMinutes * 60 * 1000
      raw = calcIdleTotalsByEmployee(items, thresholdMs, shiftFilter, startMs, endMs)
    }
    const result = {}
    for (const [name, val] of Object.entries(raw)) result[enrich(name)] = val
    return result
  }, [isSummaryOnly, dateSummary, items, selectedDate, shiftFilter, idleThresholdMinutes])

  // ── Weight ──────────────────────────────────────────────────────────────────
  const weightByEmployee = useMemo(() => {
    let raw
    if (isSummaryOnly && dateSummary?.weightByEmployee) raw = dateSummary.weightByEmployee
    else if (!items.length) return {}
    else raw = getWeightByEmployee(items)
    const result = {}
    for (const [name, val] of Object.entries(raw)) {
      const key = enrich(name)
      if (!result[key]) result[key] = { ...val }
      else { result[key].storage += val.storage; result[key].kdk += val.kdk; result[key].total += val.total }
    }
    return result
  }, [isSummaryOnly, dateSummary, items])

  // ── Загрузка нарушений ──────────────────────────────────────────────────────
  useEffect(() => {
    getViolations().then(setViolations).catch(() => {})
  }, [])

  // ── Текстовые эффекты для слайда нарушений ──────────────────────────────────
  useEffect(() => {
    clearInterval(typewriterRef.current)
    cancelAnimationFrame(damageRafRef.current)

    if (TABS[tabIdx]?.id !== 'violations') return

    const v = violations[violationIdx]
    if (!v) return

    setTypewriterText('')
    setTypewriterDone(false)
    setDamageDisplay(0)

    // Печатная машинка
    const title = v.title || ''
    let charIdx = 0
    typewriterRef.current = setInterval(() => {
      charIdx++
      setTypewriterText(title.slice(0, charIdx))
      if (charIdx >= title.length) {
        clearInterval(typewriterRef.current)
        setTypewriterDone(true)
      }
    }, 55)

    // Счётчик ущерба 0 → target за 1.5с (ease-out cubic)
    if (v.damage != null) {
      const target = Number(v.damage)
      const start  = performance.now()
      const dur    = 3000
      const step   = (ts) => {
        const p = Math.min((ts - start) / dur, 1)
        const eased = 1 - Math.pow(1 - p, 3)
        setDamageDisplay(Math.round(eased * target))
        if (p < 1) damageRafRef.current = requestAnimationFrame(step)
      }
      damageRafRef.current = requestAnimationFrame(step)
    }

    return () => {
      clearInterval(typewriterRef.current)
      cancelAnimationFrame(damageRafRef.current)
    }
  }, [tabIdx, violationIdx, violations])

  // ── Предварительный замер ширины всех слайдов ───────────────────────────────
  // Запускается когда приходят новые данные. Рендеринг происходит в скрытом слое.
  useEffect(() => {
    const t = setTimeout(() => {
      const containerWidth = bodyRef.current?.clientWidth || window.innerWidth
      TABS.forEach(({ id }) => {
        const el = measureRefs.current[id]
        if (!el) return
        const naturalWidth = el.scrollWidth
        zoomMapRef.current[id] = naturalWidth > containerWidth
          ? containerWidth / naturalWidth
          : 1
      })
      // Применить к текущему слайду если данные только что обновились
      if (zoomRef.current) {
        const currentId = TABS[tabIdx]?.id
        const scale = zoomMapRef.current[currentId] ?? 1
        zoomRef.current.style.zoom = String(scale)
      }
    }, 200)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySummary, heDataAll])

  // ── Применить zoom + плавный fade-in при смене вкладки ────────────────────
  useLayoutEffect(() => {
    const zoomEl = zoomRef.current
    if (!zoomEl) return
    // Вкладка нарушений — полноэкранное видео, zoom не нужен
    const scale = TABS[tabIdx].id === 'violations' ? 1 : (zoomMapRef.current[TABS[tabIdx].id] ?? 1)
    zoomEl.style.zoom = String(scale)
    // Плавное появление нового слайда (WAAPI opacity — GPU, не блокирует поток)
    zoomEl.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 300, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' }
    )
  }, [tabIdx])

  // ── Слайдшоу: скролл + таймер слайда ───────────────────────────────────────
  useEffect(() => {
    scrollAnimRef.current?.cancel()
    scrollAnimRef.current = null
    headClonesRef.current.forEach(({ wrapper, thead }) => {
      wrapper.parentNode?.removeChild(wrapper)
      thead.style.visibility = ''
    })
    headClonesRef.current = []
    clearTimeout(slideTimerRef.current)
    clearInterval(slideCountRef.current)
    clearTimeout(violationTimerRef.current)
    setViolationIdx(0)

    const initTimer = setTimeout(() => {
      const bodyEl = bodyRef.current
      const zoomEl = zoomRef.current
      if (!bodyEl || !zoomEl) return

      const isViolationsTab = TABS[tabIdx]?.id === 'violations'

      if (isViolationsTab) {
        const advanceViolation = () => {
          if (violationIdx < violations.length - 1) {
            setViolationIdx(i => i + 1)
          } else {
            setViolationIdx(0)
            setTabIdx(i => {
              const next = (i + 1) % TABS.length
              if (next === 0 && needsRefreshRef.current) { window.location.reload(); return i }
              return next
            })
          }
        }

        const startViolationTimer = (dur) => {
          const total = Math.max(isFinite(dur) && dur > 0 ? dur : MIN_SLIDE_SEC, MIN_SLIDE_SEC)
          slideTotalRef.current = total
          setSlideLeft(Math.ceil(total))
          clearInterval(slideCountRef.current)
          slideCountRef.current = setInterval(() => {
            setSlideLeft(s => Math.max(0, s - 1))
          }, 1000)
          clearTimeout(slideTimerRef.current)
          slideTimerRef.current = setTimeout(advanceViolation, total * 1000)
        }

        // Ждём метаданные видео — поллим каждые 100 мс, максимум 5 с
        let pollCount = 0
        const pollDuration = () => {
          const videoEl = zoomEl.querySelector('video')
          const dur = videoEl?.duration
          if (isFinite(dur) && dur > 0) {
            startViolationTimer(dur)
          } else if (pollCount++ < 50) {
            violationTimerRef.current = setTimeout(pollDuration, 100)
          } else {
            startViolationTimer(MIN_SLIDE_SEC)
          }
        }
        violationTimerRef.current = setTimeout(pollDuration, 200)
        return
      }

      const contentH   = zoomEl.getBoundingClientRect().height
      const containerH = bodyEl.clientHeight
      const distance   = Math.max(0, contentH - containerH)

      const scrollDuration = distance > 0 ? distance / SCROLL_PPS : 0
      const total = Math.max(MIN_SLIDE_SEC, scrollDuration + PAUSE_SEC)

      slideTotalRef.current = total
      setSlideLeft(Math.ceil(total))
      slideCountRef.current = setInterval(() => {
        setSlideLeft(s => Math.max(0, s - 1))
      }, 1000)

      if (distance > 0) {
        const bodyRect = bodyEl.getBoundingClientRect()
        const zoom = parseFloat(zoomEl.style.zoom) || 1

        zoomEl.querySelectorAll('table').forEach(table => {
          const thead = table.querySelector('thead')
          if (!thead) return

          const tableRect = table.getBoundingClientRect()
          const leftOffset = tableRect.left - bodyRect.left

          const wrapper = document.createElement('div')
          wrapper.style.cssText = `position:absolute;top:0;left:${leftOffset}px;width:${tableRect.width}px;z-index:10;overflow:hidden;pointer-events:none`

          const cloneTable = document.createElement('table')
          cloneTable.className = table.className
          cloneTable.style.zoom = String(zoom)
          cloneTable.style.width = `${tableRect.width / zoom}px`
          cloneTable.style.tableLayout = 'fixed'

          const clonedThead = thead.cloneNode(true)
          Array.from(thead.querySelectorAll('th')).forEach((th, i) => {
            const cloneTh = clonedThead.querySelectorAll('th')[i]
            if (!cloneTh) return
            const w = Math.round(th.getBoundingClientRect().width / zoom)
            cloneTh.style.width = `${w}px`
            cloneTh.style.minWidth = `${w}px`
            cloneTh.style.maxWidth = `${w}px`
          })

          cloneTable.appendChild(clonedThead)
          wrapper.appendChild(cloneTable)
          bodyEl.appendChild(wrapper)

          thead.style.visibility = 'hidden'
          headClonesRef.current.push({ wrapper, thead })
        })

        scrollAnimRef.current = zoomEl.animate(
          [{ transform: 'translateY(0px)' }, { transform: `translateY(-${distance}px)` }],
          { duration: scrollDuration * 1000, easing: 'linear', fill: 'forwards' }
        )
      }

      slideTimerRef.current = setTimeout(() => {
        setTabIdx(i => {
          const next = (i + 1) % TABS.length
          if (next === 0 && needsRefreshRef.current) { window.location.reload(); return i }
          return next
        })
      }, total * 1000)
    }, 400)

    return () => {
      clearTimeout(initTimer)
      clearTimeout(slideTimerRef.current)
      clearInterval(slideCountRef.current)
      clearTimeout(violationTimerRef.current)
      scrollAnimRef.current?.cancel()
      headClonesRef.current.forEach(({ wrapper, thead }) => {
        wrapper.parentNode?.removeChild(wrapper)
        thead.style.visibility = ''
      })
      headClonesRef.current = []
    }
  }, [tabIdx, violationIdx, violations])

  // ── Обратный отсчёт до обновления данных ────────────────────────────────────
  // Reload не делаем здесь — ждём конца цикла слайдов
  useEffect(() => {
    needsRefreshRef.current = false
    setRefresh(REFRESH_SEC)
    clearInterval(refreshRef.current)
    refreshRef.current = setInterval(() => {
      setRefresh(c => {
        if (c <= 1) {
          needsRefreshRef.current = true
          clearInterval(refreshRef.current)
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(refreshRef.current)
  }, [allItems, dateSummary])

  // ── Clock strings ───────────────────────────────────────────────────────────
  const clockTime = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const clockDate = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const updatedStr = status?.updatedAt
    ? new Date(status.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : null

  const tab = TABS[tabIdx].id

  const sharedHourlyProps = {
    idlesByEmployee, weightByEmployee,
    allowedIdleMinutes, shiftFilter, selectedDate,
  }

  return (
    <div className={s.page}>
      {/* ── Скрытый слой для предварительного замера ширины всех слайдов ── */}
      <div className={s.measureLayer} style={{ position: 'fixed', top: 0, left: '-200vw', width: '100vw', visibility: 'hidden', pointerEvents: 'none' }}>
        <div style={{ padding: '12px 16px' }} ref={el => { measureRefs.current.summary = el }}>
          {companySummary && (
            <CompanySummaryTable rows={companySummary.rows} hoursDisplay={companySummary.hoursDisplay} showHours={false} />
          )}
        </div>
        <div style={{ padding: '12px 16px' }} ref={el => { measureRefs.current.stats = el }}>
          {heDataAll && (
            <HourlyEmployeeTable allRows={heDataAll.allRows} hours={heDataAll.hours} mode="sz" {...sharedHourlyProps} />
          )}
        </div>
        <div style={{ padding: '12px 16px' }} ref={el => { measureRefs.current.idles = el }}>
          {heDataAll && (
            <HourlyEmployeeTable allRows={heDataAll.allRows} hours={heDataAll.hours} mode="idles" {...sharedHourlyProps} />
          )}
        </div>
      </div>

      {/* ── Header ── */}
      <header className={s.header}>
        <div className={s.headerLeft}>
          <span className={s.logoText}>СберЛогистика</span>
          <div className={s.tabs}>
            {TABS.map((t, i) => (
              <button
                key={t.id}
                className={`${s.tab} ${tabIdx === i ? s.tabActive : ''}`}
                onClick={() => setTabIdx(i)}
              >
                {t.label}
                {tabIdx === i && (
                  <span
                    className={s.tabProgress}
                    style={{ width: `${(slideLeft / slideTotalRef.current) * 100}%` }}
                  />
                )}
              </button>
            ))}
          </div>
        </div>

        <div className={s.headerRight}>
          {updatedStr && (
            <span className={s.updatedAt}>Обновлено: {updatedStr}</span>
          )}
          {loading && <span className={s.loadingDot}>●</span>}
          <span className={s.countdown} title="Обновление данных после завершения цикла слайдов">
            {refresh > 0 ? `↻ ${refresh}с` : '↻ после цикла'}
          </span>
          <div className={s.clock}>
            <span className={s.clockTime}>{clockTime}</span>
            <span className={s.clockDate}>{clockDate}</span>
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      <main className={s.body} ref={bodyRef}>
        <div className={s.zoom} ref={zoomRef}>
          {tab === 'summary' && (
            companySummary
              ? <CompanySummaryTable
                  rows={companySummary.rows}
                  hoursDisplay={companySummary.hoursDisplay}
                  showHours={false}
                />
              : <div className={s.empty}>{loading ? 'Загрузка...' : 'Нет данных'}</div>
          )}

          {tab === 'stats' && (
            heDataAll
              ? <HourlyEmployeeTable allRows={heDataAll.allRows} hours={heDataAll.hours} mode="sz" {...sharedHourlyProps} />
              : <div className={s.empty}>{loading ? 'Загрузка...' : 'Нет данных'}</div>
          )}

          {tab === 'idles' && (
            heDataAll
              ? <HourlyEmployeeTable allRows={heDataAll.allRows} hours={heDataAll.hours} mode="idles" {...sharedHourlyProps} />
              : <div className={s.empty}>{loading ? 'Загрузка...' : 'Нет данных'}</div>
          )}

          {tab === 'violations' && (
            violations.length === 0
              ? <div className={s.empty}>Нарушений нет</div>
              : (() => {
                  const v = violations[violationIdx] || violations[0]
                  return (
                    <div key={violationIdx} className={s.violationSlide}>
                      <div className={s.violationVideoWrap}>
                        <video
                          key={v.id}
                          className={s.violationVideo}
                          src={`/violation-videos/${v.videoFile}`}
                          autoPlay
                          muted
                          loop
                          playsInline
                        />
                      </div>
                      <div className={s.violationInfo}>
                        <div className={s.violationTitle}>
                          <span className={s.violationWarningIcon}>⚠</span>
                          {typewriterText}
                          {!typewriterDone && <span className={s.cursor} />}
                        </div>
                        <div className={s.violationRight}>
                          {v.damage != null && (
                            <div className={s.violationDamage}>
                              {damageDisplay.toLocaleString('ru-RU')} ₽
                            </div>
                          )}
                          {violations.length > 1 && (
                            <div className={s.violationDots}>
                              {violations.map((_, i) => (
                                <span key={i} className={`${s.dot} ${i === violationIdx ? s.dotActive : ''}`} />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })()
          )}
        </div>
      </main>
    </div>
  )
}
