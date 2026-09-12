@echo off
:: Double-click this file to safely update the app to the latest version.
:: It saves any local changes first, so nothing you have is ever lost.
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "DID_STASH=0"

echo ============================================
echo   ARECO Solar Forecasting Tool - Updater
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [PROBLEM] Git is not installed on this computer, so it can't update itself.
    echo Please ask for help installing Git from:
    echo   https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
)

if not exist ".git" (
    echo [PROBLEM] This folder does not look like the project folder.
    echo Please contact support - do not continue.
    echo.
    pause
    exit /b 1
)

echo Checking your current version...
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
echo   You are on: %BRANCH%
echo.

echo Checking if you have any unsaved local changes...
set "STATUS_LINES=0"
for /f %%u in ('git status --porcelain') do set /a STATUS_LINES+=1

if not "%STATUS_LINES%"=="0" (
    echo   Found some local changes. Backing them up safely first...
    for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
    git stash push -u -m "auto-backup-before-update-!STAMP!" >nul
    if errorlevel 1 (
        echo.
        echo [PROBLEM] Could not back up your local changes safely.
        echo Stopping now so nothing gets lost. Please contact support.
        echo.
        pause
        exit /b 1
    )
    set "DID_STASH=1"
    echo   Done. Your local changes are safely backed up.
) else (
    echo   No local changes found. Nothing to back up.
)
echo.

echo Downloading the latest update...
git pull --ff-only
if errorlevel 1 (
    echo.
    echo [PROBLEM] The update could not be downloaded automatically.
    echo Nothing on your computer was changed.
    if "%DID_STASH%"=="1" (
        echo Your local changes are still safely backed up and untouched.
    )
    echo Please contact support for help - do not try to fix this yourself.
    echo.
    pause
    exit /b 1
)
echo   Update downloaded successfully.
echo.

if "%DID_STASH%"=="1" (
    echo Restoring your local changes...
    git stash pop
    if errorlevel 1 (
        echo.
        echo [NOTICE] Your local changes could not be restored automatically.
        echo Don't worry - nothing was lost, they are still safely backed up.
        echo Please contact support so they can restore them for you.
        echo.
        pause
        exit /b 1
    )
    echo   Your local changes were restored.
    echo.
)

echo ============================================
echo   Update complete!
echo   You can now run ARECO65.bat as usual.
echo ============================================
echo.
pause
