@echo off
setlocal
echo Close any portable Workbench copy and finish active tasks before installing.
echo Managed Workbench windows will be closed and reopened.
pause
set "PSModulePath="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Update.ps1"
if errorlevel 1 (
    echo Update failed. Review the message above before retrying.
    pause
    exit /b 1
)
echo Update complete.
pause
