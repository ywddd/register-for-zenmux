#!/bin/bash
# ============================================================
# ZenMux 注册机 - Linux/macOS 启动脚本
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo "[!] 未找到 .env 文件"
    echo "    请复制 .env.example 为 .env 并填写配置"
    echo ""
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "    已自动创建 .env，请编辑后重新运行"
    fi
    exit 1
fi

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[!] 未找到 Node.js，请先安装: https://nodejs.org"
    exit 1
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "[*] 首次运行，正在安装依赖..."
    npm install
    echo ""
fi

# 启动注册机，传递所有参数
node zenmux_register.mjs "$@"
