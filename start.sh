#!/bin/bash
# OWMS — бэкенд + React (Vite dev server)

cd "$(dirname "$0")"

PROJECT_NAME="OWMS Samokat Collector"
DEFAULT_PORT=3000

if [ -f .env ]; then
  source .env 2>/dev/null || true
fi
export PORT="${PORT:-$DEFAULT_PORT}"

echo "=============================================="
echo "  $PROJECT_NAME"
echo "  Бэкенд : http://localhost:$PORT"
echo "  React  : http://localhost:5173"
echo "=============================================="

# --- 1. Node.js >= 18 ---
check_node() {
  command -v node >/dev/null 2>&1 || return 1
  local ver
  ver=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  [ -n "$ver" ] && [ "$ver" -ge 18 ] 2>/dev/null
}

if ! check_node; then
  echo "[!] Node.js 18+ не найден. Установка..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  check_node || { echo "[ОШИБКА] Не удалось установить Node.js."; exit 1; }
fi
echo "[OK] Node.js $(node -v)"

# --- 2. Зависимости бэкенда ---
echo "[*] Зависимости бэкенда..."
npm install --no-audit --no-fund 2>/dev/null || npm install
echo "[OK] Бэкенд готов."

# --- 3. Зависимости React ---
if [ -d frontend/app ]; then
  echo "[*] Зависимости React..."
  (cd frontend/app && npm install --no-audit --no-fund 2>/dev/null || npm install)
  echo "[OK] React готов."
fi

# --- 4. .NET инструменты ---
if command -v dotnet >/dev/null 2>&1; then
  echo "[*] .NET $(dotnet --version) — сборка инструментов..."
  dotnet restore tools/SaveFetchedData/SaveFetchedData.csproj >/dev/null 2>&1 || true
  dotnet build   tools/SaveFetchedData/SaveFetchedData.csproj -c Release >/dev/null 2>&1 || true
  [ -f tools/MissingWeightRebuild/MissingWeightRebuild.csproj ] && \
    dotnet build tools/MissingWeightRebuild/MissingWeightRebuild.csproj -c Release >/dev/null 2>&1 || true
  echo "[OK] .NET готов."
else
  echo "[!] dotnet не найден — .NET ускорение отключено."
fi

# --- 5. Cleanup при выходе ---
BACKEND_PID=""
VITE_PID=""

cleanup() {
  echo ""
  echo "[*] Остановка..."
  [ -n "$VITE_PID" ]    && kill "$VITE_PID"    2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM EXIT

# --- 6. Запуск бэкенда ---
echo ""
echo "[*] Запуск бэкенда на порту $PORT..."
node backend/server.js &
BACKEND_PID=$!

# Ждём пока бэкенд поднимется (до 15 секунд)
echo -n "[*] Ожидание бэкенда"
for i in $(seq 1 30); do
  sleep 0.5
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo ""
    echo "[ОШИБКА] Бэкенд упал. Запустите вручную для диагностики:"
    echo "  node backend/server.js"
    exit 1
  fi
  if (echo > /dev/tcp/localhost/$PORT) 2>/dev/null; then
    echo " готов."
    break
  fi
  echo -n "."
done

# --- 7. Запуск React ---
if [ -d frontend/app ]; then
  echo "[*] Запуск React (Vite)..."
  (cd frontend/app && npm run dev) &
  VITE_PID=$!
  echo "[OK] Запущено. Открывай: http://localhost:5173"
  echo "     Остановка: Ctrl+C"
  echo "=============================================="
  wait "$VITE_PID"
else
  echo "[WARN] frontend/app не найден, работает только бэкенд."
  wait "$BACKEND_PID"
fi
