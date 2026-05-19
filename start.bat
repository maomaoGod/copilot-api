@echo off
echo ================================================
echo Copilot API Server with Usage Viewer
echo ================================================
echo.

if not exist node_modules (
    echo Installing dependencies...
    bun install
    echo.
)

echo Starting server...
echo The usage endpoint will be available after the server starts
echo.

echo http://localhost:4141/usage
bun run --watch ./src/main.ts start

pause
