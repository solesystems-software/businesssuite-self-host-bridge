import type { Env } from './mobileSyncTypes'

// One instance per account (idFromName(accountSyncId)). Holds no persistent
// storage: it is a live relay between the connected desktop and the connected
// phone(s) for that account. Uses the Hibernation API so an idle channel costs
// nothing and survives eviction.
//
// Each socket is tagged with its role ('desktop' | 'mobile') at accept time. The
// Worker entry authenticates the upgrade and passes the authenticated role via
// the ?channel_role= query param; the tag is a Hibernation API tag, so it (and
// therefore counterpart-presence via getWebSockets(role)) survives eviction —
// the runtime rehydrates tagged sockets on wake.
//
// Frames a socket may SEND:
//   { type: 'ping' }                                   -> auto-response 'pong' (never wakes the DO)
//   { type: 'sync_check' }               (desktop)     -> { type: 'high_water', server_sequence }
//   { type: 'request_push', request_id } (desktop)     -> relay { type: 'push_requested' } to every mobile
//                                                          socket, then reply to the sender
//                                                          { type: 'push_ack', request_id, counterpart_connected, delivered }
//   { type: 'request_publish', request_id } (mobile)   -> relay { type: 'publish_requested' } to every desktop
//                                                          socket, then reply to the sender
//                                                          { type: 'publish_ack', request_id, counterpart_connected, delivered }
//   { type: 'counterpart_status_request', request_id } -> reply { type: 'counterpart_status', request_id, connected }
//
// Frames a socket may RECEIVE:
//   { type: 'packets_pending', server_sequence }  (desktop, from POST /notify)
//   { type: 'high_water', server_sequence }       (desktop)
//   { type: 'push_requested' }                    (mobile)  -> phone flushes its outbox
//   { type: 'publish_requested' }                 (desktop) -> desktop publishes a fresh snapshot
//   the *_ack / counterpart_status replies described above
//
// Unknown frame types are ignored by every client, so new frames are additive.
type ChannelRole = 'desktop' | 'mobile'

export class AccountSyncChannel implements DurableObject {
  // Highest server_sequence this instance has been poked with since it last
  // woke. null right after a hibernation wake — the desktop treats null as
  // "sync to be safe".
  private lastPokedSequence: number | null = null

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    // Answer keepalive pings without waking the instance from hibernation, so an
    // idle channel survives proxy idle timeouts between either side and CF.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(JSON.stringify({ type: 'ping' }), JSON.stringify({ type: 'pong' })),
    )
  }

  private socketsForRole(role: ChannelRole): WebSocket[] {
    return this.state.getWebSockets(role)
  }

  private roleOf(ws: WebSocket): ChannelRole | null {
    const tags = this.state.getTags(ws)
    if (tags.includes('mobile')) return 'mobile'
    if (tags.includes('desktop')) return 'desktop'
    return null
  }

  private relay(role: ChannelRole, frame: unknown): number {
    const text = JSON.stringify(frame)
    let delivered = 0
    for (const socket of this.socketsForRole(role)) {
      try { socket.send(text); delivered += 1 } catch { /* socket is closing; ignore */ }
    }
    return delivered
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/notify' && request.method === 'POST') {
      const body = await request.json<{ server_sequence?: number }>().catch(() => ({} as { server_sequence?: number }))
      const sequence = typeof body.server_sequence === 'number' ? body.server_sequence : null
      if (sequence !== null) this.lastPokedSequence = Math.max(this.lastPokedSequence ?? 0, sequence)
      // Scoped to desktop sockets: a phone does not act on packets_pending.
      this.relay('desktop', { type: 'packets_pending', server_sequence: sequence })
      return new Response(null, { status: 204 })
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const role: ChannelRole = url.searchParams.get('channel_role') === 'mobile' ? 'mobile' : 'desktop'
    const pair = new WebSocketPair()
    // The role tag is a Hibernation API tag: it is durable across eviction and is
    // what getWebSockets(role) / getTags(ws) read after a wake.
    this.state.acceptWebSocket(pair[1], [role])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    let parsed: { type?: string; request_id?: unknown }
    try {
      parsed = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as typeof parsed
    } catch {
      return
    }
    const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : null
    const role = this.roleOf(ws)

    if (parsed.type === 'sync_check') {
      trySend(ws, { type: 'high_water', server_sequence: this.lastPokedSequence })
      return
    }

    if (parsed.type === 'counterpart_status_request') {
      const counterpart: ChannelRole = role === 'mobile' ? 'desktop' : 'mobile'
      trySend(ws, { type: 'counterpart_status', request_id: requestId, connected: this.socketsForRole(counterpart).length > 0 })
      return
    }

    if (parsed.type === 'request_push' && role === 'desktop') {
      const delivered = this.relay('mobile', { type: 'push_requested' })
      trySend(ws, { type: 'push_ack', request_id: requestId, counterpart_connected: delivered > 0, delivered })
      return
    }

    if (parsed.type === 'request_publish' && role === 'mobile') {
      const delivered = this.relay('desktop', { type: 'publish_requested' })
      trySend(ws, { type: 'publish_ack', request_id: requestId, counterpart_connected: delivered > 0, delivered })
      return
    }
  }

  webSocketClose(): void {}

  webSocketError(): void {}
}

function trySend(ws: WebSocket, frame: unknown): void {
  try { ws.send(JSON.stringify(frame)) } catch { /* socket is closing; ignore */ }
}
