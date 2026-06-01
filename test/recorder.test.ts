import { describe, it, expect } from 'vitest'
import { recorderScript, recorderTestPage } from '../server/recorderScript.ts'

describe('recorderScript', () => {
  const script = recorderScript()

  it('masks all inputs by default (opt out, not opt in)', () => {
    // Tier 0 privacy guarantee: default true, only disabled by an explicit "false".
    expect(script).toContain('maskAllInputs: !(script && script.dataset.maskAllInputs === "false")')
    expect(script).not.toContain('maskAllInputs: Boolean(script && script.dataset.maskAllInputs === "true")')
  })

  it('exposes the documented command surface', () => {
    for (const command of ['"init"', '"start"', '"stop"', '"identify"', '"flush"']) {
      expect(script).toContain(command)
    }
  })

  it('flushes on page unload via sendBeacon', () => {
    expect(script).toContain('"pagehide"')
    expect(script).toContain('navigator.sendBeacon')
  })

  it('derives apiHost from the script origin by default', () => {
    expect(script).toContain('apiHost: scriptOrigin')
  })
})

describe('recorderTestPage', () => {
  const page = recorderTestPage()

  it('is same-origin: relative script src and window.location.origin apiHost', () => {
    expect(page).toContain('"/recorder.js"')
    expect(page).toContain('apiHost: window.location.origin')
    // Must not bake in an absolute server origin (the bug that sent it to the dashboard).
    expect(page).not.toMatch(/src=.*https?:\/\//)
  })

  it('renders the fixture workspace', () => {
    expect(page).toContain('recorder fixture')
    expect(page).toContain('Capture validation workspace')
  })
})
