/**
 * Миграция существующих фото на S3 (RustFS/MinIO).
 * Запускать внутри контейнера: node backend/migrate-to-s3.js
 */

const fs   = require('fs');
const path = require('path');
const s3   = require('./s3');

const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const RK_PHOTO_DIR = path.join(__dirname, 'data', 'rk-photos');

let ok = 0, skip = 0, fail = 0;

async function uploadFile(localPath, s3Key) {
  const buffer = fs.readFileSync(localPath);
  await s3.uploadFile(s3Key, buffer, guessContentType(localPath));
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif')  return 'image/gif';
  return 'image/jpeg';
}

async function migrateDir(dir, s3Prefix, label) {
  if (!fs.existsSync(dir)) {
    console.log(`[SKIP] ${label}: папка не найдена`);
    return;
  }

  const files = fs.readdirSync(dir).filter(f => {
    const full = path.join(dir, f);
    return fs.statSync(full).isFile();
  });

  console.log(`\n[${label}] Найдено файлов: ${files.length}`);
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const localPath = path.join(dir, file);
    const s3Key = `${s3Prefix}/${file}`;

    try {
      await uploadFile(localPath, s3Key);
      ok++;
    } catch (err) {
      fail++;
      console.error(`  [ERROR] ${file}: ${err.message}`);
    }

    if ((i + 1) % 50 === 0 || i + 1 === files.length) {
      const done = i + 1;
      const left = files.length - done;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = done / elapsed;
      const etaSec = left / speed;
      const eta = etaSec > 60
        ? `${Math.round(etaSec / 60)} мин`
        : `${Math.round(etaSec)} сек`;
      const pct = Math.round((done / files.length) * 100);
      console.log(`  [${label}] ${done}/${files.length} (${pct}%) — осталось: ${left} файлов, ~${eta}`);
    }
  }
}

async function migrateThumbs() {
  const thumbDir = path.join(RK_PHOTO_DIR, 'thumbs');
  if (!fs.existsSync(thumbDir)) return;

  const files = fs.readdirSync(thumbDir).filter(f =>
    fs.statSync(path.join(thumbDir, f)).isFile()
  );

  console.log(`\n[rk-photos/thumbs] Найдено файлов: ${files.length}`);
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      await uploadFile(path.join(thumbDir, file), `rk-photos/thumbs/${file}`);
      ok++;
    } catch (err) {
      fail++;
      console.error(`  [ERROR] ${file}: ${err.message}`);
    }

    if ((i + 1) % 50 === 0 || i + 1 === files.length) {
      const done = i + 1;
      const left = files.length - done;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = done / elapsed;
      const etaSec = left / speed;
      const eta = etaSec > 60
        ? `${Math.round(etaSec / 60)} мин`
        : `${Math.round(etaSec)} сек`;
      const pct = Math.round((done / files.length) * 100);
      console.log(`  [rk-photos/thumbs] ${done}/${files.length} (${pct}%) — осталось: ${left} файлов, ~${eta}`);
    }
  }
}

async function main() {
  console.log('=== Миграция фото на S3 ===');
  console.log(`Endpoint: ${process.env.S3_ENDPOINT}`);
  console.log(`Bucket:   ${process.env.S3_BUCKET}`);

  await migrateDir(UPLOADS_DIR,  'consolidation', 'consolidation');
  await migrateDir(RK_PHOTO_DIR, 'rk-photos',     'rk-photos');
  await migrateThumbs();

  console.log(`\n=== Готово: ${ok} загружено, ${fail} ошибок ===`);

  if (fail === 0) {
    console.log('\nВсе файлы загружены успешно.');
    console.log('Теперь можно удалить локальные файлы для освобождения диска:');
    console.log(`  rm -rf ${UPLOADS_DIR}/*`);
    console.log(`  rm -rf ${RK_PHOTO_DIR}/*`);
  }
}

main().catch(err => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
