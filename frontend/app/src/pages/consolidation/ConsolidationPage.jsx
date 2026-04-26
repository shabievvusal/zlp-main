import { useState, useEffect, useCallback, useRef } from 'react'
import * as api from '../../api/index.js'
import { formatDateTime } from '../../utils/format.js'
import { X, Search, Pencil, RefreshCw, Send, Printer } from 'lucide-react'
import s from './ConsolidationPage.module.css'

// ─── Constants ───────────────────────────────────────────────────────────────

const SAMOKAT_STOCKS_URL = 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search'
const SAMOKAT_CELLS_URL  = 'https://api.samokat.ru/wmsops-wwh/topology/cells/filters/by-address-search'
const LOOKUP_OP_TYPES = [
  'PIECE_SELECTION_PICKING',
  'PIECE_SELECTION_PICKING_COMPLETE',
  'PICK_BY_LINE',
  'PALLET_SELECTION_MOVE_TO_PICK_BY_LINE',
]
const SZ_RECIPIENT = 'Геращенко И.С.'
const SZ_ORG = 'СТПС ООО «СберЛогистика»'
const MEMOS_SUPERVISORS_KEY = 'memos_supervisors'
const SZ_COMPANY_NAMES = {
  'два колеса': 'ООО "Два Колеса"',
  '2 колеса': 'ООО "Два Колеса"',
  'мувинг': 'ООО "Мувинговая компания"',
  'мувинговая': 'ООО "Мувинговая компания"',
  'мувинговая компания': 'ООО "Мувинговая компания"',
  'градус': 'ООО "Градус"',
  'эни ком сервис': 'ООО "Эни Ком Сервис"',
  'эни сервис ком': 'ООО "Эни Ком Сервис"',
  'эск': 'ООО "Эни Ком Сервис"',
}
const LS_ACCESS_KEY        = 'wms_access_token'
const LS_ACCESS_EXPIRY_KEY = 'wms_access_token_expiry'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getStoredToken() {
  try {
    const token  = localStorage.getItem(LS_ACCESS_KEY)
    const expiry = localStorage.getItem(LS_ACCESS_EXPIRY_KEY)
    if (!token) return null
    if (expiry && Date.now() > Number(expiry) - 60_000) return null
    return token
  } catch { return null }
}

function getSupervisors() {
  try { return JSON.parse(localStorage.getItem(MEMOS_SUPERVISORS_KEY) || '[]') } catch { return [] }
}


function formatDateOnly(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

function formatTimeOnly(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatCompanyForSz(raw) {
  if (!raw || !String(raw).trim()) return '—'
  const key = String(raw).trim().toLowerCase()
  return SZ_COMPANY_NAMES[key] || (key.startsWith('ооо "') ? raw.trim() : `ООО "${raw.trim()}"`)
}

function getTaskAreaPhrase(c) {
  if (c.taskArea === 'kdk') return 'выполнял задачу в КДК'
  if (c.taskArea === 'storage') return 'выполняя задачу в хранении'
  const op = (c.operationType || '').toUpperCase()
  if (op === 'PICK_BY_LINE' || op.includes('PALLET')) return 'выполнял задачу в КДК'
  return 'выполняя задачу в хранении'
}

function getComplaintPhotos(c) {
  return Array.isArray(c.photoFilenames) && c.photoFilenames.length > 0
    ? c.photoFilenames
    : (c.photoFilename ? [c.photoFilename] : [])
}

function photoUrl(name) {
  if (!name) return ''
  if (name.startsWith('http')) return name
  return `/api/consolidation/uploads/${encodeURIComponent(name)}`
}

// ─── WMS lookup (browser-side) ───────────────────────────────────────────────

async function wmsPost(token, body) {
  const r = await fetch(SAMOKAT_STOCKS_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
    },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`API ${r.status}`)
  return JSON.parse(text)
}

async function wmsGet(token, url) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`API ${r.status}`)
  return JSON.parse(text)
}

function normalizeCellAddress(str) {
  return String(str || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[—–−]/g, '-')
}

function extractCellIdList(data, wantedAddressNorm) {
  const value = data?.value || data || {}
  const lists = [
    value?.items, data?.items, value?.content, data?.content,
    value?.cells, data?.cells,
    Array.isArray(value) ? value : null,
    Array.isArray(data) ? data : null,
  ].filter(Array.isArray)
  const rawItems = lists.flat()
  const wantedNorm = normalizeCellAddress(wantedAddressNorm)
  const outExact = [], outLoose = []
  for (const it of rawItems) {
    const id = it?.cellId ?? it?.id ?? null
    const addr = normalizeCellAddress(it?.cellAddress || it?.fullAddress || it?.address || it?.name || '')
    if (!id) continue
    if (wantedNorm) {
      if (addr === wantedNorm) { if (!outExact.includes(id)) outExact.push(id) }
      else if (addr.includes(wantedNorm) || wantedNorm.includes(addr)) { if (!outLoose.includes(id)) outLoose.push(id) }
    } else if (!outLoose.includes(id)) outLoose.push(id)
  }
  return outExact.length > 0 ? outExact : outLoose
}

async function findCellIdsByAddress(token, cellAddress) {
  const query = String(cellAddress || '').trim()
  if (!query) return []
  const urls = [
    `${SAMOKAT_CELLS_URL}?cellAddressSearch=${encodeURIComponent(query)}`,
    `${SAMOKAT_CELLS_URL}?cellAddressSearch=${encodeURIComponent(query)}&pageNumber=1&pageSize=50`,
  ]
  for (const url of urls) {
    try {
      const data = await wmsGet(token, url)
      const ids = extractCellIdList(data, query)
      if (ids.length > 0) return ids
      const any = extractCellIdList(data, '')
      if (any.length > 0) return any
    } catch { /* try next */ }
  }
  return []
}

function fioFromUser(user) {
  if (!user) return null
  if (typeof user === 'string') return user
  return [user.lastName, user.firstName, user.middleName].filter(Boolean).join(' ').trim() || null
}

function matchesBarcode(item, barcodeNorm) {
  const barcodes = item?.product?.barcodes || []
  return barcodes.some(b => String(b).trim() === barcodeNorm) ||
    String(item?.product?.nomenclatureCode || '').trim() === barcodeNorm
}

function matchesHandlingUnitBarcode(item, barcodeNorm) {
  return String(item?.sourceAddress?.handlingUnitBarcode || '').trim() === barcodeNorm ||
    String(item?.targetAddress?.handlingUnitBarcode || '').trim() === barcodeNorm
}

function pickProductBarcode(item, requestedBarcode) {
  const list = Array.isArray(item?.product?.barcodes)
    ? item.product.barcodes.map(x => String(x).trim()).filter(Boolean) : []
  const req = String(requestedBarcode || '').trim()
  if (req && list.includes(req)) return req
  return list[0] || null
}

function matchesCell(item, cellNorm) {
  return String(item?.targetAddress?.cellAddress || '').trim().toLowerCase() === cellNorm ||
    String(item?.sourceAddress?.cellAddress || '').trim().toLowerCase() === cellNorm
}

function matchesTargetCell(item, cellIds, cellNorm) {
  if (!Array.isArray(cellIds) || cellIds.length === 0) return matchesCell(item, cellNorm)
  const id = item?.targetAddress?.cellId
  if (id) return cellIds.includes(id)
  return matchesCell(item, cellNorm)
}

async function lookupViaBrowser(token, barcode, cell) {
  function isoMsk(date) {
    const tzOffset = -3 * 60
    return new Date(date.getTime() - tzOffset * 60000).toISOString().replace('Z', '+03:00')
  }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todayISO = isoMsk(today)
  const nowISO = isoMsk(new Date())

  const result = {
    productName: null, nomenclatureCode: null, productBarcode: null,
    violator: null, violatorId: null, handlingUnitBarcode: null,
    operationType: null, operationCompletedAt: null,
    lookupDone: true, lookupError: null, strategy: null,
  }

  const barcodeNorm = String(barcode).trim()
  const cellNorm = String(cell || '').trim().toLowerCase()
  let cellIds = []

  try { cellIds = await findCellIdsByAddress(token, cell) } catch { /* ignore */ }

  const baseBody = {
    productId: null, parts: [], operationTypes: null,
    sourceCellId: null, targetCellId: null,
    operationStartedAtFrom: todayISO, operationStartedAtTo: nowISO,
    operationCompletedAtFrom: todayISO, operationCompletedAtTo: nowISO,
    executorId: null,
  }

  // ─── Priority: exact match (cell + barcode) ───────────────────────────────
  try {
    const exactBodies = cellIds.length > 0
      ? cellIds.map(id => ({ ...baseBody, targetCellId: id, operationTypes: LOOKUP_OP_TYPES }))
      : [{ ...baseBody, operationTypes: LOOKUP_OP_TYPES }]

    const pageSize = 500
    let pageNumber = 1
    let exactFound = [], exactMatchMode = null

    while (true) {
      const batches = await Promise.all(exactBodies.map(b => wmsPost(token, { ...b, pageNumber, pageSize })))
      const allItems = batches.flatMap(b => b?.value?.items || [])
      if (allItems.length === 0) break

      const byBarcode = allItems.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesBarcode(it, barcodeNorm))
      if (byBarcode.length > 0) { exactFound = byBarcode; exactMatchMode = 'product_barcode'; break }

      const byHU = allItems.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesHandlingUnitBarcode(it, barcodeNorm))
      if (byHU.length > 0) { exactFound = byHU; exactMatchMode = 'handling_unit_barcode'; break }

      pageNumber++
    }

    if (exactFound.length > 0) {
      exactFound.sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
      const ex = exactFound[0]
      result.productName = ex.product?.name || null
      result.nomenclatureCode = ex.product?.nomenclatureCode || null
      result.productBarcode = pickProductBarcode(ex, barcodeNorm)
      result.violator = fioFromUser(ex.responsibleUser) || fioFromUser(ex.executor) || null
      result.violatorId = ex.responsibleUser?.id || ex.executorId || null
      result.handlingUnitBarcode = ex?.targetAddress?.handlingUnitBarcode || ex?.sourceAddress?.handlingUnitBarcode || null
      result.operationType = ex.operationType || null
      result.operationCompletedAt = ex.operationCompletedAt || null
      result.strategy = exactMatchMode === 'handling_unit_barcode' ? 'exact_cell_and_handling_unit_barcode' : 'exact_cell_and_barcode'
      return result
    }
  } catch { /* fallback */ }

  // ─── Fallback: search by cell, filter by barcode on client ────────────────
  const fallbackBodies = cellIds.length > 0
    ? cellIds.map(id => ({ ...baseBody, targetCellId: id, operationTypes: LOOKUP_OP_TYPES }))
    : [{ ...baseBody, operationTypes: LOOKUP_OP_TYPES }]

  let itemsA = [], foundByHandlingUnit = false
  const pageSize = 500
  let pageNumber = 1

  while (true) {
    const batches = await Promise.all(fallbackBodies.map(b => wmsPost(token, { ...b, pageNumber, pageSize })))
    const allItems = batches.flatMap(b => b?.value?.items || [])
    if (allItems.length === 0) break

    const byBarcode = allItems.filter(it => matchesBarcode(it, barcodeNorm))
    if (byBarcode.length > 0) { itemsA = byBarcode; foundByHandlingUnit = false; break }

    const byHU = allItems.filter(it => matchesHandlingUnitBarcode(it, barcodeNorm))
    if (byHU.length > 0) { itemsA = byHU; foundByHandlingUnit = true; break }

    pageNumber++
  }

  result.strategy = itemsA.length > 0
    ? (foundByHandlingUnit ? 'handling_unit_match_paginated' : 'ean_match_paginated')
    : 'not_found'

  if (itemsA.length === 0) return result

  itemsA.sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
  const first = itemsA[0]
  result.productName = first.product?.name || null
  result.nomenclatureCode = first.product?.nomenclatureCode || null

  const productId = first.product?.productId ?? first.productId ?? null
  if (!productId || !cell) return result

  // ─── Step B: find violator ────────────────────────────────────────────────
  const stepBQueries = cellIds.length > 0
    ? cellIds.map(id => wmsPost(token, { ...baseBody, productId, targetCellId: id, pageNumber: 1, pageSize: 500 }))
    : [wmsPost(token, { ...baseBody, productId, pageNumber: 1, pageSize: 500 })]

  const stepBData = await Promise.all(stepBQueries)
  const itemsB = stepBData.flatMap(x => x?.value?.items || [])

  const matched = itemsB.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesBarcode(it, barcodeNorm))
  const matchedFinal = matched.length > 0
    ? matched
    : itemsB.filter(it => matchesTargetCell(it, cellIds, cellNorm) && matchesHandlingUnitBarcode(it, barcodeNorm))

  if (matchedFinal.length > 0) {
    matchedFinal.sort((a, b) => new Date(b.operationCompletedAt || 0) - new Date(a.operationCompletedAt || 0))
    const v = matchedFinal[0]
    result.violator = fioFromUser(v.responsibleUser) || fioFromUser(v.executor) || null
    result.violatorId = v.responsibleUser?.id || v.executorId || null
    result.productBarcode = pickProductBarcode(v, barcodeNorm)
    result.handlingUnitBarcode = v?.targetAddress?.handlingUnitBarcode || v?.sourceAddress?.handlingUnitBarcode || null
    result.operationType = v.operationType || null
    result.operationCompletedAt = v.operationCompletedAt || null
  }

  return result
}

// ─── Print service notes ──────────────────────────────────────────────────────

function shortFio(fullName) {
  if (!fullName) return '—'
  const parts = String(fullName).trim().split(/\s+/)
  if (parts.length < 2) return parts[0] || '—'
  const [last, first, ...rest] = parts
  const initials = [first, ...rest].filter(Boolean).map(p => p[0].toUpperCase() + '.').join('')
  return `${last} ${initials}`
}

function buildServiceNoteSection(c, uploadsBaseUrl, supervisorName) {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const violator = c.violator?.trim() || '—'
  const violatorShort = shortFio(violator)
  const dateStr = formatDateOnly(c.operationCompletedAt || c.createdAt)
  const timeStr = formatTimeOnly(c.operationCompletedAt || c.createdAt)
  const productName = c.productName?.trim() || '—'
  const productBarcode = c.productBarcode?.trim() || c.barcode?.trim() || '—'
  const eo = c.handlingUnitBarcode?.trim() || c.barcode?.trim() || '—'
  const cell = c.cell?.trim() || '—'
  const quantity = c.quantity?.trim() || '1'
  const utDisplay = c.nomenclatureCode?.trim() || ''
  const supervisor = supervisorName?.trim() || ''
  const photos = getComplaintPhotos(c)
  const photoUrls = photos.map(name => name.startsWith('http') ? name : uploadsBaseUrl + encodeURIComponent(name))
  const imgs = photoUrls.map(url => `<img src="${url}" alt="Фото" class="sz-photo" crossorigin="">`).join('')
  const utBarcodeStr = [utDisplay, productBarcode !== '—' ? `ШК ${esc(productBarcode)}` : ''].filter(Boolean).join(' / ')
  return `
    <div class="sz-page">
      <div class="sz-header-right">
        <p>Начальнику склада</p>
        <p>${esc(SZ_ORG)}</p>
        <p>${esc(SZ_RECIPIENT)}</p>
        <p>От начальника смены</p>
        <p>${supervisor ? esc(supervisor) : '________________'}</p>
      </div>
      <div class="sz-title">Служебная записка</div>
      <div class="sz-title sz-title-sub">о выявленных нарушениях в процессе работы</div>
      <p class="sz-p">Настоящим сообщаю, что ${esc(dateStr)} года за кладовщиком ${esc(violator)} участка комплектации п. Шушары (г. Санкт-Петербург) было выявлено нарушение формирования отправления по п.2 приложения № 4 от 01.01.2025 года, а именно:</p>
      <p class="sz-p sz-p-noident">- ${esc(productName)}${utBarcodeStr ? ` ${esc(utBarcodeStr)}` : ''}</p>
      <p class="sz-p sz-p-noident">В количестве: ${esc(quantity)} шт.</p>
      <p class="sz-p sz-p-noident">Место: ${esc(cell)}</p>
      <p class="sz-p sz-p-noident">ЕО: ${esc(eo)}</p>
      <p class="sz-p sz-p-noident">Время: ${esc(dateStr)} ${esc(timeStr)}</p>
      <p class="sz-p">Данное нарушение подтверждается камерами видеонаблюдения и результатами приемки на ЦФЗ. Таким образом, зафиксировано ненадлежащее исполнение трудовых обязанностей кладовщиком ${esc(violatorShort)}.</p>
      <p class="sz-p">Подобные ошибки ведут к сбоям в адресации товара, росту недовозов и дополнительной нагрузке на персонал ЦФЗ, что систематически фиксируется в наших сводках.</p>
      <p class="sz-p">Так же данные действия привели к увеличению трудозатрат на обработку указанных позиций: дополнительные проверки, пересчеты и инвентаризации. Появляются риски ухудшения деловой репутации нашей компании, а также недоверию к качеству услуг, оказываемых нашей компанией как исполнителем складских логистических услуг.</p>
      <div class="sz-sign-block">
        <p class="sz-sign-label">Со служебной запиской ознакомлен, нарушения подтверждаю:</p>
        <div class="sz-sign-fields"><span></span><span></span><span></span></div>
        <div class="sz-sign-captions"><span>(Подпись)</span><span>(Расшифровка)</span><span>(Дата)</span></div>
        <p class="sz-sign-label" style="margin-top:18px">Начальник смены:</p>
        <div class="sz-sign-fields"><span></span><span></span><span></span></div>
        <div class="sz-sign-captions"><span>(Подпись)</span><span>(Расшифровка)</span><span>(Дата)</span></div>
      </div>
      ${photoUrls.length > 0 ? `<div class="sz-photos">${imgs}</div>` : ''}
    </div>`
}

function printServiceNotes(selected, supervisorName) {
  if (selected.length === 0) { alert('Отметьте галочками жалобы для печати СЗ'); return }
  const origin = window.location.origin || ''
  const uploadsBaseUrl = origin + '/api/consolidation/uploads/'
  const sections = selected.map(c => buildServiceNoteSection(c, uploadsBaseUrl, supervisorName)).join('')
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Служебные записки</title>
<style>
@page { size: A4; margin: 20mm; }
body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.45; color: #000; margin: 0; padding: 16px; }
.sz-page { page-break-after: always; padding-bottom: 20px; }
.sz-page:last-child { page-break-after: auto; }
.sz-header-right { text-align: right; margin-bottom: 20px; }
.sz-header-right p { margin: 2px 0; }
.sz-title { text-align: center; font-weight: 700; margin: 8px 0 2px; }
.sz-title-sub { margin-bottom: 14px; }
.sz-p { text-align: justify; text-indent: 1.25cm; margin: 0 0 8px 0; }
.sz-p-noident { text-indent: 0; }
.sz-sign-block { margin-top: 24px; }
.sz-sign-label { margin: 0 0 4px 0; }
.sz-sign-fields { display: flex; gap: 24px; margin-top: 14px; }
.sz-sign-fields span { flex: 1; border-bottom: 1px solid #000; min-width: 100px; }
.sz-sign-captions { display: flex; gap: 24px; margin-top: 2px; }
.sz-sign-captions span { flex: 1; font-size: 10pt; text-align: center; }
.sz-photos { margin-top: 16px; height: 230mm; display: flex; flex-direction: column; gap: 0; page-break-inside: avoid; }
.sz-photo { width: 100%; flex: 1; min-height: 60mm; object-fit: cover; display: block; border: 1px solid #ccc; box-sizing: border-box; }
</style></head><body>${sections}</body></html>`
  const w = window.open('', '_blank')
  if (!w) { alert('Разрешите всплывающие окна для печати'); return }
  w.document.write(html); w.document.close()
  w.onload = () => { w.focus(); w.print(); w.afterprint = () => w.close() }
}

// ─── Photo modal ──────────────────────────────────────────────────────────────

function PhotoModal({ urls, idx, onClose, onPrev, onNext }) {
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && urls.length > 1) onPrev()
      else if (e.key === 'ArrowRight' && urls.length > 1) onNext()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [urls, onClose, onPrev, onNext])

  const multi = urls.length > 1
  return (
    <div className={s.photoModalOverlay} onClick={onClose}>
      <div className={s.photoModalInner} onClick={e => e.stopPropagation()}>
        <button className={s.photoModalClose} onClick={onClose}>×</button>
        {multi && <button className={`${s.photoNav} ${s.photoNavPrev}`} onClick={onPrev}>&#10094;</button>}
        <img src={urls[idx]} alt="Фото" />
        {multi && <button className={`${s.photoNav} ${s.photoNavNext}`} onClick={onNext}>&#10095;</button>}
        {multi && <div className={s.photoCounter}>{idx + 1} / {urls.length}</div>}
      </div>
    </div>
  )
}

// ─── Edit modal ───────────────────────────────────────────────────────────────

function EditModal({ complaint, onClose, onSaved }) {
  const [company, setCompany] = useState(complaint.company || '')
  const [violator, setViolator] = useState(complaint.violator || '')
  const [taskArea, setTaskArea] = useState(complaint.taskArea === 'kdk' ? 'kdk' : 'storage')
  const [cell, setCell] = useState(complaint.cell || '')
  const [barcode, setBarcode] = useState(complaint.barcode || '')
  const [nomenclatureCode, setNomenclatureCode] = useState(complaint.nomenclatureCode || '')
  const [productName, setProductName] = useState(complaint.productName || '')
  const [productBarcode, setProductBarcode] = useState(complaint.productBarcode || '')
  const [handlingUnitBarcode, setHandlingUnitBarcode] = useState(complaint.handlingUnitBarcode || '')
  const [companies, setCompanies] = useState([])
  const [employees, setEmployees] = useState([])

  useEffect(() => {
    api.getEmployees()
      .then(data => {
        setCompanies(data.companies || [])
        setEmployees(data.employees || [])
      })
      .catch(() => {})
  }, [])

  const employeesForCompany = employees.filter(e => e.company === company)

  const handleSave = async () => {
    if (!company) { alert('Выберите компанию'); return }
    if (!violator) { alert('Выберите сотрудника (нарушителя)'); return }
    const payload = {
      company, violator,
      taskArea: taskArea === 'kdk' || taskArea === 'storage' ? taskArea : undefined,
      cell: cell.trim() || undefined,
      barcode: barcode.trim() || undefined,
      nomenclatureCode: nomenclatureCode.trim() || undefined,
      productName: productName.trim() || undefined,
      productBarcode: productBarcode.trim() || undefined,
      handlingUnitBarcode: handlingUnitBarcode.trim() || undefined,
      lookupDone: true, lookupError: null,
    }
    try {
      await api.saveComplaintLookup(complaint.id, payload)
      onSaved()
    } catch (err) {
      alert('Ошибка сохранения: ' + (err.message || 'Попробуйте снова'))
    }
  }

  return (
    <div className={s.editModalOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={s.editModalInner}>
        <div className={s.editHeader}>
          <h3>Редактировать жалобу</h3>
          <button className={s.editClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
        </div>

        <div className={s.editStep}>
          <label className={s.editLabel}>Компания</label>
          <select className="form-control" value={company}
            onChange={e => { setCompany(e.target.value); setViolator('') }}>
            <option value="">— Выберите компанию —</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className={s.editStep}>
          <label className={s.editLabel}>Сотрудник (нарушитель)</label>
          <select className="form-control" value={violator} onChange={e => setViolator(e.target.value)}>
            <option value="">— Выберите сотрудника —</option>
            {employeesForCompany.map(e => <option key={e.fio} value={e.fio}>{e.fio}</option>)}
          </select>
        </div>

        <div className={`${s.editStep}`}>
          <label className={s.editLabel}>Поля</label>
          <div className={s.editGrid}>
            <div className={s.editField}>
              <label>Где выполнял задачу</label>
              <select className="form-control" value={taskArea} onChange={e => setTaskArea(e.target.value)}>
                <option value="storage">В хранении</option>
                <option value="kdk">В КДК</option>
              </select>
            </div>
            <div className={s.editField}>
              <label>Место</label>
              <input type="text" className="form-control" value={cell} onChange={e => setCell(e.target.value)} placeholder="KDH-4-44" />
            </div>
            <div className={s.editField}>
              <label>Штрихкод / ЕО</label>
              <input type="text" className="form-control" value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="Штрихкод" />
            </div>
            <div className={s.editField}>
              <label>Артикул</label>
              <input type="text" className="form-control" value={nomenclatureCode} onChange={e => setNomenclatureCode(e.target.value)} placeholder="УТ-00000000" />
            </div>
            <div className={`${s.editField} ${s.editFieldWide}`}>
              <label>Товар</label>
              <input type="text" className="form-control" value={productName} onChange={e => setProductName(e.target.value)} placeholder="Название товара" />
            </div>
            <div className={s.editField}>
              <label>ШК товара</label>
              <input type="text" className="form-control" value={productBarcode} onChange={e => setProductBarcode(e.target.value)} placeholder="4600..." />
            </div>
            <div className={s.editField}>
              <label>ЕО</label>
              <input type="text" className="form-control" value={handlingUnitBarcode} onChange={e => setHandlingUnitBarcode(e.target.value)} placeholder="0122..." />
            </div>
          </div>
        </div>

        <div className={s.editActions}>
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}

// ─── Complaint row ────────────────────────────────────────────────────────────

function ComplaintRow({ complaint: c, selected, onToggle, onLookup, onEdit, onPhotoOpen }) {
  const photos = getComplaintPhotos(c)
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr className={s.complaintRow} onClick={() => photos.length > 0 && setExpanded(p => !p)} style={{ cursor: photos.length > 0 ? 'pointer' : 'default' }}>
        <td onClick={e => e.stopPropagation()}><input type="checkbox" checked={selected} onChange={onToggle} /></td>
        <td className={s.tdDate}>{formatDateTime(c.createdAt)}</td>
        <td>{c.employeeName || '—'}</td>
        <td className={s.tdCell}>{c.cell}</td>
        <td className={s.tdBarcode}>{c.barcode}</td>
        <td>{c.nomenclatureCode || '—'}</td>
        <td>{c.productName || '—'}</td>
        <td>
          {c.violator || '—'}
          {!c.lookupDone && c.lookupError && (
            <span className={s.lookupErr} title={c.lookupError}>!</span>
          )}
        </td>
        <td>{c.company || '—'}</td>
        <td className={s.tdDate}>{formatDateTime(c.operationCompletedAt)}</td>
        <td>
          <div className={s.actionsCol} onClick={e => e.stopPropagation()}>
            <button className={`btn btn-sm ${s.btnLookup}`} title="Поиск в WMS" onClick={() => onLookup(c)}><Search size={13} strokeWidth={2}/></button>
            <button className={`btn btn-sm ${s.btnEdit}`} title="Редактировать" onClick={() => onEdit(c)}><Pencil size={13} strokeWidth={2}/></button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className={s.photoDetailRow}>
          <td colSpan={12} className={s.photoDetailCell}>
            <div className={s.photoDetailInner}>
              {photos.map((url, i) => (
                <img
                  key={i}
                  src={photoUrl(url)}
                  alt={`Фото ${i + 1}`}
                  className={s.photoDetailThumb}
                  loading="lazy"
                  onClick={() => onPhotoOpen(photos.map(n => photoUrl(n)), i)}
                />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ConsolidationPage() {
  const [complaints, setComplaints] = useState([])
  const [violatorFilter, setViolatorFilter] = useState('all')
  const [selected, setSelected] = useState(new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [lookupAllText, setLookupAllText] = useState(null)
  const [supervisor, setSupervisor] = useState(() => {
    const list = getSupervisors()
    return list[0] || ''
  })
  const [loaded, setLoaded] = useState(false)
  const [photoModal, setPhotoModal] = useState({ open: false, urls: [], idx: 0 })
  const [editModal, setEditModal] = useState({ open: false, complaint: null })
  const lookingUpRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const list = await api.getConsolidationComplaints()
      setComplaints(list)
      setLoaded(true)
      setSelected(prev => {
        const validIds = new Set(list.map(c => String(c.id)))
        return new Set([...prev].filter(id => validIds.has(id)))
      })
    } catch (err) {
      console.error('loadComplaints', err)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ─── Derived ──────────────────────────────────────────────────────────────
  const filtered = violatorFilter === 'all'
    ? complaints
    : violatorFilter === 'found'
      ? complaints.filter(c => c.violator)
      : complaints.filter(c => !c.violator)
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
  const countFound = complaints.filter(c => c.violator).length
  const countNotFound = complaints.filter(c => !c.violator).length

  const getSelected = () => complaints.filter(c => selected.has(String(c.id)))

  // ─── Handlers ─────────────────────────────────────────────────────────────
  const toggleOne = id => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(String(id))) next.delete(String(id)); else next.add(String(id))
    return next
  })

  const toggleAll = () => {
    const pageIds = pageItems.map(c => String(c.id))
    const allChecked = pageIds.every(id => selected.has(id))
    setSelected(prev => {
      const next = new Set(prev)
      if (allChecked) pageIds.forEach(id => next.delete(id))
      else pageIds.forEach(id => next.add(id))
      return next
    })
  }

  const handleDelete = async id => {
    if (!confirm('Удалить жалобу?')) return
    try { await api.deleteComplaint(id); await load() }
    catch (err) { console.error('deleteComplaint', err) }
  }

  const handleLookupOne = async c => {
    const token = getStoredToken()
    if (!token) { alert('Войдите в WMS для поиска'); return }
    try {
      const result = await lookupViaBrowser(token, c.barcode, c.cell)
      await api.saveComplaintLookup(c.id, result)
      await load()
    } catch (err) {
      await api.saveComplaintLookup(c.id, { lookupDone: false, lookupError: err.message || 'Ошибка WMS' })
      await load()
    }
  }

  const handleLookupAll = async () => {
    if (lookingUpRef.current) return
    const token = getStoredToken()
    if (!token) { alert('Войдите в WMS для поиска'); return }
    let needLookup = complaints.filter(c => !c.lookupDone)
    if (needLookup.length === 0) {
      if (!confirm('Все жалобы уже проверены. Проверить заново?')) return
      needLookup = [...complaints]
    }
    lookingUpRef.current = true
    const total = needLookup.length
    for (let i = 0; i < total; i++) {
      const c = needLookup[i]
      setLookupAllText(`${i + 1}/${total}...`)
      try {
        const result = await lookupViaBrowser(token, c.barcode, c.cell)
        await api.saveComplaintLookup(c.id, result)
      } catch (err) {
        await api.saveComplaintLookup(c.id, { lookupDone: false, lookupError: err.message || 'Ошибка WMS' })
      }
    }
    lookingUpRef.current = false
    setLookupAllText(null)
    await load()
  }

  const handleBulkLookup = async () => {
    const sel = getSelected()
    if (sel.length === 0) { alert('Отметьте жалобы галочкой'); return }
    const token = getStoredToken()
    if (!token) { alert('Войдите в WMS для поиска'); return }
    let ok = 0, fail = 0
    for (const c of sel) {
      try {
        const result = await lookupViaBrowser(token, c.barcode, c.cell)
        await api.saveComplaintLookup(c.id, result); ok++
      } catch (err) {
        await api.saveComplaintLookup(c.id, { lookupDone: false, lookupError: err.message || 'Ошибка WMS' }); fail++
      }
    }
    if (fail > 0) alert(`Проверено: ${ok}, с ошибкой: ${fail}`)
    await load()
  }

  const handleBulkDelete = async () => {
    const sel = getSelected()
    if (sel.length === 0) { alert('Отметьте жалобы галочкой'); return }
    if (!confirm(`Удалить выбранные жалобы (${sel.length})?`)) return
    const results = await Promise.allSettled(sel.map(c => api.deleteComplaint(c.id)))
    const fail = results.filter(r => r.status === 'rejected').length
    if (fail > 0) alert(`Удалено: ${results.length - fail}, с ошибкой: ${fail}`)
    await load()
  }

  const handleSendTelegram = async () => {
    const sel = getSelected()
    if (sel.length === 0) { alert('Отметьте жалобы галочкой'); return }
    try {
      const res = await api.sendComplaintsToTelegram(sel.map(c => String(c.id)))
      if (!res?.ok) {
        const msg = res?.failed?.[0]?.error || res?.error || 'Ошибка отправки в Telegram'
        alert(msg); return
      }
      const { sentCount = 0, failedCount = 0, failed = [] } = res
      if (failedCount > 0) {
        const errs = failed.slice(0, 3).map(x => x?.error).filter(Boolean).join('\n')
        alert(`Отправлено: ${sentCount}, с ошибкой: ${failedCount}${errs ? `\n\n${errs}` : ''}`)
      } else {
        alert(`Отправлено в Telegram: ${sentCount}`)
      }
    } catch (err) { alert('Ошибка отправки: ' + err.message) }
  }

  const handlePrintSz = () => printServiceNotes(getSelected(), supervisor)

  const openPhotoModal = (urls, idx) => setPhotoModal({ open: true, urls, idx })
  const closePhotoModal = () => setPhotoModal(p => ({ ...p, open: false }))
  const prevPhoto = () => setPhotoModal(p => ({ ...p, idx: (p.idx - 1 + p.urls.length) % p.urls.length }))
  const nextPhoto = () => setPhotoModal(p => ({ ...p, idx: (p.idx + 1) % p.urls.length }))

  const supervisorOptions = getSupervisors()
  const allPageChecked = pageItems.length > 0 && pageItems.every(c => selected.has(String(c.id)))

  return (
    <div style={{ padding: 24 }}>
      {/* Toolbar */}
      <div className={s.toolbarWrap}>
        {/* Строка 1: основные действия */}
        <div className={s.toolbarRow}>
          <div className={s.toolbarLeft}>
            <button className="btn btn-primary btn-sm" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={load}>
              <RefreshCw size={14} strokeWidth={2}/>Обновить
            </button>
            <button className="btn btn-secondary btn-sm" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={handleLookupAll} disabled={!!lookupAllText}>
              <Search size={14} strokeWidth={2}/>{lookupAllText ? `Проверка ${lookupAllText}` : 'Проверить все'}
            </button>
            <button className="btn btn-secondary btn-sm" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={handleSendTelegram}>
              <Send size={14} strokeWidth={2}/>В Telegram
            </button>
            <button className="btn btn-secondary btn-sm" style={{display:'inline-flex',alignItems:'center',gap:6}} onClick={handlePrintSz}>
              <Printer size={14} strokeWidth={2}/>Создать СЗ
            </button>
          </div>
          <div className={s.toolbarRight}>
            <span className={s.szSupervisorLabel}>Начальник смены:</span>
            <select className={s.statusSelect} value={supervisor} onChange={e => setSupervisor(e.target.value)}>
              <option value="">— Выберите —</option>
              {supervisorOptions.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        {/* Строка 2: групповые действия + счётчики + фильтры */}
        <div className={s.toolbarRow}>
          <div className={s.toolbarLeft}>
            <button className="btn btn-secondary btn-sm" onClick={handleBulkLookup}>Проверить выбранные</button>
            <button className="btn btn-danger btn-sm" onClick={handleBulkDelete}>Удалить выбранные</button>
            <div className={s.toolbarSep}/>
            <div className={s.counters}>
              <span>Всего: <b>{complaints.length}</b></span>
              <span>Найдено: <b>{countFound}</b></span>
              <span>Не найдено: <b>{countNotFound}</b></span>
              <span>Выбрано: <b>{selected.size}</b></span>
            </div>
          </div>
          <div className={s.filters}>
            {[
              { val: 'all',       label: 'Все' },
              { val: 'found',     label: 'Нарушитель найден' },
              { val: 'not_found', label: 'Не найден' },
            ].map(({ val, label }) => (
              <button
                key={val}
                className={`${s.filterChip}${violatorFilter === val ? ` ${s.filterChipActive}` : ''}`}
                onClick={() => { setViolatorFilter(val); setPage(1) }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Card */}
      <div className="card" style={{ overflow: 'visible' }}>
        <div className="card-header">
          <span>Жалобы на нарушения</span>
          <a href="/consolidation-form" target="_blank" style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'underline' }}>
            Форма для сотрудников
          </a>
        </div>

        {/* Pagination bar */}
        {filtered.length > 0 && (
          <div className={s.paginationBar}>
            <div className={s.paginationLeft}>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Показывать:</span>
              <select className={s.statusSelect} value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}>
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                Стр. {safePage}/{totalPages} • {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} из {filtered.length}
              </span>
            </div>
            <div className={s.paginationRight}>
              <button className="btn btn-secondary" style={{ padding: '6px 10px' }}
                disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}>←</button>
              <button className="btn btn-secondary" style={{ padding: '6px 10px' }}
                disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}>→</button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className={s.tableScroll}>
          {filtered.length === 0 ? (
            <div className={s.empty}>
              {!loaded ? 'Нажмите «Обновить» для загрузки' : 'Нет жалоб'}
            </div>
          ) : (
            <table className={s.table}>
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" checked={allPageChecked} onChange={toggleAll}
                      title="Выбрать все на странице" />
                  </th>
                  <th>Дата</th>
                  <th>Кто подал</th>
                  <th>Место</th>
                  <th>Штрихкод</th>
                  <th>Артикул</th>
                  <th>Товар</th>
                  <th>Нарушитель</th>
                  <th>Компания</th>
                  <th>Время нарушения</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map(c => (
                  <ComplaintRow
                    key={c.id}
                    complaint={c}
                    selected={selected.has(String(c.id))}
                    onToggle={() => toggleOne(c.id)}
                    onLookup={handleLookupOne}
                    onEdit={complaint => setEditModal({ open: true, complaint })}

                    onPhotoOpen={openPhotoModal}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Photo modal */}
      {photoModal.open && (
        <PhotoModal
          urls={photoModal.urls}
          idx={photoModal.idx}
          onClose={closePhotoModal}
          onPrev={prevPhoto}
          onNext={nextPhoto}
        />
      )}

      {/* Edit modal */}
      {editModal.open && editModal.complaint && (
        <EditModal
          complaint={editModal.complaint}
          onClose={() => setEditModal({ open: false, complaint: null })}
          onSaved={async () => { setEditModal({ open: false, complaint: null }); await load() }}
        />
      )}
    </div>
  )
}
