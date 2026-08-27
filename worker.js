import { DurableObject } from "cloudflare:workers";

/* =========================================================
   CONFIG
========================================================= */

const MATCH_SIZE = 4;
const WAIT_MS = 15_000;
const STALE_MS = 90_000;
const MATCHED_RETENTION_MS = 10 * 60_000;

const MAX_WS_MESSAGE = 250_000;

/* =========================================================
   CORS
========================================================= */

function corsHeaders(origin = "") {
  const allowed =
    !origin ||
    origin === "null" ||
    origin.endsWith(".github.io") ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:");

  return {
    "Access-Control-Allow-Origin": allowed
      ? origin || "*"
      : "https://jrjboss.github.io",

    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
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

/* =========================================================
   ROOM CODE
========================================================= */

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let out = "";

  for (let i = 0; i < 5; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

/* =========================================================
   MATCHMAKER
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

  makeMatch(waitingRows) {
    const now = Date.now();
    const matchId = crypto.randomUUID();
    const roomCode = makeRoomCode();

    const selected = waitingRows.slice(0, MATCH_SIZE);

    const players = selected.map((row, index) => ({
      id: row.id,
      name: row.name,
      team: index % 2 === 0 ? "red" : "blue",
      bot: false,
      host: index === 0
    }));

    while (players.length < MATCH_SIZE) {
      const index = players.length;

      players.push({
        id: `bot-${matchId}-${index}`,
        name: `Codename Bot ${index}`,
        team: index % 2 === 0 ? "red" : "blue",
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
          SET
            status = 'matched',
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

    const existing = this.ctx.storage.sql
      .exec("SELECT * FROM queue WHERE id = ?", player.id)
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

    const row = this.ctx.storage.sql
      .exec(
        "SELECT * FROM queue WHERE id = ?",
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

      const waiting = this.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM queue WHERE status = 'waiting'"
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

    const waitingRows = this.ctx.storage.sql
      .exec(`
        SELECT *
        FROM queue
        WHERE status = 'waiting'
        ORDER BY joined_at ASC
        LIMIT 4
      `)
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
      const match = this.makeMatch(waitingRows);

      const matched = match.players.find(
        player => player.id === id
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

    const position = waitingRows.findIndex(
      player => player.id === id
    );

    return {
      status: "waiting",
      position: position >= 0 ? position + 1 : 1,
      queueCount: waitingRows.length,
      waitedMs:
        Date.now() - Number(row.joined_at)
    };
  }

  async leave(id) {
    this.ctx.storage.sql.exec(
      "DELETE FROM queue WHERE id = ?",
      id
    );

    return {
      ok: true
    };
  }
}

/* =========================================================
   DRAWING ROOM
========================================================= */

export class DrawingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.clients = new Map();

    this.ctx.blockConcurrencyWhile(async () => {
      const stored =
        await this.ctx.storage.get("roomState");

      this.roomState = stored || {
        roomCode: "",
        players: {},
        drawing: [],
        round: 1,
        totalRounds: 4,
        word: "",
        drawerId: null,
        started: false
      };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(
          request.headers.get("Origin") || ""
        )
      });
    }

    if (url.pathname === "/state") {
      return json(this.roomState);
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        room: this.roomState.roomCode,
        players: Object.keys(this.roomState.players || {}).length
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({
        ok: true,
        service: "drawing-room",
        websocket: true
      });
    }

    const playerId =
      url.searchParams.get("playerId") ||
      crypto.randomUUID();

    const playerName =
      url.searchParams.get("name") ||
      "Player";

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    server.accept();

    const connection = {
      socket: server,
      playerId,
      playerName,
      connectedAt: Date.now()
    };

    this.clients.set(playerId, connection);

    /* -----------------------------------------
       PLAYER JOINED
    ----------------------------------------- */

    if (!this.roomState.players[playerId]) {
      this.roomState.players[playerId] = {
        id: playerId,
        name: playerName,
        connected: true
      };

      await this.saveState();
    } else {
      this.roomState.players[playerId].connected = true;
      await this.saveState();
    }

    server.send(
      JSON.stringify({
        type: "room_state",
        state: this.roomState
      })
    );

    this.broadcast(
      {
        type: "player_joined",
        player: this.roomState.players[playerId]
      },
      playerId
    );

    /* -----------------------------------------
       MESSAGE
    ----------------------------------------- */

    server.addEventListener("message", async event => {
      try {
        let raw = event.data;

        if (typeof raw !== "string") {
          return;
        }

        if (raw.length > MAX_WS_MESSAGE) {
          server.send(
            JSON.stringify({
              type: "error",
              message: "Drawing message is too large."
            })
          );

          return;
        }

        let message;

        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }

        await this.handleMessage(
          playerId,
          message
        );
      } catch (error) {
        console.error(
          "Drawing message error:",
          error
        );
      }
    });

    /* -----------------------------------------
       CLOSE
    ----------------------------------------- */

    server.addEventListener("close", async () => {
      this.clients.delete(playerId);

      if (this.roomState.players[playerId]) {
        this.roomState.players[playerId].connected =
          false;

        await this.saveState();
      }

      this.broadcast({
        type: "player_left",
        playerId
      });
    });

    server.addEventListener("error", () => {
      this.clients.delete(playerId);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async handleMessage(playerId, message) {
    if (!message || typeof message !== "object") {
      return;
    }

    const type = message.type;

    /* -----------------------------------------
       PING
    ----------------------------------------- */

    if (type === "ping") {
      const client = this.clients.get(playerId);

      if (client) {
        client.socket.send(
          JSON.stringify({
            type: "pong",
            time: Date.now()
          })
        );
      }

      return;
    }

    /* -----------------------------------------
       PLAYER UPDATE
    ----------------------------------------- */

    if (type === "player_update") {
      if (this.roomState.players[playerId]) {
        this.roomState.players[playerId] = {
          ...this.roomState.players[playerId],
          ...message.player,
          id: playerId
        };

        await this.saveState();

        this.broadcast({
          type: "player_update",
          player: this.roomState.players[playerId]
        });
      }

      return;
    }

    /* -----------------------------------------
       DRAW STROKE
    ----------------------------------------- */

    if (
      type === "draw" ||
      type === "stroke" ||
      type === "drawing"
    ) {
      const stroke = {
        ...message,
        playerId,
        time: Date.now()
      };

      /*
       * Do NOT store unlimited drawing data.
       * The browser sends individual strokes instead
       * of gigantic canvas/data URLs.
       */

      if (!Array.isArray(this.roomState.drawing)) {
        this.roomState.drawing = [];
      }

      this.roomState.drawing.push(stroke);

      /*
       * Keep the room from becoming gigantic.
       */
      if (this.roomState.drawing.length > 5000) {
        this.roomState.drawing =
          this.roomState.drawing.slice(-5000);
      }

      this.broadcast(stroke, playerId);

      await this.saveState();

      return;
    }

    /* -----------------------------------------
       CLEAR CANVAS
    ----------------------------------------- */

    if (type === "clear") {
      this.roomState.drawing = [];

      await this.saveState();

      this.broadcast({
        type: "clear",
        playerId
      });

      return;
    }

    /* -----------------------------------------
       UNDO
    ----------------------------------------- */

    if (type === "undo") {
      if (this.roomState.drawing.length) {
        this.roomState.drawing.pop();
      }

      await this.saveState();

      this.broadcast({
        type: "undo",
        playerId
      });

      return;
    }

    /* -----------------------------------------
       ROUND UPDATE
    ----------------------------------------- */

    if (type === "round_update") {
      this.roomState.round =
        Number(message.round || 1);

      this.roomState.totalRounds =
        Number(message.totalRounds || 4);

      this.roomState.drawerId =
        message.drawerId || null;

      this.roomState.word =
        message.word || "";

      this.roomState.drawing = [];

      await this.saveState();

      this.broadcast({
        type: "round_update",
        round: this.roomState.round,
        totalRounds: this.roomState.totalRounds,
        drawerId: this.roomState.drawerId
      });

      return;
    }

    /* -----------------------------------------
       GAME MESSAGE
    ----------------------------------------- */

    if (
      type === "guess" ||
      type === "correct_guess" ||
      type === "game_update" ||
      type === "timer" ||
      type === "score" ||
      type === "chat"
    ) {
      this.broadcast({
        ...message,
        playerId
      });

      return;
    }

    /* -----------------------------------------
       GENERIC RELAY
    ----------------------------------------- */

    /*
     * This lets your existing frontend continue
     * working even if it has custom message types.
     */
    this.broadcast(
      {
        ...message,
        playerId
      },
      playerId
    );
  }

  broadcast(message, exceptPlayerId = null) {
    let data;

    try {
      data = JSON.stringify(message);
    } catch {
      return;
    }

    if (data.length > MAX_WS_MESSAGE) {
      console.warn(
        "Skipping oversized websocket message:",
        data.length
      );

      return;
    }

    for (const [id, connection] of this.clients) {
      if (id === exceptPlayerId) {
        continue;
      }

      try {
        connection.socket.send(data);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  async saveState() {
    /*
     * Never let a broken/huge drawing state kill
     * the Durable Object.
     */

    try {
      const copy = {
        ...this.roomState,
        drawing: Array.isArray(this.roomState.drawing)
          ? this.roomState.drawing.slice(-5000)
          : []
      };

      const serialized =
        JSON.stringify(copy);

      if (
        serialized.length <
        1_500_000
      ) {
        await this.ctx.storage.put(
          "roomState",
          copy
        );
      }
    } catch (error) {
      console.error(
        "Could not save room:",
        error
      );
    }
  }
}

/* =========================================================
   MAIN WORKER
========================================================= */

const worker = {
  async fetch(request, env) {
    const origin =
      request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    const url = new URL(request.url);

    /* =========================================
       DRAWING WEBSOCKET
    ========================================= */

    if (url.pathname.startsWith("/draw/")) {
      const parts =
        url.pathname.split("/").filter(Boolean);

      const roomCode =
        String(parts[1] || "")
          .trim()
          .toUpperCase();

      if (!roomCode) {
        return json(
          {
            error: "Room code is required"
          },
          400,
          origin
        );
      }

      const roomId =
        env.DRAWING_ROOMS.idFromName(
          roomCode
        );

      const room =
        env.DRAWING_ROOMS.get(roomId);

      /*
       * IMPORTANT:
       * Pass the original request through to
       * the Durable Object so WebSocket upgrade
       * works correctly.
       */
      return room.fetch(request);
    }

    /* =========================================
       MATCHMAKING
    ========================================= */

    if (
      url.pathname === "/matchmaking/join" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const name =
          String(body?.name || "")
            .trim()
            .slice(0, 18);

        const playerId =
          String(body?.playerId || "")
            .trim();

        if (!name || !playerId) {
          return json(
            {
              error:
                "name and playerId are required"
            },
            400,
            origin
          );
        }

        const id =
          env.MATCHMAKER.idFromName(
            "global-queue"
          );

        const stub =
          env.MATCHMAKER.get(id);

        return json(
          await stub.join({
            id: playerId,
            name
          }),
          200,
          origin
        );
      } catch (error) {
        console.error(error);

        return json(
          {
            error:
              "Invalid matchmaking request"
          },
          400,
          origin
        );
      }
    }

    /* =========================================
       MATCHMAKING STATUS
    ========================================= */

    if (
      url.pathname === "/matchmaking/status" &&
      request.method === "GET"
    ) {
      const playerId =
        String(
          url.searchParams.get(
            "playerId"
          ) || ""
        ).trim();

      if (!playerId) {
        return json(
          {
            error:
              "playerId is required"
          },
          400,
          origin
        );
      }

      const id =
        env.MATCHMAKER.idFromName(
          "global-queue"
        );

      const stub =
        env.MATCHMAKER.get(id);

      return json(
        await stub.status(playerId),
        200,
        origin
      );
    }

    /* =========================================
       MATCHMAKING LEAVE
    ========================================= */

    if (
      url.pathname === "/matchmaking/leave" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const playerId =
          String(
            body?.playerId || ""
          ).trim();

        if (!playerId) {
          return json(
            {
              error:
                "playerId is required"
            },
            400,
            origin
          );
        }

        const id =
          env.MATCHMAKER.idFromName(
            "global-queue"
          );

        const stub =
          env.MATCHMAKER.get(id);

        return json(
          await stub.leave(playerId),
          200,
          origin
        );
      } catch (error) {
        console.error(error);

        return json(
          {
            error:
              "Invalid leave request"
          },
          400,
          origin
        );
      }
    }

    /* =========================================
       HEALTH CHECK
    ========================================= */

    if (url.pathname === "/health") {
      return json(
        {
          ok: true,
          service:
            "codenames-matchmaking",
          drawingWebSocket: true,
          matchmaking: true,
          timestamp: Date.now()
        },
        200,
        origin
      );
    }

    /* =========================================
       ROOT
    ========================================= */

    return json(
      {
        ok: true,
        service:
          "codenames-matchmaking",
        endpoints: {
          matchmaking:
            "/matchmaking/join",
          status:
            "/matchmaking/status",
          leave:
            "/matchmaking/leave",
          drawing:
            "/draw/ROOMCODE",
          health:
            "/health"
        }
      },
      200,
      origin
    );
  }
};

export default worker;
