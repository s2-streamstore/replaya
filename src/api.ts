import type {
  AppendEventsRequest,
  AppendEventsResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  HealthResponse,
  SessionDetail,
  SessionSummary,
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

  listSessions() {
    return request<{ sessions: SessionSummary[] }>('/sessions')
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

  liveSessionUrl(id: string, fromSeqNum: number) {
    return `/api/sessions/${encodeURIComponent(id)}/live?fromSeqNum=${encodeURIComponent(String(fromSeqNum))}`
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
