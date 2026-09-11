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
 * @module dsh-copilot-acp
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { apply as applyAcpProvider } from '@deepseek-ai/dsh-subagent-acp'
import { apply as applySubagentTool } from '@deepseek-ai/dsh-tool-subagent'
import { parseDeviceCode, parseSignedInLogin } from './device-code.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHIM = join(HERE, 'shim.mjs')

/** The credential record the sign-in flow writes: <scope>/<id>. */
const CREDENTIAL = credentialKey('copilot-acp', 'github')

/** The vendor backend's own defaults, restated because this plugin calls its `apply` directly. */
const DISPOSE_EOF_GRACE_MS = 6000
const DISPOSE_GRACE_MS = 3000

export const name = 'copilot-acp'

/** The services the two reused backend plugins need, so this plugin mounts only when they exist. */
export const inject = ['subagents', 'subprocess', 'tools', 'systemPrompt', 'sessionProjections']

export const Config = z.object({
  providerName: z.string().default('acp'),
  toolName: z.string().default('copilot'),
  displayName: z.string().default('GitHub Copilot'),
  cliPath: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  extraArgs: z.array(z.string()).default([]),
  allowRead: z.boolean().default(true),
  allowNetwork: z.boolean().default(true),
  allowShell: z.boolean().default(false),
  extraWriteRoots: z.array(z.string()).default([]),
  extraDeniedWrites: z.array(z.string()).default([]),
  extraDeniedReads: z.array(z.string()).default([]),
  builtinDenyRules: z.boolean().default(true),
})

/**
 * The Copilot CLI executable.
 *
 * Precedence: explicit config, then `COPILOT_CLI_PATH`, then the platform
 * package published next to the `@github/copilot` umbrella this package
 * depends on — the same resolution the official npm loader performs.
 * @param config - the plugin configuration.
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
 * Mount the policy-scoped ACP provider, the delegation tool, and the sign-in flow.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx, config) {
  const cli = resolveCliPath(config)
  if (cli === undefined) {
    throw new Error(
      'copilot-acp: cannot locate the GitHub Copilot CLI — install this plugin with its @github/copilot dependency, or set `cliPath` (or COPILOT_CLI_PATH)',
    )
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

  applyAcpProvider(ctx, {
    providerName: config.providerName,
    command: process.execPath,
    args,
    // The shim answers every permission request itself; anything it does not
    // answer is refused rather than auto-approved — the previous failure mode
    // was a blanket `allow` that silently widened Copilot's file access.
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

  ctx.inject(['authorization', 'credentials'], (authCtx) => {
    registerSignInFlow(authCtx, config, cli)
  })

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
 * @param config - the plugin configuration.
 * @param cli - the resolved Copilot CLI path.
 */
function registerSignInFlow(ctx, config, cli) {
  ctx.authorization.registerFlow({
    key: CREDENTIAL,
    label: config.displayName,
    methods: [{ id: 'oauth', label: 'Sign in with GitHub' }],
    async run(session) {
      const { login } = await deviceLogin(cli, session)
      // The token itself belongs to the CLI's own credential store; this record
      // is the plugin's durable statement of who is signed in. The seam refuses
      // a flow that resolves without committing.
      await ctx.credentials.modifyRecord(CREDENTIAL, async () => ({
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
