#!/bin/bash
# 启动 hotmail_helper API 服务
# 用于接码的本地 API

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_SCRIPT="$SCRIPT_DIR/hotmail_helper(1).py"

if [ ! -f "$HELPER_SCRIPT" ]; then
    echo "错误: 找不到 hotmail_helper(1).py"
    exit 1
fi

# 检查是否已在运行
if curl -s http://127.0.0.1:17373/health > /dev/null 2>&1; then
    echo "hotmail_helper 已在运行"
    exit 0
fi

echo "启动 hotmail_helper API..."
echo "端口: 17373"
echo "地址: http://127.0.0.1:17373"
echo ""

# 启动服务
python3 "$HELPER_SCRIPT" &
HELPER_PID=$!

echo "PID: $HELPER_PID"
echo "$HELPER_PID" > /tmp/hotmail_helper.pid

# 等待服务启动
sleep 2

if curl -s http://127.0.0.1:17373/health > /dev/null 2>&1; then
    echo "✓ hotmail_helper 启动成功"
else
    echo "✗ hotmail_helper 启动失败"
fi
