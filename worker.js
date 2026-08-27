import { DurableObject } from "cloudflare:workers";

const MATCH_SIZE = 4;
const WAIT_MS = 15_000;
const STALE_MS = 90_000;
const MATCHED_RETENTION_MS = 10 * 60_000;

/* =========================================================
   CORS
========================================================= */

function corsHeaders(origin) {
  const allowed =
    origin === "https://jrjboss.github.io" ||
    origin === "null" ||
    !origin;

  return {
    "Access-Control-Allow-Origin": allowed
      ? origin || "*"
      : "https://jrjboss.github.io",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

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

  let out = "";

  for (let i = 0; i < 5; i++) {
    out += chars[
      Math.floor(
        Math.random() * chars.length
      )
    ];
  }

  return out;
}

/* =========================================================
   EXISTING MATCHMAKER
   DO NOT CHANGE THE MATCHMAKING LOGIC
========================================================= */

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

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
    const cutoff =
      Date.now() - STALE_MS;

    this.ctx.storage.sql.exec(
      `
      DELETE FROM queue
      WHERE status = 'waiting'
      AND joined_at < ?
      `,
      cutoff
    );

    this.ctx.storage.sql.exec(
      `
      DELETE FROM queue
      WHERE status = 'matched'
      AND joined_at < ?
      `,
      Date.now() -
        MATCHED_RETENTION_MS
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
      players.length <
      MATCH_SIZE
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
        host: !!row.host,
        team: row.team,
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
          player =>
            player.id === id
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
        player =>
          player.id === id
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
        Date.now() -
        Number(row.joined_at)
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
    this.connections = new Set();

    this.ctx.blockConcurrencyWhile(
      async () => {
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
      }
    );
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
      finished: false
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
    state.version =
      Date.now();

    await this.ctx.storage.put(
      "drawingState",
      state
    );
  }

  broadcast(message) {
    const encoded =
      JSON.stringify(message);

    for (
      const socket of
      this.connections
    ) {
      try {
        socket.send(encoded);
      } catch {
        this.connections.delete(
          socket
        );
      }
    }
  }

  async fetch(request) {
    const origin =
      request.headers.get(
        "Origin"
      ) || "";

    const url =
      new URL(request.url);

    /* -------------------------
       CORS
    ------------------------- */

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

    /* -------------------------
       GET STATE
    ------------------------- */

    if (
      url.pathname.endsWith(
        "/state"
      ) &&
      request.method === "GET"
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

    /* -------------------------
       START / UPDATE ROUND
    ------------------------- */

    if (
      url.pathname.endsWith(
        "/round"
      ) &&
      request.method === "POST"
    ) {
      let body = {};

      try {
        body =
          await request.json();
      } catch {
        body = {};
      }

      const state =
        await this.getState();

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

      state.strokes = [];
      state.started = true;
      state.finished = false;

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

    /* -------------------------
       ADD STROKE
    ------------------------- */

    if (
      url.pathname.endsWith(
        "/stroke"
      ) &&
      request.method === "POST"
    ) {
      let stroke;

      try {
        stroke =
          await request.json();
      } catch {
        return json(
          {
            error:
              "Invalid stroke"
          },
          400,
          origin
        );
      }

      const state =
        await this.getState();

      /*
       IMPORTANT:

       Strokes are stored separately
       from matchmaking.

       The Matchmaker JSON is never
       touched by drawing data.
      */

      state.strokes.push(
        stroke
      );

      /*
       Prevent a broken client from
       accidentally filling the DO
       forever.
      */

      if (
        state.strokes.length >
        10000
      ) {
        state.strokes =
          state.strokes.slice(
            -10000
          );
      }

      await this.saveState(
        state
      );

      /*
       Send ONLY the new stroke
       to connected players.

       We do NOT send the entire
       drawing state every time.
      */

      this.broadcast({
        type:
          "stroke",
        stroke
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

    /* -------------------------
       CLEAR CANVAS
    ------------------------- */

    if (
      url.pathname.endsWith(
        "/clear"
      ) &&
      request.method === "POST"
    ) {
      const state =
        await this.getState();

      state.strokes = [];

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

    /* -------------------------
       FINISH ROUND
    ------------------------- */

    if (
      url.pathname.endsWith(
        "/finish"
      ) &&
      request.method === "POST"
    ) {
      const state =
        await this.getState();

      state.finished =
        true;

      await this.saveState(
        state
      );

      /*
       We intentionally do NOT
       broadcast the result here.

       The client can show the
       final result only when the
       game itself says the round
       is finished.
      */

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

    /* -------------------------
       DELETE ROOM / GAME END
    ------------------------- */

    if (
      url.pathname.endsWith(
        "/delete"
      ) &&
      request.method === "POST"
    ) {
      /*
       This deletes the stored
       drawing data after the game.

       It does NOT delete or touch
       MATCHMAKER.
      */

      await this.ctx.storage.deleteAll();

      this.broadcast({
        type:
          "room_deleted"
      });

      return json(
        {
          ok: true
        },
        200,
        origin
      );
    }

    /* -------------------------
       WEBSOCKET
    ------------------------- */

    if (
      request.headers.get(
        "Upgrade"
      )?.toLowerCase() ===
      "websocket"
    ) {
      const pair =
        new WebSocketPair();

      const client =
        pair[0];

      const server =
        pair[1];

      server.accept();

      this.connections.add(
        server
      );

      const remove =
        () => {
          this.connections.delete(
            server
          );
        };

      server.addEventListener(
        "close",
        remove
      );

      server.addEventListener(
        "error",
        remove
      );

      /*
       Send the current drawing
       ONCE when the player joins.

       After that, only new
       strokes are broadcast.
      */

      const state =
        await this.getState();

      try {
        server.send(
          JSON.stringify({
            type:
              "state",
            state
          })
        );
      } catch {
        remove();
      }

      return new Response(
        null,
        {
          status: 101,
          webSocket:
            client
        }
      );
    }

    /* -------------------------
       HEALTH
    ------------------------- */

    return json(
      {
        ok: true,
        service:
          "drawing-room"
      },
      200,
      origin
    );
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

    /* -------------------------
       CORS PREFLIGHT
    ------------------------- */

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
      new URL(request.url);

    /* =====================================================
       DRAWING ROOMS

       /draw/ROOMCODE/state
       /draw/ROOMCODE/round
       /draw/ROOMCODE/stroke
       /draw/ROOMCODE/clear
       /draw/ROOMCODE/finish
       /draw/ROOMCODE/delete
       /draw/ROOMCODE  (WebSocket)
    ===================================================== */

    if (
      url.pathname.startsWith(
        "/draw/"
      )
    ) {
      const roomName =
        url.pathname
          .slice(
            "/draw/".length
          )
          .split("/")[0]
          .trim();

      if (!roomName) {
        return json(
          {
            error:
              "Drawing room is required"
          },
          400,
          origin
        );
      }

      const id =
        env.DRAWING_ROOMS.idFromName(
          roomName
        );

      const room =
        env.DRAWING_ROOMS.get(
          id
        );

      return room.fetch(
        request
      );
    }

    /* =====================================================
       EXISTING MATCHMAKING

       THIS SECTION REMAINS SEPARATE
       FROM DRAWING.
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
      /* -------------------------
         JOIN
      ------------------------- */

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

      /* -------------------------
         STATUS
      ------------------------- */

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

      /* -------------------------
         LEAVE
      ------------------------- */

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
      console.error(error);

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
