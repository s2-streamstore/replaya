import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import 'rrweb-player/dist/style.css'
import type { eventWithTime } from '@rrweb/types'
import type { RRwebPlayerOptions } from 'rrweb-player'
import type { ReplayEvent } from './shared/session'

interface ReplayPlayerProps {
  sessionId: string
  events: ReplayEvent[]
  live: boolean
  lastSeqNum: number
  createPlayer?: (options: RRwebPlayerOptions) => DestroyablePlayer | Promise<DestroyablePlayer>
}

export interface ReplayPlayerHandle {
  seek: (offsetMs: number) => void
}

interface DestroyablePlayer {
  addEvent: (event: eventWithTime) => void
  addEventListener: (event: string, handler: (payload: unknown) => void) => void
  getReplayer: () => { on: (event: string, handler: () => void) => void }
  goto: (offsetMs: number, play: boolean) => void
  $destroy: () => void
}
const LIVE_EDGE_PROGRESS = 0.995
type PlayerState = 'loading' | 'playing' | 'paused' | 'waiting'

function describePlaybackStatus(
  live: boolean,
  followingLiveEdge: boolean,
  playerState: PlayerState,
  lastSeqNum: number,
): { label: string; detail: string } {
  if (live && followingLiveEdge) {
    return { label: 'Live tail', detail: `stream seq ${lastSeqNum}` }
  }

  if (live) {
    return {
      label: playerState === 'playing' ? 'Playing history' : 'Reviewing history',
      detail: `new records continue after seq ${lastSeqNum}`,
    }
  }

  return {
    label:
      playerState === 'playing' ? 'Playing replay' : playerState === 'loading' ? 'Loading replay' : 'Paused',
    detail: playerState === 'playing' ? 'timeline advancing' : 'ready at final frame',
  }
}

function uiPayload(value: unknown) {
  if (typeof value === 'object' && value !== null && 'payload' in value) {
    return (value as { payload: unknown }).payload
  }

  return value
}

function eventSeqNum(event: ReplayEvent) {
  const replaya = event._replaya
  if (typeof replaya !== 'object' || replaya === null || !('s2SeqNum' in replaya)) return -1

  const seqNum = replaya.s2SeqNum
  return typeof seqNum === 'number' && Number.isFinite(seqNum) ? seqNum : -1
}

function maxEventSeqNum(events: ReplayEvent[]) {
  return events.reduce((maxSeqNum, event) => Math.max(maxSeqNum, eventSeqNum(event)), -1)
}

function eventTimestamp(event: ReplayEvent) {
  return typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : null
}

function timelineEndOffset(events: ReplayEvent[], maxSeqNum: number) {
  const mountedEvents = events
    .filter((event) => {
      const seqNum = eventSeqNum(event)
      return seqNum >= 0 && seqNum <= maxSeqNum && eventTimestamp(event) !== null
    })
    .sort((a, b) => eventSeqNum(a) - eventSeqNum(b))
  const firstEvent = mountedEvents[0]
  const lastEvent = mountedEvents.at(-1)
  const firstTimestamp = firstEvent ? eventTimestamp(firstEvent) : null
  const lastTimestamp = lastEvent ? eventTimestamp(lastEvent) : null

  return firstTimestamp !== null && lastTimestamp !== null ? Math.max(0, lastTimestamp - firstTimestamp) : null
}

export const ReplayPlayer = forwardRef<ReplayPlayerHandle, ReplayPlayerProps>(function ReplayPlayer(
  { sessionId, events, live, lastSeqNum, createPlayer },
  ref,
) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<DestroyablePlayer | null>(null)
  const mountedSessionRef = useRef<string | null>(null)
  const lastAddedSeqNumRef = useRef(-1)
  const followingLiveEdgeRef = useRef(true)
  const liveEdgeSeekTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const progressInteractionClearTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const progressInteractionActiveRef = useRef(false)
  const eventsRef = useRef(events)
  const [size, setSize] = useState({ width: 960, height: 540 })
  const [playerError, setPlayerError] = useState<string | null>(null)
  const [playerState, setPlayerState] = useState<PlayerState>('loading')
  const [followingLiveEdge, setFollowingLiveEdge] = useState(live)
  const canMount = events.length >= 2
  const liveModeClass = live ? (followingLiveEdge ? 'following' : 'reviewing') : 'snapshot'
  const { label: statusLabel, detail: statusDetail } = describePlaybackStatus(
    live,
    followingLiveEdge,
    playerState,
    lastSeqNum,
  )

  const setFollowingLiveEdgeState = useCallback((nextFollowingLiveEdge: boolean) => {
    followingLiveEdgeRef.current = nextFollowingLiveEdge
    setFollowingLiveEdge((current) => (current === nextFollowingLiveEdge ? current : nextFollowingLiveEdge))
  }, [])

  const clearLiveEdgeSeekTimer = useCallback(() => {
    if (liveEdgeSeekTimerRef.current === null) return
    window.clearTimeout(liveEdgeSeekTimerRef.current)
    liveEdgeSeekTimerRef.current = null
  }, [])

  const clearProgressInteractionTimer = useCallback(() => {
    if (progressInteractionClearTimerRef.current === null) return
    window.clearTimeout(progressInteractionClearTimerRef.current)
    progressInteractionClearTimerRef.current = null
  }, [])

  const markProgressInteraction = useCallback(() => {
    clearProgressInteractionTimer()
    progressInteractionActiveRef.current = true
  }, [clearProgressInteractionTimer])

  const releaseProgressInteractionSoon = useCallback(() => {
    clearProgressInteractionTimer()
    progressInteractionClearTimerRef.current = window.setTimeout(() => {
      progressInteractionActiveRef.current = false
      progressInteractionClearTimerRef.current = null
    }, 250)
  }, [clearProgressInteractionTimer])

  const seekPlayerToLiveEdge = useCallback((player: DestroyablePlayer, sourceEvents: ReplayEvent[] = eventsRef.current) => {
    const edgeOffset = timelineEndOffset(sourceEvents, lastAddedSeqNumRef.current)
    if (edgeOffset !== null) {
      player.goto(edgeOffset, false)
    }
  }, [])

  const appendNewEventsToPlayer = useCallback((player: DestroyablePlayer, sourceEvents: ReplayEvent[]) => {
    const nextEvents = sourceEvents
      .filter((event) => eventSeqNum(event) > lastAddedSeqNumRef.current)
      .sort((a, b) => eventSeqNum(a) - eventSeqNum(b))

    for (const event of nextEvents) {
      player.addEvent(event as eventWithTime)
      lastAddedSeqNumRef.current = Math.max(lastAddedSeqNumRef.current, eventSeqNum(event))
    }

    return nextEvents.length
  }, [])

  const continueBufferedPlayback = useCallback(
    (player: DestroyablePlayer, sourceEvents: ReplayEvent[] = eventsRef.current) => {
      const resumeOffset = timelineEndOffset(sourceEvents, lastAddedSeqNumRef.current)
      const appendedCount = appendNewEventsToPlayer(player, sourceEvents)

      if (appendedCount === 0 || resumeOffset === null) return false

      const scheduledSessionId = sessionId
      setFollowingLiveEdgeState(false)
      void Promise.resolve().then(() => {
        if (
          playerRef.current !== player ||
          mountedSessionRef.current !== scheduledSessionId ||
          followingLiveEdgeRef.current
        ) {
          return
        }

        player.goto(resumeOffset, true)
        setPlayerState('playing')
      })
      return true
    },
    [appendNewEventsToPlayer, sessionId, setFollowingLiveEdgeState],
  )

  const queueLiveEdgeSeek = useCallback(
    (sourceEvents: ReplayEvent[]) => {
      clearLiveEdgeSeekTimer()
      const scheduledSessionId = sessionId
      liveEdgeSeekTimerRef.current = window.setTimeout(() => {
        liveEdgeSeekTimerRef.current = null
        const player = playerRef.current
        if (!player || mountedSessionRef.current !== scheduledSessionId || !followingLiveEdgeRef.current) return

        seekPlayerToLiveEdge(player, sourceEvents)
        setPlayerState('waiting')
      }, 0)
    },
    [clearLiveEdgeSeekTimer, seekPlayerToLiveEdge, sessionId],
  )

  const leaveLiveEdge = useCallback(() => {
    clearLiveEdgeSeekTimer()
    setFollowingLiveEdgeState(false)
  }, [clearLiveEdgeSeekTimer, setFollowingLiveEdgeState])

  const followLiveEdge = useCallback(
    (sourceEvents: ReplayEvent[] = eventsRef.current) => {
      setFollowingLiveEdgeState(true)
      const player = playerRef.current
      if (!player || mountedSessionRef.current !== sessionId) return

      appendNewEventsToPlayer(player, sourceEvents)
      queueLiveEdgeSeek(sourceEvents)
    },
    [appendNewEventsToPlayer, queueLiveEdgeSeek, sessionId, setFollowingLiveEdgeState],
  )

  useImperativeHandle(
    ref,
    () => ({
      seek(offsetMs: number) {
        const player = playerRef.current
        if (!player) return
        leaveLiveEdge()
        player.goto(Math.max(0, offsetMs), false)
        setPlayerState('paused')
      },
    }),
    [leaveLiveEdge],
  )

  useEffect(() => {
    eventsRef.current = events
  }, [events])

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    const updateSize = () => {
      const width = Math.max(320, Math.floor(frame.clientWidth))
      setSize({
        width,
        height: Math.max(280, Math.floor(width * 0.56)),
      })
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(frame)
    updateSize()

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !canMount) return

    const progressFromEvent = (event: Event) => {
      const progress = event.target instanceof Element ? event.target.closest('.rr-progress') : null
      return progress instanceof HTMLElement ? progress : null
    }

    const handleControllerClick = (event: MouseEvent) => {
      const progress = progressFromEvent(event)
      if (!progress) return

      const rect = progress.getBoundingClientRect()
      const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
      if (live && ratio >= LIVE_EDGE_PROGRESS) {
        followLiveEdge()
      } else {
        leaveLiveEdge()
      }
    }

    const handleProgressInteractionStart = (event: Event) => {
      if (progressFromEvent(event)) markProgressInteraction()
    }

    frame.addEventListener('click', handleControllerClick, true)
    frame.addEventListener('pointerdown', handleProgressInteractionStart, true)
    frame.addEventListener('mousedown', handleProgressInteractionStart, true)
    frame.addEventListener('touchstart', handleProgressInteractionStart, true)
    window.addEventListener('pointerup', releaseProgressInteractionSoon, true)
    window.addEventListener('mouseup', releaseProgressInteractionSoon, true)
    window.addEventListener('touchend', releaseProgressInteractionSoon, true)
    window.addEventListener('touchcancel', releaseProgressInteractionSoon, true)

    return () => {
      frame.removeEventListener('click', handleControllerClick, true)
      frame.removeEventListener('pointerdown', handleProgressInteractionStart, true)
      frame.removeEventListener('mousedown', handleProgressInteractionStart, true)
      frame.removeEventListener('touchstart', handleProgressInteractionStart, true)
      window.removeEventListener('pointerup', releaseProgressInteractionSoon, true)
      window.removeEventListener('mouseup', releaseProgressInteractionSoon, true)
      window.removeEventListener('touchend', releaseProgressInteractionSoon, true)
      window.removeEventListener('touchcancel', releaseProgressInteractionSoon, true)
      clearProgressInteractionTimer()
      progressInteractionActiveRef.current = false
    }
  }, [
    canMount,
    clearProgressInteractionTimer,
    followLiveEdge,
    leaveLiveEdge,
    live,
    markProgressInteraction,
    releaseProgressInteractionSoon,
    sessionId,
  ])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !canMount) return

    let cancelled = false

    async function mountPlayer() {
      const target = frameRef.current
      if (!target) return

      try {
        setPlayerState('loading')
        const RrwebPlayer =
          createPlayer ??
          (async (playerOptions: RRwebPlayerOptions) => {
            const { default: Player } = await import('rrweb-player')
            return new Player(playerOptions) as unknown as DestroyablePlayer
          })

        if (cancelled) return
        const currentEvents = eventsRef.current
        if (currentEvents.length < 2) return

        const options: RRwebPlayerOptions = {
          target,
          props: {
            events: currentEvents as eventWithTime[],
            width: size.width,
            height: size.height,
            autoPlay: false,
            showController: true,
            liveMode: false,
            speed: 1,
            speedOption: [1, 2, 4],
            maxScale: 1,
          },
        }

        playerRef.current?.$destroy()
        target.replaceChildren()
        const player = await RrwebPlayer(options)
        if (cancelled) {
          player.$destroy()
          return
        }
        const handleFinish = () => {
          if (live) {
            if (!followingLiveEdgeRef.current && continueBufferedPlayback(player)) return
            followLiveEdge()
            setPlayerState('waiting')
          } else {
            setPlayerState('paused')
          }
        }

        player.addEventListener('ui-update-progress', (progress: unknown) => {
          const value = uiPayload(progress)
          if (typeof value === 'number') {
            if (!live) {
              setFollowingLiveEdgeState(value >= LIVE_EDGE_PROGRESS)
            } else if (progressInteractionActiveRef.current) {
              if (value >= LIVE_EDGE_PROGRESS) {
                followLiveEdge()
              } else {
                leaveLiveEdge()
              }
            }
          }
        })
        player.addEventListener('ui-update-player-state', (state: unknown) => {
          const value = uiPayload(state)
          if (value === 'playing') {
            setPlayerState(live && followingLiveEdgeRef.current ? 'waiting' : 'playing')
          } else if (value === 'paused') {
            setPlayerState(live && followingLiveEdgeRef.current ? 'waiting' : 'paused')
          } else if (value === 'live') {
            setPlayerState(live && followingLiveEdgeRef.current ? 'waiting' : 'playing')
          }
        })
        player.getReplayer().on('finish', handleFinish)

        if (live) {
          setFollowingLiveEdgeState(true)
        } else {
          setFollowingLiveEdgeState(false)
        }

        playerRef.current = player
        mountedSessionRef.current = sessionId
        lastAddedSeqNumRef.current = maxEventSeqNum(currentEvents)
        setPlayerError(null)

        if (live) {
          seekPlayerToLiveEdge(player, currentEvents)
          setPlayerState('waiting')
        } else {
          const endOffset = timelineEndOffset(currentEvents, lastAddedSeqNumRef.current)
          if (endOffset !== null) {
            player.goto(endOffset, false)
          }
          setPlayerState('paused')
        }
      } catch (error) {
        if (cancelled) return
        target.replaceChildren()
        setPlayerError(error instanceof Error ? error.message : 'Unable to load the replay player.')
      }
    }

    void mountPlayer()

    return () => {
      cancelled = true
      clearLiveEdgeSeekTimer()
      clearProgressInteractionTimer()
      progressInteractionActiveRef.current = false
      playerRef.current?.$destroy()
      playerRef.current = null
      mountedSessionRef.current = null
      lastAddedSeqNumRef.current = -1
      setPlayerState('loading')
    }
  }, [
    canMount,
    clearLiveEdgeSeekTimer,
    clearProgressInteractionTimer,
    continueBufferedPlayback,
    createPlayer,
    followLiveEdge,
    leaveLiveEdge,
    live,
    seekPlayerToLiveEdge,
    sessionId,
    setFollowingLiveEdgeState,
    size.height,
    size.width,
  ])

  useEffect(() => {
    const player = playerRef.current
    if (!player || mountedSessionRef.current !== sessionId) return

    if (live && !followingLiveEdgeRef.current) return

    const appendedCount = appendNewEventsToPlayer(player, events)
    if (appendedCount > 0 && live && followingLiveEdgeRef.current) {
      queueLiveEdgeSeek(events)
    }
  }, [appendNewEventsToPlayer, events, live, queueLiveEdgeSeek, sessionId])

  if (events.length < 2) {
    return (
      <div className="empty-state">
        <strong>Not enough replay frames</strong>
        <span>{live ? 'Waiting for live rrweb frames.' : 'This session needs at least two rrweb events before the player can mount.'}</span>
      </div>
    )
  }

  return (
    <>
      {playerError && (
        <div className="banner" role="alert">
          {playerError}
        </div>
      )}
      <div
        className={`replay-player-shell ${playerState} ${live ? 'live' : 'recorded'} ${liveModeClass}`}
        data-player-state={playerState}
        data-live={live ? 'true' : 'false'}
        data-following-live-edge={live && followingLiveEdge ? 'true' : 'false'}
      >
        <div className="replay-playback-bar" aria-live="polite">
          <span
            className={`playback-dot ${live && followingLiveEdge ? 'live' : playerState === 'playing' ? 'playing' : ''}`}
            aria-hidden="true"
          />
          <strong>{statusLabel}</strong>
          <span>{statusDetail}</span>
        </div>
        <div ref={frameRef} className="replay-frame rr-block" />
      </div>
    </>
  )
})
