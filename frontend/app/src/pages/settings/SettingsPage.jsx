import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { useApp } from '../../context/AppContext.jsx'
import { useNotify } from '../../context/NotifyContext.jsx'
import * as api from '../../api/index.js'
import { normalizeFio, hasMatchInEmplKeys, personKey } from '../../utils/emplUtils.js'
import { formatDateTime } from '../../utils/format.js'
import {
  Users, Send, Lock, Settings, RefreshCw, FolderOpen, Scale,
  User, UserCircle, Trash2, X, Upload, Download, Clock, Theater,
} from 'lucide-react'
import s from './SettingsPage.module.css'

// ─── Constants ───────────────────────────────────────────────────────────────

const VS_MODULE_LABELS = {
  stats: 'Статистика', data: 'Данные', monitor: 'Мониторинг',
  analysis: 'Анализ', consolidation: 'Консолидация', docs: 'Документы',
  settings: 'Настройки', shipments: 'Отгрузка',
  receive: 'Форма отгрузки', consolidation_form: 'Форма консолидации',
  reports: 'Отчёты', supplies: 'Поставки',
}
const ALL_MODULES = ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'supplies']

const VS_ACTION_LABELS = {
  fetch_data:      'Обновить данные',
  recheck_data:    'Перепроверить данные',
  request_fetch:   'Запросить обновление',
  edit_thresholds: 'Редактировать пороги простоев',
}
const ALL_ACTIONS = ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds']

// Встроенные роли (fallback до загрузки)
const BUILTIN_ROLE_LABELS = {
  admin: 'Администратор', group_leader: 'Руководитель группы',
  supervisor: 'Начальник смены', manager: 'Менеджер',
}

function rolesToLabelMap(roles) {
  const map = {}
  for (const r of roles) map[r.key] = r.label
  return map
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shiftKeyLabel(shiftKey) {
  if (!shiftKey) return ''
  const [date, type] = shiftKey.split('_')
  const [y, m, d] = (date || '').split('-')
  const dateStr = d && m && y ? `${d}.${m}.${y}` : date
  return type === 'day' ? `${dateStr} День (9:00–21:00)` : `${dateStr} Ночь (21:00–9:00)`
}

function titleCaseFio(str) {
  return (str || '').replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

function getTelegramChatsFromConfig(config) {
  if (Array.isArray(config.telegramChats) && config.telegramChats.length > 0) {
    return config.telegramChats.map(c => ({
      chatId: String(c.chatId || '').trim(),
      threadIdConsolidation: String(c.threadIdConsolidation ?? c.threadId ?? '').trim(),
      threadIdStats: String(c.threadIdStats ?? c.threadId ?? '').trim(),
      threadIdIdles: String(c.threadIdIdles ?? c.threadIdStats ?? c.threadId ?? '').trim(),
      label: String(c.label != null ? c.label : '').trim(),
      enabled: c.enabled !== false,
      companiesFilter: Array.isArray(c.companiesFilter)
        ? c.companiesFilter
        : (c.companiesFilter ? String(c.companiesFilter).split(',').map(x => x.trim()).filter(Boolean) : []),
    }))
  }
  if (config.telegramChatId && String(config.telegramChatId).trim()) {
    return [{
      chatId: String(config.telegramChatId).trim(),
      threadIdConsolidation: String(config.telegramThreadId || '').trim(),
      threadIdStats: String(config.telegramThreadId || '').trim(),
      threadIdIdles: String(config.telegramThreadIdIdles || config.telegramThreadId || '').trim(),
      label: '', enabled: true, companiesFilter: [],
    }]
  }
  return []
}

function emptyChat() {
  return { chatId: '', threadIdConsolidation: '', threadIdStats: '', threadIdIdles: '', label: '', enabled: true, companiesFilter: [] }
}

// ─── VS User edit modal ───────────────────────────────────────────────────────

function VsUserEditModal({ user, onClose, onSaved, roles = [] }) {
  const notify = useNotify()
  const { user: currentUser, refreshUser } = useAuth()  // currentUser used below for self-edit detection
  const isNew = !user?.login
  const [login, setLogin] = useState(user?.login || '')
  const [name, setName] = useState(user?.name || '')
  const [role, setRole] = useState(user?.role || 'manager')
  const [companies, setCompanies] = useState((user?.companyIds || []).join(', '))
  const [allowWithoutToken, setAllowWithoutToken] = useState(!!user?.allowWithoutToken)
  const [selfOnly, setSelfOnly] = useState(!!user?.selfOnly)
  const [password, setPassword] = useState('')
  const [modules, setModules] = useState(new Set(user?.modules || []))
  const [actions, setActions] = useState(new Set(user?.actions || []))

  const toggleModule = m => setModules(prev => {
    const next = new Set(prev)
    if (next.has(m)) next.delete(m); else next.add(m)
    return next
  })

  const toggleAction = a => setActions(prev => {
    const next = new Set(prev)
    if (next.has(a)) next.delete(a); else next.add(a)
    return next
  })

  const handleSave = async () => {
    const trimmedLogin = login.trim()
    if (!trimmedLogin) { notify('Введите логин (номер)', 'error'); return }
    const companyIds = role === 'manager'
      ? companies.split(/[,;]/).map(x => x.trim()).filter(Boolean)
      : []
    const payload = { name: name.trim(), role, modules: [...modules], actions: [...actions], companyIds, allowWithoutToken, selfOnly }
    if (password.trim()) payload.password = password.trim()
    try {
      await api.putVsAdminUser(trimmedLogin, payload)
      notify('Сохранено', 'success')
      if (currentUser?.login === trimmedLogin || currentUser?.phone === trimmedLogin) {
        await refreshUser()
      }
      onSaved()
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }

  return (
    <div className={s.modalOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={s.modalBox}>
        <div className={s.modalHeader}>
          <span>{isNew ? 'Добавить пользователя' : 'Права и модули'}</span>
          <button className={s.modalClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
        </div>
        <div className={s.modalBody}>
          <div className="form-group">
            <label>Логин (номер телефона)</label>
            <input className="form-control" value={login} onChange={e => setLogin(e.target.value)}
              disabled={!isNew} placeholder="79161234567" />
          </div>
          <div className="form-group">
            <label>ФИО</label>
            <input className="form-control" value={name} onChange={e => setName(e.target.value)}
              placeholder="Иванов Иван Иванович" />
          </div>
          <div className="form-group">
            <label>Роль</label>
            <select className="form-control" value={role} onChange={e => setRole(e.target.value)}>
              {roles.map(r => <option key={r.key} value={r.key}>{r.label}{r.builtin ? '' : ' *'}</option>)}
            </select>
          </div>
          {role === 'manager' && (
            <div className="form-group">
              <label>Компании (через запятую)</label>
              <input className="form-control" value={companies} onChange={e => setCompanies(e.target.value)}
                placeholder="ООО Компания, ИП Иванов" />
            </div>
          )}
          <div className="form-group">
            <label>Пароль (оставьте пустым, чтобы не менять)</label>
            <input type="password" className="form-control" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Новый пароль..." />
          </div>
          <div className="form-group">
            <label style={{ fontWeight: 400 }}>
              <input type="checkbox" checked={allowWithoutToken} onChange={e => setAllowWithoutToken(e.target.checked)}
                style={{ marginRight: 6 }} />
              Разрешить вход без токена WMS
            </label>
          </div>
          <div className="form-group">
            <label style={{ fontWeight: 400 }}>
              <input type="checkbox" checked={selfOnly} onChange={e => setSelfOnly(e.target.checked)}
                style={{ marginRight: 6 }} />
              Видит только свои данные
            </label>
          </div>
          <div className="form-group">
            <label>Модули</label>
            <div style={{ marginTop: 6 }}>
              {ALL_MODULES.map(m => (
                <label key={m} style={{ display: 'block', marginBottom: 6, fontWeight: 400 }}>
                  <input type="checkbox" checked={modules.has(m)} onChange={() => toggleModule(m)}
                    style={{ marginRight: 6 }} />
                  {VS_MODULE_LABELS[m]}
                </label>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label>Действия</label>
            <div style={{ marginTop: 6 }}>
              {ALL_ACTIONS.map(a => (
                <label key={a} style={{ display: 'block', marginBottom: 6, fontWeight: 400 }}>
                  <input type="checkbox" checked={actions.has(a)} onChange={() => toggleAction(a)}
                    style={{ marginRight: 6 }} />
                  {VS_ACTION_LABELS[a]}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className={s.modalFooter}>
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}

// ─── Users card (admin only) ──────────────────────────────────────────────────

function UsersCard({ roles = [] }) {
  const notify = useNotify()
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [editUser, setEditUser] = useState(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoadingUsers(true)
    try {
      setUsers(await api.getVsAdminUsers())
    } catch (err) {
      notify('Ошибка загрузки пользователей: ' + err.message, 'error')
    } finally {
      setLoadingUsers(false)
    }
  }, [notify])

  useEffect(() => { load() }, [load])

  const handleDelete = async login => {
    if (!confirm(`Удалить доступ для ${login}?`)) return
    try {
      await api.deleteVsAdminUser(login)
      notify('Доступ удалён', 'success')
      load()
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }

  const successful = users.filter(u => u.lastSuccessAt).length
  const roleLabelsMap = rolesToLabelMap(roles.length ? roles : Object.entries(BUILTIN_ROLE_LABELS).map(([k,v]) => ({ key: k, label: v })))
  const q = search.trim().toLowerCase()
  const filtered = q
    ? users.filter(u =>
        (u.login || '').toLowerCase().includes(q) ||
        (u.name || '').toLowerCase().includes(q) ||
        (u.role || '').toLowerCase().includes(q) ||
        (roleLabelsMap[u.role] || '').toLowerCase().includes(q)
      )
    : users

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><User size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Пользователи</div>
          <div className={s.cardSub}>Всего: {users.length}, успешных входов: {successful}</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditUser({})}>+ Добавить</button>
      </div>
      <div className={s.settingsBody}>
        <input
          className="form-control"
          placeholder="Поиск по логину, ФИО, роли..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Логин</th>
                <th>ФИО</th>
                <th>Роль</th>
                <th>Модули</th>
                <th>Успешный вход</th>
                <th style={{ width: 140 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {loadingUsers ? (
                <tr><td colSpan={5} className={s.emptyRow}>Загрузка...</td></tr>
              ) : !filtered.length ? (
                <tr><td colSpan={5} className={s.emptyRow}>{users.length ? 'Ничего не найдено' : 'Нет записей о входах'}</td></tr>
              ) : filtered.map(u => {
                let roleText = u.role ? (roleLabelsMap[u.role] || u.role) : '—'
                if (u.role === 'manager' && u.companyIds?.length) roleText += ' · ' + u.companyIds.join(', ')
                if (u.allowWithoutToken) roleText += ' (без токена)'
                if (u.hasPassword) roleText += ' · пароль'
                const modulesText = u.modules?.length ? u.modules.map(m => VS_MODULE_LABELS[m] || m).join(', ') : '—'
                const successText = u.lastSuccessAt
                  ? formatDateTime(u.lastSuccessAt)
                  : (u.lastAttemptAt ? 'Нет (ошибка)' : '—')
                return (
                  <tr key={u.login}>
                    <td>{u.login || '—'}</td>
                    <td style={{ fontSize: 13 }}>{u.name || '—'}</td>
                    <td>{roleText}</td>
                    <td style={{ maxWidth: 200, fontSize: 12 }}>{modulesText}</td>
                    <td style={{ fontSize: 12 }}>{successText}</td>
                    <td>
                      {u.role === 'admin' && currentUser?.role !== 'developer' && currentUser?.login !== u.login && currentUser?.phone !== u.login ? (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Администратор</span>
                      ) : u.hasAccess ? (
                        <>
                          <button className="btn btn-sm btn-secondary" onClick={() => setEditUser(u)}>Изменить</button>
                          {' '}
                          <button className="btn btn-sm btn-danger" onClick={() => handleDelete(u.login)}>Удалить</button>
                        </>
                      ) : (
                        <button className="btn btn-sm btn-primary" onClick={() => setEditUser(u)}>Дать доступ</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      {editUser !== null && (
        <VsUserEditModal
          user={editUser}
          roles={roles}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); load() }}
        />
      )}
    </div>
  )
}

// ─── Manager telegram card ────────────────────────────────────────────────────

function ManagerTelegramCard() {
  const [status, setStatus] = useState('—')
  useEffect(() => {
    api.getVsTelegramStatus()
      .then(r => setStatus(r.linked
        ? 'Привязан — отчёты приходят в Telegram'
        : 'Не привязан. Нажмите «В Telegram» на вкладке Статистика.'))
      .catch(() => setStatus('—'))
  }, [])

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><Send size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Привязка бота для рассылки статистики</div>
          <div className={s.cardSub}>Себе в личку или в группу — отчёты по кнопке «В Telegram» на вкладке «Статистика»</div>
        </div>
      </div>
      <div className={s.settingsBody}>
        <p className={s.settingDesc} style={{ padding: '16px 20px 4px' }}>Чтобы получать отчёты в Telegram:</p>
        <ol style={{ margin: '8px 0 12px 40px', fontSize: 13, color: 'var(--text)' }}>
          <li>Откройте вкладку <strong>Статистика</strong></li>
          <li>Нажмите кнопку <strong>В Telegram</strong></li>
          <li>При первом нажатии привяжите бота по коду (себе или добавьте бота в группу и отправьте код туда)</li>
        </ol>
        <div className={s.settingRow} style={{ padding: '0 20px 16px', alignItems: 'center', gap: 8 }}>
          <span className={s.settingLabel}>Статус:&nbsp;</span>
          <span className={s.settingDesc}>{status}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Auto-fetch card ──────────────────────────────────────────────────────────

function AutoFetchCard() {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem('vs_auto_fetch_enabled') === '1' } catch { return false }
  })

  const handleToggle = e => {
    const val = e.target.checked
    setEnabled(val)
    try { localStorage.setItem('vs_auto_fetch_enabled', val ? '1' : '0') } catch { /* ignore */ }
  }

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><RefreshCw size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Автообновление</div>
          <div className={s.cardSub}>Этот браузер будет забирать данные из WMS каждые 3 минуты</div>
        </div>
      </div>
      <div className={s.settingsBody}>
        <div className={s.settingRow} style={{ padding: '16px 20px', alignItems: 'center', gap: 16 }}>
          <div className={s.settingInfo}>
            <div className={s.settingLabel}>Автообновление на этом устройстве</div>
            <div className={s.settingDesc}>Включите на одном компьютере — статистика обновится у всех остальных автоматически</div>
          </div>
          <div className={s.settingControl}>
            <label className={s.settingToggle}>
              <input type="checkbox" checked={enabled} onChange={handleToggle} />
              <span className={s.settingToggleSlider} />
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Quick assign modal (вместо window.prompt) ────────────────────────────────

function QuickAssignModal({ fio, companies, onSave, onClose }) {
  const [company, setCompany] = useState('')
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div className={s.modalOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={s.modalBox} style={{ maxWidth: 360 }}>
        <div className={s.modalHeader}>
          <span>Назначить компанию</span>
          <button className={s.modalClose} onClick={onClose}><X size={16} strokeWidth={2}/></button>
        </div>
        <div className={s.modalBody}>
          <div className="form-group">
            <label style={{ color: 'var(--text-muted)', fontSize: 12 }}>Сотрудник</label>
            <div style={{ fontWeight: 600, marginTop: 2 }}>{fio}</div>
          </div>
          <div className="form-group">
            <label>Компания</label>
            <input
              ref={inputRef}
              className="form-control"
              list="quick-assign-dl"
              value={company}
              onChange={e => setCompany(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && company.trim() && onSave(company.trim())}
              placeholder="Введите или выберите..."
            />
            <datalist id="quick-assign-dl">
              {companies.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
        </div>
        <div className={s.modalFooter}>
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={!company.trim()}
            onClick={() => onSave(company.trim())}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}

// ─── No-company table row ─────────────────────────────────────────────────────

function NoCompanyTableRow({ fio, companies, onSave }) {
  const [company, setCompany] = useState('')
  return (
    <tr>
      <td style={{ fontSize: 13 }}>{fio}</td>
      <td>
        <input
          className={s.emplInput}
          list="nocompany-companies-dl"
          value={company}
          onChange={e => setCompany(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && company.trim() && onSave(fio, company.trim())}
          placeholder="Компания..."
          style={{ border: '1.5px solid var(--border)', background: 'var(--white)' }}
        />
      </td>
      <td>
        <button
          className="btn btn-primary btn-sm"
          disabled={!company.trim()}
          onClick={() => onSave(fio, company.trim())}
        >
          Назначить
        </button>
      </td>
    </tr>
  )
}

// ─── Employee row component ───────────────────────────────────────────────────

function EmplRow({ row, onChange, onDelete }) {
  return (
    <tr>
      <td>
        <input className={s.emplInput} type="text" value={row.fio}
          onChange={e => onChange('fio', e.target.value)} placeholder="ФИО" />
      </td>
      <td>
        <input className={s.emplInput} type="text" list="empl-companies-dl"
          value={row.company} placeholder="Компания"
          onChange={e => onChange('company', e.target.value)} />
      </td>
      <td>
        <button className={s.btnIconDel} onClick={onDelete} title="Удалить"><X size={13} strokeWidth={2}/></button>
      </td>
    </tr>
  )
}

// ─── Employees card ───────────────────────────────────────────────────────────

function EmployeesCard() {
  const notify = useNotify()
  const { emplMap, emplNameMap, emplCompanies, dateSummary, allItems, loadEmployees } = useApp()
  const [rows, setRows] = useState([])
  const [allCompanies, setAllCompanies] = useState([])
  const [search, setSearch] = useState('')
  const [info, setInfo] = useState('Проверяется...')
  const [quickAssign, setQuickAssign] = useState(null) // { fio } — открытый QuickAssignModal
  const [localSaved, setLocalSaved] = useState(() => new Set()) // optimistic: fio norms just saved
  const [noCompanyView, setNoCompanyView] = useState('bubbles') // 'bubbles' | 'table'
  const fileInputRef = useRef(null)

  const loadFromServer = useCallback(async () => {
    try {
      const res = await api.getEmployees()
      const employees = res.employees || []
      const companies = res.companies || emplCompanies
      setAllCompanies(companies)
      setRows(employees.map(e => ({ fio: titleCaseFio(e.fio), company: e.company || '' })))
      setInfo(employees.length
        ? `${employees.length} сотрудников · ${companies.length} компаний`
        : 'Список пуст — добавьте вручную или загрузите CSV')
    } catch { /* ignore */ }
  }, [emplCompanies])

  useEffect(() => { loadFromServer() }, [loadFromServer])

  const noCompanyList = useMemo(() => {
    const fioToFull = new Map()
    const enrich = (fio) => {
      const norm = normalizeFio(fio)
      return emplNameMap.get(personKey(norm)) || fio
    }
    for (const item of allItems) {
      const fio = (item.executor || '').trim()
      if (!fio) continue
      const norm = normalizeFio(fio)
      if (!hasMatchInEmplKeys(norm, emplMap)) fioToFull.set(norm, enrich(fio))
    }
    for (const e of (dateSummary?.executors || [])) {
      const fio = (e.name || '').trim()
      if (!fio) continue
      const norm = normalizeFio(fio)
      if (!hasMatchInEmplKeys(norm, emplMap)) fioToFull.set(norm, enrich(fio))
    }
    return [...fioToFull.values()].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [allItems, dateSummary, emplMap, emplNameMap])

  // Filter out optimistically-saved fios so bubbles disappear immediately after save
  const displayNoCompany = useMemo(
    () => noCompanyList.filter(fio => !localSaved.has(normalizeFio(fio))),
    [noCompanyList, localSaved]
  )

  const doSaveEmpl = useCallback(async (fio, company) => {
    try {
      const data = await api.saveEmplOne(fio, company)
      if (data.ok) {
        notify('Сохранено', 'success')
        // Optimistic: remove bubble immediately
        setLocalSaved(prev => new Set([...prev, normalizeFio(fio)]))
        await loadEmployees()
        loadFromServer()
      } else {
        notify('Ошибка: ' + (data.error || 'не удалось сохранить'), 'error')
      }
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }, [notify, loadEmployees, loadFromServer])

  const handleQuickAssignSave = async (company) => {
    const { fio } = quickAssign
    setQuickAssign(null)
    await doSaveEmpl(fio, company)
  }

const handleAddRow = () => setRows(prev => [{ fio: '', company: '' }, ...prev])

  const handleRowChange = (idx, field, value) =>
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value } : r))

  const handleDeleteRow = idx => setRows(prev => prev.filter((_, i) => i !== idx))

  const handleImportCsv = e => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target.result || ''
      const csv = text.startsWith('\uFEFF') ? text.slice(1) : text
      const sep = csv.includes(';') ? ';' : ','
      const imported = []
      for (const line of csv.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const cols = trimmed.split(sep).map(c => c.trim().replace(/^"|"$/g, ''))
        if (cols[0]) imported.push({ fio: titleCaseFio(cols[0]), company: cols[1] || '' })
      }
      setRows(imported)
      notify('Импортировано ' + imported.length + ' строк', 'info')
    }
    reader.readAsText(file, 'utf-8')
    e.target.value = ''
  }

  const handleExportCsv = () => {
    if (!rows.length) { notify('Нет данных для экспорта', 'error'); return }
    const csv = rows.map(r => r.fio + ';' + r.company).join('\r\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'employees.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleSave = async () => {
    const seen = new Set()
    const all = []
    for (const r of rows) {
      if (!r.fio.trim()) continue
      const k = normalizeFio(r.fio)
      if (!seen.has(k)) { seen.add(k); all.push(r) }
    }
    const csv = all.map(r => r.fio + ';' + r.company).join('\n')
    try {
      const res = await api.saveEmployeesCsv(csv)
      if (res.ok) {
        notify('Сохранено ' + all.length + ' сотрудников', 'success')
        await loadEmployees()
        loadFromServer()
      } else {
        notify('Ошибка: ' + res.error, 'error')
      }
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }

  const filteredRows = rows.filter(r => {
    if (!search) return true
    const q = search.toLowerCase()
    return r.fio.toLowerCase().includes(q) || r.company.toLowerCase().includes(q)
  })

  return (
    <>
      {/* datalist один раз для всей карточки */}
      <datalist id="empl-companies-dl">
        {allCompanies.map(c => <option key={c} value={c} />)}
      </datalist>

      {quickAssign && (
        <QuickAssignModal
          fio={quickAssign.fio}
          companies={allCompanies}
          onSave={handleQuickAssignSave}
          onClose={() => setQuickAssign(null)}
        />
      )}

      <div className={s.card}>
        <div className={s.cardHeader}>
          <div className={s.cardIcon}><Users size={22} strokeWidth={1.5}/></div>
          <div className={s.cardHeaderText}>
            <div className={s.cardTitle}>Список сотрудников</div>
            <div className={s.cardSub}>{info}</div>
          </div>
        </div>

        {/* datalist для таблицы без компании */}
        <datalist id="nocompany-companies-dl">
          {allCompanies.map(c => <option key={c} value={c} />)}
        </datalist>

        {/* Без компании */}
        {displayNoCompany.length > 0 && (
          <div className={s.emplNoCompanySection}>
            <div className={s.emplNoCompanyHeader}>
              <span className={s.emplNoCompanyBadge}>{displayNoCompany.length}</span>
              <span className={s.emplSubtitle}>Из статистики без компании</span>
              <div className={s.noCompanyViewToggle}>
                <button
                  className={`btn btn-sm ${noCompanyView === 'bubbles' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setNoCompanyView('bubbles')}
                  title="Показать метками"
                >
                  ○ Метки
                </button>
                <button
                  className={`btn btn-sm ${noCompanyView === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setNoCompanyView('table')}
                  title="Показать списком"
                >
                  ≡ Список
                </button>
              </div>
            </div>

            {noCompanyView === 'bubbles' ? (
              <ul className={s.emplNoCompanyList}>
                {displayNoCompany.map(fio => (
                  <li key={fio}>
                    <button className={s.btnEmplFio} onClick={() => setQuickAssign({ fio })}>
                      {fio}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={s.noCompanyTableWrap}>
                <table className={s.emplEditorTable}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 200 }}>ФИО из статистики</th>
                      <th style={{ minWidth: 180 }}>Компания</th>
                      <th style={{ width: 100 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {displayNoCompany.map(fio => (
                      <NoCompanyTableRow
                        key={fio}
                        fio={fio}
                        companies={allCompanies}
                        onSave={doSaveEmpl}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className={s.settingsBody}>
          <div className={s.emplToolbar}>
            <input type="text" className={`form-control ${s.emplSearch}`}
              placeholder="Поиск..."
              value={search} onChange={e => setSearch(e.target.value)} />
            <button className="btn btn-secondary btn-sm" onClick={handleAddRow}>+ Добавить</button>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              <Upload size={13} strokeWidth={2} style={{marginRight:4}}/> CSV
              <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImportCsv} />
            </label>
            <button className="btn btn-secondary btn-sm" style={{display:'inline-flex',alignItems:'center',gap:5}} onClick={handleExportCsv}><Download size={13} strokeWidth={2}/>Экспорт</button>

            <button className="btn btn-primary btn-sm" onClick={handleSave}>Сохранить</button>
          </div>

          <div className={s.emplEditorTableWrap}>
            <table className={s.emplEditorTable}>
              <thead>
                <tr>
                  <th style={{ minWidth: 240 }}>ФИО</th>
                  <th style={{ minWidth: 180 }}>Компания</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {filteredRows.length ? filteredRows.map(r => {
                  const origIdx = rows.indexOf(r)
                  return (
                    <EmplRow
                      key={origIdx}
                      row={r}
                      onChange={(field, val) => handleRowChange(origIdx, field, val)}
                      onDelete={() => handleDeleteRow(origIdx)}
                    />
                  )
                }) : (
                  <tr>
                    <td colSpan={3} className={s.emptyRow}>
                      {rows.length ? 'Ничего не найдено' : 'Нет сотрудников — добавьте вручную или загрузите CSV'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Shifts card ──────────────────────────────────────────────────────────────

function ShiftsCard() {
  const [shifts, setShifts] = useState([])
  const [loadingShifts, setLoadingShifts] = useState(true)

  useEffect(() => {
    api.listShifts()
      .then(data => setShifts(data || []))
      .catch(() => {})
      .finally(() => setLoadingShifts(false))
  }, [])

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><FolderOpen size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Сохранённые смены</div>
          <div className={s.cardSub}>Файлы в папке backend/data/</div>
        </div>
      </div>
      <div className={s.settingsBody}>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Смена</th>
                <th style={{ textAlign: 'right' }}>Операций</th>
                <th>Обновлено</th>
              </tr>
            </thead>
            <tbody>
              {loadingShifts ? (
                <tr><td colSpan={3} className={s.emptyRow}>Загрузка...</td></tr>
              ) : !shifts.length ? (
                <tr><td colSpan={3} className={s.emptyRow}>Нет сохранённых смен</td></tr>
              ) : shifts.map(shift => (
                <tr key={shift.shiftKey}>
                  <td>{shiftKeyLabel(shift.shiftKey)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{(shift.count || 0).toLocaleString('ru-RU')}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {shift.updatedAt ? formatDateTime(shift.updatedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Telegram chat row ────────────────────────────────────────────────────────

function TelegramChatRow({ chat, companies, onChange, onDelete }) {
  return (
    <div className={s.tgChatCard}>
      <div className={s.tgChatHead}>
        <label className={s.tgEnabledWrap} title="Отключить уведомления в этот чат">
          <input type="checkbox" checked={chat.enabled !== false}
            onChange={e => onChange('enabled', e.target.checked)} />
          Вкл
        </label>
        <input type="text" className={`form-control ${s.tgChatIdInput}`}
          placeholder="Chat ID (например −1001234567890)" value={chat.chatId}
          onChange={e => onChange('chatId', e.target.value)} />
        <button className={s.btnIconDel} onClick={onDelete} title="Удалить чат"><X size={13} strokeWidth={2}/></button>
      </div>
      <div className={s.tgChatFields}>
        <div className={s.tgField}>
          <span className={s.tgFieldLabel}>Thread: Консолидация</span>
          <input type="text" className="form-control" placeholder="ID темы"
            value={chat.threadIdConsolidation}
            onChange={e => onChange('threadIdConsolidation', e.target.value)} />
        </div>
        <div className={s.tgField}>
          <span className={s.tgFieldLabel}>Thread: Статистика</span>
          <input type="text" className="form-control" placeholder="ID темы"
            value={chat.threadIdStats}
            onChange={e => onChange('threadIdStats', e.target.value)} />
        </div>
        <div className={s.tgField}>
          <span className={s.tgFieldLabel}>Thread: Простои</span>
          <input type="text" className="form-control" placeholder="ID темы"
            value={chat.threadIdIdles}
            onChange={e => onChange('threadIdIdles', e.target.value)} />
        </div>
        <div className={s.tgField}>
          <span className={s.tgFieldLabel}>Компании (пусто = все)</span>
          <select multiple className={`form-control ${s.tgCompanies}`}
            title="Выберите компании для этого чата; ничего не выбрано = все"
            value={chat.companiesFilter}
            onChange={e => onChange('companiesFilter', Array.from(e.target.selectedOptions).map(o => o.value).filter(Boolean))}>
            {companies.length
              ? companies.map(c => <option key={c} value={c}>{c}</option>)
              : <option disabled value="">Загрузите сотрудников — появятся компании</option>}
          </select>
        </div>
      </div>
    </div>
  )
}

// ─── Telegram card ────────────────────────────────────────────────────────────

function TelegramCard() {
  const notify = useNotify()
  const { emplCompanies } = useApp()
  const [chats, setChats] = useState([emptyChat()])
  const [tokenInput, setTokenInput] = useState('')
  const [statusText, setStatusText] = useState('Проверяется...')
  const [statusColor, setStatusColor] = useState('var(--text-muted)')

  const load = useCallback(async () => {
    try {
      const cfg = await api.getConfig()
      const hasToken = cfg.telegramBotToken === '***'
      const parsedChats = getTelegramChatsFromConfig(cfg)
      setChats(parsedChats.length ? parsedChats : [emptyChat()])
      const hasChats = parsedChats.some(c => c.chatId)
      if (hasToken && hasChats) {
        setStatusText(`Настроено: bot token сохранён, чатов: ${parsedChats.filter(c => c.chatId).length}`)
        setStatusColor('var(--green)')
      } else {
        setStatusText('Не настроено')
        setStatusColor('var(--text-muted)')
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load() }, [load])

  const addChat = () => setChats(prev => [...prev, emptyChat()])
  const deleteChat = idx => setChats(prev => prev.filter((_, i) => i !== idx))
  const updateChat = (idx, field, value) =>
    setChats(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c))

  const handleSave = async () => {
    const activeChats = []
    for (const c of chats) {
      const chatId = c.chatId.trim()
      if (!chatId) continue
      if (c.threadIdConsolidation && !/^\d+$/.test(c.threadIdConsolidation)) {
        notify('Thread ID консолидации должен быть целым числом', 'error'); return
      }
      if (c.threadIdStats && !/^\d+$/.test(c.threadIdStats)) {
        notify('Thread ID статистики должен быть целым числом', 'error'); return
      }
      if (c.threadIdIdles && !/^\d+$/.test(c.threadIdIdles)) {
        notify('Thread ID простоев должен быть целым числом', 'error'); return
      }
      activeChats.push({
        chatId,
        threadIdConsolidation: c.threadIdConsolidation,
        threadIdStats: c.threadIdStats,
        threadIdIdles: c.threadIdIdles,
        label: '',
        enabled: c.enabled,
        companiesFilter: c.companiesFilter,
      })
    }
    if (!activeChats.length) { notify('Добавьте хотя бы один чат с Chat ID', 'error'); return }
    const payload = { telegramChats: activeChats }
    if (tokenInput.trim()) payload.telegramBotToken = tokenInput.trim()
    try {
      const res = await api.putConfig(payload)
      if (res.ok) {
        setTokenInput('')
        notify('Настройки Telegram сохранены', 'success')
        load()
      } else {
        notify('Ошибка: ' + res.error, 'error')
      }
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }

  const handleClear = async () => {
    try {
      const res = await api.putConfig({ telegramBotToken: '', telegramChats: [] })
      if (res.ok) {
        setTokenInput('')
        notify('Настройки Telegram очищены', 'info')
        load()
      } else {
        notify('Ошибка: ' + res.error, 'error')
      }
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><Send size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Telegram уведомления</div>
          <div className={s.cardSub} style={{ color: statusColor }}>{statusText}</div>
        </div>
      </div>
      <div className={s.settingsBody}>
        <div className={s.settingRow} style={{ padding: '16px 20px', alignItems: 'center', gap: 16 }}>
          <div className={s.settingInfo}>
            <div className={s.settingLabel}>Bot token</div>
            <div className={s.settingDesc}>Вставьте токен только при изменении. Храним на сервере.</div>
          </div>
          <div className={s.settingControl}>
            <input type="password" className="form-control"
              value={tokenInput} onChange={e => setTokenInput(e.target.value)}
              placeholder="123456:ABC..." style={{ width: 280 }} />
          </div>
        </div>
        <div className={s.settingDivider} />
        <div className={s.settingRowStack}>
          <div className={s.settingInfo}>
            <div className={s.settingLabel}>Чаты и пользователи</div>
            <div className={s.settingDesc}>
              «Вкл» — чат получает уведомления; снять — отключить. «Компании» — выпадающий список (ничего не выбрано = все).
              Thread ID для тем «Ошибки комплектации», «Статистика» и «Простои».
            </div>
          </div>
          <div className={s.settingControlFull}>
            <div className={s.telegramChatsList}>
              {chats.map((chat, idx) => (
                <TelegramChatRow
                  key={idx}
                  chat={chat}
                  companies={emplCompanies}
                  onChange={(field, val) => updateChat(idx, field, val)}
                  onDelete={() => deleteChat(idx)}
                />
              ))}
            </div>
            <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={addChat}>
              + Добавить чат
            </button>
          </div>
        </div>
        <div className={s.settingsActions}>
          <button className="btn btn-primary" onClick={handleSave}>Сохранить Telegram</button>
          <button className="btn btn-secondary" onClick={handleClear}>Очистить Telegram</button>
        </div>
      </div>
    </div>
  )
}

// ─── Pending registrations card (admin only) ──────────────────────────────────

function PendingCard({ onApproved, roles = [] }) {
  const notify = useNotify()
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState({})
  const [roleFor, setRoleFor] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setPending(await api.getVsAdminPending())
    } catch (err) {
      notify('Ошибка загрузки заявок: ' + err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => { load() }, [load])

  const handleApprove = async (phone) => {
    const role = roleFor[phone] || 'manager'
    setApproving(a => ({ ...a, [phone]: true }))
    try {
      await api.approveVsPending(phone, role)
      notify('Доступ одобрен', 'success')
      load()
      onApproved?.()
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    } finally {
      setApproving(a => ({ ...a, [phone]: false }))
    }
  }

  const handleReject = async (phone) => {
    if (!confirm('Отклонить заявку?')) return
    try {
      await api.rejectVsPending(phone)
      notify('Заявка отклонена', 'success')
      load()
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    }
  }

  if (!loading && !pending.length) return null

  return (
    <div className={s.card} style={{ borderLeft: '3px solid #f59e0b' }}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><Clock size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Заявки на регистрацию</div>
          <div className={s.cardSub}>Пользователи, ожидающие одобрения доступа</div>
        </div>
      </div>
      <div className={s.settingsBody}>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Телефон</th>
                <th>Дата заявки</th>
                <th>Роль</th>
                <th style={{ width: 200 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className={s.emptyRow}>Загрузка...</td></tr>
              ) : pending.map(p => (
                <tr key={p.phone}>
                  <td style={{ fontWeight: 600 }}>{p.name || '—'}</td>
                  <td>{p.phone}</td>
                  <td style={{ fontSize: 12 }}>{p.registeredAt ? new Date(p.registeredAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td>
                    <select
                      style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)' }}
                      value={roleFor[p.phone] || 'manager'}
                      onChange={e => setRoleFor(r => ({ ...r, [p.phone]: e.target.value }))}
                    >
                      {(roles.length ? roles : Object.entries(BUILTIN_ROLE_LABELS).map(([k, v]) => ({ key: k, label: v }))).map(r => (
                        <option key={r.key} value={r.key}>{r.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={approving[p.phone]}
                      onClick={() => handleApprove(p.phone)}
                    >
                      {approving[p.phone] ? '...' : 'Одобрить'}
                    </button>
                    {' '}
                    <button className="btn btn-sm btn-danger" onClick={() => handleReject(p.phone)}>
                      Отклонить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Roles card (admin only) ──────────────────────────────────────────────────

function RolesCard({ roles, onChanged }) {
  const notify = useNotify()
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newModules, setNewModules] = useState(new Set())
  const [editKey, setEditKey] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editModules, setEditModules] = useState(new Set())
  const [search, setSearch] = useState('')

  const toggleModule = (set, setFn, m) => setFn(prev => {
    const next = new Set(prev)
    if (next.has(m)) next.delete(m); else next.add(m)
    return next
  })

  const handleAdd = async () => {
    if (!newLabel.trim()) { notify('Введите название роли', 'error'); return }
    try {
      await api.addVsAdminRole('', newLabel.trim(), [...newModules])
      notify('Роль добавлена', 'success')
      setShowAdd(false); setNewLabel(''); setNewModules(new Set())
      onChanged()
    } catch (err) { notify('Ошибка: ' + err.message, 'error') }
  }

  const handleUpdate = async () => {
    try {
      await api.updateVsAdminRole(editKey, editLabel.trim(), [...editModules])
      notify('Роль обновлена', 'success')
      setEditKey(null)
      onChanged()
    } catch (err) { notify('Ошибка: ' + err.message, 'error') }
  }

  const handleDelete = async (key) => {
    if (!confirm('Удалить роль?')) return
    try {
      await api.deleteVsAdminRole(key)
      notify('Роль удалена', 'success')
      onChanged()
    } catch (err) { notify('Ошибка: ' + err.message, 'error') }
  }

  const startEdit = r => {
    setEditKey(r.key); setEditLabel(r.label); setEditModules(new Set(r.modules || []))
  }

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><Theater size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Роли</div>
          <div className={s.cardSub}>Встроенные и кастомные роли с правами на модули</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(v => !v)}>+ Новая роль</button>
      </div>
      <div className={s.settingsBody}>
        <input
          className="form-control"
          placeholder="Поиск по ключу или названию..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {showAdd && (
          <div style={{ background: 'var(--bg)', borderRadius: 8, padding: 16, marginBottom: 16, border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>Новая роль</div>
            <div className="form-group">
              <label>Название</label>
              <input className="form-control" value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Кладовщик" autoFocus />
            </div>
            <div className="form-group">
              <label>Модули</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                {ALL_MODULES.map(m => (
                  <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 400, fontSize: 13 }}>
                    <input type="checkbox" checked={newModules.has(m)} onChange={() => toggleModule(newModules, setNewModules, m)} />
                    {VS_MODULE_LABELS[m]}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={handleAdd}>Добавить</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setShowAdd(false); setNewLabel(''); setNewModules(new Set()) }}>Отмена</button>
            </div>
          </div>
        )}
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Ключ</th>
                <th>Название</th>
                <th>Модули</th>
                <th style={{ width: 140 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {roles.filter(r => {
                const q = search.trim().toLowerCase()
                return !q || r.key.includes(q) || r.label.toLowerCase().includes(q)
              }).map(r => editKey === r.key ? (
                <tr key={r.key}>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.key}</td>
                  <td>
                    <input className="form-control" style={{ fontSize: 13, padding: '4px 8px' }} value={editLabel} onChange={e => setEditLabel(e.target.value)} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {ALL_MODULES.map(m => (
                        <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 3, fontWeight: 400, fontSize: 12 }}>
                          <input type="checkbox" checked={editModules.has(m)} onChange={() => toggleModule(editModules, setEditModules, m)} />
                          {VS_MODULE_LABELS[m]}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button className="btn btn-sm btn-primary" onClick={handleUpdate}>Сохранить</button>
                    {' '}
                    <button className="btn btn-sm btn-secondary" onClick={() => setEditKey(null)}><X size={13} strokeWidth={2}/></button>
                  </td>
                </tr>
              ) : (
                <tr key={r.key}>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.key}</td>
                  <td style={{ fontWeight: r.builtin ? 600 : 400 }}>{r.label}{r.builtin ? <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>встроенная</span> : null}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.modules?.length ? r.modules.map(m => VS_MODULE_LABELS[m] || m).join(', ') : '—'}</td>
                  <td>
                    {!r.builtin && (
                      <>
                        <button className="btn btn-sm btn-secondary" onClick={() => startEdit(r)}>Изменить</button>
                        {' '}
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(r.key)}>Удалить</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Access content ────────────────────────────────────────────────────────────

// ─── Product weights card ────────────────────────────────────────────────────

function ProductWeightsCard() {
  const notify = useNotify()
  const fileRef = useRef(null)
  const [info, setInfo] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const loadInfo = useCallback(async () => {
    try { setInfo(await api.getProductWeightsInfo()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadInfo() }, [loadInfo])

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const res = await api.uploadProductWeightsExcel(file)
      notify(`Загружено ${res.count} артикулов`, 'success')
      await loadInfo()
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Удалить файл весов товаров? Это действие нельзя отменить.')) return
    setDeleting(true)
    try {
      await api.deleteProductWeightsExcel()
      notify('Файл весов удалён', 'success')
      await loadInfo()
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><Scale size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Веса товаров</div>
          <div className={s.cardSub}>
            {info?.exists
              ? `${info.count} артикулов · обновлено ${formatDateTime(info.updatedAt)} · ${(info.sizeBytes / 1024).toFixed(0)} КБ`
              : 'Файл не загружен'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {info?.exists && (
            <button
              className="btn btn-danger"
              onClick={handleDelete}
              disabled={deleting || uploading}
            >
              {deleting ? 'Удаление...' : <><Trash2 size={13} strokeWidth={2} style={{marginRight:4}}/>Удалить</>}
            </button>
          )}
          <label className={`btn btn-primary${uploading ? ' disabled' : ''}`} style={{ cursor: 'pointer', display:'inline-flex', alignItems:'center', gap:6 }}>
            <Upload size={14} strokeWidth={2}/>{uploading ? 'Загрузка...' : 'Загрузить Excel'}
            <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleUpload} disabled={uploading} />
          </label>
        </div>
      </div>
      <div className={s.settingsBody} style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        Файл должен содержать колонки <strong>«Артикул товара»</strong> и <strong>«Вес товара»</strong>.
        Вес указывается в кг (например: 0.5) или граммах (например: 500г).
      </div>
    </div>
  )
}

// ─── My modules card ─────────────────────────────────────────────────────────

function MyModulesCard() {
  const { user, refreshUser } = useAuth()
  const notify = useNotify()
  const [selected, setSelected] = useState(() => new Set(user?.modules || []))
  const [saving, setSaving] = useState(false)

  const toggle = m => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(m)) next.delete(m); else next.add(m)
    return next
  })

  const handleSave = async () => {
    const login = user?.login || user?.phone
    if (!login) return
    setSaving(true)
    try {
      await api.putVsAdminUser(login, { modules: [...selected] })
      await refreshUser()
      notify('Разделы обновлены', 'success')
    } catch (err) {
      notify('Ошибка: ' + err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={s.cardIcon}><UserCircle size={22} strokeWidth={1.5}/></div>
        <div className={s.cardHeaderText}>
          <div className={s.cardTitle}>Мои разделы</div>
          <div className={s.cardSub}>Выберите разделы, которые отображаются в вашем меню</div>
        </div>
      </div>
      <div className={s.settingsBody}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px', padding: '16px 20px' }}>
          {ALL_MODULES.map(m => (
            <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 400, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(m)} onChange={() => toggle(m)} />
              {VS_MODULE_LABELS[m] || m}
            </label>
          ))}
        </div>
        <div style={{ padding: '0 20px 16px' }}>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AccessContent() {
  const notify = useNotify()
  const [roles, setRoles] = useState([])
  const [usersKey, setUsersKey] = useState(0)

  const loadRoles = useCallback(async () => {
    try { setRoles(await api.getVsAdminRoles()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadRoles() }, [loadRoles])

  const handleRolesChanged = () => { loadRoles(); setUsersKey(k => k + 1) }

  return (
    <>
      <MyModulesCard />
      <PendingCard onApproved={() => setUsersKey(k => k + 1)} roles={roles} />
      <RolesCard roles={roles} onChanged={handleRolesChanged} />
      <UsersCard key={usersKey} roles={roles} />
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TAB_DEFS = [
  { key: 'employees', label: 'Сотрудники', Icon: Users },
  { key: 'telegram',  label: 'Telegram',   Icon: Send },
  { key: 'access',    label: 'Доступ',     Icon: Lock },
  { key: 'system',    label: 'Система',    Icon: Settings },
]

export default function SettingsPage() {
  const { user } = useAuth()
  const role = user?.role
  const isManager = role === 'manager'
  const isNonManager = !isManager

  const visibleTabs = TAB_DEFS.filter(t => {
    if (t.key === 'employees') return isNonManager
    if (t.key === 'telegram')  return true
    if (t.key === 'access')    return isNonManager
    if (t.key === 'system')    return isNonManager
    return false
  })

  const [activeTab, setActiveTab] = useState(visibleTabs[0]?.key ?? 'telegram')
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([visibleTabs[0]?.key ?? 'telegram']))

  const handleTabClick = (key) => {
    setActiveTab(key)
    setVisitedTabs(prev => new Set([...prev, key]))
  }

  const hide = (key) => activeTab === key ? {} : { display: 'none' }

  return (
    <div className={s.settingsPage}>
      <div className={s.tabStrip}>
        {visibleTabs.map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`${s.tab} ${activeTab === key ? s.tabActive : ''}`}
            onClick={() => handleTabClick(key)}
          >
            <Icon size={15} strokeWidth={1.75} className={s.tabIcon} />
            {label}
          </button>
        ))}
      </div>

      <div className={s.tabContent}>
        {visitedTabs.has('employees') && isNonManager && (
          <div style={hide('employees')}><EmployeesCard /></div>
        )}

        {visitedTabs.has('telegram') && isManager && (
          <div style={hide('telegram')}><ManagerTelegramCard /></div>
        )}
        {visitedTabs.has('telegram') && isNonManager && (
          <div style={hide('telegram')}><TelegramCard /></div>
        )}

        {visitedTabs.has('access') && isNonManager && (
          <div style={hide('access')}><AccessContent /></div>
        )}

        {visitedTabs.has('system') && isNonManager && (
          <div style={hide('system')}>
            <AutoFetchCard />
            <ShiftsCard />
            <ProductWeightsCard />
          </div>
        )}
      </div>
    </div>
  )
}
