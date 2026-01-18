#!/bin/bash

# Claude-Call Authorization Server 启动/重启脚本

cd "$(dirname "$0")"

# 检查并停止已运行的服务
PID=$(pgrep -f "bun run server/index.ts")
if [ -n "$PID" ]; then
    echo "停止现有服务 (PID: $PID)..."
    kill "$PID" 2>/dev/null
    sleep 1
fi

# 启动服务并后台运行
nohup bun run server/index.ts > server.log 2>&1 &

echo "服务已启动，PID: $!"
echo "日志文件: server.log"
echo "查看日志: tail -f server.log"
