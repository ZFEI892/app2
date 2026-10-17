@echo off
chcp 65001 >nul
title 试卷批改（关闭此窗口即停止服务）
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Users\34769\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=C:\Users\34769\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

if not defined NODE_EXE (
  echo 未找到 Node.js，无法启动。
  echo 请到 https://nodejs.org 装一个较新的 Node.js（推荐 22 LTS 或更高）后重试。
  pause
  exit /b 1
)

echo 正在启动，请稍等几秒（浏览器会自动打开）...
echo.
"%NODE_EXE%" --no-warnings "%~dp0server\index.js"

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
