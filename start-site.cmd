@echo off
cd /d "%~dp0"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" "%~dp0index.html"
) else (
  start "" "%~dp0index.html"
)
