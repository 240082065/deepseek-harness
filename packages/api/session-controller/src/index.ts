/** Session Remote owner: cold reads, explicit Agent commands, and live control state. */

import { hostname } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { canOpenNativePath, nativeFileManager, nativeFileApplications, openNativeFileApplication, openNativeAssociatedPath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ApiSessionAgentController,
  inspectApiSession,
  type ApiSessionAgentResult,
} from './agent.ts'
import { SessionCommandController } from './commands.ts'
import { SessionControlController } from './control.ts'
import { SessionHistoryController } from './history.ts'
import { SessionFileReferences } from './file-references.ts'
import { ApiSessionList } from './list.ts'
import { buildModelCatalog, hasProviderApiKey } from './catalog.ts'
import { installModelSelectionProjection } from './model-selection-projection.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import { SessionMediaReferences } from './media-references.ts'
import { ArchivedSessionGate } from './archived-session-gate.ts'
import type {
  ModelCatalog,
  SessionWorkspacePathApplication,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionProjectionsRequest,
  SessionProjectionsValue,
  SessionProjectionValues,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

export type * from './types.ts'
export { ApiSessionNotFound } from './agent.ts'
export { SessionFileReferences } from './file-references.ts'
export { SessionSkillCatalog } from './skill-catalog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner. */
    sessionController: SessionController
  }
}

/** Session Controller deployment policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
  /** Positive integral milliseconds of list work before yielding between complete rows. */
  readonly listWorkSliceMs?: number
}

/** Deployment policy after schema defaults have been applied. */
type ResolvedConfig = Config & { readonly listWorkSliceMs: number }

/** Host integrations replaceable by direct unit tests. */
export interface SessionControllerInternals {
  /** Native default-application handoff. */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native file-association query. */
  readonly fileApplications?: typeof nativeFileApplications
  /** Explicit registered-application handoff. */
  readonly openFileApplication?: typeof openNativeFileApplication
  /** Native file-manager handoff. */
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native handoff availability probe. */
  readonly canOpenPath?: () => boolean
}

/** Host service backing the generated `ctx.remote.session` namespace. */
export class SessionController extends TypertRemoteService {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'fileUploads',
    'fs',
    'llm',
    'sessions',
    'sessionProjections',
    'sessionQuery',
    'typert',
    'workspaceRegistry',
  ]

  static Config: z<Config, ResolvedConfig> = z.object({
    nativeOpen: z.boolean(),
    listWorkSliceMs: z.natural().min(1).default(16),
  })

  private readonly agents: ApiSessionAgentController
  private readonly commands: SessionCommandController
  private readonly controlState: SessionControlController
  private readonly history: SessionHistoryController
  private readonly listState: ApiSessionList
  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly fileApplications: typeof nativeFileApplications
  private readonly openFileApplication: typeof openNativeFileApplication
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly promotions = new Set<Promise<void>>()

  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener and list-scheduling deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    const resolved = SessionController.Config(config)
    installModelSelectionProjection(ctx)
    this.agents = new ApiSessionAgentController(ctx)
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd())
    ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => {
      const result = await this.agents.resolveAgent(sessionId)
      if ('error' in result) throw result.error
      return result.agent
    }), 'session-controller: file-upload Agent resolver')
    this.controlState = new SessionControlController(ctx)
    // Registered before history so reverse-order teardown closes every
    // follower before waiting for already-admitted promotions.
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions])
    }, 'session-controller.promotions')
    this.history = new SessionHistoryController(ctx, (observation) => { this.promote(observation) })
    this.listState = new ApiSessionList(ctx, resolved.listWorkSliceMs)
    this.fileApplications = internals.fileApplications ?? nativeFileApplications
    this.openFileApplication = internals.openFileApplication ?? openNativeFileApplication
    this.openPath = internals.openPath ?? openNativeAssociatedPath
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionMediaReferences)
    ctx.plugin(SessionSkillCatalog)
    // An archived Session, or a subagent descendant of one, runs no model step
    // until it is restored; what it still runs is stopped by the owners that
    // answer the Workspace registry's archive-admission events.
    ctx.plugin(ArchivedSessionGate)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    ctx.on('session/disposed', (session) => {
      ctx.emit('api-session/removed', session.id)
    })
    const publishAgentAvailability = ({ agent }: { agent: Agent }): undefined => {
      if (ctx.sessions.get(agent.id) === agent.session) {
        ctx.emit('api-session/added', this.listState.summaryFor(agent.session))
      }
    }
    ctx.on('agent/created', publishAgentAvailability)
    ctx.on('agent/disposed', publishAgentAvailability)
    ctx.on('agent/status', ({ agent, status }) => {
      ctx.emit('api-session/status', agent.id, status === 'running')
    })
    ctx.on('agent/error', ({ agent, error }) => {
      ctx.emit('api-session/error', agent.id, errorChain(error))
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const agent = ctx.agents.get(session.id)
        if (agent?.session === session) this.agents.consumeSelection(
          agent,
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort,
        )
      }
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      ctx.emit('api-session/activity', session.id, event.time)
    })

    // --- 本地定制：脚本桥接路由（课题 #67-484，方案 B） ---------------------
    // 只做一件事：让外部脚本能建会话 / 发消息，并且因为直接调用下面 create()/
    // prompt() 这两个已有的公开方法（跟 Remote 协议走的是同一套逻辑），已打开
    // 的桌面端界面能像平时一样实时看到——不需要另外通知前端刷新。
    // 纯粹新增、默认不生效：只有显式设了 DSH_SCRIPT_BRIDGE_KEY 环境变量才会注册
    // 这条路由，不设就跟官方原版行为完全一样，不影响任何已有功能。
    // 注意：故意不走 ctx.connection.fetch.register——那条注册在 /api 前缀下，
    // 会先过浏览器登录 cookie 那道闸（没 cookie 一律 401，我们的处理函数根本
    // 轮不到执行），这正是我们想绕开、不借用登录态的那层。改为直接注入
    // webServer，在 /api 之外另挂一个路径，只认自己这把暗号。
    const scriptBridgeKey = process.env.DSH_SCRIPT_BRIDGE_KEY
    if (scriptBridgeKey !== undefined && scriptBridgeKey.length > 0) {
      // devhub 的 HarnessContract 要求执行器能报告「开工/收工」事件(exit_reason)、
      // 能被打断(cancel)；这里另开几路监听，只追加进我们自己的环形缓冲区，不改
      // 上面几行官方原有的监听器行为。sessionId 对应哪个对话，cwd 对应哪个文件夹，
      // 都从这几个事件本身带的字段里取，不用额外猜。
      ctx.on('session/created', (session) => {
        pushScriptBridgeEvent('session-created', session.id, session.header.cwd === undefined
          ? {}
          : { cwd: session.header.cwd })
      })
      ctx.on('session/disposed', (session) => {
        pushScriptBridgeEvent('session-disposed', session.id)
      })
      ctx.on('agent/status', ({ agent, status }) => {
        pushScriptBridgeEvent(status === 'running' ? 'agent-running' : 'agent-idle', agent.id)
      })
      ctx.on('agent/error', ({ agent, error }) => {
        pushScriptBridgeEvent('agent-error', agent.id, { detail: errorChain(error) })
      })
      ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
          kind: 'exact',
          path: '/x-script-bridge/session',
          handler: (req, res) => handleScriptBridgeRequest(this, scriptBridgeKey, req, res),
        }), 'session-controller: script-bridge route (local customization, #67-484)')
      })
    }
  }

  private promote(observation: SessionObservation): void {
    const sessionId = observation.header.id
    const task = (async () => {
      using ownedObservation = observation
      const result = await this.agents.resolveObservedAgent(ownedObservation)
      if ('error' in result) this.ctx.emit('api-session/error', sessionId, result.error.message)
    })().catch((error: unknown) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`)
    })
    this.promotions.add(task)
    void task.finally(() => { this.promotions.delete(task) })
  }

  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.agents.resolveAgent(sessionId)
  }

  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - durable Session identity.
   * @param signal - optional caller cancellation for persistence reads.
   * @returns the current attached state or persisted header and event prefix.
   */
  inspect(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionInspection> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return Promise.resolve({
        meta: attached.header,
        inheritedEventCount: attached.inheritedEventCount,
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        events: attached.snapshotEvents(),
      })
    }
    return inspectApiSession(this.ctx, sessionId, signal)
  }

  /**
   * Read all visible Session rows without resuming an Agent.
   * @param _request - reserved empty list request.
   * @param signal - cancellation for persistence reads and summary generation.
   * @returns visible Session summaries ordered by activity.
   */
  @Remote('list')
  async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    return { items: await this.listState.list(signal) }
  }

  /**
   * Search visible Session content without resuming an Agent.
   * @param request - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  @Remote('search')
  search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    return this.listState.search(request.query, signal)
  }

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Select one Session-local model after explicitly resuming the Session; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session, without waiting for default persistence.
   */
  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    return this.commands.selectModel(request)
  }

  /**
   * Select the first available account model after login when no provider API key is configured.
   * @returns after saving the first available model or retaining the existing default.
   */
  @Remote
  async initializeDefaultModel(): Promise<void> {
    const provider = 'deepseek-account'
    if (await hasProviderApiKey(this.ctx)) return
    const catalog = await buildModelCatalog(this.ctx)
    const model = catalog.groups.find(group => group.id === provider)?.models[0]
    if (model === undefined) throw new RemoteError('session/provider-models-unavailable',
      `provider "${provider}" has no available models`, { provider })
    const selection = { provider, model: model.id,
      ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoning.defaultEffort) },
    }
    await this.ctx.agentDefaultModel.saveSelection(selection)
  }

  /**
   * Describe every currently routable model for Host-generation selectors.
   * @returns provider-grouped models, the deployment default, and isolated provider failures.
   */
  @Remote('modelCatalog')
  modelCatalog(): Promise<ModelCatalog> {
    return buildModelCatalog(this.ctx)
  }

  /**
   * Report whether this deployment can hand a Session workspace path to a native desktop.
   * @returns true when the matching open operation is available.
   */
  @Remote
  canOpenWorkspacePath(): boolean {
    return this.canOpenPath()
  }

  /**
   * Describe the serving desktop for authenticated file-action routes.
   * @returns Host name, configured availability, and platform-specific file-manager behavior.
   */
  workspaceDesktop(): { name: string; available: boolean; fileManager: 'finder' | 'explorer' | 'directory' | null } {
    const fileManager = nativeFileManager()
    return { name: hostname(), available: fileManager !== null && this.canOpenPath(), fileManager }
  }

  /**
   * Verify one path through the composed filesystem and open it on the Host desktop.
   * @param request - path after best-effort Session workspace resolution.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the native opener accepts the path.
   * @throws RemoteError when the request is invalid, has no verified Host mapping, is cancelled, or the opener fails.
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      if (request.action === 'reveal') await this.revealPath(path, signal)
      else if (request.application !== undefined) await this.openFileApplication(path, request.application, signal)
      else await this.openPath(path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'path open was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError(
        'gateway/internal',
        'path open failed',
        {},
        { cause: error },
      )
    }
  }

  /**
   * Query current file handlers on the serving desktop without activating an Agent.
   * @param request - file path in Host filesystem syntax.
   * @param signal - caller lifetime, propagated to filesystem and desktop queries.
   * @returns OS application names, icons, and default selection; empty when desktop opening is unavailable.
   * @throws RemoteError when the path is invalid, the query is cancelled, or native discovery fails.
   */
  @Remote('workspacePathApplications')
  async workspacePathApplications(
    request: { readonly path: string }, signal: AbortSignal,
  ): Promise<readonly SessionWorkspacePathApplication[]> {
    if (!this.canOpenPath()) return []
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      return await this.fileApplications(path, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'application query was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'file application query failed', {}, { cause: error })
    }
  }

  private async verifyDesktopPath(path: string, signal: AbortSignal): Promise<string> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'A non-empty file path is required', {})
    signal.throwIfAborted()
    const hostPath = resolve(path)
    const { fs } = this.ctx
    const mapped = fs.processPathFromHostPath(hostPath)
    if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal })) !== hostPath) {
      throw new RemoteError('gateway/bad-request', 'Path has no verified Host path', {})
    }
    signal.throwIfAborted()
    return hostPath
  }

  /**
   * Rename one Session after explicitly resuming it.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  @Remote('rename')
  rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    return this.commands.rename(request)
  }

  /**
   * Fork one cold-readable exact event prefix into a new Session. An omitted
   * boundary selects the latest completed-turn prefix; an open cut receives
   * synthetic fork closers.
   * @param request - source Session and optional exact inclusive event boundary.
   * @returns the new Session identity.
   */
  @Remote('fork')
  fork(request: SessionForkRequest): Promise<SessionForkValue> {
    return this.commands.fork(request)
  }

  /**
   * Admit one prompt after explicitly resuming its Session.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @param signal - caller cancellation before prompt admission begins.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  @Remote('prompt')
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    signal.throwIfAborted()
    return this.commands.prompt(request)
  }

  /**
   * Read one image proven reachable from the addressed Session log.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    return this.commands.attachment(request)
  }

  /**
   * Mutate one still-pending queue occurrence, resuming a cold Agent first.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  @Remote('updateQueue')
  updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    return this.commands.updateQueue(request)
  }

  /**
   * Cancel one active Agent turn without dropping its pending inbox.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue {
    return this.commands.cancel(request)
  }

  /**
   * Read one cold-safe, message-aligned Session history page.
   * @param request - durable address, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page.
   */
  @Remote('page')
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    return this.history.page(request, signal)
  }

  /**
   * Follow one Session log from its opening or resume cursor.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete opening snapshot followed by gap-free durable event
   *   frames and optional cursorless assistant-stream frames.
   */
  @Remote({ mode: 'stream' })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.history.follow(request, signal)
  }

  /**
   * Read all registered projections without activating an Agent.
   * @param request - Session whose current values are required.
   * @param signal - cancellation for the Session observation.
   * @returns complete baseline, or null when the Session does not exist.
   */
  @Remote('projections')
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    const { sessionId } = request
    if (sessionId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    }
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal })
      const projections = observation.projections
      if (projections === undefined) {
        throw new RemoteError('session/projections-unavailable', 'Session projections are unavailable', {})
      }
      return { asOfSeq: projections.asOfSeq, values: projections.values as SessionProjectionValues }
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
      if (signal.aborted
        || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')) {
        throw new RemoteError('gateway/cancelled', 'Session projection read was cancelled', {}, { cause: error })
      }
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'Session projection read failed', {}, { cause: error })
    }
  }

  /**
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.controlState.control(signal)
  }


}

export { buildModelCatalog }
export default SessionController

/**
 * 本地定制（课题 #67-484，方案 B）：脚本建会话/发消息的「开工」「收工」事件环形
 * 缓冲区——满足 devhub HarnessContract 的 exit_reason / event_stream 要求。
 * 只在 DSH_SCRIPT_BRIDGE_KEY 生效时才有监听器往里写，平时是空数组，零开销。
 */
interface ScriptBridgeEvent {
  readonly seq: number
  readonly time: number
  /** session-created=开工；session-disposed/agent-idle=收工；agent-error=收工且异常。 */
  readonly type: 'session-created' | 'session-disposed' | 'agent-running' | 'agent-idle' | 'agent-error'
  /** 对应哪个对话。 */
  readonly sessionId: string
  /** 对应哪个文件夹，只有 session-created 带。 */
  readonly cwd?: string
  /** agent-error 的错误详情，即退出原因。 */
  readonly detail?: string
}
const SCRIPT_BRIDGE_EVENT_CAP = 1000
const scriptBridgeEvents: ScriptBridgeEvent[] = []
let scriptBridgeEventSeq = 0

function pushScriptBridgeEvent(
  type: ScriptBridgeEvent['type'],
  sessionId: string,
  extra: { cwd?: string; detail?: string } = {},
): void {
  scriptBridgeEventSeq += 1
  scriptBridgeEvents.push({ seq: scriptBridgeEventSeq, time: Date.now(), type, sessionId, ...extra })
  if (scriptBridgeEvents.length > SCRIPT_BRIDGE_EVENT_CAP) scriptBridgeEvents.shift()
}

/**
 * 本地定制（课题 #67-484，方案 B）：脚本桥接路由的实际处理函数。
 *
 * 认四个动作：
 *   - {"action":"create", "payload": SessionCreateRequest} 建会话（开工入口之一）
 *   - {"action":"prompt", "payload": SessionPromptRequest} 发消息
 *   - {"action":"cancel", "payload": SessionCancelRequest} 打断当前轮
 *   - {"action":"events", "payload": {"sinceSeq"?: number}} 读开工/收工事件，
 *     sinceSeq 省略或给 0 表示从头读，否则只读比它新的
 * create/prompt/cancel 直接转调 SessionController 已有的同名公开方法——跟界面
 * 点按钮触发的是同一条代码路径，不碰 Remote/typert 协议那一层，也不复用浏览器
 * 登录态，鉴权只看请求头 `x-script-bridge-key` 是否等于启动时设的那个值。
 * @param controller - 当前 SessionController 实例，借用它已有的 create/prompt/cancel。
 * @param expectedKey - 启动时从 DSH_SCRIPT_BRIDGE_KEY 环境变量读到的暗号。
 * @param request - 原始 Fetch 请求。
 * @returns JSON 响应：成功 200，暗号不对 401，格式不对或内部出错 400/500。
 */
function writeScriptBridgeJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

async function readScriptBridgeBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function handleScriptBridgeRequest(
  controller: SessionController,
  expectedKey: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    writeScriptBridgeJson(res, 405, { error: 'POST only' })
    return
  }
  if (req.headers['x-script-bridge-key'] !== expectedKey) {
    writeScriptBridgeJson(res, 401, { error: 'unauthorized' })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readScriptBridgeBody(req))
  } catch {
    writeScriptBridgeJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  if (typeof body !== 'object' || body === null || !('action' in body) || !('payload' in body)) {
    writeScriptBridgeJson(res, 400, { error: 'expected {"action","payload"}' })
    return
  }
  const { action, payload } = body as { action: unknown; payload: unknown }
  try {
    if (action === 'create') {
      const value = await controller.create(payload as SessionCreateRequest)
      writeScriptBridgeJson(res, 200, { ok: true, result: value })
      return
    }
    if (action === 'prompt') {
      const value = await controller.prompt(payload as SessionPromptRequest, new AbortController().signal)
      writeScriptBridgeJson(res, 200, { ok: true, result: value })
      return
    }
    if (action === 'cancel') {
      const value = controller.cancel(payload as SessionCancelRequest)
      writeScriptBridgeJson(res, 200, { ok: true, result: value })
      return
    }
    if (action === 'events') {
      const sinceSeq = typeof (payload as { sinceSeq?: unknown } | undefined)?.sinceSeq === 'number'
        ? (payload as { sinceSeq: number }).sinceSeq
        : 0
      const events = scriptBridgeEvents.filter(e => e.seq > sinceSeq)
      writeScriptBridgeJson(res, 200, { ok: true, result: { events, lastSeq: scriptBridgeEventSeq } })
      return
    }
    writeScriptBridgeJson(res, 400, { error: `unknown action "${String(action)}"` })
  } catch (error) {
    writeScriptBridgeJson(res, 500, { error: errorChain(error) })
  }
}
