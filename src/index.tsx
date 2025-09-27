import { pathToFileURL } from 'node:url'
import { render } from 'ink'
import { getSessions } from './codex'
import { resumeSession } from './resume'
import SessionPicker from './ui/SessionPicker'

export { getSessions }

export async function main() {
  try {
    const { sessions, totalBlendedTokens, totalCostUsd } = await getSessions()
    let selectedSessionId: string | null = null

    const { waitUntilExit } = render(
      <SessionPicker
        sessions={sessions}
        totalTokens={totalBlendedTokens}
        totalCost={totalCostUsd}
        onResume={session => {
          selectedSessionId = session.id
        }}
      />
    )

    await waitUntilExit()

    if (selectedSessionId) {
      process.stdout.write(`Resuming session ${selectedSessionId}\n`)
      const exitCode = await resumeSession(selectedSessionId)
      process.exitCode = exitCode
    }
  } catch (error) {
    console.error('Failed to load Codex sessions:', error)
    process.exitCode = 1
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (entryHref === import.meta.url) {
  void main()
}
