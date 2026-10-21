#!/bin/sh
# CopyAnywhere 安装 / 更新 / 卸载（不需要 Docker）
#
#   sudo sh install.sh                    安装或更新（保留配置和数据）
#   sudo sh install.sh --token <TOKEN>    同时安装 cloudflared 并接入这个 Tunnel
#   sudo sh install.sh --port 8090        指定本机端口（默认 8090）
#   sudo sh install.sh --uninstall        卸载程序（保留数据；加 --purge 连数据和配置一起删）
#
# 支持 systemd（Debian / Ubuntu / CentOS / Rocky …）和 OpenRC（Alpine），x86_64 / arm64 / armv7。
set -eu

BUILD=dev
NAME=copyanywhere
APP_DIR=/opt/copyanywhere
DATA_DIR=/var/lib/copyanywhere
CONF_DIR=/etc/copyanywhere
ENV_FILE=$CONF_DIR/env
TUNNEL_ENV=$CONF_DIR/tunnel.env
SVC_USER=copyanywhere
NODE_MAJOR=22   # downloaded when the system has no Node.js >= NODE_MIN
NODE_MIN=20

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m注意:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- arguments ----------
TOKEN=${TUNNEL_TOKEN:-}
PORT_ARG=
MODE=install
PURGE=0
while [ $# -gt 0 ]; do
  case $1 in
    --token) [ $# -ge 2 ] || die "--token 后面要跟 Tunnel token"; TOKEN=$2; shift 2 ;;
    --token=*) TOKEN=${1#*=}; shift ;;
    --port) [ $# -ge 2 ] || die "--port 后面要跟端口号"; PORT_ARG=$2; shift 2 ;;
    --port=*) PORT_ARG=${1#*=}; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done
if [ -n "$PORT_ARG" ]; then
  case $PORT_ARG in ''|*[!0-9]*) die "端口必须是数字：$PORT_ARG" ;; esac
  [ "$PORT_ARG" -ge 1 ] && [ "$PORT_ARG" -le 65535 ] || die "端口超出范围：$PORT_ARG"
fi
if [ -n "$TOKEN" ]; then
  # accept the whole "cloudflared service install eyJ…" command pasted from the dashboard
  t=$(printf '%s' "$TOKEN" | grep -o 'eyJ[A-Za-z0-9+/=_-]*' | head -n 1 || true)
  [ -n "$t" ] || die "Tunnel token 格式不对（应以 eyJ 开头，在 Zero Trust → Tunnels 里复制）"
  TOKEN=$t
fi

[ "$(uname -s)" = Linux ] || die "只支持 Linux"
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo sh $0"

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  INIT=systemd
elif command -v openrc-run >/dev/null 2>&1 || [ -x /sbin/openrc-run ]; then
  INIT=openrc
else
  die "没找到 systemd 或 OpenRC，无法注册为系统服务"
fi

svc_stop() {
  if [ $INIT = systemd ]; then systemctl stop "$1" >/dev/null 2>&1 || true
  else rc-service "$1" stop >/dev/null 2>&1 || true; fi
}
svc_start() { # enable at boot + (re)start now
  if [ $INIT = systemd ]; then
    systemctl daemon-reload
    systemctl enable "$1" >/dev/null 2>&1
    systemctl restart "$1"
  else
    rc-update add "$1" default >/dev/null 2>&1 || true
    rc-service "$1" restart >/dev/null 2>&1 || rc-service "$1" start >/dev/null
  fi
}
svc_remove() {
  svc_stop "$1"
  if [ $INIT = systemd ]; then
    systemctl disable "$1" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$1.service"
    systemctl daemon-reload
  else
    rc-update del "$1" default >/dev/null 2>&1 || true
    rm -f "/etc/init.d/$1"
  fi
}
svc_logs() {
  if [ $INIT = systemd ]; then journalctl -u "$1" -n 30 --no-pager 2>/dev/null || true
  else tail -n 30 "/var/log/$1.log" 2>/dev/null || true; fi
}

# ---------- uninstall ----------
if [ $MODE = uninstall ]; then
  svc_remove $NAME-tunnel
  svc_remove $NAME
  if [ -f $CONF_DIR/.cloudflared-installed ]; then rm -f /usr/local/bin/cloudflared; fi
  rm -rf $APP_DIR
  rm -f $TUNNEL_ENV $CONF_DIR/.cloudflared-installed /var/log/$NAME.log /var/log/$NAME-tunnel.log
  if [ $PURGE = 1 ]; then
    rm -rf $DATA_DIR $CONF_DIR
    if id $SVC_USER >/dev/null 2>&1; then
      if command -v userdel >/dev/null 2>&1; then userdel $SVC_USER 2>/dev/null || true
      else deluser $SVC_USER 2>/dev/null || true; fi
    fi
    log "已卸载，数据和配置已删除"
  else
    log "已卸载。数据保留在 $DATA_DIR，配置在 $CONF_DIR（重新安装会接着用；彻底删除：sudo sh $0 --uninstall --purge）"
  fi
  exit 0
fi

# ---------- helpers ----------
fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "需要 curl 或 wget"; fi
}
http_ok() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -o /dev/null "$1" 2>/dev/null
  else wget -q -O /dev/null "$1" 2>/dev/null; fi
}
envget() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1; }
envset() { # key value (file is root-only; values never contain '|')
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}

case $(uname -m) in
  x86_64|amd64) NODE_ARCH=x64; CF_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; CF_ARCH=arm64 ;;
  armv7l|armv7*) NODE_ARCH=armv7l; CF_ARCH=arm ;;
  *) die "不支持的 CPU 架构：$(uname -m)" ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------- program files: embedded payload, or the files next to this script ----------
if grep -q '^__PAYLOAD_BELOW__$' "$0" 2>/dev/null; then
  sed '1,/^__PAYLOAD_BELOW__$/d' "$0" | base64 -d | tar -xzf - -C "$WORK" || die "安装包已损坏，请重新上传 install.sh"
  SRC=$WORK/app
else
  SRC=$(cd "$(dirname "$0")" && pwd)
fi
[ -f "$SRC/server.js" ] && [ -d "$SRC/public" ] && [ -f "$SRC/package.json" ] \
  || die "找不到程序文件。请上传打包好的单文件 install.sh，或在项目目录里运行"
[ -f "$SRC/VERSION" ] && BUILD=$(cat "$SRC/VERSION")

# ---------- Node.js ----------
node_ok() { "$1" -e "process.exit(+process.versions.node.split('.')[0] >= $NODE_MIN ? 0 : 1)" >/dev/null 2>&1; }
OWN_NODE=$APP_DIR/node/bin/node
download_node() {
  base=https://nodejs.org/dist/latest-v$NODE_MAJOR.x
  fetch $base/SHASUMS256.txt "$WORK/SHASUMS256.txt" || die "无法访问 nodejs.org"
  file=$(grep -o "node-v[0-9.]*-linux-$NODE_ARCH\.tar\.gz" "$WORK/SHASUMS256.txt" | head -n 1)
  [ -n "$file" ] || die "nodejs.org 没有 linux-$NODE_ARCH 的 Node.js $NODE_MAJOR"
  ver=${file#node-}; ver=${ver%%-linux*}
  if [ -x "$OWN_NODE" ] && [ "$("$OWN_NODE" --version 2>/dev/null)" = "$ver" ]; then return 0; fi
  log "下载 Node.js $ver（$NODE_ARCH，约 30MB）…"
  fetch "$base/$file" "$WORK/$file"
  sum=$(grep " $file\$" "$WORK/SHASUMS256.txt" | cut -d ' ' -f 1)
  echo "$sum  $WORK/$file" | sha256sum -c - >/dev/null 2>&1 || die "Node.js 下载校验失败"
  mkdir -p "$WORK/node"
  tar -xzf "$WORK/$file" -C "$WORK/node" "${file%.tar.gz}/bin/node"   # only the binary (~100MB less than the full tarball)
  n="$WORK/node/${file%.tar.gz}/bin/node"
  "$n" --version >/dev/null 2>&1 || die "下载的 Node.js 无法在这个系统上运行（系统太旧，glibc 需要 >= 2.28）"
  mkdir -p "$APP_DIR/node/bin"
  mv -f "$n" "$OWN_NODE.new" && mv -f "$OWN_NODE.new" "$OWN_NODE"
}
if [ -x "$OWN_NODE" ]; then
  download_node                       # keep the bundled Node.js on the latest $NODE_MAJOR.x
  NODE=$OWN_NODE
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE=$(command -v node)
elif command -v apk >/dev/null 2>&1; then
  log "安装 Node.js（apk）…"
  apk add --no-cache nodejs >/dev/null || die "apk 安装 nodejs 失败"
  NODE=$(command -v node)
  node_ok "$NODE" || die "Alpine 自带的 Node.js 太旧（需要 >= $NODE_MIN），请升级到 Alpine 3.19 以上"
else
  download_node
  NODE=$OWN_NODE
fi
log "Node.js $("$NODE" --version)：$NODE"

# ---------- user, directories, config ----------
if ! id $SVC_USER >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir $DATA_DIR --no-create-home --shell "$(command -v nologin || echo /bin/false)" $SVC_USER
  else
    addgroup -S $SVC_USER 2>/dev/null || true
    adduser -S -D -H -h $DATA_DIR -s /sbin/nologin -G $SVC_USER $SVC_USER
  fi
fi
SVC_GROUP=$(id -gn $SVC_USER)
mkdir -p $DATA_DIR $CONF_DIR
chown -R "$SVC_USER:$SVC_GROUP" $DATA_DIR
chmod 700 $DATA_DIR $CONF_DIR

if [ ! -f "$ENV_FILE" ]; then
  p=${PORT_ARG:-8090}
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]$p\$"; then
    die "端口 $p 已被占用，换一个：sudo sh $0 --port 8091"
  fi
  pw=$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
  avail=$(df -Pk $DATA_DIR | awk 'NR==2 { print int($4 / 1024) }')
  total=5120
  if [ $((avail - 1024)) -lt $total ]; then total=$((avail - 1024)); fi
  [ "$total" -ge 100 ] || die "磁盘只剩 ${avail}MB，空间不够（至少需要约 1.1GB）"
  [ "$total" -lt 5120 ] && warn "磁盘只剩 ${avail}MB，存储上限设为 ${total}MB（留 1GB 给系统）"
  umask 077
  cat > "$ENV_FILE" <<EOF
# CopyAnywhere 配置。修改后重启生效：
#   systemd: systemctl restart $NAME    OpenRC: rc-service $NAME restart
# 创建空间时需要的服务器密码
PASSWORD=$pw
# 只监听本机，由 cloudflared 转发
HOST=127.0.0.1
PORT=${PORT_ARG:-8090}
DATA_DIR=$DATA_DIR
# 内容保存时长（小时）
TTL_HOURS=24
# 所有空间合计的存储上限（MB），满了自动删除最旧的内容
MAX_TOTAL_MB=$total
# 每个空间最多保留的条数
MAX_ITEMS=500
# 磁盘至少保留的空闲空间（MB）
MIN_FREE_MB=512
EOF
  umask 022
  log "已生成配置 $ENV_FILE（随机服务器密码）"
elif [ -n "$PORT_ARG" ]; then
  envset PORT "$PORT_ARG"
fi
PORT=$(envget PORT); PORT=${PORT:-8090}

# ---------- program ----------
rm -rf $APP_DIR/app.new
mkdir -p $APP_DIR/app.new
cp -R "$SRC/server.js" "$SRC/package.json" "$SRC/public" $APP_DIR/app.new/
echo "$BUILD" > $APP_DIR/app.new/VERSION
chmod -R u=rwX,go=rX $APP_DIR/app.new
rm -rf $APP_DIR/app.old
[ -d $APP_DIR/app ] && mv $APP_DIR/app $APP_DIR/app.old
mv $APP_DIR/app.new $APP_DIR/app
rm -rf $APP_DIR/app.old

# ---------- services ----------
write_systemd() { # name description exec envfile
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_GROUP
EnvironmentFile=$4
ExecStart=$3
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
EOF
}
write_openrc() { # name description command args envfile
  touch "/var/log/$1.log"
  chown "$SVC_USER:$SVC_GROUP" "/var/log/$1.log"
  cat > "/etc/init.d/$1" <<EOF
#!/sbin/openrc-run
description="$2"
supervisor=supervise-daemon
command="$3"
command_args="$4"
command_user="$SVC_USER:$SVC_GROUP"
directory="$DATA_DIR"
output_log="/var/log/$1.log"
error_log="/var/log/$1.log"
respawn_delay=3
respawn_max=0
umask=077

depend() { need net; after firewall; }
start_pre() { set -a; . "$5"; set +a; }
EOF
  chmod 755 "/etc/init.d/$1"
}

log "注册系统服务（$INIT）…"
if [ $INIT = systemd ]; then
  write_systemd $NAME "CopyAnywhere (end-to-end encrypted clipboard / file drop)" "$NODE $APP_DIR/app/server.js" "$ENV_FILE"
else
  write_openrc $NAME "CopyAnywhere" "$NODE" "$APP_DIR/app/server.js" "$ENV_FILE"
fi
svc_start $NAME

i=0
until http_ok "http://127.0.0.1:$PORT/healthz"; do
  i=$((i + 1))
  if [ $i -ge 20 ]; then svc_logs $NAME; die "服务没有正常启动（上面是日志）"; fi
  sleep 1
done
log "CopyAnywhere $BUILD 已运行：http://127.0.0.1:$PORT（仅本机可访问）"

# ---------- cloudflared (optional) ----------
if [ -n "$TOKEN" ]; then
  umask 077
  printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > "$TUNNEL_ENV"
  umask 022
fi
if [ -f "$TUNNEL_ENV" ]; then
  CF=$(command -v cloudflared || true)
  if [ -z "$CF" ]; then
    log "下载 cloudflared（$CF_ARCH）…"
    fetch "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF_ARCH" "$WORK/cloudflared" \
      || die "下载 cloudflared 失败（需要能访问 github.com）"
    chmod 755 "$WORK/cloudflared"
    "$WORK/cloudflared" --version >/dev/null 2>&1 || die "下载的 cloudflared 无法运行"
    mv -f "$WORK/cloudflared" /usr/local/bin/cloudflared
    touch $CONF_DIR/.cloudflared-installed
    CF=/usr/local/bin/cloudflared
  fi
  if [ $INIT = systemd ]; then
    write_systemd $NAME-tunnel "CopyAnywhere Cloudflare Tunnel" "$CF --no-autoupdate tunnel run" "$TUNNEL_ENV"
  else
    write_openrc $NAME-tunnel "CopyAnywhere Cloudflare Tunnel" "$CF" "--no-autoupdate tunnel run" "$TUNNEL_ENV"
  fi
  svc_start $NAME-tunnel
  log "cloudflared 已启动（$("$CF" --version 2>/dev/null | head -n 1)）"
fi

# ---------- summary ----------
if [ $INIT = systemd ]; then
  st="systemctl status $NAME"; lg="journalctl -u $NAME -f"; rs="systemctl restart $NAME"
else
  st="rc-service $NAME status"; lg="tail -f /var/log/$NAME.log"; rs="rc-service $NAME restart"
fi
echo
if [ -f "$TUNNEL_ENV" ]; then
  echo "在 Cloudflare Zero Trust → Networks → Tunnels → 你的隧道 → Public Hostname 添加域名，"
  echo "    Service 选 HTTP，URL 填：127.0.0.1:$PORT"
else
  echo "下一步：接入 cloudflared（Service 填 http://127.0.0.1:$PORT）"
  echo "    · VPS 上已有 cloudflared：在它的隧道里加一个 Public Hostname 即可"
  echo "    · 还没有：Zero Trust → Networks → Tunnels 新建隧道，复制 token，然后运行"
  echo "        sudo sh $0 --token <TOKEN>"
fi
echo
log "完成。打开 https://<你的域名> ，输入服务器密码创建空间，再用手机扫码添加设备。"
echo "    服务器密码：$(envget PASSWORD)"
echo "    存储上限：  $(envget MAX_TOTAL_MB) MB（全部空间合计，满了自动删最旧的）"
echo "    配置文件：  $ENV_FILE（改完 $rs）"
echo "    状态 / 日志：$st  /  $lg"
echo "    更新：上传新的 install.sh 后再运行一次；卸载：sudo sh $0 --uninstall"
exit 0
