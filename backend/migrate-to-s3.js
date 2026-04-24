/**
 * Миграция существующих фото на S3 (RustFS/MinIO).
 * Запускать внутри контейнера: node backend/migrate-to-s3.js
 */

const fs   = require('fs');
const path = require('path');
const s3   = require('./s3');

const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const RK_PHOTO_DIR = path.join(__dirname, 'data', 'rk-photos');
const CONCURRENCY  = 10;

let totalOk = 0, totalFail = 0;

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

function progressBar(done, total, width = 30) {
  const pct  = done / total;
  const fill = Math.round(pct * width);
  const bar  = '█'.repeat(fill) + '░'.repeat(width - fill);
  return `[${bar}] ${done}/${total} (${Math.round(pct * 100)}%)`;
}

function formatEta(sec) {
  if (sec < 60)   return `${Math.round(sec)} сек`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  return `${(sec / 3600).toFixed(1)} ч`;
}

async function uploadOne(localPath, s3Key) {
  const stat      = fs.statSync(localPath);
  const fileSize  = stat.size;
  const buffer    = fs.readFileSync(localPath);
  const t0        = Date.now();
  await s3.uploadFile(s3Key, buffer, guessContentType(localPath));
  const elapsed   = (Date.now() - t0) / 1000 || 0.001;
  const speed     = fileSize / elapsed;
  return { fileSize, speed };
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif')  return 'image/gif';
  return 'image/jpeg';
}

async function runPool(tasks) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function migrateDir(dir, s3Prefix, label) {
  if (!fs.existsSync(dir)) {
    console.log(`[SKIP] ${label}: папка не найдена`);
    return;
  }

  const files = fs.readdirSync(dir).filter(f =>
    fs.statSync(path.join(dir, f)).isFile()
  );

  const total     = files.length;
  const startTime = Date.now();
  let done        = 0;
  let totalBytes  = 0;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${label}] Файлов: ${total} | Параллельность: ${CONCURRENCY}`);
  console.log('─'.repeat(60));

  const tasks = files.map(file => async () => {
    const localPath = path.join(dir, file);
    const s3Key     = `${s3Prefix}/${file}`;

    process.stdout.write(`  → ${file} `);

    try {
      const { fileSize, speed } = await uploadOne(localPath, s3Key);
      totalOk++;
      done++;
      totalBytes += fileSize;

      const elapsed     = (Date.now() - startTime) / 1000;
      const avgSpeed    = totalBytes / elapsed;
      const left        = total - done;
      const etaSec      = left / (done / elapsed);

      console.log(`✓ ${formatBytes(fileSize)} | ${formatSpeed(speed)}`);

      if (done % 50 === 0 || done === total) {
        console.log(`\n  ${progressBar(done, total)}`);
        console.log(`  Скорость: ${formatSpeed(avgSpeed)} | Осталось: ~${formatEta(etaSec)}\n`);
      }
    } catch (err) {
      totalFail++;
      done++;
      console.log(`✗ ОШИБКА: ${err.message}`);
    }
  });

  await runPool(tasks);
}

async function migrateThumbs() {
  const thumbDir = path.join(RK_PHOTO_DIR, 'thumbs');
  if (!fs.existsSync(thumbDir)) return;

  const files = fs.readdirSync(thumbDir).filter(f =>
    fs.statSync(path.join(thumbDir, f)).isFile()
  );

  const total     = files.length;
  const startTime = Date.now();
  let done        = 0;
  let totalBytes  = 0;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[rk-photos/thumbs] Файлов: ${total} | Параллельность: ${CONCURRENCY}`);
  console.log('─'.repeat(60));

  const tasks = files.map(file => async () => {
    const localPath = path.join(thumbDir, file);
    const s3Key     = `rk-photos/thumbs/${file}`;

    process.stdout.write(`  → ${file} `);

    try {
      const { fileSize, speed } = await uploadOne(localPath, s3Key);
      totalOk++;
      done++;
      totalBytes += fileSize;

      const elapsed  = (Date.now() - startTime) / 1000;
      const avgSpeed = totalBytes / elapsed;
      const etaSec   = (total - done) / (done / elapsed);

      console.log(`✓ ${formatBytes(fileSize)} | ${formatSpeed(speed)}`);

      if (done % 50 === 0 || done === total) {
        console.log(`\n  ${progressBar(done, total)}`);
        console.log(`  Скорость: ${formatSpeed(avgSpeed)} | Осталось: ~${formatEta(etaSec)}\n`);
      }
    } catch (err) {
      totalFail++;
      done++;
      console.log(`✗ ОШИБКА: ${err.message}`);
    }
  });

  await runPool(tasks);
}

async function main() {
  console.log('═'.repeat(60));
  console.log('  МИГРАЦИЯ ФОТО НА S3');
  console.log(`  Endpoint : ${process.env.S3_ENDPOINT}`);
  console.log(`  Bucket   : ${process.env.S3_BUCKET}`);
  console.log(`  Старт    : ${new Date().toLocaleString('ru')}`);
  console.log('═'.repeat(60));

  await migrateDir(UPLOADS_DIR,  'consolidation', 'consolidation');
  await migrateDir(RK_PHOTO_DIR, 'rk-photos',     'rk-photos');
  await migrateThumbs();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ИТОГ: ✓ ${totalOk} загружено | ✗ ${totalFail} ошибок`);
  console.log(`  Завершено: ${new Date().toLocaleString('ru')}`);
  console.log('═'.repeat(60));

  if (totalFail === 0) {
    console.log('\n  Все файлы загружены. Для освобождения диска:');
    console.log(`    rm -rf ${UPLOADS_DIR}/*`);
    console.log(`    rm -rf ${RK_PHOTO_DIR}/*`);
  }
}

main().catch(err => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
