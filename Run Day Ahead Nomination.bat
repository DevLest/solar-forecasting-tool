@echo off
title Day Ahead Nomination
cd /d "%~dp0"

REM Try different ways to run Python on Windows
py -3 main_nomination.py 2>nul
if %errorlevel% equ 0 goto :done

python main_nomination.py 2>nul
if %errorlevel% equ 0 goto :done

python3 main_nomination.py 2>nul
if %errorlevel% equ 0 goto :done

REM Try common Python install locations (e.g. from python.org installer)
for %%P in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "%ProgramFiles%\Python313\python.exe"
    "%ProgramFiles%\Python312\python.exe"
    "%ProgramFiles%\Python311\python.exe"
) do (
    if exist %%P (
        "%%~P" main_nomination.py
        goto :done
    )
)

:notfound
echo.
echo Python was not found.
echo.
echo Do one of the following:
echo   1. Install Python 3 from https://www.python.org/downloads/
echo      During setup, CHECK "Add Python to PATH", then run this file again.
echo.
echo   2. If Python is already installed, open Start Menu, type "Python",
echo      open "Python 3.x" and in the window type:
echo        cd /d "%~dp0"
echo        python main_nomination.py
echo.
pause
exit /b 1

:done
