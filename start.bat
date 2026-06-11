@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
title OWMS Samokat Collector

cd /d "%~dp0"

set "PROJECT_NAME=OWMS Samokat Collector"
set "DEFAULT_PORT=3001"

rem Read PORT from .env (only PORT=... line)
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (`findstr /R /I "^PORT=" ".env"`) do (
        set "%%A=%%B"
    )
)
if not defined PORT set "PORT=%DEFAULT_PORT%"

echo ==============================================
echo   %PROJECT_NAME%
echo   Port: %PORT%
echo ==============================================

rem 1. Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Install Node.js 18+ from https://nodejs.org/
    goto end
)

for /f "tokens=1 delims=." %%V in ('node -v 2^>nul') do set "NODE_VER=%%V"
set "NODE_VER=%NODE_VER:v=%"
if %NODE_VER% LSS 18 (
    echo [ERROR] Node.js 18+ required. Current: v%NODE_VER%
    echo Update from https://nodejs.org/
    goto end
)

for /f "delims=" %%V in ('node -v') do echo [OK] Node.js %%V

rem 2. npm dependencies
if not exist node_modules (
    echo [*] Installing dependencies...
    call npm install
) else (
    echo [*] Checking dependencies...
    call npm install --no-audit --no-fund 2>nul
    if errorlevel 1 call npm install
)
echo [OK] Dependencies ready.

rem 2.1 .NET dependencies (save-fetched-data)
where dotnet >nul 2>&1
if errorlevel 1 goto no_dotnet

for /f "delims=" %%V in ('dotnet --version') do echo [OK] dotnet %%V
if not exist tools\SaveFetchedData\SaveFetchedData.csproj goto no_tools

echo [*] Restoring .NET dependencies...
dotnet restore tools\SaveFetchedData\SaveFetchedData.csproj >nul
if exist tools\WeightScan\WeightScan.csproj dotnet restore tools\WeightScan\WeightScan.csproj >nul
if exist tools\MissingWeightRebuild\MissingWeightRebuild.csproj dotnet restore tools\MissingWeightRebuild\MissingWeightRebuild.csproj >nul
echo [*] Building .NET tools (Release)...
dotnet build tools\SaveFetchedData\SaveFetchedData.csproj -c Release >nul
if exist tools\MissingWeightRebuild\MissingWeightRebuild.csproj dotnet build tools\MissingWeightRebuild\MissingWeightRebuild.csproj -c Release >nul
if exist tools\SaveFetchedData\bin\Release\net9.0\SaveFetchedData.dll (
    echo [OK] .NET tools ready.
) else (
    echo [WARN] .NET build completed, but DLL not found.
)
goto start_server

:no_dotnet
echo [WARN] dotnet not found. save-fetched-data acceleration disabled.
goto start_server

:no_tools
echo [WARN] tools\SaveFetchedData not found. .NET step skipped.
goto start_server

:start_server
echo.
echo Server: http://localhost:%PORT%
echo Stop: Ctrl+C
echo ==============================================
node backend\server.js

echo.
if errorlevel 1 (
    echo [ERROR] Server stopped with error.
) else (
    echo [INFO] Server stopped.
)

:end
pause
