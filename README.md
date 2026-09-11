# dsh-copilot-acp

Plug **GitHub Copilot** (the official Copilot CLI) into **DeepSeek Harness** as an ACP subagent:
install it, sign in once, and the agent can delegate work to Copilot — with writes confined to the
delegating session's own workspace.

[中文](README.zh.md) | English

---

## What it mounts

| Piece | Description |
|---|---|
| ACP subagent provider `acp` | Each delegation spawns a fresh official Copilot CLI process (`copilot --acp --stdio`) |
| Delegation tool `copilot` | The model-facing tool, with `description` / `prompt` / `run_in_background` |
| GitHub sign-in flow | Exposed through DSH's authorization seam; runs the CLI's own official OAuth device-code login |
| Policy middle layer `lib/shim.mjs` | An ACP intermediary between DSH and Copilot that **decides every permission request** |

## Install

```bash
# from npm (once published)
dsh plugin --profile desktop add dsh-copilot-acp

# or straight from a git repository (no publishing needed)
dsh plugin --profile desktop add "github:<owner>/dsh-copilot-acp"
```

The package declares `dsh.bundle`, so it joins that profile's plugin layer stack on install and
leaves it again on removal.

> Where it lands: pnpm puts the **installed copy** in `~/.dsh/profiles/<profile>/node_modules/` —
> that is DSH's plugin install directory. Both commands above record only a version or a repository
> name in the profile manifest, never a local path. Avoid installing from a local tarball or
> directory: the manifest would then be coupled to that path forever.

> **Windows: paths containing spaces.** `dsh plugin ... add "<local path with spaces>"` is currently
> split on the space by the DSH launcher (`spawnSync(..., { shell: true })` without quoting). Install
> from a local path by calling pnpm yourself instead:
> ```powershell
> cd $env:USERPROFILE\.dsh\profiles\desktop
> pnpm add "D:\path with spaces\dsh-copilot-acp"
> # then add "dsh-copilot-acp" to dsh.profile.bundles in package.json
> ```
> Installing by npm name is unaffected.

## Sign in

Run the **"Sign in with GitHub"** flow this plugin registers from any DSH configuration surface: it
starts `copilot login --device-code` and hands the **verification URL and code** to that page, then
records the sign-in in the DSH credential store (`copilot-acp/github`). The token itself stays in the
Copilot CLI's own credential store; this plugin never touches it.

The CLI's terminal login works too: `<copilot> login`.

## Use

Delegate in natural language:

```
Hand this diff to the copilot subagent and report only high-risk findings
Have copilot investigate that stack trace in the background while you keep writing tests
```

A child does **not** see the current conversation and returns only its final text, so write a
self-contained `prompt`.

## Permission model

For every tool call the CLI sends an ACP `session/request_permission` carrying `kind` and
`locations[].path` / `rawInput` (absolute paths). The middle layer decides, **in this order**:

1. **a path on the protected list is refused** (even inside the workspace)
2. `read` `search` `think` → per `allowRead` (default allow)
3. `fetch` → per `allowNetwork` (default allow)
4. `edit` `delete` `move` → **allowed only when every declared path resolves inside the session workspace**
5. `execute` (shell) → per `allowShell` (default deny)
6. anything else → refused (fail safe)

### Built-in protected lists (extendable, not silently removable)

**Never written** — the "something runs it later without me asking" surfaces: `.git/hooks`,
`.git/config`, `.git/config.worktree`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`,
`package.json`, `.env*`.

**Never read** — credential and key material: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`,
`*.kdbx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `.ssh`, `.gnupg`, `.netrc`, `_netrc`,
`.git-credentials`, `.aws/credentials`, `.docker/config.json`, `.kube/config`, `.config/gh/hosts.yml`.

Rule syntax: a **single-segment rule matches that segment anywhere** in the path (so `package.json`
also covers nested ones); a **multi-segment rule matches any contiguous window** (so `.git/hooks` is
caught in any repository); `*` and `?` are supported. Add your own with `extraDeniedWrites` /
`extraDeniedReads`; `builtinDenyRules: false` disables the built-ins wholesale (**not recommended**).

### Key mechanics

- **"The session workspace" needs no configuration**: the middle layer's cwd is the delegating
  session's cwd — the *same workspace as the parent agent* — resolved per delegation.
- **Paths are canonicalized by resolving the deepest existing ancestor and re-appending the missing
  tail**, so a junction/symlink inside the workspace that points outside is seen as the outside path:
  creating a file *through* one is refused (this was a gap; it is fixed and covered by a regression case).
- **Fail safe**: the official ACP backend is configured with `permission: 'reject'`, so a request the
  middle layer does not handle is refused rather than auto-approved.
- On a refusal the middle layer writes an explicit notice **with the reason** into the agent message
  stream, so the delegating agent sees why instead of an empty result.

## Enforcement strength — please read

**The boundary is a protocol-client decision (software enforcement), not an operating-system one.**
Measured on Windows 11 25H2 (build 26200.9445) with Copilot CLI v1.0.83:

**Approaches that do not work:**

| Approach | Measured result |
|---|---|
| `--excluded-tools=shell` | The CLI answers `Unknown tool name in the tool excludedlist: "shell"` — `shell(...)` is allow/deny *pattern* syntax, not a tool name |
| `--allow-tool='write(<workspace>)'` | Such rules only pre-approve; they do not restrict. Deny outranks allow, so "writable only here" is inexpressible |
| Relying on the CLI's own path permissions | No: in ACP mode a client's blanket auto-approval lets the CLI's built-in edit tool write outside the workspace (measured, file created outside) |
| Enabling the CLI's MXC sandbox (`--experimental --sandbox`, or a persisted `sandbox.enabled: true`) | **ACP sessions never enter the sandbox**: `/sandbox status` stays `disabled` inside the session, while on the same machine `-p` mode *hard-denies* the identical out-of-workspace command. The official ACP route cannot be hardened this way (v1.0.83) |

**So, when you need an OS-level boundary**, run the whole DSH session inside a container/sandbox, or
drive Copilot through the CLI's own `-p` mode (whose sandbox does apply there).

**Known gaps:** hard links, and the time-of-check/time-of-use window between this decision and the
actual write; tool shapes other than `execute` whose paths are not declared — which is exactly why
shell is denied by default.
**Reads are still not scoped to the workspace** (that is the requirement), so "read anything" plus
allowed network forms an exfiltration path: set `allowNetwork: false`, or run the whole DSH session
inside a container, when that matters.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `acp` | Provider registry name |
| `toolName` | `copilot` | Model-facing delegation tool name |
| `displayName` | `GitHub Copilot` | Label on the sign-in flow |
| `cliPath` | resolved | Override the Copilot CLI executable (or set `COPILOT_CLI_PATH`) |
| `model` | CLI default | Passed to the CLI as `--model` |
| `reasoningEffort` | CLI default | Passed as `--effort` (low/medium/high/xhigh/max) |
| `extraArgs` | `[]` | Extra CLI arguments |
| `allowRead` | `true` | Read-only tool kinds |
| `allowNetwork` | `true` | Network (`fetch`) tool kind |
| `allowShell` | `false` | Shell execution; **enabling it puts shell outside the workspace guarantee** |
| `extraWriteRoots` | `[]` | Additional writable roots (absolute paths) |
| `extraDeniedWrites` | `[]` | Extra "never written" rules (segment-glob syntax) |
| `extraDeniedReads` | `[]` | Extra "never read" rules |
| `builtinDenyRules` | `true` | Apply the built-in protected lists (turning it off drops both the auto-execution and the credential-material protection — not recommended) |

## Disable and uninstall

```yaml
# Temporarily off from the profile's own cordis.patch.yml (user layer), no uninstall:
- id: copilot-acp
  disabled: true
```

```bash
dsh plugin --profile desktop remove dsh-copilot-acp
```

## Reproducible verification

1. **Policy regression, 21/21** (`node test-shim.mjs` — a fake ACP agent feeds constructed permission
   requests; no network, no Copilot call, no harness): ordinary and nested new files inside the
   workspace allowed; absolute and `..\..\` paths outside refused; `.git/hooks`, `.git/config`,
   `package.json` (incl. nested), `.npmrc`, `.env.local` refused; ordinary reads outside allowed;
   `.ssh/id_rsa`, `.aws/credentials`, `.env` refused; shell denied by default and allowed with
   `{"shell":true}`; unknown kind refused; **a new file routed through a junction pointing OUTSIDE is
   refused** and **through a junction pointing INSIDE is allowed**; `extraWrites` honored;
   `builtinDeny:false` disables the built-ins.
2. **Device-code parsers, 8/8** (`node test-device-code.mjs`, fed the stdout and stderr variants
   captured from the real CLI).
3. **End to end** (needs an authorized Copilot): DSH (headless profile) → plugin → middle layer →
   official CLI, delegating "create a file in the workspace, and create
   `C:\Users\<user>\e2e-escape-probe.txt`". The in-workspace file was CREATED, the out-of-workspace
   file was **NOT CREATED**; the middle layer logged `ALLOW kind=edit` / `ALLOW kind=read` /
   `DENY kind=edit`.

4. **Load safety, 11/11** (`node test-load-guard.mjs`): rebuilds a profile carrying a stale
   `@deepseek-ai/dsh-credentials` (one that exports no `credentialKey`) and asserts the plugin
   **still loads**, that `apply()` **only goes inert and logs** when a backend is missing or throws
   on import, and that the happy path logs no error.

## Why it cannot take DSH down at boot

This plugin imports **nothing but Node builtins and its own files at module scope**. Every
third-party package is imported lazily inside `apply()`, and any failure leaves the plugin **inert
with a log line** while the host boots normally.

That discipline comes from a real incident: a profile's `node_modules` carried a **stale transitive
copy** of `@deepseek-ai/dsh-credentials@0.1.0-rc.8`, which shadows the installation's `0.1.2-rc.1`
under Node's nearest-`node_modules` rule. That older version does not export `credentialKey`, so a
top-level `import { credentialKey }` raised
`SyntaxError: … does not provide an export named 'credentialKey'` **while loading** — and a
load-time throw terminates the whole `dsh` process, so DSH would not start.

The fix is the discipline above: the export is no longer required (an equivalent `<scope>/<id>`
string key is used) and both backends became dynamic imports.

> For every DSH plugin author: **a stale transitive dependency in a profile shadows the
> installation's version**, which makes a top-level third-party `import` a potentially fatal pattern.

## Known limitations

- **Exact version pinning**: `@deepseek-ai/dsh-subagent-acp` and `@deepseek-ai/dsh-tool-subagent` are
  pinned exactly (npm `latest` for the former is `0.0.1-rc.1`, incompatible with this harness's
  `0.1.2-rc.1` peer ranges). Bump both when the harness moves.
- Children are **one-shot** (not continuable) and support no child LLM route selection — the ACP
  backend advertises neither capability.
- On some refusals Copilot emits no final message; the middle layer's notice mitigates this, but the
  parent may see only that notice.
- Running the middle layer **by hand** inside DSH's own tool sandbox fails with `spawn EPERM`
  (piped stdio is denied there); this does not affect normal plugin operation.

## License

Plugin code: MIT. The Copilot CLI is published by GitHub under its own license (`@github/copilot`'s LICENSE.md).
