#!/bin/bash
# ogdeveloper Web 服务启动脚本
# 用法: ./start-web.sh [端口] [密码]
PORT="${1:-4224}"
PASSWORD="${2:-ogdev123}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DBX_STATIC_DIR="$DIR/dist"
export DBX_PORT="$PORT"
export DBX_PASSWORD="$PASSWORD"
# 本地 JDBC 插件包（离线安装用，避免从网络下载）
export DBX_JDBC_PLUGIN_ZIP="$DIR/target/release/jdbc-plugin.zip"
# DBX_DISABLE_PASSWORD=1 可关闭登录密码（仅限可信内网）

echo "ogdeveloper web → http://0.0.0.0:$PORT"
exec "$DIR/target/release/dbx-web"
