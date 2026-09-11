#!/usr/bin/env node
/**
 * ACP policy middle layer for `dsh-copilot-acp`.
 *
 * DSH speaks ACP to this process over stdio; this process speaks ACP to the
 * official GitHub Copilot CLI, which it spawns as a child. Every message is
 * forwarded untouched EXCEPT `session/request_permission`: that one is answered
 * here, by the policy below, so the client's blanket auto-approval can never
 * widen Copilot's access (which is exactly what happens when a plain ACP
 * provider is configured with `permission: allow`).
 *
 * The session workspace is this process's cwd: the ACP provider spawns each
 * child with the delegating parent session's working directory, so the policy
 * scopes writes to "the same workspace as the parent agent" per delegation,
 * with no static path in any configuration file.
 *
 * Decisions, in order:
 *   1. a path on the protected deny list is refused (even inside the workspace)
 *   2. read/search/think                                  -> policy.read
 *   3. fetch                                              -> policy.network
 *   4. edit/delete/move: every declared path must resolve inside the workspace
 *   5. execute                                            -> policy.shell
 *   6. anything else                                      -> refused
 *
 * Paths are canonicalized by resolving the deepest EXISTING ancestor, so a
 * junction or symlink inside the workspace that points outside cannot be used
 * to create files beyond the boundary.
 *
 * Policy (env `COPILOT_SHIM_POLICY`, JSON), all optional:
 *   read          (true)  — read/search/think tool calls
 *   network       (true)  — fetch tool calls
 *   shell         (false) — execute tool calls
 *   extents       ([])    — extra writable roots
 *   extraWrites   ([])    — extra protected-path rules for writes
 *   extraReads    ([])    — extra protected-path rules for reads
 *   builtinDeny   (true)  — apply the built-in protected-path rules
 *
 * Diagnostics go to stderr; stdout carries nothing but ACP.
 */

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Paths the agent may never WRITE, expressed as path-segment patterns.
 * A single-segment rule matches that segment anywhere in the path; a
 * multi-segment rule matches a contiguous window of segments anywhere.
 * These are the "something runs it later without me asking" surfaces: git
 * executes hooks, package managers execute install scripts and repo config.
 */
const BUILTIN_WRITE_DENY = [
  '.git/hooks',
  '.git/config',
  '.git/config.worktree',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  'package.json',
  '.env*',
]

/** Paths the agent may never READ: the usual credential and key material. */
const BUILTIN_READ_DENY = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.ppk',
  '*.kdbx',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'id_dsa*',
  '.ssh',
  '.gnupg',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.aws/credentials',
  '.docker/config.json',
  '.kube/config',
  '.config/gh/hosts.yml',
]

const [cliPath, ...cliArgs] = process.argv.slice(2)
if (cliPath === undefined) {
  process.stderr.write('[copilot-acp] shim: missing Copilot CLI path argument\n')
  process.exit(2)
}

const workspace = process.cwd()
const policy = readPolicy(process.env.COPILOT_SHIM_POLICY)
const writeRules = [...(policy.builtinDeny ? BUILTIN_WRITE_DENY : []), ...policy.extraWrites]
const readRules = [...(policy.builtinDeny ? BUILTIN_READ_DENY : []), ...policy.extraReads]

/** Parse the policy env value; a broken value fails closed to the defaults. */
function readPolicy(raw) {
  const defaults = {
    read: true,
    network: true,
    shell: false,
    extents: [],
    extraWrites: [],
    extraReads: [],
    builtinDeny: true,
  }
  if (raw === undefined || raw === '') return defaults
  try {
    const parsed = JSON.parse(raw)
    const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [])
    return {
      read: parsed.read !== false,
      network: parsed.network !== false,
      shell: parsed.shell === true,
      extents: strings(parsed.extents),
      extraWrites: strings(parsed.extraWrites),
      extraReads: strings(parsed.extraReads),
      builtinDeny: parsed.builtinDeny !== false,
    }
  } catch (error) {
    process.stderr.write(`[copilot-acp] shim: unreadable policy, failing closed to defaults: ${String(error)}\n`)
    return defaults
  }
}

const childEnv = { ...process.env }
// Never let an ambient switch widen the policy this process enforces.
delete childEnv.COPILOT_ALLOW_ALL
delete childEnv.COPILOT_SHIM_POLICY
childEnv.COPILOT_AUTO_UPDATE = 'false'

const child = spawn(cliPath, cliArgs, {
  cwd: workspace,
  env: childEnv,
  stdio: ['pipe', 'pipe', 'inherit'],
})

process.stdin.pipe(child.stdin)
process.stdin.on('end', () => {
  try {
    child.stdin.end()
  } catch {
    /* the child may already be gone */
  }
})
child.stdin.on('error', () => {})

/** Compare paths portably: Windows paths are case-insensitive. */
const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)

/**
 * Canonical form of a path whose tail may not exist yet.
 *
 * Resolves the deepest existing ancestor (following symlinks and junctions) and
 * re-appends the missing tail. A junction inside the workspace that points
 * outside therefore canonicalizes to the outside path, which is what the
 * boundary check needs to see.
 * @param path - a declared path, absolute or relative to the workspace.
 * @returns an absolute, symlink-free-as-far-as-it-exists path.
 */
function canonical(path) {
  let current = resolve(workspace, path)
  const missing = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      /* c8 ignore next -- an unresolvable filesystem root is not reachable on a real host */
      if (parent === current) return resolve(workspace, path)
      missing.push(basename(current))
      current = parent
    }
  }
}

const workspaceRoots = [canonical(workspace), ...policy.extents.map((extent) => canonical(extent))]

/** Whether an already-canonicalized path is the workspace root or lives under it. */
function insideWorkspace(canonicalPath) {
  for (const root of workspaceRoots) {
    if (fold(canonicalPath) === fold(root)) return true
    const rel = relative(fold(root), fold(canonicalPath))
    if (rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) return true
  }
  return false
}

/** Split a path into meaningful segments. */
function segments(path) {
  return path.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

const regexpCache = new Map()
/** Compile one path-segment glob. */
function segmentPattern(glob) {
  const cached = regexpCache.get(glob)
  if (cached !== undefined) return cached
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\/]*').replace(/\?/g, '.')
  const pattern = new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '')
  regexpCache.set(glob, pattern)
  return pattern
}

/**
 * Whether `pathSegments` is caught by one rule.
 * @param pathSegments - segments of the canonicalized path.
 * @param rule - a slash-separated segment pattern.
 * @returns true when the rule applies.
 */
function matchesRule(pathSegments, rule) {
  const ruleSegments = segments(rule)
  if (ruleSegments.length === 0) return false
  if (ruleSegments.length === 1) {
    const pattern = segmentPattern(ruleSegments[0])
    return pathSegments.some((segment) => pattern.test(segment))
  }
  const patterns = ruleSegments.map(segmentPattern)
  outer: for (let start = 0; start + patterns.length <= pathSegments.length; start++) {
    for (let offset = 0; offset < patterns.length; offset++) {
      if (!patterns[offset].test(pathSegments[start + offset])) continue outer
    }
    return true
  }
  return false
}

/** Whether a canonicalized path is on one of the protected lists. */
function denied(canonicalPath, rules) {
  const pathSegments = segments(canonicalPath)
  return rules.some((rule) => matchesRule(pathSegments, rule))
}

/** Every path a tool call declares, from ACP `locations` and the raw input. */
function declaredPaths(toolCall) {
  const found = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') found.push(value)
  }
  if (Array.isArray(toolCall?.locations)) {
    for (const location of toolCall.locations) push(location?.path)
  }
  const raw = toolCall?.rawInput
  if (raw !== null && typeof raw === 'object') {
    for (const key of ['fileName', 'filePath', 'file', 'path', 'target', 'targetFile', 'absPath']) push(raw[key])
    for (const key of ['paths', 'files', 'targets']) {
      if (Array.isArray(raw[key])) for (const entry of raw[key]) push(typeof entry === 'string' ? entry : entry?.path)
    }
  }
  return [...new Set(found)]
}

/**
 * The policy verdict for one permission request.
 * @param kind - the ACP tool-call kind.
 * @param paths - canonicalized declared paths.
 * @returns the verdict and, when refused, why.
 */
function verdictFor(kind, paths) {
  switch (kind) {
    case 'read':
    case 'search':
    case 'think': {
      if (!policy.read) return { verdict: 'deny', reason: 'read access is disabled by policy' }
      if (paths.some((path) => denied(path, readRules))) {
        return { verdict: 'deny', reason: 'the path is on the protected read list (credentials or key material)' }
      }
      return { verdict: 'allow' }
    }
    case 'fetch':
      return policy.network ? { verdict: 'allow' } : { verdict: 'deny', reason: 'network access is disabled by policy' }
    case 'edit':
    case 'delete':
    case 'move': {
      if (paths.length === 0) return { verdict: 'deny', reason: 'the tool call declared no path' }
      if (paths.some((path) => denied(path, writeRules))) {
        return { verdict: 'deny', reason: 'the path is protected (hooks, package/manager config, install scripts, or secrets)' }
      }
      if (!paths.every(insideWorkspace)) {
        return { verdict: 'deny', reason: "the path resolves outside this session's workspace" }
      }
      return { verdict: 'allow' }
    }
    case 'execute':
      return policy.shell ? { verdict: 'allow' } : { verdict: 'deny', reason: 'shell execution is disabled by policy' }
    default:
      return { verdict: 'deny', reason: `unrecognized tool kind "${kind}"` }
  }
}

/** Answer with the agent's own option ids; `cancelled` when it offers none. */
function answer(options, verdict) {
  const wanted = verdict === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of wanted) {
    const option = (Array.isArray(options) ? options : []).find((entry) => entry?.kind === kind)
    if (option?.optionId !== undefined) return { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  const anyReject = (Array.isArray(options) ? options : []).find(
    (entry) => typeof entry?.kind === 'string' && entry.kind.startsWith('reject'),
  )
  if (verdict === 'deny' && anyReject?.optionId !== undefined) {
    return { outcome: { outcome: 'selected', optionId: anyReject.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

let buffered = ''

/**
 * Explain a refusal on the agent's own message channel.
 * @param sessionId - the ACP session the request belonged to.
 * @param kind - the tool-call kind.
 * @param declared - the paths as the agent declared them.
 * @param reason - why the request was refused.
 */
function announceDenial(sessionId, kind, declared, reason) {
  if (typeof sessionId !== 'string') return
  const where = declared.length > 0 ? declared.join(', ') : '(no path declared)'
  const text = `[copilot-acp] blocked a ${kind}: ${reason}. Requested path(s): ${where}.\n`
  const notice = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  }
  process.stdout.write(`${JSON.stringify(notice)}\n`)
}

function handleLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    process.stdout.write(`${line}\n`)
    return
  }
  if (message?.method === 'session/request_permission' && message.id !== undefined) {
    const toolCall = message.params?.toolCall ?? {}
    const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other'
    const declared = declaredPaths(toolCall)
    const canonicalPaths = declared.map(canonical)
    const { verdict, reason } = verdictFor(kind, canonicalPaths)
    process.stderr.write(
      `[copilot-acp] permission ${verdict.toUpperCase()} kind=${kind} declared=${JSON.stringify(declared)} resolved=${JSON.stringify(canonicalPaths)}${verdict === 'deny' ? ` reason=${reason}` : ''}\n`,
    )
    const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message.params?.options, verdict) })
    child.stdin.write(`${payload}\n`)
    // A denied tool call otherwise ends the turn silently: the child emits
    // thoughts and tool activity, but no `agent_message_chunk`, so the
    // delegating agent would see an empty result with no reason. Report the
    // decision as agent text so the reason survives into the parent's result.
    if (verdict === 'deny') announceDenial(message.params?.sessionId, kind, declared, reason)
    return
  }
  process.stdout.write(`${line}\n`)
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffered += chunk
  let index
  while ((index = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    handleLine(line)
  }
})

child.on('exit', (code, signal) => {
  if (buffered !== '') handleLine(buffered)
  // Flush before exiting: stdout is an async pipe, so a bare process.exit()
  // here would truncate the agent's final message chunks.
  process.stdout.write('', () => process.exit(code ?? (signal === null ? 0 : 1)))
})
child.on('error', (error) => {
  process.stderr.write(`[copilot-acp] shim: cannot spawn Copilot CLI: ${String(error)}\n`)
  process.exit(1)
})
