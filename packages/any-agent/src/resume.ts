import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export type ResumeSessionSource = 'codex' | 'claude-code'

export interface ResumeSessionOptions {
  source?: ResumeSessionSource
  binary?: string
  model?: string
  config?: string
  extraArgs?: string[]
  yoloMode?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
  spawnImpl?: (
    command: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ) => ChildProcess
  forwardSignals?: NodeJS.Signals[]
  wrapClaudeWithScript?: boolean
}

const DEFAULT_MODEL = 'gpt-5-codex'
const DEFAULT_CONFIG = 'model_reasoning_effort="high"'
const DEFAULT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
const DEFAULT_SOURCE: ResumeSessionSource = 'codex'

export async function resumeSession(
  sessionId: string,
  options: ResumeSessionOptions = {},
): Promise<number> {
  const trimmedId = sessionId?.trim()
  if (!trimmedId) {
    throw new Error('Session id is required to resume an agent session')
  }

  const {
    source = DEFAULT_SOURCE,
    binary,
    model = DEFAULT_MODEL,
    config = DEFAULT_CONFIG,
    extraArgs = [],
    yoloMode = false,
    env = process.env,
    cwd,
    spawnImpl = spawn,
    forwardSignals = DEFAULT_SIGNALS,
    wrapClaudeWithScript = process.platform !== 'win32',
  } = options

  const { command, args } = buildResumeInvocation({
    sessionId: trimmedId,
    source,
    binary,
    model,
    config,
    extraArgs,
    yoloMode,
    wrapClaudeWithScript,
  })

  const spawnOptions: SpawnOptions = {
    stdio: 'inherit',
    env,
    cwd,
  }

  const child = spawnImpl(command, args, spawnOptions)

  return await new Promise<number>((resolve, reject) => {
    const listenerMap = new Map<NodeJS.Signals, () => void>()

    const cleanup = () => {
      for (const [signal, handler] of listenerMap) {
        process.off(signal, handler)
      }
    }

    for (const signal of forwardSignals) {
      const handler = () => {
        try {
          child.kill(signal)
        } catch {
          // ignore failures when forwarding signals
        }
      }
      listenerMap.set(signal, handler)
      process.on(signal, handler)
    }

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
      if (code === null) {
        resolve(0)
        return
      }
      resolve(code)
    })
  })
}

type ResumeInvocation = {
  command: string
  args: string[]
}

type ResumeInvocationOptions = {
  sessionId: string
  source: ResumeSessionSource
  binary?: string
  model: string
  config: string
  extraArgs: string[]
  yoloMode: boolean
  wrapClaudeWithScript: boolean
}

function buildResumeInvocation({
  sessionId,
  source,
  binary,
  model,
  config,
  extraArgs,
  yoloMode,
  wrapClaudeWithScript,
}: ResumeInvocationOptions): ResumeInvocation {
  if (source === 'claude-code') {
    const claudeBinary = binary ?? 'claude'
    const claudeArgs = ['--resume', sessionId]
    if (yoloMode) {
      claudeArgs.push('--dangerously-skip-permissions')
    }
    claudeArgs.push(...extraArgs)
    if (wrapClaudeWithScript) {
      return {
        command: 'script',
        args: ['-q', '/dev/null', claudeBinary, ...claudeArgs],
      }
    }
    return {
      command: claudeBinary,
      args: claudeArgs,
    }
  }

  const codexArgs = ['-m', model, '-c', config, '--search']
  if (yoloMode) {
    codexArgs.push('--yolo')
  }
  codexArgs.push('resume', sessionId, ...extraArgs)
  return {
    command: binary ?? 'codex',
    args: codexArgs,
  }
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
