# TODO · magpie-dumate 本地维护支线

基线：上游 `R227BOUT/magpie-dumate` v0.3.0（commit `1d950b3`，2026-11-13 push）。
本地位置：本仓库根目录（路径刻意不入库——脱敏闸门会拦绝对路径）。本文件只记「卡在谁手里」，
每条带可执行的判据；不带判据的条目不进本文件。

---

## 1. 代码层 ✅（本地已完成）

| 项 | 状态 | 判据 |
|---|---|---|
| 行尾固定 LF（新增 `.gitattributes`） | ✅ | CRLF 检出下 `node run-tests.mjs --quick` 全过（实测 124 pass / 0 fail） |
| `test-delivery-review` 读源码前归一 CRLF | ✅ | 同上；单独跑 `node test-delivery-review.mjs` 5 条全过 |
| 多账号 seat key 派生（issue #3） | ✅ | `node test-desktop-paths.mjs` P8/P9 通过 |
| 模型 API id 去重（issue #6） | ✅ | `node test-model-catalog.mjs` C13 通过 |
| Cookie 头控制字符/非法名过滤 | ✅ | `node test-unit.mjs` U9 通过 |
| token 缓存上限 16 条 | ✅ | `grep -n "TOKEN_CACHE_MAX" index.mjs` 有定义且 `rememberToken` 是唯一写入点 |
| README 变更记录 0.3.1 段 | ✅ | `node test-release-ready.mjs` R1 版本一致 |
| 请求节奏：console 接口最小间隔 800ms + 35% 抖动 | ✅ | `node test-unit.mjs` U11（注入时钟，不睡真实时间） |
| 熔断：连续 3 次软失败停手 15 分钟，聊天入口快速 429 | ✅ | `node test-unit.mjs` U12 |
| 响应分类：只对 429/403/5xx 退避，401/3xx 不动 | ✅ | `node test-unit.mjs` U13 |
| `Retry-After` 遵守且有 1 小时封顶 | ✅ | U13 的 `retryAfterHeader: "999999"` 用例 |
| `guard.mjs` 进 `package.json` 的 `files` | ✅ | `node -e "console.log(require('./package.json').files)"` 含 guard.mjs |
| 节流开关 `DUMATE_MIN_INTERVAL_MS`（离线套件设 0，线上保留） | ✅ | `node run-tests.mjs --quick` 总耗时回落到 ~10s，且 `test-determinism` ≤2s |
| 换号闸门：refresh 不跨账号复用 seat | ✅ | `node test-bug-regression.mjs` G11 |
| 签到信息 10 分钟缓存（余额不缓存） | ✅ | `node test-bug-regression.mjs` G10；`test-checkin-branches` 7 条全过 |

## 1.5 真实运行观测（2026-11-15 20:40–23:45，约 3 小时）

| 观测 | 值 | 来源 |
|---|---|---|
| usage 轮询采样数 | 23 | `~/.config/magpie/quota-history.json` |
| 轮询间隔 中位 / 最小 / 最大 | 260s / 63s / 4818s | 同上 |
| 期间积分消耗 | 30500 → 28398（2102） | `quotas.json` + quota-history |
| 401 / 429 / 5xx 痕迹 | 无 | 无错误落盘、`logins.json` 无失效重登记录 |
| 熔断触发次数 | 0 | 无 `riskGuard` 报错出现 |

结论：这一段节奏与凭据链是稳的，所以本轮只做「降请求数」与「堵换号」，不动节流参数。

## 2. 部署 / 同源化

| 项 | 状态 | 判据 |
|---|---|---|
| 仓库是唯一事实来源 | ✅ | 部署目录就是本仓库（本地 spec 原地加载），没有第二份拷贝 |
| 在 magpie 里登记 spec | ✅ | `magpie plugin list` 出现 `dumate (百度搭子 DuMate, 22 models)`；`plugin-providers.json` 里 `id=dumate` 的 `spec` = 本仓库路径 |
| 桌面登录态接上 | ✅ | `plugin login dumate` 选方式 1 返回 `signed in`；`plugin-auth.json` 里 `source=desktop`、`cookies` 56 条 |
| 积分链路真实可用 | ✅ | `hooks.auth.usage()` 返回 `30499.79 / 30500.00 积分`，到期 `2026-11-22`，`signIn: kept`（只调 /points 接口，不耗积分） |
| 真实模型清单导入 | ✅ | 本机 `opencode.json` 导入 22 个入口、22 个唯一 API id、0 重复；快照落在 `~/.config/magpie/magpie-dumate/models.snapshot.json` |
| 插件侧签到单独跑一次 | ⏳ 待做 | 客户端今天已自行签到（usage 显示「已签到 1 天」），插件 `checkin` hook 尚未单独验证：等 magpie 下一次调度，看是否返回 `done`（不是 `claimed`） |
| 真实聊天一次 | ⏳ 待做 | 需要用户点头：会消耗积分（实测每轮约 0.08 积分） |

## 3. ⛔ 阻塞（只有用户能做）

- **必须在百度搭子客户端里保持登录**。插件只读复用 `auth.json` + `.cookie-key`，
  客户端登出 / 换号后必须重新 `magpie plugin login dumate`。这一步没有自动化空间。
- ~~是否要把本地支线推回 GitHub~~ → **已定**（2026-11-15）：推到 fork
  `cixia6944-cloud/magpie-dumate`，`main` 跟踪 `origin/main`，上游留作 `upstream`。
  不给上游开 PR，理由见 `DECISIONS.md` D9。**仍需用户决定**：要不要把三处代码修复
  拆成独立 PR 提给上游（那需要按上游风格只带 `index.mjs` / `models.mjs` / 两个测试，
  不带 `docs/` 整包）。

## 4. 🔄 下一步（我能做，等指令）

- 用真实账号跑一次 `node run-tests.mjs`（12 个联网套件，**会消耗积分**），
  核对 SSE / 工具调用 / 长会话在上游网关上的真实行为。
  ⚠️ 注意：`test-heartbeat` 会跑满 20 分钟、`test-long-session` 会连发 6 次真实请求，
  两者**不在 runner 名单里**，只能手动跑，别误触。
- 上游 issue #5「模型选择打不开」：需要界面层复现，先拿 magpie 版本号与复现步骤再动。
- 上游 PR #2 / #4 都在做「读网关实时 `/models` 清单」。若上游合并，本地这套
  `opencode.json` 快照逻辑要整体让位——**翻案条件见 DECISIONS D6**。

## 5. 💤 故意不做（每条都写了什么时候翻案）

- **不给聊天请求加整体超时**。
  理由：流式响应本来就可能持续几分钟，一个总时长上限会在长回答中途掐断连接，
  而连接层的 connect timeout 在 Node 原生 fetch（undici）里没有独立开关。
  翻案条件：出现「网关挂住不返回、agent 无限等待」的真实案例，且日志里能区分
  「等首字节」和「流到一半」。届时用 abort + 可配置的 TTFB 超时，而不是总时长。
- **不删那 6 个不在 runner 里的测试文件**。
  理由：它们不是死代码——`test-heartbeat`（20 分钟心跳）、`test-long-session`（3 分钟
  长会话）、`test-points-audit`（真实积分对账）之类是**手动 soak 工具**，跑起来会真花积分
  或跑很久，放进 `--quick` 会把「秒级反馈」毁掉。
  翻案条件：把 runner 改成分级（offline / online / soak），并给 soak 加显式
  `--soak` 开关且默认拒绝执行时，再把它们挂进去。
- **不改 magpie 的凭据存储格式**（Cookie 仍是明文存 `plugin-auth.json`）。
  理由：那是宿主（magpie）的契约，插件单方面加密会让 `getAuth()` 读不回来。
  翻案条件：magpie 自己在 plugin-auth 层提供加密或 keyring 挂载。
- **不引入数据库 / 不改快照格式**。
  理由：一个 `models.snapshot.json` 够用，schema 1 已带版本号。
  翻案条件：需要跨进程并发写或按账号分库存清单。
- **不追上游 star / 不写自我推广**。

## 6. 风险登记

| 风险 | 触发条件 | 影响 | 当前处置 |
|---|---|---|---|
| 账号级凭据外泄 | `plugin-auth.json` 被读走 | BDUSS/STOKEN 等于百度账号完整登录态，不只是模型额度 | 只说「用小号」不够，见 docs/DECISIONS.md D5；本机文件权限由 magpie 管 |
| 客户端更新改密文格式 | 百度改 `auth.json` 布局 | 桌面登录读取直接返回 null（不会崩） | 已容错降级；翻案条件：真出现时按 `iv(12)+tag(16)+ct` 实测顺序更新注释 |
| 上游改网关地址/模型 id | 百度调整 `dumate-svc` 或清单 | 400 / 模型 404 | `loader` 校验目标必须是官方 chat 端点，异常会以 400 明确报错 |
| 服务端封禁这类复用登录态的用法 | 风控升级 | 账号被限制 | 属于用法本身的风险，插件层无法规避；已在 README 安全说明中写明 |
| 上游合并 PR #4（实时 /models） | 上游发新版 | 本地快照逻辑变成冗余分支 | 见 D6 翻案条件 |

## 7. 变更纪律（本次踩过的坑）

1. **判定点不能和动作写在一条命令里**。测「CRLF 会不会让套件挂」时，
   先把副本转 CRLF 再跑，和直接改工作区再跑，是两件事——本次全程用副本
   （`/tmp/crlf-probe*`），没有污染仓库。
2. **跑不熟悉的测试文件前先读头注释**。`test-heartbeat` 一跑就起 20 分钟心跳并发了
   真实请求（余额 30500.00 → 30499.92 积分），是本轮唯一的意外消耗。
   以后手动跑任何 `test-*.mjs` 前先 `grep -n "setInterval\|process.argv"`。
3. **行尾类问题不要在 Windows 上靠肉眼判断**。`file index.mjs` 说 CRLF，
   `git ls-files --eol` 才说清「仓库里存的是 LF、工作区被转成了 CRLF」，两者不矛盾。
4. **改 `accountId` 之前先问一句「已有 seat 会不会失联」**。结论是不能改真实
   `bceAccountId`，只能在它缺失时才派生——这条写进了 P9 断言。
