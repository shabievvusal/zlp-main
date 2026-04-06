#!/bin/sh
set -e

# ─── Проверка маркера уничтожения ─────────────────────────────────────────────
# Если предыдущий запуск записал .destroy — удаляем образ и том, затем выходим
if [ -f "/app/host-project/.destroy" ]; then
  node -e "
    const fs = require('fs');
    const http = require('http');
    let marker = {};
    try { marker = JSON.parse(fs.readFileSync('/app/host-project/.destroy', 'utf8')); } catch {}
    function del(p) {
      return new Promise(resolve => {
        const req = http.request({ socketPath: '/var/run/docker.sock', method: 'DELETE', path: p }, res => {
          res.resume(); res.on('end', resolve);
        });
        req.on('error', resolve);
        req.end();
      });
    }
    (async () => {
      if (marker.volumeName) await del('/v1.41/volumes/' + marker.volumeName + '?force=true');
      if (marker.imageId)    await del('/v1.41/images/'  + encodeURIComponent(marker.imageId) + '?force=true');
      process.exit(0);
    })();
  "
  exit 0
fi

PERSIST=/app/persist
mkdir -p "$PERSIST/data"

# Инициализируем файлы при первом запуске
[ -f "$PERSIST/vs-users.json" ] || echo '{"users":[]}' > "$PERSIST/vs-users.json"
[ -f "$PERSIST/config.json"   ] || cp /app/backend/config.json.default "$PERSIST/config.json"
[ -f "$PERSIST/empl.csv"      ] || touch "$PERSIST/empl.csv"
mkdir -p "$PERSIST/uploads"

# Подменяем файлы симлинками на персистентный том
ln -sf "$PERSIST/vs-users.json" /app/backend/vs-users.json
ln -sf "$PERSIST/config.json"   /app/backend/config.json
ln -sf "$PERSIST/empl.csv"      /app/empl.csv
rm -rf /app/backend/uploads
ln -sf "$PERSIST/uploads"       /app/backend/uploads

# Подменяем папку data
rm -rf /app/backend/data
ln -sf "$PERSIST/data" /app/backend/data

exec node backend/server.js
