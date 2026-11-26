# dsh-aecpt — AeCpt 学生科研工作台（DSH 插件）

> Student research workbench plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai), connecting students to a self-hosted **AeCpt** (Aesthetic Computing) research group server. Licensed under **MIT**.

`dsh-aecpt` 为课题组学生提供运行在 DSH 桌面端内的完整科研协作工作台，同时将所有学生可用能力暴露为本地代理与 Agent 工具，欢迎学生在本仓库基础上按个人研究习惯进行界面美化、提示词定制与工作流扩展。

---

## 核心功能

- **概览（Overview）**：一屏掌握当前教学周进展、最近导师反馈、本周 7 天计划日历条与未读文献订阅。
- **教学周科研进展（两层结构 + 离线优先）**：
  - **碎片收集**：在任意 DSH 对话右上角点击「**进展总结**」，可勾选当前会话前序或工作区过往片段作为承接脉络，一键提取进展片段归入当前教学周的「本周汇总」池；支持手动补记与删除回滚。
  - **一键提炼周报**：在工作台「科研进展」中一键将本周所有碎片提炼为结构化完整周报（已有正文时自动进入**增量融合**模式，尊重你手工修改与删减，不复原旧试错），支持一键撤销、Markdown + KaTeX 公式编辑、离线草稿三路合并（diff3）同步与导出。
  - **提交与反馈**：提交后锁定周报并查看导师反馈。
- **个人计划与选择性共享**：支持「清单」与「月历」双视图，可关联科研/毕设项目；默认完全私密，仅在你预览确认后向指定导师分享当前快照，后续编辑仍保持私密，可随时撤回共享。
- **本机文献订阅**：支持期刊 RSS/Atom、arXiv 分类预设/自定义检索与研究博客；数据保存在本机 `~/.aecpt/dsh/`，不上传服务器。
- **课题组公用论文库**：支持 DOI / arXiv 自动解析元数据、arXiv 自动下载或本地上传 PDF（≤50 MB）、投稿经导师审核后全组共享、全文关键词/标签检索、PDF 下载与多选导出 BibTeX。
- **内置 Agent 工具（8 个）**：在 DSH 对话中可直接通过自然语言或自定义 Skill 调用工作台全部学生能力（见下方工具列表）。

---

## 快速安装与使用

### 环境要求

- DeepSeek Harness（DSH）`^0.2.3-alpha.2`
- Node.js `>= 20`（用于构建客户端与运行本地测试）

### 1. 安装插件

**方式 A（从 npm 安装，推荐普通学生）**：
在 DSH「**插件** → **添加插件**」中直接输入包名 **`dsh-aecpt`** 安装即可（无需克隆代码或安装 Node.js）。

**方式 B（从源码构建，适合二开与客制化）**：

```bash
git clone https://github.com/yhong91/dsh-aecpt.git
cd dsh-aecpt
npm ci
npm run build
```

然后在 DSH「**插件** → **添加插件**」中选择本仓库的绝对路径（例如 `/path/to/dsh-aecpt`）。

### 2. 通过导师邀请链接自动连接并授权

本插件**不硬编码任何服务器地址**，直接通过导师发来的邀请链接一跳串联注册、入组与免复制自动授权：

1. 打开 DSH 左侧栏「**AeCpt 科研工作台**」，点击「**连接工作台**」；
2. 粘贴导师发给你的**邀请链接**（如 `https://your-server/invitations/...`），插件会自动提取服务器地址；
3. 点击「**前往浏览器注册 / 授权**」：
   - 首次使用的同学在浏览器用学号注册并点「确认接受邀请并继续授权」后会自动进入授权页；
   - 点击「允许授权」后，DSH 会**自动完成连接**（无需手动复制粘贴代码；密码不经过 DSH 或大模型，长期令牌与服务器地址保存在 DSH 凭据库中，下次重连无需再贴地址）。

> 亦保留折叠式「手动粘贴一次性代码」兜底；也支持在 DSH 对话中将邀请链接交给 `aecpt_authorize` 工具或在插件配置中预设 `serverUrl`。

---

## 免改源码自定义 AI 提示词

如果想调整「对话进展提取」或「每周完整周报提炼」的写作风格（例如适配不同学科、增加实验指标模板或改用英文输出），无需修改插件源码，只需在本机创建文件 `~/.aecpt/dsh/prompts.json`：

```json
{
  "fragment_system": "你是科研过程记录助手……（留空或省略该字段则沿用内置提示词）",
  "compile_system": "你是高校科研周报撰写助手……（留空或省略该字段则沿用内置提示词）"
}
```

保存后**立即生效**（每次总结/提炼时动态读取，单条上限 16,000 字；若文件不存在或 JSON 格式有误会自动安全回退到内置提示词）。内置完整提示词见 [prompts.js](./prompts.js)。

---

## 内置 Agent 工具一览

学生可在 DSH 对话或自定义 Skill 中组合调用以下 8 个工具：

| 工具名 | 作用 | 主要 actions / 说明 |
| --- | --- | --- |
| `aecpt_me` | 查询当前身份与上下文 | 返回 `id`、`username`、`full_name`、`student_number`、`is_student`、`current_period`（当前教学周）与可见 `projects` 列表 |
| `aecpt_authorize` / `aecpt_authorize_complete` | 发起/完成 OAuth PKCE 浏览器授权 | 仅走浏览器授权码，不接触密码 |
| `aecpt_logout` | 断开当前绑定 | 先尽力吊销服务端令牌，再清除本机凭据 |
| `aecpt_report` | 科研进展与教学周碎片 | `list` / `detail` / `create` / `edit`（需传整数 `revision`） / `submit` / `summaries`（查看本周碎片） / `add_summary`（追加手动碎片） / `periods`（查询教学周） |
| `aecpt_plan` | 个人计划与项目列表 | `list`（支持 `open`/`done`/`all`） / `create` / `update` / `projects`（可见项目）；分享给导师保留在 UI 人工确认 |
| `aecpt_library` | 课题组公用论文库 | `search` / `get` / `mine` / `resolve`（DOI/arXiv 解析） / `submit` / `download`（PDF 落盘 `~/.aecpt/library/` 供 Agent 阅读） / `export`（BibTeX） |
| `aecpt_feeds` | 本机文献订阅 | `list` / `sources` / `add` / `remove` / `refresh` / `read` |

---

## 二次开发与客制化指南

服务端将客户端视为**非受信任开源客户端**——所有权限边界、字段上限、乐观锁（`revision`）、配额与限流均在服务端强制执行，因此你可以放心地自由改造 UI、提示词、本地工具与交互流程。完整服务端接口契约见 [docs/SERVER_API.md](./docs/SERVER_API.md)。

### 目录结构地图

```text
dsh-aecpt/
├── index.js               # DSH Host 入口：/aecpt-api 代理、LLM 总结/提炼编排、8 个 Agent 工具
├── prompts.js             # AI 系统提示词与构建器（支持 ~/.aecpt/dsh/prompts.json 覆写）
├── binding.js             # OAuth 2.0 PKCE 授权、令牌换取与 DSH 凭据库读写
├── store.js               # 本机离线草稿库、summary_records 同步队列与缓存隔离（~/.aecpt/dsh/）
├── diff3.js               # 离线草稿冲突三路合并算法
├── feeds.js               # 零依赖 RSS/Atom/arXiv 抓取与 SSRF 公网主机校验
├── library.js             # DOI/arXiv 元数据解析、multipart PDF 上传与流式下载
├── client.js              # 前端主入口：工作台壳、科研进展主从视图、弹窗与侧栏/顶栏图标
├── session-popover.js     # 对话右上角「进展总结」浮层（前序片段勾选 + 立即提取）
├── overview-panel.js      # 「概览」首页卡片与 7 天计划日历条
├── report-fragments.js    # 「本周汇总」碎片列表、手动补记与一键提炼控件
├── report-markdown.js     # 安全 Markdown + KaTeX 渲染器（配 report-math.js）
├── plan-panel.js          # 「计划」清单 / 月历视图与导师分享抽屉
├── feeds-panel.js         # 「文献订阅」界面
├── library-panel.js       # 「论文库」公用库 / 我的投稿 / 提交论文三视图
├── workbench.css          # 工作台主样式（全量使用 DSH 主题 CSS 变量，零硬编码色值）
├── build-client.js        # esbuild 浏览器端打包脚本（产物输出至 dist/client.js）
├── tests/                 # Node 原生单元测试（npm test）
└── docs/
    ├── DETAIL.md          # DSH 插件详情页说明
    └── SERVER_API.md      # 学生可用服务端 API 与 Host 代理接口手册
```

### 本地开发与验证流程

```bash
# 修改前端文件后重新打包 dist/client.js
npm run build

# 运行全量单元测试（无须连接线上服务器，内置 mock 上游）
npm test

# 检查打包产物文件清单
npm pack --dry-run
```

### 客制化约定建议

1. **样式跟随 DSH 明暗主题**：所有 CSS 颜色请使用 DSH 主题变量（如 `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-module-platform`、`--dsw-alias-border-l2`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-link`），不要写死 `#hex` 或 `rgb()`，避免浅色/深色主题切换时对比度失效。
2. **令牌永不进入浏览器端**：所有带 `Bearer` 令牌的上游请求都应留在 Host（`index.js`）代理，前端通过同源 `/aecpt-api/*` 访问。
3. **本机数据位置**：缓存与配置保存在 `~/.aecpt/dsh/`（按 `server_instance + userId` 隔离），Agent 下载的论文 PDF 保存在 `~/.aecpt/library/`，目录权限为当前用户私有（`0700` / `0600`）。

---

## 发布新版本到 npm（维护者）

仓库内置了两套 GitHub Actions 工作流：
- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)：每次推送或 PR 到 `main` 自动执行语法检查、`npm run build`、`npm test` 与打包检查；
- [`.github/workflows/publish-npm.yml`](./.github/workflows/publish-npm.yml)：推送 `vX.Y.Z` 标签时自动校验标签与 `package.json` 版本一致、补齐 `repository` 元数据（用于公开仓库 `--provenance` 溯源签名）、构建测试、发布至 npm（预发布版本如 `v0.2.0-beta.1` 自动归入 `next` dist-tag）并创建 GitHub Release（也支持在 Actions 页面手动 `workflow_dispatch` 开启 `dry_run` 预演）。

### 首次配置（二选一）

- **方式 A（推荐，无长期密钥）：npm Trusted Publishing (OIDC)**
  1. 首次发版（`0.1.0`）先用本机 `npm login && npm publish` 或下述 `NPM_TOKEN` 创建 npm 包页面（npmjs.org 需先存在包页才能配置 Trusted Publisher）；
  2. 打开 `https://www.npmjs.com/package/dsh-aecpt/access`（或包页面 **Settings** 标签）→ **Trusted Publishers** → 添加 GitHub Actions（Owner 填 `yhong91`、Repository 填 `dsh-aecpt`、Workflow Filename 填 `publish-npm.yml`）；
  3. 之后删除 `NPM_TOKEN` Secret 即可实现零长期密钥自动发布。
- **方式 B（首次发版立即可用）：配置 `NPM_TOKEN` Secret**
  1. 在 npmjs.org 创建一个具有 `dsh-aecpt` 发布权限的 Granular Access Token（勾选 Bypass 2FA）；
  2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 新增 Secret `NPM_TOKEN`。

> 建议在创建 GitHub 仓库后，将 `"repository"` 字段写入 `package.json`；即使暂未填写，`publish-npm.yml` 也会在发布时自动按 `GITHUB_REPOSITORY` 补齐，以免公开仓库的 `--provenance` 校验失败。

### 日常发版命令

```bash
# 首次发布当前 0.1.0：
git tag v0.1.0
git push origin main --follow-tags

# 后续迭代发布（自动改 package.json 并打 vX.Y.Z 标签）：
npm version patch   # 或 minor / major
git push origin main --follow-tags
```

---

## 开源许可

本项目采用 [MIT License](./LICENSE) 开源；打包进 `dist/client.js` 的第三方依赖许可声明见构建时生成的 `dist/THIRD-PARTY-NOTICES.txt` 与 [licenses/](./licenses)。
