# ─────────────────────────────────────────────────────────────────
# Stage 1: сборка React-фронтенда
# ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build
COPY frontend/app/package*.json ./
RUN npm ci
COPY frontend/app/ ./
RUN npm run build

# ─────────────────────────────────────────────────────────────────
# Stage 2: сборка .NET инструментов
# ─────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS dotnet-builder

WORKDIR /tools

COPY tools/ ./

RUN dotnet publish SaveFetchedData/SaveFetchedData.csproj \
        -c Release -o /out/SaveFetchedData \
        --self-contained false && \
    dotnet publish MissingWeightRebuild/MissingWeightRebuild.csproj \
        -c Release -o /out/MissingWeightRebuild \
        --self-contained false && \
    dotnet publish WeightScan/WeightScan.csproj \
        -c Release -o /out/WeightScan \
        --self-contained false

# ─────────────────────────────────────────────────────────────────
# Stage 3: production-образ ноды
# ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

# .NET 9.0 runtime + libvips для sharp
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
        libvips \
    && wget https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O /tmp/ms.deb \
    && dpkg -i /tmp/ms.deb \
    && rm /tmp/ms.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-runtime-9.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимости бэкенда
COPY package*.json ./
RUN npm ci --omit=dev

# Код бэкенда
COPY backend/ ./backend/

# Собранный React
COPY --from=frontend-builder /build/dist ./frontend/app/dist/

# Собранные .NET инструменты (в ожидаемые пути)
COPY --from=dotnet-builder /out/SaveFetchedData      ./tools/SaveFetchedData/bin/Release/net9.0/
COPY --from=dotnet-builder /out/MissingWeightRebuild ./tools/MissingWeightRebuild/bin/Release/net9.0/
COPY --from=dotnet-builder /out/WeightScan           ./tools/WeightScan/bin/Release/net9.0/

# Дефолтный конфиг для персистентного тома
RUN echo '{"intervalMinutes":5,"pageSize":500,"connectionMode":"browser"}' > backend/config.json.default && \
    mkdir -p backend/data

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3009

ENTRYPOINT ["./docker-entrypoint.sh"]
