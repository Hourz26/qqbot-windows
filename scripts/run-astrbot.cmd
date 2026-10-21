@echo off
chcp 65001 >nul
cd /d C:\Apps\astrbot
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
"C:\Apps\astrbot-venv\Scripts\astrbot.exe" run >> "C:\Apps\astrbot\run.log" 2>> "C:\Apps\astrbot\run.err.log"