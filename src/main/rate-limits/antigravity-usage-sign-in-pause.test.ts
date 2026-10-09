import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from './antigravity-usage-fetcher'
import type { ProcessResult } from '../../shared/child-process/process-spec'

const USAGE_ENVELOPE = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.4,
              reset_time: '2026-10-07T08:08:35Z'
            }
          ]
        }
      ]
    }
  }
})

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function harness(initial: ProcessResult) {
  let usageResult = initial
  const runCommand = vi
    .fn()
    .mockImplementation(async (spec: { args?: readonly string[] }) =>
      spec.args?.[0] === '--version'
        ? processResult({ stdout: 'agy version 1.3.2\n' })
        : usageResult
    )
  const usageReads = (): number =>
    runCommand.mock.calls.filter(([spec]) => spec.args?.[0] !== '--version').length
  return {
    usageReads,
    answerWith: (next: ProcessResult) => {
      usageResult = next
    },
    fetch: (force?: boolean) =>
      fetchAntigravityRateLimits({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock returns a ProcessResult, which is the whole contract runProcess exposes to this fetcher.
        runCommand: runCommand as never,
        resolveCommand: vi
          .fn()
          .mockResolvedValue('C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe'),
        resolveEnvironment: vi.fn().mockResolvedValue({ PATH: 'C:\\Windows' }),
        platform: 'win32',
        now: () => 1_700_000_000_000,
        force
      })
  }
}

// Why: agy's print mode opens a browser OAuth page when silent auth fails, so every automated
// retry used to open another sign-in tab.
describe('Antigravity usage after a possible browser sign-in', () => {
  beforeEach(() => {
    resetAntigravityUsageSupportForTests()
  })

  it('stops automated reads after a timeout, which is how a pending browser sign-in looks', async () => {
    const h = harness(processResult({ timedOut: true, code: null }))
    await h.fetch()

    const replayed = await h.fetch()

    expect(h.usageReads()).toBe(1)
    expect(replayed.status).toBe('error')
    expect(replayed.error).toContain('did not answer in time')
    expect(replayed.error).toContain('refresh usage')
  })

  it('stops automated reads after a signed-out answer', async () => {
    const h = harness(processResult({ stderr: 'You are not logged into Antigravity.' }))
    await h.fetch()

    const replayed = await h.fetch()

    expect(h.usageReads()).toBe(1)
    expect(replayed.status).toBe('unavailable')
    expect(replayed.usageMetadata?.failureKind).toBe('missing-credentials')
  })

  it('lets a user-directed refresh read again and resumes polling once it succeeds', async () => {
    const h = harness(processResult({ timedOut: true, code: null }))
    await h.fetch()
    h.answerWith(processResult({ stdout: USAGE_ENVELOPE }))

    expect((await h.fetch(true)).status).toBe('ok')
    expect((await h.fetch()).status).toBe('ok')
    expect(h.usageReads()).toBe(3)
  })

  it('keeps the pause when a user-directed refresh still cannot sign in', async () => {
    const h = harness(processResult({ timedOut: true, code: null }))
    await h.fetch()
    await h.fetch(true)

    await h.fetch()

    expect(h.usageReads()).toBe(2)
  })

  it('does not pause on an ordinary read failure', async () => {
    const h = harness(processResult({ code: 2, stdout: 'unknown command /usage' }))
    await h.fetch()
    await h.fetch()

    expect(h.usageReads()).toBe(2)
  })
})
