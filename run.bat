@echo off
setlocal
cd /d "%~dp0"
set "PY_EMBED_URL=https://www.python.org/ftp/python/3.12.9/python-3.12.9-embed-amd64.zip"
set "PY_EMBED_DIR=%~dp0.python"
set "PY_EMBED_ZIP=%~dp0py_embed.zip"

:: Prefer system Python
where python >nul 2>nul
if %errorlevel% equ 0 (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" 2>nul
  if %errorlevel% equ 0 goto run
)
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" 2>nul
  if %errorlevel% equ 0 (
    py -3 "%~dp0run_dashboard.py"
    goto end
  )
)

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

:run
python "%~dp0run_dashboard.py"
goto end

:run_embed
"%PY_EMBED_DIR%\python.exe" "%~dp0run_dashboard.py"
goto end

:end
endlocal
