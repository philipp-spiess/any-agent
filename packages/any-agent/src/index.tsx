import type { ReadStream as TtyReadStream } from 'node:tty'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { render } from 'ink'
import {
  getSessions as getCodexSessions,
  orderSessionsByBranch,
  type SessionSummary,
  type SessionsWithTotals,
} from './codex'
import { getClaudeSessions } from './claudecode'
import { resumeSession } from './resume'
import SessionPicker from './ui/SessionPicker'

const TTY_DEBUG = process.env.ANY_AGENT_DEBUG_TTY === '1'

export { getCodexSessions as getSessions, getClaudeSessions }

export type SessionSourceFilter = 'all' | 'codex' | 'claudecode'

const EMPTY_RESULT = (): SessionsWithTotals => ({
  sessions: [],
  totalBlendedTokens: 0,
  totalCostUsd: 0,
})

const safeLoad = async (
  loader: () => Promise<SessionsWithTotals>,
): Promise<SessionsWithTotals> => {
  try {
    return await loader()
  } catch {
    return EMPTY_RESULT()
  }
}

export async function getAllSessions(
  filter: SessionSourceFilter = 'all',
): Promise<SessionsWithTotals> {
  if (filter === 'codex') {
    return safeLoad(() => getCodexSessions())
  }

  if (filter === 'claudecode') {
    return safeLoad(() => getClaudeSessions())
  }

  const [codex, claude] = await Promise.all([
    safeLoad(() => getCodexSessions()),
    safeLoad(() => getClaudeSessions()),
  ])

  const mergedSessions = [...codex.sessions, ...claude.sessions]
  const sessions = orderSessionsByBranch(mergedSessions)
  const totalBlendedTokens = codex.totalBlendedTokens + claude.totalBlendedTokens
  const totalCostUsd = codex.totalCostUsd + claude.totalCostUsd

  return { sessions, totalBlendedTokens, totalCostUsd }
}

type ParsedCliOptions = {
  filter: SessionSourceFilter
  yoloMode: boolean
}

const parseCliOptions = (argv: string[]): ParsedCliOptions => {
  let filter: SessionSourceFilter = 'all'
  let yoloMode = false

  for (const arg of argv) {
    if (arg === '--yolo') {
      yoloMode = true
      continue
    }

    if (!arg || filter !== 'all') {
      continue
    }

    const normalized = arg.toLowerCase()
    if (normalized === 'codex' || normalized === 'claudecode') {
      filter = normalized
    }
  }

  return { filter, yoloMode }
}

const resolveSessionWorkingDirectory = (
  session: SessionSummary,
): string | undefined => {
  const meta = session.meta ?? undefined
  const cwdValue = sanitizeWorkingDirectory(
    meta && typeof meta.cwd === 'string' ? meta.cwd : undefined,
  )
  if (cwdValue) {
    return cwdValue
  }

  const metaRecord = meta as Record<string, unknown> | undefined
  const projectPathValue = sanitizeWorkingDirectory(
    metaRecord && typeof metaRecord.projectPath === 'string'
      ? (metaRecord.projectPath as string)
      : undefined,
  )
  if (projectPathValue) {
    return projectPathValue
  }

  return undefined
}

const sanitizeWorkingDirectory = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const clearScreen = () => {
  if (!process.stdout.isTTY) {
    return
  }
  const ESC = '\u001b'
  process.stdout.write(`${ESC}[2J${ESC}[3J${ESC}[H`)
}

const getTtyInput = (): (NodeJS.ReadStream & TtyReadStream) | null => {
  const stdin = process.stdin as NodeJS.ReadStream & Partial<TtyReadStream>
  if (!stdin.isTTY) {
    return null
  }
  return stdin as NodeJS.ReadStream & TtyReadStream
}

const captureRawMode = (): boolean | undefined => {
  const ttyInput = getTtyInput()
  return ttyInput?.isRaw
}

const restoreRawMode = (initialRawMode: boolean | undefined) => {
  const ttyInput = getTtyInput()
  if (!ttyInput || typeof ttyInput.setRawMode !== 'function') {
    return
  }

  const desired = initialRawMode ?? false
  if (ttyInput.isRaw === desired) {
    return
  }

  try {
    ttyInput.setRawMode(desired)
  } catch {
    // ignore failures when toggling raw mode
  }
}

const detachTtyListeners = () => {
  const ttyInput = getTtyInput()
  if (!ttyInput) {
    return
  }
  const eventNames = ['data', 'readable', 'keypress'] as const
  for (const event of eventNames) {
    ttyInput.removeAllListeners(event)
  }
}

const pauseTtyInput = () => {
  const ttyInput = getTtyInput()
  if (!ttyInput) {
    return
  }
  try {
    ttyInput.pause()
  } catch {
    // ignore pause failures
  }
}

type CapturedEncoding = BufferEncoding | 'buffer' | undefined

const captureEncoding = (): CapturedEncoding => {
  const ttyInput = getTtyInput() as (NodeJS.ReadStream & TtyReadStream & { readableEncoding?: BufferEncoding | null }) | null
  if (!ttyInput) {
    return undefined
  }
  const encoding = ttyInput.readableEncoding ?? (ttyInput as unknown as { _readableState?: { encoding: BufferEncoding | null } })._readableState?.encoding ?? null
  return encoding ?? 'buffer'
}

const restoreEncoding = (encoding: CapturedEncoding) => {
  const ttyInput = getTtyInput()
  if (!ttyInput) {
    return
  }
  try {
    if (!encoding || encoding === 'buffer') {
      ttyInput.setEncoding(undefined)
    } else {
      ttyInput.setEncoding(encoding)
    }
  } catch {
    // ignore encoding restoration failures
  }
}

const debugTtyState = (stage: string) => {
  if (!TTY_DEBUG) {
    return
  }
  const ttyInput = getTtyInput()
  const state = {
    stage,
    stdoutIsTTY: process.stdout.isTTY,
    stdinIsTTY: Boolean(ttyInput),
    stdinIsRaw: ttyInput?.isRaw ?? null,
    stdinIsPaused: ttyInput ? ttyInput.isPaused() : null,
    listenerCounts: ttyInput
      ? {
          data: ttyInput.listeners('data').length,
          readable: ttyInput.listeners('readable').length,
          keypress: ttyInput.listeners('keypress').length,
        }
      : null,
  }
  try {
    process.stderr.write(`[any-agent tty] ${JSON.stringify(state)}\n`)
  } catch {
    // Swallow logging failures
  }
}

export async function main() {
  try {
    const { filter: sourceFilter, yoloMode } = parseCliOptions(process.argv.slice(2))
    const { sessions, totalBlendedTokens, totalCostUsd } =
      await getAllSessions(sourceFilter)
    let selectedSession: SessionSummary | undefined

    const initialRawMode = captureRawMode()
    const initialEncoding = captureEncoding()
    debugTtyState('before-render')

    const { waitUntilExit } = render(
      <SessionPicker
        sessions={sessions}
        totalTokens={totalBlendedTokens}
        totalCost={totalCostUsd}
        onResume={session => {
          selectedSession = session
        }}
      />
    )

    await waitUntilExit()
    restoreRawMode(initialRawMode)
    restoreEncoding(initialEncoding)
    detachTtyListeners()
    pauseTtyInput()
    debugTtyState('after-detach')

    const sessionToResume: SessionSummary | undefined = selectedSession
    if (!sessionToResume) {
      debugTtyState('no-session-selected')
      return
    }

    clearScreen()
    debugTtyState('before-spawn')
    process.stdout.write(`Resuming session ${sessionToResume.id}\n`)
    const exitCode = await resumeSession(sessionToResume.resumeTarget, {
      source: sessionToResume.source,
      cwd: resolveSessionWorkingDirectory(sessionToResume),
      yoloMode,
    })
    process.exitCode = exitCode
  } catch (error) {
    console.error('Failed to load agent sessions:', error)
    process.exitCode = 1
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (entryHref === import.meta.url) {
  void main()
}
