import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import 'rrweb-player/dist/style.css'
import type { eventWithTime } from '@rrweb/types'
import type RrwebPlayerInstance from 'rrweb-player'
import type { RRwebPlayerOptions } from 'rrweb-player'
import type { ReplayEvent } from './shared/session'

interface ReplayPlayerProps {
  sessionId: string
  events: ReplayEvent[]
  live: boolean
  lastSeqNum: number
}

type DestroyablePlayer = RrwebPlayerInstance & { $destroy: () => void }
const LIVE_EDGE_PROGRESS = 0.995
type PlayerState = 'loading' | 'playing' | 'paused' | 'waiting'

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

export function ReplayPlayer({ sessionId, events, live, lastSeqNum }: ReplayPlayerProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<DestroyablePlayer | null>(null)
  const mountedSessionRef = useRef<string | null>(null)
  const lastAddedSeqNumRef = useRef(-1)
  const followingLiveEdgeRef = useRef(true)
  const eventsRef = useRef(events)
  const [size, setSize] = useState({ width: 960, height: 540 })
  const [playerError, setPlayerError] = useState<string | null>(null)
  const [playerState, setPlayerState] = useState<PlayerState>('loading')
  const [followingLiveEdge, setFollowingLiveEdge] = useState(live)
  const canMount = events.length >= 2
  const liveModeClass = live ? (followingLiveEdge ? 'following' : 'reviewing') : 'snapshot'
  const statusLabel =
    live && followingLiveEdge
      ? 'Live tail'
      : live
        ? playerState === 'playing'
          ? 'Playing history'
          : 'Reviewing history'
        : playerState === 'playing'
          ? 'Playing replay'
        : playerState === 'loading'
          ? 'Loading replay'
          : 'Paused'
  const statusDetail = live
    ? followingLiveEdge
      ? `stream seq ${lastSeqNum}`
      : `new records continue after seq ${lastSeqNum}`
    : playerState === 'playing'
      ? 'timeline advancing'
      : 'ready at final frame'

  const updateFollowingLiveEdge = (nextFollowingLiveEdge: boolean) => {
    followingLiveEdgeRef.current = nextFollowingLiveEdge
    setFollowingLiveEdge((current) => (current === nextFollowingLiveEdge ? current : nextFollowingLiveEdge))
  }

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

    const handleControllerClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.rr-progress')) {
        updateFollowingLiveEdge(false)
      }
    }

    frame.addEventListener('click', handleControllerClick, true)

    return () => frame.removeEventListener('click', handleControllerClick, true)
  }, [canMount, sessionId])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !canMount) return

    let cancelled = false

    async function mountPlayer() {
      const target = frameRef.current
      if (!target) return

      try {
        setPlayerState('loading')
        const { default: RrwebPlayer } = await import('rrweb-player')

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
            liveMode: live,
            speed: 1,
            speedOption: [1, 2, 4],
            maxScale: 1,
          },
        }

        playerRef.current?.$destroy()
        target.replaceChildren()
        const player = new RrwebPlayer(options) as DestroyablePlayer
        const handleFinish = () => {
          if (live) {
            updateFollowingLiveEdge(true)
            player.getReplayer().startLive(Date.now())
            setPlayerState('waiting')
          } else {
            setPlayerState('paused')
          }
        }

        player.addEventListener('ui-update-progress', (progress: unknown) => {
          const value = uiPayload(progress)
          if (typeof value === 'number') {
            if (!live) {
              updateFollowingLiveEdge(value >= LIVE_EDGE_PROGRESS)
            } else if (!followingLiveEdgeRef.current && value >= LIVE_EDGE_PROGRESS) {
              updateFollowingLiveEdge(true)
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
          updateFollowingLiveEdge(true)
        } else {
          updateFollowingLiveEdge(false)
        }

        playerRef.current = player
        mountedSessionRef.current = sessionId
        lastAddedSeqNumRef.current = maxEventSeqNum(currentEvents)
        setPlayerError(null)

        if (live) {
          const edgeOffset = timelineEndOffset(currentEvents, lastAddedSeqNumRef.current)
          if (edgeOffset !== null) {
            player.goto(edgeOffset, false)
          }
          player.getReplayer().startLive(Date.now())
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
      playerRef.current?.$destroy()
      playerRef.current = null
      mountedSessionRef.current = null
      lastAddedSeqNumRef.current = -1
      setPlayerState('loading')
    }
  }, [canMount, live, sessionId, size.height, size.width])

  useEffect(() => {
    const player = playerRef.current
    if (!player || mountedSessionRef.current !== sessionId) return

    const nextEvents = events
      .filter((event) => eventSeqNum(event) > lastAddedSeqNumRef.current)
      .sort((a, b) => eventSeqNum(a) - eventSeqNum(b))

    const wasFollowingLiveEdge = live && followingLiveEdgeRef.current

    for (const event of nextEvents) {
      player.addEvent(event as eventWithTime)
      lastAddedSeqNumRef.current = Math.max(lastAddedSeqNumRef.current, eventSeqNum(event))
    }

    if (nextEvents.length > 0 && wasFollowingLiveEdge) {
      setPlayerState('waiting')
    }
  }, [events, live, sessionId])

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
}
