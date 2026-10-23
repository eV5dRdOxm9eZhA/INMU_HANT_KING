@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org/ からインストールしてください。
  pause & exit /b 1
)
if not exist "vendor\models\pose_landmarker_lite.task" (
  echo 初回準備: 判定エンジンとモデルを取得します...
  call npm install || (pause & exit /b 1)
  call npm run vendor || (pause & exit /b 1)
)
start "" http://localhost:8080/
node scripts\serve.mjs
pause
