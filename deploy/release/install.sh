#!/usr/bin/env bash
#
# 血糖记录 —— 服务器侧安装脚本（在服务器上以 root 执行）
#
# 前置：本目录（含 dist/ 与 deploy/）已被上传到服务器，例如 /root/gms-release/
#   /root/gms-release/web/           前端构建产物（apps/web/dist 的内容）
#   /root/gms-release/api/server.mjs 后端单文件产物
#   /root/gms-release/api/backup.mjs 备份脚本
#   /root/gms-release/api/account.mjs 账户管理脚本（开通/重置账号）
#   /root/gms-release/Caddyfile      站点配置（服务器已有 Caddy 时使用）
#   /root/gms-release/nginx.conf     站点配置（无 Caddy 时使用）
#   /root/gms-release/gms-api.service
#
# 最省事的取件方式：仓库是公开的，直接在服务器上拉取构建产物
#   git clone --depth 1 https://github.com/Whisky53/elderly-glucose-log.git /tmp/gms-src
#   bash /tmp/gms-src/deploy/release/install.sh
# 构建产物在 macOS 上交叉生成即可，纯 JS 不含原生依赖，无需在服务器上重新构建。
#
# 幂等：可重复执行；已存在的目录/账号/服务会复用而不是报错。
#
# 用法：
#   bash install.sh              # 用默认值
#   NODE_BIN=/usr/local/bin/node bash install.sh
#
set -euo pipefail

RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/gms/api
DATA_DIR=/var/lib/gms
BACKUP_DIR=/var/lib/gms/backups
WEB_DIR=/var/www/gms
SERVICE_USER=gms
API_PORT="${GMS_API_PORT:-8100}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[失败] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root 权限执行"

# ---------- 1. Node 运行时 ----------
log "检查 Node 运行时"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ]; then
  warn "未找到 node，尝试安装 Node 22"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    PM=$(command -v dnf || command -v yum)
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    "$PM" install -y nodejs
  else
    die "无法自动安装 Node，请手动安装 Node 22 后重试（可指定 NODE_BIN=/path/to/node）"
  fi
  NODE_BIN="$(command -v node)"
fi

NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 22 ] || die "需要 Node 22 及以上（当前 $("$NODE_BIN" -v)）——node:sqlite 从 22.5 起才可用"

# 关键自检：node:sqlite 必须可用，否则同步服务起不来
"$NODE_BIN" -e 'require("node:sqlite")' >/dev/null 2>&1 \
  || die "当前 Node 的 node:sqlite 不可用，请升级到 Node 22.5+ 或 24"

log "Node 就绪：$NODE_BIN ($("$NODE_BIN" -v))"

# ---------- 2. Nginx ----------
log "检查 Nginx"
if ! command -v nginx >/dev/null 2>&1; then
  warn "未找到 nginx，尝试安装"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    PM=$(command -v dnf || command -v yum)
    "$PM" install -y nginx
  else
    die "无法自动安装 Nginx，请手动安装后重试"
  fi
fi

# ---------- 3. 用户与目录 ----------
log "创建运行账号与目录"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi

install -d -m 0755 "$APP_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$BACKUP_DIR"
install -d -m 0755 "$WEB_DIR"

# ---------- 4. 分发文件 ----------
log "分发应用文件"
[ -f "$RELEASE_DIR/api/server.mjs" ] || die "缺少 api/server.mjs，请确认上传完整"
[ -d "$RELEASE_DIR/web" ] || die "缺少 web/ 目录，请确认上传完整"

install -m 0755 -o root -g root "$RELEASE_DIR/api/server.mjs" "$APP_DIR/server.mjs"
install -m 0755 -o root -g root "$RELEASE_DIR/api/backup.mjs" "$APP_DIR/backup.mjs"

# 账户管理脚本（受控开通账号用；缺失时不阻塞部署）
if [ -f "$RELEASE_DIR/api/account.mjs" ]; then
  install -m 0755 -o root -g root "$RELEASE_DIR/api/account.mjs" "$APP_DIR/account.mjs"
fi

# 前端产物整体替换：先清空再拷贝，避免旧版本的 hashed 资源越积越多
find "$WEB_DIR" -mindepth 1 -delete
cp -r "$RELEASE_DIR/web/." "$WEB_DIR/"
chown -R root:root "$WEB_DIR"
find "$WEB_DIR" -type d -exec chmod 0755 {} +
find "$WEB_DIR" -type f -exec chmod 0644 {} +

# ---------- 5. systemd ----------
log "安装 systemd 服务"
sed -e "s#^ExecStart=.*#ExecStart=$NODE_BIN server.mjs#" \
    -e "s#^Environment=GMS_API_PORT=.*#Environment=GMS_API_PORT=$API_PORT#" \
    "$RELEASE_DIR/gms-api.service" > /etc/systemd/system/gms-api.service

# 密码文件：只在不存在时创建，避免二次执行覆盖用户已改的密码
if [ ! -f /etc/gms-api.env ]; then
  ADMIN_PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
  printf 'GMS_ADMIN_PASSWORD=%s\n' "$ADMIN_PW" > /etc/gms-api.env
  chmod 0600 /etc/gms-api.env
else
  ADMIN_PW="$(sed -n 's/^GMS_ADMIN_PASSWORD=//p' /etc/gms-api.env)"
fi

systemctl daemon-reload
systemctl enable gms-api >/dev/null
systemctl restart gms-api

log "等待服务就绪"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$API_PORT/healthz" >/dev/null 2>&1; then
    log "服务已就绪"
    break
  fi
  [ "$i" -eq 20 ] && {
    journalctl -u gms-api -n 40 --no-pager || true
    die "服务未在预期时间内就绪，请查看上面的日志"
  }
  sleep 1
done

# ---------- 6. 站点配置 ----------
log "配置站点（$WEB_SERVER）"
if [ "$WEB_SERVER" = caddy ]; then
  # 备份镜像自带的默认站点配置（只在首次执行时备份，避免覆盖掉回滚用的原版）
  if [ -f /etc/caddy/Caddyfile ] && [ ! -f /etc/caddy/Caddyfile.orig.bak ]; then
    cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig.bak
  fi
  sed -e "s#root \* .*#root * $WEB_DIR#" \
      -e "s#reverse_proxy 127.0.0.1:[0-9]*#reverse_proxy 127.0.0.1:$API_PORT#" \
      "$RELEASE_DIR/Caddyfile" > /etc/caddy/Caddyfile
  chmod 0644 /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "Caddy 配置校验失败"
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload caddy
else
  if [ -d /etc/nginx/conf.d ] && [ -f /etc/nginx/nginx.conf ] && grep -q "conf.d/\*.conf" /etc/nginx/nginx.conf; then
    install -m 0644 "$RELEASE_DIR/nginx.conf" /etc/nginx/conf.d/gms.conf
  elif [ -d /etc/nginx/sites-available ]; then
    install -m 0644 "$RELEASE_DIR/nginx.conf" /etc/nginx/sites-available/gms
    ln -sfn /etc/nginx/sites-available/gms /etc/nginx/sites-enabled/gms
    # Debian 默认站点会和我们的 server_name _ 抢 80 端口
    [ -e /etc/nginx/sites-enabled/default ] && rm -f /etc/nginx/sites-enabled/default
  else
    install -m 0644 "$RELEASE_DIR/nginx.conf" /etc/nginx/conf.d/gms.conf
  fi
  nginx -t || die "Nginx 配置校验失败"
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
fi

# ---------- 7. 备份定时任务 ----------
log "配置每日备份"
CRON_LINE="0 3 * * * $NODE_BIN $APP_DIR/backup.mjs $DATA_DIR/gms.sqlite $BACKUP_DIR 14"
if command -v crontab >/dev/null 2>&1; then
  TMP_CRON="$(mktemp)"
  crontab -l 2>/dev/null | grep -v 'gms/api/backup.mjs' > "$TMP_CRON" || true
  printf '%s\n' "$CRON_LINE" >> "$TMP_CRON"
  crontab "$TMP_CRON"
  rm -f "$TMP_CRON"
else
  warn "未找到 crontab，请手动添加：$CRON_LINE"
fi

# ---------- 8. 汇总 ----------
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"

cat <<EOF

────────────────────────────────────────────
安装完成

  访问地址      http://${PUBLIC_IP:-<服务器公网IP>}
  应用目录      $APP_DIR
  数据目录      $DATA_DIR/gms.sqlite   （备份：$BACKUP_DIR）
  服务管理      systemctl status gms-api / restart gms-api
  实时日志      journalctl -u gms-api -f

  管理员账号    admin
  管理员密码    ${ADMIN_PW:-见 journalctl -u gms-api | grep 已创建初始账户}

  开通家人账号  $NODE_BIN $APP_DIR/account.mjs create <用户名> <密码> --db $DATA_DIR/gms.sqlite
  查看账号      $NODE_BIN $APP_DIR/account.mjs list --db $DATA_DIR/gms.sqlite
  重置密码      $NODE_BIN $APP_DIR/account.mjs reset <用户名> <新密码> --db $DATA_DIR/gms.sqlite

⚠ 接下来还需处理：
  1) 在腾讯云控制台「安全组」放行 80 端口（以及后续 HTTPS 的 443）
  2) 登录后立即在设置页修改密码（当前密码写在 /etc/gms-api.env，请勿外传）
────────────────────────────────────────────
EOF
