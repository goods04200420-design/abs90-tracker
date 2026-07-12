@echo off
REM ABS90 식단&운동 트래커 로컬 서버
REM Cloudflare Tunnel(codex-mobile)의 abs.get1004.com -> localhost:8792 로 연결됨
cd /d "D:\개발\식단&운동"
echo ABS90 서버 시작: http://localhost:8792  (외부: https://abs.get1004.com)
python -m http.server 8792 --bind 127.0.0.1
