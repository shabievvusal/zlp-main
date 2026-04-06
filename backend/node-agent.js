/**
 * node-agent.js — агент ноды для связи с панелью управления.
 * Отвечает за: статус, SSO-вход разработчика, отключение, уничтожение.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DISABLED_PATH = path.join(__dirname, 'data', 'node-disabled');
const NODE_TOKEN = (process.env.NODE_TOKEN || '').trim();
const NODE_NAME  = (process.env.NODE_NAME  || 'Нода').trim();
const SSO_TTL_MS = 60 * 1000; // токен живёт 60 секунд

const ssoTokens = new Map(); // token → expiresAt

// ─── Состояние ноды ────────────────────────────────────────────────────────────

function isDisabled() {
  try { return fs.existsSync(DISABLED_PATH); } catch { return false; }
}

function disable() {
  try {
    const dir = path.dirname(DISABLED_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISABLED_PATH, new Date().toISOString(), 'utf8');
  } catch {}
}

function enable() {
  try { if (fs.existsSync(DISABLED_PATH)) fs.unlinkSync(DISABLED_PATH); } catch {}
}

// ─── Аутентификация ────────────────────────────────────────────────────────────

function verifyNodeToken(token) {
  if (!NODE_TOKEN || !token) return false;
  // timing-safe сравнение
  try {
    const a = Buffer.from(String(token));
    const b = Buffer.from(NODE_TOKEN);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ─── SSO токены (одноразовые) ──────────────────────────────────────────────────

function createSSOToken() {
  // Очищаем протухшие
  const now = Date.now();
  for (const [t, exp] of ssoTokens) {
    if (now > exp) ssoTokens.delete(t);
  }
  const token = crypto.randomBytes(32).toString('hex');
  ssoTokens.set(token, now + SSO_TTL_MS);
  return token;
}

function consumeSSOToken(token) {
  if (!token) return false;
  const exp = ssoTokens.get(token);
  if (!exp) return false;
  ssoTokens.delete(token);
  return Date.now() <= exp;
}

// ─── Уничтожение ──────────────────────────────────────────────────────────────

/** Запрос к Docker API через unix-сокет. */
function dockerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const opts = {
      socketPath: '/var/run/docker.sock',
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function destroyNode() {
  setTimeout(async () => {
    const DOCKER_SOCK = '/var/run/docker.sock';
    const inDocker = fs.existsSync(DOCKER_SOCK) && fs.existsSync('/.dockerenv');

    if (inDocker) {
      const { execSync } = require('child_process');
      const containerId = require('os').hostname();

      // 1. Получаем инфо о контейнере
      let imageId = null;
      let volumeName = null;
      try {
        const infoRes = await dockerRequest('GET', `/v1.41/containers/${containerId}/json`);
        const info = JSON.parse(infoRes.body);
        imageId = info.Image || null;
        const mount = (info.Mounts || []).find(m => m.Destination === '/app/persist');
        volumeName = mount?.Name || null;
      } catch {}

      // 2. Удаляем файлы проекта на хосте
      try {
        execSync('find /app/host-project -mindepth 1 -delete');
      } catch {}

      // 3. Удаляем файлы проекта на хосте
      try {
        execSync('find /app/host-project -mindepth 1 -delete');
      } catch {}

      // 4. Записываем маркер с ID образа в папку проекта на хосте.
      //    При следующем docker compose up entrypoint найдёт его и удалит образ.
      try {
        if (imageId) {
          const marker = JSON.stringify({ imageId, volumeName });
          fs.writeFileSync('/app/host-project/.destroy', marker, 'utf8');
        }
      } catch {}

      // 5. Выходим — on-failure не рестартует при коде 0
      process.exit(0);

    } else {
      // Bare-metal: удаляем папку проекта и выходим
      try {
        const { execSync } = require('child_process');
        const projectRoot = path.resolve(path.join(__dirname, '..'));
        if (process.platform === 'win32') {
          execSync(`rmdir /s /q "${projectRoot}"`);
        } else {
          execSync(`rm -rf --one-file-system "${projectRoot}"`);
        }
      } catch {}
      process.exit(0);
    }
  }, 300);
}

module.exports = {
  isDisabled,
  disable,
  enable,
  verifyNodeToken,
  createSSOToken,
  consumeSSOToken,
  destroyNode,
  NODE_NAME,
};
