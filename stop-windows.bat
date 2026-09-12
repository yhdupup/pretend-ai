@echo off
rem 假装 AI - Windows 停止
rem 正常情况下不需要它：关掉启动时那个窗口就是停止。
rem 它只停「自己能认出来的进程」，认不出来什么都不杀。

setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" -Action stop
set CODE=%ERRORLEVEL%

echo.
if not "%CODE%"=="0" echo 停止流程没有完全成功，退出码 %CODE%。
pause
exit /b %CODE%
