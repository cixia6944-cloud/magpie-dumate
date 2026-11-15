# 决策记录 · magpie-dumate 本地维护支线

格式：**日期 · 决定 · 理由（带实测数据）· 复核判据**。
复核判据必须是一条能跑的命令，不是「定期检查」。

---

## D1 · 2026-11-15 · 以「本地 fork 叠提交」维护，不复制粘贴改部署目录

**决定**：插件就是本仓库（这个 git 工作区）本身，
magpie 通过本地 spec 原地加载；不再存在「仓库一份 + 部署目录一份」。

**理由**：上一类事故的成因就是同一份代码存在两个位置且不知道哪个是最新。
magpie 的本地 spec 是原地加载（官方原文 "a folder is loaded where it is;
nothing is installed"），所以根本不需要复制。

**复核判据**：
```bash
grep -o '"spec": "[^"]*dumate[^"]*"' ~/.config/magpie/plugin-providers.json
# 输出应指向本仓库根目录，且用户目录下没有第二份 index.mjs：
find "$USERPROFILE" -name "index.mjs" -path "*dumate*" 2>/dev/null   # 只应有一条
```

---

## D2 · 2026-11-15 · 行尾以仓库为准（`.gitattributes` + 断言归一，两层都做）

**决定**：新增 `.gitattributes` 强制 LF；同时把 `test-delivery-review.mjs` 里读源码的
地方改成读入即归一。**只做其中一层是不够的**。

**理由**：实测数据——
- LF 检出：`node run-tests.mjs --quick` → 120 pass / 0 fail
- CRLF 检出（同一份代码转换后）：119 pass / **1 fail**，挂在
  `test-delivery-review` 的 `/instructions:[\s\S]*?,\n\s*method/`，报「只找到 0 组 instructions」

只加 `.gitattributes` 依赖别人配好 `core.autocrlf`；只改断言则下次读到 CRLF 的
`README.md` 还会踩别的正则。两层都做之后，CRLF 副本实测 124 pass / 0 fail。

**复核判据**：
```bash
mkdir -p /tmp/p && cp -r . /tmp/p/ && cd /tmp/p && rm -rf .git
python -c "import glob;[open(f,'wb').write(open(f,'rb').read().replace(b'\n',b'\r\n')) for f in glob.glob('*.mjs')]"
node run-tests.mjs --quick | tail -3      # 必须 0 fail
```

---

## D3 · 2026-11-15 · 多账号用「派生 seat key」，但真实 `bceAccountId` 一个字都不改

**决定**：`seatIdentity()` 在 `bceAccountId` 缺失时，优先用 app 的 `profileId`，
否则用 cookie 集的 sha256 前 12 位派生出 `dumate-<hash>`；`bceAccountId` 存在时原样使用。

**理由**：上游 issue #3 的根因是三条登录路径都退回常量 `PROVIDER_NAME`
（浏览器/手动路径是 `String(info?.bceAccountId ?? PROVIDER_NAME)`，桌面路径是
`d.accountId || PROVIDER_NAME`），magpie 以 accountId 为 seat key，第二个账号直接覆盖第一个。

为什么不给**所有**账号统一加前缀：那会让每一个已有 seat 的 key 都变，等于逼所有人重登。
派生只发生在「本来就会互相顶掉」的情形，收益明确、代价为零。

**复核判据**：
```bash
node test-desktop-paths.mjs | grep -E "P8|P9"
# P8: 两账号两个 key；P9: bce-account-0001 透传不变
```

---

## D4 · 2026-11-15 · 模型清单按 API id 去重，规范键优先

**决定**：`importModels()` 在原有「别名指向存在的键」规则之后，再按声明的 `id` 收敛，
同一个 API id 只保留一个入口；`key === id` 的规范键优先，被合并的进 `excluded`。

**理由**：上游 issue #6。原规则是
`if (key !== id && Object.hasOwn(source, id)) continue` ——只有当目标键**也在源里**时才生效。
真机上的形态恰恰不是这样：两个显示别名都声明 `id: "model-text"`，而源里根本没有
`model-text` 这个键，于是两条都进列表，切换模型发出去的是同一个上游，表现为「切了没用」。

**复核判据**：
```bash
node test-model-catalog.mjs | grep C13      # 重复 id 收敛为 1，规范键优先
node -e "import('./models.mjs').then(m=>{const c=m.importModels({provider:{QianfanPersonalQuota:{models:JSON.parse(require('fs').readFileSync('models.default.json','utf8')).models}}});console.log(Object.keys(c.models).length, c.excluded)})"
# 参考清单应仍是 22 个入口、0 排除（说明去重没误伤正常清单）
```

---

## D5 · 2026-11-15 · 凭据明文存 `plugin-auth.json`：不改，但写进风险登记

**决定**：不尝试在插件层加密 Cookie。README 的安全说明里明确写「BDUSS/STOKEN 等同意志级凭据」。

**理由**：凭据的持久化格式是 magpie 宿主的契约，`getAuth()` 按那个格式读回；
插件单方面塞密文会直接让 seat 失效。真正的翻案点是宿主提供 keyring 或加密存储。

**复核判据**：
```bash
grep -n "意志级凭据\|plugin-auth.json" README.md     # 安全说明存在
node tools/check-secrets.mjs                        # 仓库内无凭据特征串
```

---

## D6 · 2026-11-15 · 保留 `opencode.json` 快照逻辑，不跟上游 PR #4 的路线

**决定**：暂时不改成「读网关实时 `/models`」。

**理由**：PR #2 / #4 都还没合（2026-11-15 实测：两个都 open）。实时清单更准，但会引入
一次新的网络依赖，且与本地的「卸载客户端后清单不丢」目标冲突。
先保住现状，等上游真合了再整体让位。

**翻案条件（一条命令能判）**：
```bash
curl -s https://api.github.com/repos/R227BOUT/magpie-dumate/pulls?state=closed \
  | python -c "import json,sys;print([p['number'] for p in json.load(sys.stdin) if p.get('merged_at')])"
# 输出里出现 2 或 4 → 说明上游已合并实时清单方案，本地 models.mjs 该让位
```

---

## D7 · 2026-11-15 · 6 个不在 runner 的测试文件保留，但登记为 soak 工具

**决定**：不删除，也不塞进 `--quick`。

**理由**：实测跑了它们，行为是：`test-heartbeat` 起 20 分钟心跳并发真实请求
（余额 30500.00 → 30499.92 积分），`test-long-session` 3 分钟连发 6 次真实请求，
`test-magpie-upgrade` / `test-ai-sdk-e2e` 在缺沙箱/依赖时 `SKIP` 并 exit 0。
它们是有意的手动工具，不是「忘了接线的死文件」——但**上一版文档没写这件事**，
导致看代码的人（包括我）会把它们当成 cruft。所以记录在案 + 见 TODO 第 5 节翻案条件。

**复核判据**：
```bash
node test-magpie-upgrade.mjs; echo "exit=$?"     # SKIP 且 exit=0
grep -c "test-heartbeat" run-tests.mjs           # 应为 0（确实不在 runner 里）
```

---

## D8 · 2026-11-15 · 用 `plugin add <本地路径>` + CLI 登录方式 1 部署，不复制文件

**决定**：`magpie plugin add .` 登记本地 spec；登录用 `magpie plugin login dumate` 后
从三个方式里选 1（桌面登录态复用），CLI 需要交互，用 `printf '1\n' |` 喂选择。

**理由**：本地 spec 是原地加载，「仓库 = 部署目录」才成立；复制到 `.config/magpie` 会出现
第二份代码。实测 CLI 启动的 host 自带代理环境变量（`HTTPS_PROXY=127.0.0.1:10808`），
而网关是境内域名，直连与代理都通——记录在此，避免以后把网络问题归因错。

**实测证据**：`plugin list` → `dumate (百度搭子 DuMate, 22 models) signed in`；
`Usage` hook 返回真实余额；magpie 自己的 seat 显示 id（32 位十六进制）与
`plugin-auth.json` 里的 `accountId`（真实 `bceAccountId`）不是同一个值——那是宿主的内部哈希，
**不要拿 `plugin list` 的显示值判断 accountId 是否被改写**。

**复核判据**：
```bash
magpie plugin list | grep -A1 magpie-dumate
node -e "const j=require(require('os').homedir()+'/.config/magpie/plugin-auth.json').dumate;console.log(j.source,j.accountId.length,j.cookies.length)"
# 期望 desktop 32 56
```
