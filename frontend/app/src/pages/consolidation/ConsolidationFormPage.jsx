import { useState, useRef } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { shortFio } from '../../utils/format.js'
import styles from './ConsolidationFormPage.module.css'

const STORAGE_KEY_ROW    = 'consolidation_cell_row'
const STORAGE_KEY_PREFIX = 'consolidation_storage_prefix'

export default function ConsolidationFormPage() {
  const { user } = useAuth()
  const name = user?.name ? shortFio(user.name) : ''
  const [prefix, setPrefix]   = useState(() => localStorage.getItem(STORAGE_KEY_PREFIX) || 'KDH')
  const [rowVal, setRowVal]   = useState(() => localStorage.getItem(STORAGE_KEY_ROW) || '')
  const [place, setPlace]     = useState('')
  const [barcode, setBarcode] = useState('')
  const [photos, setPhotos]   = useState(null)
  const [status, setStatus]   = useState(null) // { ok, text }
  const [busy, setBusy]       = useState(false)

  const cellPreview = prefix + (rowVal || place ? '-' + [rowVal, place].filter(Boolean).join('-') : '-')

  // focus-order refs for Enter navigation
  const rowRef     = useRef()
  const placeRef   = useRef()
  const barcodeRef = useRef()
  const nameRef    = useRef()
  const photoRef   = useRef()
  const focusOrder = [rowRef, placeRef, barcodeRef, photoRef]

  function handleKeyDown(e) {
    if (e.key !== 'Enter') return
    const idx = focusOrder.findIndex(r => r.current === e.target)
    if (idx === -1) return
    e.preventDefault()
    const next = focusOrder[idx + 1] || focusOrder[0]
    next.current?.focus()
  }

  function selectPrefix(p) {
    setPrefix(p)
    localStorage.setItem(STORAGE_KEY_PREFIX, p)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!rowVal.trim() || !place.trim()) {
      setStatus({ ok: false, text: 'Введите ряд и место в ряду' })
      return
    }
    setStatus(null)
    setBusy(true)
    const cell = prefix + '-' + rowVal.trim() + '-' + place.trim()
    const fd = new FormData()
    fd.append('cell', cell)
    fd.append('barcode', barcode)
    fd.append('employeeName', name)
    if (photos) {
      for (const f of photos) fd.append('photo', f)
    }
    try {
      const r = await fetch('/api/consolidation/complaints', { method: 'POST', body: fd })
      const data = await r.json()
      if (data.ok) {
        localStorage.setItem(STORAGE_KEY_ROW, rowVal.trim())
        localStorage.setItem(STORAGE_KEY_PREFIX, prefix)

        setStatus({ ok: true, text: 'Жалоба отправлена! Спасибо.' })
        setPlace('')
        setBarcode('')
        setPhotos(null)
        if (photoRef.current) photoRef.current.value = ''
      } else {
        setStatus({ ok: false, text: 'Ошибка: ' + (data.error || 'Попробуйте снова') })
      }
    } catch (err) {
      setStatus({ ok: false, text: 'Ошибка сети: ' + err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.body}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <img src="/icon.png" alt="logo" className={styles.logoIcon} />
          <div>
            <div className={styles.logoText}>СберЛогистика</div>
            <div className={styles.logoSub}>Консолидация</div>
          </div>
        </div>
        <h1 className={styles.h1}>Сообщить о нарушении</h1>
        <p className={styles.subtitle}>Заполните форму и прикрепите фото</p>

        <form onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
          {/* Cell */}
          <div className={styles.formGroup}>
            <label className={styles.labelRequired}>Место хранения (ячейка)</label>
            <div className={styles.cellRow}>
              <div className={styles.cellToggle} role="group" aria-label="Тип зоны">
                <button
                  type="button"
                  data-prefix="KDS"
                  className={prefix === 'KDS' ? styles.cellToggleBtnActive : styles.cellToggleBtn}
                  title="Сухой"
                  onClick={() => selectPrefix('KDS')}
                >KDS</button>
                <button
                  type="button"
                  data-prefix="KDH"
                  className={prefix === 'KDH' ? styles.cellToggleBtnActive : styles.cellToggleBtn}
                  title="Холод"
                  onClick={() => selectPrefix('KDH')}
                >KDH</button>
              </div>
              <div className={styles.cellFields}>
                <input
                  ref={rowRef}
                  className={`${styles.formControl} ${styles.cellRowNum}`}
                  type="text"
                  placeholder="4"
                  maxLength={1}
                  autoComplete="off"
                  inputMode="numeric"
                  title="Ряд (1 цифра, сохраняется)"
                  value={rowVal}
                  onChange={e => setRowVal(e.target.value)}
                />
                <input
                  ref={placeRef}
                  className={`${styles.formControl} ${styles.cellPlaceNum}`}
                  type="text"
                  placeholder="44"
                  maxLength={2}
                  required
                  autoComplete="off"
                  inputMode="numeric"
                  title="Место в ряду (2 цифры)"
                  value={place}
                  onChange={e => setPlace(e.target.value)}
                />
              </div>
            </div>
            <small className={styles.cellHint}>
              Ряд и место в ряду. Итог: <strong>{cellPreview}</strong>
            </small>
          </div>

          {/* Barcode */}
          <div className={styles.formGroup}>
            <label className={styles.labelRequired} htmlFor="cf-barcode">Штрихкод товара</label>
            <input
              ref={barcodeRef}
              id="cf-barcode"
              className={styles.formControl}
              type="text"
              inputMode="numeric"
              placeholder="отсканируй ШК товара или ЕО"
              required
              autoComplete="off"
              value={barcode}
              onChange={e => setBarcode(e.target.value)}
            />
          </div>

          {/* Name */}
          <div className={styles.formGroup}>
            <label htmlFor="cf-name">Ваше имя</label>
            <input
              ref={nameRef}
              id="cf-name"
              className={styles.formControl}
              type="text"
              value={name}
              readOnly
            />
          </div>

          {/* Photo */}
          <div className={styles.formGroup}>
            <label htmlFor="cf-photo">Фото нарушения (можно несколько)</label>
            <input
              ref={photoRef}
              id="cf-photo"
              className={styles.formControl}
              type="file"
              accept="image/*"
              multiple
              onChange={e => setPhotos(e.target.files)}
            />
          </div>

          <button type="submit" className={styles.btnSubmit} disabled={busy}>
            {busy ? 'Отправка...' : 'Отправить'}
          </button>
        </form>

        {status && (
          <div className={status.ok ? `${styles.msg} ${styles.msgOk}` : `${styles.msg} ${styles.msgErr}`}>
            {status.text}
          </div>
        )}
      </div>
    </div>
  )
}
