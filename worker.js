import { DurableObject } from "cloudflare:workers";

/* =========================================================
   CONFIG
========================================================= */

const MATCH_SIZE = 4;
const WAIT_MS = 15_000;
const STALE_MS = 90_000;
const MATCHED_RETENTION_MS = 10 * 60_000;

const DRAWING_TTL_MS = 30 * 60_000;
const MAX_IMAGE_BYTES = 900_000;
const GUESS_TIME = 30;

/* =========================================================
   CORS / JSON
========================================================= */

function corsHeaders(origin) {
  const allowed =
    origin === "https://jrjboss.github.io" ||
    origin === "null" ||
    !origin;

  return {
    "Access-Control-Allow-Origin":
      allowed ? origin || "*" : "https://jrjboss.github.io",
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
   WORDS
========================================================= */

const WORDS = [
  "Elephant",
  "Pizza",
  "Guitar",
  "Rocket",
  "Sunglasses",
  "Waterfall",
  "Skateboard",
  "Dragon",
  "Umbrella",
  "Cactus",
  "Robot",
  "Snowman",
  "Bicycle",
  "Volcano",
  "Butterfly",
  "Camera",
  "Lighthouse",
  "Astronaut",
  "Campfire",
  "Kangaroo",
  "Ice cream",
  "Rainbow",
  "Spaceship",
  "Pirate ship",
  "Mermaid",
  "Dinosaur",
  "Waffle",
  "Tornado",
  "Jellyfish",
  "Skyscraper",
  "Penguin",
  "Cheeseburger",
  "Ninja",
  "Wizard",
  "Roller coaster",
  "Beehive",
  "Octopus",
  "Fireworks",
  "Sandcastle",
  "Telescope",
  "Violin",
  "Compass",
  "Anchor",
  "Cupcake",
  "Parachute",
  "Owl",
  "Panda",
  "Peacock",
  "Tent",
  "Lantern",
  "Bridge",
  "Flamingo",
  "Cheetah",
  "Snail",
  "Whale",
  "Crown",
  "Magnet",
  "Kite",
  "Sunflower",
  "Scarecrow",
  "Beach ball",
  "Fishing rod",
  "Traffic light"
];

function chooseWord(category = "general") {
  return WORDS[
    Math.floor(Math.random() * WORDS.length)
  ];
}

function normalizeWord(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function sameWord(a, b) {
  return normalizeWord(a) === normalizeWord(b);
}

/* =========================================================
   CLEAN INPUT
========================================================= */

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 18);
}

function cleanTeam(value) {
  return (
    String(value || "Team Red")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 18) || "Team Red"
  );
}

/* =========================================================
   PUBLIC STATE
========================================================= */

function publicState(state, playerId) {
  const copy = structuredClone(state);

  /*
   * NEVER expose another player's secret word.
   */
  const round = copy.roundsData?.find(
    r => r.round === copy.round
  );

  if (round) {
    copy.myPrompt =
      round.artistId === playerId
        ? round.word
        : null;
  } else {
    copy.myPrompt = null;
  }

  /*
   * During guessing nobody needs the secret word.
   */
  if (copy.phase !== "finished") {
    copy.secretWord = null;
  }

  /*
   * Results reveal the word.
   */
  if (
    copy.phase === "result" ||
    copy.phase === "finished"
  ) {
    copy.secretWord =
      round?.word || null;
  }

  /*
   * Never send giant temporary data URLs through normal state.
   */
  copy.roundsData = (copy.roundsData || []).map(r => ({
    round: r.round,
    artistId: r.artistId,
    artistName: r.artistName,
    team: r.team,
    word: (
      copy.phase === "result" ||
      copy.phase === "finished"
    )
      ? r.word
      : null,
    submitted: !!r.image,
    image: (
      copy.phase === "result" ||
      copy.phase === "finished"
    )
      ? r.image || null
      : null,
    guessResults: r.guessResults || [],
    winnerIds: r.winnerIds || [],
    correct: !!r.correct
  }));

  if (copy.deadline) {
    copy.secondsLeft = Math.max(
      0,
      Math.ceil(
        (copy.deadline - Date.now()) / 1000
      )
    );
  } else {
    copy.secondsLeft = 0;
  }

  return copy;
}

/* =========================================================
   MATCHMAKER
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
    const cutoff =
      Date.now() - STALE_MS;

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

    const selected =
      waitingRows.slice(0, MATCH_SIZE);

    const players =
      selected.map((row, index) => ({
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
        difficulty: "normal"
      });
    }

    const payload =
      JSON.stringify({
        matchId,
        roomCode,
        players,
        createdAt: now
      });

    this.ctx.storage.transactionSync(() => {
      for (
        const player of
        players.filter(p => !p.bot)
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE queue
           SET status = 'matched',
               match_id = ?,
               host = ?,
               team = ?,
               payload = ?
           WHERE id = ?`,
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
          "SELECT * FROM queue WHERE id = ?",
          player.id
        )
        .toArray();

    if (existing.length) {
      return this.status(player.id);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO queue(
        id,
        name,
        joined_at,
        status,
        payload
      )
      VALUES (?, ?, ?, 'waiting', ?)`,
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
          "SELECT * FROM queue WHERE id = ?",
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
        JSON.parse(row.payload);

      return {
        status: "matched",
        ...match,
        host: !!row.host,
        team: row.team
      };
    }

    const waitingRows =
      this.ctx.storage.sql
        .exec(
          `SELECT *
           FROM queue
           WHERE status = 'waiting'
           ORDER BY joined_at ASC
           LIMIT 4`
        )
        .toArray();

    const oldest =
      waitingRows[0]?.joined_at ||
      Date.now();

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
          player =>
            player.id === id
        );

      if (matched) {
        return {
          status: "matched",
          ...match,
          host: matched.host,
          team: matched.team
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

    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map();

    ctx.blockConcurrencyWhile(async () => {
      const existing =
        await ctx.storage.get(
          "drawState"
        );

      if (!existing) {
        await ctx.storage.put(
          "drawState",
          this.defaultState()
        );
      }
    });
  }

  defaultState() {
    return {
      code: "",
      mode: "1v1",
      phase: "lobby",

      leaderId: null,

      players: [],

      rounds: 4,
      timeLimit: 60,
      guessTime: GUESS_TIME,

      round: 0,

      roundsData: [],

      deadline: 0,
      secondsLeft: 0,

      submittedCount: 0,

      category: "general",

      createdAt: Date.now()
    };
  }

  async getState() {
    return (
      await this.ctx.storage.get(
        "drawState"
      )
    ) || this.defaultState();
  }

  async saveState(state) {
    if (state.deadline) {
      state.secondsLeft =
        Math.max(
          0,
          Math.ceil(
            (state.deadline -
              Date.now()) /
              1000
          )
        );
    } else {
      state.secondsLeft = 0;
    }

    await this.ctx.storage.put(
      "drawState",
      state
    );
  }

  broadcast(state, type = "state") {
    for (
      const [playerId, socket]
      of this.sockets
    ) {
      try {
        socket.send(
          JSON.stringify({
            type,
            state:
              publicState(
                state,
                playerId
              )
          })
        );
      } catch {
        this.sockets.delete(
          playerId
        );
      }
    }
  }

  ensurePlayer(state, id) {
    return state.players.find(
      p => p.id === id
    );
  }

  getCurrentRound(state) {
    return state.roundsData.find(
      r =>
        r.round === state.round
    );
  }

  /* =======================================================
     START
  ======================================================= */

  async startGame(state) {
    if (!state.players.length) {
      throw new Error(
        "At least one player is required."
      );
    }

    state.phase = "drawing";
    state.round = 1;

    state.roundsData = [];

    const shuffled =
      [...state.players];

    /*
     * Every player gets a drawing turn.
     * For 4 players and 4 rounds:
     * player 1 → player 2 → player 3 → player 4
     *
     * If more rounds are selected,
     * rotation continues.
     */

    for (
      let i = 0;
      i < state.rounds;
      i++
    ) {
      const artist =
        shuffled[
          i % shuffled.length
        ];

      state.roundsData.push({
        round: i + 1,

        artistId:
          artist.id,

        artistName:
          artist.name,

        team:
          artist.team || "red",

        word:
          chooseWord(
            state.category
          ),

        image: null,

        submitted: false,

        guessResults: [],

        winnerIds: [],

        correct: false
      });
    }

    const first =
      state.roundsData[0];

    state.deadline =
      Date.now() +
      state.timeLimit * 1000;

    state.submittedCount = 0;

    await this.saveState(state);

    this.ctx.storage.setAlarm(
      state.deadline
    );
  }

  /* =======================================================
     SUBMIT DRAWING
  ======================================================= */

  async submitDrawing(
    state,
    playerId,
    image
  ) {
    if (
      state.phase !== "drawing"
    ) {
      throw new Error(
        "Drawing phase is not active."
      );
    }

    const round =
      this.getCurrentRound(state);

    if (!round) {
      throw new Error(
        "Round not found."
      );
    }

    if (
      round.artistId !==
      playerId
    ) {
      throw new Error(
        "Only the current artist can submit."
      );
    }

    if (round.submitted) {
      throw new Error(
        "Drawing already submitted."
      );
    }

    if (
      typeof image !== "string"
    ) {
      throw new Error(
        "Invalid drawing."
      );
    }

    /*
     * Expect a compressed data URL:
     * data:image/jpeg;base64,...
     */

    if (
      !image.startsWith(
        "data:image/"
      )
    ) {
      throw new Error(
        "Drawing must be an image."
      );
    }

    /*
     * Approximate byte check.
     */

    const comma =
      image.indexOf(",");

    if (comma === -1) {
      throw new Error(
        "Invalid image."
      );
    }

    const base64 =
      image.slice(
        comma + 1
      );

    const bytes =
      Math.floor(
        base64.length * 0.75
      );

    if (
      bytes > MAX_IMAGE_BYTES
    ) {
      throw new Error(
        "Drawing image is too large. Compress it before sending."
      );
    }

    round.image = image;
    round.submitted = true;

    state.submittedCount = 1;

    /*
     * Stop drawing immediately.
     *
     * Everyone now waits for the artist.
     */

    state.phase = "waiting";

    state.deadline = 0;

    await this.saveState(state);

    this.broadcast(
      state,
      "drawing_submitted"
    );

    /*
     * Check whether everybody
     * who needs to participate has submitted.
     */

    const allArtistsSubmitted =
      state.roundsData.every(
        r => r.submitted
      );

    /*
     * Because rounds are sequential,
     * we move into guessing immediately
     * after this drawing.
     *
     * This means players don't have to wait
     * for future rounds.
     */

    if (
      round.submitted
    ) {
      await this.beginGuessing(
        state
      );
    }

    return state;
  }

  /* =======================================================
     GUESSING
  ======================================================= */

  async beginGuessing(state) {
    const round =
      this.getCurrentRound(state);

    if (!round) {
      return;
    }

    state.phase = "guessing";

    state.deadline =
      Date.now() +
      GUESS_TIME * 1000;

    round.guessResults =
      round.guessResults || [];

    round.winnerIds =
      round.winnerIds || [];

    await this.saveState(state);

    this.ctx.storage.setAlarm(
      state.deadline
    );

    this.broadcast(
      state,
      "guessing"
    );
  }

  async processGuess(
    state,
    playerId,
    guess
  ) {
    if (
      state.phase !== "guessing"
    ) {
      throw new Error(
        "Guessing is not active."
      );
    }

    const round =
      this.getCurrentRound(state);

    if (!round) {
      throw new Error(
        "Round not found."
      );
    }

    if (
      playerId ===
      round.artistId
    ) {
      throw new Error(
        "The artist cannot guess."
      );
    }

    const player =
      this.ensurePlayer(
        state,
        playerId
      );

    if (!player) {
      throw new Error(
        "Player not found."
      );
    }

    const text =
      String(guess || "")
        .trim()
        .slice(0, 80);

    if (!text) {
      throw new Error(
        "Enter a guess."
      );
    }

    const already =
      round.guessResults.find(
        g =>
          g.id === playerId
      );

    if (already) {
      throw new Error(
        "You already guessed."
      );
    }

    const correct =
      sameWord(
        text,
        round.word
      );

    let points = 0;

    if (correct) {
      const remaining =
        Math.max(
          0,
          Math.ceil(
            (state.deadline -
              Date.now()) /
              1000
          )
        );

      points =
        50 +
        Math.min(
          50,
          remaining
        );

      const score =
        state.players.find(
          p =>
            p.id === playerId
        );

      if (score) {
        score.score =
          Number(score.score || 0) +
          points;
      }

      round.winnerIds.push(
        playerId
      );

      round.correct = true;
    }

    round.guessResults.push({
      id: playerId,
      name: player.name,
      guess: text,
      correct,
      points
    });

    /*
     * Every non-artist can guess once.
     */

    const guessers =
      state.players.filter(
        p =>
          p.id !==
          round.artistId
      );

    const allGuessed =
      round.guessResults.length >=
      guessers.length;

    if (
      correct ||
      allGuessed
    ) {
      await this.finishRound(
        state
      );
    } else {
      await this.saveState(
        state
      );

      this.broadcast(
        state,
        "guess"
      );
    }

    return {
      correct,
      points,
      state
    };
  }

  /* =======================================================
     FINISH ROUND
  ======================================================= */

  async finishRound(state) {
    state.phase = "result";
    state.deadline = 0;
    state.secondsLeft = 0;

    const round =
      this.getCurrentRound(state);

    if (round) {
      round.submitted = true;
    }

    await this.saveState(state);

    this.broadcast(
      state,
      "result"
    );
  }

  /* =======================================================
     NEXT ROUND
  ======================================================= */

  async nextRound(
    state,
    playerId
  ) {
    if (
      state.leaderId !==
      playerId
    ) {
      throw new Error(
        "Only the host can continue."
      );
    }

    if (
      state.phase !== "result"
    ) {
      throw new Error(
        "The round is not finished."
      );
    }

    if (
      state.round >=
      state.rounds
    ) {
      state.phase =
        "finished";

      state.deadline = 0;

      await this.saveState(
        state
      );

      this.broadcast(
        state,
        "finished"
      );

      return;
    }

    state.round++;

    const round =
      this.getCurrentRound(state);

    if (!round) {
      throw new Error(
        "Next round not found."
      );
    }

    /*
     * If a future round hasn't got a
     * drawing yet, it starts now.
     */

    round.image = null;
    round.submitted = false;
    round.guessResults = [];
    round.winnerIds = [];
    round.correct = false;

    state.phase = "drawing";

    state.submittedCount = 0;

    state.deadline =
      Date.now() +
      state.timeLimit * 1000;

    await this.saveState(state);

    this.ctx.storage.setAlarm(
      state.deadline
    );

    this.broadcast(
      state,
      "next_round"
    );
  }

  /* =======================================================
     SETTINGS
  ======================================================= */

  applySettings(state, body) {
    if (
      Number(body.rounds) > 0
    ) {
      state.rounds =
        Math.min(
          20,
          Math.max(
            1,
            Number(body.rounds)
          )
        );
    }

    if (
      Number(body.timeLimit) > 0
    ) {
      state.timeLimit =
        Math.min(
          180,
          Math.max(
            15,
            Number(body.timeLimit)
          )
        );
    }

    if (
      body.mode === "1v1" ||
      body.mode === "teams" ||
      body.mode === "free"
    ) {
      state.mode =
        body.mode;
    }

    if (
      typeof body.category ===
      "string"
    ) {
      state.category =
        body.category
          .trim()
          .slice(0, 40) ||
        "general";
    }
  }

  /* =======================================================
     HTTP
  ======================================================= */

  async fetch(request) {
    const origin =
      request.headers.get(
        "Origin"
      ) || "";

    const url =
      new URL(request.url);

    const parts =
      url.pathname
        .split("/")
        .filter(Boolean);

    const playerId =
      String(
        url.searchParams.get(
          "playerId"
        ) || ""
      ).trim();

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers:
          corsHeaders(origin)
      });
    }

    let state =
      await this.getState();

    if (!state.code) {
      state.code =
        parts[1] || "";

      await this.saveState(
        state
      );
    }

    const send =
      (data, status = 200) =>
        json(
          data,
          status,
          origin
        );

    try {
      /* ===================================================
         STATE
      =================================================== */

      if (
        url.pathname.endsWith(
          "/state"
        ) &&
        request.method === "GET"
      ) {
        return send({
          ok: true,
          state:
            publicState(
              state,
              playerId
            )
        });
      }

      /* ===================================================
         JOIN
      =================================================== */

      if (
        url.pathname.endsWith(
          "/join"
        ) &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const id =
          String(
            body.playerId || ""
          ).trim();

        const name =
          cleanName(
            body.name
          );

        if (!id || !name) {
          return send(
            {
              error:
                "playerId and name are required"
            },
            400
          );
        }

        if (!state.code) {
          state.code =
            parts[1] ||
            makeRoomCode();
        }

        const existing =
          this.ensurePlayer(
            state,
            id
          );

        if (
          state.players.length >=
            20 &&
          !existing
        ) {
          return send(
            {
              error:
                "Room is full."
            },
            409
          );
        }

        if (!existing) {
          const team =
            cleanTeam(
              body.team ||
                (
                  state.players.length %
                  2 === 0
                    ? "red"
                    : "blue"
                )
            );

          state.players.push({
            id,
            name,
            team,
            score: 0,
            joinedAt: Date.now()
          });
        } else {
          existing.name =
            name;

          if (body.team) {
            existing.team =
              cleanTeam(
                body.team
              );
          }
        }

        if (
          !state.leaderId ||
          body.host === true
        ) {
          state.leaderId =
            id;
        }

        this.applySettings(
          state,
          body
        );

        await this.saveState(
          state
        );

        this.broadcast(
          state,
          "player_joined"
        );

        return send({
          ok: true,
          state:
            publicState(
              state,
              id
            )
        });
      }

      /* ===================================================
         SETTINGS
      =================================================== */

      if (
        url.pathname.endsWith(
          "/settings"
        ) &&
        request.method === "POST"
      ) {
        if (
          state.leaderId !==
          playerId
        ) {
          return send(
            {
              error:
                "Only the host can change settings."
            },
            403
          );
        }

        const body =
          await request.json();

        this.applySettings(
          state,
          body
        );

        await this.saveState(
          state
        );

        this.broadcast(
          state,
          "settings"
        );

        return send({
          ok: true,
          state:
            publicState(
              state,
              playerId
            )
        });
      }

      /* ===================================================
         START
      =================================================== */

      if (
        url.pathname.endsWith(
          "/start"
        ) &&
        request.method === "POST"
      ) {
        if (
          state.leaderId !==
          playerId
        ) {
          return send(
            {
              error:
                "Only the host can start."
            },
            403
          );
        }

        if (
          !state.players.length
        ) {
          return send(
            {
              error:
                "Add a player first."
            },
            400
          );
        }

        await this.startGame(
          state
        );

        this.broadcast(
          state,
          "start"
        );

        return send({
          ok: true,
          state:
            publicState(
              state,
              playerId
            )
        });
      }

      /* ===================================================
         SUBMIT IMAGE
      =================================================== */

      if (
        url.pathname.endsWith(
          "/submit"
        ) &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const image =
          String(
            body.image ||
            body.dataUrl ||
            ""
          );

        try {
          await this.submitDrawing(
            state,
            playerId,
            image
          );
        } catch (error) {
          return send(
            {
              error:
                error?.message ||
                "Could not submit drawing."
            },
            400
          );
        }

        return send({
          ok: true,
          state:
            publicState(
              state,
              playerId
            )
        });
      }

      /* ===================================================
         GUESS
      =================================================== */

      if (
        url.pathname.endsWith(
          "/guess"
        ) &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        try {
          const result =
            await this.processGuess(
              state,
              playerId,
              body.guess
            );

          return send({
            ok: true,
            correct:
              result.correct,
            points:
              result.points,
            state:
              publicState(
                state,
                playerId
              )
          });
        } catch (error) {
          return send(
            {
              error:
                error?.message ||
                "Guess failed."
            },
            400
          );
        }
      }

      /* ===================================================
         NEXT
      =================================================== */

      if (
        url.pathname.endsWith(
          "/next"
        ) &&
        request.method === "POST"
      ) {
        try {
          await this.nextRound(
            state,
            playerId
          );

          return send({
            ok: true,
            state:
              publicState(
                state,
                playerId
              )
          });
        } catch (error) {
          return send(
            {
              error:
                error?.message ||
                "Could not start next round."
            },
            400
          );
        }
      }

      /* ===================================================
         RESTART
      =================================================== */

      if (
        url.pathname.endsWith(
          "/restart"
        ) &&
        request.method === "POST"
      ) {
        if (
          state.leaderId !==
          playerId
        ) {
          return send(
            {
              error:
                "Only the host can restart."
            },
            403
          );
        }

        for (
          const player of
          state.players
        ) {
          player.score = 0;
        }

        await this.startGame(
          state
        );

        this.broadcast(
          state,
          "restart"
        );

        return send({
          ok: true,
          state:
            publicState(
              state,
              playerId
            )
        });
      }

      /* ===================================================
         LEAVE
      =================================================== */

      if (
        url.pathname.endsWith(
          "/leave"
        ) &&
        request.method === "POST"
      ) {
        state.players =
          state.players.filter(
            p =>
              p.id !== playerId
          );

        if (
          state.leaderId ===
          playerId
        ) {
          state.leaderId =
            state.players[0]?.id ||
            null;
        }

        if (
          !state.players.length
        ) {
          await this.ctx.storage
            .deleteAll();

          for (
            const socket of
            this.sockets.values()
          ) {
            try {
              socket.close(
                1000,
                "Room closed"
              );
            } catch {}
          }

          this.sockets.clear();

          return send({
            ok: true
          });
        }

        await this.saveState(
          state
        );

        this.broadcast(
          state,
          "player_left"
        );

        return send({
          ok: true,
          state:
            publicState(
              state,
              playerId
            )
        });
      }

      /* ===================================================
         WEBSOCKET
         
         IMPORTANT:
         No drawing strokes are sent.
         
         WebSocket is ONLY used for:
         - player joined
         - game state
         - submit notification
         - guessing
         - results
      =================================================== */

      if (
        request.headers
          .get("Upgrade")
          ?.toLowerCase() ===
        "websocket"
      ) {
        const pair =
          new WebSocketPair();

        const client =
          pair[0];

        const server =
          pair[1];

        server.accept();

        const socketPlayerId =
          playerId ||
          `socket-${crypto.randomUUID()}`;

        this.sockets.set(
          socketPlayerId,
          server
        );

        server.addEventListener(
          "close",
          () => {
            this.sockets.delete(
              socketPlayerId
            );
          }
        );

        server.addEventListener(
          "error",
          () => {
            this.sockets.delete(
              socketPlayerId
            );
          }
        );

        server.addEventListener(
          "message",
          async event => {
            try {
              const message =
                JSON.parse(
                  event.data
                );

              if (
                message.type ===
                "ping"
              ) {
                server.send(
                  JSON.stringify({
                    type: "pong"
                  })
                );

                return;
              }

              if (
                message.type ===
                "state"
              ) {
                const latest =
                  await this.getState();

                server.send(
                  JSON.stringify({
                    type: "state",
                    state:
                      publicState(
                        latest,
                        socketPlayerId
                      )
                  })
                );

                return;
              }

              /*
               * DO NOT accept stroke messages.
               *
               * Drawing is local now.
               */

              if (
                message.type ===
                "stroke"
              ) {
                return;
              }

              if (
                message.type ===
                "clear"
              ) {
                return;
              }

              /*
               * Notify clients that a drawing
               * was submitted.
               */

              if (
                message.type ===
                "submitted"
              ) {
                const latest =
                  await this.getState();

                this.broadcast(
                  latest,
                  "drawing_submitted"
                );

                return;
              }
            } catch (error) {
              console.error(
                "WebSocket error:",
                error
              );
            }
          }
        );

        server.send(
          JSON.stringify({
            type: "state",
            state:
              publicState(
                state,
                socketPlayerId
              )
          })
        );

        return new Response(
          null,
          {
            status: 101,
            webSocket: client
          }
        );
      }

      return send({
        ok: true,
        service:
          "drawing-room"
      });
    } catch (error) {
      console.error(error);

      return send(
        {
          error:
            error?.message ||
            "Drawing room server error"
        },
        500
      );
    }
  }

  /* =========================================================
     ALARM
  ========================================================= */

  async alarm() {
    const state =
      await this.getState();

    if (
      !state.deadline ||
      Date.now() <
        state.deadline
    ) {
      return;
    }

    /*
     * Drawing time expired.
     *
     * Move to guessing even if the artist
     * didn't manually press SEND.
     */

    if (
      state.phase === "drawing"
    ) {
      const round =
        this.getCurrentRound(
          state
        );

      if (round) {
        round.submitted =
          true;

        /*
         * Empty image means the player
         * didn't submit anything.
         */
        if (!round.image) {
          round.image = null;
        }
      }

      state.phase =
        "waiting";

      state.deadline = 0;

      await this.saveState(
        state
      );

      await this.beginGuessing(
        state
      );

      return;
    }

    /*
     * Guess timer expired.
     */

    if (
      state.phase === "guessing"
    ) {
      await this.finishRound(
        state
      );
    }
  }
}

/* =========================================================
   MAIN WORKER
========================================================= */

export default {
  async fetch(request, env) {
    const origin =
      request.headers.get(
        "Origin"
      ) || "";

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers:
            corsHeaders(origin)
        }
      );
    }

    const url =
      new URL(request.url);

    /* =====================================================
       DRAWING ROOMS
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
       MATCHMAKING
       
       KEPT HERE.
       DO NOT REMOVE.
    ===================================================== */

    if (
      url.pathname.startsWith(
        "/matchmaking"
      )
    ) {
      const id =
        env.MATCHMAKER.idFromName(
          "global-queue"
        );

      const stub =
        env.MATCHMAKER.get(id);

      try {
        if (
          url.pathname ===
            "/matchmaking/join" &&
          request.method ===
            "POST"
        ) {
          const body =
            await request.json();

          const name =
            cleanName(
              body?.name
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
              id: playerId,
              name
            }),
            200,
            origin
          );
        }

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

    /* =====================================================
       HEALTH CHECK
    ===================================================== */

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
};
