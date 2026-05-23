@echo off
cd /d "%~dp0"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
start "Laser Body Studio server" /D "%~dp0" /min "%NODE_EXE%" server.js
timeout /t 1 /nobreak >nul
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" "http://localhost:4173/"
) else (
  start "" "http://localhost:4173/"
)
