#!/usr/bin/env bash
# CopyAnywhere 一键部署 / 更新（在 VPS 上、项目目录里运行）
#
#   ./install.sh                     构建并启动（首次会生成 .env 和随机密码）
#   sudo ./install.sh drop.example.com   同时为该域名写入 Caddy 反代并自动 HTTPS
#
# 重复运行是安全的：已有的 .env、数据和 Caddy 站点不会被覆盖。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m注意:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

DOMAIN="${1:-}"
case "$DOMAIN" in -h|--help) sed -n '2,7p' "$0"; exit 0 ;; esac

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
port="$(sed -n 's/^HOST_PORT=//p' .env | tail -1)"; port="${port:-8090}"

# ---------- build & run ----------
log "构建并启动容器…"
docker compose up -d --build
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 \
  || { docker compose logs --tail 30; die "服务未就绪"; }
log "服务已运行：http://127.0.0.1:$port（仅本机）"

block() {
  cat <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$port
}
EOF
}

# ---------- Caddy (optional) ----------
if [ -n "$DOMAIN" ]; then
  CADDYFILE=/etc/caddy/Caddyfile
  if command -v caddy >/dev/null && [ -f "$CADDYFILE" ]; then
    [ -w "$CADDYFILE" ] || die "没有写 $CADDYFILE 的权限，请用 sudo 运行"
    if grep -qE "^[[:space:]]*$DOMAIN[[:space:]]*\{" "$CADDYFILE"; then
      log "Caddyfile 里已有 $DOMAIN，未修改"
    else
      cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
      tmp="$(mktemp)"
      { cat "$CADDYFILE"; echo; echo "# copyanywhere"; block; } > "$tmp"
      caddy validate --adapter caddyfile --config "$tmp" >/dev/null 2>&1 \
        || { caddy validate --adapter caddyfile --config "$tmp"; rm -f "$tmp"; die "Caddy 配置校验失败，未修改"; }
      install -m 644 "$tmp" "$CADDYFILE"; rm -f "$tmp"
      systemctl reload caddy 2>/dev/null || caddy reload --config "$CADDYFILE" --adapter caddyfile
      log "已加入 Caddy 站点 $DOMAIN（证书自动申请）"
    fi
    if grep -q 'managed-by: blog/deploy.sh' "$CADDYFILE"; then
      warn "这个 Caddyfile 由博客的 deploy.sh 管理，博客重新部署（Caddy 模式）时会被覆盖；届时再运行一次本脚本即可加回。"
    fi
  else
    warn "未检测到 Caddy。请把域名反代到 http://127.0.0.1:$port ，例如 Caddy："
    echo; block; echo
    echo "cloudflared Tunnel：Public Hostname 指向 http://127.0.0.1:$port 即可。"
  fi
  url="https://$DOMAIN"
else
  url="https://<你的域名>"
  echo
  echo "下一步：把域名反代到 http://127.0.0.1:$port（必须是 HTTPS，浏览器加密和剪贴板接口都需要）。"
  echo "已装 Caddy 的话：sudo ./install.sh drop.example.com"
fi

echo
log "完成。打开 $url ，输入服务器密码创建空间，再用手机扫码添加设备。"
echo "    服务器密码：$(sed -n 's/^PASSWORD=//p' .env | tail -1)"
echo "    更新：git pull && ./install.sh    日志：docker compose logs -f"
