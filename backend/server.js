const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const cookieParser = require('cookie-parser');
const { execFile } = require('child_process');
const { promisify } = require('util');
const scheduler = require('./scheduler');
const dataCollector = require('./data-collector');
const storage = require('./storage');
const vsAuth = require('./vs-auth');
const nodeAgent = require('./node-agent');
const productWeights = require('./product-weights');
const rkStorage = require('./route-rk-storage');
const excelReports = require('./excel-reports');

const app = express();
app.use(cookieParser());
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const execFileAsync = promisify(execFile);

try {
  app.use(require('compression')());
} catch (_) {
  // compression не установлен — сервер работает без gzip
}

// ✅ МАКСИМАЛЬНЫЙ ЛИМИТ - 1 ГИГАБАЙТ
app.use(express.json({ limit: '1024mb' }));
app.use(express.urlencoded({ extended: true, limit: '1024mb' }));

const DEFAULT_CONFIG = {
  token: '',
  refreshToken: '',
  intervalMinutes: 60,
  pageSize: 500,
  apiUrl: 'https://api.samokat.ru/wmsops-wwh/stocks/changes/search',
  useVpn: true,
  cookie: '',
  telegramBotToken: '',
  telegramChatId: '',
  telegramThreadId: '',
  telegramThreadIdIdles: '',
  telegramChats: [], // [{ chatId, threadIdConsolidation?, threadIdStats?, threadIdIdles?, label? }] — несколько чатов/пользователей
  telegramTimezone: 'Europe/Moscow', // часовой пояс для времени в уведомлениях (например Europe/Kaliningrad для UTC+2)
};

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ...DEFAULT_CONFIG };
    const out = { ...DEFAULT_CONFIG, ...config };
    if (!Array.isArray(out.telegramChats)) out.telegramChats = [];
    // Миграция: старые чаты с одним threadId → раздельные (консолидация + статистика)
    for (const chat of out.telegramChats) {
      if (chat.threadId && !chat.threadIdConsolidation && !chat.threadIdStats) {
        chat.threadIdConsolidation = chat.threadId;
        chat.threadIdStats = chat.threadId;
      }
      if (chat.threadIdStats && !chat.threadIdIdles) {
        chat.threadIdIdles = chat.threadIdStats;
      }
      if (chat.enabled === undefined) chat.enabled = true;
      if (!Array.isArray(chat.companiesFilter)) chat.companiesFilter = [];
    }
    if (out.telegramChats.length === 0 && (out.telegramChatId || '').trim()) {
      out.telegramChats = [{
        chatId: String(out.telegramChatId).trim(),
        threadIdConsolidation: String(out.telegramThreadId || '').trim(),
        threadIdStats: String(out.telegramThreadId || '').trim(),
        threadIdIdles: String(out.telegramThreadIdIdles || out.telegramThreadId || '').trim(),
        label: '',
        enabled: true,
        companiesFilter: [],
      }];
    }
    return out;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Список чатов для отправки: из telegramChats, только enabled !== false. companiesFilter: пустой = все компании. */
function getTelegramChats(config) {
  const list = Array.isArray(config.telegramChats) && config.telegramChats.length > 0
    ? config.telegramChats
    : (config.telegramChatId && String(config.telegramChatId).trim()
      ? [{
          chatId: String(config.telegramChatId).trim(),
          threadIdConsolidation: String(config.telegramThreadId || '').trim(),
          threadIdStats: String(config.telegramThreadId || '').trim(),
          threadIdIdles: String(config.telegramThreadIdIdles || config.telegramThreadId || '').trim(),
          enabled: true,
          companiesFilter: [],
        }]
      : []);
  return list
    .filter(c => c.enabled !== false && String(c.chatId || '').trim())
    .map(c => ({
      chatId: String(c.chatId || '').trim(),
      threadIdConsolidation: parseTelegramThreadId(c.threadIdConsolidation) || parseTelegramThreadId(c.threadId),
      threadIdStats: parseTelegramThreadId(c.threadIdStats) || parseTelegramThreadId(c.threadId),
      threadIdIdles: parseTelegramThreadId(c.threadIdIdles) || parseTelegramThreadId(c.threadIdStats) || parseTelegramThreadId(c.threadId),
      companiesFilter: Array.isArray(c.companiesFilter) ? c.companiesFilter.filter(x => x != null && String(x).trim()) : [],
    }));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

async function doFetch() {
  try {
    const result = await dataCollector.fetchFromAPI();
    return { success: true, ...result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      status: err.status,
      data: err.data,
    };
  }
}

scheduler.setFetchHandler(doFetch);

let fetchRequested = false;
let eoRefreshQueue = []; // routeId[] — очередь запросов на обновление ЕО

// API-маршруты регистрируем до статики, чтобы POST /api/empl и др. не отдавали index.html
app.get('/api/status', (req, res) => {
  try {
    const config = loadConfig();
    res.json({
      scheduleRunning: scheduler.isRunning(),
      tokenRefresherRunning: false,
      lastRun: scheduler.getLastRun(),
      fetchRequested,
      eoRefreshQueue,
      config: {
        ...config,
        token: config.token ? '***' : '',
        refreshToken: config.refreshToken ? '***' : '',
        cookie: config.cookie ? '***' : '',
        intervalMinutes: config.intervalMinutes ?? 60,
        pageSize: config.pageSize ?? 500,
      },
    });
  } catch (err) {
    console.error('GET /api/status', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fetch-data', async (req, res) => {
  try {
    const config = loadConfig();
    const token = req.body?.token || config.token;
    const options = req.body?.options || {};
    const result = await dataCollector.fetchFromAPI(token, options);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || 'Ошибка запроса данных';
    if (status >= 500) console.error('POST /api/fetch-data:', message);
    else console.error('POST /api/fetch-data', err);
    res.status(status).json({
      success: false,
      error: message,
      data: err.data,
    });
  }
});

app.get('/api/config', (req, res) => {
  try {
    const c = loadConfig();
    const out = { ...c, token: c.token ? '***' : '' };
    if (out.refreshToken) out.refreshToken = '***';
    if (out.cookie) out.cookie = '***';
    if (out.telegramBotToken) out.telegramBotToken = '***';
    res.json(out);
  } catch (err) {
    console.error('GET /api/config', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const body = req.body || {};
    const config = loadConfig();
    
    if (body.token !== undefined) config.token = String(body.token).trim();
    if (body.refreshToken !== undefined) config.refreshToken = String(body.refreshToken).trim();
    if (body.connectionMode !== undefined) config.connectionMode = body.connectionMode;
    if (body.intervalMinutes !== undefined) config.intervalMinutes = Math.max(1, parseInt(body.intervalMinutes, 10) || 60);
    if (body.pageSize !== undefined) config.pageSize = Math.min(1000, Math.max(1, parseInt(body.pageSize, 10) || 500));
    if (body.useVpn !== undefined) config.useVpn = !!body.useVpn;
    if (body.cookie !== undefined) config.cookie = typeof body.cookie === 'string' ? body.cookie : '';
    if (body.telegramBotToken !== undefined) config.telegramBotToken = typeof body.telegramBotToken === 'string' ? body.telegramBotToken.trim() : '';
    if (body.telegramChatId !== undefined) config.telegramChatId = typeof body.telegramChatId === 'string' ? body.telegramChatId.trim() : '';
    if (body.telegramThreadId !== undefined) config.telegramThreadId = typeof body.telegramThreadId === 'string' ? body.telegramThreadId.trim() : '';
    if (body.telegramThreadIdIdles !== undefined) config.telegramThreadIdIdles = typeof body.telegramThreadIdIdles === 'string' ? body.telegramThreadIdIdles.trim() : '';
    if (body.telegramChats !== undefined) {
      config.telegramChats = Array.isArray(body.telegramChats)
        ? body.telegramChats.map(c => ({
            chatId: String(c.chatId != null ? c.chatId : '').trim(),
            threadIdConsolidation: String(c.threadIdConsolidation != null ? c.threadIdConsolidation : '').trim(),
            threadIdStats: String(c.threadIdStats != null ? c.threadIdStats : '').trim(),
            threadIdIdles: String(c.threadIdIdles != null ? c.threadIdIdles : '').trim(),
            label: String(c.label != null ? c.label : '').trim(),
            enabled: c.enabled !== false,
            companiesFilter: Array.isArray(c.companiesFilter) ? c.companiesFilter.map(x => String(x).trim()).filter(Boolean) : [],
          })).filter(c => c.chatId)
        : [];
      if (config.telegramChats.length === 0) config.telegramChatId = '';
      if (config.telegramChats.length === 0) config.telegramThreadId = '';
    }
    if (body.telegramTimezone !== undefined) config.telegramTimezone = typeof body.telegramTimezone === 'string' && body.telegramTimezone.trim() ? body.telegramTimezone.trim() : 'Europe/Moscow';
    saveConfig(config);
    
    const out = { ...config, token: config.token ? '***' : '' };
    if (out.refreshToken) out.refreshToken = '***';
    if (out.cookie) out.cookie = '***';
    if (out.telegramBotToken) out.telegramBotToken = '***';
    
    res.json({ ok: true, config: out });
  } catch (err) {
    console.error('PUT /api/config', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/missing-weight — пересобираем через .NET и возвращаем свежий список
app.get('/api/missing-weight', async (req, res) => {
  try {
    await rebuildMissingWeightDotnet();
  } catch (err) {
    console.error('[missing-weight] rebuild failed:', err.message);
  }
  res.json(loadMissingWeight());
});

// POST /api/missing-weight/rebuild — пересборка через .NET-инструмент
app.post('/api/missing-weight/rebuild', async (req, res) => {
  try {
    const count = await rebuildMissingWeightDotnet();
    if (count == null) return res.status(500).json({ ok: false, error: 'dotnet tool not available' });
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/missing-weight/sync — синхронизация: добавить новые, убрать получившие вес
// body: { missing: [{name, article}], withWeight: [article_or_name] }
app.post('/api/missing-weight/sync', (req, res) => {
  try {
    const missing = Array.isArray(req.body.missing) ? req.body.missing : [];
    const withWeight = new Set(Array.isArray(req.body.withWeight) ? req.body.withWeight : []);

    const current = loadMissingWeight();
    // Индекс по ключу (article если есть, иначе name)
    const byKey = new Map();
    for (const item of current) {
      const key = (item.article && String(item.article).trim()) || String(item.name).trim();
      if (key) byKey.set(key, item);
    }
    // Добавляем новые
    for (const item of missing) {
      const key = (item.article && String(item.article).trim()) || String(item.name).trim();
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, { name: String(item.name || '').trim(), article: String(item.article || '').trim() });
    }
    // Удаляем те, у которых появился вес (от фронта)
    for (const key of withWeight) {
      byKey.delete(String(key).trim());
    }
    // Дополнительно удаляем всё, что теперь есть в Excel-таблице весов
    for (const [key, item] of byKey) {
      const article = String(item.article || '').trim();
      if (article && productWeights.getWeightGrams(article) > 0) {
        byKey.delete(key);
      }
    }

    const updated = [...byKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    saveMissingWeight(updated);
    res.json({ ok: true, count: updated.length });
  } catch (err) {
    console.error('POST /api/missing-weight/sync', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/history', (req, res) => {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) return res.json([]);
  const files = fs.readdirSync(dataDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.light.json'))
    .map(f => {
      const stat = fs.statSync(path.join(dataDir, f));
      return { name: f, mtime: stat.mtime, size: stat.size };
    })
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
    .slice(0, 50);
  res.json(files);
});

app.get('/api/data/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  if (!name.endsWith('.json') || name.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(__dirname, 'data', name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json(data);
});

const DATA_DIR = path.join(__dirname, 'data');
const EMPL_CSV_PATH = path.join(__dirname, '..', 'empl.csv');
const MISSING_WEIGHT_PATH = path.join(DATA_DIR, 'missing_weight.json');
const NAMES_REGISTRY_PATH = path.join(DATA_DIR, 'names_registry.json');

function normPkForRegistry(fio) {
  const norm = String(fio || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const parts = norm.split(' ').filter(Boolean);
  if (!parts.length) return norm;
  const init = parts.length > 1 ? parts[1].charAt(0) : '';
  return (parts[0] + ' ' + init).trim();
}

function updateNamesRegistry(items) {
  let registry = {};
  try {
    if (fs.existsSync(NAMES_REGISTRY_PATH))
      registry = JSON.parse(fs.readFileSync(NAMES_REGISTRY_PATH, 'utf8'));
  } catch {}

  let changed = false;
  const itemNames = new Map(); // pk -> best full name from current items
  for (const item of (items || [])) {
    const ru = item.responsibleUser || {};
    const full = [ru.lastName, ru.firstName, ru.middleName].filter(Boolean).join(' ').trim();
    if (!full) continue;
    const pk = normPkForRegistry(full);
    const existing = registry[pk];
    if (!existing || full.split(/\s+/).length > existing.split(/\s+/).length) {
      registry[pk] = full;
      changed = true;
    }
    const cur = itemNames.get(pk);
    if (!cur || full.split(/\s+/).length > cur.split(/\s+/).length) {
      itemNames.set(pk, full);
    }
  }

  if (changed) {
    try { fs.writeFileSync(NAMES_REGISTRY_PATH, JSON.stringify(registry), 'utf8'); } catch {}
  }

  // Обновляем empl.csv — заменяем короткие имена на полные, собираем existingPks
  const existingPks = new Set();
  if (fs.existsSync(EMPL_CSV_PATH)) {
    try {
      const text = readEmplCsvText();
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      let csvChanged = false;
      const newLines = lines.map(line => {
        const t = line.trim();
        if (!t) return line;
        const idx = t.indexOf(';');
        const fio = idx >= 0 ? t.slice(0, idx).trim() : t.trim();
        if (fio) existingPks.add(normPkForRegistry(fio));
        if (idx < 0 || !fio) return line;
        const company = t.slice(idx + 1).trim();
        const fullFio = registry[normPkForRegistry(fio)];
        if (fullFio && fullFio.split(/\s+/).length > fio.split(/\s+/).length) {
          csvChanged = true;
          const titled = fullFio.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
          return titled + ';' + company;
        }
        return line;
      });
      if (csvChanged) {
        fs.writeFileSync(EMPL_CSV_PATH, Buffer.from('\uFEFF' + newLines.join('\n'), 'utf8'));
      }
    } catch {}
  }

  // Возвращаем имена из текущей выгрузки, которых нет в empl.csv
  const newNames = [];
  for (const [pk, full] of itemNames) {
    if (!existingPks.has(pk)) {
      const titled = full.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      newNames.push(titled);
    }
  }
  return { newNames };
}

function loadMissingWeight() {
  try {
    if (fs.existsSync(MISSING_WEIGHT_PATH)) return JSON.parse(fs.readFileSync(MISSING_WEIGHT_PATH, 'utf8'));
  } catch (_) {}
  return [];
}

function saveMissingWeight(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MISSING_WEIGHT_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function getDotnetMissingWeightRebuildCmd() {
  const dll = path.join(__dirname, '..', 'tools', 'MissingWeightRebuild', 'bin', 'Release', 'net9.0', 'MissingWeightRebuild.dll');
  if (fs.existsSync(dll)) return { exe: 'dotnet', args: [dll] };
  const proj = path.join(__dirname, '..', 'tools', 'MissingWeightRebuild', 'MissingWeightRebuild.csproj');
  if (fs.existsSync(proj)) return { exe: 'dotnet', args: ['run', '--project', proj, '--'] };
  return null;
}

/**
 * Перестраивает missing_weight.json через .NET-инструмент.
 * Не требует участия фронта — инструмент сам обходит все data/YYYY-MM-DD/HH.json.
 */
async function rebuildMissingWeightDotnet() {
  const cmd = getDotnetMissingWeightRebuildCmd();
  if (!cmd) { console.warn('[missing-weight] dotnet tool not found'); return null; }

  // Экспортируем таблицу весов во временный JSON { article: grams }
  const weightsObj = Object.fromEntries(productWeights.getMap());
  const tmpDir = path.join(DATA_DIR, 'raw_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const weightsPath = path.join(tmpDir, `weights_${Date.now()}.json`);
  fs.writeFileSync(weightsPath, JSON.stringify(weightsObj), 'utf8');

  try {
    const { stdout } = await execFileAsync(
      cmd.exe,
      cmd.args.concat(['--data-dir', DATA_DIR, '--weights', weightsPath, '--out', MISSING_WEIGHT_PATH]),
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
    const parsed = stdout ? JSON.parse(stdout.trim()) : null;
    if (parsed?.ok) return parsed.count;
    return null;
  } finally {
    try { fs.unlinkSync(weightsPath); } catch {}
  }
}

// ─── Консолидация: multer + paths ──────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CONSOLIDATION_PATH = path.join(__dirname, 'data', 'consolidation.json');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  },
});

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения (PNG)'));
  },
});

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function loadComplaints() {
  try {
    if (!fs.existsSync(CONSOLIDATION_PATH)) return [];
    return JSON.parse(fs.readFileSync(CONSOLIDATION_PATH, 'utf8'));
  } catch { return []; }
}

function saveComplaints(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONSOLIDATION_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function tgSafe(v) {
  return String(v == null ? '' : v).trim();
}

function escapeTgHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Экранирование для Telegram Markdown (* и _ в контенте не должны ломать разметку) */
function escapeTgMarkdown(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[');
}

function formatComplaintForTelegram(c, photoUrl, config = {}, companyResolved = null) {
  const dt = c?.operationCompletedAt || c?.createdAt || '';
  const tz = (config && config.telegramTimezone) || 'Europe/Moscow';
  const dateText = dt
    ? new Date(dt).toLocaleString('ru-RU', { timeZone: tz })
    : '—';
  const company = companyResolved != null ? companyResolved : (c.company != null && String(c.company).trim() !== '' ? c.company : '—');
  const v = (x) => escapeTgMarkdown(tgSafe(x) || '—');
  const dateEsc = escapeTgMarkdown(dateText);
  // Markdown: *текст* = жирный в Telegram
  return [
    `*Компания:* ${v(company)}`,
    `*Нарушитель:* ${v(c.violator)}`,
    `*Место:* ${v(c.cell)}`,
    `*ЕО:* ${v(c.handlingUnitBarcode)}`,
    `*ШК:* ${v(c.productBarcode)}`,
    `*Товар:* ${v(c.productName)}`,
    `*Время:* ${dateEsc}`,
    `*Фото:* ${photoUrl ? '✅' : '—'}`,
  ].join('\n');
}

function parseTelegramThreadId(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function sendTelegramMessage(botToken, chatId, text, threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (threadId) payload.message_thread_id = threadId;
  if (parseMode) payload.parse_mode = parseMode;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramPhoto(botToken, chatId, caption, photoPath, photoFilename = 'photo.jpg', threadId = null, parseMode = null) {
  const fileBuf = fs.readFileSync(photoPath);
  return sendTelegramPhotoFromBuffer(botToken, chatId, caption, fileBuf, photoFilename, threadId, parseMode);
}

async function sendTelegramPhotoFromBuffer(botToken, chatId, caption, buffer, photoFilename = 'photo.png', threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  const blob = new Blob([buffer]);
  form.append('photo', blob, photoFilename);
  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramDocumentFromBuffer(botToken, chatId, caption, buffer, documentFilename = 'file.png', threadId = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendDocument`;
  const form = new FormData();
  form.append('chat_id', chatId);
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption);
  const blob = new Blob([buffer]);
  form.append('document', blob, documentFilename);
  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

async function sendTelegramMediaGroup(botToken, chatId, caption, files, threadId = null, parseMode = null) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMediaGroup`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));

  const media = files.map((f, i) => {
    const item = { type: 'photo', media: `attach://photo${i}` };
    if (i === 0 && caption) {
      item.caption = caption;
      if (parseMode) item.parse_mode = parseMode;
    }
    return item;
  });
  form.append('media', JSON.stringify(media));

  files.forEach((f, i) => {
    const buf = fs.readFileSync(f.path);
    const blob = new Blob([buf]);
    form.append(`photo${i}`, blob, f.name || `photo_${i + 1}.jpg`);
  });

  const response = await fetch(url, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const e = new Error(data?.description || `Telegram API ${response.status}`);
    e.status = response.status;
    throw e;
  }
}

// save-fetched-data: мерж по часам (обработка на .NET). Без долговременного raw.
app.post('/api/save-fetched-data', async (req, res) => {
  try {
    const t0 = Date.now();
    const body = req.body || {};
    const value = body.value || body;
    const items = Array.isArray(value?.items) ? value.items : [];
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // Сохраняем полные имена (с отчеством) до удаления raw-файла
    let newEmployees = [];
    if (items.length > 0) {
      const regResult = updateNamesRegistry(items);
      newEmployees = regResult.newNames || [];
    }

    let engine = 'dotnet';
    let mergeResult = { added: 0, skipped: 0, byShift: {} };
    let dotnetMs = 0;
    let rawMs = 0;

    if (items.length > 0) {
      const dotnetCmd = getDotnetSaveFetchedCmd();
      if (!dotnetCmd) {
        console.error('save-fetched-data dotnet error: dotnet not found');
        return res.status(500).json({ ok: false, error: 'dotnet not found' });
      }
      // временный raw для .NET (после обработки удаляем)
      const tmpDir = path.join(DATA_DIR, 'raw_tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const rawName = `fetched_${Date.now()}.json`;
      const rawPath = path.join(tmpDir, rawName);
      const tRawStart = Date.now();
      fs.writeFileSync(rawPath, JSON.stringify(value), 'utf8');
      rawMs = Date.now() - tRawStart;
      try {
        const tDotnetStart = Date.now();
        const { stdout } = await execFileAsync(dotnetCmd.exe, dotnetCmd.args.concat(['--input', rawPath, '--data-dir', DATA_DIR]), {
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        });
        dotnetMs = Date.now() - tDotnetStart;
        const parsed = stdout ? JSON.parse(stdout) : null;
        if (parsed && parsed.ok) {
          mergeResult = {
            added: Number(parsed.added) || 0,
            skipped: Number(parsed.skipped) || 0,
            byShift: parsed.byShift || {},
          };
        } else {
          console.error('save-fetched-data dotnet error: invalid response');
          return res.status(500).json({ ok: false, error: 'dotnet: invalid response' });
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error('save-fetched-data dotnet error:', msg);
        return res.status(500).json({ ok: false, error: msg });
      } finally {
        try { fs.unlinkSync(rawPath); } catch {}
      }
    }

    const shiftKeys = Object.keys(mergeResult.byShift || {});
    const savedTo = shiftKeys.length ? shiftKeys.join(', ') : 'hourly';

    // Обновляем список неучтённых товаров в фоне после сохранения новых данных
    rebuildMissingWeightDotnet()
      .then(count => { if (count != null) console.log(`[missing-weight] Обновлено после fetch: ${count} товаров`); })
      .catch(() => {});

    res.json({
      ok: true,
      engine,
      savedTo,
      added: mergeResult.added,
      skipped: mergeResult.skipped,
      itemsCount: items.length,
      newEmployees,
      timings: {
        totalMs: Date.now() - t0,
        rawWriteMs: rawMs,
        dotnetMs,
      },
    });
  } catch (err) {
    console.error('POST /api/save-fetched-data', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function getDotnetSaveFetchedCmd() {
  const toolDll = path.join(__dirname, '..', 'tools', 'SaveFetchedData', 'bin', 'Release', 'net9.0', 'SaveFetchedData.dll');
  if (fs.existsSync(toolDll)) {
    return { exe: 'dotnet', args: [toolDll] };
  }
  const toolProj = path.join(__dirname, '..', 'tools', 'SaveFetchedData', 'SaveFetchedData.csproj');
  if (fs.existsSync(toolProj)) {
    return { exe: 'dotnet', args: ['run', '--project', toolProj, '--'] };
  }
  return null;
}

function getDotnetArticleSpeedsCmd() {
  const toolDll = path.join(__dirname, '..', 'tools', 'ArticleSpeeds', 'bin', 'Release', 'net9.0', 'ArticleSpeeds.dll');
  if (fs.existsSync(toolDll)) return { exe: 'dotnet', args: [toolDll] };
  const toolProj = path.join(__dirname, '..', 'tools', 'ArticleSpeeds', 'ArticleSpeeds.csproj');
  if (fs.existsSync(toolProj)) return { exe: 'dotnet', args: ['run', '--project', toolProj, '--'] };
  return null;
}

function readEmplCsvText() {
  const buf = fs.readFileSync(EMPL_CSV_PATH);
  // UTF-8 BOM (EF BB BF) — сохранено через /api/employees
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  // Важно: buf.toString('utf8') подставляет U+FFFD (�) на битых байтах и может дать ложные совпадения.
  // Надёжнее: строгая проверка UTF-8 (fatal), иначе — cp1251 (часто Excel).
  try {
    const td = new TextDecoder('utf-8', { fatal: true });
    return td.decode(buf);
  } catch {
    const iconv = require('iconv-lite');
    return iconv.decode(buf, 'cp1251');
  }
}

/** Карта нормализованное ФИО -> компания для фильтра по роли manager */
function getEmplMapFioToCompany() {
  const map = new Map();
  if (!fs.existsSync(EMPL_CSV_PATH)) return map;
  let text;
  try {
    text = readEmplCsvText();
  } catch {
    return map;
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.indexOf(';');
    if (idx < 0) continue;
    const fio = t.slice(0, idx).trim();
    const company = t.slice(idx + 1).trim();
    if (fio) {
      const key = fio.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!map.has(key)) map.set(key, company);
    }
  }
  return map;
}

function normalizeFioForMatch(fio) {
  return String(fio || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getCompanyByFio(emplMap, executorFio) {
  const norm = normalizeFioForMatch(executorFio);
  if (!norm) return null;
  for (const [key, company] of emplMap) {
    if (norm === key || norm.includes(key) || key.includes(norm)) return company;
  }
  return null;
}

// Веса товаров из Excel для фронтенда (article -> grams)
app.get('/api/product-weights', (req, res) => {
  try {
    res.json(Object.fromEntries(productWeights.getMap()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Веса товаров: загрузка Excel (только админ) ───────────────────────────

const uploadWeightsExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname) ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel';
    if (ok) cb(null, true); else cb(new Error('Только Excel-файлы (.xlsx, .xls)'));
  },
});

const EXCEL_PATH = path.join(__dirname, 'data.xlsx');

app.get('/api/vs/admin/product-weights/info', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const exists = fs.existsSync(EXCEL_PATH);
    if (!exists) return res.json({ exists: false, count: 0 });
    const stat = fs.statSync(EXCEL_PATH);
    const count = productWeights.getMap().size;
    res.json({ exists: true, updatedAt: stat.mtime.toISOString(), sizeBytes: stat.size, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vs/admin/product-weights/upload', vsSessionRequired, vsAdminRequired, uploadWeightsExcel.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    fs.writeFileSync(EXCEL_PATH, req.file.buffer);
    const map = productWeights.reload();
    res.json({ ok: true, count: map.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vs/admin/product-weights', vsSessionRequired, vsAdminRequired, (_req, res) => {
  try {
    if (fs.existsSync(EXCEL_PATH)) fs.unlinkSync(EXCEL_PATH);
    productWeights.reload();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/empl', (req, res) => {
  if (!fs.existsSync(EMPL_CSV_PATH)) {
    return res.json({ employees: [], companies: [] });
  }
  let text;
  try {
    text = readEmplCsvText();
  } catch {
    return res.json({ employees: [], companies: [] });
  }
  const employees = [];
  const companySet = new Set();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.indexOf(';');
    if (idx < 0) continue;
    const fio = t.slice(0, idx).trim();
    const company = t.slice(idx + 1).trim();
    if (fio) {
      employees.push({ fio, company });
      if (company) companySet.add(company);
    }
  }
  res.json({ employees, companies: [...companySet].sort() });
});

function appendToEmplCsv(fio, company) {
  const line = String(fio).trim().replace(/;/g, ',') + ';' + String(company).trim().replace(/[\r\n]/g, ' ') + '\n';
  // Файл empl.csv хранится в UTF-8 (с BOM при первом сохранении через /api/employees).
  // Дописываем тоже в UTF-8, чтобы не смешивать кодировки.
  fs.appendFileSync(EMPL_CSV_PATH, Buffer.from(line, 'utf8'));
}

app.post('/api/empl', (req, res) => {
  try {
    const { fio, company } = req.body || {};
    if (!fio || typeof fio !== 'string' || !fio.trim()) {
      return res.status(400).json({ ok: false, error: 'Укажите ФИО' });
    }
    appendToEmplCsv(fio.trim(), (company != null ? String(company) : '').trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/empl', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/empl/add-new — добавить новых сотрудников в empl.csv (без компании)
app.post('/api/empl/add-new', (req, res) => {
  try {
    const names = Array.isArray(req.body?.names) ? req.body.names : [];
    if (!names.length) return res.json({ ok: true, added: 0 });

    let lines = [];
    if (fs.existsSync(EMPL_CSV_PATH)) {
      const text = readEmplCsvText();
      lines = text.replace(/\r\n/g, '\n').split('\n');
    }

    // Собираем существующие pk чтобы не дублировать
    const existingPks = new Set();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const idx = t.indexOf(';');
      const fio = idx >= 0 ? t.slice(0, idx).trim() : t.trim();
      if (fio) existingPks.add(normPkForRegistry(fio));
    }

    let added = 0;
    for (const name of names) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      if (existingPks.has(normPkForRegistry(trimmed))) continue;
      lines.push(trimmed + ';');
      existingPks.add(normPkForRegistry(trimmed));
      added++;
    }

    if (added > 0) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      if (!fs.existsSync(EMPL_CSV_PATH)) {
        if (!fs.existsSync(path.dirname(EMPL_CSV_PATH))) fs.mkdirSync(path.dirname(EMPL_CSV_PATH), { recursive: true });
      }
      fs.writeFileSync(EMPL_CSV_PATH, Buffer.from('\uFEFF' + lines.join('\n'), 'utf8'));
    }

    // Возвращаем обновлённый список
    const employees = [];
    const companies = new Set();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const idx = t.indexOf(';');
      const fio = idx >= 0 ? t.slice(0, idx).trim() : t.trim();
      const company = idx >= 0 ? t.slice(idx + 1).trim() : '';
      if (fio) {
        employees.push({ fio, company });
        if (company) companies.add(company);
      }
    }

    res.json({ ok: true, added, employees, companies: [...companies].sort() });
  } catch (err) {
    console.error('POST /api/empl/add-new', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/empl/enrich-names — обогатить empl.csv отчествами из сырых WMS-файлов
app.post('/api/empl/enrich-names', (req, res) => {
  try {
    // Читаем реестр имён (накапливается при каждом fetch из WMS)
    let registry = {};
    try {
      if (fs.existsSync(NAMES_REGISTRY_PATH))
        registry = JSON.parse(fs.readFileSync(NAMES_REGISTRY_PATH, 'utf8'));
    } catch {}

    // Также добавляем имена из raw_tmp (если там что-то осталось)
    const RAW_TMP_DIR = path.join(DATA_DIR, 'raw_tmp');
    if (fs.existsSync(RAW_TMP_DIR)) {
      const rawFiles = fs.readdirSync(RAW_TMP_DIR).filter(f => f.endsWith('.json') && !f.startsWith('weights_'));
      for (const file of rawFiles) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(RAW_TMP_DIR, file), 'utf8'));
          for (const item of (raw?.value?.items || raw?.items || [])) {
            const ru = item.responsibleUser || {};
            const full = [ru.lastName, ru.firstName, ru.middleName].filter(Boolean).join(' ').trim();
            if (!full) continue;
            const pk = normPkForRegistry(full);
            const ex = registry[pk];
            if (!ex || full.split(/\s+/).length > ex.split(/\s+/).length) registry[pk] = full;
          }
        } catch {}
      }
    }

    if (Object.keys(registry).length === 0 || !fs.existsSync(EMPL_CSV_PATH)) {
      return res.json({ ok: true, updated: 0, employees: [], companies: [] });
    }

    const text = readEmplCsvText();
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let updated = 0;

    const newLines = lines.map(line => {
      const t = line.trim();
      if (!t) return line;
      const idx = t.indexOf(';');
      if (idx < 0) return line;
      const fio = t.slice(0, idx).trim();
      const company = t.slice(idx + 1).trim();
      if (!fio) return line;
      const fullFio = registry[normPkForRegistry(fio)];
      if (fullFio && fullFio.split(/\s+/).length > fio.split(/\s+/).length) {
        updated++;
        const titled = fullFio.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        return titled + ';' + company;
      }
      return line;
    });

    if (updated > 0) {
      fs.writeFileSync(EMPL_CSV_PATH, Buffer.from('\uFEFF' + newLines.join('\n'), 'utf8'));
    }

    const employees = [];
    const companySet = new Set();
    for (const line of newLines) {
      const t = line.trim();
      if (!t) continue;
      const idx = t.indexOf(';');
      if (idx < 0) continue;
      const fio = t.slice(0, idx).trim();
      const company = t.slice(idx + 1).trim();
      if (fio) { employees.push({ fio, company }); if (company) companySet.add(company); }
    }

    res.json({ ok: true, updated, employees, companies: [...companySet].sort() });
  } catch (err) {
    console.error('POST /api/empl/enrich-names', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Авторизация /vs: сессия + роли ─────────────────────────────────────────────

const SAMOKAT_AUTH_URL = 'https://api.samokat.ru/wmsin-wwh/auth/password';
const VS_SESSION_COOKIE = 'vs_sid';

async function samokatLogin(login, password) {
  const r = await fetch(SAMOKAT_AUTH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://wwh.samokat.ru',
      Referer: 'https://wwh.samokat.ru/',
    },
    body: JSON.stringify({ login, password }),
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`Ошибка авторизации Samokat: ${r.status}`);
    err.status = r.status;
    try {
      const data = JSON.parse(text);
      if (data.message) err.message = data.message;
    } catch {}
    throw err;
  }
  return r.json();
}

app.post('/api/vs/auth/register', async (req, res) => {
  try {
    const { name, phone, sitePassword } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: 'Укажите ФИО' });
    if (!phone || !String(phone).trim()) return res.status(400).json({ ok: false, error: 'Укажите номер телефона' });
    if (!sitePassword || !String(sitePassword).trim()) return res.status(400).json({ ok: false, error: 'Укажите пароль от сайта' });
    const sitePasswordHash = vsAuth.hashPassword(String(sitePassword).trim());
    vsAuth.addPendingUser({ name: String(name).trim(), phone, wmsPhone: phone, sitePasswordHash });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Ошибка регистрации' });
  }
});

app.post('/api/vs/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ ok: false, error: 'Укажите логин и пароль' });
    }
    const user = vsAuth.findUserByLogin(login);
    if (!user) {
      vsAuth.recordLoginAttempt(login, false);
      // Проверяем — может быть заявка на регистрацию ещё не одобрена
      const pending = vsAuth.getPendingUsers();
      const isPending = pending.some(p => vsAuth.normalizePhone(p.phone) === vsAuth.normalizePhone(login));
      if (isPending) {
        return res.status(403).json({ ok: false, error: 'Ваша заявка на доступ ещё не одобрена администратором' });
      }
      return res.status(403).json({ ok: false, error: 'Вы не зарегистрованы на сайте' });
    }

    const userActions = Array.isArray(user.actions) ? user.actions : vsAuth.getActionsForRole(user.role);
    const companyIds  = user.role === 'manager' && Array.isArray(user.companyIds) ? user.companyIds : undefined;

    // Пробуем пароль от сайта (если задан)
    if (user.passwordHash && vsAuth.verifyPassword(password, user.passwordHash)) {
      vsAuth.recordLoginAttempt(login, true);
      const sessionId = vsAuth.createSession(user, login);
      const modules = user.modules || vsAuth.getModulesForRole(user.role);
      res.cookie(VS_SESSION_COOKIE, sessionId, { httpOnly: true, path: '/', maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
      // Если пользователю нужен WMS-токен — пробуем тот же пароль в WMS
      if (!user.allowWithoutToken) {
        try {
          const samokatRes = await samokatLogin(login, password);
          const accessToken = samokatRes?.value?.accessToken;
          const refreshToken = samokatRes?.value?.refreshToken;
          const expiresIn = samokatRes?.value?.expiresIn || 300;
          if (accessToken) {
            return res.json({
              ok: true, role: user.role, modules, actions: userActions, accessToken, expiresIn,
              refreshToken: refreshToken || '',
              name: user.name || undefined, companyIds,
            });
          }
        } catch { /* WMS пароль не совпал — входим без токена */ }
      }
      return res.json({
        ok: true, role: user.role, modules, actions: userActions,
        allowWithoutToken: user.allowWithoutToken,
        name: user.name || undefined, companyIds,
      });
    }

    // Если пользователь «без токена» и пароль уже проверен выше — отказ
    if (user.allowWithoutToken && user.passwordHash) {
      vsAuth.recordLoginAttempt(login, false);
      return res.status(401).json({ ok: false, error: 'Неверный пароль' });
    }

    // allowWithoutToken без пароля (старый формат) — разрешаем
    if (user.allowWithoutToken && !user.passwordHash) {
      vsAuth.recordLoginAttempt(login, true);
      const sessionId = vsAuth.createSession(user, login);
      const modules = user.modules || vsAuth.getModulesForRole(user.role);
      res.cookie(VS_SESSION_COOKIE, sessionId, { httpOnly: true, path: '/', maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
      return res.json({
        ok: true, role: user.role, modules, actions: userActions, allowWithoutToken: true,
        name: user.name || undefined, companyIds,
      });
    }

    // Пробуем пароль WMS через Samokat API
    try {
      const samokatRes = await samokatLogin(login, password);
      const accessToken = samokatRes?.value?.accessToken;
      const refreshToken = samokatRes?.value?.refreshToken;
      const expiresIn = samokatRes?.value?.expiresIn || 300;
      if (!accessToken) {
        vsAuth.recordLoginAttempt(login, false);
        return res.status(401).json({ ok: false, error: 'Неверный пароль' });
      }
      vsAuth.recordLoginAttempt(login, true);
      const sessionId = vsAuth.createSession(user, login);
      const modules = user.modules || vsAuth.getModulesForRole(user.role);
      res.cookie(VS_SESSION_COOKIE, sessionId, { httpOnly: true, path: '/', maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
      return res.json({
        ok: true, role: user.role, modules, actions: userActions, accessToken, expiresIn,
        name: user.name || undefined, refreshToken: refreshToken || '', companyIds,
      });
    } catch (samokatErr) {
      vsAuth.recordLoginAttempt(login, false);
      return res.status(401).json({ ok: false, error: 'Неверный пароль' });
    }
  } catch (err) {
    if (req.body?.login) vsAuth.recordLoginAttempt(req.body.login, false);
    console.error('POST /api/vs/auth/login', err);
    res.status(500).json({ ok: false, error: err.message || 'Ошибка входа' });
  }
});

app.get('/api/vs/auth/me', (req, res) => {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  const session = vsAuth.getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Сессия не найдена или истекла' });
  }
  // Перечитываем модули из файла пользователей, чтобы изменения в ролях применялись без перелогина
  const user = vsAuth.findUserByLogin(session.login);
  const modules = (user?.modules) || vsAuth.getModulesForRole(session.role);
  const actions = user ? (Array.isArray(user.actions) ? user.actions : vsAuth.getActionsForRole(user.role)) : [];
  res.json({
    name: user?.name || undefined,
    role: session.role,
    modules,
    actions,
    allowWithoutToken: !!session.allowWithoutToken,
    selfOnly: !!(user?.selfOnly),
    companyIds: session.role === 'manager' && Array.isArray(session.companyIds) ? session.companyIds : undefined,
  });
});

app.post('/api/vs/auth/logout', (req, res) => {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  if (sessionId) vsAuth.destroySession(sessionId);
  res.clearCookie(VS_SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// ─── Привязка Telegram для менеджера (отчёты в личку) ─────────────────────────

async function getTelegramBotUsername(botToken) {
  if (!botToken || !botToken.trim()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`);
    const data = await r.json();
    return data?.ok && data?.result?.username ? data.result.username : null;
  } catch {
    return null;
  }
}

app.get('/api/vs/telegram/status', vsSessionRequired, async (req, res) => {
  try {
    const login = req.vsSession?.login;
    const chatId = login ? vsAuth.getTelegramChatId(login) : null;
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    let botUsername = null;
    if (botToken) botUsername = await getTelegramBotUsername(botToken);
    res.json({ linked: !!chatId, botUsername });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vs/telegram/bind-start', vsSessionRequired, async (req, res) => {
  try {
    const login = req.vsSession?.login;
    if (!login) return res.status(401).json({ error: 'Нет логина в сессии' });
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) return res.status(400).json({ error: 'Бот не настроен (добавьте Bot Token в настройках)' });
    const code = vsAuth.createBindingCode();
    vsAuth.addBindingCode(code, login);
    const botUsername = await getTelegramBotUsername(botToken);
    res.json({ code, botUsername: botUsername || '', expiresIn: 300 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Node agent: отключение ноды ──────────────────────────────────────────────

/** Middleware: если нода отключена — возвращает 503 для всех маршрутов кроме /api/node/* */
app.use((req, res, next) => {
  if (req.path.startsWith('/api/node/')) return next();
  if (nodeAgent.isDisabled()) {
    return res.status(503).json({ error: 'Нода отключена панелью управления' });
  }
  next();
});

/** Проверка токена ноды из заголовка Authorization: Bearer <NODE_TOKEN> */
function requireNodeToken(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!nodeAgent.verifyNodeToken(token)) {
    return res.status(401).json({ error: 'Неверный NODE_TOKEN' });
  }
  next();
}

/** GET /api/node/status — статус ноды (для панели управления) */
app.get('/api/node/status', requireNodeToken, (req, res) => {
  res.json({
    ok: true,
    name: nodeAgent.NODE_NAME,
    disabled: nodeAgent.isDisabled(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || null,
  });
});

/** POST /api/node/disable — отключить ноду */
app.post('/api/node/disable', requireNodeToken, (req, res) => {
  nodeAgent.disable();
  res.json({ ok: true });
});

/** POST /api/node/enable — включить ноду */
app.post('/api/node/enable', requireNodeToken, (req, res) => {
  nodeAgent.enable();
  res.json({ ok: true });
});

/** POST /api/node/destroy — уничтожить ноду (удалить проект и завершить процесс) */
app.post('/api/node/destroy', requireNodeToken, (req, res) => {
  res.json({ ok: true, message: 'Нода будет уничтожена' });
  nodeAgent.destroyNode();
});

/** POST /api/node/sso/create — создать одноразовый SSO-токен (панель → нода) */
app.post('/api/node/sso/create', requireNodeToken, (req, res) => {
  const token = nodeAgent.createSSOToken();
  res.json({ ok: true, token });
});

/** GET /api/node/sso/login?token=... — войти как разработчик по одноразовому токену */
app.get('/api/node/sso/login', (req, res) => {
  const token = String(req.query.token || '');
  if (!nodeAgent.consumeSSOToken(token)) {
    return res.status(401).send('Токен недействителен или истёк');
  }
  const sid = vsAuth.createSession({
    role: 'developer',
    modules: ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'reports'],
    allowWithoutToken: true,
  }, '__developer__');
  res.cookie(VS_SESSION_COOKIE, sid, {
    httpOnly: true,
    path: '/',
    maxAge: 4 * 60 * 60 * 1000, // 4 часа
    sameSite: 'lax',
  });
  res.redirect('/');
});

/** GET /api/node/users — список пользователей для панели управления */
app.get('/api/node/users', requireNodeToken, (req, res) => {
  const users = vsAuth.getAllUsersForAdmin();
  res.json(users);
});

/** PUT /api/node/users — создать или обновить пользователя (панель → нода) */
app.put('/api/node/users', requireNodeToken, (req, res) => {
  try {
    const { login, name, role, modules, shiftType, companyIds, allowWithoutToken, password } = req.body || {};
    if (!login || String(login).trim() === '') {
      return res.status(400).json({ error: 'Укажите логин' });
    }
    vsAuth.saveUser(login, { name, role, modules, shiftType, companyIds, allowWithoutToken, password });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/node/users/:login — удалить пользователя (панель → нода) */
app.delete('/api/node/users/:login', requireNodeToken, (req, res) => {
  try {
    const login = decodeURIComponent(req.params.login || '');
    if (!login.trim()) return res.status(400).json({ error: 'Укажите логин' });
    vsAuth.removeUser(login);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Middleware: опционально подставляет req.vsSession. Не возвращает 401 — только для маршрутов, которые сами проверяют. */
function vsSessionOptional(req, res, next) {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  req.vsSession = sessionId ? vsAuth.getSession(sessionId) : null;
  next();
}

/** Middleware: доступ только с валидной сессией /vs, иначе 401. */
function vsSessionRequired(req, res, next) {
  const sessionId = req.cookies?.[VS_SESSION_COOKIE];
  const session = sessionId ? vsAuth.getSession(sessionId) : null;
  if (!session) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  req.vsSession = session;
  next();
}

/** Middleware: доступ только для роли admin или developer, иначе 403. */
function vsAdminRequired(req, res, next) {
  const role = req.vsSession?.role;
  if (role !== 'admin' && role !== 'developer') {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
}


app.post('/api/vs/request-fetch', vsSessionRequired, (req, res) => {
  fetchRequested = true;
  res.json({ ok: true });
});

// Кладовщик (без WMS токена) запрашивает обновление ЕО — корп. устройство обработает
app.post('/api/rk/routes/:routeId/eos/request-refresh', (req, res) => {
  const routeId = decodeURIComponent(req.params.routeId);
  if (!eoRefreshQueue.includes(routeId)) eoRefreshQueue.push(routeId);
  res.json({ ok: true });
});

// Корп. устройство вызывает после завершения полного runFetchForHours
app.post('/api/vs/mark-updated', vsSessionRequired, (req, res) => {
  scheduler.setLastRun(new Date());
  fetchRequested = false;
  res.json({ ok: true });
});

// ─── API админа /vs: пользователи, права, модули ─────────────────────────────────

app.get('/api/vs/admin/users', vsSessionRequired, vsAdminRequired, (_req, res) => {
  try {
    res.json(vsAuth.getAllUsersForAdmin());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/vs/admin/users', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const { login, name, role, modules, actions, shiftType, companyIds, allowWithoutToken, selfOnly, password } = req.body || {};
    if (!login || String(login).trim() === '') {
      return res.status(400).json({ error: 'Укажите логин (номер телефона или буквенный)' });
    }
    vsAuth.saveUser(login, { name, role, modules, actions, shiftType, companyIds, allowWithoutToken, selfOnly, password });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/vs/admin/users/:login', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const login = decodeURIComponent(req.params.login || '');
    if (!login.trim()) return res.status(400).json({ error: 'Укажите логин' });
    vsAuth.removeUser(login);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Custom roles (admin) ────────────────────────────────────────────────────

app.get('/api/vs/admin/roles', vsSessionRequired, vsAdminRequired, (_req, res) => {
  try {
    res.json(vsAuth.getAllRoles());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vs/admin/roles', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const { key, label, modules } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'Укажите название роли' });
    const finalKey = vsAuth.addCustomRole(key, label, modules);
    res.json({ ok: true, key: finalKey });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vs/admin/roles/:key', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key || '');
    const { label, modules } = req.body || {};
    vsAuth.updateCustomRole(key, label, modules);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vs/admin/roles/:key', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key || '');
    vsAuth.deleteCustomRole(key);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Pending registration requests (admin) ───────────────────────────────────

app.get('/api/vs/admin/pending', vsSessionRequired, vsAdminRequired, (_req, res) => {
  try {
    res.json(vsAuth.getPendingUsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vs/admin/pending/approve', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const { phone, role, modules } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });
    vsAuth.approvePendingUser(phone, role, modules);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vs/admin/pending/:phone', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone || '');
    vsAuth.rejectPendingUser(phone);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API для страницы /vs (смены, дата, мониторинг, перекличка) ─────────────────

app.get('/api/date/:date/items', vsSessionOptional, (req, res) => {
  try {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'Неверный формат даты (YYYY-MM-DD)' });
    }
    const fromHour = req.query.fromHour != null ? parseInt(req.query.fromHour, 10) : undefined;
    const toHour = req.query.toHour != null ? parseInt(req.query.toHour, 10) : undefined;
    let shift = req.query.shift === 'day' || req.query.shift === 'night' ? req.query.shift : undefined;
    const session = req.vsSession;
    if (session?.role === 'supervisor' && session.shiftType) {
      if (shift && shift !== session.shiftType) {
        return res.status(403).json({ error: 'Доступ только к своей смене' });
      }
      shift = session.shiftType;
    }
    let items = storage.getDateItems(dateStr, { fromHour, toHour, shift });
    if (session?.role === 'manager' && Array.isArray(session.companyIds) && session.companyIds.length > 0) {
      const emplMap = getEmplMapFioToCompany();
      const allowed = new Set(session.companyIds.map(c => c.trim().toLowerCase()));
      items = items.filter(it => {
        const company = getCompanyByFio(emplMap, it.executor);
        return company && allowed.has(company.trim().toLowerCase());
      });
    }
    const userForItems = session ? vsAuth.findUserByLogin(session.login) : null;
    if (userForItems?.selfOnly && userForItems?.name) {
      const selfNorm = normalizeFioForMatch(userForItems.name);
      items = items.filter(it => normalizeFioForMatch(it.executor) === selfNorm);
    }
    res.json({ date: dateStr, count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/date/:date/summary', vsSessionOptional, (req, res) => {
  try {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'Неверный формат даты (YYYY-MM-DD)' });
    }
    let shift = req.query.shift === 'day' || req.query.shift === 'night' ? req.query.shift : undefined;
    let idleThresholdMs = undefined;
    if (req.query.idleThresholdMinutes != null) {
      const minutes = parseInt(req.query.idleThresholdMinutes, 10);
      if (Number.isFinite(minutes) && minutes >= 0) {
        idleThresholdMs = minutes * 60 * 1000;
      }
    }
    const session = req.vsSession;
    if (session?.role === 'supervisor' && session.shiftType) {
      if (shift && shift !== session.shiftType) {
        return res.status(403).json({ error: 'Доступ только к своей смене' });
      }
      shift = session.shiftType;
    }
    const emplMap = getEmplMapFioToCompany();
    const getCompany = (fio) => getCompanyByFio(emplMap, fio);
    const userForSummary = session ? vsAuth.findUserByLogin(session.login) : null;
    const filterExecutorNorm = userForSummary?.selfOnly && userForSummary?.name
      ? normalizeFioForMatch(userForSummary.name)
      : undefined;
    const summary = storage.getDateSummary(dateStr, { shift, idleThresholdMs, filterExecutorNorm }, { getCompany });
    res.json({ date: dateStr, shift: shift || null, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/date/:date/storage', vsSessionOptional, (req, res) => {
  try {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: 'Неверный формат даты (YYYY-MM-DD)' });
    }
    const shift = req.body?.shift === 'night' ? 'night' : 'day';
    const totalStorageCount = Number(req.body?.totalStorageCount) || 0;
    const storageByHour = req.body?.storageByHour && typeof req.body.storageByHour === 'object' ? req.body.storageByHour : {};
    const totalWeightGrams = Number(req.body?.totalWeightGrams) || 0;
    const weightByEmployee = req.body?.weightByEmployee && typeof req.body.weightByEmployee === 'object' ? req.body.weightByEmployee : {};
    storage.saveStorageForDate(dateStr, shift, { totalStorageCount, storageByHour, totalWeightGrams, weightByEmployee });
    res.json({ ok: true, date: dateStr, shift });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts', vsSessionOptional, (req, res) => {
  try {
    let shifts = storage.listShifts();
    const session = req.vsSession;
    if (session?.role === 'supervisor' && session.shiftType) {
      shifts = shifts.filter(s => (s.shiftKey || '').endsWith('_' + session.shiftType));
    }
    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Анализ: скорости сотрудников (СЗ/час) по истории ───────────────────────

function getDateRangeList(fromStr, toStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) return [];
  const out = [];
  const from = new Date(fromStr + 'T12:00:00Z');
  const to = new Date(toStr + 'T12:00:00Z');
  if (from > to) return [];
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

app.get('/api/analysis/employee-rates', vsSessionOptional, (req, res) => {
  try {
    const dateFrom = String(req.query.dateFrom || '').slice(0, 10);
    const dateTo = String(req.query.dateTo || '').slice(0, 10);
    const shift = req.query.shift === 'day' || req.query.shift === 'night' ? req.query.shift : undefined;
    const idleThresholdMinutes = req.query.idleThresholdMinutes != null ? parseInt(req.query.idleThresholdMinutes, 10) : 15;
    const idleThresholdMs = (Number.isFinite(idleThresholdMinutes) && idleThresholdMinutes >= 0)
      ? idleThresholdMinutes * 60 * 1000
      : 15 * 60 * 1000;

    const dates = getDateRangeList(dateFrom, dateTo);
    if (!dates.length) return res.status(400).json({ error: 'Неверный диапазон дат' });

    const totals = new Map(); // name -> { tasksCount, hoursWorked, peakPerHour, byZone }
    const emplMap = getEmplMapFioToCompany();
    const getCompany = (fio) => getCompanyByFio(emplMap, fio);
    const sessionForRates = req.vsSession;
    const userForRates = sessionForRates ? vsAuth.findUserByLogin(sessionForRates.login) : null;
    const filterExecutorNormRates = userForRates?.selfOnly && userForRates?.name
      ? normalizeFioForMatch(userForRates.name)
      : undefined;
    for (const dateStr of dates) {
      const summary = storage.getDateSummary(dateStr, { shift, idleThresholdMs, filterExecutorNorm: filterExecutorNormRates }, { getCompany });
      const hb = summary && summary.hourlyByEmployee;
      const rows = hb && Array.isArray(hb.rows) ? hb.rows : [];
      const hours = hb && Array.isArray(hb.hours) ? hb.hours : [];
      for (const row of rows) {
        const name = row.name || row.executor || '';
        if (!name) continue;
        const byHour = row.byHour && typeof row.byHour === 'object' ? row.byHour : {};
        let hoursWorked = 0;
        let peakPerHour = 0;
        for (const h of hours) {
          const v = Number(byHour[h] || 0);
          if (v > 0) hoursWorked += 1;
          if (v > peakPerHour) peakPerHour = v;
        }
        if (!totals.has(name)) totals.set(name, { tasksCount: 0, hoursWorked: 0, peakPerHour: 0, byZone: {} });
        const t = totals.get(name);
        t.tasksCount += Number(row.total) || 0;
        t.hoursWorked += hoursWorked;
        if (peakPerHour > t.peakPerHour) t.peakPerHour = peakPerHour;
        if (row.byZone && typeof row.byZone === 'object') {
          for (const [zk, zv] of Object.entries(row.byZone)) {
            if (!t.byZone[zk]) t.byZone[zk] = { count: 0, weightGrams: 0 };
            t.byZone[zk].count += Number(zv.count) || 0;
            t.byZone[zk].weightGrams += Number(zv.weightGrams) || 0;
          }
        }
      }
    }

    const list = [];
    for (const [name, t] of totals) {
      const hours = t.hoursWorked;
      const szPerHour = hours > 0 ? t.tasksCount / hours : 0;
      const totalWeightGrams = Object.values(t.byZone).reduce((s, z) => s + (Number(z.weightGrams) || 0), 0);
      const kgPerHour = hours > 0 ? (totalWeightGrams / 1000) / hours : 0;
      // кг/час по зонам
      const kgPerHourByZone = {};
      for (const [zk, zv] of Object.entries(t.byZone)) {
        kgPerHourByZone[zk] = hours > 0 ? (Number(zv.weightGrams) || 0) / 1000 / hours : 0;
      }
      list.push({
        name,
        tasksCount: t.tasksCount,
        hoursWorked: Math.round(hours),
        szPerHour: Number(szPerHour.toFixed(2)),
        peakPerHour: Number((t.peakPerHour || 0).toFixed(2)),
        kgPerHour: Number(kgPerHour.toFixed(2)),
        kgPerHourByZone,
        byZone: t.byZone,
      });
    }
    list.sort((a, b) => (b.szPerHour - a.szPerHour) || (b.tasksCount - a.tasksCount) || a.name.localeCompare(b.name, 'ru'));
    res.json({ dateFrom, dateTo, shift: shift || null, count: list.length, employees: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analysis/article-speeds?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD[&opType=PICK_BY_LINE|PIECE_SELECTION_PICKING][&zone=KDS|KDH|SH|HH]
app.get('/api/analysis/article-speeds', vsSessionOptional, async (req, res) => {
  try {
    const dateFrom = String(req.query.dateFrom || '').slice(0, 10);
    const dateTo   = String(req.query.dateTo   || '').slice(0, 10);
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Нужны dateFrom и dateTo' });

    const cmd = getDotnetArticleSpeedsCmd();
    if (!cmd) return res.status(500).json({ error: 'ArticleSpeeds tool не найден' });

    const cmdArgs = [...cmd.args, '--data-dir', DATA_DIR, '--date-from', dateFrom, '--date-to', dateTo];
    if (req.query.opType) cmdArgs.push('--op-type', String(req.query.opType));
    if (req.query.zone)   cmdArgs.push('--zone',    String(req.query.zone));

    const { stdout } = await execFileAsync(cmd.exe, cmdArgs, { maxBuffer: 32 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts/current', (req, res) => {
  res.json({ shiftKey: storage.getCurrentShiftKey() });
});

app.get('/api/shifts/:shiftKey/items', (req, res) => {
  try {
    const { shiftKey } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}_(day|night)$/.test(shiftKey)) {
      return res.status(400).json({ error: 'Неверный формат shiftKey' });
    }
    const items = storage.getShiftItems(shiftKey);
    res.json({ shiftKey, count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET/POST /api/employees — для страницы /vs (csv)
app.get('/api/employees', (req, res) => {
  try {
    if (!fs.existsSync(EMPL_CSV_PATH)) {
      return res.json({ csv: '', employees: [], companies: [] });
    }
    const text = readEmplCsvText();
    const employees = [];
    const companySet = new Set();
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const idx = t.indexOf(';');
      if (idx < 0) continue;
      const fio = t.slice(0, idx).trim();
      const company = t.slice(idx + 1).trim();
      if (fio) {
        employees.push({ fio, company });
        if (company) companySet.add(company);
      }
    }
    res.json({ csv: text, employees, companies: [...companySet].sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', (req, res) => {
  try {
    const { csv } = req.body || {};
    if (typeof csv !== 'string') return res.status(400).json({ error: 'Нет поля csv' });
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(EMPL_CSV_PATH, Buffer.concat([bom, Buffer.from(csv, 'utf8')]));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const LIVE_MONITOR_URL = 'https://api.samokat.ru/wmsops-wwh/activity-monitor/selection/handling-units-in-progress';
const ROLLCALL_PATH = path.join(__dirname, 'data', 'rollcall.json');


app.get('/api/monitor/live', async (req, res) => {
  try {
    const config = loadConfig();
    const token = (config.token || '').trim();
    if (!token) return res.status(401).json({ error: 'Токен не задан' });
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Origin': 'https://wwh.samokat.ru',
      'Referer': 'https://wwh.samokat.ru/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    };
    const cookie = (config.cookie || '').trim();
    if (cookie) headers['Cookie'] = cookie;
    const response = await fetch(LIVE_MONITOR_URL, { headers });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'Ответ не JSON', preview: text.slice(0, 200) });
    }
    if (!response.ok) return res.status(response.status).json({ error: `API ${response.status}`, data });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/rollcall', (req, res) => {
  try {
    if (!fs.existsSync(ROLLCALL_PATH)) return res.json({ shiftKey: null, present: [] });
    res.json(JSON.parse(fs.readFileSync(ROLLCALL_PATH, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rollcall', (req, res) => {
  try {
    const { shiftKey, present } = req.body || {};
    storage.ensureDataDir();
    fs.writeFileSync(ROLLCALL_PATH, JSON.stringify({ shiftKey: shiftKey || null, present: present || [] }), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule/start', (req, res) => {
  res.json(scheduler.start());
});

app.post('/api/schedule/stop', (req, res) => {
  res.json(scheduler.stop());
});

app.post('/api/schedule/settings', (req, res) => {
  try {
    const { intervalMinutes, pageSize } = req.body || {};
    const config = loadConfig();
    if (intervalMinutes !== undefined) {
      config.intervalMinutes = Math.max(1, parseInt(intervalMinutes, 10) || 10);
    }
    if (pageSize !== undefined) {
      config.pageSize = Math.min(1000, Math.max(1, parseInt(pageSize, 10) || 500));
    }
    saveConfig(config);
    const wasRunning = scheduler.isRunning();
    if (wasRunning) {
      scheduler.stop();
      const result = scheduler.start();
      return res.json({ ok: true, restarted: true, message: result.message, config: { intervalMinutes: config.intervalMinutes } });
    }
    res.json({ ok: true, restarted: false, config: { intervalMinutes: config.intervalMinutes } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Консолидация: маршруты ──────────────────────────────────────────────────

// POST /api/consolidation/complaints — создать жалобу
app.post('/api/consolidation/complaints', upload.array('photo', 10), (req, res) => {
  try {
    const { cell, barcode, employeeName } = req.body || {};
    if (!cell || !barcode) {
      return res.status(400).json({ ok: false, error: 'Укажите место хранения и штрихкод' });
    }
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const uploaded = Array.isArray(req.files) ? req.files : [];
    const photoFilenames = [];
    if (uploaded.length > 0) {
      for (let i = 0; i < uploaded.length; i++) {
        const f = uploaded[i];
        const ext = path.extname(f.originalname) || '.jpg';
        const suffix = i === 0 ? '' : `_${i + 1}`;
        const newName = `${id}${suffix}${ext}`;
        fs.renameSync(f.path, path.join(UPLOADS_DIR, newName));
        photoFilenames.push(newName);
      }
    }
    const photoFilename = photoFilenames[0] || null;
    const complaint = {
      id,
      createdAt: new Date().toISOString(),
      cell: cell.trim(),
      barcode: barcode.trim(),
      employeeName: (employeeName || '').trim() || null,
      photoFilename,
      photoFilenames,
      productName: null,
      nomenclatureCode: null,
      violator: null,
      violatorId: null,
      operationType: null,
      operationCompletedAt: null,
      status: 'new',
      lookupDone: false,
      lookupError: null,
    };
    const list = loadComplaints();
    list.unshift(complaint);
    saveComplaints(list);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('POST /api/consolidation/complaints', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/consolidation/complaints — список жалоб (компания из консолидации или по ФИО из empl)
app.get('/api/consolidation/complaints', (req, res) => {
  try {
    const list = loadComplaints();
    const emplMap = getEmplMapFioToCompany();
    const enriched = list.map(c => ({
      ...c,
      company: (c.company != null && String(c.company).trim() !== '') ? c.company : (getCompanyByFio(emplMap, c.violator) || ''),
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/consolidation/complaints/:id/status — сменить статус
app.put('/api/consolidation/complaints/:id/status', (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['new', 'in_progress', 'resolved'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Неверный статус' });
    }
    const list = loadComplaints();
    const item = list.find(c => c.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Не найдено' });
    item.status = status;
    saveComplaints(list);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/consolidation/complaints/:id — удалить жалобу
app.delete('/api/consolidation/complaints/:id', (req, res) => {
  try {
    const list = loadComplaints();
    const idx = list.findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const [removed] = list.splice(idx, 1);
    saveComplaints(list);
    // Удалить все фото жалобы
    const photos = Array.isArray(removed.photoFilenames) && removed.photoFilenames.length > 0
      ? removed.photoFilenames
      : (removed.photoFilename ? [removed.photoFilename] : []);
    for (const file of photos) {
      const photoPath = path.join(UPLOADS_DIR, file);
      if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/consolidation/uploads/:filename — отдача фото
app.get('/api/consolidation/uploads/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  if (name.includes('..')) return res.status(400).json({ error: 'Invalid' });
  const filePath = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// PUT /api/consolidation/complaints/:id/lookup — сохранить результат WMS-поиска (от клиента)
app.put('/api/consolidation/complaints/:id/lookup', (req, res) => {
  try {
    const list = loadComplaints();
    const item = list.find(c => c.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const d = req.body || {};
    if (d.cell !== undefined) item.cell = d.cell;
    if (d.barcode !== undefined) item.barcode = d.barcode;
    if (d.productName !== undefined) item.productName = d.productName;
    if (d.nomenclatureCode !== undefined) item.nomenclatureCode = d.nomenclatureCode;
    if (d.productBarcode !== undefined) item.productBarcode = d.productBarcode;
    if (d.violator !== undefined) item.violator = d.violator;
    if (d.violatorId !== undefined) item.violatorId = d.violatorId;
    if (d.handlingUnitBarcode !== undefined) item.handlingUnitBarcode = d.handlingUnitBarcode;
    if (d.operationType !== undefined) item.operationType = d.operationType;
    if (d.operationCompletedAt !== undefined) item.operationCompletedAt = d.operationCompletedAt;
    if (d.lookupDone !== undefined) item.lookupDone = d.lookupDone;
    if (d.lookupError !== undefined) item.lookupError = d.lookupError;
    if (d.company !== undefined) item.company = d.company;
    if (d.taskArea !== undefined) item.taskArea = (d.taskArea === 'kdk' || d.taskArea === 'storage') ? d.taskArea : '';
    else if (d.operationType != null && (item.taskArea == null || String(item.taskArea).trim() === '')) {
      const op = String(d.operationType).toUpperCase();
      item.taskArea = (op === 'PICK_BY_LINE' || op.indexOf('PALLET') >= 0) ? 'kdk' : 'storage';
    }
    if (item.violator != null && (item.company == null || String(item.company).trim() === '')) {
      const emplMap = getEmplMapFioToCompany();
      item.company = getCompanyByFio(emplMap, item.violator) || '';
    }
    saveComplaints(list);
    res.json({ ok: true, complaint: item });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/consolidation/telegram/send — отправить выбранные жалобы в Telegram
app.post('/api/consolidation/telegram/send', async (req, res) => {
  try {
    const complaintIds = Array.isArray(req.body?.complaintIds)
      ? req.body.complaintIds.map(x => String(x))
      : [];
    if (complaintIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'Не переданы complaintIds' });
    }

    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    const chats = getTelegramChats(config);
    if (!botToken || !chats.length) {
      return res.status(400).json({ ok: false, error: 'Не настроены telegramBotToken или список чатов (Chat ID) в config' });
    }

    const list = loadComplaints();
    const byId = new Map(list.map(c => [String(c.id), c]));
    const selected = complaintIds.map(id => byId.get(id)).filter(Boolean);

    const onlyInProgress = selected.filter(c => c.status === 'in_progress');
    const skipped = selected.filter(c => c.status !== 'in_progress').map(c => c.id);
    if (onlyInProgress.length === 0) {
      return res.status(400).json({ ok: false, error: 'Выбранные жалобы не имеют статус "в работе"', skipped });
    }

    const sent = [];
    const failed = [];
    const origin = `${req.protocol}://${req.get('host')}`;
    const emplMap = getEmplMapFioToCompany();
    for (const c of onlyInProgress) {
      const photos = Array.isArray(c?.photoFilenames) && c.photoFilenames.length > 0
        ? c.photoFilenames
        : (c?.photoFilename ? [c.photoFilename] : []);
      const photoUrl = photos.length > 0
        ? `${origin}/api/consolidation/uploads/${encodeURIComponent(photos[0])}`
        : '';
      const company = (c.company != null && String(c.company).trim() !== '') ? c.company : (getCompanyByFio(emplMap, c.violator) || '—');
      const text = formatComplaintForTelegram(c, photoUrl, config, company);
      const photoPaths = photos
        .map(name => ({ name, path: path.join(UPLOADS_DIR, name) }))
        .filter(x => fs.existsSync(x.path));
      let sentToAny = false;
      for (const chat of chats) {
        const threadId = chat.threadIdConsolidation;
        try {
          if (photoPaths.length > 1) {
            await sendTelegramMediaGroup(botToken, chat.chatId, text, photoPaths, threadId, 'Markdown');
          } else if (photoPaths.length === 1) {
            const p = photoPaths[0];
            await sendTelegramPhoto(botToken, chat.chatId, text, p.path, p.name, threadId, 'Markdown');
          } else {
            await sendTelegramMessage(botToken, chat.chatId, text, threadId, 'Markdown');
          }
          sentToAny = true;
        } catch (e) {
          failed.push({ id: c.id, error: e.message });
        }
      }
      if (sentToAny) sent.push(c.id);
    }

    res.json({
      ok: failed.length === 0,
      sentCount: sent.length,
      failedCount: failed.length,
      sent,
      failed,
      skipped,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Кэш дневной сводки по компаниям ─────────────────────────────────────────

const COMPANY_DAY_CACHE_DIR = path.join(DATA_DIR, 'company-day-cache');

function companyCachePath(dateStr, shift) {
  const suffix = shift ? `_${shift}` : '_all';
  return path.join(COMPANY_DAY_CACHE_DIR, `${dateStr}${suffix}.json`);
}

function loadCompanyDayCache(dateStr, shift) {
  const fp = companyCachePath(dateStr, shift);
  try {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}

function saveCompanyDayCache(dateStr, shift, companies) {
  if (!fs.existsSync(COMPANY_DAY_CACHE_DIR)) fs.mkdirSync(COMPANY_DAY_CACHE_DIR, { recursive: true });
  const fp = companyCachePath(dateStr, shift);
  fs.writeFileSync(fp, JSON.stringify({ dateStr, shift, cachedAt: new Date().toISOString(), companies }), 'utf8');
}

/** Вычислить сводку по компаниям за один день и вернуть объект { companyName: { totalTasks, storageOps, kdkOps, weightStorageGrams, weightKdkGrams, employees: string[] } } */
function computeCompanyDay(dateStr, shift, getComp) {
  function parseWeightGramsFromName(name) {
    const s = String(name || '').replace(/\u00a0|\u202f/g, ' ').trim();
    if (!s) return 0;
    const parseN = v => { const n = Number(String(v||'').replace(',','.')); return Number.isFinite(n) ? n : 0; };
    const fromUnit = (val, unit) => {
      const v = parseN(val); if (!v) return 0;
      const u = String(unit||'').toLowerCase();
      if (u==='кг'||u==='kg') return v*1000;
      if (u==='г'||u==='g') return v;
      if (u==='л'||u==='l') return v*1000;
      if (u==='мл'||u==='ml') return v;
      return 0;
    };
    const combo = s.match(/(\d+(?:[.,]\d+)?)\s*[xх×]\s*(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i);
    if (combo) return parseN(combo[1]) * fromUnit(combo[2], combo[3]);
    const simple = s.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|kg|g|l|ml)/i);
    if (simple) return fromUnit(simple[1], simple[2]);
    return 0;
  }

  const items = storage.getDateItems(dateStr, { shift: shift || undefined });
  if (!items.length) return {};

  const dayByCompany = new Map();
  for (const item of items) {
    const op = (item.operationType || '').toUpperCase();
    const isKdk     = op === 'PICK_BY_LINE';
    const isPallet  = op === 'PALLET_SELECTION_MOVE_TO_PICK_BY_LINE';
    const isStorage = op === 'PIECE_SELECTION_PICKING';
    if (!isKdk && !isPallet && !isStorage) continue;

    const company = getComp(item.executor);
    const taskKey = isKdk
      ? `task|${item.executor||''}|${item.cell||''}|${item.nomenclatureCode||item.productName||''}`
      : `id|${item.id||''}`;

    if (!dayByCompany.has(company)) dayByCompany.set(company, { taskKeys: new Set(), storageOps: 0, kdkOps: 0, palletOps: 0, weightStorageGrams: 0, weightKdkGrams: 0, employees: new Set() });
    const dc = dayByCompany.get(company);
    if (!dc.taskKeys.has(taskKey)) {
      dc.taskKeys.add(taskKey);
      if (isKdk) dc.kdkOps++; else if (isPallet) dc.palletOps++; else dc.storageOps++;
    }
    const grams = (productWeights.getWeightGrams(String(item.nomenclatureCode||'').trim()) || parseWeightGramsFromName(item.productName||'')) * Math.max(1, Number(item.quantity)||1);
    if (grams > 0) { if (isKdk) dc.weightKdkGrams += grams; else dc.weightStorageGrams += grams; }
    dc.employees.add(normalizeFioForMatch(item.executor));
  }

  const result = {};
  for (const [company, dc] of dayByCompany) {
    result[company] = {
      totalTasks:         dc.taskKeys.size,
      storageOps:         dc.storageOps,
      kdkOps:             dc.kdkOps,
      palletOps:          dc.palletOps,
      weightStorageGrams: dc.weightStorageGrams,
      weightKdkGrams:     dc.weightKdkGrams,
      employees:          [...dc.employees],
    };
  }
  return result;
}

// GET /api/stats/monthly-company — сводка по компаниям за месяц
app.get('/api/stats/monthly-company', vsSessionRequired, (req, res) => {
  try {
    const year  = parseInt(req.query.year,  10);
    const month = parseInt(req.query.month, 10); // 1–12
    const shift = req.query.shift || null;        // 'day'|'night'|null
    if (!year || !month || month < 1 || month > 12) {
      return res.status(400).json({ error: 'Нужны year и month (1–12)' });
    }
    const emplMap  = getEmplMapFioToCompany();
    const getComp  = fio => getCompanyByFio(emplMap, fio) || '—';
    const daysInMonth = new Date(year, month, 0).getDate();
    const todayStr = new Date().toISOString().slice(0, 10);

    // company -> { totalTasks, storageOps, kdkOps, weightStorageGrams, weightKdkGrams, employees: Set, workDays }
    const monthly = new Map();

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const isToday = dateStr === todayStr;

      let dayCompanies;
      if (!isToday) {
        // Прошлые дни — берём из кэша или вычисляем и кэшируем
        const cached = loadCompanyDayCache(dateStr, shift);
        if (cached) {
          dayCompanies = cached.companies;
        } else {
          dayCompanies = computeCompanyDay(dateStr, shift, getComp);
          if (Object.keys(dayCompanies).length > 0) saveCompanyDayCache(dateStr, shift, dayCompanies);
        }
      } else {
        // Сегодня — всегда живой расчёт
        dayCompanies = computeCompanyDay(dateStr, shift, getComp);
      }

      for (const [company, dc] of Object.entries(dayCompanies)) {
        if (!monthly.has(company)) monthly.set(company, { totalTasks: 0, storageOps: 0, kdkOps: 0, palletOps: 0, weightStorageGrams: 0, weightKdkGrams: 0, employees: new Set(), workDays: 0 });
        const r = monthly.get(company);
        r.totalTasks         += dc.totalTasks;
        r.storageOps         += dc.storageOps;
        r.kdkOps             += dc.kdkOps;
        r.palletOps          += (dc.palletOps || 0);
        r.weightStorageGrams += dc.weightStorageGrams;
        r.weightKdkGrams     += dc.weightKdkGrams;
        (dc.employees || []).forEach(e => r.employees.add(e));
        r.workDays++;
      }
    }

    const companies = [...monthly.entries()]
      .map(([name, r]) => ({
        name,
        totalTasks:         r.totalTasks,
        storageOps:         r.storageOps,
        kdkOps:             r.kdkOps,
        palletOps:          r.palletOps,
        weightStorageGrams: r.weightStorageGrams,
        weightKdkGrams:     r.weightKdkGrams,
        weightTotalGrams:   r.weightStorageGrams + r.weightKdkGrams,
        employees:          r.employees.size,
        workDays:           r.workDays,
      }))
      .sort((a, b) => b.totalTasks - a.totalTasks);

    res.json({ year, month, daysInMonth, companies });
  } catch (err) {
    console.error('GET /api/stats/monthly-company', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vs/admin/company-day-cache/invalidate — сбросить кэш за дату (при ручном исправлении данных)
app.post('/api/vs/admin/company-day-cache/invalidate', vsSessionRequired, vsAdminRequired, (req, res) => {
  try {
    const { dateStr } = req.body || {};
    if (!dateStr) return res.status(400).json({ error: 'Нужен dateStr' });
    ['day', 'night', null].forEach(shift => {
      const fp = companyCachePath(dateStr, shift);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stats/send-hourly-telegram — отправить PNG по компаниям как файлы (документы) в Telegram
// Менеджер (с сессией): отправка в привязанный чат. Иначе — в чаты из настроек.
app.post('/api/stats/send-hourly-telegram', vsSessionOptional, uploadMemory.any(50), async (req, res) => {
  try {
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) {
      return res.status(400).json({ ok: false, error: 'Не настроены Telegram (Bot Token в настройках)' });
    }
    const files = req.files && Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'Не получены файлы' });
    }
    let captions = [];
    let companiesPerFile = [];
    try {
      if (req.body && req.body.captions) captions = JSON.parse(req.body.captions);
      if (req.body && req.body.companiesPerFile) companiesPerFile = JSON.parse(req.body.companiesPerFile);
    } catch (_) {}
    if (!Array.isArray(companiesPerFile)) companiesPerFile = [];

    let chats = [];
    if (req.vsSession?.role === 'manager' && req.vsSession?.login) {
      const managerChatId = vsAuth.getTelegramChatId(req.vsSession.login);
      if (managerChatId) {
        chats = [{ chatId: managerChatId, threadIdStats: null, companiesFilter: [] }];
      }
    }
    if (!chats.length) {
      chats = getTelegramChats(config);
      if (!chats.length) {
        return res.status(400).json({ ok: false, error: 'Не настроены чаты в настройках или привяжите Telegram (менеджер)' });
      }
    }

    const allowFileForChat = (fileIndex, chat) => {
      if (!Array.isArray(chat.companiesFilter) || chat.companiesFilter.length === 0) return true;
      const key = companiesPerFile[fileIndex];
      return key === 'Full' || (key && chat.companiesFilter.includes(key));
    };

    for (const chat of chats) {
      const threadId = chat.threadIdStats;
      let sentForChat = 0;
      for (let i = 0; i < files.length; i++) {
        if (!allowFileForChat(i, chat)) continue;
        const f = files[i];
        const caption = Array.isArray(captions) && captions[i] != null ? String(captions[i]) : `Сотрудники по часам ${i + 1}`;
        const filename = (f.originalname && /\.png$/i.test(f.originalname)) ? f.originalname : `hourly_${i + 1}.png`;
        await sendTelegramDocumentFromBuffer(botToken, chat.chatId, caption, f.buffer, filename, threadId);
        sentForChat++;
      }
    }
    res.json({ ok: true, sent: files.length });
  } catch (err) {
    console.error('POST /api/stats/send-hourly-telegram', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/stats/send-idles-telegram — отправить PNG таблицы простоев в Telegram
// Менеджер (с сессией): отправка в привязанный чат. Иначе — в чаты из настроек.
app.post('/api/stats/send-idles-telegram', vsSessionOptional, uploadMemory.any(30), async (req, res) => {
  try {
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) {
      return res.status(400).json({ ok: false, error: 'Не настроены Telegram (Bot Token в настройках)' });
    }
    const files = req.files && Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'Не получены файлы' });
    }
    let captions = [];
    let companiesPerFile = [];
    try {
      if (req.body && req.body.captions) captions = JSON.parse(req.body.captions);
      if (req.body && req.body.companiesPerFile) companiesPerFile = JSON.parse(req.body.companiesPerFile);
    } catch (_) {}
    if (!Array.isArray(companiesPerFile)) companiesPerFile = [];

    let chats = [];
    if (req.vsSession?.role === 'manager' && req.vsSession?.login) {
      const managerChatId = vsAuth.getTelegramChatId(req.vsSession.login);
      if (managerChatId) {
        chats = [{ chatId: managerChatId, threadIdIdles: null }];
      }
    }
    if (!chats.length) {
      chats = getTelegramChats(config);
      if (!chats.length) {
        return res.status(400).json({ ok: false, error: 'Не настроены чаты в настройках или привяжите Telegram (менеджер)' });
      }
    }

    const allowFileForChat = (fileIndex, chat) => {
      if (!Array.isArray(chat.companiesFilter) || chat.companiesFilter.length === 0) return true;
      const key = companiesPerFile[fileIndex];
      return key === 'Full' || (key && chat.companiesFilter.includes(key));
    };

    for (const chat of chats) {
      const threadId = chat.threadIdIdles;
      let sentForChat = 0;
      for (let i = 0; i < files.length; i++) {
        if (!allowFileForChat(i, chat)) continue;
        const f = files[i];
        const caption = Array.isArray(captions) && captions[i] != null ? String(captions[i]) : `Простои ${i + 1}`;
        const filename = (f.originalname && /\.png$/i.test(f.originalname)) ? f.originalname : `idles_${i + 1}.png`;
        await sendTelegramDocumentFromBuffer(botToken, chat.chatId, caption, f.buffer, filename, threadId);
        sentForChat++;
      }
    }
    res.json({ ok: true, sent: files.length });
  } catch (err) {
    console.error('POST /api/stats/send-idles-telegram', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/shipments/missing-codes — ЦФЗ-адреса без кода получателя
app.get('/api/shipments/missing-codes', vsSessionRequired, (req, res) => {
  try {
    const allAddresses = rkStorage.getAddresses();
    const missing = excelReports.getMissingCodes(allAddresses);
    res.json(missing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ExcelJS = require('exceljs');
const XLSX    = require('xlsx');

// GET /api/shipments/codes — все адреса с текущими кодами получателей
app.get('/api/shipments/codes', vsSessionRequired, (req, res) => {
  try {
    const allAddresses = rkStorage.getAddresses();
    const codes = excelReports.getAddressCodes();
    const result = allAddresses.map(address => ({
      address,
      code: codes[address]?.sapCode || null,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shipments/codes/export — скачать Excel с адресами без кода
app.get('/api/shipments/codes/export', vsSessionRequired, async (req, res) => {
  try {
    const allAddresses = rkStorage.getAddresses();
    const codes = excelReports.getAddressCodes();
    const missing = allAddresses.filter(a => !codes[a]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Коды получателей');
    ws.columns = [
      { header: 'Адрес ЦФЗ',       key: 'address', width: 45 },
      { header: 'Код получателя',   key: 'code',    width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    missing.forEach(a => ws.addRow({ address: a, code: '' }));

    const buf = await wb.xlsx.writeBuffer();
    const filename = encodeURIComponent('Коды получателей ЦФЗ.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (err) {
    console.error('GET /api/shipments/codes/export', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shipments/codes/import — загрузить Excel с кодами получателей
app.post('/api/shipments/codes/import', vsSessionRequired, uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    let saved = 0;
    for (const row of rows) {
      const address = String(row['Адрес ЦФЗ'] || '').trim();
      const code    = String(row['Код получателя'] || '').trim();
      if (address && code) {
        excelReports.setAddressCode(address, code);
        saved++;
      }
    }
    res.json({ ok: true, saved });
  } catch (err) {
    console.error('POST /api/shipments/codes/import', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shipments/set-code — привязать ЦФЗ-адрес к коду получателя
app.post('/api/shipments/set-code', vsSessionRequired, (req, res) => {
  try {
    const { address, code } = req.body;
    if (!address || !code) return res.status(400).json({ error: 'Нужны address и code' });
    excelReports.setAddressCode(address, code);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /api/shipments/report?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD — скачать Excel-отчёт
app.get('/api/shipments/report', vsSessionRequired, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Нужны dateFrom и dateTo' });

    const summaryData = rkStorage.getReportData(dateFrom, dateTo);
    const allAddresses = rkStorage.getAddresses();

    const datesSet = new Set();
    summaryData.forEach(e => e.records.forEach(r => datesSet.add(r.date)));
    const dates = [...datesSet].sort();

    const buf = await excelReports.generateReport(summaryData, dates, dateFrom, allAddresses);

    const filename = encodeURIComponent('Отчет по РК.xlsx');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (err) {
    console.error('GET /api/shipments/report', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rk/routes/bulk — удалить маршруты по списку ID
app.delete('/api/rk/routes/bulk', vsSessionRequired, (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Нужен массив ids' });
    const deleted = rkStorage.deleteRoutesByIds(ids);
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error('DELETE /api/rk/routes/bulk', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rk/routes?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD — удалить маршруты РК за период
app.delete('/api/rk/routes', vsSessionRequired, (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Нужны dateFrom и dateTo' });
    const deleted = rkStorage.deleteRoutesByDateRange(dateFrom, dateTo);
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error('DELETE /api/rk/routes', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Отгрузка РК (маршрутная модель) ─────────────────────────────────────────

// GET /api/rk/routes?q=&dateFrom=&dateTo=&receivedDateFrom=&receivedDateTo=&status=
app.get('/api/rk/routes', vsSessionRequired, (req, res) => {
  try {
    const { q, dateFrom, dateTo, receivedDateFrom, receivedDateTo, status } = req.query;
    res.json(rkStorage.getRoutes({ q, dateFrom, dateTo, receivedDateFrom, receivedDateTo, status }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/routes/:routeId
app.get('/api/rk/routes/:routeId', vsSessionRequired, (req, res) => {
  try {
    const route = rkStorage.getRouteById(decodeURIComponent(req.params.routeId));
    if (!route) return res.status(404).json({ error: 'Маршрут не найден' });
    res.json(route);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rk/import-bulk — импорт маршрутов из WMS (только метаданные, без счёта РК)
app.post('/api/rk/import-bulk', vsSessionRequired, (req, res) => {
  try {
    const routes = Array.isArray(req.body?.routes) ? req.body.routes : [];
    if (!routes.length) return res.status(400).json({ ok: false, error: 'Нет маршрутов' });
    const result = rkStorage.importBulk(routes);
    res.json({ ok: true, routes: routes.length, ...result });
  } catch (err) {
    console.error('POST /api/rk/import-bulk', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/rk/photos — загрузка фото (multipart, поле "photos")
const rkPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  },
});
app.post('/api/rk/photos', rkPhotoUpload.array('photos', 10), (req, res) => {
  try {
    const urls = (req.files || []).map(f => {
      const ext = path.extname(f.originalname) || '.jpg';
      const name = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      return rkStorage.savePhoto(name, f.buffer);
    });
    res.json({ ok: true, urls });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Раздача фото
// ─── SSE: уведомления для VS-вкладки ─────────────────────────────────────────

const sseClients = new Set();

app.get('/api/rk/events', vsSessionRequired, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function sseNotify(event) {
  const msg = `event: ${event}\ndata: {}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// Thumbnails: генерируется при первом запросе, кешируется на диск
const THUMB_DIR = path.join(rkStorage.PHOTO_DIR, 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

app.get('/rk-photos/thumb/:filename', async (req, res) => {
  const filename  = path.basename(req.params.filename);
  const origPath  = path.join(rkStorage.PHOTO_DIR, filename);
  const thumbName = filename.replace(/\.[^.]+$/, '.jpg');
  const thumbPath = path.join(THUMB_DIR, thumbName);

  if (!origPath.startsWith(rkStorage.PHOTO_DIR)) return res.status(403).end();
  if (!fs.existsSync(origPath)) return res.status(404).end();

  try {
    if (!fs.existsSync(thumbPath)) {
      await sharp(origPath)
        .resize(144, 144, { fit: 'cover' })
        .jpeg({ quality: 70 })
        .toFile(thumbPath);
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(thumbPath);
  } catch {
    res.sendFile(origPath, err => { if (err) res.status(404).end(); });
  }
});

app.use('/rk-photos', (req, res, next) => {
  const filePath = path.join(rkStorage.PHOTO_DIR, path.basename(req.path));
  if (!filePath.startsWith(rkStorage.PHOTO_DIR)) return res.status(403).end();
  res.sendFile(filePath, err => { if (err) res.status(404).end(); });
});

// POST /api/rk/routes/:routeId/ship — отгрузка (кладовщик вводит РК по каждому ЦФЗ)
app.post('/api/rk/routes/:routeId/ship', (req, res) => {
  try {
    const routeId = decodeURIComponent(req.params.routeId);
    const { by, gate, tempBefore, tempAfter, rokhlya, items, photos } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'Некорректный формат данных' });
    }
    const route = rkStorage.submitShipment(routeId, { by, gate, tempBefore, tempAfter, rokhlya, items, photos });
    sseNotify('routes-updated');
    res.json({ ok: true, route });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/rk/routes/:routeId/receive — приёмка возврата РК
app.post('/api/rk/routes/:routeId/receive', (req, res) => {
  try {
    const routeId = decodeURIComponent(req.params.routeId);
    const { by, gate, rokhlya, items, photos } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'Некорректный формат данных' });
    }
    const route = rkStorage.submitReceiving(routeId, { by, gate, rokhlya, items, photos });
    sseNotify('routes-updated');
    res.json({ ok: true, route });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// PATCH /api/rk/routes/:routeId/driver — замена водителя на маршруте
app.patch('/api/rk/routes/:routeId/driver', vsSessionRequired, (req, res) => {
  try {
    const route = rkStorage.updateRouteDriver(decodeURIComponent(req.params.routeId), req.body);
    res.json({ ok: true, route });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// PUT /api/rk/routes/:routeId/ship — редактирование отгрузки (включая подтверждённые)
app.put('/api/rk/routes/:routeId/ship', vsSessionRequired, (req, res) => {
  try {
    const route = rkStorage.updateShipment(decodeURIComponent(req.params.routeId), req.body);
    res.json({ ok: true, route });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// PUT /api/rk/routes/:routeId/receive — редактирование приёмки
app.put('/api/rk/routes/:routeId/receive', vsSessionRequired, (req, res) => {
  try {
    const route = rkStorage.updateReceiving(decodeURIComponent(req.params.routeId), req.body);
    res.json({ ok: true, route });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/rk/routes/:routeId/confirm-ship — подтверждение отгрузки менеджером
app.post('/api/rk/routes/:routeId/confirm-ship', vsSessionRequired, (req, res) => {
  try {
    const login = req.vsSession?.login;
    const user = login ? vsAuth.findUserByLogin(login) : null;
    const confirmedBy = user?.name || login || null;
    const route = rkStorage.confirmShipment(decodeURIComponent(req.params.routeId), confirmedBy);
    res.json({ ok: true, route });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/rk/routes/:routeId/confirm-receive — подтверждение приёмки менеджером
app.post('/api/rk/routes/:routeId/confirm-receive', vsSessionRequired, (req, res) => {
  try {
    const login = req.vsSession?.login;
    const user = login ? vsAuth.findUserByLogin(login) : null;
    const confirmedBy = user?.name || login || null;
    const route = rkStorage.confirmReceiving(decodeURIComponent(req.params.routeId), confirmedBy);
    res.json({ ok: true, route });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// GET /api/rk/routes/:routeId/eos — ЕО по маршруту (публичный)
app.get('/api/rk/routes/:routeId/eos', (req, res) => {
  try {
    const eos = rkStorage.getRouteEos(decodeURIComponent(req.params.routeId));
    if (eos === null) return res.status(404).json({ error: 'Маршрут не найден' });
    res.json(eos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rk/routes/:routeId/eos/refresh — обновить ЕО из WMS
// Клиент (браузер) сам делает запрос к WMS и передаёт сюда сырые данные в теле
app.post('/api/rk/routes/:routeId/eos/refresh', async (req, res) => {
  const routeId = decodeURIComponent(req.params.routeId);

  try {
    const wmsData = req.body;
    const routeVal = wmsData?.value ?? wmsData;
    const stores = Array.isArray(routeVal?.stores) ? routeVal.stores : [];

    // Обновляем все ЦФЗ за один load+save
    const results = rkStorage.updateRouteEosBatch(routeId, stores);
    // Убираем из очереди запросов
    eoRefreshQueue = eoRefreshQueue.filter(id => id !== routeId);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/rk/driver-rokhlya-debt?name= — суммарный долг рохлей водителя (публичный)
app.get('/api/rk/driver-rokhlya-debt', (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.json({ rokhlyaDebt: 0, debtSince: null });
    const drivers = rkStorage.getByDriver({ q: name });
    const driver = drivers.find(d => d.name === name) || drivers[0];
    if (!driver) return res.json({ rokhlyaDebt: 0, debtSince: null });
    const debtRoute = (driver.routes || [])
      .filter(r => (r.shippedRokhlya - r.receivedRokhlya) > 0)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
    res.json({
      rokhlyaDebt: driver.rokhlyaDebt || 0,
      debtSince: debtRoute ? { date: debtRoute.date, routeNumber: debtRoute.routeNumber } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/drivers?q= — сводка по водителям
app.get('/api/rk/drivers', vsSessionRequired, (req, res) => {
  try {
    res.json(rkStorage.getByDriver({ q: req.query.q }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/drivers/pending?q= — водители с неподтверждёнными маршрутами
app.get('/api/rk/drivers/pending', (req, res) => {
  try {
    res.json(rkStorage.getDriversWithPending(req.query.q || ''));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/drivers/:name/routes/pending — маршруты водителя для приёмки
app.get('/api/rk/drivers/:name/routes/pending', (req, res) => {
  try {
    res.json(rkStorage.getRoutesByDriverPending(decodeURIComponent(req.params.name)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/drivers/unshipped?q= — водители с неотгруженными маршрутами (для страницы кладовщика)
app.get('/api/rk/drivers/unshipped', (req, res) => {
  try {
    res.json(rkStorage.getDriversUnshipped(req.query.q || ''));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/drivers/:name/routes/unshipped — неотгруженные маршруты водителя
app.get('/api/rk/drivers/:name/routes/unshipped', (req, res) => {
  try {
    res.json(rkStorage.getRoutesByDriverUnshipped(decodeURIComponent(req.params.name)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/routes-search?q=&mode=unshipped|pending — поиск маршрутов для страницы кладовщика
app.get('/api/rk/routes-search', (req, res) => {
  try {
    const { q, mode } = req.query;
    const status = mode === 'unshipped' ? 'unshipped' : mode === 'pending' ? 'pending' : undefined;
    res.json(rkStorage.getRoutes({ q, status }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rk/cfz?q= — сводка по ЦФЗ
app.get('/api/rk/cfz', vsSessionRequired, (req, res) => {
  try {
    res.json(rkStorage.getByCfz({ q: req.query.q }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── React SPA ────────────────────────────────────────────────────────────────

const DIST_DIR = path.join(__dirname, '..', 'frontend', 'app', 'dist');

app.use(express.static(DIST_DIR));
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// ─── Опрос Telegram для привязки менеджеров (код в личку боту) ───────────────

let telegramPollingOffset = 0;

async function telegramBindingPollOnce() {
  try {
    const config = loadConfig();
    const botToken = String(config.telegramBotToken || '').trim();
    if (!botToken) return;
    const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getUpdates?offset=${telegramPollingOffset}&timeout=20`;
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!data?.ok || !Array.isArray(data.result)) return;
    for (const upd of data.result) {
      if (upd.update_id >= telegramPollingOffset) telegramPollingOffset = upd.update_id + 1;
      const msg = upd.message || upd.edited_message;
      if (!msg?.text) continue;
      const text = String(msg.text).trim().toUpperCase();
      const chatId = msg.chat?.id;
      if (!chatId) continue;
      const login = vsAuth.consumeBindingCode(text);
      if (login) {
        vsAuth.setTelegramChatId(login, String(chatId));
        await sendTelegramMessage(botToken, chatId, '✅ Привязано. Отчёты по статистике будут приходить сюда.');
      }
    }
  } catch (_) {
    // игнорируем ошибки опроса
  }
}

function startTelegramBindingPolling() {
  setInterval(telegramBindingPollOnce, 3000);
}

app.listen(PORT, '0.0.0.0', () => {
  scheduler.ensureDataDir();
  startTelegramBindingPolling();
  console.log(`Сервер: http://localhost:${PORT} (доступен по сети на порту ${PORT})`);
});
