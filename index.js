/**
 * DSH-消息树（Host）
 *
 * 功能：持久化分支树；从任意用户消息前 fork；把编辑后的文字和附件发送到分支；
 * 继承父会话的模型与工作区；同步树标题；提供树级重命名、归档、删除。
 *
 * 修改 DSH：新增 /message-tree/* HTTP 路由；监听 session/event 更新分支标题和
 * 首条用户消息；通过 sessionController 创建/fork/发送/重命名会话，通过
 * workspaceRegistry 归档或删除，通过 fileUploads 为重发文件创建回执。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'message-tree'
export const inject = [
  'webServer',
  'sessionController',
  'agents',
  'sessions',
  'workspaceRegistry',
  'attachments',
  'fileUploads',
]

const ROUTE = '/message-tree'
const STORE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'message-tree')
const STORE_FILE = join(STORE_DIR, 'trees.json')
const MAX_BODY_BYTES = 64 * 1024 * 1024

const state = { trees: {}, sessionRoot: {} }
let writeChain = Promise.resolve()

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return
    if (parsed.trees && typeof parsed.trees === 'object') state.trees = parsed.trees
    if (parsed.sessionRoot && typeof parsed.sessionRoot === 'object') state.sessionRoot = parsed.sessionRoot
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('message-tree: failed to read state', error)
  }
}

async function saveState() {
  await mkdir(STORE_DIR, { recursive: true })
  const payload = JSON.stringify(state, null, 2)
  const temporary = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(temporary, payload, 'utf8')
  await rename(temporary, STORE_FILE)
}

function persist() {
  writeChain = writeChain.then(saveState, saveState)
  return writeChain
}

function publicState() {
  const hiddenSessionIds = []
  const trees = Object.values(state.trees).map((tree) => {
    const sessionIds = Object.keys(tree.sessions || {})
    for (const id of sessionIds) {
      if (id !== tree.activeSessionId) hiddenSessionIds.push(id)
    }
    return {
      rootId: tree.rootId,
      activeSessionId: tree.activeSessionId,
      title: tree.title || '',
      sessionIds,
      history: [...(tree.history || [])],
      points: Object.values(tree.points || {}).map((point) => ({
        id: point.id,
        parentSessionId: point.parentSessionId,
        messageId: point.messageId,
        seq: point.seq,
        versions: (point.versions || []).map((version) => ({
          sessionId: version.sessionId,
          messageId: version.messageId,
          seq: version.seq,
        })),
      })),
    }
  })
  return {
    ok: true,
    trees,
    sessionRoot: { ...state.sessionRoot },
    hiddenSessionIds,
  }
}

function treeOf(sessionId) {
  const root = state.sessionRoot[sessionId]
  return root ? state.trees[root] : undefined
}

function ensureTree(sessionId, title = '') {
  const existing = treeOf(sessionId)
  if (existing) return existing
  const tree = {
    rootId: sessionId,
    activeSessionId: sessionId,
    title,
    sessions: {
      [sessionId]: { parentSessionId: null, forkAtSeq: null, createdAt: Date.now() },
    },
    points: {},
    history: [sessionId],
  }
  state.trees[sessionId] = tree
  state.sessionRoot[sessionId] = sessionId
  return tree
}

async function ensureLiveSession(ctx, sessionId) {
  let session = ctx.sessions.get(sessionId)
  if (session) return session
  const resolved = await ctx.sessionController.resolveAgent(sessionId)
  if (resolved?.error) {
    throw Object.assign(new Error('Session is unavailable.'), { status: 404 })
  }
  session = ctx.sessions.get(sessionId)
  if (!session) throw Object.assign(new Error('Session is unavailable.'), { status: 404 })
  return session
}

function findUserMessage(session, messageId) {
  const events = session.snapshotEvents()
  for (const event of events) {
    if (event.type === 'user/message' && event.data?.id === messageId) return event
  }
  throw Object.assign(new Error('User message not found.'), { status: 404 })
}

async function stopAndClear(ctx, sessionId) {
  const agent = ctx.agents.get(sessionId)
  if (!agent) return
  try {
    await agent.cancel({ kind: 'user' })
  } catch (error) {
    console.error('message-tree: cancel failed', error)
  }
  try {
    await agent.whenIdle()
  } catch (error) {
    console.error('message-tree: idle wait failed', error)
  }
}

async function attachWorkspace(ctx, parentSessionId, childSessionId) {
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(parentSessionId)) continue
    try {
      await workspace.attachSession(childSessionId)
    } catch (error) {
      console.error('message-tree: workspace attach failed', error)
    }
  }
}

async function inheritModel(ctx, parentSessionId, childSessionId) {
  const parent = ctx.sessions.get(parentSessionId)
  const config = parent?.requestHeader?.()?.config
  if (!config?.provider || !config?.model) return
  try {
    await ctx.sessionController.selectModel({
      sessionId: childSessionId,
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    })
  } catch (error) {
    console.error('message-tree: model inheritance failed', error)
  }
}

async function renameSession(ctx, sessionId, title) {
  if (!title) return
  try {
    await ctx.sessionController.rename({ sessionId, title })
  } catch (error) {
    console.error('message-tree: rename failed', error)
  }
}

async function* singleChunk(bytes) {
  yield bytes
}

function recordEdit(tree, parentSessionId, target, childSessionId, forkAtSeq) {
  const pointId = `${parentSessionId}:${target.data.id}`
  let point = tree.points[pointId]
  if (!point) {
    point = {
      id: pointId,
      parentSessionId,
      messageId: target.data.id,
      seq: target.seq,
      versions: [],
    }
    tree.points[pointId] = point
  }
  if (!point.versions.some((version) => version.sessionId === parentSessionId)) {
    point.versions.unshift({ sessionId: parentSessionId, messageId: target.data.id, seq: target.seq })
  }
  if (!point.versions.some((version) => version.sessionId === childSessionId)) {
    point.versions.push({ sessionId: childSessionId, messageId: null, seq: null })
  }
  tree.sessions[childSessionId] = { parentSessionId, forkAtSeq, createdAt: Date.now() }
  state.sessionRoot[childSessionId] = tree.rootId
  tree.activeSessionId = childSessionId
  tree.history = [...(tree.history || []), childSessionId]
  return point
}

function hasEarlierHuman(session, targetSeq) {
  for (const event of session.snapshotEvents()) {
    if (event.seq >= targetSeq) break
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') return true
  }
  return false
}

async function handlePrepare(ctx, body) {
  const parentSessionId = sessionIdOf(body.sessionId)
  const messageId = typeof body.messageId === 'string' ? body.messageId : ''
  if (!messageId) throw Object.assign(new TypeError('messageId is required.'), { status: 400 })

  const parentSession = await ensureLiveSession(ctx, parentSessionId)
  const target = findUserMessage(parentSession, messageId)
  const tree = ensureTree(parentSessionId, typeof body.title === 'string' ? body.title : '')
  if (body.title && !tree.title) tree.title = body.title

  await stopAndClear(ctx, parentSessionId)

  const earlier = hasEarlierHuman(parentSession, target.seq)
  let childSessionId
  if (earlier) {
    const fork = await ctx.sessionController.fork({
      sessionId: parentSessionId,
      atSeq: target.seq - 1,
    })
    childSessionId = fork.sessionId
  } else {
    const created = await ctx.sessionController.create({
      cwd: parentSession.header.cwd || homedir(),
      ...(parentSession.header.agentPreset ? { agentPreset: parentSession.header.agentPreset } : {}),
    })
    childSessionId = created.sessionId
  }

  await attachWorkspace(ctx, parentSessionId, childSessionId)
  await renameSession(ctx, childSessionId, tree.title)
  await inheritModel(ctx, parentSessionId, childSessionId)

  const point = recordEdit(tree, parentSessionId, target, childSessionId, earlier ? target.seq - 1 : 0)
  await persist()

  return {
    ok: true,
    childSessionId,
    pointId: point.id,
    message: summarizeMessage(target),
    state: publicState(),
  }
}

async function handleSend(ctx, body) {
  const sessionId = sessionIdOf(body.sessionId)
  await ensureLiveSession(ctx, sessionId)

  const content = []
  const text = typeof body.text === 'string' ? body.text : ''
  if (text.trim()) content.push({ type: 'text', text })
  for (const item of Array.isArray(body.attachments) ? body.attachments : []) {
    const attachment = item?.attachment
    if (attachment?.attachmentId) {
      if (item.kind === 'image') {
        const stored = await ctx.attachments.readImage(attachment)
        content.push({
          type: 'image',
          mediaType: attachment.mediaType,
          data: Buffer.from(stored.data).toString('base64'),
          name: attachment.name,
        })
      } else {
        const receipt = await ctx.fileUploads.uploadStream({
          sessionId,
          data: ctx.attachments.readFileStream(attachment),
          name: attachment.name,
        })
        content.push({ type: 'file', receiptId: receipt.receiptId })
      }
      continue
    }
    if (typeof item?.data !== 'string' || !item.data) continue
    if (item.kind === 'image') {
      content.push({
        type: 'image',
        mediaType: item.mediaType,
        data: item.data,
        name: item.name,
      })
    } else {
      const receipt = await ctx.fileUploads.uploadStream({
        sessionId,
        data: singleChunk(Buffer.from(item.data, 'base64')),
        name: item.name,
      })
      content.push({ type: 'file', receiptId: receipt.receiptId })
    }
  }
  if (content.length === 0) {
    throw Object.assign(new Error('The edited message is empty.'), { status: 400 })
  }

  const prompted = await ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content,
  }, new AbortController().signal)
  if (prompted?.accepted !== true) {
    throw Object.assign(new Error('Could not send the edited message.'), { status: 500 })
  }
  return { ok: true, state: publicState() }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }))
      }
    })
    request.on('error', reject)
  })
}

function respondJson(response, status, value) {
  if (response.writableEnded) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sessionIdOf(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new TypeError('sessionId must be a non-empty string.'), { status: 400 })
  }
  return value.trim()
}

function summarizeMessage(event) {
  const data = event?.data || {}
  const attachments = []
  const texts = []
  for (const block of data.content || []) {
    if (block.type === 'text') texts.push(block.text)
    if (block.type === 'image' || block.type === 'file') {
      attachments.push({ kind: block.type, attachment: block.attachment })
    }
  }
  return {
    ok: true,
    messageId: data.id,
    seq: event.seq,
    text: texts.join('\n'),
    attachments,
  }
}

async function handleRoute(ctx, request, response) {
  const url = new URL(request.url || ROUTE, 'http://message-tree.local')
  const pathname = url.pathname.replace(/\/+$/, '')

  try {
    if (request.method === 'GET' && (pathname === ROUTE || pathname === `${ROUTE}/state`)) {
      respondJson(response, 200, publicState())
      return
    }

    if (request.method === 'GET' && pathname === `${ROUTE}/message`) {
      const sessionId = sessionIdOf(url.searchParams.get('sessionId'))
      const messageId = url.searchParams.get('messageId')
      if (!messageId) throw Object.assign(new TypeError('messageId is required.'), { status: 400 })
      const session = await ensureLiveSession(ctx, sessionId)
      const event = findUserMessage(session, messageId)
      respondJson(response, 200, summarizeMessage(event))
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/stop`) {
      const body = (await readJson(request)) || {}
      const sessionId = sessionIdOf(body.sessionId)
      await stopAndClear(ctx, sessionId)
      respondJson(response, 200, { ok: true })
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/send`) {
      const body = (await readJson(request)) || {}
      respondJson(response, 200, await handleSend(ctx, body))
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/prepare`) {
      const body = (await readJson(request)) || {}
      respondJson(response, 200, await handlePrepare(ctx, body))
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/attachment`) {
      const body = (await readJson(request)) || {}
      const attachments = Array.isArray(body.attachments) ? body.attachments : []
      const result = []
      for (const item of attachments) {
        if (item.kind === 'image') {
          const stored = await ctx.attachments.readImage(item.attachment)
          result.push({
            kind: 'image',
            mediaType: item.attachment.mediaType,
            name: item.attachment.name,
            bytes: item.attachment.bytes,
            data: Buffer.from(stored.data).toString('base64'),
          })
        } else {
          const chunks = []
          for await (const chunk of ctx.attachments.readFileStream(item.attachment)) {
            chunks.push(Buffer.from(chunk))
          }
          result.push({
            kind: 'file',
            name: item.attachment.name,
            bytes: item.attachment.bytes,
            data: Buffer.concat(chunks).toString('base64'),
          })
        }
      }
      respondJson(response, 200, { ok: true, attachments: result })
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/switch`) {
      const body = (await readJson(request)) || {}
      const sessionId = sessionIdOf(body.sessionId)
      const targetSessionId = sessionIdOf(body.targetSessionId)
      const tree = treeOf(sessionId)
      if (!tree || !tree.sessions[targetSessionId]) {
        throw Object.assign(new Error('Branch not found.'), { status: 404 })
      }
      if (tree.activeSessionId !== targetSessionId) {
        tree.activeSessionId = targetSessionId
        tree.history = [...(tree.history || []), targetSessionId]
        await persist()
      }
      respondJson(response, 200, { ok: true, sessionId: targetSessionId, state: publicState() })
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/undo`) {
      const body = (await readJson(request)) || {}
      const sessionId = sessionIdOf(body.sessionId)
      const tree = treeOf(sessionId)
      if (!tree) throw Object.assign(new Error('Tree not found.'), { status: 404 })
      const history = tree.history || []
      if (history.length < 2) {
        throw Object.assign(new Error('Nothing to undo.'), { status: 400 })
      }
      const current = history[history.length - 1]
      const target = history[history.length - 2]
      tree.history = history.slice(0, -1)
      tree.activeSessionId = target
      await persist()
      respondJson(response, 200, {
        ok: true,
        sessionId: target,
        undoneSessionId: current,
        state: publicState(),
      })
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/rename`) {
      const body = (await readJson(request)) || {}
      const sessionId = sessionIdOf(body.sessionId)
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) throw Object.assign(new TypeError('title is required.'), { status: 400 })
      const tree = treeOf(sessionId)
      if (!tree) {
        await renameSession(ctx, sessionId, title)
      } else {
        tree.title = title
        for (const id of Object.keys(tree.sessions)) await renameSession(ctx, id, title)
        await persist()
      }
      respondJson(response, 200, { ok: true, state: publicState() })
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/archive`) {
      const body = (await readJson(request)) || {}
      const sessionId = sessionIdOf(body.sessionId)
      const tree = treeOf(sessionId)
      const sessionIds = tree ? Object.keys(tree.sessions) : [sessionId]
      for (const id of sessionIds) {
        await stopAndClear(ctx, id)
        try {
          await ctx.workspaceRegistry.archiveSession(id)
        } catch (error) {
          console.error('message-tree: archive failed', error)
        }
      }
      respondJson(response, 200, { ok: true, state: publicState() })
      return
    }

    if (request.method === 'POST' && pathname === `${ROUTE}/delete`) {
      const body = (await readJson(request)) || {}
      const sessionId = sessionIdOf(body.sessionId)
      const tree = treeOf(sessionId)
      const sessionIds = tree ? Object.keys(tree.sessions) : [sessionId]
      for (const id of sessionIds) {
        await stopAndClear(ctx, id)
        try {
          if (typeof ctx.workspaceRegistry.permanentlyDeleteSession === 'function') {
            await ctx.workspaceRegistry.permanentlyDeleteSession(id)
          } else {
            await ctx.workspaceRegistry.archiveSession(id)
          }
        } catch {
          try {
            await ctx.workspaceRegistry.archiveSession(id)
          } catch (error) {
            console.error('message-tree: delete fallback failed', error)
          }
        }
      }
      if (tree) {
        delete state.trees[tree.rootId]
        for (const id of sessionIds) delete state.sessionRoot[id]
        await persist()
      }
      respondJson(response, 200, { ok: true, state: publicState() })
      return
    }

    respondJson(response, 404, { ok: false, error: `Not found: ${url.pathname}` })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    if (status >= 500) console.error('message-tree: request failed', error)
    respondJson(response, status, { ok: false, code: error?.code, error: message })
  }
}

export function apply(ctx) {
  loadState()

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      const tree = treeOf(session.id)
      if (!tree) return
      for (const point of Object.values(tree.points || {})) {
        const version = point.versions?.find((item) => item.sessionId === session.id && !item.messageId)
        if (!version) continue
        version.messageId = event.data.id
        version.seq = event.seq
        persist()
        return
      }
      return
    }
    if (event?.type !== 'session/title') return
    const tree = treeOf(session.id)
    if (!tree) return
    const title = typeof event.data?.title === 'string' ? event.data.title : ''
    if (!title || title === tree.title) return
    tree.title = title
    persist()
    for (const id of Object.keys(tree.sessions)) {
      if (id === session.id) continue
      renameSession(ctx, id, title)
    }
  }), 'message-tree: title and branch sync')

  const webServer = ctx.get('webServer') || ctx.webServer
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (request, response) => {
        handleRoute(ctx, request, response).catch((error) => {
          console.error('message-tree: route failed', error)
          respondJson(response, 500, { ok: false, error: 'Internal error.' })
        })
      },
    }), 'message-tree: HTTP route')
  }
}
