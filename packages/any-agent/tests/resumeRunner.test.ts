import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../src/resume', () => ({
  resumeSession: vi.fn(),
}))

afterEach(() => {
  process.exitCode = undefined
})

test('main runs resumeSession with payload data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resume-runner-test-'))
  const signalPath = path.join(dir, 'signal.json')
  const payload = {
    resumeTarget: 'session-123',
    source: 'codex' as const,
    cwd: '/tmp/project',
    yoloMode: true,
  }
  await writeFile(signalPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8' })

  const resumeModule = await import('../src/resume')
  const resumeSpy = vi.mocked(resumeModule.resumeSession)
  resumeSpy.mockResolvedValue(7)

  const { main } = await import('../src/resumeRunner')
  await main(signalPath)

  expect(resumeSpy).toHaveBeenCalledWith('session-123', {
    source: 'codex',
    cwd: '/tmp/project',
    yoloMode: true,
  })
  expect(process.exitCode).toBe(7)
})

test('main reports errors for malformed payloads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resume-runner-bad-'))
  const signalPath = path.join(dir, 'signal.json')
  await writeFile(signalPath, JSON.stringify({ resumeTarget: 123 }), {
    encoding: 'utf8',
  })

  const { main } = await import('../src/resumeRunner')
  await main(signalPath)

  expect(process.exitCode).toBe(1)
})
