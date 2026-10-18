/**
 * DSH-消息树界面
 *
 * 功能：侧边栏只显示当前活动分支；在用户消息行注入编辑、回退、翻页、撤销；
 * 回退时把文字和附件放回当前原生输入框；切换分支保持树的侧边栏排序；
 * 提供树级重命名、归档、删除菜单和草稿冲突处理。
 *
 * 修改 DSH：包装 sidebar.workspaces、conversation.composer.bar 和
 * conversation.input.attachments；隐藏非活动分支并改写树会话的排序时间；
 * 在原生消息 meta 行注入操作条；遮蔽原生会话菜单中的重命名和归档项。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-message-tree-client',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const Fragment = React.Fragment

    const TREE_ICONS = {
      edit: [
        'M2.5 13.5L3.2 10.3L10.9 2.6C11.4 2.1 12.2 2.1 12.7 2.6L13.4 3.3C13.9 3.8 13.9 4.6 13.4 5.1L5.7 12.8L2.5 13.5Z',
        'M9.8 3.7L12.3 6.2',
      ],
      rollback: [
        'M6.5 3.5L3 7L6.5 10.5',
        'M3 7H9.5C11.4 7 13 8.6 13 10.5C13 12.4 11.4 14 9.5 14H7',
      ],
      undo: [
        'M3 7C4.5 3.5 8 2 11 3.5C13.5 4.8 14.5 7.8 13.2 10.3C12 12.7 9.2 13.8 6.7 12.8',
        'M3 3.5V7H6.5',
      ],
      left: ['M10 3L5 8L10 13'],
      right: ['M6 3L11 8L6 13'],
      archive: [
        'M2.5 4.5H13.5',
        'M3.5 4.5V12.5C3.5 13.3 4.2 14 5 14H11C11.8 14 12.5 13.3 12.5 12.5V4.5',
        'M6.5 7.5H9.5',
      ],
      trash: [
        'M2.5 4.5H13.5',
        'M6 4.5V3H10V4.5',
        'M4.5 4.5L5.1 13H10.9L11.5 4.5',
        'M6.6 6.8V11',
        'M9.4 6.8V11',
      ],
    }

    function makeIcon(name) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('viewBox', '1.5 1.5 13 13')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke-width', '1')
      svg.setAttribute('aria-hidden', 'true')
      for (const d of TREE_ICONS[name] || []) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        path.setAttribute('stroke', 'currentColor')
        path.setAttribute('stroke-linejoin', 'round')
        svg.appendChild(path)
      }
      return svg
    }

    function MenuItemIcon({ name, danger = false, size = 14 }) {
      return h('span', {
        className: 'message-tree-menu-item-icon',
        'aria-hidden': 'true',
        style: {
          width: size,
          height: size,
          ...(danger ? { color: 'var(--dsw-alias-state-error-primary)' } : {}),
        },
      },
      h('svg', { width: size, height: size, viewBox: '1.5 1.5 13 13', fill: 'none', strokeWidth: 1 },
        (TREE_ICONS[name] || []).map((d, index) => h('path', {
          key: index,
          d,
          stroke: 'currentColor',
          strokeLinejoin: 'round',
        }))))
    }

    const ROUTE = '/message-tree'
    const WRAPPED = Symbol.for('dsh-plugin-message-tree.wrapped')

    let pluginCtx = null
    let currentSessionId = null
    let barLayer = null
    let pendingRollback = null
    const nativeInputActions = new Map()
    const nativeAttachments = new Map()

    const stateStore = {
      state: { trees: [], sessionRoot: {}, hiddenSessionIds: [] },
      version: 0,
    }
    const stateListeners = new Set()

    function setTreeState(next) {
      stateStore.state = next && next.ok ? next : { trees: [], sessionRoot: {}, hiddenSessionIds: [] }
      window.__dshMessageTreeHiddenSessions = new Set(stateStore.state.hiddenSessionIds || [])
      stateStore.version += 1
      for (const listener of stateListeners) listener()
    }

    function useTreeState() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        stateListeners.add(listener)
        return () => {
          stateListeners.delete(listener)
        }
      }, [])
      return stateStore.state
    }

    async function refreshState() {
      try {
        const response = await fetch(`${ROUTE}/state`, { headers: { accept: 'application/json' } })
        const result = await response.json()
        if (!response.ok || result.ok === false) throw new Error(result.error || 'state failed')
        setTreeState(result)
      } catch (error) {
        console.error('message-tree: state refresh failed', error)
      }
    }

    function treeForSession(sessionId) {
      const root = stateStore.state.sessionRoot?.[sessionId]
      return stateStore.state.trees.find((tree) => tree.rootId === root)
    }

    function pointForMessage(messageId) {
      for (const tree of stateStore.state.trees) {
        for (const point of tree.points || []) {
          if ((point.versions || []).some((version) => version.messageId === messageId)) {
            return { tree, point }
          }
        }
      }
      return undefined
    }

    function openSession(sessionId) {
      const uiWorkspace = pluginCtx
        ? (typeof pluginCtx.get === 'function' ? pluginCtx.get('uiWorkspace') : pluginCtx.uiWorkspace)
        : undefined
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        uiWorkspace.openSession(sessionId)
      } else if (pluginCtx?.sessions && typeof pluginCtx.sessions.open === 'function') {
        pluginCtx.sessions.open(sessionId)
      }
    }

    function sessionSnapshot() {
      const service = pluginCtx && pluginCtx.sessions
      const source = service && service.list
      if (!source) return { ids: [], byId: {} }
      if (typeof source.getSnapshot === 'function') return source.getSnapshot()
      return source.snapshot || source
    }

    function treeSessionSortMap(snapshot) {
      const map = {}
      const trees = stateStore.state.trees || []
      if (trees.length === 0) return map
      const byId = snapshot?.byId || {}
      for (const tree of trees) {
        const sessionIds = Array.isArray(tree.sessionIds) ? tree.sessionIds : []
        let max = 0
        for (const id of sessionIds) {
          const value = Number(byId[id]?.updatedAt)
          if (Number.isFinite(value) && value > max) max = value
        }
        if (max <= 0) continue
        for (const id of sessionIds) map[id] = max
      }
      return map
    }

    function effectiveTreeSnapshot(snapshot) {
      if (!snapshot) return snapshot
      const sortMap = treeSessionSortMap(snapshot)
      window.__dshMessageTreeSessionSortAt = sortMap
      const keys = Object.keys(sortMap)
      if (keys.length === 0) return snapshot
      const byId = { ...(snapshot.byId || {}) }
      for (const id of keys) {
        if (!byId[id]) continue
        byId[id] = { ...byId[id], updatedAt: sortMap[id] }
      }
      const ids = [...(Array.isArray(snapshot.ids) ? snapshot.ids : [])].sort((a, b) => {
        const atA = Number(byId[a]?.updatedAt) || 0
        const atB = Number(byId[b]?.updatedAt) || 0
        return atB - atA
      })
      return { ...snapshot, ids, byId }
    }

    function filterSessions(snapshot, hidden, version) {
      if (!snapshot) return snapshot
      if (filterSessions.cache?.source === snapshot && filterSessions.cache.version === version) {
        return filterSessions.cache.value
      }
      const effective = effectiveTreeSnapshot(snapshot)
      const ids = Array.isArray(effective.ids) ? effective.ids : []
      const nextIds = ids.filter((id) => !hidden.has(id))
      let value = effective
      if (nextIds.length !== ids.length) {
        const byId = { ...(effective.byId || {}) }
        for (const id of hidden) delete byId[id]
        value = { ...effective, ids: nextIds, byId }
      }
      filterSessions.cache = { source: snapshot, version, value }
      return value
    }

    function filterWorkspaces(snapshot, hidden, version) {
      if (!snapshot) return snapshot
      if (filterWorkspaces.cache?.source === snapshot && filterWorkspaces.cache.version === version) {
        return filterWorkspaces.cache.value
      }
      const sessions = sessionSnapshot()
      const sortMap = treeSessionSortMap(sessions)
      const atOf = (id) => sortMap[id] || Number(sessions?.byId?.[id]?.updatedAt) || 0
      const items = Array.isArray(snapshot.items) ? snapshot.items : []
      let changed = false
      const nextItems = items.map((workspace) => {
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        const nextSessionIds = sessionIds
          .filter((id) => !hidden.has(id))
          .sort((a, b) => atOf(b) - atOf(a))
        if (nextSessionIds.length === sessionIds.length && nextSessionIds.every((id, index) => id === sessionIds[index])) {
          return workspace
        }
        changed = true
        return { ...workspace, sessionIds: nextSessionIds }
      })
      const value = changed ? { ...snapshot, items: nextItems } : snapshot
      filterWorkspaces.cache = { source: snapshot, version, value }
      return value
    }

    function patchNativeEntry(ctx, slotName, patch) {
      const restorers = new Map()
      function reconcile() {
        const entries = typeof ctx.slots.entries === 'function' ? (ctx.slots.entries(slotName) || []) : []
        for (const entry of entries) {
          if ((entry.options?.priority ?? 0) !== 0 || restorers.has(entry)) continue
          restorers.set(entry, patch(entry))
        }
      }
      reconcile()
      const unsubscribe = typeof ctx.slots.subscribe === 'function'
        ? ctx.slots.subscribe(slotName, reconcile)
        : undefined
      return () => {
        if (typeof unsubscribe === 'function') unsubscribe()
        for (const restore of restorers.values()) restore()
        restorers.clear()
      }
    }

    function wrapSidebarEntry(entry) {
      if (!entry || entry[WRAPPED]) return () => {}
      const NativeSidebar = entry.component
      function MessageTreeSidebar(props) {
        const state = useTreeState()
        if (typeof props.useSessions !== 'function' || typeof props.useWorkspaces !== 'function') {
          return h(NativeSidebar, props)
        }
        const hidden = new Set(state.hiddenSessionIds || [])
        const version = stateStore.version
        function useSessions(selector, equality) {
          return props.useSessions((snapshot) => selector(filterSessions(snapshot, hidden, version)), equality)
        }
        function useWorkspaces(selector, equality) {
          return props.useWorkspaces((snapshot) => selector(filterWorkspaces(snapshot, hidden, version)), equality)
        }
        return h(NativeSidebar, { ...props, useSessions, useWorkspaces })
      }
      MessageTreeSidebar.displayName = 'MessageTreeSidebar(' + (NativeSidebar.displayName || NativeSidebar.name || 'Native') + ')'
      entry.component = MessageTreeSidebar
      entry[WRAPPED] = { kind: 'sidebar', original: NativeSidebar }
      return () => {
        if (entry.component === MessageTreeSidebar) entry.component = NativeSidebar
        delete entry[WRAPPED]
      }
    }

    function wrapComposerEntry(entry) {
      if (!entry || entry[WRAPPED]) return () => {}
      const NativeComposer = entry.component
      function MessageTreeComposer(props) {
        React.useEffect(() => {
          if (!props.sessionId) return undefined
          currentSessionId = props.sessionId
          if (props.inputActions) nativeInputActions.set(props.sessionId, props.inputActions)
          refreshState()
          return undefined
        }, [props.sessionId, props.inputActions])
        return h(NativeComposer, props)
      }
      MessageTreeComposer.displayName = 'MessageTreeComposer(' + (NativeComposer.displayName || NativeComposer.name || 'Native') + ')'
      entry.component = MessageTreeComposer
      entry[WRAPPED] = { kind: 'composer', original: NativeComposer }
      return () => {
        if (entry.component === MessageTreeComposer) entry.component = NativeComposer
        delete entry[WRAPPED]
      }
    }

    function wrapAttachmentsEntry(entry) {
      if (!entry || entry[WRAPPED]) return () => {}
      const NativeAttachments = entry.component
      function MessageTreeAttachments(props) {
        if (props.sessionId) nativeAttachments.set(props.sessionId, props.attachments || [])
        return h(NativeAttachments, props)
      }
      MessageTreeAttachments.displayName = 'MessageTreeAttachments(' + (NativeAttachments.displayName || NativeAttachments.name || 'Native') + ')'
      entry.component = MessageTreeAttachments
      entry[WRAPPED] = { kind: 'attachments', original: NativeAttachments }
      return () => {
        if (entry.component === MessageTreeAttachments) entry.component = NativeAttachments
        delete entry[WRAPPED]
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          resolve(result.slice(result.indexOf(',') + 1))
        }
        reader.onerror = () => reject(reader.error || new Error('read failed'))
        reader.readAsDataURL(file)
      })
    }

    async function rollbackAttachmentPayload(sessionId, pending) {
      const result = []
      const seen = new Set()
      const native = nativeAttachments.get(sessionId) || []
      for (const item of native) {
        const file = item?.file
        if (file instanceof File) {
          const key = `file:${file.name}:${file.size}:${file.lastModified}`
          if (seen.has(key)) continue
          seen.add(key)
          result.push({
            kind: file.type.startsWith('image/') ? 'image' : 'file',
            name: file.name,
            mediaType: file.type || 'application/octet-stream',
            data: await fileToBase64(file),
          })
          continue
        }
        const attachment = item?.attachment || item?.ref
        if (!attachment?.attachmentId || seen.has(attachment.attachmentId)) continue
        seen.add(attachment.attachmentId)
        result.push({ kind: item.kind === 'image' ? 'image' : 'file', attachment })
      }

      if (pending && !pending.nativeAttachmentMode) {
        for (const item of pending.attachments || []) {
          const ref = item?.attachment
          if (!ref?.attachmentId) continue
          if (result.some((entry) => entry.name === ref.name || entry.attachment?.attachmentId === ref.attachmentId)) continue
          const response = await fetch(`${ROUTE}/attachment`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, attachments: [{ kind: item.kind, attachment: ref }] }),
          })
          const payload = await response.json()
          const stored = payload?.attachments?.[0]
          if (!stored) continue
          result.push({
            kind: item.kind === 'image' ? 'image' : 'file',
            name: ref.name,
            mediaType: stored.mediaType || ref.mediaType || 'application/octet-stream',
            data: stored.data,
          })
        }
      }
      return result
    }

    async function switchVersion(point, messageId, direction) {
      const versions = point.versions || []
      const currentIndex = versions.findIndex((version) => version.messageId === messageId)
      const fallback = versions.findIndex((version) => version.sessionId === currentSessionId)
      const index = currentIndex >= 0 ? currentIndex : fallback
      if (index < 0) return
      const next = index + direction
      if (next < 0 || next >= versions.length) return
      const target = versions[next]
      try {
        const response = await fetch(`${ROUTE}/switch`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId, targetSessionId: target.sessionId }),
        })
        const result = await response.json()
        if (!response.ok || result.ok === false) throw new Error(result.error || 'switch failed')
        setTreeState(result.state)
        openSession(target.sessionId)
      } catch (error) {
        console.error('message-tree: branch switch failed', error)
      }
    }

    async function undoTree(tree) {
      try {
        const response = await fetch(`${ROUTE}/undo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId }),
        })
        const result = await response.json()
        if (!response.ok || result.ok === false) throw new Error(result.error || 'undo failed')
        setTreeState(result.state)
        openSession(result.sessionId)
      } catch (error) {
        console.error('message-tree: undo failed', error)
      }
    }

    const draftStore = { open: false, messageId: null, mode: 'edit', draft: '' }
    const draftListeners = new Set()

    function setDraft(patch) {
      Object.assign(draftStore, patch)
      for (const listener of draftListeners) listener()
    }

    function useDraft() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        draftListeners.add(listener)
        return () => {
          draftListeners.delete(listener)
        }
      }, [])
      return draftStore
    }

    const actionDialogStore = {
      open: false,
      kind: 'rename',
      sessionId: null,
      displayTitle: '',
      value: '',
      busy: false,
      error: '',
    }
    const actionDialogListeners = new Set()

    function setActionDialog(patch) {
      Object.assign(actionDialogStore, patch)
      for (const listener of actionDialogListeners) listener()
    }

    function useActionDialog() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((value) => value + 1)
        actionDialogListeners.add(listener)
        return () => {
          actionDialogListeners.delete(listener)
        }
      }, [])
      return actionDialogStore
    }

    function openActionDialog(kind, sessionId, displayTitle) {
      setActionDialog({
        open: true,
        kind,
        sessionId,
        displayTitle: displayTitle || '',
        value: displayTitle || '',
        busy: false,
        error: '',
      })
    }

    function closeActionDialog() {
      setActionDialog({ open: false, busy: false, error: '' })
    }

    function openErrorDialog(message) {
      setActionDialog({
        open: true,
        kind: 'error',
        sessionId: null,
        displayTitle: '',
        value: String(message || '操作失败'),
        busy: false,
        error: '',
      })
    }

    function nativeDraftText() {
      const editors = [...document.querySelectorAll('[contenteditable="true"]')]
      const composer = editors.find((element) => !element.closest('[role="dialog"]') && !element.closest('[data-message-tree-bar]'))
      return composer ? String(composer.innerText || '').trim() : ''
    }

    function requestEdit(messageId, mode) {
      const draft = nativeDraftText()
      if (draft) {
        setDraft({ open: true, messageId, mode, draft })
        return
      }
      startRollback(messageId, mode)
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    async function pasteCurrentComposer(sessionId, text) {
      const editor = await waitForNativeComposer(sessionId)
      if (!editor) return false
      editor.focus()
      if (String(editor.innerText || '').trim()) {
        document.execCommand('selectAll')
        document.execCommand('delete')
      }
      const transfer = new DataTransfer()
      transfer.setData('text/plain', text)
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
      return true
    }

    async function startRollback(messageId, mode, appendText = '') {
      const sessionId = currentSessionId
      if (!sessionId) return
      try {
        await fetch(`${ROUTE}/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        await sleep(150)
        const response = await fetch(`${ROUTE}/message?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`)
        const result = await response.json()
        if (!response.ok || result.ok === false) throw new Error(result.error || 'load failed')
        const text = [result.text || '', appendText || ''].filter((part) => part && part.trim()).join('\n')
        pendingRollback = {
          sessionId,
          messageId,
          title: document.title.replace(' — DeepSeek Harness', ''),
          text,
          attachments: result.attachments || [],
          busy: false,
        }
        const actions = nativeInputActions.get(sessionId)
        if (actions && typeof actions.setDraft === 'function') {
          actions.setDraft(text)
        } else {
          await pasteCurrentComposer(sessionId, text)
        }
        if (actions && typeof actions.addAttachments === 'function' && pendingRollback.attachments.length > 0) {
          const ids = pendingRollback.attachments
            .map((item) => item.attachment?.attachmentId)
            .filter(Boolean)
          if (ids.length > 0) {
            try {
              actions.addAttachments(ids)
            } catch (error) {
              console.warn('message-tree: restoring attachments failed', error)
            }
          }
          await sleep(200)
          const restored = nativeAttachments.get(sessionId) || []
          pendingRollback.nativeAttachmentMode = pendingRollback.attachments.some((item) =>
            restored.some((entry) => (entry?.file?.name || entry?.attachment?.name) === item.attachment?.name))
        }
        setTimeout(() => {
          const editor = [...document.querySelectorAll('[contenteditable="true"]')]
            .find((element) => !element.closest('[role="dialog"]'))
          editor?.focus()
        }, 120)
      } catch (error) {
        pendingRollback = null
        openErrorDialog(error instanceof Error ? error.message : String(error))
      }
    }

    async function handleRollbackSend() {
      const pending = pendingRollback
      if (!pending || pending.busy || pending.sessionId !== currentSessionId) return
      pending.busy = true
      let prepared
      try {
        const editor = [...document.querySelectorAll('[contenteditable="true"]')]
          .find((element) => !element.closest('[role="dialog"]'))
        const text = String(editor?.innerText || pending.text || '').trim()
        const attachments = await rollbackAttachmentPayload(pending.sessionId, pending)
        if (!text && attachments.length === 0) {
          throw new Error('The edited message is empty.')
        }
        prepared = await postJson('/prepare', {
          sessionId: pending.sessionId,
          messageId: pending.messageId,
          title: pending.title,
        })
        const sent = await postJson('/send', {
          sessionId: prepared.childSessionId,
          text,
          attachments,
        })
        setTreeState(sent.state)
        try {
          nativeInputActions.get(pending.sessionId)?.setDraft?.('')
        } catch {
          // The parent draft is hidden after the switch.
        }
        pendingRollback = null
        openSession(prepared.childSessionId)
      } catch (error) {
        if (prepared?.childSessionId) {
          try {
            const undone = await postJson('/undo', { sessionId: prepared.childSessionId })
            if (undone.sessionId) openSession(undone.sessionId)
          } catch {
            // The branch remains available from the sidebar.
          }
        }
        if (pendingRollback) pendingRollback.busy = false
        openErrorDialog(error instanceof Error ? error.message : String(error))
      }
    }

    async function waitForNativeComposer(sessionId) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (currentSessionId && currentSessionId !== sessionId) {
          await sleep(100)
          continue
        }
        const editor = [...document.querySelectorAll('[contenteditable="true"]')]
          .find((element) => !element.closest('[role="dialog"]') && !element.closest('[data-message-tree-bar]'))
        if (editor) return editor
        await sleep(100)
      }
      return undefined
    }

    function DialogFrame({ label, onClose, children }) {
      return h('div', {
        style: draftBackdropStyle,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && onClose) onClose()
        },
      },
      h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': label,
        style: draftPanelStyle,
        onMouseDown: (event) => event.stopPropagation(),
      }, children))
    }

    function DraftDialog() {
      const state = useDraft()
      if (!state.open) return null
      const close = () => setDraft({ open: false })
      const choose = (kind) => {
        const { messageId, mode, draft } = state
        close()
        if (kind === 'replace') startRollback(messageId, mode)
        if (kind === 'append') startRollback(messageId, mode, draft)
      }
      return h(DialogFrame, { label: '输入框已有草稿', onClose: close },
        h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: '22px' } }, '输入框里已有草稿'),
        h('div', { style: draftHintStyle }, '回退/编辑会把消息放回原生输入框。现有草稿要怎么处理？'),
        h('div', { style: draftPreviewStyle }, state.draft.slice(0, 300)),
        h('div', { style: draftActionsStyle },
          h('button', { type: 'button', onClick: () => choose('cancel'), style: dialogSecondaryStyle }, '取消'),
          h('button', { type: 'button', onClick: () => choose('append'), style: dialogSecondaryStyle }, '追加到消息后'),
          h('button', { type: 'button', onClick: () => choose('replace'), style: dialogPrimaryStyle }, '替换草稿')))
    }

    function TreeActionDialog() {
      const state = useActionDialog()
      const inputRef = React.useRef(null)
      React.useEffect(() => {
        if (!state.open || state.kind !== 'rename') return
        const timer = setTimeout(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        }, 30)
        return () => clearTimeout(timer)
      }, [state.open, state.kind])
      if (!state.open) return null
      const isError = state.kind === 'error'
      const title = isError
        ? '操作失败'
        : state.kind === 'rename'
          ? '重命名对话'
          : state.kind === 'archive'
            ? '归档对话'
            : '删除对话'
      const body = isError
        ? state.value
        : state.kind === 'archive'
          ? '归档后可以从回收站恢复。'
          : '删除后将从侧边栏移除；仍在运行的对话会先停止。'
      const submit = async () => {
        if (state.busy) return
        if (isError) {
          closeActionDialog()
          return
        }
        if (state.kind === 'rename' && !state.value.trim()) return
        setActionDialog({ busy: true, error: '' })
        try {
          if (state.kind === 'rename') {
            await postJson('/rename', { sessionId: state.sessionId, title: state.value.trim() })
          } else if (state.kind === 'archive') {
            await postJson('/archive', { sessionId: state.sessionId })
          } else {
            await postJson('/delete', { sessionId: state.sessionId })
          }
          closeActionDialog()
        } catch (error) {
          setActionDialog({ busy: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return h(DialogFrame, {
        label: title,
        onClose: state.busy ? undefined : closeActionDialog,
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, lineHeight: '22px' } },
        state.kind === 'delete' ? h(MenuItemIcon, { name: 'trash', danger: true, size: 16 }) : null,
        h('span', null, title)),
      state.kind === 'rename'
        ? h('input', {
          ref: inputRef,
          value: state.value,
          onChange: (event) => setActionDialog({ value: event.target.value, error: '' }),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit()
          },
          placeholder: '输入会话标题',
          style: actionInputStyle,
        })
        : h('div', { style: draftHintStyle }, body),
      state.error ? h('div', { style: dialogErrorStyle }, state.error) : null,
      h('div', { style: draftActionsStyle },
        isError
          ? h('button', { type: 'button', onClick: closeActionDialog, style: dialogPrimaryStyle }, '知道了')
          : h(Fragment, null,
            h('button', { type: 'button', onClick: closeActionDialog, disabled: state.busy, style: dialogSecondaryStyle }, '取消'),
            h('button', {
              type: 'button',
              onClick: submit,
              disabled: state.busy || (state.kind === 'rename' && !state.value.trim()),
              style: state.kind === 'delete' ? actionDangerStyle : dialogPrimaryStyle,
            }, state.busy ? '处理中…' : state.kind === 'rename' ? '保存' : state.kind === 'archive' ? '归档' : '删除'))))
    }

    const draftBackdropStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 1100,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.5))',
    }
    const draftPanelStyle = {
      width: 'min(480px, 100%)',
      padding: 16,
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: 'var(--dsw-elevation-panel, 0 18px 60px rgba(0, 0, 0, 0.35))',
      fontSize: 13,
      lineHeight: '20px',
    }
    const draftHintStyle = { marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }
    const draftPreviewStyle = {
      marginTop: 10,
      maxHeight: 120,
      overflow: 'auto',
      padding: 10,
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-base)',
      fontSize: 12,
      whiteSpace: 'pre-wrap',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const draftActionsStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }
    const actionInputStyle = {
      width: '100%',
      height: 34,
      boxSizing: 'border-box',
      marginTop: 12,
      padding: '0 10px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 8,
      background: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-base))',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      outline: 'none',
    }
    const actionDangerStyle = {
      padding: '0 12px',
      height: 32,
      borderRadius: 8,
      border: 'none',
      background: 'var(--dsw-alias-state-error-primary)',
      color: '#fff',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
    }

    const dialogErrorStyle = { marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }
    const dialogSecondaryStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      height: 32,
      boxSizing: 'border-box',
      padding: '0 12px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
    }
    const dialogPrimaryStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      height: 32,
      boxSizing: 'border-box',
      padding: '0 12px',
      borderRadius: 8,
      border: 'none',
      background: 'var(--dsw-alias-button-primary-fill)',
      color: 'var(--dsw-alias-label-primary-foreground)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
    }

    const BAR_CSS = `
[data-chat-flow-kind="user"] [data-message-tree-bar] {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
[data-message-tree-bar] button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 29px;
  height: 29px;
  padding: 6px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  cursor: pointer;
}
[data-message-tree-bar] button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
[data-message-tree-bar] button:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: -2px;
}
[data-message-tree-bar] svg {
  display: block;
}
[data-message-tree-bar] [data-message-tree-arrows] {
  display: inline-flex;
  align-items: center;
  gap: 0;
  color: var(--dsw-alias-label-tertiary);
}
[data-message-tree-bar] [data-message-tree-arrows] span {
  padding: 0 2px;
  font-size: 12px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}
.message-tree-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 34px;
  box-sizing: border-box;
  padding: 6px 8px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.message-tree-menu-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.message-tree-menu-item:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: -2px;
}
.message-tree-menu-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--dsw-alias-menu-icon, currentColor);
}
.message-tree-menu-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-tree-menu-item-danger {
  color: var(--dsw-alias-state-error-primary);
}
.message-tree-menu-item-danger .message-tree-menu-item-icon {
  color: var(--dsw-alias-state-error-primary);
}
.ppByMG_actions .ppByMG_action svg {
  width: 14px !important;
  height: 14px !important;
}

.dsh-trash-row-btn:not(.dsh-trash-row-btn--spacer) {
  display: none !important;
}
`
    function parseMessageId(element) {
      const key = element.getAttribute('data-chat-node-key') || ''
      const marker = 'input-message'
      const index = key.indexOf(marker)
      if (index < 0) return null
      return key.slice(index + marker.length) || null
    }

    function setIconButton(button, name, label) {
      button.textContent = ''
      button.setAttribute('aria-label', label)
      button.setAttribute('title', label)
      button.appendChild(makeIcon(name))
    }

    function updateBar(bar, messageId) {
      const pointInfo = pointForMessage(messageId)
      const { tree, point } = pointInfo || {}
      const versions = point?.versions || []
      const currentIndex = versions.findIndex((version) => version.messageId === messageId)
      const signature = pointInfo
        ? `${point.id}:${versions.length}:${currentIndex}:${(tree.history || []).length}`
        : `none:${messageId}`
      if (bar.getAttribute('data-message-tree-signature') === signature) return
      bar.setAttribute('data-message-tree-signature', signature)
      bar.textContent = ''
      const edit = document.createElement('button')
      edit.type = 'button'
      setIconButton(edit, 'edit', '编辑消息')
      edit.addEventListener('click', (event) => {
        event.stopPropagation()
        requestEdit(messageId, 'edit')
      })
      bar.appendChild(edit)

      const rollback = document.createElement('button')
      rollback.type = 'button'
      setIconButton(rollback, 'rollback', '回退到这条消息')
      rollback.addEventListener('click', (event) => {
        event.stopPropagation()
        requestEdit(messageId, 'rollback')
      })
      bar.appendChild(rollback)

      if (!pointInfo) return

      if ((tree.history || []).length > 1) {
        const undo = document.createElement('button')
        undo.type = 'button'
        setIconButton(undo, 'undo', '撤销上次分支切换')
        undo.addEventListener('click', (event) => {
          event.stopPropagation()
          undoTree(tree)
        })
        bar.appendChild(undo)
      }

      if (versions.length > 1) {
        const arrows = document.createElement('span')
        arrows.setAttribute('data-message-tree-arrows', '')
        const left = document.createElement('button')
        left.type = 'button'
        setIconButton(left, 'left', '上一个分支')
        left.addEventListener('click', (event) => {
          event.stopPropagation()
          switchVersion(point, messageId, -1)
        })
        const label = document.createElement('span')
        label.textContent = `${currentIndex >= 0 ? currentIndex + 1 : 1}/${versions.length}`
        const right = document.createElement('button')
        right.type = 'button'
        setIconButton(right, 'right', '下一个分支')
        right.addEventListener('click', (event) => {
          event.stopPropagation()
          switchVersion(point, messageId, 1)
        })
        arrows.appendChild(left)
        arrows.appendChild(label)
        arrows.appendChild(right)
        bar.appendChild(arrows)
      }
    }

    function scanBars() {
      for (const element of document.querySelectorAll('[data-chat-flow-kind="user"]')) {
        const messageId = parseMessageId(element)
        if (!messageId) continue
        let bar = element.querySelector('[data-message-tree-bar]')
        if (!bar) {
          bar = document.createElement('div')
          bar.setAttribute('data-message-tree-bar', '')
        }
        const copy = element.querySelector('button[aria-label="复制"]')
        const meta = copy?.parentElement
        if (meta) {
          if (bar.parentElement !== meta || meta.lastElementChild !== bar) meta.appendChild(bar)
        } else if (bar.parentElement !== element) {
          element.appendChild(bar)
        }
        updateBar(bar, messageId)
      }
    }

    function installBars(ctx) {
      if (!barLayer) {
        barLayer = document.createElement('style')
        barLayer.setAttribute('data-message-tree-style', '')
        barLayer.textContent = BAR_CSS
        document.head.appendChild(barLayer)
      }
      let scheduled = false
      function schedule() {
        if (scheduled) return
        scheduled = true
        setTimeout(() => {
          scheduled = false
          scanBars()
        }, 60)
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      const interval = setInterval(schedule, 500)
      const refreshTimer = setInterval(refreshState, 3000)
      schedule()
      const unsubscribe = () => {
        observer.disconnect()
        clearInterval(interval)
        clearInterval(refreshTimer)
      }
      ctx.effect(() => () => {
        unsubscribe()
        if (barLayer) {
          barLayer.remove()
          barLayer = null
        }
        for (const bar of document.querySelectorAll('[data-message-tree-bar]')) bar.remove()
      }, 'message-tree: bar layer')
      stateListeners.add(schedule)
    }

    function HiddenNativeMenuItem() {
      return null
    }

    function renderMenuItem(icon, label, onClick, danger = false) {
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: `message-tree-menu-item${danger ? ' message-tree-menu-item-danger' : ''}`,
        onClick,
      },
      h(MenuItemIcon, { name: icon }),
      h('span', { className: 'message-tree-menu-item-label' }, label))
    }

    async function postJson(path, body) {
      const response = await fetch(`${ROUTE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok || result.ok === false) throw new Error(result.error || 'request failed')
      if (result.state) setTreeState(result.state)
      return result
    }

    function useCloseMenu(props) {
      try {
        if (typeof props.useMenuOpenState === 'function') {
          const [, setMenuOpen] = props.useMenuOpenState()
          if (typeof setMenuOpen === 'function') return () => setMenuOpen(false)
        }
      } catch {
        // A missing menu hook only leaves the menu open.
      }
      return () => {}
    }

    function TreeRenameItem(props) {
      const close = useCloseMenu(props)
      const onClick = () => {
        close()
        openActionDialog('rename', props.sessionId, props.displayTitle || '')
      }
      return renderMenuItem('edit', '重命名对话', onClick)
    }

    function TreeArchiveItem(props) {
      const close = useCloseMenu(props)
      const onClick = () => {
        close()
        openActionDialog('archive', props.sessionId, props.displayTitle || '')
      }
      return renderMenuItem('archive', '归档对话', onClick)
    }

    function TreeDeleteItem(props) {
      const close = useCloseMenu(props)
      const onClick = () => {
        close()
        openActionDialog('delete', props.sessionId, props.displayTitle || '')
      }
      return renderMenuItem('trash', '删除对话', onClick, true)
    }

    function captureRollbackClick(event) {
      if (!pendingRollback || pendingRollback.busy || pendingRollback.sessionId !== currentSessionId) return
      const target = event.target
      const button = target && target.closest ? target.closest('button[aria-label="发送消息"]') : null
      if (!button) return
      event.preventDefault()
      event.stopImmediatePropagation()
      handleRollbackSend()
    }

    function captureRollbackKey(event) {
      if (!pendingRollback || pendingRollback.busy || pendingRollback.sessionId !== currentSessionId) return
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      const target = event.target
      if (!target || !target.closest) return
      if (!target.closest('[contenteditable="true"]') || target.closest('[role="dialog"]')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      handleRollbackSend()
    }

    function apply(ctx) {
      pluginCtx = ctx
      refreshState()
      ctx.slots.inject('sidebar.workspaces', () => patchNativeEntry(ctx, 'sidebar.workspaces', wrapSidebarEntry))
      ctx.slots.inject('conversation.composer.bar', () => patchNativeEntry(ctx, 'conversation.composer.bar', wrapComposerEntry))
      ctx.slots.inject('conversation.input.attachments', () => patchNativeEntry(ctx, 'conversation.input.attachments', wrapAttachmentsEntry))
      window.addEventListener('click', captureRollbackClick, true)
      window.addEventListener('keydown', captureRollbackKey, true)
      ctx.effect(() => () => {
        window.removeEventListener('click', captureRollbackClick, true)
        window.removeEventListener('keydown', captureRollbackKey, true)
      }, 'message-tree: rollback DOM capture')
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'rename',
        order: 200,
        priority: -1,
      }, HiddenNativeMenuItem))
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'archive',
        order: 400,
        priority: -1,
      }, HiddenNativeMenuItem))
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'message-tree.rename',
        order: 900,
      }, TreeRenameItem))
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'message-tree.archive',
        order: 910,
      }, TreeArchiveItem))
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'message-tree.delete',
        order: 920,
      }, TreeDeleteItem))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'message-tree.draft-dialog',
        order: 20,
      }, DraftDialog))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'message-tree.action-dialog',
        order: 22,
      }, TreeActionDialog))
      installBars(ctx)
      return () => {
        pluginCtx = null
        currentSessionId = null
      }
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiConversation'],
      apply,
    }
  },
})
