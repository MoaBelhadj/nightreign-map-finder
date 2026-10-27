@echo off
rem Serves this folder on http://localhost:8787 and opens the map finder in Edge. Close this window to stop.
cd /d "%~dp0"
where py >nul 2>nul || (echo Python is needed: install it from python.org, then run this again. & pause & exit /b 1)
start "" msedge "http://localhost:8787/nightreign-map-finder.html#live"
py serve.py 8787
