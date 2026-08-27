import { DurableObject } from "cloudflare:workers";

/* =========================================================
   CODENAMES MATCHMAKING
========================================================= */

const MATCH_SIZE = 4;
const WAIT_MS = 15_000;
const STALE_MS = 90_000;
const MATCHED_RETENTION_MS = 10 * 60_000;

function corsHeaders(origin) {
  const allowed =
    origin === "https://jrjboss.github.io" ||
    origin === "null" ||
    !origin;

  return {
    "Access-Control-Allow-Origin": allowed
      ? origin || "*"
      : "https://jrjboss.github.io",

    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin)
    }
  });
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 5; i++) {
    code += chars[
      Math.floor(Math.random() * chars.length)
    ];
  }

  return code;
}


/* =========================================================
   MATCHMAKER
   EXISTING CODENAMES LOGIC
========================================================= */

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS queue (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'waiting',
          match_id TEXT,
          host INTEGER NOT NULL DEFAULT 0,
          team TEXT,
          payload TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_queue_status_time
        ON queue(status, joined_at);

        CREATE INDEX IF NOT EXISTS idx_queue_match
        ON queue(match_id);
      `);
    });
  }

  cleanStale() {
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `
      DELETE FROM queue
      WHERE status = 'waiting'
      AND joined_at < ?
      `,
      now - STALE_MS
    );

    this.ctx.storage.sql.exec(
      `
      DELETE FROM queue
      WHERE status = 'matched'
      AND joined_at < ?
      `,
      now - MATCHED_RETENTION_MS
    );
  }

  makeMatch(rows) {
    const matchId = crypto.randomUUID();
    const roomCode = makeRoomCode();
    const now = Date.now();

    const selected = rows.slice(0, MATCH_SIZE);

    const players = selected.map((row, index) => ({
      id: row.id,
      name: row.name,

      team:
        index % 2 === 0
          ? "red"
          : "blue",

      bot: false,
      host: index === 0
    }));

    while (players.length < MATCH_SIZE) {
      const index = players.length;

      players.push({
        id: `bot-${matchId}-${index}`,
        name: `Codename Bot ${index}`,
        team:
          index % 2 === 0
            ? "red"
            : "blue",
        bot: true,
        host: false,
        difficulty: "normal"
      });
    }

    const payload = JSON.stringify({
      matchId,
      roomCode,
      players,
      createdAt: now
    });

    this.ctx.storage.transactionSync(() => {
      for (const player of players.filter(p => !p.bot)) {
        this.ctx.storage.sql.exec(
          `
          UPDATE queue
          SET status = 'matched',
              match_id = ?,
              host = ?,
              team = ?,
              payload = ?
          WHERE id = ?
          `,
          matchId,
          player.host ? 1 : 0,
          player.team,
          payload,
          player.id
        );
      }
    });

    return {
      matchId,
      roomCode,
      players
    };
  }

  async join(player) {
    this.cleanStale();

    const existing =
      this.ctx.storage.sql
        .exec(
          `
          SELECT *
          FROM queue
          WHERE id = ?
          `,
          player.id
        )
        .toArray();

    if (existing.length) {
      return this.status(player.id);
    }

    this.ctx.storage.sql.exec(
      `
      INSERT INTO queue(
        id,
        name,
        joined_at,
        status,
        payload
      )
      VALUES (?, ?, ?, 'waiting', ?)
      `,
      player.id,
      player.name,
      Date.now(),
      JSON.stringify(player)
    );

    return this.status(player.id);
  }

  async status(id) {
    this.cleanStale();

    const row =
      this.ctx.storage.sql
        .exec(
          `
          SELECT *
          FROM queue
          WHERE id = ?
          `,
          id
        )
        .toArray()[0];

    if (!row) {
      return {
        status: "gone"
      };
    }

    if (row.status === "matched" && row.payload) {
      const match = JSON.parse(row.payload);

      const waiting =
        this.ctx.storage.sql
          .exec(
            `
            SELECT COUNT(*) AS count
            FROM queue
            WHERE status = 'waiting'
            `
          )
          .one();

      return {
        status: "matched",
        ...match,
        host: !!row.host,
        team: row.team,
        queueCount: Number(waiting.count || 0)
      };
    }

    const waitingRows =
      this.ctx.storage.sql
        .exec(
          `
          SELECT *
          FROM queue
          WHERE status = 'waiting'
          ORDER BY joined_at ASC
          LIMIT 4
          `
        )
        .toArray();

    const oldest =
      waitingRows[0]?.joined_at || Date.now();

    const shouldMatch =
      waitingRows.length >= MATCH_SIZE ||
      (
        waitingRows.length > 0 &&
        Date.now() - oldest >= WAIT_MS
      );

    if (shouldMatch) {
      const match =
        this.makeMatch(waitingRows);

      const matched =
        match.players.find(
          p => p.id === id
        );

      if (matched) {
        return {
          status: "matched",
          ...match,
          host: matched.host,
          team: matched.team,
          queueCount: 0
        };
      }
    }

    const position =
      waitingRows.findIndex(
        p => p.id === id
      );

    return {
      status: "waiting",
      position:
        position >= 0
          ? position + 1
          : 1,
      queueCount:
        waitingRows.length,
      waitedMs:
        Date.now() - Number(row.joined_at)
    };
  }

  async leave(id) {
    this.ctx.storage.sql.exec(
      `
      DELETE FROM queue
      WHERE id = ?
      `,
      id
    );

    return {
      ok: true
    };
  }
}


/* =========================================================
   DRAWING ROOM
   REAL MULTIPLAYER ROOM
========================================================= */

export class DrawingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;

    /*
     * IMPORTANT:
     *
     * We now use Cloudflare's Durable Object
     * Hibernation WebSocket API.
     *
     * This is different from:
     *
     * server.accept()
     *
     * and avoids keeping a fragile in-memory
     * Set of sockets.
     */
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        "ping",
        "pong"
      )
    );

    this.ctx.blockConcurrencyWhile(async () => {
      const existing =
        await this.ctx.storage.get(
          "drawingState"
        );

      if (!existing) {
        await this.ctx.storage.put(
          "drawingState",
          this.defaultState()
        );
      }
    });
  }

  defaultState() {
    return {
      round: 0,
      totalRounds: 0,

      drawerId: null,
      drawerName: null,

      strokes: [],

      version: 0,

      started: false,
      finished: false,

      players: [],

      createdAt: Date.now()
    };
  }

  async getState() {
    return (
      await this.ctx.storage.get(
        "drawingState"
      )
    ) || this.defaultState();
  }

  async saveState(state) {
    state.version = Date.now();

    await this.ctx.storage.put(
      "drawingState",
      state
    );
  }

  async broadcast(message) {
    const encoded =
      JSON.stringify(message);

    for (
      const socket of
      this.ctx.getWebSockets()
    ) {
      try {
        socket.send(encoded);
      } catch {
        try {
          socket.close();
        } catch {}
      }
    }
  }

  async sendTo(socket, message) {
    try {
      socket.send(
        JSON.stringify(message)
      );
    } catch {}
  }

  async updatePresence() {
    const state =
      await this.getState();

    const players =
      this.ctx.getWebSockets()
        .map(ws => {
          try {
            return ws.deserializeAttachment();
          } catch {
            return null;
          }
        })
        .filter(Boolean);

    state.players = players;

    await this.saveState(state);

    await this.broadcast({
      type: "players",
      players
    });
  }

  async fetch(request) {
    const url =
      new URL(request.url);

    /*
     * ==========================================
     * WEBSOCKET
     * ==========================================
     */

    const upgrade =
      request.headers.get("Upgrade");

    if (
      request.method === "GET" &&
      upgrade &&
      upgrade.toLowerCase() === "websocket"
    ) {
      const pair =
        new WebSocketPair();

      const client = pair[0];
      const server = pair[1];

      /*
       * THIS IS THE IMPORTANT FIX.
       *
       * Do NOT call:
       *
       * server.accept()
       *
       * Instead use:
       *
       * ctx.acceptWebSocket(server)
       */
      this.ctx.acceptWebSocket(server);

      const playerId =
        url.searchParams.get(
          "playerId"
        ) ||
        crypto.randomUUID();

      const playerName =
        (
          url.searchParams.get(
            "playerName"
          ) ||
          "Player"
        )
          .trim()
          .slice(0, 24);

      const team =
        url.searchParams.get(
          "team"
        ) || null;

      server.serializeAttachment({
        id: playerId,
        name: playerName,
        team,
        joinedAt: Date.now()
      });

      /*
       * Send current state immediately.
       */
      const state =
        await this.getState();

      await this.sendTo(server, {
        type: "state",
        state
      });

      /*
       * Tell the new player that the
       * connection is actually ready.
       */
      await this.sendTo(server, {
        type: "connected",
        playerId,
        room:
          url.pathname
            .split("/")
            .filter(Boolean)[1] || null
      });

      /*
       * Update everybody's player list.
       */
      await this.updatePresence();

      return new Response(
        null,
        {
          status: 101,
          webSocket: client
        }
      );
    }


    /*
     * ==========================================
     * OPTIONS
     * ==========================================
     */

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(
          request.headers.get("Origin") || ""
        )
      });
    }


    /*
     * ==========================================
     * GET STATE
     * ==========================================
     */

    if (
      request.method === "GET" &&
      url.pathname.endsWith("/state")
    ) {
      const state =
        await this.getState();

      return json({
        ok: true,
        state
      }, 200,
      request.headers.get("Origin") || "");
    }


    /*
     * ==========================================
     * ROUND
     * ==========================================
     */

    if (
      request.method === "POST" &&
      url.pathname.endsWith("/round")
    ) {
      let body = {};

      try {
        body = await request.json();
      } catch {}

      const state =
        await this.getState();

      if (
        body.round !== undefined
      ) {
        state.round =
          Number(body.round);
      }

      if (
        body.totalRounds !== undefined
      ) {
        state.totalRounds =
          Number(body.totalRounds);
      }

      if (
        body.drawerId !== undefined
      ) {
        state.drawerId =
          body.drawerId;
      }

      if (
        body.drawerName !== undefined
      ) {
        state.drawerName =
          body.drawerName;
      }

      state.strokes = [];
      state.started = true;
      state.finished = false;

      await this.saveState(state);

      await this.broadcast({
        type: "round",
        state
      });

      return json({
        ok: true,
        state
      }, 200,
      request.headers.get("Origin") || "");
    }


    /*
     * ==========================================
     * STROKE
     * ==========================================
     */

    if (
      request.method === "POST" &&
      url.pathname.endsWith("/stroke")
    ) {
      let stroke;

      try {
        stroke =
          await request.json();
      } catch {
        return json({
          ok: false,
          error: "Invalid stroke"
        }, 400,
        request.headers.get("Origin") || "");
      }

      const state =
        await this.getState();

      if (
        state.strokes.length >= 10000
      ) {
        state.strokes =
          state.strokes.slice(-9000);
      }

      state.strokes.push(stroke);

      await this.saveState(state);

      /*
       * Only send the new stroke.
       * This makes drawing much faster.
       */
      await this.broadcast({
        type: "stroke",
        stroke
      });

      return json({
        ok: true,
        version: state.version
      }, 200,
      request.headers.get("Origin") || "");
    }


    /*
     * ==========================================
     * CLEAR
     * ==========================================
     */

    if (
      request.method === "POST" &&
      url.pathname.endsWith("/clear")
    ) {
      const state =
        await this.getState();

      state.strokes = [];

      await this.saveState(state);

      await this.broadcast({
        type: "clear",
        version: state.version
      });

      return json({
        ok: true
      }, 200,
      request.headers.get("Origin") || "");
    }


    /*
     * ==========================================
     * FINISH
     * ==========================================
     */

    if (
      request.method === "POST" &&
      url.pathname.endsWith("/finish")
    ) {
      const state =
        await this.getState();

      state.finished = true;

      await this.saveState(state);

      await this.broadcast({
        type: "round_finished",
        round: state.round,
        version: state.version
      });

      return json({
        ok: true,
        round: state.round
      }, 200,
      request.headers.get("Origin") || "");
    }


    /*
     * ==========================================
     * DELETE ROOM
     * ==========================================
     */

    if (
      request.method === "POST" &&
      url.pathname.endsWith("/delete")
    ) {
      await this.ctx.storage.deleteAll();

      await this.broadcast({
        type: "room_deleted"
      });

      return json({
        ok: true
      }, 200,
      request.headers.get("Origin") || "");
    }


    /*
     * ==========================================
     * ROOM HEALTH
     * ==========================================
     */

    return json({
      ok: true,
      service: "drawing-room",
      websocket: true,
      connections:
        this.ctx.getWebSockets().length
    }, 200,
    request.headers.get("Origin") || "");
  }


  /*
   * ==========================================
   * WEBSOCKET MESSAGE
   * ==========================================
   */

  async webSocketMessage(ws, message) {
    let data;

    try {
      data =
        typeof message === "string"
          ? JSON.parse(message)
          : null;
    } catch {
      data = null;
    }

    if (!data) return;

    /*
     * Client can send:
     *
     * {type:"ping"}
     * {type:"hello"}
     */

    if (data.type === "ping") {
      try {
        ws.send(
          JSON.stringify({
            type: "pong"
          })
        );
      } catch {}
    }

    if (data.type === "hello") {
      const attachment =
        ws.deserializeAttachment();

      try {
        ws.send(
          JSON.stringify({
            type: "hello",
            player: attachment,
            connections:
              this.ctx.getWebSockets().length
          })
        );
      } catch {}
    }
  }


  /*
   * ==========================================
   * WEBSOCKET CLOSE
   * ==========================================
   */

  async webSocketClose(
    ws,
    code,
    reason,
    wasClean
  ) {
    /*
     * Remove this player's presence
     * and notify everyone.
     */

    const state =
      await this.getState();

    const players =
      this.ctx.getWebSockets()
        .filter(socket => socket !== ws)
        .map(socket => {
          try {
            return socket.deserializeAttachment();
          } catch {
            return null;
          }
        })
        .filter(Boolean);

    state.players = players;

    await this.saveState(state);

    await this.broadcast({
      type: "players",
      players
    });

    /*
     * Cloudflare automatically handles
     * the close response for hibernatable
     * WebSockets.
     */
  }


  async webSocketError(ws, error) {
    /*
     * Do not crash the room because one
     * player's browser/network had an error.
     */
    console.error(
      "Drawing WebSocket error:",
      error
    );
  }
}


/* =========================================================
   MAIN WORKER
========================================================= */

export default {
  async fetch(request, env) {
    const origin =
      request.headers.get("Origin") || "";

    /*
     * CORS
     */

    if (
      request.method === "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    const url =
      new URL(request.url);


    /*
     * ==========================================
     * DRAWING ROOMS
     * ==========================================
     *
     * /draw/ROOM
     * /draw/ROOM/state
     * /draw/ROOM/round
     * /draw/ROOM/stroke
     * /draw/ROOM/clear
     * /draw/ROOM/finish
     * /draw/ROOM/delete
     */

    if (
      url.pathname.startsWith("/draw/")
    ) {
      const roomName =
        url.pathname
          .slice("/draw/".length)
          .split("/")[0]
          .trim();

      if (!roomName) {
        return json({
          ok: false,
          error: "Room code required"
        }, 400, origin);
      }

      /*
       * IMPORTANT:
       *
       * Every player using the same room
       * gets the exact same Durable Object.
       */
      const id =
        env.DRAWING_ROOMS.idFromName(
          roomName.toUpperCase()
        );

      const room =
        env.DRAWING_ROOMS.get(id);

      /*
       * IMPORTANT:
       *
       * Return the DO response directly.
       * Do NOT convert the 101 WebSocket
       * response into JSON.
       */
      return room.fetch(request);
    }


    /*
     * ==========================================
     * CODENAMES MATCHMAKING
     * ==========================================
     */

    if (
      !url.pathname.startsWith(
        "/matchmaking"
      )
    ) {
      return json({
        ok: true,
        service: "codenames-matchmaking"
      }, 200, origin);
    }

    const id =
      env.MATCHMAKER.idFromName(
        "global-queue"
      );

    const stub =
      env.MATCHMAKER.get(id);

    try {

      /*
       * JOIN
       */

      if (
        url.pathname ===
          "/matchmaking/join" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const name =
          String(body?.name || "")
            .trim()
            .slice(0, 18);

        const playerId =
          String(
            body?.playerId || ""
          ).trim();

        if (!name || !playerId) {
          return json({
            error:
              "name and playerId are required"
          }, 400, origin);
        }

        return json(
          await stub.join({
            id: playerId,
            name
          }),
          200,
          origin
        );
      }


      /*
       * STATUS
       */

      if (
        url.pathname ===
          "/matchmaking/status" &&
        request.method === "GET"
      ) {
        const playerId =
          String(
            url.searchParams.get(
              "playerId"
            ) || ""
          ).trim();

        if (!playerId) {
          return json({
            error:
              "playerId is required"
          }, 400, origin);
        }

        return json(
          await stub.status(playerId),
          200,
          origin
        );
      }


      /*
       * LEAVE
       */

      if (
        url.pathname ===
          "/matchmaking/leave" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const playerId =
          String(
            body?.playerId || ""
          ).trim();

        if (!playerId) {
          return json({
            error:
              "playerId is required"
          }, 400, origin);
        }

        return json(
          await stub.leave(playerId),
          200,
          origin
        );
      }

      return json({
        error: "Not found"
      }, 404, origin);

    } catch (error) {
      console.error(
        "Matchmaking error:",
        error
      );

      return json({
        error:
          "Matchmaking server error"
      }, 500, origin);
    }
  }
};
