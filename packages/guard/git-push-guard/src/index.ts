/**
 * Git push guard: while enabled for a session, an agent's Git push does not run
 * until the user answers a confirmation question in the Web UI. The question
 * names the exact command, so the user decides on the real action rather than a
 * pre-granted token.
 *
 * Two independent settings drive the decision. The built-in plugins settings
 * card changes the default for new sessions; the composer chip changes one
 * session only, and a later default change never overrides it. Both are read and
 * written through one same-origin route and persisted as `{ default, sessions }`
 * under the Harness home.
 *
 * The user is the only approval channel: answers come from the human UI, and an
 * agent has no way to answer its own question.
 *
 * @module @deepseek-ai/dsh-git-push-guard
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { pushTargetOf, commandDetailOf, type PushTarget } from './push-command.ts'
import { loadGuardState, saveGuardState, sessionEnabled, type MutableGuardState } from './state.ts'

export type { GuardState } from './state.ts'

/** Cordis function-plugin name. */
export const name = 'git-push-guard'

/** The route carrier, the tool pipeline, the prompt, and the human answerer. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'userQuestions']

/** Plugin configuration. */
export interface Config {
  /** Absolute state file path; defaults to `$DSH_HOME/push-guard/state.json`. */
  readonly stateFile?: string
  /** Whether a new session starts with the guard enabled. Defaults to true. */
  readonly defaultEnabled?: boolean
  /**
   * Branch names whose pushes wait for confirmation. Empty guards every push.
   * Use `guardedBranchesPrefix` for a family such as `release/`.
   */
  readonly guardedBranches?: string[]
  /** Branch-name prefixes whose pushes wait for confirmation; `release/` covers `release/2026-05`. */
  readonly guardedBranchesPrefix?: string[]
}

export const Config: z<Config> = z.object({
  stateFile: z.string(),
  defaultEnabled: z.boolean().default(true),
  guardedBranches: z.array(z.string()).default([]),
  guardedBranchesPrefix: z.array(z.string()).default([]),
})

/** Branches whose pushes wait for confirmation, split by how a name matches. */
interface GuardedBranches {
  /** Branch names matched exactly. */
  readonly exact: readonly string[]
  /** Branch-name prefixes: every branch that starts with one is guarded. */
  readonly prefix: readonly string[]
}

/** Same-origin endpoint the browser controls read and write. */
const STATE_ROUTE = '/push-guard/state'

/** The toggle body is tiny; reject anything larger. */
const MAX_BODY_BYTES = 4096

/** Allow label that admits one push. */
const APPROVE = 'Allow'

/** Allow label that keeps the push blocked. */
const REJECT = 'Reject'

/**
 * Model-facing policy statement contributed while the guard is enabled.
 * @param guardedBranches - configured branch words; empty guards every push.
 * @returns the policy text for this deployment.
 */
function promptTextOf(guardedBranches: GuardedBranches): string {
  const names = [
    ...guardedBranches.exact.map(word => `\`${word}\``),
    ...guardedBranches.prefix.map(word => `\`${word}*\``),
  ]
  const scope = names.length === 0
    ? 'git push commands'
    : `git push commands to ${names.join(', ')}, and pushes that name no branch`
  return `Git push guard is enabled in this session: ${scope} do not run until the user answers `
    + 'the confirmation question the Harness shows right before the command runs. If the user rejects it, do not retry '
    + 'unless the user asks you to push. The user can turn the guard off for this session from the guard chip in the composer.'
}

/** Model-facing denial when the user rejects the push. */
const REJECTED_REASON = 'Git push guard: the user rejected this push, so nothing ran. Do not retry unless the user asks you to push.'

/** Model-facing denial when no human answer is reachable. */
const UNAVAILABLE_REASON = 'Git push guard: the user could not be asked to confirm this push, so nothing ran.'

/** Model-facing denial for a call without an owning agent. */
const NO_AGENT_REASON = 'Git push guard: a push command without an owning agent is always blocked.'

/** Model-facing denial for a subagent call, which cannot open a human interaction. */
const CHILD_REASON = 'Git push guard: a subagent cannot ask the user for push confirmation, so the push was blocked. '
  + 'Report the requested push to the parent agent instead.'

/** Send one JSON response that the browser must not cache. */
function sendJson(response: ServerResponse, status: number, payload: unknown, includeBody = true): void {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(includeBody ? body : undefined)
}

/**
 * Read one size-bounded JSON request body.
 * @param request - incoming request.
 * @returns the parsed body.
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Read one boolean field from a parsed JSON object. */
function booleanField(body: object, field: string): boolean | undefined {
  const value: unknown = Reflect.get(body, field)
  return typeof value === 'boolean' ? value : undefined
}

/** Read one string field from a parsed JSON object. */
function stringField(body: object, field: string): string | undefined {
  const value: unknown = Reflect.get(body, field)
  return typeof value === 'string' ? value : undefined
}

/**
 * Answer the UI state route. GET without `session` reports the default; GET
 * with `?session=<id>` reports that session's own setting. POST `{ enabled }`
 * changes the default, and POST `{ enabled, sessionId }` changes one session.
 * @param state - live guard state.
 * @param persist - writes the state after a change.
 * @returns the HTTP route handler.
 */
function stateRoute(state: MutableGuardState, persist: () => void) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const sessionId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('session') ?? ''
    if (request.method === 'GET' || request.method === 'HEAD') {
      const payload = sessionId === ''
        ? { default: state.default }
        : { default: state.default, session: sessionEnabled(state, sessionId, persist) }
      sendJson(response, 200, payload, request.method !== 'HEAD')
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'GET, HEAD, POST')
      response.statusCode = 405
      response.end()
      return
    }
    if (!/^application\/json\b/iu.test(request.headers['content-type'] ?? '')) {
      sendJson(response, 415, { error: 'content-type must be application/json' })
      return
    }
    try {
      const body = await readJsonBody(request)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(response, 400, { error: 'body must be a JSON object' })
        return
      }
      const enabled = booleanField(body, 'enabled')
      if (enabled === undefined) {
        sendJson(response, 400, { error: 'enabled must be a boolean' })
        return
      }
      const bodySessionId = stringField(body, 'sessionId')
      if (bodySessionId !== undefined && bodySessionId !== '') {
        state.sessions[bodySessionId] = enabled
        persist()
        sendJson(response, 200, { default: state.default, session: enabled })
        return
      }
      state.default = enabled
      persist()
      sendJson(response, 200, { default: state.default })
    } catch {
      sendJson(response, 400, { error: 'invalid JSON body' })
    }
  }
}

/** Whether one pending push stays guarded, and which configured words it reaches. */
interface GuardHit {
  /** Configured words the push reaches; empty when no branch filter is configured. */
  readonly matched: readonly string[]
  /** Whether the command names no single destination, so its branch is unknown here. */
  readonly unknown: boolean
}

/**
 * Decide whether one push target stays guarded.
 * @param target - the branches the command pushes to.
 * @param guardedBranches - configured words; empty guards every push.
 * @returns the hit, or undefined when a configured filter covers no branch of this push.
 */
function guardHit(target: PushTarget, guardedBranches: GuardedBranches): GuardHit | undefined {
  const words = [...guardedBranches.exact, ...guardedBranches.prefix.map(word => `${word}*`)]
  if (words.length === 0) return { matched: [], unknown: false }
  // `--all` and a push without a refspec can reach a guarded branch without
  // naming it, so they stay guarded rather than passing unexamined.
  if (target.all || target.implicit) return { matched: [], unknown: true }
  const matched = target.branches.flatMap((branch) => {
    if (guardedBranches.exact.includes(branch)) return [branch]
    const prefix = guardedBranches.prefix.find(word => branch.startsWith(word))
    return prefix === undefined ? [] : [`${prefix}*`]
  })
  return matched.length === 0 ? undefined : { matched: [...new Set(matched)], unknown: false }
}

/**
 * Describe the guarded branches in the confirmation question.
 * @param hit - what the pending push reaches.
 * @returns one line naming the branches, or the reason the branch is unknown.
 */
function detailOfHit(hit: GuardHit): string {
  if (hit.matched.length > 0) return `Guarded branches: ${hit.matched.join(', ')}`
  if (hit.unknown) return 'Guarded branches: the command names none, so it pushes the current branch'
  return 'Guarded branches: every push'
}

/**
 * Ask the user whether one pending push may run.
 * @param ctx - plugin context carrying the human answerer.
 * @param agent - the agent that owns the pending call.
 * @param execution - the pending tool call.
 * @param command - its shell command string.
 * @param hit - the guarded branches this push reaches.
 * @returns the pre-dispatch decision.
 */
async function confirmPush(
  ctx: Context,
  agent: NonNullable<ToolExecution['agent']>,
  execution: ToolExecution,
  command: string,
  hit: GuardHit,
): Promise<PreToolDecision> {
  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      signal: execution.signal,
      questions: [{
        id: 'git-push-guard',
        header: 'Git push guard',
        question: 'Allow this Git push?',
        detail: `The agent wants to run:\n\n${commandDetailOf(command)}\n\n${detailOfHit(hit)}`,
        options: [
          { label: APPROVE, description: 'Run this push command.' },
          { label: REJECT, description: 'Keep the push blocked.' },
        ],
      }],
    })
    const selected = answer.answers.flatMap(item => item.selected)
    if (selected.includes(APPROVE)) return { kind: 'allow' }
    return { kind: 'deny', reason: REJECTED_REASON }
  } catch (error) {
    if (execution.signal.aborted) return { kind: 'cancel' }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('child') || message.includes('owned by another live agent')) return { kind: 'deny', reason: CHILD_REASON }
    return { kind: 'deny', reason: `${UNAVAILABLE_REASON} (${message})` }
  }
}

/**
 * Name the argument that carries a tool call's command text. Bash and
 * PowerShell both pass the command as `command`; a terminal write passes the
 * text to send.
 * @param tool - the tool's registered name.
 * @returns the argument field, or undefined for every other tool.
 */
function commandFieldOf(tool: string): string | undefined {
  switch (tool) {
    case 'bash':
    case 'pwsh':
      return 'command'
    case 'terminal_send':
      return 'text'
    default:
      return undefined
  }
}

/**
 * Read the shell command string of a tool call this guard inspects.
 * @param execution - pending tool call.
 * @returns the command string, or undefined for every other tool.
 */
function commandOf(execution: ToolExecution): string | undefined {
  const field = commandFieldOf(execution.name)
  if (field === undefined) return undefined
  const args = execution.arguments
  if (args === null || typeof args !== 'object') return undefined
  const value: unknown = Reflect.get(args, field)
  return typeof value === 'string' ? value : undefined
}

/**
 * Report the push a pending tool call would run.
 * @param execution - pending tool call.
 * @returns the command string and its target, or undefined when the call pushes nothing.
 */
function pushOf(execution: ToolExecution): { command: string; target: PushTarget } | undefined {
  const command = commandOf(execution)
  if (command === undefined) return undefined
  const target = pushTargetOf(command)
  return target === undefined ? undefined : { command, target }
}

/**
 * Register the guard while this plugin is active.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const file = config.stateFile ?? dshHomePath('push-guard', 'state.json')
  /* v8 ignore next -- Config normalization supplies defaultEnabled before apply; the fallback serves direct apply() calls. */
  const state = loadGuardState(file, config.defaultEnabled ?? true)
  const guardedBranches: GuardedBranches = { exact: config.guardedBranches ?? [], prefix: config.guardedBranchesPrefix ?? [] }
  const persist = (): void => { saveGuardState(file, state) }

  // The route admits no anonymous request: the Connection service's
  // `webserver/authorize` listener applies the deployment's Host/Origin fence
  // and resolves the browser's session cookie before this handler runs.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    auth: 'required',
    handler: stateRoute(state, persist),
  }), 'git-push-guard: state route')

  // A new session starts with the current default and then keeps its own choice.
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent.session.id
    if (state.sessions[sessionId] !== undefined) return
    state.sessions[sessionId] = state.default
    persist()
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const push = pushOf(exec)
    if (push === undefined) return next()
    const hit = guardHit(push.target, guardedBranches)
    if (hit === undefined) return next()
    const agent = exec.agent
    // A push intent without an owning session cannot be approved; fail closed.
    if (agent === undefined) return { kind: 'deny', reason: NO_AGENT_REASON }
    const sessionId = agent.session.id
    if (!sessionEnabled(state, sessionId, persist)) return next()
    const decision = await confirmPush(ctx, agent, exec, push.command, hit)
    if (decision.kind === 'allow') return next()
    return decision
  })

  ctx.systemPrompt.section({
    name: 'git-push-guard:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      return sessionEnabled(state, agent.session.id, persist) ? promptTextOf(guardedBranches) : ''
    },
  })
}
