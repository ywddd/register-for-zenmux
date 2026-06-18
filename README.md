# ZenMux 注册管理面板

自动化 ZenMux.ai 账号注册工具，支持 Web 管理面板、批量注册、验证码自动获取、自动创建平台 API Key，并可一键导入 gpt-load。

## 功能特性

- 🚀 **自动化注册** - Playwright 驱动浏览器完成注册全流程
- 🛡️ **多类型验证码** - CapSolver 自动解决 Cloudflare Turnstile / reCAPTCHA v2 / reCAPTCHA v3 / hCaptcha，失败自动重试
- 📧 **接码服务** - 内置 hotmail_helper（随面板一键启动），Microsoft Graph 底层取码，支持收件箱 + 垃圾邮件，旧码过滤，未收到自动重发
- 🔗 **邀请码轮换** - 支持多个邀请码随机选择，注册成功后自动提取新账号邀请码加入轮换
- 🔑 **API Key 自动创建** - 注册成功后自动创建 Pay API（sk-ai-v1）和 Platform API（sk-mg-v1），带 CSRF 处理
- 🚚 **gpt-load 联动** - Pay Key 可一键/自动导入 gpt-load 指定分组
- ⚡ **并发注册** - 信号量控制并发（默认 3，上限 20），文件写入加锁防损坏；面板可实时调整
- 🌐 **动态代理** - 支持 rotating 代理（每账号独立出口 IP），降低同 IP 风控；面板填写即时保存
- 🌐 **Web 管理面板** - 零依赖原生 HTTP，深色主题全功能 UI
- 📦 **批量操作** - 批量导入账号（支持 `----` 分隔文本 / JSON / 文件上传）、批量注册、账号可移出/恢复待注册
- 🖥️ **跨平台** - 支持 Windows / Linux / macOS

## 环境要求

- **Node.js** >= 18.0.0（推荐 v20+）
- **Python 3**（hotmail_helper 接码服务，需 `flask`、`requests`）
- **Playwright Chromium** 浏览器
- **Microsoft OAuth 账号**（email / client_id / refresh_token）
- **CapSolver API Key**（自动过验证码）

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/bouderer/register-for-zenmux.git
cd register-for-zenmux
```

### 2. 安装依赖

```bash
# Node 依赖
npm install

# Playwright 浏览器（Linux 需额外装系统依赖）
npx playwright install chromium
npx playwright install-deps chromium   # 仅 Linux

# Python 依赖（接码服务）
pip install flask requests
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
# CapSolver API Key（必须，用于自动过验证码）
CAPSOLVER_API_KEY=你的key

# ZenMux 邀请码（多个用逗号分隔）
ZENMUX_INVITE_CODE=CODE1,CODE2

# 面板监听（0.0.0.0 = 对外可访问）
WEB_HOST=0.0.0.0
WEB_PORT=17380
```

### 4. 准备账号文件

创建 `zenmux_accounts.json`：

```json
[
  {
    "email": "user1@hotmail.com",
    "client_id": "你的_microsoft_oauth_client_id",
    "refresh_token": "你的_refresh_token",
    "password": ""
  }
]
```

> 也可启动面板后在「账号」标签页用「上传 txt/json 文件」批量导入，每行一个账号：
> `邮箱----密码----client_id----refresh_token`（密码可留空）

### 5. 启动

```bash
node web_panel.mjs
```

面板会**自动拉起 hotmail_helper 接码子进程**，无需单独启动。访问 `http://你的IP:17380`。

## 注册流程

每个账号全自动：

```
1. 已注册（有 session）直接跳过，不重复打码
2. 随机选邀请码，打开 https://zenmux.ai/invite/{code}
3. 填邮箱
4. 探测 Turnstile（确认需要才打码，省钱；失败自动重试 3 次）
5. 点 Send 发送验证码
6. hotmail_helper 取验证码（仅认本次发送后的新邮件，旧码过滤）
7. 输入验证码（OTP 多框 / 单框 / 普通框自适应）
8. 探测二次验证（Turnstile / reCAPTCHA / hCaptcha），需要则打码
9. 登录成功判定（URL 跳转 + referral/info 二次确认，避免误判）
10. 保存 session
11. 自动提取该账号邀请码（加入轮换池）
12. 自动创建 Pay API key（sk-ai-v1）+ Platform API key（sk-mg-v1）
13. Pay key 自动导入 gpt-load（若配置 GPTLOAD_PAY_GROUP_ID）
```

**验证码收不到时**：第 1 轮等 65 秒，未收到重发；第 2 轮等 15 秒，仍未收到则跳过该账号。

## 并发注册

批量注册时支持并发，多个账号同时进行（等邮件的空闲时间被利用）：

- `CONCURRENCY=3`（默认，上限 20），每个账号开一个独立浏览器
- 文件写入（账号/邀请码/key）加互斥锁，防并发损坏 JSON
- 面板「触发注册」可实时调整并发数（注册中不可改）
- 注意内存：2 核 4G 机器建议 2–3，资源充足可调高

## 动态代理

支持 rotating 代理，每个浏览器走独立出口 IP，降低同 IP 多账号风控：

```env
PROXY_URL=http://user:pass@host:port
```

- 格式 `http://user:pass@host:port` 或 `http://host:port`（IP 白名单方式）
- rotating 代理每次连接换 IP，并发账号自动分配不同 IP
- 代理连不上自动跳过该账号
- 面板「触发注册」可填写即时保存（写入 `.env` 即时生效）
- CapSolver 打码走服务端，不受代理影响

## Web 管理面板

| 模块 | 功能 |
|------|------|
| 📋 账号管理 | 查看/添加/删除账号，批量导入（文本+文件），移出/恢复待注册，实时状态（未注册/注册中/已注册/已跳过） |
| 🚀 注册 | 单个/批量注册，并发数控制，动态代理配置，实时日志，停止任务 |
| 🔑 API Keys | 查看/创建 Pay·Platform key，导出 txt，一键导入 gpt-load |
| 📜 日志 | 系统运行日志 |
| ⚙️ 设置 | 邀请码配置（手动+自动提取），服务状态，CapSolver 余额 |

### 主要 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/accounts` | 账号列表（含状态） |
| POST | `/api/accounts` | 添加账号 |
| PATCH | `/api/accounts/:email` | 切换 skip（移出/恢复待注册） |
| DELETE | `/api/accounts/:email` | 删除账号 |
| POST | `/api/accounts/import` | 批量导入 |
| POST | `/api/register` | 触发注册（支持并发） |
| GET | `/api/register/status` | 注册状态 + 日志 |
| POST | `/api/register/stop` | 停止注册 |
| POST | `/api/config` | 更新配置（邀请码/并发数/代理URL，写回 .env） |
| GET | `/api/invite-codes` | 邀请码列表 |
| POST | `/api/invite-codes/extract` | 手动提取邀请码 |
| GET | `/api/api-keys` | 已保存的 API Key |
| POST | `/api/api-keys/ensure` | 创建/检查 API Key（死 session 自动重登） |
| GET | `/api/api-keys/export?type=pay\|platform\|all` | 导出 key 为 txt |
| GET | `/api/gptload/groups` | gpt-load 分组列表 |
| POST | `/api/gptload/import` | 导入 key 到 gpt-load |

## API Key 说明

ZenMux 平台两类 API Key（均自动创建，无需订阅）：

- **Pay API**（按量付费，`sk-ai-v1-`）：`POST /api/api_key/create`，body `{"name":"xxx","tags":[]}`
- **Platform API**（平台管理，`sk-mg-v1-`）：`POST /api/management_key/create`，body `{"name":"xxx"}`

> 两类 create 接口均需 `X-CSRF-Token` 头（取自 `ctoken` cookie）。注册成功后自动创建，保存在 `zenmux_api_keys.json`，也可在面板手动创建/检查。

## gpt-load 联动

在 `.env` 配置后，注册成功产生的 Pay Key 会自动导入 gpt-load 指定分组：

```env
GPTLOAD_BASE=http://127.0.0.1:3001
GPTLOAD_AUTH_KEY=你的gpt-load管理key
GPTLOAD_PAY_GROUP_ID=1
```

也可在「🔑 API Keys」标签页选分组，手动一键导入。

## 配置说明

### CapSolver（必须）

注册 [CapSolver](https://dashboard.capsolver.com) 获取 API Key，设到 `.env` 的 `CAPSOLVER_API_KEY`。用于自动过 Turnstile / reCAPTCHA。

### 邀请码

```env
ZENMUX_INVITE_CODE=CODE1,CODE2,CODE3
```

注册时随机选一个，注册成功后自动提取新账号邀请码加入轮换池。

### hotmail_helper（接码服务）

Python 实现，随 `web_panel.mjs` 自动启动，默认 `http://127.0.0.1:17373`。也可单独运行：

```bash
python3 "hotmail_helper(1).py"
# 或
bash start_hotmail_helper.sh
```

取码策略：直接走 hotmail_helper（Graph 底层），仅认本次发送后的新邮件（旧码时间过滤）。第 1 轮等 65s，未收到重发；第 2 轮等 15s，仍未收到则跳过该账号。

### 并发与代理（可选）

```env
# 并发数（默认 3，上限 20）
CONCURRENCY=3

# 动态代理（rotating，每账号独立出口 IP）
PROXY_URL=http://user:pass@host:port
```

两者都可在面板「触发注册」实时调整并写回 `.env`。详见上方「并发注册」「动态代理」章节。

### Microsoft OAuth

需 Azure AD 注册应用获取 `client_id`，并授权邮箱读取权限（Mail.ReadWrite）。

## 部署到 Linux 服务器

```bash
# Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 依赖
npm install
npx playwright install chromium
npx playwright install-deps chromium
pip install flask requests

# PM2 守护
npm install -g pm2
pm2 start web_panel.mjs --name zenmux-panel
pm2 save && pm2 startup
```

Nginx 反代（可选）：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:17380;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 常见问题

**Q: Turnstile 打码失败？**
确认 `CAPSOLVER_API_KEY` 正确、余额充足。代码会自动重试 3 次。

**Q: 获取验证码超时？**
检查 `refresh_token` 是否有效、hotmail_helper 是否运行（面板会自动起）、垃圾邮件文件夹。第 1 轮等 65s、第 2 轮等 15s，仍未收到则跳过该账号。

**Q: 创建 API Key 报 401？**
该账号 session 失效。代码会自动删除死 session 并重新登录后再建 key。

**Q: 已注册账号重复打码？**
不会。有 session 的账号自动跳过。

**Q: 并发注册会损坏数据吗？**
不会。账号/邀请码/API Key 的文件写入都有互斥锁，并发安全。

**Q: 代理连不上怎么办？**
代理连接失败会自动跳过该账号，不影响其它账号注册。检查 `PROXY_URL` 格式与代理可用性。

**Q: Linux 无头模式报错？**
`npx playwright install-deps chromium`

## 项目结构

```
register-for-zenmux/
├── web_panel.mjs              # Web 管理面板 + 注册核心（零依赖 HTTP）
├── zenmux_register.mjs        # 命令行注册工具
├── capsolver_helper.mjs       # CapSolver API 封装（Turnstile/reCAPTCHA/hCaptcha）
├── capture_apis.mjs           # API 抓包工具（带自动打码）
├── hotmail_helper(1).py       # 邮箱接码服务（Graph 底层）
├── public/
│   └── index.html             # 管理面板 UI
├── register.sh / .bat         # 命令行启动脚本
├── start_hotmail_helper.sh    # 单独启动接码服务
├── .env.example               # 配置模板
├── package.json
└── README.md
```

> `zenmux_accounts.json` / `zenmux_api_keys.json` / `zenmux_sessions/` / `zenmux_results/` 等含敏感数据的文件已被 `.gitignore` 忽略，不会提交。

## 许可证

MIT License
