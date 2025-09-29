import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resumeSession } from './resume'

type ResumeSignalPayload = {
  resumeTarget: string
  source: 'codex' | 'claude-code'
  cwd?: string
  yoloMode?: boolean
}

const ensureResumePayload = (value: unknown): ResumeSignalPayload => {
  if (!value || typeof value !== 'object') {
    throw new Error('Resume signal payload is malformed')
  }
  const payload = value as Partial<ResumeSignalPayload>
  if (!payload.resumeTarget || typeof payload.resumeTarget !== 'string') {
    throw new Error('Resume signal payload is missing resumeTarget')
  }
  if (payload.source !== 'codex' && payload.source !== 'claude-code') {
    throw new Error('Resume signal payload is missing source')
  }
  const normalized: ResumeSignalPayload = {
    resumeTarget: payload.resumeTarget,
    source: payload.source,
    yoloMode: payload.yoloMode ?? false,
  }
  if (typeof payload.cwd === 'string' && payload.cwd.trim().length > 0) {
    normalized.cwd = payload.cwd
  }
  return normalized
}

export async function main(signalFilePath: string | undefined = undefined) {
  try {
    const filePath = signalFilePath ?? process.argv[2]
    if (!filePath) {
      throw new Error('Resume signal file path is required')
    }
    const contents = await readFile(filePath, { encoding: 'utf8' })
    const rawPayload = JSON.parse(contents)
    const payload = ensureResumePayload(rawPayload)
    const exitCode = await resumeSession(payload.resumeTarget, {
      source: payload.source,
      cwd: payload.cwd,
      yoloMode: payload.yoloMode,
    })
    process.exitCode = exitCode
  } catch (error) {
    console.error('Failed to resume session:', error)
    process.exitCode = 1
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (entryHref === import.meta.url) {
  void main()
}
