@echo off
setlocal
cd /d "%~dp0"
REM Copy run.local.example.bat to run.local.bat and set your own values.
if exist run.local.bat call run.local.bat
py worker.py
pause
