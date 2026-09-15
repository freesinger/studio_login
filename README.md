# studio-login

Studio 企业登录、资源配置和后付费接入服务。使用 TypeScript、Fastify 和 MySQL 8，不依赖 Redis 或 H2。

服务启动时会自动：

1. 执行未应用的 MySQL Schema。
2. 创建或校准环境变量指定的 `SYSTEM_ADMIN`。
3. 启动 HTTP 服务，不依赖尚未分配的公网地址。

Schema 使用 `sql/schema/NNN_*.sql` 增量迁移；已上线的迁移文件不再修改，结构变更必须新增下一个版本，服务启动时会按文件名顺序自动执行未应用版本。

管理员登录后，在“Studio 服务连接”中填写 Studio 和 Login 的公网地址并注册 Ticket 回调；资源配置组发布时再用该组真实 LAS API Key 注册用量回调。Integration Token、数据库密码和管理员密码仍只从服务端配置读取，不会在页面展示或提交。子账号登录成功后使用一次性 Ticket 直接进入 Studio。

资源配置组只要求 `lasApiKey`、`arkApiKey` 和 `tosBucketName`，地域由 Studio 查询返回，LAS 服务地址由 Studio 服务端配置注入。配置组保存后立即生效，内部版本仅用于审计；子账号支持修改显示名称、密码、配置组和账期限额，账单支持整体、配置组、子账号三种汇总维度。

## 快速启动

```bash
docker compose -f deploy/local/compose.yml up -d
npm install
cp .env.example .env
```

填写 `.env` 中的数据库、管理员账号和 Integration Token 等启动配置后运行：

```bash
npm run dev
```

服务启动并绑定 EIP 或域名后，管理员在页面填写一个公网接入地址；生产环境必须使用 HTTPS。该地址既是用户访问 Studio 的入口，也是 Studio 回调 Login 的入口，前端请求到达后由服务端转发到后端，用户不需要也不应该配置或暴露后端地址。所有 Studio 连接统一使用 `STUDIO_LOGIN_ACCOUNT_ID` 作为 `appId`，并使用同一个 `LAS_STUDIO_INTEGRATION_TOKEN`；接入新实例前由对应 Studio 管理员录入这组凭证。

完整设计、流程和安全约束见 [doc/studio-login-mvp-design.md](doc/studio-login-mvp-design.md)。本地双服务启动和计费验证见
[doc/studio-login-integration-test-manual.md](doc/studio-login-integration-test-manual.md)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发模式启动并自动迁移 |
| `npm run build` | 编译生产代码 |
| `npm start` | 启动编译产物并自动迁移 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run db:migrate` | 只执行 Schema 迁移 |
| `npm run db:check` | 检查数据库连接和关键表 |
| `npm run check:sensitive` | 扫描高风险敏感内容 |
| `npm test` | 运行真实 MySQL 集成测试 |

## 常见问题

## 币种与账期时区

通过 `STUDIO_LOGIN_CURRENCY=CNY|USD` 设置部署币种，通过部署环境 `TZ` 设置账期与界面时区（未配置或为空时默认 `Asia/Shanghai`，币种未配置时默认 `CNY`）。人民币和美元默认客户单价均为 1、成本单价均为 0.5，可在页面配置具体价格。配置说明和数据边界见 [部署币种与时区](doc/deployment-currency-timezone.md)。
