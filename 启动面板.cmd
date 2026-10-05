@echo off
node.exe "%~dp0plugins\start-buttons\dist\panel.mjs" --open
if errorlevel 1 pause
