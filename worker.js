import { DurableObject } from "cloudflare:workers";

/* =========================================================
   CONFIG
========================================================= */

const MATCH_SIZE = 4;
const WAIT_MS = 15_000;
const STALE_MS = 90_000;
const MATCHED_RETENTION_MS = 10 * 60_000;

const MAX_PLAYERS = 20;
const MAX_STROKES = 12000;

/* =========================================================
   CORS
========================================================= */

function corsHeaders(origin = "") {
  const allowed =
    origin === "https://jrjboss.github.io" ||
    origin === "null" ||
    origin === "";

  return {
    "Access-Control-Allow-Origin":
      allowed ? origin || "*" : "https://jrjboss.github.io",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Allow-Credentials":
      "true",

    "Cache-Control":
      "no-store"
  };
}

function json(data, status = 200, origin = "") {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        ...corsHeaders(origin)
      }
    }
  );
}

/* =========================================================
   ROOM CODE
========================================================= */

function makeRoomCode() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let result = "";

  for (let i = 0; i < 5; i++) {
    result +=
      chars[
        Math.floor(
          Math.random() * chars.length
        )
      ];
  }

  return result;
}

/* =========================================================
   MATCHMAKER
   KEEPING THIS SEPARATE FROM DRAWING
========================================================= */

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;

    ctx.blockConcurrencyWhile(async () => {
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

    const matchId =
      crypto.randomUUID();

    const roomCode =
      makeRoomCode();

    const selected =
      waitingRows.slice(
        0,
        MATCH_SIZE
      );

    const players =
      selected.map(
        (row, index) => ({
          id: row.id,
          name: row.name,

          team:
            index % 2 === 0
              ? "red"
              : "blue",

          bot: false,
          host: index === 0
        })
      );

    while (
      players.length < MATCH_SIZE
    ) {
      const index =
        players.length;

      players.push({
        id:
          `bot-${matchId}-${index}`,

        name:
          `Codename Bot ${index}`,

        team:
          index % 2 === 0
            ? "red"
            : "blue",

        bot: true,
        host: false,
        difficulty:
          "normal"
      });
    }

    const payload =
      JSON.stringify({
        matchId,
        roomCode,
        players,
        createdAt: now
      });

    this.ctx.storage.transactionSync(
      () => {
        for (
          const player of
          players.filter(
            p => !p.bot
          )
        ) {
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
      }
    );

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
      return this.status(
        player.id
      );
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
      VALUES (
        ?,
        ?,
        ?,
        'waiting',
        ?
      )
      `,
      player.id,
      player.name,
      Date.now(),
      JSON.stringify(player)
    );

    return this.status(
      player.id
    );
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

    if (
      row.status === "matched" &&
      row.payload
    ) {
      const match =
        JSON.parse(
          row.payload
        );

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

        host:
          !!row.host,

        team:
          row.team,

        queueCount:
          Number(
            waiting.count || 0
          )
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
      waitingRows[0]?.joined_at ||
      Date.now();

    const shouldMatch =
      waitingRows.length >=
        MATCH_SIZE ||
      (
        waitingRows.length > 0 &&
        Date.now() -
          oldest >=
          WAIT_MS
      );

    if (shouldMatch) {
      const match =
        this.makeMatch(
          waitingRows
        );

      const matched =
        match.players.find(
          p =>
            p.id === id
        );

      if (matched) {
        return {
          status:
            "matched",

          ...match,

          host:
            matched.host,

          team:
            matched.team,

          queueCount:
            0
        };
      }
    }

    const position =
      waitingRows.findIndex(
        player =>
          player.id === id
      );

    return {
      status:
        "waiting",

      position:
        position >= 0
          ? position + 1
          : 1,

      queueCount:
        waitingRows.length,

      waitedMs:
        Date.now() -
        Number(
          row.joined_at
        )
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
========================================================= */

export class DrawingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    this.sockets =
      new Map();

    this.ctx.blockConcurrencyWhile(
      async () => {
        let state =
          await this.ctx.storage.get(
            "drawingState"
          );

        if (!state) {
          state =
            this.defaultState();

          await this.ctx.storage.put(
            "drawingState",
            state
          );
        }

        /* -------------------------------------------------
           Repair older room states.
        ------------------------------------------------- */

        state.players =
          Array.isArray(
            state.players
          )
            ? state.players
            : [];

        state.strokes =
          Array.isArray(
            state.strokes
          )
            ? state.strokes
            : [];

        state.round =
          Number(
            state.round || 0
          );

        state.totalRounds =
          Number(
            state.totalRounds || 0
          );

        state.version =
          Number(
            state.version || 0
          );

        await this.ctx.storage.put(
          "drawingState",
          state
        );
      }
    );
  }

  defaultState() {
    return {
      roomCode: null,

      players: [],

      round: 0,
      totalRounds: 0,

      drawerId: null,
      drawerName: null,

      category: null,
      word: null,

      strokes: [],

      version: 0,

      started: false,
      finished: false,

      createdAt:
        Date.now(),

      updatedAt:
        Date.now()
    };
  }

  async getState() {
    const state =
      await this.ctx.storage.get(
        "drawingState"
      );

    if (!state) {
      return this.defaultState();
    }

    return state;
  }

  async saveState(state) {
    state.version =
      Number(
        state.version || 0
      ) + 1;

    state.updatedAt =
      Date.now();

    await this.ctx.storage.put(
      "drawingState",
      state
    );

    return state;
  }

  /* =======================================================
     SOCKET HELPERS
  ======================================================= */

  send(socket, message) {
    try {
      socket.send(
        JSON.stringify(message)
      );

      return true;
    } catch {
      return false;
    }
  }

  broadcast(message) {
    const dead = [];

    for (
      const [socket, playerId]
      of this.sockets
    ) {
      const ok =
        this.send(
          socket,
          message
        );

      if (!ok) {
        dead.push(
          [socket, playerId]
        );
      }
    }

    for (
      const [socket, playerId]
      of dead
    ) {
      this.removeSocket(
        socket,
        playerId
      );
    }
  }

  removeSocket(socket, playerId) {
    try {
      socket.close();
    } catch {}

    this.sockets.delete(
      socket
    );

    /*
      IMPORTANT:
      We do not immediately delete
      the player from the room here.

      Browsers can temporarily lose
      WebSocket connections.

      The player remains in the lobby
      and can reconnect.
    */

    this.broadcastPlayers();
  }

  broadcastPlayers() {
    this.getState()
      .then(state => {
        this.broadcast({
          type:
            "players",

          players:
            state.players
        });
      })
      .catch(() => {});
  }

  /* =======================================================
     PLAYER MANAGEMENT
  ======================================================= */

  async addPlayer(player) {
    const state =
      await this.getState();

    if (
      !player ||
      !player.id
    ) {
      return state;
    }

    const id =
      String(
        player.id
      ).slice(
        0,
        100
      );

    const name =
      String(
        player.name ||
        "Player"
      )
        .trim()
        .slice(
          0,
          24
        );

    const existingIndex =
      state.players.findIndex(
        p =>
          p.id === id
      );

    if (
      existingIndex >= 0
    ) {
      state.players[
        existingIndex
      ] = {
        ...state.players[
          existingIndex
        ],

        name:
          name ||
          state.players[
            existingIndex
          ].name,

        online: true,

        lastSeen:
          Date.now()
      };
    } else {
      if (
        state.players.length >=
        MAX_PLAYERS
      ) {
        throw new Error(
          "Room is full"
        );
      }

      state.players.push({
        id,

        name:
          name ||
          "Player",

        team:
          player.team ||
          null,

        host:
          !!player.host,

        bot:
          !!player.bot,

        online:
          true,

        lastSeen:
          Date.now()
      });
    }

    await this.saveState(
      state
    );

    this.broadcast({
      type:
        "players",

      players:
        state.players
    });

    return state;
  }

  async markOffline(playerId) {
    if (!playerId) return;

    const state =
      await this.getState();

    const player =
      state.players.find(
        p =>
          p.id === playerId
      );

    if (!player) return;

    player.online =
      false;

    player.lastSeen =
      Date.now();

    await this.saveState(
      state
    );

    this.broadcast({
      type:
        "players",

      players:
        state.players
    });
  }

  async removePlayer(playerId) {
    if (!playerId) {
      return;
    }

    const state =
      await this.getState();

    state.players =
      state.players.filter(
        p =>
          p.id !== playerId
      );

    await this.saveState(
      state
    );

    this.broadcast({
      type:
        "players",

      players:
        state.players
    });
  }

  /* =======================================================
     REQUEST HANDLER
  ======================================================= */

  async fetch(request) {
    const origin =
      request.headers.get(
        "Origin"
      ) || "";

    const url =
      new URL(
        request.url
      );

    /* =====================================================
       CORS
    ===================================================== */

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,

          headers:
            corsHeaders(
              origin
            )
        }
      );
    }

    /* =====================================================
       WEBSOCKET
       
       THIS MUST BE BEFORE NORMAL
       HTTP ROUTES.
    ===================================================== */

    const upgrade =
      request.headers
        .get("Upgrade");

    if (
      upgrade &&
      upgrade.toLowerCase() ===
        "websocket"
    ) {
      return this.handleWebSocket(
        request
      );
    }

    /* =====================================================
       STATE
       
       GET /draw/ROOM/state
    ===================================================== */

    if (
      request.method ===
        "GET" &&
      url.pathname.endsWith(
        "/state"
      )
    ) {
      const state =
        await this.getState();

      return json(
        {
          ok: true,

          state
        },

        200,

        origin
      );
    }

    /* =====================================================
       JOIN ROOM
       
       POST /draw/ROOM/join
    ===================================================== */

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/join"
      )
    ) {
      let body = {};

      try {
        body =
          await request.json();
      } catch {}

      try {
        const state =
          await this.addPlayer(
            body
          );

        return json(
          {
            ok: true,

            state
          },

          200,

          origin
        );
      } catch (error) {
        return json(
          {
            ok: false,

            error:
              error?.message ||
              "Unable to join room"
          },

          400,

          origin
        );
      }
    }

    /* =====================================================
       LEAVE ROOM
       
       POST /draw/ROOM/leave
    ===================================================== */

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/leave"
      )
    ) {
      let body = {};

      try {
        body =
          await request.json();
      } catch {}

      await this.removePlayer(
        body.playerId
      );

      return json(
        {
          ok: true
        },

        200,

        origin
      );
    }

    /* =====================================================
       START / ROUND
       
       POST /draw/ROOM/round
    ===================================================== */

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/round"
      )
    ) {
      let body = {};

      try {
        body =
          await request.json();
      } catch {}

      const state =
        await this.getState();

      if (
        body.roomCode !==
        undefined
      ) {
        state.roomCode =
          body.roomCode;
      }

      if (
        body.round !==
        undefined
      ) {
        state.round =
          Number(
            body.round
          );
      }

      if (
        body.totalRounds !==
        undefined
      ) {
        state.totalRounds =
          Number(
            body.totalRounds
          );
      }

      if (
        body.drawerId !==
        undefined
      ) {
        state.drawerId =
          body.drawerId;
      }

      if (
        body.drawerName !==
        undefined
      ) {
        state.drawerName =
          body.drawerName;
      }

      if (
        body.category !==
        undefined
      ) {
        state.category =
          body.category;
      }

      if (
        body.word !==
        undefined
      ) {
        state.word =
          body.word;
      }

      state.strokes =
        [];

      state.started =
        true;

      state.finished =
        false;

      await this.saveState(
        state
      );

      this.broadcast({
        type:
          "round",

        state
      });

      return json(
        {
          ok: true,

          state
        },

        200,

        origin
      );
    }

    /* =====================================================
       STROKE
       
       POST /draw/ROOM/stroke
    ===================================================== */

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/stroke"
      )
    ) {
      let stroke;

      try {
        stroke =
          await request.json();
      } catch {
        return json(
          {
            ok: false,

            error:
              "Invalid stroke"
          },

          400,

          origin
        );
      }

      const state =
        await this.getState();

      state.strokes.push(
        stroke
      );

      if (
        state.strokes.length >
        MAX_STROKES
      ) {
        state.strokes =
          state.strokes.slice(
            -MAX_STROKES
          );
      }

      await this.saveState(
        state
      );

      /*
        Send only the new stroke.
      */

      this.broadcast({
        type:
          "stroke",

        stroke,

        version:
          state.version
      });

      return json(
        {
          ok: true,

          version:
            state.version
        },

        200,

        origin
      );
    }

    /* =====================================================
       CLEAR
       
       POST /draw/ROOM/clear
    ===================================================== */

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/clear"
      )
    ) {
      const state =
        await this.getState();

      state.strokes =
        [];

      await this.saveState(
        state
      );

      this.broadcast({
        type:
          "clear",

        version:
          state.version
      });

      return json(
        {
          ok: true
        },

        200,

        origin
      );
    }

    /* =====================================================
       FINISH
       
       POST /draw/ROOM/finish
    ===================================================== */

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/finish"
      )
    ) {
      const state =
        await this.getState();

      state.finished =
        true;

      await this.saveState(
        state
      );

      this.broadcast({
        type:
          "round_finished",

        round:
          state.round,

        version:
          state.version
      });

      return json(
        {
          ok: true,

          round:
            state.round
        },

        200,

        origin
      );
    }

    /* =====================================================
       DELETE ROOM
       
       POST /draw/ROOM/delete
    ===================================================== */

    if (
      request.method ===
        "POST" &&
      url.pathname.endsWith(
        "/delete"
      )
    ) {
      /*
        Delete DRAWING ROOM DATA ONLY.

        MATCHMAKER IS NOT TOUCHED.
      */

      this.broadcast({
        type:
          "room_deleted"
      });

      await this.ctx.storage.deleteAll();

      return json(
        {
          ok: true
        },

        200,

        origin
      );
    }

    return json(
      {
        ok: true,

        service:
          "drawing-room",

        room:
          url.pathname
      },

      200,

      origin
    );
  }

  /* =======================================================
     WEBSOCKET HANDLER
  ======================================================= */

  async handleWebSocket(request) {
    const url =
      new URL(
        request.url
      );

    const playerId =
      String(
        url.searchParams.get(
          "playerId"
        ) || ""
      ).trim();

    const playerName =
      String(
        url.searchParams.get(
          "playerName"
        ) || ""
      ).trim();

    const team =
      String(
        url.searchParams.get(
          "team"
        ) || ""
      ).trim();

    const host =
      url.searchParams.get(
        "host"
      ) === "1";

    /*
      IMPORTANT:
      Do not create a WebSocket if
      there is no player ID.
    */

    if (!playerId) {
      return new Response(
        "playerId is required",
        {
          status: 400
        }
      );
    }

    const pair =
      new WebSocketPair();

    const client =
      pair[0];

    const server =
      pair[1];

    /*
      Accept the SERVER side.
    */

    server.accept();

    /*
      Store socket.
    */

    this.sockets.set(
      server,
      playerId
    );

    /*
      Register/update player.
    */

    try {
      await this.addPlayer({
        id:
          playerId,

        name:
          playerName ||
          "Player",

        team:
          team || null,

        host,

        bot:
          false
      });
    } catch {}

    /*
      Immediately send complete
      room state to THIS player.
    */

    const state =
      await this.getState();

    this.send(
      server,
      {
        type:
          "connected",

        playerId,

        state
      }
    );

    /*
      Also send player list.
    */

    this.send(
      server,
      {
        type:
          "players",

        players:
          state.players
      }
    );

    /*
      Socket messages from client.
    */

    server.addEventListener(
      "message",
      async event => {
        await this.handleSocketMessage(
          server,
          playerId,
          event
        );
      }
    );

    server.addEventListener(
      "close",
      async () => {
        this.sockets.delete(
          server
        );

        await this.markOffline(
          playerId
        );
      }
    );

    server.addEventListener(
      "error",
      async () => {
        this.sockets.delete(
          server
        );

        await this.markOffline(
          playerId
        );
      }
    );

    /*
      RETURN THE CLIENT SIDE.

      This is critical for the browser
      WebSocket handshake.
    */

    return new Response(
      null,
      {
        status: 101,

        webSocket:
          client
      }
    );
  }

  /* =======================================================
     WEBSOCKET MESSAGE ROUTER
  ======================================================= */

  async handleSocketMessage(
    socket,
    playerId,
    event
  ) {
    let message;

    try {
      if (
        typeof event.data ===
        "string"
      ) {
        message =
          JSON.parse(
            event.data
          );
      } else {
        return;
      }
    } catch {
      this.send(
        socket,
        {
          type:
            "error",

          error:
            "Invalid message"
        }
      );

      return;
    }

    if (
      !message ||
      typeof message.type !==
        "string"
    ) {
      return;
    }

    /* -----------------------------------------------------
       PING
    ----------------------------------------------------- */

    if (
      message.type ===
      "ping"
    ) {
      this.send(
        socket,
        {
          type:
            "pong",

          time:
            Date.now()
        }
      );

      return;
    }

    /* -----------------------------------------------------
       PLAYER UPDATE
    ----------------------------------------------------- */

    if (
      message.type ===
      "player"
    ) {
      await this.addPlayer({
        id:
          playerId,

        name:
          message.name,

        team:
          message.team,

        host:
          !!message.host,

        bot:
          false
      });

      return;
    }

    /* -----------------------------------------------------
       STROKE THROUGH WEBSOCKET
    ----------------------------------------------------- */

    if (
      message.type ===
      "stroke"
    ) {
      const state =
        await this.getState();

      const stroke =
        message.stroke ||
        message.data;

      if (!stroke) {
        return;
      }

      state.strokes.push(
        stroke
      );

      if (
        state.strokes.length >
        MAX_STROKES
      ) {
        state.strokes =
          state.strokes.slice(
            -MAX_STROKES
          );
      }

      await this.saveState(
        state
      );

      this.broadcast({
        type:
          "stroke",

        stroke,

        playerId,

        version:
          state.version
      });

      return;
    }

    /* -----------------------------------------------------
       CLEAR THROUGH WEBSOCKET
    ----------------------------------------------------- */

    if (
      message.type ===
      "clear"
    ) {
      const state =
        await this.getState();

      state.strokes =
        [];

      await this.saveState(
        state
      );

      this.broadcast({
        type:
          "clear",

        playerId,

        version:
          state.version
      });

      return;
    }

    /* -----------------------------------------------------
       ROUND THROUGH WEBSOCKET
    ----------------------------------------------------- */

    if (
      message.type ===
      "round"
    ) {
      const state =
        await this.getState();

      const data =
        message.state ||
        message;

      if (
        data.round !==
        undefined
      ) {
        state.round =
          Number(
            data.round
          );
      }

      if (
        data.totalRounds !==
        undefined
      ) {
        state.totalRounds =
          Number(
            data.totalRounds
          );
      }

      if (
        data.drawerId !==
        undefined
      ) {
        state.drawerId =
          data.drawerId;
      }

      if (
        data.drawerName !==
        undefined
      ) {
        state.drawerName =
          data.drawerName;
      }

      if (
        data.category !==
        undefined
      ) {
        state.category =
          data.category;
      }

      if (
        data.word !==
        undefined
      ) {
        state.word =
          data.word;
      }

      state.strokes =
        [];

      state.started =
        true;

      state.finished =
        false;

      await this.saveState(
        state
      );

      this.broadcast({
        type:
          "round",

        state
      });

      return;
    }

    /* -----------------------------------------------------
       FINISH THROUGH WEBSOCKET
    ----------------------------------------------------- */

    if (
      message.type ===
      "finish"
    ) {
      const state =
        await this.getState();

      state.finished =
        true;

      await this.saveState(
        state
      );

      this.broadcast({
        type:
          "round_finished",

        round:
          state.round,

        version:
          state.version
      });

      return;
    }
  }
}

/* =========================================================
   MAIN WORKER
========================================================= */

export default {
  async fetch(
    request,
    env
  ) {
    const origin =
      request.headers.get(
        "Origin"
      ) || "";

    /* =====================================================
       CORS
    ===================================================== */

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,

          headers:
            corsHeaders(
              origin
            )
        }
      );
    }

    const url =
      new URL(
        request.url
      );

    /* =====================================================
       DRAWING ROOMS

       /draw/ROOM
       /draw/ROOM/state
       /draw/ROOM/join
       /draw/ROOM/leave
       /draw/ROOM/round
       /draw/ROOM/stroke
       /draw/ROOM/clear
       /draw/ROOM/finish
       /draw/ROOM/delete
    ===================================================== */

    if (
      url.pathname.startsWith(
        "/draw/"
      )
    ) {
      const roomCode =
        url.pathname
          .slice(
            "/draw/".length
          )
          .split("/")[0]
          .trim();

      if (!roomCode) {
        return json(
          {
            ok: false,

            error:
              "Drawing room is required"
          },

          400,

          origin
        );
      }

      const id =
        env.DRAWING_ROOMS.idFromName(
          roomCode
        );

      const room =
        env.DRAWING_ROOMS.get(
          id
        );

      /*
        Pass the ORIGINAL request to
        the Durable Object.

        This is important for WebSocket
        Upgrade requests.
      */

      return room.fetch(
        request
      );
    }

    /* =====================================================
       EXISTING MATCHMAKING

       NOTHING ABOVE CHANGES THIS.
    ===================================================== */

    if (
      !url.pathname.startsWith(
        "/matchmaking"
      )
    ) {
      return json(
        {
          ok: true,

          service:
            "codenames-matchmaking"
        },

        200,

        origin
      );
    }

    const id =
      env.MATCHMAKER.idFromName(
        "global-queue"
      );

    const stub =
      env.MATCHMAKER.get(
        id
      );

    try {
      /* ---------------------------------------------------
         JOIN
      --------------------------------------------------- */

      if (
        url.pathname ===
          "/matchmaking/join" &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        const name =
          String(
            body?.name || ""
          )
            .trim()
            .slice(
              0,
              18
            );

        const playerId =
          String(
            body?.playerId ||
              ""
          ).trim();

        if (
          !name ||
          !playerId
        ) {
          return json(
            {
              error:
                "name and playerId are required"
            },

            400,

            origin
          );
        }

        return json(
          await stub.join({
            id:
              playerId,

            name
          }),

          200,

          origin
        );
      }

      /* ---------------------------------------------------
         STATUS
      --------------------------------------------------- */

      if (
        url.pathname ===
          "/matchmaking/status" &&
        request.method ===
          "GET"
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

        return json(
          await stub.status(
            playerId
          ),

          200,

          origin
        );
      }

      /* ---------------------------------------------------
         LEAVE
      --------------------------------------------------- */

      if (
        url.pathname ===
          "/matchmaking/leave" &&
        request.method ===
          "POST"
      ) {
        const body =
          await request.json();

        const playerId =
          String(
            body?.playerId ||
              ""
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

        return json(
          await stub.leave(
            playerId
          ),

          200,

          origin
        );
      }

      return json(
        {
          error:
            "Not found"
        },

        404,

        origin
      );
    } catch (error) {
      console.error(
        "MATCHMAKER ERROR:",
        error
      );

      return json(
        {
          error:
            "Matchmaking server error"
        },

        500,

        origin
      );
    }
  }
};
