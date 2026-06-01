import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/ReplayPlayer.tsx', import.meta.url), 'utf8')

describe('ReplayPlayer active-session playback integration', () => {
  it('does not put rrweb into live mode, so active-session history remains playable', () => {
    expect(source).toContain('liveMode: false')
    expect(source).not.toContain('startLive(')
    expect(source).toContain('queueLiveEdgeSeek(events)')
    expect(source).toContain('if (live && !followingLiveEdgeRef.current) return')
    expect(source).toContain('continueBufferedPlayback(player)')
    expect(source).toContain('player.goto(resumeOffset, true)')
  })
})
