@echo off
REM ============================================================
REM ZenMux 注册机 - Windows 启动脚本
REM ============================================================

cd /d "%~dp0"

REM 检查 .env 文件
if not exist ".env" (
    echo [!] 未找到 .env 文件
    echo     请复制 .env.example 为 .env 并填写配置
    echo.
    if exist ".env.example" (
        copy .env.example .env
        echo     已自动创建 .env，请编辑后重新运行
    )
    pause
    exit /b 1
)

REM 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] 未找到 Node.js，请先安装: https://nodejs.org
    pause
    exit /b 1
)

REM 检查依赖
if not exist "node_modules" (
    echo [*] 首次运行，正在安装依赖...
    npm install
    echo.
)

REM 启动注册机，传递所有参数
node zenmux_register.mjs %*

if %errorlevel% neq 0 (
    echo.
    echo [!] 运行出错，请检查上方错误信息
    pause
)
