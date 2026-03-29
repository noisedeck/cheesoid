// server/lib/room-manager.js
import { Room } from './chat-session.js'

/**
 * Manages multiple named rooms for hub personas,
 * or a single default room for legacy single-room personas.
 */
export class RoomManager {
  constructor(persona) {
    this.persona = persona
    this._rooms = new Map()
    this._defaultRoom = null

    this._dmClients = new Map() // name → Set<res>

    const hostedRooms = persona.config.hosted_rooms || []
    if (hostedRooms.length > 0) {
      for (const name of hostedRooms) {
        const room = new Room(persona, { roomName: name })
        room._roomManager = this
        this._rooms.set(name, room)
      }
    } else {
      // Legacy single-room mode
      this._defaultRoom = new Room(persona)
      this._defaultRoom._roomManager = this
    }
  }

  addDMClient(res, name) {
    if (!name) return
    if (!this._dmClients.has(name)) {
      this._dmClients.set(name, new Set())
    }
    this._dmClients.get(name).add(res)
    if (res.on) {
      res.on('close', () => {
        const clients = this._dmClients.get(name)
        if (clients) {
          clients.delete(res)
          if (clients.size === 0) this._dmClients.delete(name)
        }
      })
    }
  }

  routeDM(from, to, text, isAgent) {
    // Don't process self-DMs
    if (from === to) return

    const event = {
      type: 'user_message',
      from,
      to,
      text,
      timestamp: Date.now(),
    }
    const data = `data: ${JSON.stringify(event)}\n\n`

    for (const name of [from, to]) {
      const clients = this._dmClients.get(name)
      if (clients) {
        for (const client of clients) {
          client.write(data)
        }
      }
    }

    // If recipient is the hub's own agent, process and reply via DM
    const agentName = this.persona.config.display_name
    if (to === agentName) {
      const room = this.isHub
        ? this._rooms.values().next().value
        : this._defaultRoom
      if (room) {
        room.processDM(from, text).catch(err => {
          console.error(`[${this.persona.config.name}] DM processing error:`, err.message)
        })
      }
    }
  }

  get isHub() {
    return this._rooms.size > 0
  }

  get roomNames() {
    return [...this._rooms.keys()]
  }

  get defaultRoom() {
    return this._defaultRoom
  }

  get(name) {
    return this._rooms.get(name)
  }

  /**
   * Get room by name, falling back to default for legacy mode.
   * For hub mode, returns first room if no name given.
   */
  resolve(name) {
    if (this.isHub) {
      return name ? this._rooms.get(name) : this._rooms.values().next().value
    }
    return this._defaultRoom
  }

  async initialize() {
    if (this.isHub) {
      for (const room of this._rooms.values()) {
        await room.initialize()
      }
    } else {
      await this._defaultRoom.initialize()
    }
  }

  /** All rooms as an iterable */
  rooms() {
    if (this.isHub) return this._rooms.values()
    return [this._defaultRoom][Symbol.iterator]()
  }

  /** Aggregated participants across all rooms */
  get allParticipants() {
    const names = new Set()
    for (const room of this.rooms()) {
      for (const name of room.participantList) {
        names.add(name)
      }
    }
    return [...names]
  }

  destroy() {
    for (const room of this.rooms()) {
      room.destroy()
    }
  }
}
