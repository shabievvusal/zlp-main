/**
 * Обновляет consolidation.json и route-rk.json — заменяет имена файлов
 * на прямые S3 URL. Безопасно запускать повторно.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR          = path.join(__dirname, 'data');
const CONSOLIDATION_PATH = path.join(DATA_DIR, 'consolidation.json');
const RK_PATH            = path.join(DATA_DIR, 'route-rk.json');

const S3_PUBLIC_URL = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');
const S3_BUCKET     = process.env.S3_BUCKET || 'zlp-media';

if (!S3_PUBLIC_URL) {
  console.error('Ошибка: S3_PUBLIC_URL не задан в .env');
  process.exit(1);
}

function toS3Url(folder, name) {
  if (!name) return name;
  if (name.startsWith('http')) return name;
  return `${S3_PUBLIC_URL}/${S3_BUCKET}/${folder}/${name}`;
}

function rkPhotoToS3Url(url) {
  if (!url) return url;
  if (url.startsWith('http')) return url;
  // /rk-photos/filename.jpg → S3 URL
  const filename = url.replace('/rk-photos/', '');
  return `${S3_PUBLIC_URL}/${S3_BUCKET}/rk-photos/${filename}`;
}

// ─── Консолидация ─────────────────────────────────────────────────────────────
let consolidationUpdated = 0;

if (fs.existsSync(CONSOLIDATION_PATH)) {
  const list = JSON.parse(fs.readFileSync(CONSOLIDATION_PATH, 'utf-8'));

  for (const item of list) {
    let changed = false;

    if (item.photoFilename && !item.photoFilename.startsWith('http')) {
      item.photoFilename = toS3Url('consolidation', item.photoFilename);
      changed = true;
    }

    if (Array.isArray(item.photoFilenames)) {
      item.photoFilenames = item.photoFilenames.map(n => toS3Url('consolidation', n));
      changed = true;
    }

    if (changed) consolidationUpdated++;
  }

  fs.writeFileSync(CONSOLIDATION_PATH, JSON.stringify(list, null, 2), 'utf-8');
  console.log(`consolidation.json: обновлено ${consolidationUpdated} записей`);
} else {
  console.log('consolidation.json: не найден, пропуск');
}

// ─── РК маршруты ──────────────────────────────────────────────────────────────
let rkUpdated = 0;

if (fs.existsSync(RK_PATH)) {
  const data = JSON.parse(fs.readFileSync(RK_PATH, 'utf-8'));

  for (const route of Object.values(data)) {
    let changed = false;

    if (route.shipment?.photos) {
      route.shipment.photos = route.shipment.photos.map(u => rkPhotoToS3Url(u));
      changed = true;
    }
    if (route.receiving?.photos) {
      route.receiving.photos = route.receiving.photos.map(u => rkPhotoToS3Url(u));
      changed = true;
    }

    if (changed) rkUpdated++;
  }

  fs.writeFileSync(RK_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`route-rk.json: обновлено ${rkUpdated} маршрутов`);
} else {
  console.log('route-rk.json: не найден, пропуск');
}

console.log('\nГотово. Перезапусти сервер: docker compose restart');
