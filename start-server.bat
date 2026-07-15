@echo off
REM ABS90 식단&운동 트래커 로컬 서버
REM Cloudflare Workers 배포 전 로컬 개발용
cd /d "D:\개발\식단&운동"
echo ABS90 개발 서버 시작: http://localhost:8792
npm run dev
