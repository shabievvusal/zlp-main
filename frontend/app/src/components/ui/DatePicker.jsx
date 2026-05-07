import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ChevronDown, Calendar, Clock } from 'lucide-react'
import styles from './DatePicker.module.css'

const MONTHS       = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
const MONTHS_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек']
const DAYS         = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDatePart(str) {
  if (!str) return null
  const date = str.split(' ')[0].split('T')[0]
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return null
  return { y, m, d }
}

function parseTimePart(str) {
  if (!str) return { h: 0, min: 0 }
  const sep = str.includes('T') ? 'T' : ' '
  const parts = str.split(sep)
  if (parts.length < 2) return { h: 0, min: 0 }
  const [h, min] = parts[1].split(':').map(Number)
  return { h: h || 0, min: min || 0 }
}

function toDateStr(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

function toDateTimeStr(y, m, d, h, min) {
  return `${toDateStr(y, m, d)} ${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`
}

function getTodayStr() {
  const t = new Date()
  return toDateStr(t.getFullYear(), t.getMonth() + 1, t.getDate())
}

function getDaysInMonth(y, m) { return new Date(y, m, 0).getDate() }
function getFirstWeekday(y, m) { return (new Date(y, m - 1, 1).getDay() + 6) % 7 }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// ── Component ─────────────────────────────────────────────────────────────────

export default function DatePicker({
  value,
  onChange,
  max,
  min,
  showTime = false,
  placeholder = 'Выберите дату',
  id,
}) {
  const [open, setOpen]         = useState(false)
  const [above, setAbove]       = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const [popupPos, setPopupPos] = useState({})
  const triggerRef              = useRef(null)
  const popupRef                = useRef(null)
  const todayStr                = getTodayStr()

  const parsed   = parseDatePart(value)
  const timePart = showTime ? parseTimePart(value) : null

  const [viewY, setViewY] = useState(() => parsed?.y || new Date().getFullYear())
  const [viewM, setViewM] = useState(() => parsed?.m || new Date().getMonth() + 1)
  const [hour,  setHour]  = useState(() => timePart?.h   ?? 0)
  const [minute, setMin]  = useState(() => timePart?.min ?? 0)

  useEffect(() => {
    if (parsed) { setViewY(parsed.y); setViewM(parsed.m) }
  }, [value])

  useEffect(() => {
    if (showTime && value) {
      const t = parseTimePart(value)
      setHour(t.h); setMin(t.min)
    }
  }, [value, showTime])

  // Compute fixed position from trigger rect
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const popupWidth      = 256
    const estimatedHeight = showTime ? 380 : 310

    const _above = window.innerHeight - rect.bottom < estimatedHeight
    const _right = rect.left + popupWidth > window.innerWidth - 8

    setAbove(_above)
    setAlignRight(_right)

    const pos = {}
    if (_above) {
      pos.bottom = window.innerHeight - rect.top + 6
    } else {
      pos.top = rect.bottom + 6
    }
    if (_right) {
      pos.right = window.innerWidth - rect.right
    } else {
      pos.left = rect.left
    }
    setPopupPos(pos)
  }, [open, showTime])

  // Close on outside click, Escape, or scroll
  useEffect(() => {
    if (!open) return
    const onDown = e => {
      if (triggerRef.current?.contains(e.target)) return
      if (popupRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey    = e => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [open])

  const prevMonth = () => viewM === 1  ? (setViewM(12), setViewY(y => y - 1)) : setViewM(m => m - 1)
  const nextMonth = () => viewM === 12 ? (setViewM(1),  setViewY(y => y + 1)) : setViewM(m => m + 1)

  const emit = (dateStr, h, m) => {
    const v = showTime ? toDateTimeStr(...dateStr.split('-').map(Number), h, m) : dateStr
    onChange({ target: { value: v } })
  }

  const selectDay = d => {
    const str = toDateStr(viewY, viewM, d)
    if (max && str.slice(0,10) > max.slice(0,10)) return
    if (min && str.slice(0,10) < min.slice(0,10)) return
    emit(str, hour, minute)
    if (!showTime) setOpen(false)
  }

  const goToday = () => {
    const t = parseDatePart(todayStr)
    setViewY(t.y); setViewM(t.m)
    emit(todayStr, hour, minute)
    if (!showTime) setOpen(false)
  }

  const changeHour = v => {
    const h = clamp(isNaN(v) ? 0 : v, 0, 23)
    setHour(h)
    if (parsed) emit(toDateStr(parsed.y, parsed.m, parsed.d), h, minute)
  }

  const changeMin = v => {
    const m = clamp(isNaN(v) ? 0 : v, 0, 59)
    setMin(m)
    if (parsed) emit(toDateStr(parsed.y, parsed.m, parsed.d), hour, m)
  }

  const dateLabel = parsed
    ? `${String(parsed.d).padStart(2,'0')} ${MONTHS_SHORT[parsed.m - 1]} ${parsed.y}`
    : null
  const timeLabel = showTime
    ? `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`
    : null

  const firstDay    = getFirstWeekday(viewY, viewM)
  const daysInMonth = getDaysInMonth(viewY, viewM)
  const cells       = [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]
  const selectedDateStr = parsed ? toDateStr(parsed.y, parsed.m, parsed.d) : null

  const popupClassName = [
    styles.popup,
    above      ? styles.popupAbove : '',
    alignRight ? styles.popupRight : '',
  ].join(' ')

  return (
    <div className={styles.wrap}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Calendar size={13} className={styles.calIcon} />
        {dateLabel ? (
          <>
            <span className={styles.label}>{dateLabel}</span>
            {showTime && (
              <>
                <span className={styles.timeSep}>·</span>
                <Clock size={12} className={styles.calIcon} />
                <span className={styles.label}>{timeLabel}</span>
              </>
            )}
          </>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <ChevronDown size={12} className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} />
      </button>

      {open && createPortal(
        <div
          ref={popupRef}
          className={popupClassName}
          style={{ position: 'fixed', ...popupPos }}
          role="dialog"
        >
          {/* Month header */}
          <div className={styles.header}>
            <button type="button" className={styles.navBtn} onClick={prevMonth} aria-label="Предыдущий месяц">
              <ChevronLeft size={14} />
            </button>
            <span className={styles.monthLabel}>{MONTHS[viewM - 1]} {viewY}</span>
            <button type="button" className={styles.navBtn} onClick={nextMonth} aria-label="Следующий месяц">
              <ChevronRight size={14} />
            </button>
          </div>

          {/* Calendar grid */}
          <div className={styles.grid}>
            {DAYS.map(d => <div key={d} className={styles.dayName}>{d}</div>)}
            {cells.map((d, i) => {
              if (!d) return <div key={`_${i}`} />
              const str        = toDateStr(viewY, viewM, d)
              const isSelected = str === selectedDateStr
              const isToday    = str === todayStr
              const isDisabled = (max && str > max.slice(0,10)) || (min && str < min.slice(0,10))
              return (
                <button
                  key={d}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => selectDay(d)}
                  className={[
                    styles.day,
                    isSelected  ? styles.daySelected  : '',
                    isToday && !isSelected ? styles.dayToday : '',
                    isDisabled  ? styles.dayDisabled  : '',
                  ].join(' ')}
                >
                  {d}
                </button>
              )
            })}
          </div>

          {/* Time picker */}
          {showTime && (
            <div className={styles.timePicker}>
              <Clock size={14} className={styles.timeIcon} />
              <input
                className={styles.timeInput}
                type="number"
                min={0} max={23}
                value={String(hour).padStart(2,'0')}
                onChange={e => changeHour(parseInt(e.target.value, 10))}
              />
              <span className={styles.timeColon}>:</span>
              <input
                className={styles.timeInput}
                type="number"
                min={0} max={59}
                value={String(minute).padStart(2,'0')}
                onChange={e => changeMin(parseInt(e.target.value, 10))}
              />
            </div>
          )}

          {/* Footer */}
          <div className={styles.footer}>
            <button type="button" className={styles.todayBtn} onClick={goToday}>
              Сегодня
            </button>
            {showTime && (
              <button type="button" className={styles.applyBtn} onClick={() => setOpen(false)}>
                Применить
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
