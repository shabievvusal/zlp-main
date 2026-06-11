import { useState, useEffect, useRef } from 'react'
import { getViolations, createViolation, deleteViolation } from '../../api/index.js'
import { useNotify } from '../../context/NotifyContext.jsx'
import styles from './ViolationsPage.module.css'

function formatDamage(n) {
  if (n == null) return '—'
  return Number(n).toLocaleString('ru-RU') + ' ₽'
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ViolationsPage() {
  const notify = useNotify()
  const [violations, setViolations] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [previewIdx, setPreviewIdx] = useState(null)

  const [title, setTitle] = useState('')
  const [damage, setDamage] = useState('')
  const [videoFile, setVideoFile] = useState(null)
  const fileRef = useRef(null)

  const load = async () => {
    try {
      setLoading(true)
      setViolations(await getViolations())
    } catch (e) {
      notify.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleSubmit = async e => {
    e.preventDefault()
    if (!title.trim()) return notify.error('Введите название нарушения')
    if (!videoFile) return notify.error('Выберите видео-файл')
    try {
      setSubmitting(true)
      const fd = new FormData()
      fd.append('title', title.trim())
      if (damage) fd.append('damage', damage)
      fd.append('video', videoFile)
      const created = await createViolation(fd)
      setViolations(v => [created, ...v])
      setTitle('')
      setDamage('')
      setVideoFile(null)
      if (fileRef.current) fileRef.current.value = ''
      notify.success('Нарушение добавлено')
    } catch (e) {
      notify.error(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Удалить нарушение?')) return
    try {
      await deleteViolation(id)
      setViolations(v => v.filter(x => x.id !== id))
      if (previewIdx !== null) setPreviewIdx(null)
      notify.success('Удалено')
    } catch (e) {
      notify.error(e.message)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Нарушения</h1>
        <span className={styles.count}>{violations.length} записей</span>
      </div>

      {/* ── Форма добавления ── */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">Добавить нарушение</div>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.formRow}>
            <div className="form-group" style={{ flex: 2, marginBottom: 0 }}>
              <label>Нарушение *</label>
              <input
                className="form-control"
                placeholder="Описание нарушения"
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label>Ущерб (₽)</label>
              <input
                className="form-control"
                type="number"
                min="0"
                placeholder="0"
                value={damage}
                onChange={e => setDamage(e.target.value)}
              />
            </div>
          </div>
          <div className={styles.formRow}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label>Видео *</label>
              <input
                ref={fileRef}
                className="form-control"
                type="file"
                accept="video/*"
                onChange={e => setVideoFile(e.target.files[0] || null)}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting}
              >
                {submitting ? 'Загрузка...' : 'Добавить'}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* ── Список ── */}
      {loading ? (
        <div className={styles.empty}>Загрузка...</div>
      ) : violations.length === 0 ? (
        <div className={styles.empty}>Нарушений нет</div>
      ) : (
        <div className={styles.grid}>
          {violations.map((v, idx) => (
            <div
              key={v.id}
              className={`${styles.card} ${previewIdx === idx ? styles.cardActive : ''}`}
            >
              <div className={styles.videoWrap} onClick={() => setPreviewIdx(previewIdx === idx ? null : idx)}>
                {previewIdx === idx ? (
                  <video
                    className={styles.video}
                    src={`/violation-videos/${v.videoFile}`}
                    controls
                    autoPlay
                    muted
                  />
                ) : (
                  <div className={styles.videoThumb}>
                    <span className={styles.playIcon}>▶</span>
                  </div>
                )}
              </div>
              <div className={styles.cardBody}>
                <div className={styles.cardTitle}>{v.title}</div>
                <div className={styles.cardMeta}>
                  <span className={v.damage ? styles.damage : styles.damageEmpty}>
                    {formatDamage(v.damage)}
                  </span>
                  <span className={styles.date}>{formatDate(v.createdAt)}</span>
                </div>
              </div>
              <button
                className={`btn btn-danger btn-sm ${styles.deleteBtn}`}
                onClick={() => handleDelete(v.id)}
              >
                Удалить
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
