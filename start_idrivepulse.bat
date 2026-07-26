@echo off
setlocal
cd /d "%~dp0"

python -c "import fastapi, uvicorn, pymobiledevice3, mutagen" >nul 2>nul
if errorlevel 1 (
    echo iDrivePulse dependencies are not installed.
    echo Run: python -m pip install -r requirements.txt
    pause
    exit /b 1
)

start "" /min powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8765'"
python app.py

endlocal
