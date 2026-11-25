# AeCpt 学生客户端接口与二次开发手册

本文档面向希望基于 `dsh-aecpt` 进行界面客制化、新增 Agent 工具或构建自定义客户端的学生开发者，涵盖 **AeCpt 服务端学生可用 HTTP API** 与 **DSH Host 本地代理 (`/aecpt-api/*`)** 两层契约。

---

## 1. 安全与信任边界

- **服务端为唯一可信边界**：所有身份鉴权、对象可见性、字数/条数配额、并发版本锁（`revision`）与限流均由服务端强制执行；客户端校验仅用于提升交互体验。
- **认证仅走 OAuth 2.0 PKCE**：服务端不提供密码直登 API，请勿引导用户在插件或大模型对话中输入密码。
- **令牌隔离**：Bearer 令牌（`aec_...`）仅保存在 DSH Host 凭据库，前端面板通过同源 `/aecpt-api/*` 代理访问，不得把令牌暴露给网页脚本或工具输出。
- **隐藏对象返回 404**：无权访问或不存在的资源统一返回 `404`，不泄露对象是否存在。

---

## 2. 服务端学生可用 HTTP API（`/api/v1/`）

以下路由均要求请求头携带 `Authorization: Bearer <ApiToken>`（标注「公开」的除外）。

### 2.1 服务发现与认证

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/health/` | （公开）健康检查，返回 `{"status": "ok"}` |
| `GET /api/v1/meta/` | （公开）发现服务端 API 版本、`server_instance`、OAuth 路径及全部字段/体积/配额上限（客制化请优先读取此接口，避免硬编码上限） |
| `GET /oauth/authorize/` | 浏览器 OAuth 2.0 PKCE（`S256`）登录与授权页（`client_id=aecpt-dsh-plugin`，`scope=api`，`redirect_uri=<origin>/oauth/plugin-done/`） |
| `POST /oauth/token/` | 使用一次性授权码 + `code_verifier` 换取 5 分钟短效 OAuth Access Token |
| `POST /api/v1/auth/tokens/exchange/` | 用上述 OAuth Access Token 一次性换取长期 `ApiToken`（90 天滑动续期，单人最多 10 个活跃令牌；换票后原 OAuth Token 立即销毁） |
| `POST /api/v1/auth/tokens/current/revoke/` | 吊销当前正在使用的 `ApiToken`（断开连接时调用） |
| `GET /api/v1/me/` | 返回当前账号：`id`、`username`、`full_name`、`gender`、`student_number`、`is_student`、`is_supervisor`、`is_superuser`、`server_instance` |

### 2.2 教学周与项目

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/academic-periods/` | 返回当前教学周 `current` 与学期周列表 `weeks`（编码如 `26FA13W`） |
| `GET /api/v1/projects/` | 返回当前学生参与的可见项目列表（含 `id`、`name`、`kind`、`status`、`members` 等） |

### 2.3 科研进展 / 周报（含过程碎片 `summary_records`）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/reports/` | 列出本人进展（可选 `?project=<id>&limit=&offset=`，响应头带 `X-Total-Count`）；每条包含轻量字段 `summary_count` |
| `POST /api/v1/reports/` | 新建某教学周草稿：`{ period, project?, content?, summary_records? }`；同教学周已存在时返回 `409 period_exists` 并附 `snapshot` |
| `GET /api/v1/reports/{pk}/` | 获取进展详情（含完整 `content`、`revision`、`summary_records`、`feedback`） |
| `PATCH /api/v1/reports/{pk}/` | 更新草稿（**必须**携带整数 `revision`，否则 `400 revision_required`；版本落后返回 `409 revision_conflict` 与最新 `snapshot`）；支持更新 `content` 与可选 `summary_records` |
| `POST /api/v1/reports/{pk}/submit/` | 提交并锁定周报（幂等；可选传 `revision` 与 `summary_records`，省略 `summary_records` 时自动保留草稿阶段已同步的碎片） |
| `POST /api/v1/reports/sync/` | 离线清单差量同步（传入本地已知 `{ id, revision }` 清单，返回变更项） |

**`summary_records` 条目结构**（每条上限由 `/api/v1/meta/` 的 `summary_records_max` 声明，默认最多 100 条）：
```json
{
  "id": "uuid-string",
  "session_id": "dsh-session-id-or-manual",
  "from_seq": 0,
  "to_seq": 12,
  "created_at": "2026-11-25T10:00:00Z",
  "provider": "deepseek",
  "model": "deepseek-chat",
  "summary": "### 一句话具体主题\n- 关键进展要点"
}
```

### 2.4 个人计划与选择性分享

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/plan-items/` | 列出本人全部个人计划（支持 `?limit=&offset=`） |
| `POST /api/v1/plan-items/` | 新建计划：`{ title, notes?, due_date? ("YYYY-MM-DD"|null), done?, project? (int|null) }` |
| `PATCH /api/v1/plan-items/{pk}/` | 局部更新个人计划（任意子集字段） |
| `GET /api/v1/plan-sharing/supervisors/` | 列出当前可分享的在职导师列表 |
| `GET /api/v1/plan-items/{pk}/shares/` | 查看某条计划已发布的导师分享快照 |
| `POST /api/v1/plan-items/{pk}/shares/` | 向指定导师发布快照：`{ supervisor_id, snapshot: { title, notes, due_date, done } }`（`snapshot` 须与服务端当前值完全一致，防止误分享陈旧内容） |
| `DELETE /api/v1/plan-items/{pk}/shares/{share_id}/` | 撤回已发布的计划分享 |

### 2.5 课题组公用论文库

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/library/papers/` | 检索全组已入库论文（可选 `?q=空格分词&tag=精确标签&limit=&offset=`） |
| `POST /api/v1/library/papers/` | `multipart/form-data` 提交新论文：`metadata`（JSON 字符串：`title`, `authors`, `year`, `venue`, `doi`, `arxiv_id`, `url`, `abstract`, `tags`, `note`）+ `pdf`（≤50 MB）；学生投稿进入 `pending` 待导师审核，重复返回 `409 paper_duplicate` 并附 `existing` |
| `GET /api/v1/library/papers/{pk}/` | 获取单篇论文详情 |
| `PATCH /api/v1/library/papers/{pk}/` | 修改本人待审核投稿的元数据（`doi`/`arxiv_id` 不可改） |
| `DELETE /api/v1/library/papers/{pk}/` | 撤回本人待审核或未通过的投稿 |
| `GET /api/v1/library/papers/{pk}/pdf/` | 流式下载 PDF 二进制内容 |
| `GET /api/v1/library/submissions/` | 查看本人全部投稿及审核意见 |
| `GET /api/v1/library/export/` | 导出已入库论文 BibTeX（`?ids=1,2` 或 `?q=&tag=`，最多 500 篇） |

### 2.6 统一错误信封与限流

所有 API 错误均返回统一结构，响应头带 `X-Correlation-ID`：
```json
{
  "error": {
    "code": "revision_conflict",
    "detail": "修订号不一致，请基于最新快照重试",
    "correlation_id": "..."
  }
}
```
常见错误码：`authentication_failed`（令牌失效/被撤销，需重新授权）、`revision_required` / `revision_conflict`（周报版本冲突）、`period_exists`（教学周草稿已存在）、`paper_duplicate`（论文重复）、HTTP `429`（触发限流，应退避重试）。

---

## 3. DSH Host 本地代理路由（`/aecpt-api/*`）

前端面板（`client.js` 及各 `*-panel.js`）通过同源 `/aecpt-api/*` 与 Host 通信，携带请求头 `X-AeCpt-Client: 1` 及（已连接时的）`X-AeCpt-Binding: <bindingId>`：

- **连接与授权**：`GET /status`、`GET /connection/`、`POST /authorize/start`、`POST /authorize/complete`、`POST /authorize/confirm`、`POST /disconnect`
- **AI 总结与周报提炼**：`GET /summary-models`、`POST /summary-model`、`GET /summarize/context?sessionId=...`、`POST /summarize`、`POST /reports/summaries/`、`DELETE /reports/:id/summaries/:recordId/`、`POST /reports/:id/compile/`、`POST /reports/:id/undo-compile/`
- **离线优先周报**：`GET/POST /reports/`、`GET/PATCH /reports/:id/`、`POST /reports/:id/submit/`、`POST /reports/:id/resolve/`、`POST /reports/sync/`、`GET /export?id=...`
- **本机文献订阅**：`GET /feeds/`、`POST /feeds/sources/`、`DELETE /feeds/sources/:id/`、`POST /feeds/refresh`、`POST /feeds/read`
- **公用论文库（Host 侧解析/组装）**：`POST /library/resolve`、`POST /library/papers/`、`GET /library/papers/:id/pdf/`
- **服务端直通白名单**：`GET /me/`、`GET /meta/`、`GET /academic-periods/`、`GET /projects/`、`/plan-items/*`、`/plan-sharing/supervisors/`、`/library/papers/`、`/library/submissions/`、`/library/export/`、`/library/papers/:id/`

---

## 4. 本机存储目录约定

- `~/.aecpt/dsh/reports-<accountKey>.json`：离线周报草稿、同步队列与会话进度点（`0600`）
- `~/.aecpt/dsh/feeds-<accountKey>.json`：本机文献订阅源与已读状态（`0600`）
- `~/.aecpt/dsh/prompts.json`：可选自定义 AI 提示词覆写文件
- `~/.aecpt/library/<accountKey>/`：通过 `aecpt_library` 工具下载的本地 PDF
- 凭据令牌本身不写入 `~/.aecpt/`，统一托管于 DSH 凭据库（键名 `dsh-aecpt/default`）。
