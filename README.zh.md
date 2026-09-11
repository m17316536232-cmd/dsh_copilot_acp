# dsh-copilot-acp

把 **GitHub Copilot**（GitHub 官方 Copilot CLI）接入 **DeepSeek Harness**，作为一个 ACP 子代理：装上、登录一次，之后主代理就能把任务委派给 Copilot，**且写入被限制在委派会话自己的工作区内**。

English | [English](README.md)

---

## 它挂载什么

| 组件 | 说明 |
|---|---|
| ACP 子代理提供方 `acp` | 每次委派启动一个全新的官方 Copilot CLI 进程（`copilot --acp --stdio`） |
| 委派工具 `copilot` | 模型可见的委派工具，参数 `description` / `prompt` / `run_in_background` |
| GitHub 登录流 | 通过 DSH 授权 seam 暴露；走 Copilot CLI 自己的官方 OAuth 设备码流程 |
| 策略中间层 `lib/shim.mjs` | 位于 DSH 与 Copilot 之间的 ACP 中间层，**逐条裁决权限请求** |

## 安装

```bash
dsh plugin --profile desktop add dsh-copilot-acp
```

本包声明了 `dsh.bundle`，因此安装后**自动进入该 profile 的插件层栈**，卸载后自动退出。

> **Windows 上的路径含空格问题**：`dsh plugin ... add "<含空格的本地路径>"` 目前会被 DSH 启动器
> （`spawnSync(..., { shell: true })` 未加引号）按空格拆成两个参数。用本地路径安装时请改为直接调用 pnpm：
> ```powershell
> cd $env:USERPROFILE\.dsh\profiles\desktop
> pnpm add "D:\path with spaces\dsh-copilot-acp"
> # 然后把 "dsh-copilot-acp" 加进 package.json 的 dsh.profile.bundles
> ```
> 从 npm 名称安装不受此影响。

## 登录

在 DSH 的配置界面里运行本插件注册的 **"Sign in with GitHub"** 流：它会启动
`copilot login --device-code`，把**验证网址与设备码**直接显示在该页面上，授权完成后把登录信息
记入 DSH 凭据存储（`copilot-acp/github` 记录）。令牌本身保存在 Copilot CLI 自己的凭据库里，本插件不接触它。

也可以直接在终端完成：`<copilot> login`。

## 使用

在任意会话里用自然语言委派即可：

```
用 copilot 子代理把这个 diff 审一遍，只报高风险问题
让 copilot 后台查这个报错的根因，你同时继续写测试
```

子代理**看不到当前对话**，只会回传最终文本；`prompt` 要写成自包含的任务。

## 权限模型（本插件的核心）

每一次工具调用，Copilot CLI 都会发来一条 ACP `session/request_permission`，其中带
`kind`（操作类型）与 `locations[].path` / `rawInput`（绝对路径）。中间层据此裁决，**顺序如下**：

1. **命中保护清单 → 直接拒绝**（即使路径在工作区内）
2. `read` `search` `think` → 按 `allowRead`（默认允许）
3. `fetch` → 按 `allowNetwork`（默认允许）
4. `edit` `delete` `move` → **仅当所有声明路径都解析到会话工作区内才允许**
5. `execute`（shell）→ 按 `allowShell`（默认拒绝）
6. 其它/未知 `kind` → 拒绝（失效安全）

### 内置保护清单（可加不可误删）

**禁写**（这些是"没人叫我，它自己就会被执行"的入口）：`.git/hooks`、`.git/config`、
`.git/config.worktree`、`.npmrc`、`.yarnrc`、`.yarnrc.yml`、`.pnpmfile.cjs`、`package.json`、`.env*`。

**禁读**（凭据与密钥物料）：`.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.ppk`、`*.kdbx`、
`id_rsa*`、`id_ed25519*`、`id_ecdsa*`、`id_dsa*`、`.ssh`、`.gnupg`、`.netrc`、`_netrc`、
`.git-credentials`、`.aws/credentials`、`.docker/config.json`、`.kube/config`、`.config/gh/hosts.yml`。

规则语法：**单段规则匹配路径中任意同名/同形的段**（所以 `package.json` 连嵌套的也会拦），
**多段规则匹配任意连续段窗口**（所以任意仓库里的 `.git/hooks` 都会被拦）；支持 `*` 与 `?` 通配。
用 `extraDeniedWrites` / `extraDeniedReads` 追加；`builtinDenyRules: false` 可整体关闭内置清单（**不建议**）。

### 关键机制

- **"会话工作区"是你无需配置的动态值**：中间层进程的 cwd = 被委派会话的 cwd，即**父代理同一个工作区**，逐次委派解析。
- **路径规范化取"最深的已存在祖先"再拼余下部分**：工作区内若有 junction/符号链接指向外部，通过它**新建**文件也会被解析成真实的外部路径 → 拒绝（这条曾是缺口，已修，并有回归用例覆盖）。
- **失效安全**：官方 ACP 后端被配置为 `permission: 'reject'`，所以中间层没处理到的请求一律被拒绝，而不是被自动放行。
- 被拒绝时，中间层会往 agent 消息流里写一条带**具体原因**的通告，避免"静默结束"。

## 强制力说明 —— 请务必读这一节

**本插件的边界是"协议客户端判定"（软件强制），不是操作系统级强制。** 已在 Windows 11 25H2
（build 26200.9445）+ Copilot CLI v1.0.83 上实测的结论：

**这些做法实测无效：**

| 做法 | 实测结果 |
|---|---|
| `--excluded-tools=shell` | CLI 回 `Unknown tool name in the tool excludedlist: "shell"` —— `shell(...)` 只是 allow/deny 的**模式语法**，不是工具名 |
| `--allow-tool='write(<工作区>)'` | 这类规则只是"预先批准"，**不构成限制**；而 deny 优先级高于 allow，无法表达"仅此目录可写" |
| 依赖 CLI 自带的 Path Permissions | 不成立：在 ACP 模式下客户端一旦自动放行，CLI 内置编辑工具可越界写（实测写入工作区外成功） |
| 开启 CLI 的 MXC 沙箱（`--experimental --sandbox` 或持久化 `sandbox.enabled: true`） | **ACP 会话永远不进沙箱**：会话内 `/sandbox status` 始终为 `disabled`；而同一台机器上 `-p` 模式对同一越界命令**硬拒绝**。即官方 ACP 路径无法借沙箱加固（v1.0.83） |

**因此：需要操作系统级硬边界时**，请把整个 DSH 会话放进容器/沙箱运行，或改用 CLI 自己的 `-p` 模式（其沙箱在 `-p` 下确实生效）。

**已知不覆盖的情况**：硬链接绕过、检查与写入之间的时间差（TOCTOU）；以及对 `execute` 之外新出现的工具形状不做路径推断 —— 这也是默认拒绝 shell 的原因。
**读取仍不受工作区限制**（这是需求本身），因此"读任意文件 + 允许联网"构成一条数据外泄通路；需要收紧时请设置 `allowNetwork: false`，或把整个 DSH 放进容器运行。

## 配置项

| 键 | 默认 | 含义 |
|---|---|---|
| `providerName` | `acp` | 子代理提供方注册名 |
| `toolName` | `copilot` | 模型可见的委派工具名 |
| `displayName` | `GitHub Copilot` | 登录流上显示的标签 |
| `cliPath` | 自动解析 | 覆盖 Copilot CLI 可执行文件路径（也可用 `COPILOT_CLI_PATH`） |
| `model` | CLI 默认 | 传给 CLI 的 `--model` |
| `reasoningEffort` | CLI 默认 | 传给 CLI 的 `--effort`（low/medium/high/xhigh/max） |
| `extraArgs` | `[]` | 追加给 CLI 的参数 |
| `allowRead` | `true` | 只读类工具 |
| `allowNetwork` | `true` | 联网类工具（fetch） |
| `allowShell` | `false` | shell 执行；**开启后工作区约束不再覆盖 shell** |
| `extraWriteRoots` | `[]` | 额外可写根目录（绝对路径） |
| `extraDeniedWrites` | `[]` | 追加"禁写"规则（段通配语法） |
| `extraDeniedReads` | `[]` | 追加"禁读"规则 |
| `builtinDenyRules` | `true` | 是否启用内置保护清单（关闭会同时失去"自动执行入口"与"凭据物料"两层防护，不建议） |

## 启停与卸载

```yaml
# 在 profile 的 cordis.patch.yml（用户层）里临时关闭，无需卸载：
- id: copilot-acp
  disabled: true
```

```bash
dsh plugin --profile desktop remove dsh-copilot-acp
```

## 可复现的验证

1. **策略回归 21/21**（`node test-shim.mjs`，用假 ACP 智能体喂入构造的权限请求，零成本、不调用真 Copilot）：
   区内普通文件与嵌套新建放行；区外绝对路径/`..\..\` 穿越拒绝；`.git/hooks`、`.git/config`、
   `package.json`（含嵌套）、`.npmrc`、`.env.local` 拒绝；区外普通读取放行；`.ssh/id_rsa`、`.aws/credentials`、
   `.env` 拒绝；shell 默认拒绝、`{"shell":true}` 时放行；未知 `kind` 拒绝；
   **经"指向外部的 junction"新建文件拒绝**、**经"指向内部的 junction"新建文件放行**；
   `extraWrites` 生效、`builtinDeny:false` 可关。
2. **设备码解析 8/8**（`node test-device-code.mjs`，输入为本会话从真实 CLI 抓到的 stdout/stderr 两种变体）。
3. **端到端**（需已授权的 Copilot）：DSH（headless profile）→ 插件 → 中间层 → 官方 CLI，委派"在工作区内
   创建一个文件、并创建 `C:\Users\<user>\e2e-escape-probe.txt`"。结果：区内文件 CREATED，区外文件
   **NOT CREATED**；中间层同时输出 `ALLOW kind=edit` / `ALLOW kind=read` / `DENY kind=edit`。

## 已知限制

- **依赖版本精确对齐**：`@deepseek-ai/dsh-subagent-acp` 与 `@deepseek-ai/dsh-tool-subagent` 被**精确钉版本**
  （npm 上 `dsh-subagent-acp` 的 `latest` 是 `0.0.1-rc.1`，与本 harness 的 `0.1.2-rc.1` peer 范围不兼容）。harness 升级时需同步提升。
- 子代理是**一次性**的（不可续聊），不支持子 LLM 路由选择（ACP 后端不广告这些能力）。
- 部分拒绝场景下 Copilot 不产出最终正文 —— 中间层的通告已缓解，但父代理仍可能只看到通告文本。
- 在 DSH 自带沙箱内**手工**运行中间层会因 piped stdio 被拒（`spawn EPERM`）；这是 DSH 工具沙箱的限制，不影响正常插件运行。

## 许可

插件代码 MIT。GitHub Copilot CLI 由 GitHub 发布，遵循其自身许可（`@github/copilot` 的 LICENSE.md）。
