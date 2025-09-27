import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface ResumeSessionOptions {
  binary?: string
  model?: string
  config?: string
  extraArgs?: string[]
  env?: NodeJS.ProcessEnv
  spawnImpl?: (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ) => ChildProcess
  forwardSignals?: NodeJS.Signals[]
}

const DEFAULT_MODEL = 'gpt-5-codex'
const DEFAULT_CONFIG = 'model_reasoning_effort="high"'
const DEFAULT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

export async function resumeSession(
  sessionId: string,
  options: ResumeSessionOptions = {},
): Promise<number> {
  const trimmedId = sessionId?.trim()
  if (!trimmedId) {
    throw new Error('Session id is required to resume a Codex session')
  }

  const {
    binary = 'codex',
    model = DEFAULT_MODEL,
    config = DEFAULT_CONFIG,
    extraArgs = [],
    env = process.env,
    spawnImpl = spawn,
    forwardSignals = DEFAULT_SIGNALS,
  } = options

  const args = [
    '-m',
    model,
    '-c',
    config,
    '--yolo',
    '--search',
    'resume',
    trimmedId,
    ...extraArgs,
  ]

  const spawnOptions: SpawnOptions = {
    stdio: 'inherit',
    env,
  }

  const child = spawnImpl(binary, args, spawnOptions)

  const listenerMap = new Map<NodeJS.Signals, () => void>()

  for (const signal of forwardSignals) {
    const handler = () => {
      if (!child.killed) {
        try {
          child.kill(signal)
        } catch {
          // ignore failures when forwarding signals
        }
      }
    }
    listenerMap.set(signal, handler)
    process.on(signal, handler)
  }

  const cleanup = () => {
    for (const [signal, handler] of listenerMap) {
      process.off(signal, handler)
    }
  }

  return await new Promise<number>((resolve, reject) => {
    child.once('error', error => {
      cleanup()
      reject(error)
    })

    child.once('exit', (code, signal) => {
      cleanup()
      if (signal) {
        resolve(exitCodeFromSignal(signal))
        return
      }
      resolve(code ?? 0)
    })
  })
}

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGILL: 132,
  SIGTRAP: 133,
  SIGABRT: 134,
  SIGBUS: 135,
  SIGFPE: 136,
  SIGKILL: 137,
  SIGUSR1: 138,
  SIGSEGV: 139,
  SIGUSR2: 140,
  SIGPIPE: 141,
  SIGALRM: 142,
  SIGTERM: 143,
}

function exitCodeFromSignal(signal: NodeJS.Signals): number {
  return SIGNAL_EXIT_CODES[signal] ?? 1
}
