@echo off
:: Installs/updates everything the app needs (Python packages + Playwright's Chromium).
:: Called by Update.bat (full mode) and ARECO65.bat (/quiet: packages only, less output).
:: Uses %ARECO_PY% / %ARECO_EMBED% when the caller already picked a Python.
:: Exit codes: 0 = ok, 1 = install failed, 2 = no Python found yet.
setlocal
set "ROOT=%~dp0..\"
set "PY_EMBED_DIR=%ROOT%.python"
set "QUIET=0"
if /i "%~1"=="/quiet" set "QUIET=1"

:: Same order as ARECO65.bat: system Python, then the py launcher, then the portable copy
if defined ARECO_PY goto have_py
set "ARECO_EMBED=0"
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>nul && set "ARECO_PY=python"
if not defined ARECO_PY py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>nul && set "ARECO_PY=py -3"
if not defined ARECO_PY if exist "%PY_EMBED_DIR%\python.exe" (
  set ARECO_PY="%PY_EMBED_DIR%\python.exe"
  set "ARECO_EMBED=1"
)
if not defined ARECO_PY (
  echo   Python is not set up on this computer yet.
  echo   Packages will be installed automatically the first time you start ARECO65.bat.
  exit /b 2
)

:have_py
:: The portable (embeddable) Python ships without pip - set it up once
if "%ARECO_EMBED%"=="1" (
  %ARECO_PY% -m pip --version >nul 2>nul
  if errorlevel 1 (
    call :bootstrap_pip
    if errorlevel 1 (
      echo [PROBLEM] Could not set up the package installer for portable Python.
      exit /b 1
    )
  )
)

if "%QUIET%"=="0" echo   Installing Python packages (this can take a few minutes if there are new ones)...
%ARECO_PY% -m pip install -q --disable-pip-version-check --no-warn-script-location -r "%ROOT%requirements.txt"
if errorlevel 1 (
  echo [PROBLEM] Some Python packages could not be installed.
  exit /b 1
)
if "%QUIET%"=="1" exit /b 0
echo   Python packages are up to date.
echo.

:: Headless browser for the live plant-output stream OCR (quick no-op once installed)
echo   Checking the browser used for live stream reading...
%ARECO_PY% -m playwright install chromium
if errorlevel 1 (
  echo [WARNING] The browser for live stream reading could not be installed.
  echo   Everything else works; only the live plant-output reading is affected.
) else (
  echo   Browser is ready.
)
echo.

:: Tesseract is an optional OCR fallback (RapidOCR is used first); pip can't install it
where tesseract >nul 2>nul
if errorlevel 1 (
  echo [NOTE] Optional: Tesseract OCR is not installed. Not required - the app uses
  echo   RapidOCR first. To add it as a fallback, install it from
  echo   https://github.com/UB-Mannheim/tesseract/wiki and add it to PATH.
  echo.
)
exit /b 0

:bootstrap_pip
echo   Setting up the package installer for portable Python (one-time)...
:: Enable site-packages, which the embeddable build turns off by default
for %%F in ("%PY_EMBED_DIR%\python*._pth") do (
  powershell -NoProfile -Command "$p='%%~fF'; (Get-Content -LiteralPath $p) -replace '^#\s*import site','import site' | Set-Content -LiteralPath $p -Encoding ascii"
)
curl -sL -o "%PY_EMBED_DIR%\get-pip.py" "https://bootstrap.pypa.io/get-pip.py"
if not exist "%PY_EMBED_DIR%\get-pip.py" exit /b 1
%ARECO_PY% "%PY_EMBED_DIR%\get-pip.py" -q --no-warn-script-location
set "RC=%errorlevel%"
del "%PY_EMBED_DIR%\get-pip.py" 2>nul
exit /b %RC%
