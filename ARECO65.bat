@echo off
:: Icon for shortcut: right-click shortcut -> Properties -> Change Icon -> browse to:
::   %~dp0assets\areco-pwa-192.png  or  areco-favicon-48.png  (or convert to .ico)
setlocal
cd /d "%~dp0"
set "PY_EMBED_URL=https://www.python.org/ftp/python/3.12.9/python-3.12.9-embed-amd64.zip"
set "PY_EMBED_DIR=%~dp0.python"
set "PY_EMBED_ZIP=%~dp0py_embed.zip"

:: Prefer system Python, then the py launcher
set "ARECO_PY="
set "ARECO_EMBED=0"
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>nul && set "ARECO_PY=python"
if not defined ARECO_PY py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>nul && set "ARECO_PY=py -3"
if defined ARECO_PY goto run

:: Use local portable Python if already present
if exist "%PY_EMBED_DIR%\python.exe" goto run_embed

:: Download portable Python (one-time)
echo Python not found. Downloading portable Python (one-time, ~25 MB)...
curl -sL -o "%PY_EMBED_ZIP%" "%PY_EMBED_URL%"
if not exist "%PY_EMBED_ZIP%" goto no_curl
for %%A in ("%PY_EMBED_ZIP%") do if %%~zA lss 1000000 goto no_curl

if not exist "%PY_EMBED_DIR%" mkdir "%PY_EMBED_DIR%"
tar -xf "%PY_EMBED_ZIP%" -C "%PY_EMBED_DIR%" 2>nul
if not exist "%PY_EMBED_DIR%\python.exe" (
  powershell -NoProfile -Command "Expand-Archive -Path '%PY_EMBED_ZIP%' -DestinationPath '%PY_EMBED_DIR%' -Force" 2>nul
)
if exist "%PY_EMBED_DIR%\python.exe" (
  del "%PY_EMBED_ZIP%" 2>nul
  goto run_embed
)
:: Some extractions create a subfolder
for /d %%D in ("%PY_EMBED_DIR%\python-*") do (
  move "%%~D\*" "%PY_EMBED_DIR%\"
  rmdir "%%~D" 2>nul
)
del "%PY_EMBED_ZIP%" 2>nul
if exist "%PY_EMBED_DIR%\python.exe" goto run_embed

:no_curl
echo.
echo Could not install Python automatically. Please install Python 3 from:
echo   https://www.python.org/downloads/
echo Then run this script again or run:  python run_dashboard.py
pause
exit /b 1

:run_embed
set ARECO_PY="%PY_EMBED_DIR%\python.exe"
set "ARECO_EMBED=1"

:run
call "%~dp0tools\install_requirements.bat" /quiet
if errorlevel 1 (
  echo.
  echo [WARNING] Some required packages could not be installed - check your internet
  echo connection. Starting anyway; some features may not work.
  echo.
)
%ARECO_PY% "%~dp0run_dashboard.py"
goto end

:end
endlocal
