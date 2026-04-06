import { useMemo, useState, useCallback, useEffect } from 'react'
import { useApp } from '../../context/AppContext.jsx'
import { useAuth } from '../../context/AuthContext.jsx'
import {
  calcStats,
  getCompanySummaryTableData,
  getHourlyByEmployeeGroupedByCompany,
  calcIdleTotalsByEmployee,
  getShiftBoundaryMs,
  getWeightByEmployee,
  computeWorkedMinutesInShift,
  ZONES,
} from '../../utils/statsCalc.js'
import * as api from '../../api/index.js'
import { useNotify } from '../../context/NotifyContext.jsx'
import { normalizeFio, personKey } from '../../utils/emplUtils.js'
import StatsToolbar from './StatsToolbar.jsx'
import StatsCards from './StatsCards.jsx'
import CompanyFilter from './CompanyFilter.jsx'
import HourlyChart from './HourlyChart.jsx'
import CompanySummaryTable, { CompanySummaryToggle } from './CompanySummaryTable.jsx'
import MonthlyCompanySummaryTable from './MonthlyCompanySummaryTable.jsx'
import HourlyEmployeeTable from './HourlyEmployeeTable.jsx'
import { Download } from 'lucide-react'
import styles from './StatsPage.module.css'

const HE_MODES = [
  { key: 'sz',     label: 'По СЗ' },
  { key: 'hourly', label: 'По часам' },
  { key: 'zones',  label: 'По зонам' },
  { key: 'idles',  label: 'Простои' },
]

export default function StatsPage() {
  const {
    allItems, dateSummary, emplMap, emplNameMap, emplCompanies,
    selectedDate, shiftFilter, filterCompany,
    heTableMode, setHeTableMode,
    idleThresholdMinutes, setIdleThresholdMinutes,
    allowedIdleMinutes, setAllowedIdleMinutes,
    loading, status,
    newEmployeesFromFetch, dismissNewEmployees, addNewEmployees,
  } = useApp()

  const { user } = useAuth()
  const canEditThresholds = user?.actions?.includes('edit_thresholds')

  const [showHours, setShowHours] = useState(false)
  const [missingWeightTotal, setMissingWeightTotal] = useState(null)
  const notify = useNotify()

  const items = useMemo(() => {
    if (allItems.length) return allItems
    if (dateSummary?.items) return dateSummary.items
    return []
  }, [allItems, dateSummary])

  const isSummaryOnly = !allItems.length && !!dateSummary

  // ── Тяжёлые вычисления — только при смене items/shift/emplMap ──────────────
  const enrich = useCallback((name) => {
    const fromMap = emplNameMap.get(personKey(normalizeFio(name)))
    if (!fromMap) return name
    return fromMap.split(/\s+/).length >= name.split(/\s+/).length ? fromMap : name
  }, [emplNameMap])

  const heDataAll = useMemo(() => {
    if (isSummaryOnly && dateSummary?.hourlyByEmployee) {
      const { hours, rows } = dateSummary.hourlyByEmployee
      // Обогащаем имена и мёрджим дубли (короткое + полное имя → одна строка)
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
        for (const col of Object.keys(r.byHourZone || {})) if (!m.byHourZone[col] && r.byHourZone[col]) m.byHourZone[col] = r.byHourZone[col]
        for (const [zk, { count, weightGrams }] of Object.entries(r.byZone || {})) {
          if (!m.byZone[zk]) m.byZone[zk] = { count: 0, weightGrams: 0 }
          m.byZone[zk].count += count
          m.byZone[zk].weightGrams += weightGrams
        }
        m.total += r.total
        if (r.firstAt && (!m.firstAt || r.firstAt < m.firstAt)) m.firstAt = r.firstAt
        if (r.lastAt && r.lastAt > m.lastAt) m.lastAt = r.lastAt
      }
      return { hours: hours || [], allRows: [...merged.values()], byCompany: {}, companiesOrder: [] }
    }
    if (!items.length) return null
    return getHourlyByEmployeeGroupedByCompany(items, shiftFilter, emplMap, selectedDate, enrich)
  }, [isSummaryOnly, dateSummary, items, shiftFilter, emplMap, selectedDate, enrich])

  const companySummaryAll = useMemo(() => {
    if (isSummaryOnly && dateSummary?.companySummary) {
      return dateSummary.companySummary
    }
    if (!items.length) return null
    return getCompanySummaryTableData(items, shiftFilter, emplMap, selectedDate)
  }, [isSummaryOnly, dateSummary, items, shiftFilter, emplMap, selectedDate])

  const weightByEmployeeAll = useMemo(() => {
    let raw
    if (isSummaryOnly && dateSummary?.weightByEmployee) {
      raw = dateSummary.weightByEmployee
    } else if (!items.length) {
      return {}
    } else {
      raw = getWeightByEmployee(items)
    }
    const result = {}
    for (const [name, val] of Object.entries(raw)) {
      const key = enrich(name)
      if (!result[key]) {
        result[key] = { ...val }
      } else {
        result[key].storage += val.storage
        result[key].kdk += val.kdk
        result[key].total += val.total
      }
    }
    return result
  }, [isSummaryOnly, dateSummary, items, enrich])

  const idlesByEmployeeAll = useMemo(() => {
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
    for (const [name, val] of Object.entries(raw)) {
      result[enrich(name)] = val
    }
    return result
  }, [isSummaryOnly, dateSummary, items, selectedDate, shiftFilter, idleThresholdMinutes, enrich])

  // ── Лёгкая фильтрация по уже агрегированным строкам (O(сотрудники)) ────────
  const hourlyByEmployee = useMemo(() => {
    if (!heDataAll) return null
    if (filterCompany === '__all__') return heDataAll
    const allRows = heDataAll.allRows.filter(r =>
      filterCompany === '__none__' ? (!r.company || r.company === '—') : r.company === filterCompany
    )
    return { ...heDataAll, allRows }
  }, [heDataAll, filterCompany])

  const companySummary = useMemo(() => {
    if (!companySummaryAll) return null
    if (filterCompany === '__all__') return companySummaryAll
    const rows = companySummaryAll.rows.filter(r =>
      filterCompany === '__none__' ? (!r.companyName || r.companyName === '—') : r.companyName === filterCompany
    )
    return { ...companySummaryAll, rows }
  }, [companySummaryAll, filterCompany])

  const allowedNames = useMemo(() => {
    if (filterCompany === '__all__') return null
    return new Set(hourlyByEmployee?.allRows.map(r => r.name) ?? [])
  }, [hourlyByEmployee, filterCompany])

  const idlesByEmployee = useMemo(() => {
    if (!allowedNames) return idlesByEmployeeAll
    const out = {}
    for (const [n, v] of Object.entries(idlesByEmployeeAll))
      if (allowedNames.has(n)) out[n] = v
    return out
  }, [idlesByEmployeeAll, allowedNames])

  const weightByEmployee = useMemo(() => {
    if (!allowedNames) return weightByEmployeeAll
    const out = {}
    for (const [n, w] of Object.entries(weightByEmployeeAll))
      if (allowedNames.has(n)) out[n] = w
    return out
  }, [weightByEmployeeAll, allowedNames])

  // ── Карточки: calcStats один раз по всем items ────────────────────────────
  const statsAll = useMemo(() => {
    if (isSummaryOnly) {
      return {
        totalOps: dateSummary.totalOps || 0,
        totalQty: dateSummary.totalQty || 0,
        executors: dateSummary.executors || [],
        hourly: dateSummary.hourly || [],
        totalWeightStorageGrams: dateSummary.totalWeightStorageGrams || 0,
        totalWeightKdkGrams: dateSummary.totalWeightKdkGrams || 0,
        totalWeightGrams: dateSummary.totalWeightGrams || 0,
        missingWeightNames: dateSummary.missingWeightNames || [],
        missingWeightItems: dateSummary.missingWeightItems || (dateSummary.missingWeightNames || []).map(n => ({ name: n, article: '' })),
        withWeightKeys: [],
      }
    }
    if (!items.length) return null
    return calcStats(items, emplMap, '__all__')
  }, [items, dateSummary, emplMap, isSummaryOnly])

  const missingWeightNames = statsAll?.missingWeightNames || []
  const missingWeightItems = statsAll?.missingWeightItems || []
  const withWeightKeys     = statsAll?.withWeightKeys || []

  // Подгружаем общий счётчик по всем сменам с бэкенда (бэкенд пересобирает сам)
  const missingNamesCount = missingWeightNames.length
  useEffect(() => {
    if (missingNamesCount === 0) { setMissingWeightTotal(null); return }
    api.getMissingWeight().then(all => {
      if (Array.isArray(all)) setMissingWeightTotal(all.length)
    }).catch(() => {})
  }, [missingNamesCount])

  const handleExportHourly = useCallback(async () => {
    if (!hourlyByEmployee?.allRows?.length) { notify('Нет данных для экспорта', 'info'); return }
    if (heTableMode === 'zones' || heTableMode === 'idles') {
      notify('Переключитесь в режим «По СЗ» или «По часам» для экспорта', 'info'); return
    }
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      wb.creator = 'ВС'; wb.created = new Date()
      const ws = wb.addWorksheet('Сотрудники по часам')

      const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      const SUBHDR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1D5DB' } }
      const TOTAL_FILL  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
      const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
      const ALIGN  = { horizontal: 'center', vertical: 'middle' }
      const hexToArgb = h => 'FF' + h.replace('#','').padEnd(6,'0').toUpperCase()

      const { allRows, hours } = hourlyByEmployee
      const shiftLbl = shiftFilter === 'night' ? 'Ночная смена' : 'Дневная смена'
      const modeLbl  = heTableMode === 'sz' ? 'По СЗ' : 'По часам'
      const dateLbl  = selectedDate ? selectedDate.split('-').reverse().join('.') : ''

      // column indices (1-based)
      const C_CO = 1, C_NAME = 2
      const C_H0 = 3, C_HN = 2 + hours.length
      const C_TOT = C_HN + 1, C_WORK = C_TOT + 1, C_SP = C_WORK + 1
      const C_WS = C_SP + 1, C_WK = C_WS + 1, C_WT = C_WK + 1
      const NCOLS = C_WT

      // row 1: title
      ws.addRow([`Сотрудники по часам • ${modeLbl} • ${dateLbl} • ${shiftLbl}`])
      if (NCOLS > 1) ws.mergeCells(1, 1, 1, NCOLS)
      ws.getRow(1).getCell(1).style = { font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { horizontal: 'left', vertical: 'middle' } }
      ws.getRow(1).height = 26

      const addLT = (text) => {
        ws.addRow(new Array(NCOLS).fill(null))
        const rn = ws.lastRow.number
        if (NCOLS > 1) ws.mergeCells(rn, 1, rn, NCOLS)
        ws.getRow(rn).getCell(1).value = text
        ws.getRow(rn).getCell(1).style = { font: { bold: true, size: 11, color: { argb: 'FFFFFFFF' } }, fill: HEADER_FILL, alignment: { horizontal: 'left', vertical: 'middle' } }
        ws.getRow(rn).height = 18; ws.getRow(rn).outlineLevel = 1
      }
      const addLR = (argb, name, desc) => {
        ws.addRow(new Array(NCOLS).fill(null))
        const rn = ws.lastRow.number
        if (NCOLS > 3) ws.mergeCells(rn, 3, rn, NCOLS)
        const r = ws.getRow(rn)
        if (argb) r.getCell(1).style = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } }, border: BORDER, alignment: { vertical: 'middle', horizontal: 'center' } }
        r.getCell(2).value = name; r.getCell(2).style = { font: { bold: true }, alignment: { vertical: 'middle' } }
        r.getCell(3).value = desc; r.getCell(3).style = { alignment: { vertical: 'middle', wrapText: true } }
        r.height = Math.max(18, Math.ceil((desc || '').length / 70) * 16); r.outlineLevel = 1
      }
      const addLS = () => { ws.addRow(new Array(NCOLS).fill(null)); ws.getRow(ws.lastRow.number).height = 6; ws.getRow(ws.lastRow.number).outlineLevel = 1 }

      if (heTableMode === 'sz') {
        addLT('Легенда — цвета ячеек (режим «По СЗ»)')
        addLR('FFFECACA', '< 50 задач/час', 'Низкая производительность')
        addLR('FFFEF08A', '50–75 задач/час', 'Средняя производительность')
        addLR('FFFFFFFF', '> 75 задач/час', 'Высокая производительность')
      } else {
        addLT('Легенда — цвета ячеек (режим «По часам», доминирующая зона)')
        for (const z of ZONES) addLR(hexToArgb(z.bg), z.label, '')
      }
      addLS(); addLT('Описание колонок')
      addLR(null, 'Компания',   'Название компании-подрядчика сотрудника')
      addLR(null, 'Сотрудник',  'ФИО исполнителя')
      addLR(null, 'ЧЧ',         'Кол-во задач за данный час смены; под числом — вес (кг)')
      addLR(null, 'Итого',      'Суммарное кол-во задач за смену')
      addLR(null, 'В работе',   'Время в работе: длительность смены − суммарные простои (ЧЧ:ММ)')
      addLR(null, 'Старт/Пик',  'Верхняя строка — первая операция смены; нижняя — последняя')
      addLR(null, 'Вес ХР',     'Суммарный вес в зоне хранения (кг)')
      addLR(null, 'Вес КДК',    'Суммарный вес в зоне КДК (кг)')
      addLR(null, 'Вес итог',   'Общий суммарный вес (хранение + КДК, кг)')
      addLS()

      ws.addRow(new Array(NCOLS).fill(null)); ws.getRow(ws.lastRow.number).height = 4

      // two-row header
      const grpRN = ws.lastRow.number + 1
      const grpRow = ws.addRow(new Array(NCOLS).fill(''))
      const subRN = ws.lastRow.number + 1
      const subRow = ws.addRow(new Array(NCOLS).fill(''))

      const gHdr = (argb = 'FF374151') => ({ font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } }, border: BORDER, alignment: ALIGN })
      const sHdr = { font: { bold: true }, fill: SUBHDR_FILL, border: BORDER, alignment: ALIGN }

      for (const [col, label] of [[C_CO,'Компания'],[C_NAME,'Сотрудник'],[C_TOT,'Итого'],[C_WORK,'В работе'],[C_SP,'Старт/Пик'],[C_WS,'Вес ХР'],[C_WK,'Вес КДК'],[C_WT,'Вес итог']]) {
        ws.mergeCells(grpRN, col, subRN, col)
        grpRow.getCell(col).value = label; grpRow.getCell(col).style = gHdr()
      }
      if (hours.length > 0) {
        if (hours.length > 1) ws.mergeCells(grpRN, C_H0, grpRN, C_HN)
        grpRow.getCell(C_H0).value = 'Задачи по часам'; grpRow.getCell(C_H0).style = gHdr('FF1E3A5F')
        hours.forEach((col, i) => {
          const s = (col + 23) % 24
          subRow.getCell(C_H0 + i).value = `${String(s).padStart(2,'0')}–${String(col).padStart(2,'0')}`
          subRow.getCell(C_H0 + i).style = sHdr
        })
      }
      grpRow.height = 20; subRow.height = 18
      ws.views = [{ state: 'frozen', ySplit: subRN }]

      // data
      const wgKg = g => { const v = Number(g) || 0; return v > 0 ? +(v/1000).toFixed(1) : '' }
      const szFill = v => v < 50 ? { type:'pattern', pattern:'solid', fgColor:{argb:'FFFECACA'} }
                        : v <= 75 ? { type:'pattern', pattern:'solid', fgColor:{argb:'FFFEF08A'} } : null
      const zFill  = k => { const z = ZONES.find(z => z.key === k); return z ? { type:'pattern', pattern:'solid', fgColor:{argb: hexToArgb(z.bg)} } : null }

      const sorted = [...allRows].sort((a, b) => (a.company||'').localeCompare(b.company||'','ru') || b.total - a.total)
      for (const r of sorted) {
        const idleData  = idlesByEmployee[r.name] || {}
        const idleMin   = typeof idleData === 'object' ? (Number(idleData.totalMinutes)||0) : 0
        const workedMin = computeWorkedMinutesInShift(idleMin, allowedIdleMinutes, 12*60)
        const w = weightByEmployee[r.name] || { storage:0, kdk:0, total:0 }
        const fmt2 = n => String(Math.floor(n||0)).padStart(2,'0')
        const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}) : '—'

        const rowData = new Array(NCOLS).fill('')
        rowData[C_CO-1]   = r.company || '—'
        rowData[C_NAME-1] = r.name
        hours.forEach((col, i) => {
          const v = r.byHour?.[col] || 0
          const wg = r.weightByHour?.[col] || 0
          if (v > 0) rowData[C_H0-1+i] = wg > 0 ? `${v}\n${+(wg/1000).toFixed(1)} кг` : v
        })
        rowData[C_TOT-1]  = r.total || 0
        rowData[C_WORK-1] = workedMin > 0 ? `${fmt2(workedMin/60)}:${fmt2(workedMin%60)}` : '—'
        rowData[C_SP-1]   = `${fmtT(r.firstAt)}\n${fmtT(r.lastAt)}`
        rowData[C_WS-1]   = wgKg(w.storage) || '—'
        rowData[C_WK-1]   = wgKg(w.kdk) || '—'
        rowData[C_WT-1]   = wgKg(w.total) || '—'

        const row = ws.addRow(rowData); row.height = 30
        row.eachCell({ includeEmpty: true }, (cell, cn) => {
          const hasNL   = typeof cell.value === 'string' && cell.value.includes('\n')
          const isTotCol = [C_TOT, C_WORK, C_WS, C_WK, C_WT].includes(cn)
          let fill = isTotCol ? TOTAL_FILL : undefined
          if (cn >= C_H0 && cn <= C_HN) {
            const v = r.byHour?.[hours[cn - C_H0]] || 0
            if (v > 0) fill = (heTableMode === 'hourly' ? zFill(r.byHourZone?.[hours[cn-C_H0]]) : szFill(v)) || undefined
          }
          cell.style = { border: BORDER, alignment: { ...ALIGN, wrapText: hasNL }, ...(fill ? { fill } : {}) }
        })
      }

      ws.getColumn(C_CO).width = 18; ws.getColumn(C_NAME).width = 30
      hours.forEach((_, i) => { ws.getColumn(C_H0+i).width = 8 })
      ws.getColumn(C_TOT).width = 8; ws.getColumn(C_WORK).width = 10; ws.getColumn(C_SP).width = 13
      ws.getColumn(C_WS).width = 11; ws.getColumn(C_WK).width = 11; ws.getColumn(C_WT).width = 11

      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      a.download = `сотрудники_по_часам_${selectedDate || 'дата'}.xlsx`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      notify('Файл .xlsx загружен', 'success')
    } catch (err) { notify('Ошибка экспорта: ' + err.message, 'error') }
  }, [hourlyByEmployee, heTableMode, shiftFilter, selectedDate, idlesByEmployee, weightByEmployee, allowedIdleMinutes, notify])

  const handleExportMissingWeight = useCallback(async () => {
    try {
      if (missingWeightItems.length || withWeightKeys.length) {
        await api.syncMissingWeight(missingWeightItems, withWeightKeys)
      }
      const items2 = await api.getMissingWeight()
      if (!items2.length) { notify('Список неучтённых товаров пуст', 'info'); return }
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Неучтенный вес')
      ws.columns = [
        { header: 'Артикул', key: 'article', width: 20 },
        { header: 'Название товара', key: 'name', width: 70 },
      ]
      ws.getRow(1).font = { bold: true }
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } }
      for (const item of items2) ws.addRow({ article: item.article || '', name: item.name || '' })
      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'неучтенный_вес.xlsx'; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      notify(`Выгружено ${items2.length} товаров`, 'success')
    } catch (err) {
      notify('Ошибка экспорта: ' + err.message, 'error')
    }
  }, [missingWeightItems, withWeightKeys, notify])

  // При активном фильтре выводим stats из уже готовых агрегированных строк — O(сотрудники)
  const stats = useMemo(() => {
    if (!statsAll) return null
    if (filterCompany === '__all__') return statsAll
    const empRows = hourlyByEmployee?.allRows || []
    const compRows = companySummary?.rows || []
    const totalOps = empRows.reduce((s, r) => s + r.total, 0)
    const totalWeightStorageGrams = compRows.reduce((s, r) => s + (r.weightStorageGrams || 0), 0)
    const totalWeightKdkGrams    = compRows.reduce((s, r) => s + (r.weightKdkGrams    || 0), 0)
    // hourly для графика из byHour сотрудников
    const hourMap = new Map()
    for (const r of empRows) {
      for (const [colStr, v] of Object.entries(r.byHour || {})) {
        if (!v) continue
        const col = +colStr
        if (!hourMap.has(col)) hourMap.set(col, { hour: col, ops: 0, employees: 0, storageOps: 0, kdkOps: 0 })
        const h = hourMap.get(col)
        h.ops += v
        h.employees++
        h.storageOps += v  // нет раздельной разбивки без сырых items — показываем все как хранение
      }
    }
    return {
      ...statsAll,
      totalOps,
      executors: empRows,
      hourly: [...hourMap.values()].sort((a, b) => a.hour - b.hour),
      totalWeightStorageGrams,
      totalWeightKdkGrams,
      totalWeightGrams: totalWeightStorageGrams + totalWeightKdkGrams,
    }
  }, [statsAll, filterCompany, hourlyByEmployee, companySummary])

  return (
    <div className={styles.mainContent}>
      <StatsToolbar />

      {loading && <div className={styles.loadingBar} />}

      {newEmployeesFromFetch.length > 0 && (
        <div className={styles.newEmplBanner}>
          <div className={styles.newEmplBannerBody}>
            <span className={styles.newEmplBannerTitle}>Новые сотрудники из WMS ({newEmployeesFromFetch.length}):</span>
            <span className={styles.newEmplBannerList}>{newEmployeesFromFetch.join(', ')}</span>
          </div>
          <div className={styles.newEmplBannerActions}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => addNewEmployees(newEmployeesFromFetch)}>
              Добавить в список
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={dismissNewEmployees}>
              Позже
            </button>
          </div>
        </div>
      )}

      {/* Карточки */}
      {stats && (
        <StatsCards stats={stats} selectedDate={selectedDate} shiftFilter={shiftFilter} />
      )}

      {/* Неучтённый вес */}
      {statsAll && (
        <div className={styles.statsWeightRow}>
          <span className={styles.statsWeightNote}>
            {missingWeightNames.length > 0
              ? `Не учтено в весе: ${missingWeightNames.length} (смена)${missingWeightTotal != null ? ` · ${missingWeightTotal} (всего)` : ''}`
              : 'Не учтено в весе: 0 (смена)'}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={missingWeightNames.length === 0}
            onClick={handleExportMissingWeight}
          >
            <Download size={13} strokeWidth={2} style={{marginRight:4}}/>XLSX: неучтённый вес
          </button>
        </div>
      )}

      {/* Фильтр по подрядчику */}
      {emplCompanies.length > 0 && <CompanyFilter />}

      {/* Сводка по компаниям */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <span>Сводка по компаниям</span>
            <span className={styles.cardHeaderSub}> Сотрудники, СЗЧ (), Итог СЗ</span>
          </div>
          <CompanySummaryToggle showHours={showHours} onChange={setShowHours} />
        </div>
        {companySummary
          ? <CompanySummaryTable rows={companySummary.rows} hoursDisplay={companySummary.hoursDisplay} showHours={showHours} />
          : <div className={styles.emptyRow}>Нет данных</div>
        }
      </div>

      {/* Сводка по компаниям за месяц */}
      <MonthlyCompanySummaryTable />

      {/* Пики по часам */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span>Пики по часам</span>
          <span className={styles.cardHeaderSub}>операции и сотрудники за каждый час; столбики — хранение и КДК</span>
        </div>
        {stats?.hourly?.length
          ? <HourlyChart hourly={stats.hourly} shiftFilter={shiftFilter} />
          : <div className={styles.emptyRow}>Нет данных</div>
        }
      </div>

      {/* Сотрудники по часам */}
      <div className={styles.card}>
        <div className={`${styles.cardHeader} ${styles.cardHeaderHourly}`}>
          <div>
            <span>Сотрудники по часам</span>
            {status?.lastRun && (
              <div className={styles.statsLastUpdate}>
                Обновлено: {new Date(status.lastRun).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
          <div className={styles.hourlyControlsWrap}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleExportHourly}
              disabled={!hourlyByEmployee?.allRows?.length || heTableMode === 'zones' || heTableMode === 'idles'}
              title="Выгрузить таблицу в Excel"
            >
              <Download size={13} strokeWidth={2} style={{marginRight:4}}/>XLSX
            </button>
            <div className={styles.hourlyControlsSep} />
            <div className={styles.heModeToggle}>
              {HE_MODES.map(m => (
                <button
                  key={m.key}
                  className={`${styles.heModeBtn} ${heTableMode === m.key ? styles.heModeBtnActive : ''}`}
                  onClick={() => setHeTableMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className={styles.hourlyControlsSep} />
            <label className={styles.heIdlesConfig} title="Порог простоя (мин)">
              <span>Порог, мин</span>
              <input
                type="number"
                className={styles.formControlSm}
                min="0"
                value={idleThresholdMinutes}
                readOnly={!canEditThresholds}
                onChange={canEditThresholds ? e => setIdleThresholdMinutes(e.target.value === '' ? '' : Number(e.target.value)) : undefined}
                onBlur={canEditThresholds ? e => { if (e.target.value === '') setIdleThresholdMinutes(0) } : undefined}
              />
            </label>
            <label className={styles.heIdlesConfig} title="Допустимое суммарное время простоя (мин)">
              <span>Доп. простоя, мин</span>
              <input
                type="number"
                className={styles.formControlSm}
                min="0"
                value={allowedIdleMinutes}
                readOnly={!canEditThresholds}
                onChange={canEditThresholds ? e => setAllowedIdleMinutes(e.target.value === '' ? '' : Number(e.target.value)) : undefined}
                onBlur={canEditThresholds ? e => { if (e.target.value === '') setAllowedIdleMinutes(0) } : undefined}
              />
            </label>
          </div>
        </div>
        {hourlyByEmployee
          ? <HourlyEmployeeTable
              allRows={hourlyByEmployee.allRows}
              hours={hourlyByEmployee.hours}
              mode={heTableMode}
              idlesByEmployee={idlesByEmployee}
              weightByEmployee={weightByEmployee}
              allowedIdleMinutes={allowedIdleMinutes}
              shiftFilter={shiftFilter}
              selectedDate={selectedDate}
            />
          : <div className={styles.emptyRow}>Нет данных</div>
        }
      </div>
    </div>
  )
}
