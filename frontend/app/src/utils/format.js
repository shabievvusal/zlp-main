export function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

export function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function shiftLabel(date, type) {
  if (!date) return ''
  const [y, m, d] = date.split('-')
  const dateStr = d && m && y ? `${d}.${m}.${y}` : date
  return type === 'day' ? `${dateStr} День (9:00–21:00)` : `${dateStr} Ночь (21:00–9:00)`
}

export function formatMinutesToHours(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  if (m === 0) return '—'
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h > 0) return `${h}ч ${String(rem).padStart(2, '0')}м`
  return `${rem}м`
}

export function formatWeight(grams) {
  const g = Number(grams) || 0
  if (g <= 0) return '—'
  if (g >= 1_000_000) return `${(g / 1_000_000).toFixed(2)} т`
  if (g >= 1_000) return `${(g / 1_000).toFixed(1)} кг`
  return `${Math.round(g)} г`
}

/** "Иванов Иван Иванович" → "Иванов И.И.", телефоны/числа оставляет как есть */
export function shortFio(name) {
  if (!name) return '—'
  const parts = String(name).trim().split(/\s+/)
  if (parts.length < 2) return name
  // Если выглядит как телефон или нет кириллицы — не трогаем
  if (/^\d/.test(parts[0]) || !/[а-яёА-ЯЁ]/.test(name)) return name
  const last = parts[0]
  const initials = parts.slice(1).map(p => p[0] ? p[0].toUpperCase() + '.' : '').join('')
  return last + ' ' + initials
}

export function getTodayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
