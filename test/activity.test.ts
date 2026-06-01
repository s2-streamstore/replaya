import { describe, it, expect } from 'vitest'
import { buildActivity, formatOffset, prettyUrl } from '../src/activity.ts'
import type { ReplayEvent } from '../src/shared/session.ts'

const T = 1_700_000_000_000

describe('formatOffset', () => {
  it('formats ms as m:ss from the session start', () => {
    expect(formatOffset(0)).toBe('0:00')
    expect(formatOffset(5_000)).toBe('0:05')
    expect(formatOffset(65_000)).toBe('1:05')
    expect(formatOffset(-100)).toBe('0:00')
  })
})

describe('prettyUrl', () => {
  it('reduces a URL to its path+query, falling back to host or raw', () => {
    expect(prettyUrl('https://app.example.com/checkout?step=2')).toBe('/checkout?step=2')
    expect(prettyUrl('https://app.example.com/')).toBe('app.example.com')
    expect(prettyUrl('not a url')).toBe('not a url')
  })
})

describe('buildActivity', () => {
  it('returns nothing for empty or timestamp-less input', () => {
    expect(buildActivity([])).toEqual([])
    expect(buildActivity([{ type: 3, data: { source: 2, type: 2 } } as ReplayEvent])).toEqual([])
  })

  it('classifies events and computes offsets relative to the first timestamp', () => {
    const events: ReplayEvent[] = [
      { type: 4, timestamp: T, data: { href: 'https://app.example.com/checkout' } },
      { type: 2, timestamp: T + 1_000, data: {} },
      { type: 3, timestamp: T + 3_500, data: { source: 2, type: 2, x: 12.6, y: 30 } },
    ]
    const activity = buildActivity(events)

    expect(activity.map((entry) => entry.kind)).toEqual(['nav', 'load', 'click'])
    expect(activity[0]).toMatchObject({ kind: 'nav', label: 'Navigation', detail: '/checkout', offsetMs: 0 })
    expect(activity[1]).toMatchObject({ kind: 'load', label: 'Page snapshot', offsetMs: 1_000 })
    expect(activity[2]).toMatchObject({ kind: 'click', label: 'Click', detail: '13, 30', offsetMs: 3_500 })
  })

  it('drops noisy incremental sources (mousemove, scroll, mutation)', () => {
    const events: ReplayEvent[] = [
      { type: 3, timestamp: T, data: { source: 1 } }, // mouse move
      { type: 3, timestamp: T + 1, data: { source: 3 } }, // scroll
      { type: 3, timestamp: T + 2, data: { source: 0 } }, // mutation
      { type: 3, timestamp: T + 3, data: { source: 2, type: 2, x: 1, y: 1 } }, // click — kept
    ]
    expect(buildActivity(events).map((e) => e.kind)).toEqual(['click'])
  })

  it('collapses consecutive inputs on the same field into one entry with a count', () => {
    const events: ReplayEvent[] = [
      { type: 3, timestamp: T, data: { source: 5, id: 7, text: 'a' } },
      { type: 3, timestamp: T + 100, data: { source: 5, id: 7, text: 'ab' } },
      { type: 3, timestamp: T + 200, data: { source: 5, id: 7, text: 'abc' } },
    ]
    const activity = buildActivity(events)
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({ kind: 'input', count: 3, detail: '3 changes' })
  })

  it('does not collapse inputs across different fields', () => {
    const events: ReplayEvent[] = [
      { type: 3, timestamp: T, data: { source: 5, id: 7, text: 'a' } },
      { type: 3, timestamp: T + 100, data: { source: 5, id: 9, text: 'x' } },
    ]
    const activity = buildActivity(events)
    expect(activity).toHaveLength(2)
    expect(activity.every((e) => e.kind === 'input')).toBe(true)
    expect(activity[0].count).toBeUndefined()
  })
})
