# 本地部署配置需求单

本文档面向需要本地部署 Studio Login 的客户，列出部署前需要准备的硬件、软件、网络和配置参数。部署完成后 Login 服务对外提供统一的 Studio 企业登录入口，内部依赖 Node.js 运行时和 MySQL 8 数据库，不依赖 Redis 或其他中间件。

## 一、硬件配置

| 项 | 最低 | 推荐 | 说明 |
|---|---|---|---|
| CPU | 2 核 | 4 核+ | Node.js 单进程运行，并发量高时可用 PM2 开多实例 |
| 内存 | 4 GB | 8 GB+ | Login 服务本身占 ~200 MB，MySQL 占 ~500 MB；操作系统+预留合计 |
| 磁盘 | **60 GB** SSD | 100 GB+ | 需同时装 OS、Node.js、MySQL、保存日志。MySQL 数据目录单独挂载独立磁盘更佳 |
| 网络 | 稳定内网 + 一条出网链路 | — | 需能访问 Studio 服务回调地址；生产环境建议提供公网 HTTPS 入口 |

### 磁盘容量估算（按需扩容）

| 数据 | 每月增长 | 1 年 |
|---|---|---|
| 登录会话 / 审计日志 | ~10 MB / 千用户 | ~120 MB |
| 计费周期用量（period_usage） | ~50 MB / 千 task | ~600 MB |
| 系统操作日志（journalctl） | ~100 MB | ~1.2 GB |

**最低 60 GB 磁盘足够运行 2~3 年**；如果用户规模大（>10 万账号）或希望保留 3 年以上历史数据，建议留 100 GB+。

### 数据库部署建议

MySQL 可以和 Login 服务跑在**同一台机器**（测试环境、小规模部署），也可以独立一台。

- **同机**：省机器，同 VPC/localhost 零延迟；机器规格按"推荐"档来（4C8G+100G）
- **独立 MySQL**：Login 机器可降低到 2C4G；MySQL 机器单独评估（数据量大时至少 4C8G+独立磁盘）

## 二、操作系统与软件

### 操作系统

任意 Linux 发行版，推荐：

- Alibaba Cloud Linux 3 / CentOS 7+ / RHEL 8+
- Ubuntu 20.04+ / Debian 11+

macOS / Windows 也能跑（Node.js + MySQL 都有对应版本），但生产环境建议 Linux。

### Node.js

| 项 | 要求 |
|---|---|
| 版本 | **22.x LTS**（最低 20.x，推荐 22.x） |
| 安装方式 | 二进制包 / nvm / 系统包管理器皆可 |
| 运行身份 | 建议用专用用户（如 `studio-login`），或 `root` 直接跑 systemd 也可 |

### MySQL

| 项 | 要求 |
|---|---|
| 版本 | **MySQL 8.0+**（8.0.21 以上推荐，用到 utf8mb4_0900_ai_ci 和 JSON 列） |
| 字符集 | `utf8mb4` + `utf8mb4_0900_ai_ci` collation |
| 连接 | 同机部署走 `127.0.0.1:3306`，跨机部署走内网地址 |
| 账号 | 需要一个具备 **CREATE / ALTER / INSERT / SELECT / DELETE** 权限的账号（服务启动时会自动建库建表） |
| 数据目录 | 建议独立挂载并开启自动备份（mysqldump 定时任务或 RDS 自动备份） |

### 可选：Docker

如果用 Docker 部署 MySQL（推荐测试环境），一条命令即可起好：

```bash
docker run -d --name studio-login-mysql \
  -e MYSQL_ROOT_PASSWORD=password \
  -e MYSQL_DATABASE=studio_login \
  -v $(pwd)/mysql-data:/var/lib/mysql \
  -p 3306:3306 \
  mysql:8.0 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci
```

## 三、网络与端口

### 入方向（外部访问 Login）

| 端口 | 协议 | 来源 | 说明 |
|---|---|---|---|
| 3100（可自定义） | TCP | 用户浏览器 / Studio 服务 | Login 对外 HTTP 端口；生产建议走 Nginx/Caddy 反代到 80/443 |
| 22 | TCP | 运维人员 | SSH 远程管理 |

### 出方向（Login 访问外部）

| 目标 | 说明 |
|---|---|
| Studio 服务回调地址（HTTP/HTTPS） | Login 会回调 Studio 完成注册、拉取计费目录 |
| MySQL 地址（同机则免） | Login 启动时连库跑迁移 |

### 生产 HTTPS（推荐）

如果对外提供 HTTPS，需要：

1. 一个公网域名（如 `login.yourdomain.com`）
2. 一个 HTTPS 证书（可用 certbot 免费申请，或客户提供证书文件）
3. Nginx / Caddy 反代到 Login 服务端口

### Studio 回调白名单

Login 注册 Studio 时会 POST 验证 token，如果 Studio 服务有出网白名单，需要把 Login 的公网域名加入 Studio 的**回调地址白名单**，否则 Studio 注册会失败。

## 四、部署步骤

### 1. 准备 Node.js

```bash
# 示例：用 NodeSource 安装 Node.js 22 (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 或用二进制包（通用 Linux）
curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1

node -v   # v22.x.x
npm -v    # 10.x.x
```

### 2. 准备 MySQL 8

同机部署跳过；独立 MySQL 按云厂商文档或 yum/apt 安装即可。确认 `mysql -V` 输出 8.0+。

### 3. 部署 Login 代码

```bash
# 假设代码包已解压 / git clone 到 /opt/studio-login
cd /opt/studio-login
npm ci --no-audit --no-fund
cp .env.example .env
# 编辑 .env，填入第三节的配置参数
npm run build
```

### 4. 启动服务

**开发/测试**（前台运行，方便看日志）：

```bash
npm run dev
```

**生产**（用 systemd 守护，崩溃自动重启 + 开机自启）：

```bash
# 创建 /etc/systemd/system/studio-login.service
cat > /etc/systemd/system/studio-login.service << 'EOF'
[Unit]
Description=Studio Login Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/studio-login
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now studio-login
systemctl status studio-login
journalctl -u studio-login -f   # 看实时日志
```

### 5. 验证

```bash
# 健康检查
curl http://127.0.0.1:3100/health
# => {"status":"ok"}

# 打开浏览器
# http://<服务器IP>:3100/
# 用 .env 里的 STUDIO_LOGIN_ADMIN_USERNAME / STUDIO_LOGIN_ADMIN_PASSWORD 登录
```

### 6. 配置 Studio 对接

登录管理后台后，在"Studio 服务连接"中填写 Studio 公网地址，用 `STUDIO_LOGIN_ACCOUNT_ID` 作为 appId，用 `LAS_STUDIO_INTEGRATION_TOKEN` 作为共享密钥完成注册。

## 五、配置参数

所有参数在 `.env` 文件中配置，服务启动时自动加载。以下是完整参数说明（也参考仓库根目录 `.env.example`）：

### 必填参数

| 环境变量 | 示例 | 说明                                                                                                        |
|---|---|-----------------------------------------------------------------------------------------------------------|
| `STUDIO_LOGIN_DATABASE_URL` | `mysql://root@127.0.0.1:3306/studio_login（密码单独填写）` | MySQL 连接串，URL 格式见仓库根目录 `.env.example`，示例中省略密码部分 |
| `STUDIO_LOGIN_ACCOUNT_ID` | `acme_corp` | 客户唯一标识，字母/数字/下划线。Studio 对接用这个 ID 作为 appId，**部署后不建议修改**                                                    |
| `STUDIO_LOGIN_ACCOUNT_NAME` | `Acme Corp` | 客户展示名，显示在登录页顶部                                                                                            |
| `STUDIO_LOGIN_ADMIN_USERNAME` | `admin` | 初始管理员账号                                                                                                   |
| `STUDIO_LOGIN_ADMIN_PASSWORD` | `yourStrongP@ssw0rd!2026` | 初始管理员密码，**≥ 12 位**，大小写+数字+符号                                                                              |
| `LAS_STUDIO_INTEGRATION_TOKEN` | `replace-with-at-least-32-characters-long` | Login 与 Studio 的共享密钥，**需要联系LAS测获取**。用于加密存储的 LAS/Ark API Key 和 Studio 回调鉴权，**部署后不可修改** |

### 可选参数

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址。生产用 `0.0.0.0`，仅本机访问用 `127.0.0.1` |
| `PORT` | `3100` | 监听端口 |
| `APP_ENV` | `production` | 运行模式。`local` 时允许 http 回调地址；`production` 强制 https |
| `STUDIO_LOGIN_CURRENCY` | `CNY` | 计费币种。`CNY` 或 `USD`，**确定后不建议改** |
| `TZ` | `Asia/Shanghai` | 账期与界面时区。如 `America/Los_Angeles`、`Europe/London` |

### .env 示例（国内客户 / CNY / 上海时区）

```bash
STUDIO_LOGIN_DATABASE_URL=mysql://root@127.0.0.1:3306/studio_login（密码单独填写）
STUDIO_LOGIN_ACCOUNT_ID=acme_corp
STUDIO_LOGIN_ACCOUNT_NAME=Acme Corp
STUDIO_LOGIN_ADMIN_USERNAME=admin
STUDIO_LOGIN_ADMIN_PASSWORD=Str0ngP@ssw0rd!2026
LAS_STUDIO_INTEGRATION_TOKEN=replace-with-at-least-32-characters-long

APP_ENV=production
PORT=3100
STUDIO_LOGIN_CURRENCY=CNY
TZ=Asia/Shanghai
```

### .env 示例（海外客户 / USD / 美西时区）

```bash
STUDIO_LOGIN_DATABASE_URL=mysql://root@db.internal:3306/studio_login（密码单独填写）
STUDIO_LOGIN_ACCOUNT_ID=global_corp
STUDIO_LOGIN_ACCOUNT_NAME=Global Corp
STUDIO_LOGIN_ADMIN_USERNAME=admin
STUDIO_LOGIN_ADMIN_PASSWORD=Str0ngP@ssw0rd!2026
LAS_STUDIO_INTEGRATION_TOKEN=replace-with-at-least-32-characters-long

APP_ENV=production
PORT=3100
STUDIO_LOGIN_CURRENCY=USD
TZ=America/Los_Angeles
```

## 六、日常运维

```bash
systemctl status studio-login       # 查看状态
systemctl restart studio-login      # 重启
systemctl stop studio-login         # 停止
journalctl -u studio-login -f       # 实时日志
tail -f /var/log/mysql/error.log    # MySQL 错误日志（路径按实际安装）
```

### 数据备份

MySQL 定期备份（每日凌晨 3 点）：

```bash
# crontab -e 中加一行
0 3 * * *  mysqldump -u root -p'password' --single-transaction studio_login | gzip > /var/backups/studio_login-$(date +\%Y\%m\%d).sql.gz
```

### 升级

```bash
# 拉新代码 / 替换代码包
cd /opt/studio-login
npm ci --no-audit --no-fund
npm run build
systemctl restart studio-login
# 数据库迁移由服务启动时自动执行，无需手动干预
```
