/**
 * dsh-copilot-acp — GitHub Copilot as an ACP subagent for DeepSeek Harness.
 *
 * One plugin instance mounts three things:
 *   1. the official GitHub Copilot CLI as an ACP child, driven through this
 *      package's policy middle layer (`shim.mjs`) rather than directly, so the
 *      client side of the protocol enforces which paths Copilot may write;
 *   2. the model-facing delegation tool that hands a task to that child;
 *   3. a GitHub sign-in flow, surfaced by whatever configuration UI is mounted,
 *      that runs the CLI's own official device-code login.
 *
 * The CLI binary is resolved from this package's own dependency tree (the
 * `@github/copilot-<platform>-<arch>` package the official npm loader uses), so
 * a user installs the plugin and signs in — no manual CLI install and no
 * hard-coded user path.
 *
 * ## Load discipline (learned the hard way)
 *
 * This module imports **nothing but Node builtins and its own files at module
 * scope**. Every third-party package is imported lazily inside `apply()`, and
 * every failure path logs and leaves this plugin inert.
 *
 * That is not caution for its own sake: a plugin that throws while being
 * *loaded* takes the whole `dsh` process down before any recovery can run.
 * Measured in the field — a profile carried a stale transitive copy of
 * `@deepseek-ai/dsh-credentials` (0.1.0-rc.8) that shadows the installation's
 * copy (0.1.2-rc.1) under Node's nearest-`node_modules` rule, and that older
 * version does not export `credentialKey`, so a top-level
 * `import { credentialKey }` raised
 * `SyntaxError: The requested module ... does not provide an export named ...`
 * at load time and DSH failed to boot. `test-load-guard.mjs` is the regression
 * test for that whole class of failure.
 *
 * @module dsh-copilot-acp
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDeviceCode, parseSignedInLogin } from './device-code.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIM = join(HERE, 'shim.mjs')

/** The credential record the sign-in flow writes: `<scope>/<id>`. */
const CREDENTIAL_SCOPE = 'copilot-acp'
const CREDENTIAL_ID = 'github'

/** The vendor backend's own defaults, restated because this plugin calls its `apply` directly. */
const DISPOSE_EOF_GRACE_MS = 6000
const DISPOSE_GRACE_MS = 3000

export const name = 'copilot-acp'

/** The services the reused backend plugins need, so this plugin mounts only when they exist. */
export const inject = ['subagents', 'subprocess', 'tools', 'systemPrompt', 'sessionProjections']

/** Every option with its default, resolved in code because this plugin ships no schema. */
const DEFAULTS = {
  providerName: 'acp',
  toolName: 'copilot',
  displayName: 'GitHub Copilot',
  extraArgs: [],
  allowRead: true,
  allowNetwork: true,
  allowShell: false,
  extraWriteRoots: [],
  extraDeniedWrites: [],
  extraDeniedReads: [],
  builtinDenyRules: true,
}

const asStrings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [])
const asString = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
const asOptionalString = (value) => (typeof value === 'string' && value !== '' ? value : undefined)
const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/**
 * Resolve the user's configuration over the defaults, ignoring unknown keys.
 * @param raw - the entry's `config`, as the profile patch supplied it.
 * @returns the effective options.
 */
function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    providerName: asString(config.providerName, DEFAULTS.providerName),
    toolName: asString(config.toolName, DEFAULTS.toolName),
    displayName: asString(config.displayName, DEFAULTS.displayName),
    cliPath: asOptionalString(config.cliPath),
    model: asOptionalString(config.model),
    reasoningEffort: asOptionalString(config.reasoningEffort),
    extraArgs: asStrings(config.extraArgs),
    allowRead: asBoolean(config.allowRead, DEFAULTS.allowRead),
    allowNetwork: asBoolean(config.allowNetwork, DEFAULTS.allowNetwork),
    allowShell: asBoolean(config.allowShell, DEFAULTS.allowShell),
    extraWriteRoots: asStrings(config.extraWriteRoots),
    extraDeniedWrites: asStrings(config.extraDeniedWrites),
    extraDeniedReads: asStrings(config.extraDeniedReads),
    builtinDenyRules: asBoolean(config.builtinDenyRules, DEFAULTS.builtinDenyRules),
  }
}

/**
 * The Copilot CLI executable.
 *
 * Precedence: explicit config, then `COPILOT_CLI_PATH`, then the platform
 * package published next to the `@github/copilot` umbrella this package
 * depends on — the same resolution the official npm loader performs.
 * @param config - the effective options.
 * @returns an absolute executable path, or undefined when nothing resolves.
 */
function resolveCliPath(config) {
  const explicit = config.cliPath ?? process.env.COPILOT_CLI_PATH
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const platforms = process.platform === 'linux' ? ['linuxmusl', 'linux'] : [process.platform]
  for (const platform of platforms) {
    try {
      return fileURLToPath(import.meta.resolve(`@github/copilot-${platform}-${process.arch}`))
    } catch {
      /* try the next platform spelling */
    }
  }
  return undefined
}

/**
 * The credential key for the sign-in record.
 *
 * Prefers the harness helper when the mounted credential package exports it and
 * otherwise uses the plain `<scope>/<id>` string, which is exactly what that
 * helper returns (`brandString(`${scope}/${id}`)`; the brand is type-level
 * only). Nothing here may throw — a stale or partial peer copy is precisely the
 * situation this guard exists for.
 * @returns the credential key.
 */
async function credentialKeyFor() {
  try {
    const credentials = await import('@deepseek-ai/dsh-credentials')
    if (typeof credentials.credentialKey === 'function') {
      return credentials.credentialKey(CREDENTIAL_SCOPE, CREDENTIAL_ID)
    }
  } catch {
    /* the mounted copy is absent or older than the helper; the plain string is equivalent */
  }
  return `${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`
}

/**
 * Mount the policy-scoped ACP provider, the delegation tool, and the sign-in flow.
 *
 * Async on purpose: the vendor backends are imported here rather than at module
 * scope, so a resolution or version problem becomes a logged failure with an
 * inert plugin instead of a load-time crash that takes the harness with it.
 * @param ctx - the plugin context.
 * @param raw - the entry's `config`, as the profile patch supplied it.
 */
export async function apply(ctx, raw) {
  const config = resolveConfig(raw)

  const cli = resolveCliPath(config)
  if (cli === undefined) {
    ctx.logger.error(
      'copilot-acp: cannot locate the GitHub Copilot CLI — install this plugin with its @github/copilot dependency, or set `cliPath` (or COPILOT_CLI_PATH). Staying inert.',
    )
    return
  }

  let applyAcpProvider
  let applySubagentTool
  try {
    ;({ apply: applyAcpProvider } = await import('@deepseek-ai/dsh-subagent-acp'))
    ;({ apply: applySubagentTool } = await import('@deepseek-ai/dsh-tool-subagent'))
  } catch (error) {
    ctx.logger.error(
      "copilot-acp: its ACP backend packages did not load (%s). Staying inert; check this profile's @deepseek-ai/dsh-subagent-acp and dsh-tool-subagent installs.",
      String(error),
    )
    return
  }
  if (typeof applyAcpProvider !== 'function' || typeof applySubagentTool !== 'function') {
    ctx.logger.error('copilot-acp: the ACP backend packages loaded without the expected `apply` export. Staying inert.')
    return
  }

  const args = [SHIM, cli, '--acp', '--stdio']
  if (config.model !== undefined) args.push('--model', config.model)
  if (config.reasoningEffort !== undefined) args.push('--effort', config.reasoningEffort)
  args.push(...config.extraArgs)

  const policy = {
    read: config.allowRead,
    network: config.allowNetwork,
    shell: config.allowShell,
    extents: config.extraWriteRoots,
    extraWrites: config.extraDeniedWrites,
    extraReads: config.extraDeniedReads,
    builtinDeny: config.builtinDenyRules,
  }

  try {
    applyAcpProvider(ctx, {
      providerName: config.providerName,
      command: process.execPath,
      args,
      // The shim answers every permission request itself; anything it does not
      // answer is refused rather than auto-approved — a blanket `allow` would
      // silently widen Copilot's file access.
      permission: 'reject',
      env: { COPILOT_SHIM_POLICY: JSON.stringify(policy) },
      disposeEofGraceMs: DISPOSE_EOF_GRACE_MS,
      disposeGraceMs: DISPOSE_GRACE_MS,
    })

    applySubagentTool(ctx, {
      provider: config.providerName,
      toolName: config.toolName,
      // The ACP backend advertises no depthLimit capability, so a numeric cap would refuse to mount.
      maxDepth: 'provider-managed',
    })
  } catch (error) {
    ctx.logger.error('copilot-acp: the ACP backend refused this configuration (%s). Staying inert.', String(error))
    return
  }

  // Optional surface: a composition without the authorization seam still gets
  // the delegation tool, and a failure here never affects what was mounted.
  const key = await credentialKeyFor()
  try {
    ctx.inject(['authorization', 'credentials'], (authCtx) => {
      try {
        registerSignInFlow(authCtx, config, cli, key)
      } catch (error) {
        authCtx.logger.warn('copilot-acp: the GitHub sign-in flow was not registered (%s)', String(error))
      }
    })
  } catch (error) {
    ctx.logger.warn('copilot-acp: no GitHub sign-in flow was registered (%s)', String(error))
  }

  ctx.logger.info(
    'copilot-acp: Copilot CLI at %s; writes scoped to the delegating session workspace (shell %s, network %s)',
    cli,
    config.allowShell ? 'allowed' : 'denied',
    config.allowNetwork ? 'allowed' : 'denied',
  )
}

/**
 * Register the GitHub sign-in flow: the CLI's own device-code login, with the
 * verification URL and code handed to the page that started the attempt.
 * @param ctx - the context carrying `authorization` and `credentials`.
 * @param config - the effective options.
 * @param cli - the resolved Copilot CLI path.
 * @param key - the credential record key.
 */
function registerSignInFlow(ctx, config, cli, key) {
  ctx.authorization.registerFlow({
    key,
    label: config.displayName,
    methods: [{ id: 'oauth', label: 'Sign in with GitHub' }],
    async run(session) {
      const { login } = await deviceLogin(cli, session)
      // The token itself belongs to the CLI's own credential store; this record
      // is the plugin's durable statement of who is signed in. The seam refuses
      // a flow that resolves without committing.
      await ctx.credentials.modifyRecord(key, async () => ({
        kind: 'grant',
        payload: { host: 'github.com', login, cli: 'copilot' },
      }))
      session.notify({ message: `Signed in to GitHub Copilot as ${login}.` })
    },
  })
}

/**
 * Run `copilot login --device-code`, relaying the code to the human and
 * resolving once the CLI reports a signed-in account.
 * @param cli - the Copilot CLI executable.
 * @param session - the authorization attempt's interaction session.
 * @returns the signed-in GitHub login.
 */
function deviceLogin(cli, session) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['login', '--device-code'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let seen = ''
    let announced = false
    let login
    const onData = (chunk) => {
      seen += chunk.toString('utf8')
      if (!announced) {
        const device = parseDeviceCode(seen)
        if (device !== undefined) {
          announced = true
          session.notify({
            message: 'Open this page and enter the code to authorize the Copilot CLI.',
            url: device.url,
            code: device.code,
          })
        }
      }
      const signedIn = parseSignedInLogin(seen)
      if (signedIn !== undefined) login = signedIn
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    session.signal?.addEventListener('abort', () => child.kill(), { once: true })
    child.on('exit', (code) => {
      if (code === 0 && login !== undefined) resolve({ login })
      else reject(new Error(`copilot login exited with code ${code ?? 'null'}${login === undefined ? '' : ` (signed in as ${login})`}`))
    })
  })
}
