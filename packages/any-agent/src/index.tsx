import { pathToFileURL } from 'node:url'
import { render } from 'ink'
import {
  getSessions as getCodexSessions,
  type SessionSummary,
  type SessionsWithTotals,
} from './codex'
import { getClaudeSessions } from './claudecode'
import { resumeSession } from './resume'
import SessionPicker from './ui/SessionPicker'

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

  const sessions = [...codex.sessions, ...claude.sessions].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  )
  const totalBlendedTokens = codex.totalBlendedTokens + claude.totalBlendedTokens
  const totalCostUsd = codex.totalCostUsd + claude.totalCostUsd

  return { sessions, totalBlendedTokens, totalCostUsd }
}

const parseSourceFilter = (argv: string[]): SessionSourceFilter => {
  const [candidate] = argv
  if (!candidate) {
    return 'all'
  }

  const normalized = candidate.toLowerCase()
  if (normalized === 'codex' || normalized === 'claudecode') {
    return normalized
  }

  return 'all'
}

export async function main() {
  try {
    const sourceFilter = parseSourceFilter(process.argv.slice(2))
    const { sessions, totalBlendedTokens, totalCostUsd } =
      await getAllSessions(sourceFilter)
    let selectedSession: SessionSummary | null = null

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

    if (selectedSession) {
      process.stdout.write(`Resuming session ${selectedSession.id}\n`)
      const exitCode = await resumeSession(selectedSession.id, {
        source: selectedSession.source,
      })
      process.exitCode = exitCode
    }
  } catch (error) {
    console.error('Failed to load agent sessions:', error)
    process.exitCode = 1
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (entryHref === import.meta.url) {
  void main()
}
