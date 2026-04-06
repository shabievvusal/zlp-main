import { useState, useCallback } from 'react'
import { Settings2 } from 'lucide-react'
import s from './DocsPage.module.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY_SUPERVISORS = 'memos_supervisors'

const DI = {
  receiving: {
    label: 'Кладовщик (участок приема)',
    duty: 'раздел 3 ДИ, п. 3.1.1 (приемка ТМЦ, работа в ТСД/учетных системах, контроль корректности операций), раздел 3.1.3 (отчетность)',
    resp: 'раздел 5 ДИ (ответственность за ненадлежащее исполнение обязанностей, последствия ошибок, материальный ущерб)',
  },
  placement: {
    label: 'Кладовщик (участок размещения)',
    duty: 'раздел 3 ДИ, п. 3.1.1 (размещение ТМЦ, работа в ТСД/учетных системах, корректное оформление операций), раздел 3.1.3 (отчетность)',
    resp: 'раздел 5 ДИ (персональная ответственность за последствия решений и ошибок в операциях)',
  },
  forklift: {
    label: 'Водитель погрузчика (участок размещения)',
    duty: 'раздел 3 ДИ, п. 3.1.1 и 3.1.2 (выполнение работ ПРТ и погрузо-разгрузочных операций по установленным правилам)',
    resp: 'раздел 5 ДИ (ответственность за нарушения требований, причиненный ущерб и последствия решений)',
  },
}

const TC_RECIPIENT = 'Геращенко И.С.'
const TC_ORG = 'СТПС ООО «СберЛогистика»'

const TC_COMPANY_NAMES = {
  'два колеса': 'ООО "Два Колеса"',
  '2 колеса': 'ООО "Два Колеса"',
  'ооо "два колеса"': 'ООО "Два Колеса"',
  'мувинг': 'ООО "Мувинговая компания"',
  'мувинговая': 'ООО "Мувинговая компания"',
  'мувинговая компания': 'ООО "Мувинговая компания"',
  'ооо "мувинговая компания"': 'ООО "Мувинговая компания"',
  'градус': 'ООО "Градус"',
  'ооо "градус"': 'ООО "Градус"',
  'эни ком сервис': 'ООО "Эни Ком Сервис"',
  'эни сервис ком': 'ООО "Эни Ком Сервис"',
  'эск': 'ООО "Эни Ком Сервис"',
  'ооо "эни ком сервис"': 'ООО "Эни Ком Сервис"',
}

const DOC_KIND_LABEL = {
  bidu: 'Служебная (BIDU)',
  surplus: 'Служебная (Излишки)',
  tc: 'Служебная ТС',
  exp: 'Объяснительная',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtDate(v) {
  if (!v) return '___ . ___ . ______'
  const [y, m, d] = v.split('-')
  return `${d}.${m}.${y}`
}

function nonEmpty(v, fallback) {
  return (v || '').trim() || fallback
}

function ruPlural(n, one, few, many) {
  const num = Math.abs(Number(n))
  if (!Number.isFinite(num)) return many
  const mod10 = num % 10, mod100 = num % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function qtyWithWord(raw, one, few, many) {
  const text = String(raw || '').trim().replace(',', '.')
  if (!text) return '________________'
  const n = Number(text)
  if (!Number.isFinite(n)) return text
  return `${text} ${ruPlural(n, one, few, many)}`
}

function formatCompanyForSz(raw) {
  if (!raw || !String(raw).trim()) return '________________'
  const key = String(raw).trim().toLowerCase()
  return TC_COMPANY_NAMES[key] || (key.startsWith('ооо "') ? raw.trim() : `ООО "${raw.trim()}"`)
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getSupervisors() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_SUPERVISORS) || '[]') } catch { return [] }
}

function saveSupervisors(arr) {
  localStorage.setItem(STORAGE_KEY_SUPERVISORS, JSON.stringify(arr))
}

// ─── Document builders ────────────────────────────────────────────────────────

function buildBidu(f) {
  const r = DI[f.role]
  return [
    'СЛУЖЕБНАЯ ЗАПИСКА',
    'О выявленных нарушениях в процессе работы',
    '',
    `Настоящим сообщаю, что ${fmtDate(f.date)} у сотрудника ${nonEmpty(f.fioGen, nonEmpty(f.fio, '________________'))} выявлено нарушение:`,
    'некорректное применение кода BIDU.',
    '',
    `Товар: ${nonEmpty(f.product, '________________')}`,
    `Артикул: ${nonEmpty(f.article, '________________')}`,
    `Количество: ${qtyWithWord(f.quantity, 'единица', 'единицы', 'единиц')}`,
    `ЕО: ${nonEmpty(f.eo, '________________')}`,
    '',
    'Обоснование (ДИ):',
    `1. Нарушены обязанности: ${r.duty}.`,
    `2. Подлежит оценке ответственность: ${r.resp}.`,
    '',
    'Прошу:',
    '1. Запросить письменную объяснительную у сотрудника.',
    '2. Провести служебную проверку обстоятельств.',
    '3. Принять решение о мерах воздействия в соответствии с локальными актами и ТК РФ.',
    '',
    `Составил: ${nonEmpty(f.author, '________________')}`,
    `Должность: ${nonEmpty(f.authorRole, '________________')}`,
    'Подпись: __________________',
  ].join('\n')
}

function buildSurplus(f) {
  const r = DI[f.role]
  return [
    'СЛУЖЕБНАЯ ЗАПИСКА',
    'О выявленных нарушениях в процессе работы',
    '',
    `Настоящим сообщаю, что ${fmtDate(f.date)} у сотрудника ${nonEmpty(f.fioGen, nonEmpty(f.fio, '________________'))} выявлено нарушение формирования отправления:`,
    'обнаружен излишек ТМЦ.',
    '',
    `Товар: ${nonEmpty(f.product, '________________')}`,
    `Артикул: ${nonEmpty(f.article, '________________')}`,
    `Излишек в количестве: ${qtyWithWord(f.quantity, 'единица', 'единицы', 'единиц')}`,
    `ЕО: ${nonEmpty(f.eo, '________________')}`,
    '',
    'Обоснование (ДИ):',
    `1. Нарушены обязанности: ${r.duty}.`,
    `2. Подлежит оценке ответственность: ${r.resp}, при наличии ущерба — с учетом ст. 243 ТК РФ.`,
    '',
    'Прошу:',
    '1. Запросить письменную объяснительную у сотрудника.',
    '2. Провести служебную проверку причин возникновения излишка.',
    '3. Принять корректирующие меры для исключения повторения.',
    '',
    `Составил: ${nonEmpty(f.author, '________________')}`,
    `Должность: ${nonEmpty(f.authorRole, '________________')}`,
    'Подпись: __________________',
  ].join('\n')
}

function buildExp(f) {
  const r = DI[f.role]
  const measures = (f.expMeasures || '').split('\n').map(s => s.trim()).filter(Boolean)
  const measuresBlock = measures.length
    ? measures.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : '1. Усилить самоконтроль при выполнении операций.\n2. Проводить двойную сверку по ТСД.'
  return [
    'ОБЪЯСНИТЕЛЬНАЯ ЗАПИСКА',
    '',
    `Я, ${nonEmpty(f.fio, '________________')}, должность «${r.label}», по факту нарушения от ${fmtDate(f.date)} сообщаю следующее:`,
    '',
    `В ходе операции «${nonEmpty(f.expOp, '________________')}» по товару «${nonEmpty(f.product, '________________')}» (артикул ${nonEmpty(f.article, '________________')}, ЕО ${nonEmpty(f.eo, '________________')}) мной была допущена ошибка:`,
    `${nonEmpty(f.expIssue, '________________')}`,
    '',
    'Причины:',
    `1. ${nonEmpty(f.expReason1, '________________')}`,
    `2. ${nonEmpty(f.expReason2, '________________')}`,
    '',
    'Признаю, что нарушение относится к требованиям должностной инструкции:',
    `1. ${r.duty}.`,
    `2. ${r.resp}.`,
    '',
    'Для недопущения повторения обязуюсь:',
    measuresBlock,
    '',
    `Дата: ${fmtDate(f.date)}`,
    `Подпись: __________________ / ${nonEmpty(f.fio, '________________')}`,
  ].join('\n')
}

function buildTcText(f) {
  const dateInc = f.tcDateIncident || f.date
  const dateMemo = f.tcDateMemo || f.date
  const company = formatCompanyForSz(f.tcCompany || '')
  const violator = nonEmpty(f.tcViolator, '________________')
  const product = nonEmpty(f.tcProduct, '________________')
  const article = nonEmpty(f.tcArticle, '________________')
  const quantity = nonEmpty(f.tcQuantity, '1')
  const place = nonEmpty(f.tcPlace, '________________')
  const eo = nonEmpty(f.tcEo, '________________')
  const timeStr = nonEmpty(f.tcTime, '')
  const dateTimeStr = timeStr ? `${fmtDate(dateInc)} ${timeStr}` : fmtDate(dateInc)
  const brigadierRaw = f.tcBrigadier ? f.tcBrigadier.trim() : f.tcCompany
  const brigadierCompany = formatCompanyForSz(brigadierRaw || f.tcCompany || '')
  const brigadier = brigadierCompany !== '________________' ? `Бригадир ${brigadierCompany}` : '________________'
  const sender = nonEmpty(f.author, '________________')
  const senderRole = nonEmpty(f.authorRole, 'Начальник смены')
  const utLine = article !== '________________' ? article : '________________'
  return [
    `Начальнику склада\n${TC_ORG}\n${TC_RECIPIENT}\nОт ${senderRole}\n${sender}`,
    '',
    'СЛУЖЕБНАЯ ЗАПИСКА',
    'О выявленных нарушениях в процессе работы',
    '',
    `Настоящим сообщаю, что ${fmtDate(dateInc)}, со стороны сотрудника ${company} были выявлены следующие нарушения:`,
    '',
    `За сотрудником ${violator}`,
    'выявлено нарушение по п.1 приложения №4 от 01.01.2025, а именно нарушение формирования отправления товара:',
    `«${product}»`,
    utLine,
    `в количестве: ${quantity} шт`,
    `Место: ${place}`,
    `EO: ${eo}`,
    `Время: ${dateTimeStr}`,
    '',
    senderRole,
    `Подпись: __________________  ФИО: ${sender}`,
    `Дата: ${fmtDate(dateMemo)}`,
    'Подпись: __________________',
    '',
    'Со служебной запиской ознакомлен',
    'Нарушения подтверждаю',
    brigadier,
    'Подпись: __________________  ФИО: __________________',
  ].join('\n')
}

function buildTcHtml(f) {
  const dateInc = f.tcDateIncident || f.date
  const dateMemo = f.tcDateMemo || f.date
  const company = formatCompanyForSz(f.tcCompany || '')
  const violator = nonEmpty(f.tcViolator, '________________')
  const product = nonEmpty(f.tcProduct, '________________')
  const article = nonEmpty(f.tcArticle, '________________')
  const quantity = nonEmpty(f.tcQuantity, '1')
  const place = nonEmpty(f.tcPlace, '________________')
  const eo = nonEmpty(f.tcEo, '________________')
  const timeStr = nonEmpty(f.tcTime, '')
  const dateTimeStr = timeStr ? `${fmtDate(dateInc)} ${timeStr}` : fmtDate(dateInc)
  const sender = nonEmpty(f.author, '________________')
  const senderRole = nonEmpty(f.authorRole, 'Начальник смены')
  const utDisplay = article !== '________________' ? article : '—'
  const parts = []
  parts.push(`<div class="doc-right"><p>${esc('Начальнику склада')}</p><p>${esc(TC_ORG)}</p><p>${esc(TC_RECIPIENT)}</p><p>${esc('От ' + senderRole)}</p><p>${esc(sender)}</p></div>`)
  parts.push(`<div class="doc-center">СЛУЖЕБНАЯ ЗАПИСКА</div>`)
  parts.push(`<div class="doc-sub">О выявленных нарушениях в процессе работы</div>`)
  parts.push(`<p class="doc-p">Настоящим сообщаю, что <strong>${esc(fmtDate(dateInc))}</strong>, со стороны сотрудника ${esc(company)} были выявлены следующие нарушения:</p>`)
  parts.push(`<p class="doc-p no-indent">За сотрудником <strong>${esc(violator)}</strong></p>`)
  parts.push(`<p class="doc-p no-indent">выявлено нарушение по п.1 приложения №4 от 01.01.2025, а именно нарушение формирования отправления товара:</p>`)
  parts.push(`<p class="doc-p no-indent">«<strong>${esc(product)}</strong>»</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>${esc(utDisplay)}</strong></p>`)
  parts.push(`<p class="doc-p no-indent"><strong>в количестве:</strong> ${esc(quantity)} шт</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>Место:</strong> ${esc(place)}</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>EO:</strong> ${esc(eo)}</p>`)
  parts.push(`<p class="doc-p no-indent"><strong>Время:</strong> ${esc(dateTimeStr)}</p>`)
  parts.push(`<div class="doc-sign-row"><div class="doc-tc-sign"><p><strong>Начальник смены</strong></p><p>Подпись: __________________</p><p>ФИО: ${esc(sender)}</p><p>Дата: ${esc(fmtDate(dateMemo))}</p><p>Подпись: __________________</p></div><div class="doc-tc-ack"><p>Со служебной запиской ознакомлен</p><p>Нарушения подтверждаю</p><p><strong>Бригадир ${esc(company)}</strong></p><p>Подпись: __________________ &nbsp; ФИО: __________________</p></div></div>`)
  return parts.join('\n')
}

function renderPaper(text) {
  const lines = String(text || '').split('\n')
  const blocks = []
  let inList = false
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i < lines.length) blocks.push(`<div class="doc-center">${esc(lines[i])}</div>`)
  i++
  if (i < lines.length && lines[i].trim()) blocks.push(`<div class="doc-sub">${esc(lines[i])}</div>`)
  i++
  for (; i < lines.length; i++) {
    const ln = lines[i], t = ln.trim()
    if (!t) continue
    if (inList && !/^\d+\.\s+/.test(t)) { blocks.push('</ol>'); inList = false }
    if (t.startsWith('Дата:')) { blocks.push(`<div class="doc-date">${esc(t)}</div>`); continue }
    if (t === 'Прошу:' || t === 'Причины:' || t.startsWith('Обоснование')) { blocks.push(`<p class="doc-p no-indent"><b>${esc(t)}</b></p>`); continue }
    if (/^\d+\.\s+/.test(t)) {
      if (!inList) { blocks.push('<ol class="doc-list">'); inList = true }
      blocks.push(`<li>${esc(t.replace(/^\d+\.\s+/, ''))}</li>`)
      continue
    }
    if (t.startsWith('Составил:') || t.startsWith('Должность:') || t.startsWith('Подпись:')) { blocks.push(`<p class="doc-p no-indent doc-sign">${esc(t)}</p>`); continue }
    blocks.push(`<p class="doc-p">${esc(t)}</p>`)
  }
  if (inList) blocks.push('</ol>')
  return blocks.join('\n')
}

function buildOutput(kind, f) {
  if (kind === 'tc') return { html: buildTcHtml(f), text: buildTcText(f) }
  const text = kind === 'bidu' ? buildBidu(f) : kind === 'surplus' ? buildSurplus(f) : buildExp(f)
  return { html: renderPaper(text), text }
}

const DOC_PRINT_STYLES = `
  @page { size: A4; margin: 20mm; }
  body { font-family: "Times New Roman", serif; font-size: 12pt; line-height: 1.45; color: #000; margin: 0; }
  .doc-center { text-align: center; font-weight: 700; }
  .doc-sub    { text-align: center; margin-top: 4px; }
  .doc-date   { text-align: right; margin-top: 10px; margin-bottom: 14px; }
  .doc-p      { text-align: justify; text-indent: 1.25cm; margin: 0 0 8px 0; }
  .doc-p.no-indent { text-indent: 0; }
  .doc-list   { margin: 0 0 10px 0; padding-left: 20px; }
  .doc-list li{ margin-bottom: 4px; }
  .doc-sign   { margin-top: 18px; }
  .doc-right  { text-align: right; margin-bottom: 14px; }
  .doc-right p{ margin: 2px 0; }
  .doc-sign-row { display: flex; justify-content: space-between; margin-top: 18px; gap: 24px; }
  .doc-tc-sign  { flex: 1; }
  .doc-tc-sign p{ margin: 4px 0; }
  .doc-tc-ack   { flex: 1; text-align: right; max-width: 50%; }
  .doc-tc-ack p { margin: 2px 0; }
`

// ─── Main component ───────────────────────────────────────────────────────────

export default function DocsPage() {
  const today = todayStr()

  const [kind, setKind] = useState('bidu')
  const [showSettings, setShowSettings] = useState(false)
  const [supervisors, setSupervisors] = useState(() => getSupervisors())
  const [supervisorInput, setSupervisorInput] = useState('')
  const [copyLabel, setCopyLabel] = useState('Скопировать')

  // Common fields
  const [date, setDate]           = useState(today)
  const [role, setRole]           = useState('receiving')
  const [fio, setFio]             = useState('')
  const [fioGen, setFioGen]       = useState('')
  const [product, setProduct]     = useState('')
  const [article, setArticle]     = useState('')
  const [quantity, setQuantity]   = useState('')
  const [eo, setEo]               = useState('')
  const [authorSelect, setAuthorSelect] = useState('')
  const [author, setAuthor]       = useState('')
  const [authorRole, setAuthorRole] = useState('')

  // TC fields
  const [tcCompany, setTcCompany]         = useState('')
  const [tcViolator, setTcViolator]       = useState('')
  const [tcTaskArea, setTcTaskArea]       = useState('storage')
  const [tcProduct, setTcProduct]         = useState('')
  const [tcArticle, setTcArticle]         = useState('')
  const [tcQuantity, setTcQuantity]       = useState('')
  const [tcPlace, setTcPlace]             = useState('')
  const [tcEo, setTcEo]                   = useState('')
  const [tcTime, setTcTime]               = useState('')
  const [tcDateIncident, setTcDateIncident] = useState(today)
  const [tcDateMemo, setTcDateMemo]       = useState(today)
  const [tcBrigadier, setTcBrigadier]     = useState('')

  // Exp fields
  const [expOp, setExpOp]           = useState('')
  const [expIssue, setExpIssue]     = useState('')
  const [expReason1, setExpReason1] = useState('')
  const [expReason2, setExpReason2] = useState('')
  const [expMeasures, setExpMeasures] = useState('')

  const fields = {
    date, role, fio, fioGen, product, article, quantity, eo, author, authorRole,
    tcCompany, tcViolator, tcTaskArea, tcProduct, tcArticle, tcQuantity,
    tcPlace, tcEo, tcTime, tcDateIncident, tcDateMemo, tcBrigadier,
    expOp, expIssue, expReason1, expReason2, expMeasures,
  }

  const { html: outputHtml, text: outputText } = buildOutput(kind, fields)

  // ── Supervisors ──
  const addSupervisor = useCallback(() => {
    const name = supervisorInput.trim()
    if (!name) return
    const list = getSupervisors()
    if (list.includes(name)) return
    list.push(name)
    saveSupervisors(list)
    setSupervisors([...list])
    setSupervisorInput('')
  }, [supervisorInput])

  const removeSupervisor = useCallback((idx) => {
    const list = getSupervisors()
    list.splice(idx, 1)
    saveSupervisors(list)
    setSupervisors([...list])
  }, [])

  const handleAuthorSelect = (val) => {
    setAuthorSelect(val)
    if (val) { setAuthor(val); setAuthorRole('Начальник смены') }
  }

  // ── Actions ──
  const handleClear = () => {
    setFio(''); setFioGen(''); setProduct(''); setArticle(''); setQuantity(''); setEo('')
    setAuthorSelect(''); setAuthor(''); setAuthorRole('')
    setTcCompany(''); setTcViolator(''); setTcProduct(''); setTcArticle('')
    setTcQuantity(''); setTcPlace(''); setTcEo(''); setTcTime(''); setTcBrigadier('')
    setTcTaskArea('storage')
    setExpOp(''); setExpIssue(''); setExpReason1(''); setExpReason2(''); setExpMeasures('')
    const t = todayStr()
    setDate(t); setTcDateIncident(t); setTcDateMemo(t)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(outputText.trim()).then(() => {
      setCopyLabel('Скопировано')
      setTimeout(() => setCopyLabel('Скопировать'), 1200)
    })
  }

  const handlePrint = () => {
    const win = window.open('', '_blank', 'width=900,height=700')
    if (!win) return
    win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ</title><style>${DOC_PRINT_STYLES}</style></head><body>${outputHtml}</body></html>`)
    win.document.close()
    win.focus()
    win.print()
  }

  const handleDownload = () => {
    const htmlDoc = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Документ</title><style>${DOC_PRINT_STYLES}</style></head><body>${outputHtml}</body></html>`
    const blob = new Blob([htmlDoc], { type: 'application/msword' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `документ_${kind}_${date || 'без_даты'}.doc`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const isCommon = kind !== 'tc'
  const isExp    = kind === 'exp'
  const isTc     = kind === 'tc'

  return (
    <div className={s.shell}>
      <div className={s.head}>
        <div>
          <h1 className={s.headTitle}>Служебные записки и объяснительные</h1>
          <p className={s.headSub}>Шаблоны с привязкой к должностным инструкциям (разделы 3 и 5 ДИ)</p>
        </div>
        <div className={s.topActions}>
          <button className={s.btn} onClick={() => setShowSettings(v => !v)} style={{display:'inline-flex',alignItems:'center',gap:6}}><Settings2 size={14} strokeWidth={2}/>Настройки</button>
          <button className={s.btn} onClick={handleClear}>Очистить</button>
          <button className={`${s.btn} ${s.btnAlt}`} onClick={handleCopy}>{copyLabel}</button>
          <button className={s.btn} onClick={handlePrint}>Печать</button>
          <button className={`${s.btn} ${s.btnBrand}`} onClick={handleDownload}>Скачать Word (.doc)</button>
        </div>
      </div>

      <div className={s.grid}>
        {/* ── Left: form ── */}
        <section className={s.card}>
          <div className={s.cardHead}>
            <h2>Параметры документа</h2>
            <span>{DOC_KIND_LABEL[kind]}</span>
          </div>
          <div className={s.pad}>
            {/* Tabs */}
            <div className={s.tabs}>
              {['bidu', 'surplus', 'tc', 'exp'].map(k => (
                <button
                  key={k}
                  className={`${s.tab}${kind === k ? ' ' + s.tabActive : ''}`}
                  onClick={() => setKind(k)}
                >
                  {k === 'bidu' ? 'Служебная: BIDU' : k === 'surplus' ? 'Служебная: Излишки' : k === 'tc' ? 'Служебная ТС' : 'Объяснительная'}
                </button>
              ))}
            </div>

            {/* Date + Role */}
            <div className={`${s.row} ${s.rowTwo}`}>
              <div>
                <label className={s.formLabel}>Дата</label>
                <input className={s.input} type="date" value={date} onChange={e => setDate(e.target.value)} />
              </div>
              <div>
                <label className={s.formLabel}>Должность</label>
                <select className={s.select} value={role} onChange={e => setRole(e.target.value)}>
                  <option value="receiving">Кладовщик (участок приема)</option>
                  <option value="placement">Кладовщик (участок размещения)</option>
                  <option value="forklift">Водитель погрузчика (участок размещения)</option>
                </select>
              </div>
            </div>

            {/* Common fields */}
            {isCommon && (
              <>
                <div className={s.row}><div>
                  <label className={s.formLabel}>ФИО сотрудника</label>
                  <input className={s.input} type="text" placeholder="Иванов Иван Иванович" value={fio} onChange={e => setFio(e.target.value)} />
                </div></div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>ФИО в родительном падеже (опционально)</label>
                  <input className={s.input} type="text" placeholder="Иванова Ивана Ивановича" value={fioGen} onChange={e => setFioGen(e.target.value)} />
                </div></div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Наименование товара</label>
                  <input className={s.input} type="text" placeholder="Товар" value={product} onChange={e => setProduct(e.target.value)} />
                </div></div>
                <div className={`${s.row} ${s.rowTwo}`}>
                  <div>
                    <label className={s.formLabel}>Артикул</label>
                    <input className={s.input} type="text" placeholder="УТ-00000000" value={article} onChange={e => setArticle(e.target.value)} />
                  </div>
                  <div>
                    <label className={s.formLabel}>Количество</label>
                    <input className={s.input} type="text" placeholder="1" value={quantity} onChange={e => setQuantity(e.target.value)} />
                  </div>
                </div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>ЕО</label>
                  <input className={s.input} type="text" placeholder="323100000000" value={eo} onChange={e => setEo(e.target.value)} />
                </div></div>
              </>
            )}

            {/* TC fields */}
            {isTc && (
              <>
                <div className={s.note}>Служебная записка о некорректной комплектации (по образцу ТС).</div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Компания сотрудников</label>
                  <input className={s.input} type="text" placeholder='ООО «2 Колеса»' value={tcCompany} onChange={e => setTcCompany(e.target.value)} />
                </div></div>
                <div className={`${s.row} ${s.rowTwo}`}>
                  <div>
                    <label className={s.formLabel}>ФИО нарушителя</label>
                    <input className={s.input} type="text" placeholder="Ходжамуродов Абдулло Зиёвиддинович" value={tcViolator} onChange={e => setTcViolator(e.target.value)} />
                  </div>
                  <div>
                    <label className={s.formLabel}>Где выполнял задачу</label>
                    <select className={s.select} value={tcTaskArea} onChange={e => setTcTaskArea(e.target.value)}>
                      <option value="storage">В хранении</option>
                      <option value="kdk">В КДК</option>
                    </select>
                  </div>
                </div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Наименование товара</label>
                  <input className={s.input} type="text" placeholder="Суп-пюре..." value={tcProduct} onChange={e => setTcProduct(e.target.value)} />
                </div></div>
                <div className={`${s.row} ${s.rowTwo}`}>
                  <div>
                    <label className={s.formLabel}>УТ (артикул)</label>
                    <input className={s.input} type="text" placeholder="УТ-00201035" value={tcArticle} onChange={e => setTcArticle(e.target.value)} />
                  </div>
                  <div>
                    <label className={s.formLabel}>Количество, шт</label>
                    <input className={s.input} type="text" placeholder="8" value={tcQuantity} onChange={e => setTcQuantity(e.target.value)} />
                  </div>
                </div>
                <div className={`${s.row} ${s.rowTwo}`}>
                  <div>
                    <label className={s.formLabel}>Место</label>
                    <input className={s.input} type="text" placeholder="Ячейка / адрес" value={tcPlace} onChange={e => setTcPlace(e.target.value)} />
                  </div>
                  <div>
                    <label className={s.formLabel}>ЕО</label>
                    <input className={s.input} type="text" placeholder="01220014-2109" value={tcEo} onChange={e => setTcEo(e.target.value)} />
                  </div>
                </div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Время (опционально)</label>
                  <input className={s.input} type="text" placeholder="14:30" value={tcTime} onChange={e => setTcTime(e.target.value)} />
                </div></div>
                <div className={`${s.row} ${s.rowTwo}`}>
                  <div>
                    <label className={s.formLabel}>Дата нарушения</label>
                    <input className={s.input} type="date" value={tcDateIncident} onChange={e => setTcDateIncident(e.target.value)} />
                  </div>
                  <div>
                    <label className={s.formLabel}>Дата служебной записки</label>
                    <input className={s.input} type="date" value={tcDateMemo} onChange={e => setTcDateMemo(e.target.value)} />
                  </div>
                </div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Бригадир (для блока ознакомления)</label>
                  <input className={s.input} type="text" placeholder='Бригадир ООО «2 Колеса»' value={tcBrigadier} onChange={e => setTcBrigadier(e.target.value)} />
                </div></div>
              </>
            )}

            {/* Exp fields */}
            {isExp && (
              <>
                <div className={s.note}>Объяснительная заполняется от лица сотрудника.</div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Операция/этап</label>
                  <input className={s.input} type="text" placeholder="Приемка/размещение/сборка отправления" value={expOp} onChange={e => setExpOp(e.target.value)} />
                </div></div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Суть ошибки</label>
                  <textarea className={s.textarea} placeholder="Кратко опишите, что было сделано неверно" value={expIssue} onChange={e => setExpIssue(e.target.value)} />
                </div></div>
                <div className={`${s.row} ${s.rowTwo}`}>
                  <div>
                    <label className={s.formLabel}>Причина 1</label>
                    <input className={s.input} type="text" placeholder="Невнимательность при сканировании" value={expReason1} onChange={e => setExpReason1(e.target.value)} />
                  </div>
                  <div>
                    <label className={s.formLabel}>Причина 2</label>
                    <input className={s.input} type="text" placeholder="Высокая нагрузка в смене" value={expReason2} onChange={e => setExpReason2(e.target.value)} />
                  </div>
                </div>
                <div className={s.row}><div>
                  <label className={s.formLabel}>Меры недопущения (по одной строке)</label>
                  <textarea className={s.textarea} placeholder={'Проверка ЕО перед подтверждением\nПовторная сверка по ТСД'} value={expMeasures} onChange={e => setExpMeasures(e.target.value)} />
                </div></div>
              </>
            )}

            {/* Author */}
            <div className={s.row}><div>
              <label className={s.formLabel}>Начальник смены (составил)</label>
              <select className={s.select} value={authorSelect} onChange={e => handleAuthorSelect(e.target.value)}>
                <option value="">— Выберите или введите ниже —</option>
                {supervisors.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </div></div>
            <div className={`${s.row} ${s.rowTwo}`}>
              <div>
                <label className={s.formLabel}>ФИО составителя</label>
                <input className={s.input} type="text" placeholder="Петров П.П." value={author} onChange={e => setAuthor(e.target.value)} />
              </div>
              <div>
                <label className={s.formLabel}>Должность составителя</label>
                <input className={s.input} type="text" placeholder="Начальник смены" value={authorRole} onChange={e => setAuthorRole(e.target.value)} />
              </div>
            </div>

            {/* Settings panel */}
            {showSettings && (
              <div className={s.settingsPanel}>
                <h3 className={s.settingsTitle}>Начальники смен</h3>
                <p className={s.settingsDesc}>Добавьте ФИО — они появятся в списке выбора выше, чтобы не вводить каждый раз.</p>
                <ul className={s.supervisorsList}>
                  {supervisors.map((name, i) => (
                    <li key={i} className={s.supervisorItem}>
                      <span>{name}</span>
                      <button type="button" className={s.btnRemove} onClick={() => removeSupervisor(i)}>× Удалить</button>
                    </li>
                  ))}
                </ul>
                <div className={`${s.row} ${s.rowTwo}`}>
                  <div>
                    <label className={s.formLabel}>ФИО начальника смены</label>
                    <input
                      className={s.input}
                      type="text"
                      placeholder="Иванов И.И."
                      value={supervisorInput}
                      onChange={e => setSupervisorInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSupervisor() } }}
                    />
                  </div>
                  <div className={s.addBtnWrap}>
                    <label className={s.formLabel}>&nbsp;</label>
                    <button type="button" className={`${s.btn} ${s.btnBrand}`} onClick={addSupervisor}>Добавить</button>
                  </div>
                </div>
              </div>
            )}

            <button className={`${s.btn} ${s.btnBrand} ${s.btnFull}`} onClick={() => {}}>
              Сформировать документ
            </button>
          </div>
        </section>

        {/* ── Right: output ── */}
        <section className={s.card}>
          <div className={s.cardHead}>
            <h2>Результат</h2>
            <span className={s.cardHeadSub}>Готово к вставке в Word/почту</span>
          </div>
          <div className={s.pad}>
            <div className={s.paperWrap}>
              <div
                className={s.output}
                dangerouslySetInnerHTML={{ __html: outputHtml }}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
