import { useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import * as api from '../../api/index.js'
import styles from './LoginForm.module.css'

// ─── Phone formatting ─────────────────────────────────────────────────────────

function formatPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '')
  if (digits.startsWith('8')) digits = '7' + digits.slice(1)
  if (digits.length > 0 && !digits.startsWith('7')) digits = '7' + digits
  digits = digits.slice(0, 11)
  if (digits.length === 0 || digits === '7') return ''
  const d = digits.slice(1)
  let res = '+7'
  if (d.length > 0) res += ' (' + d.slice(0, Math.min(3, d.length))
  if (d.length >= 3) {
    res += ') ' + d.slice(3, Math.min(6, d.length))
    if (d.length > 6) {
      res += '-' + d.slice(6, Math.min(8, d.length))
      if (d.length > 8) res += '-' + d.slice(8, 10)
    }
  }
  return res
}

function isPhoneComplete(formatted) {
  return formatted.replace(/\D/g, '').length === 11
}

function PasswordInput({ value, onChange, placeholder, required, autoFocus }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <input
        className="form-control"
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        required={required}
        autoFocus={autoFocus}
        style={{ paddingRight: 44 }}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        style={{
          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: 18, padding: '0 2px', lineHeight: 1,
        }}
        tabIndex={-1}
        aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
      >
        {show ? '🙈' : '👁'}
      </button>
    </div>
  )
}

function PhoneInput({ value, onChange, autoFocus, required }) {
  return (
    <input
      className="form-control"
      type="tel"
      placeholder="+7 (999) 999-99-99"
      value={value}
      onChange={e => onChange(formatPhone(e.target.value))}
      autoFocus={autoFocus}
      required={required}
    />
  )
}

function LoginTab() {
  const { login } = useAuth()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    if (!isPhoneComplete(phone)) { setError('Введите полный номер телефона (+7 и 10 цифр)'); return }
    setLoading(true)
    const cleanPhone = '+7' + phone.replace(/\D/g, '').slice(-10)
    try {
      await login(cleanPhone, password)
    } catch (err) {
      setError(err.message || 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-group">
        <label>Номер телефона</label>
        <PhoneInput value={phone} onChange={setPhone} autoFocus required />
      </div>
      <div className="form-group">
        <label>Пароль</label>
        <PasswordInput placeholder="Пароль от WMS или от сайта" value={password} onChange={e => setPassword(e.target.value)} required />
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <button className={`btn btn-primary ${styles.submitBtn}`} type="submit" disabled={loading}>
        {loading ? 'Вход...' : 'Войти'}
      </button>
    </form>
  )
}

function RegisterTab() {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [wmsPassword, setWmsPassword] = useState('')
  const [sitePassword, setSitePassword] = useState('')
  const [sitePasswordConfirm, setSitePasswordConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    if (sitePassword !== sitePasswordConfirm) {
      setError('Пароли от сайта не совпадают')
      return
    }
    if (sitePassword.length < 6) {
      setError('Пароль от сайта должен быть не менее 6 символов')
      return
    }
    if (!isPhoneComplete(phone)) { setError('Введите полный номер телефона (+7 и 10 цифр)'); return }
    setLoading(true)
    const cleanPhone = '+7' + phone.replace(/\D/g, '').slice(-10)
    try {
      await api.registerVs({ name, phone: cleanPhone, wmsPassword, sitePassword })
      setDone(true)
    } catch (err) {
      setError(err.message || 'Ошибка регистрации')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className={styles.registerSuccess}>
        <div className={styles.registerSuccessIcon}>✓</div>
        <div className={styles.registerSuccessTitle}>Заявка отправлена</div>
        <div className={styles.registerSuccessText}>
          Доступ к сайту запрошен. Ожидайте одобрения администратора.
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-group">
        <label>ФИО</label>
        <input
          className="form-control"
          type="text"
          placeholder="Иванов Иван Иванович"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
          required
        />
      </div>
      <div className="form-group">
        <label>Номер телефона (как в WMS)</label>
        <PhoneInput value={phone} onChange={setPhone} required />
      </div>
      <div className="form-group">
        <label>Пароль от WMS <span className={styles.labelOptional}>(необязательно)</span></label>
        <PasswordInput placeholder="Пароль от личного кабинета WMS" value={wmsPassword} onChange={e => setWmsPassword(e.target.value)} />
        <div className={styles.fieldHint}>Используется для синхронизации данных с WMS. Может не работать, если нет доступа к мониторингу.</div>
      </div>
      <div className={styles.divider} />
      <div className="form-group">
        <label>Пароль для сайта</label>
        <PasswordInput placeholder="Придумайте пароль" value={sitePassword} onChange={e => setSitePassword(e.target.value)} required />
      </div>
      <div className="form-group">
        <label>Повторите пароль для сайта</label>
        <PasswordInput placeholder="Повторите пароль" value={sitePasswordConfirm} onChange={e => setSitePasswordConfirm(e.target.value)} required />
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <button className={`btn btn-primary ${styles.submitBtn}`} type="submit" disabled={loading}>
        {loading ? 'Отправка...' : 'Запросить доступ'}
      </button>
    </form>
  )
}

export default function LoginForm() {
  const [tab, setTab] = useState('login')

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <img src="/icon.png" alt="logo" className={styles.logoIcon} />
          <div>
            <div className={styles.logoName}>СберЛогистика WMS</div>
            <div className={styles.logoSub}>Система мониторинга склада</div>
          </div>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'login' ? styles.tabActive : ''}`}
            onClick={() => setTab('login')}
          >
            Вход
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'register' ? styles.tabActive : ''}`}
            onClick={() => setTab('register')}
          >
            Регистрация
          </button>
        </div>

        {tab === 'login' ? <LoginTab /> : <RegisterTab />}
      </div>
    </div>
  )
}
