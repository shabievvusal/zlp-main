/**
 * vs-auth.js — сессии и роли для страницы /vs
 * Роли: admin, group_leader, supervisor, manager
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VS_USERS_PATH = path.join(__dirname, 'vs-users.json');
const VS_PENDING_PATH = path.join(__dirname, 'data', 'vs-pending-users.json');
const VS_CUSTOM_ROLES_PATH = path.join(__dirname, 'data', 'vs-custom-roles.json');
const VS_LOGINS_PATH = path.join(__dirname, 'data', 'vs-logins.json');
const VS_TELEGRAM_BIND_PATH = path.join(__dirname, 'data', 'vs-telegram-bind.json');
const VS_SESSIONS_PATH = path.join(__dirname, 'data', 'vs-sessions.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней (скользящий — сбрасывается при каждом запросе)
const BIND_CODE_TTL_MS = 5 * 60 * 1000; // 5 мин

/** Модули интерфейса: stats, data, monitor, analysis, consolidation, docs, settings, shipments, receive, consolidation_form, reports, supplies */
const MODULES_BY_ROLE = {
  admin: ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'supplies'],
  group_leader: ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports'],
  supervisor: ['stats', 'data', 'monitor', 'analysis', 'docs', 'shipments', 'reports'],
  manager: ['stats', 'data', 'monitor', 'analysis', 'docs', 'shipments', 'reports'],
  developer: ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'supplies'],
};

const ALL_MODULES = ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'supplies'];

/** Действия — управляются отдельно от модулей */
const ALL_ACTIONS = ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'];

/** Действия по умолчанию для встроенных ролей */
const ACTIONS_BY_ROLE = {
  admin:        ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
  group_leader: ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
  supervisor:   ['fetch_data', 'recheck_data', 'request_fetch'],
  manager:      [],
  developer:    ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
};

function getActionsForRole(role) {
  return ACTIONS_BY_ROLE[role] || [];
}

/** Встроенные роли (нельзя удалить) */
const BUILTIN_ROLES = {
  admin:        'Администратор',
  group_leader: 'Руководитель группы',
  supervisor:   'Начальник смены',
  manager:      'Менеджер',
};

// ─── Custom roles ──────────────────────────────────────────────────────────────

function loadCustomRoles() {
  try {
    if (!fs.existsSync(VS_CUSTOM_ROLES_PATH)) return {};
    const raw = fs.readFileSync(VS_CUSTOM_ROLES_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.roles && typeof data.roles === 'object' ? data.roles : {};
  } catch { return {}; }
}

function saveCustomRoles(roles) {
  const dir = path.dirname(VS_CUSTOM_ROLES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_CUSTOM_ROLES_PATH, JSON.stringify({ roles }, null, 2), 'utf8');
}

function getAllRoles() {
  const custom = loadCustomRoles();
  const result = Object.entries(BUILTIN_ROLES).map(([k, label]) => ({
    key: k, label, modules: MODULES_BY_ROLE[k] || ALL_MODULES, builtin: true,
  }));
  for (const [k, v] of Object.entries(custom)) {
    result.push({ key: k, label: v.label || k, modules: v.modules || [], builtin: false });
  }
  return result;
}

function addCustomRole(key, label, modules) {
  let k = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!k) {
    // Авто-генерация ключа, если передан пустой или нелатинский ключ
    k = 'role_' + Date.now().toString(36);
  }
  if (BUILTIN_ROLES[k]) throw new Error('Нельзя переопределить встроенную роль');
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error('Ключ должен начинаться с буквы и содержать только латинские буквы, цифры и _');
  const roles = loadCustomRoles();
  roles[k] = {
    label: String(label || '').trim() || k,
    modules: Array.isArray(modules) ? modules.filter(m => ALL_MODULES.includes(m)) : [],
  };
  saveCustomRoles(roles);
  return k;
}

function updateCustomRole(key, label, modules) {
  if (BUILTIN_ROLES[key]) throw new Error('Нельзя изменить встроенную роль через этот метод');
  const roles = loadCustomRoles();
  if (!roles[key]) throw new Error('Роль не найдена');
  roles[key] = {
    label: String(label || '').trim() || key,
    modules: Array.isArray(modules) ? modules.filter(m => ALL_MODULES.includes(m)) : roles[key].modules || [],
  };
  saveCustomRoles(roles);
}

function deleteCustomRole(key) {
  if (BUILTIN_ROLES[key]) throw new Error('Нельзя удалить встроенную роль');
  const roles = loadCustomRoles();
  delete roles[key];
  saveCustomRoles(roles);
}

/** Проверить, является ли роль допустимой (встроенной или кастомной) */
function isValidRole(role) {
  if (!role) return false;
  if (BUILTIN_ROLES[role]) return true;
  const custom = loadCustomRoles();
  return !!custom[role];
}

/** Вернуть роль если допустима, иначе 'manager' */
function resolveRole(role) {
  return isValidRole(role) ? role : 'manager';
}

const sessions = new Map();

// ─── Персистентность сессий ────────────────────────────────────────────────

function loadSessions() {
  try {
    if (!fs.existsSync(VS_SESSIONS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(VS_SESSIONS_PATH, 'utf8'));
    const now = Date.now();
    for (const [sid, session] of Object.entries(data || {})) {
      const lastActive = session.lastActiveAt || session.createdAt || 0;
      if (now - lastActive <= SESSION_TTL_MS) {
        sessions.set(sid, session);
      }
    }
  } catch { /* игнорируем */ }
}

function saveSessions() {
  try {
    const dir = path.dirname(VS_SESSIONS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = {};
    for (const [sid, session] of sessions) {
      obj[sid] = session;
    }
    fs.writeFileSync(VS_SESSIONS_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* игнорируем */ }
}

// Загружаем сессии при старте
loadSessions();

function loadVsUsers() {
  try {
    const raw = fs.readFileSync(VS_USERS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.users) ? data.users : [];
  } catch {
    return [];
  }
}

function saveVsUsers(users) {
  const dir = path.dirname(VS_USERS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_USERS_PATH, JSON.stringify({ users }, null, 2), 'utf8');
}

function loadLogins() {
  try {
    if (!fs.existsSync(VS_LOGINS_PATH)) return {};
    const raw = fs.readFileSync(VS_LOGINS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.logins && typeof data.logins === 'object' ? data.logins : {};
  } catch {
    return {};
  }
}

function saveLogins(logins) {
  const dir = path.dirname(VS_LOGINS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_LOGINS_PATH, JSON.stringify({ logins }, null, 2), 'utf8');
}

// ─── Pending users (registration requests) ────────────────────────────────────

function loadPendingUsers() {
  try {
    if (!fs.existsSync(VS_PENDING_PATH)) return [];
    const raw = fs.readFileSync(VS_PENDING_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.pending) ? data.pending : [];
  } catch {
    return [];
  }
}

function savePendingUsers(pending) {
  const dir = path.dirname(VS_PENDING_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_PENDING_PATH, JSON.stringify({ pending }, null, 2), 'utf8');
}

/** Добавить заявку на регистрацию. Телефон нормализуется до 10 цифр. */
function addPendingUser(payload) {
  const { name, phone, wmsPhone, sitePasswordHash } = payload;
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Некорректный номер телефона');
  const pending = loadPendingUsers();
  const users = loadVsUsers();
  if (users.some(u => normalizePhone(u.login) === normalized)) {
    throw new Error('Пользователь с таким номером уже существует');
  }
  if (pending.some(p => normalizePhone(p.phone) === normalized)) {
    throw new Error('Заявка от этого номера уже ожидает рассмотрения');
  }
  pending.push({
    name: String(name || '').trim(),
    phone: '+7' + normalized,
    wmsPhone: String(wmsPhone || phone || '').replace(/\D/g, ''),
    sitePasswordHash,
    registeredAt: new Date().toISOString(),
    status: 'pending',
  });
  savePendingUsers(pending);
}

function getPendingUsers() {
  return loadPendingUsers();
}

/** Одобрить заявку: переносит в vs-users.json с указанной ролью. */
function approvePendingUser(phone, role, modules) {
  const normalized = normalizePhone(phone);
  const pending = loadPendingUsers();
  const idx = pending.findIndex(p => normalizePhone(p.phone) === normalized);
  if (idx === -1) throw new Error('Заявка не найдена');
  const entry = pending[idx];
  const validRole = resolveRole(role);
  const users = loadVsUsers();
  users.push({
    login: canonicalPhone(entry.phone) || entry.phone,
    name: entry.name || undefined,
    role: validRole,
    modules: Array.isArray(modules) && modules.length > 0 ? modules.filter(m => ALL_MODULES.includes(m)) : undefined,
    allowWithoutToken: false,
    passwordHash: entry.sitePasswordHash || undefined,
    wmsPhone: entry.wmsPhone || undefined,
  });
  saveVsUsers(users);
  pending.splice(idx, 1);
  savePendingUsers(pending);
}

/** Отклонить (удалить) заявку. */
function rejectPendingUser(phone) {
  const normalized = normalizePhone(phone);
  const pending = loadPendingUsers().filter(p => normalizePhone(p.phone) !== normalized);
  savePendingUsers(pending);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/** Канонический формат телефона для хранения: +7XXXXXXXXXX */
function canonicalPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const ten = digits.slice(-10);
  if (ten.length !== 10) return null;
  return '+7' + ten;
}

// ─── ──────────────────────────────────────────────────────────────────────────

/** Нормализация логина (телефон) для сравнения */
function normalizeLogin(login) {
  return String(login || '').replace(/\D/g, '').slice(-10);
}

/** Буквенный логин (не телефон): содержит буквы */
function isLetterLogin(login) {
  return /[a-zA-Zа-яА-ЯёЁ]/.test(String(login || '').trim());
}

/** Хеш пароля для хранения (соль:хеш в hex). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const idx = stored.indexOf(':');
  if (idx <= 0) return false;
  const salt = Buffer.from(stored.slice(0, idx), 'hex');
  const hash = Buffer.from(stored.slice(idx + 1), 'hex');
  const got = crypto.scryptSync(String(password), salt, 64);
  return got.length === hash.length && crypto.timingSafeEqual(got, hash);
}

/** Записать попытку входа. success = true если получен токен. */
function recordLoginAttempt(login, success) {
  const raw = String(login || '').trim();
  const key = isLetterLogin(raw) ? raw : (canonicalPhone(raw) || raw) || 'unknown';
  const logins = loadLogins();
  const now = new Date().toISOString();
  if (!logins[key]) logins[key] = { lastAttemptAt: null, lastSuccessAt: null };
  logins[key].lastAttemptAt = now;
  if (success) logins[key].lastSuccessAt = now;
  saveLogins(logins);
}

/**
 * Найти пользователя по логину. Возвращает { role, shiftType?, companyIds?, modules?, passwordHash? } или null.
 * Для буквенных логинов (passwordHash) сравнение по trim+lowercase.
 */
function findUserByLogin(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers();
  for (const u of users) {
    let match = false;
    if (u.passwordHash) {
      match = trimmed.toLowerCase() === String(u.login || '').trim().toLowerCase();
    } else {
      const uLogin = normalizeLogin(u.login);
      match = uLogin && (uLogin === normalized || u.login === login);
    }
    if (match) {
      const role = resolveRole(u.role);
      const modules = resolveModules(role, u.modules);
      const actions = Array.isArray(u.actions) ? u.actions.filter(a => ALL_ACTIONS.includes(a)) : getActionsForRole(role);
      return {
        name: u.name || undefined,
        role,
        shiftType: u.shiftType === 'day' || u.shiftType === 'night' ? u.shiftType : undefined,
        companyIds: Array.isArray(u.companyIds) ? u.companyIds : undefined,
        modules,
        actions,
        allowWithoutToken: !!u.allowWithoutToken,
        selfOnly: !!u.selfOnly,
        passwordHash: u.passwordHash || undefined,
      };
    }
  }
  return null;
}

function createSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Создать сессию после успешной авторизации Samokat.
 * user: { role, shiftType?, companyIds?, modules? }, login: string
 */
function createSession(user, login) {
  const sid = createSessionId();
  const now = Date.now();
  const session = {
    login: String(login || ''),
    role: user.role,
    name: user.name || undefined,
    shiftType: user.shiftType,
    companyIds: user.companyIds,
    modules: user.modules || getModulesForRole(user.role),
    allowWithoutToken: !!user.allowWithoutToken,
    selfOnly: !!user.selfOnly,
    createdAt: now,
    lastActiveAt: now,
  };
  sessions.set(sid, session);
  saveSessions();
  return sid;
}

function getSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  const lastActive = session.lastActiveAt || session.createdAt || 0;
  if (Date.now() - lastActive > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    saveSessions();
    return null;
  }
  // Скользящий TTL — обновляем время последней активности
  session.lastActiveAt = Date.now();
  // Сохраняем не при каждом запросе, а периодически (throttle)
  if (Date.now() - (session._savedAt || 0) > 5 * 60 * 1000) {
    session._savedAt = Date.now();
    saveSessions();
  }
  return session;
}

function destroySession(sessionId) {
  if (sessionId) {
    sessions.delete(sessionId);
    saveSessions();
  }
}

function getModulesForRole(role) {
  if (MODULES_BY_ROLE[role]) return MODULES_BY_ROLE[role];
  const custom = loadCustomRoles();
  if (custom[role]) return custom[role].modules || [];
  return MODULES_BY_ROLE.manager;
}

// Для привилегированных ролей (admin, developer) явно сохранённые модули дополняются
// дефолтами роли — чтобы новые модули всегда появлялись у них автоматически.
const PRIVILEGED_ROLES = ['admin', 'developer'];
function resolveModules(role, storedModules) {
  const roleDefaults = getModulesForRole(role);
  if (!Array.isArray(storedModules) || storedModules.length === 0) return roleDefaults;
  const filtered = storedModules.filter(m => ALL_MODULES.includes(m));
  if (PRIVILEGED_ROLES.includes(role)) {
    return [...new Set([...filtered, ...roleDefaults])];
  }
  return filtered;
}

/** Список пользователей для админа: из vs-users + данные о входах (успешный = получил токен). */
function getAllUsersForAdmin() {
  const users = loadVsUsers();
  const logins = loadLogins();
  const byLogin = new Map();
  for (const u of users) {
    const login = String(u.login || '').trim();
    if (!login) continue;
    const role = resolveRole(u.role);
    const modules = resolveModules(role, u.modules);
    // Ключ в logins-файле может быть как в новом (+7XXXXXXXXXX), так и в старом формате
    const loginKey = isLetterLogin(login) ? login : (canonicalPhone(login) || login);
    const rec = logins[loginKey] || logins[login] || {};
    const actions = Array.isArray(u.actions) ? u.actions.filter(a => ALL_ACTIONS.includes(a)) : getActionsForRole(role);
    byLogin.set(login, {
      login,
      name: u.name || null,
      role,
      shiftType: u.shiftType === 'day' || u.shiftType === 'night' ? u.shiftType : undefined,
      companyIds: Array.isArray(u.companyIds) ? u.companyIds : undefined,
      modules,
      actions,
      allowWithoutToken: !!u.allowWithoutToken,
      selfOnly: !!u.selfOnly,
      hasPassword: !!u.passwordHash,
      lastAttemptAt: rec.lastAttemptAt || null,
      lastSuccessAt: rec.lastSuccessAt || null,
      hasAccess: true,
    });
  }
  for (const [login, rec] of Object.entries(logins)) {
    if (!byLogin.has(login)) {
      byLogin.set(login, {
        login,
        role: null,
        shiftType: undefined,
        companyIds: undefined,
        modules: [],
        lastAttemptAt: rec.lastAttemptAt || null,
        lastSuccessAt: rec.lastSuccessAt || null,
        hasAccess: false,
      });
    }
  }
  return Array.from(byLogin.values()).sort((a, b) => (a.login || '').localeCompare(b.login || ''));
}

function userLoginMatch(u, login, normalized, trimmedLogin) {
  if (u.passwordHash) return trimmedLogin.toLowerCase() === String(u.login || '').trim().toLowerCase();
  return normalizeLogin(u.login) === normalized && normalized || u.login === login;
}

/** Сохранить/обновить пользователя (роль, модули, пароль). Только для админа. */
function saveUser(login, payload) {
  const trimmedLogin = String(login || '').trim();
  if (!trimmedLogin) throw new Error('Логин не указан');
  // Нормализуем телефонный логин: убираем скобки, пробелы, тире → +7XXXXXXXXXX
  const loginToStore = isLetterLogin(trimmedLogin) ? trimmedLogin : (canonicalPhone(trimmedLogin) || trimmedLogin);
  const normalized = normalizeLogin(login);
  const users = loadVsUsers();
  let found = false;
  for (const u of users) {
    if (!userLoginMatch(u, login, normalized, trimmedLogin)) continue;
    if (payload.name !== undefined) u.name = String(payload.name || '').trim() || undefined;
    if (payload.role !== undefined) u.role = resolveRole(payload.role);
    if (payload.modules !== undefined) u.modules = Array.isArray(payload.modules) ? payload.modules.filter(m => ALL_MODULES.includes(m)) : undefined;
    if (payload.shiftType !== undefined) u.shiftType = payload.shiftType === 'day' || payload.shiftType === 'night' ? payload.shiftType : undefined;
    if (payload.companyIds !== undefined) u.companyIds = Array.isArray(payload.companyIds) ? payload.companyIds : undefined;
    if (payload.allowWithoutToken !== undefined) u.allowWithoutToken = !!payload.allowWithoutToken;
    if (payload.selfOnly !== undefined) u.selfOnly = !!payload.selfOnly;
    if (payload.actions !== undefined) u.actions = Array.isArray(payload.actions) ? payload.actions.filter(a => ALL_ACTIONS.includes(a)) : undefined;
    if (payload.password !== undefined && String(payload.password).trim() !== '') {
      u.passwordHash = hashPassword(payload.password.trim());
    }
    found = true;
    break;
  }
  if (!found) {
    const role = resolveRole(payload.role);
    const modules = Array.isArray(payload.modules) ? payload.modules.filter(m => ALL_MODULES.includes(m)) : undefined;
    const newUser = {
      login: loginToStore,
      name: payload.name ? String(payload.name).trim() || undefined : undefined,
      role,
      shiftType: payload.shiftType === 'day' || payload.shiftType === 'night' ? payload.shiftType : undefined,
      companyIds: Array.isArray(payload.companyIds) ? payload.companyIds : undefined,
      modules: modules && modules.length > 0 ? modules : undefined,
      actions: Array.isArray(payload.actions) ? payload.actions.filter(a => ALL_ACTIONS.includes(a)) : undefined,
      allowWithoutToken: !!payload.allowWithoutToken,
      selfOnly: !!payload.selfOnly,
    };
    if (payload.password !== undefined && String(payload.password).trim() !== '') {
      newUser.passwordHash = hashPassword(payload.password.trim());
    }
    users.push(newUser);
  }
  saveVsUsers(users);
}

/** Удалить доступ пользователя (убрать из vs-users). */
function removeUser(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers().filter(u => !userLoginMatch(u, login, normalized, trimmed));
  saveVsUsers(users);
}

/** Telegram chat_id для пользователя (менеджер — отчёты в личку). */
function getTelegramChatId(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers();
  for (const u of users) {
    if (!userLoginMatch(u, login, normalized, trimmed)) continue;
    const id = u.telegramChatId;
    return id != null && String(id).trim() !== '' ? String(id).trim() : null;
  }
  return null;
}

function setTelegramChatId(login, chatId) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = loadVsUsers();
  for (const u of users) {
    if (!userLoginMatch(u, login, normalized, trimmed)) continue;
    u.telegramChatId = chatId != null ? String(chatId).trim() : '';
    saveVsUsers(users);
    return;
  }
}

// ─── Коды привязки Telegram (одноразовые, по времени) ─────────────────────────

function loadBindingCodes() {
  try {
    if (!fs.existsSync(VS_TELEGRAM_BIND_PATH)) return {};
    const raw = fs.readFileSync(VS_TELEGRAM_BIND_PATH, 'utf8');
    const data = JSON.parse(raw);
    return data.codes && typeof data.codes === 'object' ? data.codes : {};
  } catch {
    return {};
  }
}

function saveBindingCodes(codes) {
  const dir = path.dirname(VS_TELEGRAM_BIND_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VS_TELEGRAM_BIND_PATH, JSON.stringify({ codes }, null, 2), 'utf8');
}

function addBindingCode(code, login) {
  const codes = loadBindingCodes();
  codes[String(code).toUpperCase()] = {
    login: String(login || '').trim(),
    expiresAt: Date.now() + BIND_CODE_TTL_MS,
  };
  saveBindingCodes(codes);
}

/** Вернуть login и удалить код, если он валидный и не истёк. Иначе null. */
function consumeBindingCode(code) {
  const key = String(code).trim().toUpperCase();
  if (!key) return null;
  const codes = loadBindingCodes();
  const entry = codes[key];
  if (!entry || Date.now() > entry.expiresAt) return null;
  delete codes[key];
  saveBindingCodes(codes);
  return entry.login;
}

function createBindingCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
  loadVsUsers,
  findUserByLogin,
  createSession,
  getSession,
  destroySession,
  getModulesForRole,
  recordLoginAttempt,
  getAllUsersForAdmin,
  saveUser,
  removeUser,
  getTelegramChatId,
  setTelegramChatId,
  addBindingCode,
  consumeBindingCode,
  createBindingCode,
  loadBindingCodes,
  verifyPassword,
  hashPassword,
  isLetterLogin,
  MODULES_BY_ROLE,
  ALL_MODULES,
  ALL_ACTIONS,
  getActionsForRole,
  BUILTIN_ROLES,
  VS_USERS_PATH,
  addPendingUser,
  getPendingUsers,
  approvePendingUser,
  rejectPendingUser,
  normalizePhone,
  getAllRoles,
  addCustomRole,
  updateCustomRole,
  deleteCustomRole,
};
