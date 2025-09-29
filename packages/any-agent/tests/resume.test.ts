import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process'
import { expect, test, vi } from 'vitest'
import { resumeSession } from '../src/resume'

type SpawnCall = {
  command: string
  args: ReadonlyArray<string>
  options: SpawnOptionsWithoutStdio
}

function createFakeChild(): ChildProcess {
  const emitter = new EventEmitter()
  const fake = Object.assign(emitter, {
    killed: false,
    pid: 1234,
    stdin: null,
    stdout: null,
    stderr: null,
    stdio: [] as unknown[],
    channel: null,
    connected: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [] as string[],
    spawnfile: 'codex',
    kill: vi.fn((signal?: NodeJS.Signals) => {
      fake.killed = true
      return true
    }),
    send: vi.fn(() => false),
    disconnect: vi.fn(),
    ref: vi.fn(() => fake),
    unref: vi.fn(() => fake),
  })
  return fake as unknown as ChildProcess
}

test('resumeSession spawns codex with default arguments and returns exit code', async () => {
  const calls: SpawnCall[] = []
  const child = createFakeChild()
  const spawnImpl = vi.fn((command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options })
    return child
  })

  const promise = resumeSession('session-123', { spawnImpl })
  child.emit('exit', 0, null)
  const exitCode = await promise

  expect(exitCode).toBe(0)
  expect(spawnImpl).toHaveBeenCalledOnce()
  expect(calls[0]).toMatchObject({
    command: 'codex',
    args: [
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="high"',
      '--search',
      'resume',
      'session-123',
    ],
  })
  expect(calls[0].options.stdio).toBe('inherit')
  expect(calls[0].options.env).toBe(process.env)
  expect(calls[0].options.cwd).toBeUndefined()
})

test('resumeSession appends yolo flag when enabled for codex sessions', async () => {
  const calls: SpawnCall[] = []
  const child = createFakeChild()
  const spawnImpl = vi.fn((command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options })
    return child
  })

  const promise = resumeSession('session-123', { spawnImpl, yoloMode: true })
  child.emit('exit', 0, null)
  await promise

  expect(spawnImpl).toHaveBeenCalledOnce()
  expect(calls[0]).toMatchObject({
    command: 'codex',
    args: [
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="high"',
      '--search',
      '--yolo',
      'resume',
      'session-123',
    ],
  })
})

test('resumeSession passes cwd to spawn options when provided', async () => {
  const calls: SpawnCall[] = []
  const child = createFakeChild()
  const spawnImpl = vi.fn((command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options })
    return child
  })

  const cwd = '/tmp/example-project'
  const promise = resumeSession('session-with-cwd', { spawnImpl, cwd })
  child.emit('exit', 0, null)
  await promise

  expect(spawnImpl).toHaveBeenCalledOnce()
  expect(calls[0].options.cwd).toBe(cwd)
})

test('resumeSession forwards signals to the spawned process', async () => {
  const child = createFakeChild()
  const spawnImpl = vi.fn(() => child)
  const initialSigintListeners = process.listeners('SIGINT').length

  const promise = resumeSession('session-456', { spawnImpl })

  const sigintListeners = process.listeners('SIGINT')
  expect(sigintListeners.length).toBe(initialSigintListeners + 1)
  const handler = sigintListeners[sigintListeners.length - 1] as () => void

  handler()
  handler()
  expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGINT')
  expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGINT')

  child.emit('exit', 0, null)
  await promise

  expect(process.listeners('SIGINT').length).toBe(initialSigintListeners)
})

test('resumeSession returns mapped exit code when process ends via signal', async () => {
  const child = createFakeChild()
  const spawnImpl = vi.fn(() => child)

  const promise = resumeSession('session-789', { spawnImpl })
  child.emit('exit', null, 'SIGTERM')
  const exitCode = await promise

  expect(exitCode).toBe(143)
})

test('resumeSession rejects when session id is missing', async () => {
  await expect(resumeSession('')).rejects.toThrow('Session id is required to resume an agent session')
})

test('resumeSession spawns claude with resume arguments when source is claude-code', async () => {
  const calls: SpawnCall[] = []
  const child = createFakeChild()
  const spawnImpl = vi.fn((command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options })
    return child
  })

  const promise = resumeSession('session-claude', {
    source: 'claude-code',
    spawnImpl,
    wrapClaudeWithScript: false,
  })
  child.emit('exit', 0, null)
  const exitCode = await promise

  expect(exitCode).toBe(0)
  expect(spawnImpl).toHaveBeenCalledOnce()
  expect(calls[0]).toMatchObject({
    command: 'claude',
    args: ['--resume', 'session-claude'],
  })
})

test('resumeSession appends skip permissions flag when yolo mode is enabled for claude sessions', async () => {
  const calls: SpawnCall[] = []
  const child = createFakeChild()
  const spawnImpl = vi.fn((command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options })
    return child
  })

  const promise = resumeSession('session-claude', {
    source: 'claude-code',
    spawnImpl,
    wrapClaudeWithScript: false,
    yoloMode: true,
  })
  child.emit('exit', 0, null)
  await promise

  expect(spawnImpl).toHaveBeenCalledOnce()
  expect(calls[0]).toMatchObject({
    command: 'claude',
    args: ['--resume', 'session-claude', '--dangerously-skip-permissions'],
  })
})

test('resumeSession wraps claude command with script when enabled', async () => {
  const calls: SpawnCall[] = []
  const child = createFakeChild()
  const spawnImpl = vi.fn((command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options })
    return child
  })

  const promise = resumeSession('session-claude', {
    source: 'claude-code',
    spawnImpl,
    wrapClaudeWithScript: true,
  })
  child.emit('exit', 0, null)
  await promise

  expect(spawnImpl).toHaveBeenCalledOnce()
  expect(calls[0]).toMatchObject({
    command: 'script',
    args: ['-q', '/dev/null', 'claude', '--resume', 'session-claude'],
  })
})

test('resumeSession includes skip permissions flag when wrapped claude uses yolo mode', async () => {
  const calls: SpawnCall[] = []
  const child = createFakeChild()
  const spawnImpl = vi.fn((command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
    calls.push({ command, args, options })
    return child
  })

  const promise = resumeSession('session-claude', {
    source: 'claude-code',
    spawnImpl,
    wrapClaudeWithScript: true,
    yoloMode: true,
  })
  child.emit('exit', 0, null)
  await promise

  expect(spawnImpl).toHaveBeenCalledOnce()
  expect(calls[0]).toMatchObject({
    command: 'script',
    args: ['-q', '/dev/null', 'claude', '--resume', 'session-claude', '--dangerously-skip-permissions'],
  })
})
