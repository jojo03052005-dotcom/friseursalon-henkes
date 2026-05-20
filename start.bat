@echo off
cd /d "%~dp0"
if exist "C:\Program Files\nodejs\npm.cmd" (
  "C:\Program Files\nodejs\npm.cmd" start
) else (
  npm start
)
