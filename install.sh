#!/usr/bin/env bash
# CopyAnywhere 一键部署 / 更新（在 VPS 上、项目目录里运行）
#
#   ./install.sh     构建并启动（首次会生成 .env 和随机密码）
#
# HTTPS 交给 cloudflared。.env 里填了 TUNNEL_TOKEN 时会同时启动 cloudflared 容器。
# 重复运行是安全的：已有的 .env 和数据不会被覆盖。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m注意:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

case "${1:-}" in -h|--help) sed -n '2,7p' "$0"; exit 0 ;; esac

command -v docker >/dev/null || die "未安装 Docker。安装：curl -fsSL https://get.docker.com | sh"
docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2（docker compose）"

# ---------- .env ----------
if [ ! -f .env ]; then
  pw="$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  sed "s|^PASSWORD=.*|PASSWORD=$pw|" .env.example > .env
  chmod 600 .env
  log "已生成 .env（随机服务器密码）"
fi
grep -q '^PASSWORD=change-me' .env && die ".env 里的 PASSWORD 还是示例值，请改成长随机字符串"
# v1 的配置项已改名
if grep -qE '^MAX_SPACE_MB=' .env; then
  warn ".env 是旧版本的：MAX_SPACE_MB 已不再使用，改为 MAX_TOTAL_MB（全部空间合计，默认 5120）；"
  warn "大文件现在分块上传，可以删掉 MAX_FILE_MB=90 这一行。对照 .env.example 修改。"
fi

envget() { sed -n "s/^$1=//p" .env | tail -1 | tr -d '"'"'"; }
port="$(envget HOST_PORT)"; port="${port:-8090}"
bind="$(envget BIND_HOST)"; bind="${bind:-127.0.0.1}"
check="$bind"; [ "$bind" = "0.0.0.0" ] && check=127.0.0.1
token="$(envget TUNNEL_TOKEN)"
total="$(envget MAX_TOTAL_MB)"; total="${total:-5120}"

# ---------- build & run ----------
compose=(docker compose)
[ -n "$token" ] && compose+=(--profile tunnel)
log "构建并启动容器…"
"${compose[@]}" up -d --build --remove-orphans
for _ in $(seq 1 30); do
  curl -fsS "http://$check:$port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://$check:$port/healthz" >/dev/null 2>&1 \
  || { docker compose logs --tail 30; die "服务未就绪"; }
log "服务已运行：http://$check:$port"
[ "$bind" = "0.0.0.0" ] && warn "BIND_HOST=0.0.0.0 会把未加密的 HTTP 端口暴露到公网，确认防火墙已拦截 $port"

echo
if [ -n "$token" ]; then
  log "cloudflared 容器已启动（docker compose logs -f cloudflared 查看连接状态）"
  echo "    在 Cloudflare Zero Trust → Tunnels → Public Hostname 里，"
  echo "    把你的域名的 Service 设为：http://copyanywhere:8080"
else
  echo "下一步：在 cloudflared 里加一个 Public Hostname，Service 填 http://$check:$port"
  echo "    · 已在 VPS 上运行 cloudflared：Zero Trust → Tunnels → 你的隧道 → Public Hostname"
  echo "      （本地配置文件模式则在 config.yml 的 ingress 里加：service: http://$check:$port）"
  echo "    · 还没有 cloudflared：在 Zero Trust 新建 Tunnel，把 token 填进 .env 的 TUNNEL_TOKEN，"
  echo "      再运行一次 ./install.sh，Service 填 http://copyanywhere:8080"
fi

echo
log "完成。打开 https://<你的域名> ，输入服务器密码创建空间，再用手机扫码添加设备。"
echo "    服务器密码：$(envget PASSWORD)"
echo "    存储上限：$total MB（全部空间合计，满了自动删最旧的）"
echo "    更新：git pull && ./install.sh    日志：docker compose logs -f"
