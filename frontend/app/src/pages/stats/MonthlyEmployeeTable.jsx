import { useState, useEffect } from 'react'
import * as api from '../../api/index.js'
import { ZONES } from '../../utils/statsCalc.js'
import styles from './StatsPage.module.css'

function getTodayStr() {
  return new Date().toISOString().slice(0, 10)
}

function getMonthStartStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function fmtDate(d) {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}.${m}.${y}`
}

function fmtWorked(min) {
  if (!min || min <= 0) return '—'
  const totalSec = Math.round(min * 60)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}ч ${m}м ${s}с`
  if (m > 0) return `${m}м ${s}с`
  return `${s}с`
}

function enrichRows(rows) {
  return rows.map(r => {
    const wm = r.workedMinutes || 0
    return {
      ...r,
      szPerHour: wm > 0 ? +(r.total * 60 / wm).toFixed(1) : null,
      szPerMin:  wm > 0 ? +(r.total / wm).toFixed(2)       : null,
    }
  })
}

export default function MonthlyEmployeeTable({ exportRef }) {
  const [dateFrom,    setDateFrom]    = useState(getMonthStartStr)
  const [dateTo,      setDateTo]      = useState(getTodayStr)
  const [shift,       setShift]       = useState('')
  const [zone,        setZone]        = useState('')
  const [rows,        setRows]        = useState(null)
  const [loadedRange, setLoadedRange] = useState(null)
  const [loading,     setLoading]     = useState(false)
  const [sortCol,     setSortCol]     = useState('total')
  const [sortDir,     setSortDir]     = useState('desc')

  async function load() {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    try {
      const res = await api.getMonthlyEmployees(dateFrom, dateTo, shift || undefined, zone || undefined)
      setRows(enrichRows(res.rows || []))
      setLoadedRange({ from: dateFrom, to: dateTo })
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const handleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortCol(col); setSortDir(col === 'name' || col === 'company' || col === 'date' ? 'asc' : 'desc') }
  }

  const arrow = col => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const sorted = rows ? [...rows].sort((a, b) => {
    let va, vb
    if      (sortCol === 'date')      { va = a.date;      vb = b.date }
    else if (sortCol === 'company')   { va = a.company;   vb = b.company }
    else if (sortCol === 'name')      { va = a.name;      vb = b.name }
    else if (sortCol === 'total')     { va = a.total;     vb = b.total }
    else if (sortCol === 'szPerHour') { va = a.szPerHour ?? -1;       vb = b.szPerHour ?? -1 }
    else if (sortCol === 'szPerMin')  { va = a.szPerMin  ?? -1;       vb = b.szPerMin  ?? -1 }
    else if (sortCol === 'worked')    { va = a.workedMinutes ?? 0;    vb = b.workedMinutes ?? 0 }
    else                              { va = a.total;                 vb = b.total }
    if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb, 'ru') : vb.localeCompare(va, 'ru')
    return sortDir === 'asc' ? va - vb : vb - va
  }) : null

  const avg = sorted && sorted.length > 0 ? (() => {
    const n = sorted.length
    const avgTotal    = +(sorted.reduce((s, r) => s + r.total, 0) / n).toFixed(1)
    const withHour    = sorted.filter(r => r.szPerHour != null)
    const withMin     = sorted.filter(r => r.szPerMin  != null)
    const avgSzPerHour = withHour.length ? +(withHour.reduce((s, r) => s + r.szPerHour, 0) / withHour.length).toFixed(1) : null
    const avgSzPerMin  = withMin.length  ? +(withMin.reduce((s, r)  => s + r.szPerMin,  0) / withMin.length).toFixed(2)  : null
    return { avgTotal, avgSzPerHour, avgSzPerMin }
  })() : null

  const avgChipStyle = {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    background: 'var(--bg-secondary, #f3f4f6)', borderRadius: 8,
    padding: '4px 14px', minWidth: 80,
  }
  const avgLabelStyle = { fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }
  const avgValStyle   = { fontSize: 16, fontWeight: 600, color: 'var(--text)' }

  const thLeft = (col, label, title) => (
    <th onClick={() => handleSort(col)} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }} title={title}>
      {label}{arrow(col)}
    </th>
  )
  const thRight = (col, label, title) => (
    <th onClick={() => handleSort(col)} style={{ cursor: 'pointer', whiteSpace: 'nowrap', textAlign: 'right', width: '1%' }} title={title}>
      {label}{arrow(col)}
    </th>
  )

  const selectedZone = ZONES.find(z => z.key === zone)

  useEffect(() => {
    if (exportRef) exportRef.current = handleExport
  })

  async function handleExport() {
    if (!sorted?.length) return
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      wb.creator = 'ВС'; wb.created = new Date()
      const ws = wb.addWorksheet('Производительность')

      const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      const TOTAL_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
      const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
      const ALIGN  = { horizontal: 'center', vertical: 'middle' }

      const zoneLbl = selectedZone ? ` • ${selectedZone.label}` : ''
      const shiftLbl = shift === 'night' ? ' • Ночь' : shift === 'day' ? ' • День' : ''
      const title = `Производительность • ${fmtDate(loadedRange?.from)} — ${fmtDate(loadedRange?.to)}${zoneLbl}${shiftLbl}`

      const NCOLS = 7
      const AVG_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }

      // Строка 1: заголовок таблицы (A1:G1) + средние справа (I1:J1 labels, K1 values)
      ws.addRow([title])
      ws.mergeCells(1, 1, 1, NCOLS)
      ws.getRow(1).getCell(1).style = {
        font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } },
        fill: HEADER_FILL,
        alignment: { horizontal: 'left', vertical: 'middle' },
      }
      ws.getRow(1).height = 26

      // Средние — правее таблицы, начиная с колонки 9 (I)
      const avgLabels = ['Ср. СЗ', 'Ср. СЗ/ч', 'Ср. СЗ/мин']
      const avgValues = [avg?.avgTotal ?? '', avg?.avgSzPerHour ?? '', avg?.avgSzPerMin ?? '']
      avgLabels.forEach((lbl, i) => {
        const labelCell = ws.getRow(1).getCell(9 + i * 2)
        labelCell.value = lbl
        labelCell.style = { font: { bold: true, size: 11 }, fill: AVG_FILL, border: BORDER, alignment: ALIGN }
        const valCell = ws.getRow(1).getCell(10 + i * 2)
        valCell.value = avgValues[i]
        valCell.style = { font: { bold: true, size: 13 }, fill: AVG_FILL, border: BORDER, alignment: ALIGN }
      })

      const headers = ['Дата', 'Компания', 'ФИО', 'Итого СЗ', 'В работе', 'СЗ/ч', 'СЗ/мин']
      const hdrRow = ws.addRow(headers)
      hdrRow.height = 20
      hdrRow.eachCell(cell => {
        cell.style = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, border: BORDER, alignment: ALIGN }
      })
      ws.views = [{ state: 'frozen', ySplit: 2 }]

      // Ширины колонок средних
      ws.getColumn(9).width  = 12
      ws.getColumn(10).width = 10
      ws.getColumn(11).width = 12
      ws.getColumn(12).width = 10
      ws.getColumn(13).width = 14
      ws.getColumn(14).width = 10

      for (const r of sorted) {
        const row = ws.addRow([
          fmtDate(r.date),
          r.company || '—',
          r.name,
          r.total,
          fmtWorked(r.workedMinutes),
          r.szPerHour ?? '',
          r.szPerMin  ?? '',
        ])
        row.height = 18
        row.eachCell({ includeEmpty: true }, (cell, cn) => {
          cell.style = {
            border: BORDER,
            alignment: ALIGN,
            ...(cn >= 4 ? { fill: TOTAL_FILL } : {}),
          }
        })
      }

      ws.getColumn(1).width = 12
      ws.getColumn(2).width = 22
      ws.getColumn(3).width = 34
      ws.getColumn(4).width = 12
      ws.getColumn(5).width = 11
      ws.getColumn(6).width = 10
      ws.getColumn(7).width = 10

      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      const fname = `производительность_${loadedRange?.from}_${loadedRange?.to}${zone ? '_' + zone : ''}.xlsx`
      a.download = fname; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      console.error('Ошибка экспорта:', err)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Период:</span>
        <input type="date" className={styles.selectControl} style={{ fontSize: 13 }}
          value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
        <input type="date" className={styles.selectControl} style={{ fontSize: 13 }}
          value={dateTo} onChange={e => setDateTo(e.target.value)} />
        <select className={styles.selectControl} style={{ fontSize: 13 }}
          value={shift} onChange={e => setShift(e.target.value)}>
          <option value="">Все смены</option>
          <option value="day">День (9–21)</option>
          <option value="night">Ночь (21–9)</option>
        </select>
        <select
          className={styles.selectControl}
          style={{
            fontSize: 13,
            background: selectedZone ? selectedZone.bg : undefined,
            color:      selectedZone ? selectedZone.text : undefined,
          }}
          value={zone} onChange={e => setZone(e.target.value)}
        >
          <option value="">Все зоны</option>
          {ZONES.map(z => (
            <option key={z.key} value={z.key}>{z.label}</option>
          ))}
        </select>
        <button className="btn btn-secondary btn-sm"
          onClick={load} disabled={loading || !dateFrom || !dateTo}>
          {loading ? 'Загрузка...' : 'Загрузить'}
        </button>
        {loadedRange && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {fmtDate(loadedRange.from)} — {fmtDate(loadedRange.to)}
            {rows ? ` · ${rows.length} строк` : ''}
          </span>
        )}
      </div>

      {rows === null && (
        <div className={styles.emptyRow}>Выберите период и нажмите «Загрузить»</div>
      )}
      {rows !== null && (!sorted || sorted.length === 0) && (
        <div className={styles.emptyRow}>Нет данных за выбранный период</div>
      )}
      {avg && (
        <div style={{ display: 'flex', gap: 8, padding: '6px 12px', flexWrap: 'wrap' }}>
          <div style={avgChipStyle}>
            <span style={avgLabelStyle}>Ср. СЗ</span>
            <span style={avgValStyle}>{avg.avgTotal}</span>
          </div>
          <div style={avgChipStyle}>
            <span style={avgLabelStyle}>Ср. СЗ/ч</span>
            <span style={avgValStyle}>{avg.avgSzPerHour ?? '—'}</span>
          </div>
          <div style={avgChipStyle}>
            <span style={avgLabelStyle}>Ср. СЗ/мин</span>
            <span style={avgValStyle}>{avg.avgSzPerMin ?? '—'}</span>
          </div>
        </div>
      )}
      {sorted && sorted.length > 0 && (
        <div className={styles.heScrollWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {thLeft ('date',      'Дата',     'Дата смены')}
                {thLeft ('company',   'Компания', 'Компания-подрядчик')}
                {thLeft ('name',      'ФИО',      'ФИО сотрудника')}
                {thRight('total',     'Итого СЗ', 'Суммарное кол-во СЗ за смену')}
                {thRight('worked',    'В работе', 'Время в работе (span − простои ≥ 5 мин)')}
                {thRight('szPerHour', 'СЗ/ч',    'СЗ в час = Итого ÷ время в работе')}
                {thRight('szPerMin',  'СЗ/мин',  'СЗ в минуту = Итого ÷ время в работе')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                  <td>{r.company}</td>
                  <td className={styles.tdBold}>{r.name}</td>
                  <td className={styles.tdRight} style={{ whiteSpace: 'nowrap' }}>{r.total}</td>
                  <td className={styles.tdRight} style={{ whiteSpace: 'nowrap' }}>{fmtWorked(r.workedMinutes)}</td>
                  <td className={styles.tdRight} style={{ whiteSpace: 'nowrap' }}>{r.szPerHour ?? '—'}</td>
                  <td className={styles.tdRight} style={{ whiteSpace: 'nowrap' }}>{r.szPerMin  ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
