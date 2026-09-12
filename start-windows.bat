@echo off
rem 假装 AI - Windows 启动（PRD §12.2）
rem
rem 这一层只负责把 PowerShell 脚本拉起来（引导层不依赖 Node）。
rem 真正的下载/校验/装依赖/构建/起服务都在 scripts\bootstrap.ps1 和 scripts\*.mjs 里。
rem
rem 关闭这个窗口 = 停止服务。不需要卸载：项目只写自己目录里的 .runtime / logs / data / coding\node_modules。

setlocal
chcp 65001 >nul
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo 系统里找不到 powershell，无法继续。
  pause
  exit /b 3
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" -Action start %*
set CODE=%ERRORLEVEL%

echo.
if "%CODE%"=="0" (
  echo 已停止。关闭本窗口即彻底退出，原公网链接与工作会话同时失效。
) else (
  echo 启动流程未成功，退出码 %CODE%。上面最后几行就是原因，详细日志在 logs 目录。
)
pause
exit /b %CODE%
