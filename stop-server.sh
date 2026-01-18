#!/bin/bash

# Claude-Call Authorization Server 停止脚本

PID=$(pgrep -f "bun run server/index.ts")
if [ -n "$PID" ]; then
    echo "停止服务 (PID: $PID)..."
    kill "$PID" 2>/dev/null
    echo "服务已停止"
else
    echo "服务未运行"
fi
