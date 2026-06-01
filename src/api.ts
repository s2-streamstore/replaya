import type {
  AppendEventsRequest,
  AppendEventsResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  HealthResponse,
  ListSessionsResponse,
  SessionDetail,
  StopSessionRequest,
} from './shared/session'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let message = response.statusText
    try {
      const payload = (await response.json()) as { error?: string }
      message = payload.error ?? message
    } catch {
      // Keep the HTTP status text when the server did not return JSON.
    }

    throw new Error(message)
  }

  return (await response.json()) as T
}

export const api = {
  health() {
    return request<HealthResponse>('/health')
  },

  listSessions(options: { limit?: number; startAfter?: string } = {}) {
    const params = new URLSearchParams()
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.startAfter) params.set('startAfter', options.startAfter)
    const queryString = params.toString()
    const query = queryString ? `?${queryString}` : ''
    return request<ListSessionsResponse>(`/sessions${query}`)
  },

  createSession(body: CreateSessionRequest) {
    return request<CreateSessionResponse>('/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  getSession(id: string) {
    return request<{ session: SessionDetail }>(`/sessions/${id}`)
  },

  deleteSession(id: string) {
    return request<{ deleted: string }>(`/sessions/${id}`, { method: 'DELETE' })
  },

  liveSessionUrl(id: string, fromSeqNum: number) {
    return `/api/sessions/${encodeURIComponent(id)}/live?fromSeqNum=${encodeURIComponent(String(fromSeqNum))}`
  },

  liveSessionIndexUrl(fromSeqNum: number) {
    return `/api/sessions/index/live?fromSeqNum=${encodeURIComponent(String(fromSeqNum))}`
  },

  appendEvents(id: string, body: AppendEventsRequest) {
    return request<AppendEventsResponse>(`/sessions/${id}/events`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  stopSession(id: string, body: StopSessionRequest) {
    return request<{ session: SessionDetail }>(`/sessions/${id}/stop`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
}
