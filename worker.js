import { DurableObject } from "cloudflare:workers";

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
  let out = "";

  for (let i = 0; i < 5; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

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
    const cutoff = Date.now() - STALE_MS;

    this.ctx.storage.sql.exec(
      "DELETE FROM queue WHERE status = 'waiting' AND joined_at < ?",
      cutoff
    );

    this.ctx.storage.sql.exec(
      "DELETE FROM queue WHERE status = 'matched' AND joined_at < ?",
      Date.now() - MATCHED_RETENTION_MS
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

    // Fill empty player slots with AI bots.
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
      for (const player of players.filter(player => !player.bot)) {
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

    const existing = this.ctx.storage.sql
      .exec(
        "SELECT * FROM queue WHERE id = ?",
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
      waitedMs: Date.now() - Number(row.joined_at)
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

export default {
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

    // Health check.
    if (!url.pathname.startsWith("/matchmaking")) {
      return json(
        {
          ok: true,
          service: "codenames-matchmaking"
        },
        200,
        origin
      );
    }

    const id =
      env.MATCHMAKER.idFromName("global-queue");

    const stub =
      env.MATCHMAKER.get(id);

    try {
      // JOIN MATCHMAKING
      if (
        url.pathname === "/matchmaking/join" &&
        request.method === "POST"
      ) {
        const body = await request.json();

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

        return json(
          await stub.join({
            id: playerId,
            name
          }),
          200,
          origin
        );
      }

      // CHECK MATCHMAKING STATUS
      if (
        url.pathname === "/matchmaking/status" &&
        request.method === "GET"
      ) {
        const playerId =
          String(
            url.searchParams.get("playerId") || ""
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
          await stub.status(playerId),
          200,
          origin
        );
      }

      // LEAVE MATCHMAKING
      if (
        url.pathname === "/matchmaking/leave" &&
        request.method === "POST"
      ) {
        const body = await request.json();

        const playerId =
          String(body?.playerId || "")
            .trim();

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
          await stub.leave(playerId),
          200,
          origin
        );
      }

      return json(
        {
          error: "Not found"
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
