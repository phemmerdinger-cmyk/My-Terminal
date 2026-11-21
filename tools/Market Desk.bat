@echo off
title Market Desk (private)
REM Double-click to open your private Market Desk. Keep this window open while you use it; close it when you're done.

set "APP=%USERPROFILE%\Documents\My-Terminal"
set "KEYDIR=%LOCALAPPDATA%\MarketDesk"
set "KEYFILE=%KEYDIR%\desk_token.txt"

if exist "%APP%\server.js" goto havecode
echo Couldn't find the Market Desk code in %APP%.
pause
exit /b

:havecode
REM Always run the newest version: download the latest code from GitHub (public repo) and copy it over this copy.
REM Your Node.js (My-Terminal\node) and your saved key are kept. If the download fails, the current copy starts.
echo Checking for the latest version of Market Desk...
set "UPD=%TEMP%\MarketDeskUpdate"
if exist "%UPD%" rmdir /s /q "%UPD%"
mkdir "%UPD%" >nul 2>nul
curl -sfL --max-time 90 -o "%UPD%\main.zip" "https://github.com/phemmerdinger-cmyk/My-Terminal/archive/refs/heads/main.zip"
if errorlevel 1 goto noupdate
tar -xf "%UPD%\main.zip" -C "%UPD%"
if errorlevel 1 goto noupdate
if not exist "%UPD%\My-Terminal-main\server.js" goto noupdate
robocopy "%UPD%\My-Terminal-main" "%APP%" /E /XD .github tests /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto noupdate
echo Up to date.
goto updated
:noupdate
echo Couldn't check for updates right now; starting the version you already have.
:updated
rmdir /s /q "%UPD%" >nul 2>nul
set "DESK_TOKEN="
if exist "%KEYFILE%" set /p DESK_TOKEN=<"%KEYFILE%"
if defined DESK_TOKEN goto havekey

echo.
echo  First-time setup: your desk needs its key.
echo  1. In Render, on the DESK_TOKEN row, click the copy icon (two squares).
echo  2. Right-click inside this black window to paste it, then press Enter.
echo.
set /p "DESK_TOKEN=Key: "
if not defined DESK_TOKEN goto nokey
if not exist "%KEYDIR%" mkdir "%KEYDIR%"
>"%KEYFILE%" echo %DESK_TOKEN%
echo Saved. You won't be asked again.
goto havekey

:nokey
echo No key entered. Close this window and double-click Market Desk to try again.
pause
exit /b

:havekey
REM Use the portable Node.js in My-Terminal\node, otherwise an installed one
set "NODE="
if exist "%APP%\node\node.exe" set "NODE=%APP%\node\node.exe"
if defined NODE goto run
where node >nul 2>nul && set "NODE=node"
if defined NODE goto run
echo Node.js wasn't found in %APP%\node.
pause
exit /b

:run
cd /d "%APP%"
set "MODE=local"
set "PUBLIC_URL=https://my-terminal-28tq.onrender.com"
echo Starting your desk... your browser opens as soon as it is ready. Keep this window open while you use it.
REM Open the browser only once the desk answers (checks every second for up to a minute)
REM Your saved portfolios live in Chrome's copy of the desk, so open Chrome when it's installed (otherwise the default browser)
set "OPENB="
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>nul && set "OPENB=chrome"
if not defined OPENB reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>nul && set "OPENB=chrome"
start "" /min cmd /c "for /l %%i in (1,1,60) do (curl -s -o nul http://127.0.0.1:3000/api/health && (start "" %OPENB% http://127.0.0.1:3000 & exit) || timeout /t 1 >nul)"
"%NODE%" server.js
echo.
echo Market Desk stopped. If it says DESK_TOKEN is wrong, delete %KEYFILE% and start again.
pause
