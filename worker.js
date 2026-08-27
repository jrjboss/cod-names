import { DurableObject } from "cloudflare:workers";

const MATCH_SIZE = 4;
const WAIT_MS = 15_000;
const STALE_MS = 90_000;
const MATCHED_RETENTION_MS = 10 * 60_000;

function corsHeaders(origin = "") {
  const ok =
    origin === "https://jrjboss.github.io" ||
    origin === "null" ||
    !origin;

  return {
    "Access-Control-Allow-Origin":
      ok ? (origin || "*") : "https://jrjboss.github.io",
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

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";

  for (let i = 0; i < 5; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }

  return s;
}

function cleanName(v) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 18);
}

function norm(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");
}

function sameWord(a, b) {
  return norm(a) === norm(b);
}


/* =========================================================
   CODENAMES MATCHMAKER
   ========================================================= */

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
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

  clean() {
    this.ctx.storage.sql.exec(
      `
      DELETE FROM queue
      WHERE status = 'waiting'
      AND joined_at < ?
      `,
      Date.now() - STALE_MS
    );

    this.ctx.storage.sql.exec(
      `
      DELETE FROM queue
      WHERE status = 'matched'
      AND joined_at < ?
      `,
      Date.now() - MATCHED_RETENTION_MS
    );
  }

  makeMatch(rows) {
    const id = crypto.randomUUID();
    const code = roomCode();
    const now = Date.now();

    const players = rows
      .slice(0, MATCH_SIZE)
      .map((row, i) => ({
        id: row.id,
        name: row.name,
        team: i % 2 ? "blue" : "red",
        bot: false,
        host: i === 0
      }));

    while (players.length < MATCH_SIZE) {
      const i = players.length;

      players.push({
        id: `bot-${id}-${i}`,
        name: `Codename Bot ${i}`,
        team: i % 2 ? "blue" : "red",
        bot: true,
        host: false,
        difficulty: "normal"
      });
    }

    const payload = JSON.stringify({
      matchId: id,
      roomCode: code,
      players,
      createdAt: now
    });

    this.ctx.storage.transactionSync(() => {
      for (const p of players.filter(x => !x.bot)) {
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
          id,
          p.host ? 1 : 0,
          p.team,
          payload,
          p.id
        );
      }
    });

    return {
      matchId: id,
      roomCode: code,
      players
    };
  }

  async join(p) {
    this.clean();

    const existing =
      this.ctx.storage.sql
        .exec(
          "SELECT id FROM queue WHERE id = ?",
          p.id
        )
        .toArray();

    if (existing.length) {
      return this.status(p.id);
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
      VALUES(
        ?,
        ?,
        ?,
        'waiting',
        ?
      )
      `,
      p.id,
      p.name,
      Date.now(),
      JSON.stringify(p)
    );

    return this.status(p.id);
  }

  async status(id) {
    this.clean();

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
        team: row.team,
        queueCount: 0
      };
    }

    const rows =
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
      rows[0]?.joined_at ||
      Date.now();

    const shouldMatch =
      rows.length >= MATCH_SIZE ||
      (
        rows.length > 0 &&
        Date.now() - oldest >= WAIT_MS
      );

    if (shouldMatch) {
      const match =
        this.makeMatch(rows);

      const me =
        match.players.find(
          x => x.id === id
        );

      if (me) {
        return {
          status: "matched",
          ...match,
          host: me.host,
          team: me.team,
          queueCount: 0
        };
      }
    }

    const position =
      rows.findIndex(
        x => x.id === id
      );

    return {
      status: "waiting",
      position:
        position >= 0
          ? position + 1
          : 1,
      queueCount: rows.length,
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
   DRAW & GUESS WORD CATEGORIES
   ========================================================= */

const POOLS = {

  mixed: [
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
    "Ninja",
    "Wizard",
    "Octopus",
    "Sandcastle",
    "Telescope",
    "Violin",
    "Compass",
    "Cupcake",
    "Parachute",
    "Panda"
  ],

  animals: [
    "Cat",
    "Dog",
    "Lion",
    "Elephant",
    "Horse",
    "Eagle",
    "Shark",
    "Butterfly",
    "Penguin",
    "Octopus",
    "Tiger",
    "Bear",
    "Monkey",
    "Rabbit",
    "Turtle",
    "Crocodile",
    "Dolphin",
    "Whale",
    "Owl",
    "Fox",
    "Wolf",
    "Panda",
    "Kangaroo",
    "Cheetah"
  ],

  food: [
    "Pizza",
    "Burger",
    "Ice cream",
    "Apple",
    "Banana",
    "Watermelon",
    "Cake",
    "Donut",
    "Fries",
    "Chocolate",
    "Sushi",
    "Taco",
    "Kebab",
    "Falafel",
    "Coffee",
    "Tea",
    "Waffle",
    "Popcorn",
    "Pancakes",
    "Cupcake"
  ],

  objects: [
    "Phone",
    "Camera",
    "Computer",
    "Guitar",
    "Crown",
    "Umbrella",
    "Clock",
    "Glasses",
    "Lamp",
    "Key",
    "Chair",
    "Book",
    "Pen",
    "Scissors",
    "Bag",
    "Mirror",
    "Cup",
    "Spoon",
    "Ball",
    "Microphone"
  ],

  places: [
    "House",
    "Castle",
    "Beach",
    "Island",
    "Mountain",
    "Volcano",
    "School",
    "Stadium",
    "Airport",
    "City",
    "Village",
    "Farm",
    "Museum",
    "Theater",
    "Library",
    "Garden",
    "Desert",
    "Forest",
    "Harbor",
    "Bridge"
  ],

  fantasy: [
    "Dragon",
    "Robot",
    "Wizard",
    "Space ship",
    "Unicorn",
    "Galaxy",
    "Planet",
    "Knight",
    "Magic crown",
    "Portal",
    "Giant",
    "Genie",
    "Monster",
    "Fairy",
    "Phoenix"
  ],

  anime: [
    "Naruto",
    "Goku",
    "Luffy",
    "Saitama",
    "Itachi",
    "Sasuke",
    "Ichigo",
    "Eren",
    "Levi",
    "Gojo",
    "Sukuna",
    "Tanjiro",
    "Nezuko",
    "Zenitsu",
    "Zoro",
    "Sanji",
    "Shanks",
    "Deku",
    "Bakugo",
    "Todoroki",
    "Gon",
    "Killua"
  ]
};


/* =========================================================
   SAFE PUBLIC DRAWING STATE
   ========================================================= */

function publicState(state, playerId) {
  const s = structuredClone(state);

  const artist =
    s.players.find(
      p => p.id === s.artistId
    );

  const isArtist =
    artist &&
    artist.id === playerId;

  if (!isArtist) {
    s.prompt = null;
  }

  if (
    s.phase === "finished" ||
    s.phase === "result"
  ) {
    s.prompt =
      s.lastWord ||
      s.word ||
      null;
  }

  /*
   NEVER expose the secret word to guessers.
  */
  s.word = null;

  if (s.deadline) {
    s.secondsLeft =
      Math.max(
        0,
        Math.ceil(
          (s.deadline - Date.now()) / 1000
        )
      );
  }

  return s;
}


/* =========================================================
   DRAWING ROOM DURABLE OBJECT
   ========================================================= */

export class DrawingRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.sockets = new Map();

    ctx.blockConcurrencyWhile(
      async () => {
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
      }
    );
  }


  defaultState() {
    return {
      code: "",

      mode: "1v1",

      category: "mixed",

      phase: "lobby",

      leaderId: null,

      players: [],

      rounds: 4,

      timeLimit: 60,

      round: 0,

      artistIndex: 0,

      artistId: null,

      prompt: null,

      word: null,

      strokes: [],

      guesses: [],

      chat: [],

      scores: [],

      gallery: [],

      deadline: 0,

      secondsLeft: 0,

      lastSubmission: null,

      lastCorrect: false,

      lastWord: ""
    };
  }


  async getState() {
    return (
      await this.ctx.storage.get(
        "drawState"
      )
    ) || this.defaultState();
  }


  async save(state) {
    state.secondsLeft =
      state.deadline
        ? Math.max(
            0,
            Math.ceil(
              (state.deadline - Date.now()) /
                1000
            )
          )
        : 0;

    await this.ctx.storage.put(
      "drawState",
      state
    );
  }


  player(state, id) {
    return state.players.find(
      p => p.id === id
    ) || null;
  }


  guessers(state) {

    if (state.mode !== "teams") {
      return state.players.filter(
        p => p.id !== state.artistId
      );
    }

    const artist =
      this.player(
        state,
        state.artistId
      );

    const team =
      artist?.team;

    return state.players.filter(
      p =>
        p.id !== state.artistId &&
        p.team === team
    );
  }


  broadcast(
    state,
    type = "state"
  ) {
    for (
      const [id, ws]
      of this.sockets
    ) {
      try {
        ws.send(
          JSON.stringify({
            type,
            state:
              publicState(
                state,
                id
              )
          })
        );
      } catch {
        this.sockets.delete(id);
      }
    }
  }


  chooseWord(state) {

    const pool =
      POOLS[state.category] ||
      POOLS.mixed;

    const used =
      new Set(
        (state.gallery || [])
          .map(x => x.word)
      );

    const available =
      pool.filter(
        x => !used.has(x)
      );

    const source =
      available.length
        ? available
        : pool;

    return source[
      Math.floor(
        Math.random() *
        source.length
      )
    ];
  }


  schedule(state) {
    if (state.deadline) {
      this.ctx.storage.setAlarm(
        state.deadline
      );
    }
  }


  async start(state) {

    if (
      state.mode === "1v1" &&
      state.players.length < 2
    ) {
      throw new Error(
        "1v1 needs at least 2 players."
      );
    }

    if (
      state.mode === "teams"
    ) {

      const red =
        state.players.filter(
          p => p.team === "red"
        ).length;

      const blue =
        state.players.filter(
          p => p.team === "blue"
        ).length;

      if (
        red < 2 ||
        blue < 2
      ) {
        throw new Error(
          "Teams mode needs at least 2 players on each team."
        );
      }
    }

    state.phase =
      "drawing";

    state.round =
      1;

    state.artistIndex =
      0;

    state.artistId =
      state.players[0].id;

    state.strokes = [];

    state.guesses = [];

    state.gallery = [];

    state.chat = [];

    state.lastCorrect =
      false;

    state.lastWord =
      "";

    state.word =
      this.chooseWord(state);

    state.prompt =
      state.word;

    state.deadline =
      state.timeLimit
        ? Date.now() +
          state.timeLimit * 1000
        : 0;

    state.scores =
      state.players.map(
        p => ({
          id: p.id,
          name: p.name,
          score: 0
        })
      );

    await this.save(state);

    this.schedule(state);
  }


  async finishDrawing(
    state,
    timeout = false
  ) {

    if (
      state.phase !== "drawing"
    ) {
      return;
    }

    state.lastSubmission = {
      artist:
        state.artistId,

      artistName:
        this.player(
          state,
          state.artistId
        )?.name ||
        "Player",

      strokes:
        state.strokes.slice(
          -1800
        ),

      word:
        state.word || "",

      timeout
    };

    state.phase =
      "guessing";

    state.guesses =
      [];

    state.deadline =
      state.timeLimit
        ? Date.now() +
          state.timeLimit * 1000
        : 0;

    await this.save(state);

    this.schedule(state);
  }


  async finishRound(
    state,
    correct,
    winner = null
  ) {

    state.lastCorrect =
      !!correct;

    state.lastWord =
      state.word || "";

    if (
      correct &&
      winner
    ) {

      const left =
        state.deadline
          ? Math.max(
              0,
              Math.ceil(
                (state.deadline -
                  Date.now()) /
                  1000
              )
            )
          : 0;

      const points =
        50 +
        Math.min(
          50,
          left
        );

      const score =
        state.scores.find(
          x => x.id === winner
        );

      if (score) {
        score.score += points;
      }
    }

    if (
      state.lastSubmission
    ) {

      state.gallery.push({
        artist:
          state.lastSubmission
            .artistName,

        word:
          state.lastSubmission
            .word,

        strokes:
          state.lastSubmission
            .strokes,

        correct:
          !!correct,

        winnerId:
          winner || null
      });

      if (
        state.gallery.length >
        12
      ) {
        state.gallery.shift();
      }
    }

    state.phase =
      "result";

    state.deadline =
      0;

    state.secondsLeft =
      0;

    await this.save(state);
  }


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

    const send =
      (data, status = 200) =>
        json(
          data,
          status,
          origin
        );


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


    let state =
      await this.getState();


    if (!state.code) {
      state.code =
        parts[1] || "";
    }


    try {

      /* =========================================
         STATE
      ========================================= */

      if (
        url.pathname.endsWith(
          "/state"
        ) &&
        request.method ===
          "GET"
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


      /* =========================================
         JOIN
      ========================================= */

      if (
        url.pathname.endsWith(
          "/join"
        ) &&
        request.method ===
          "POST"
      ) {

        const body =
          await request
            .json()
            .catch(
              () => ({})
            );

        const id =
          String(
            body.playerId ||
              ""
          ).trim();

        const name =
          cleanName(
            body.name
          );

        if (
          !id ||
          !name
        ) {
          return send(
            {
              error:
                "playerId and name are required"
            },
            400
          );
        }


        const duplicate =
          state.players.some(
            p =>
              p.id !== id &&
              norm(p.name) ===
                norm(name)
          );

        if (duplicate) {
          return send(
            {
              error:
                "That player name is already in this room."
            },
            409
          );
        }


        if (
          state.phase !==
            "lobby" &&
          !state.players.some(
            p => p.id === id
          )
        ) {
          return send(
            {
              error:
                "The game has already started."
            },
            409
          );
        }


        if (
          state.players.length >=
            12 &&
          !state.players.some(
            p => p.id === id
          )
        ) {
          return send(
            {
              error:
                "Room is full."
            },
            409
          );
        }


        let p =
          state.players.find(
            x => x.id === id
          );


        if (!p) {

          let team =
            "solo";

          if (
            (body.mode ||
              state.mode) ===
            "teams"
          ) {

            const red =
              state.players.filter(
                x =>
                  x.team ===
                  "red"
              ).length;

            const blue =
              state.players.filter(
                x =>
                  x.team ===
                  "blue"
              ).length;

            team =
              body.team ===
                "blue"
                ? "blue"
                : body.team ===
                    "red"
                  ? "red"
                  : red <= blue
                    ? "red"
                    : "blue";
          }


          p = {
            id,
            name,
            team,
            joinedAt:
              Date.now()
          };

          state.players.push(
            p
          );

          state.scores.push({
            id,
            name,
            score: 0
          });

        } else {

          p.name =
            name;

          if (
            state.phase ===
              "lobby" &&
            state.mode ===
              "teams" &&
            (
              body.team ===
                "red" ||
              body.team ===
                "blue"
            )
          ) {
            p.team =
              body.team;
          }
        }


        if (
          !state.leaderId ||
          body.host === true
        ) {
          state.leaderId =
            id;
        }


        if (
          body.mode ===
            "1v1" ||
          body.mode ===
            "teams"
        ) {
          state.mode =
            body.mode;
        }


        if (
          Number.isFinite(
            +body.rounds
          )
        ) {
          state.rounds =
            Math.min(
              10,
              Math.max(
                1,
                Math.floor(
                  +body.rounds
                )
              )
            );
        }


        if (
          Number.isFinite(
            +body.timeLimit
          )
        ) {
          state.timeLimit =
            Math.min(
              120,
              Math.max(
                0,
                Math.floor(
                  +body.timeLimit
                )
              )
            );
        }


        if (
          POOLS[
            body.category
          ]
        ) {
          state.category =
            body.category;
        }


        await this.save(
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


      /* =========================================
         SETTINGS
      ========================================= */

      if (
        url.pathname.endsWith(
          "/settings"
        ) &&
        request.method ===
          "POST"
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


        if (
          state.phase !==
          "lobby"
        ) {
          return send(
            {
              error:
                "Settings are locked after the game starts."
            },
            409
          );
        }


        const body =
          await request
            .json()
            .catch(
              () => ({})
            );


        if (
          body.mode ===
            "1v1" ||
          body.mode ===
            "teams"
        ) {
          state.mode =
            body.mode;
        }


        if (
          Number.isFinite(
            +body.rounds
          )
        ) {
          state.rounds =
            Math.min(
              10,
              Math.max(
                1,
                Math.floor(
                  +body.rounds
                )
              )
            );
        }


        if (
          Number.isFinite(
            +body.timeLimit
          )
        ) {
          state.timeLimit =
            Math.min(
              120,
              Math.max(
                0,
                Math.floor(
                  +body.timeLimit
                )
              )
            );
        }


        if (
          POOLS[
            body.category
          ]
        ) {
          state.category =
            body.category;
        }


        await this.save(
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


      /* =========================================
         START GAME
      ========================================= */

      if (
        url.pathname.endsWith(
          "/start"
        ) &&
        request.method ===
          "POST"
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


        await this.start(
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


      /* =========================================
         SINGLE STROKE
      ========================================= */

      if (
        url.pathname.endsWith(
          "/stroke"
        ) &&
        request.method ===
          "POST"
      ) {

        if (
          state.phase !==
            "drawing" ||
          state.artistId !==
            playerId
        ) {
          return send(
            {
              error:
                "You cannot draw right now."
            },
            403
          );
        }


        const body =
          await request
            .json()
            .catch(
              () => ({})
            );


        const x = {
          x1: +body.x1,
          y1: +body.y1,
          x2: +body.x2,
          y2: +body.y2,

          color:
            String(
              body.color ||
                "#22262f"
            ).slice(
              0,
              20
            ),

          size:
            Math.max(
              2,
              Math.min(
                40,
                +body.size ||
                  7
              )
            ),

          tool:
            body.tool ===
              "eraser"
              ? "eraser"
              : "pen"
        };


        if (
          [
            x.x1,
            x.y1,
            x.x2,
            x.y2
          ].some(
            v =>
              !Number.isFinite(
                v
              )
          )
        ) {
          return send(
            {
              error:
                "Invalid stroke."
            },
            400
          );
        }


        state.strokes.push(
          x
        );


        if (
          state.strokes.length >
          1800
        ) {
          state.strokes.splice(
            0,
            state.strokes.length -
              1800
          );
        }


        await this.save(
          state
        );

        this.broadcast(
          state,
          "stroke"
        );

        return send({
          ok: true
        });
      }


      /* =========================================
         BATCH STROKES
      ========================================= */

      if (
        url.pathname.endsWith(
          "/strokes"
        ) &&
        request.method ===
          "POST"
      ) {

        if (
          state.phase !==
            "drawing" ||
          state.artistId !==
            playerId
        ) {
          return send(
            {
              error:
                "You cannot draw right now."
            },
            403
          );
        }


        const body =
          await request
            .json()
            .catch(
              () => ({})
            );


        const incoming =
          Array.isArray(
            body.strokes
          )
            ? body.strokes.slice(
                0,
                80
              )
            : [];


        for (
          const q of incoming
        ) {

          const x = {
            x1: +q.x1,
            y1: +q.y1,
            x2: +q.x2,
            y2: +q.y2,

            color:
              String(
                q.color ||
                  "#22262f"
              ).slice(
                0,
                20
              ),

            size:
              Math.max(
                2,
                Math.min(
                  40,
                  +q.size ||
                    7
                )
              ),

            tool:
              q.tool ===
                "eraser"
                ? "eraser"
                : "pen"
          };


          if (
            [
              x.x1,
              x.y1,
              x.x2,
              x.y2
            ].every(
              Number.isFinite
            )
          ) {
            state.strokes.push(
              x
            );
          }
        }


        if (
          state.strokes.length >
          1800
        ) {
          state.strokes.splice(
            0,
            state.strokes.length -
              1800
          );
        }


        await this.save(
          state
        );

        this.broadcast(
          state,
          "strokes"
        );

        return send({
          ok: true
        });
      }


      /* =========================================
         CLEAR
      ========================================= */

      if (
        url.pathname.endsWith(
          "/clear"
        ) &&
        request.method ===
          "POST"
      ) {

        if (
          state.artistId !==
            playerId ||
          state.phase !==
            "drawing"
        ) {
          return send(
            {
              error:
                "You cannot clear now."
            },
            403
          );
        }


        state.strokes = [];


        await this.save(
          state
        );

        this.broadcast(
          state,
          "clear"
        );

        return send({
          ok: true
        });
      }


      /* =========================================
         SUBMIT DRAWING
      ========================================= */

      if (
        url.pathname.endsWith(
          "/submit"
        ) &&
        request.method ===
          "POST"
      ) {

        if (
          state.artistId !==
            playerId ||
          state.phase !==
            "drawing"
        ) {
          return send(
            {
              error:
                "You cannot submit now."
            },
            403
          );
        }


        await this.finishDrawing(
          state,
          false
        );


        this.broadcast(
          state,
          "guessing"
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


      /* =========================================
         GUESS
      ========================================= */

      if (
        url.pathname.endsWith(
          "/guess"
        ) &&
        request.method ===
          "POST"
      ) {

        const guesser =
          this.player(
            state,
            playerId
          );


        if (
          !guesser ||
          state.phase !==
            "guessing" ||
          state.artistId ===
            playerId
        ) {
          return send(
            {
              error:
                "Guessing is not active."
            },
            403
          );
        }


        if (
          !this.guessers(
            state
          ).some(
            p =>
              p.id ===
              playerId
          )
        ) {
          return send(
            {
              error:
                "You cannot guess in this round."
            },
            403
          );
        }


        if (
          state.guesses.some(
            g =>
              g.id ===
              playerId
          )
        ) {
          return send(
            {
              error:
                "You already guessed."
            },
            409
          );
        }


        const body =
          await request
            .json()
            .catch(
              () => ({})
            );


        const guess =
          String(
            body.guess ||
              ""
          )
            .trim()
            .slice(
              0,
              80
            );


        if (!guess) {
          return send(
            {
              error:
                "Enter a guess."
            },
            400
          );
        }


        const correct =
          sameWord(
            guess,
            state.word
          );


        state.guesses.push({
          id:
            playerId,

          name:
            guesser.name,

          guess,

          correct
        });


        if (correct) {

          await this.finishRound(
            state,
            true,
            playerId
          );


          this.broadcast(
            state,
            "correct"
          );


          return send({
            ok: true,
            correct: true,
            state:
              publicState(
                state,
                playerId
              )
          });
        }


        const eligible =
          this.guessers(
            state
          );


        const wrongCount =
          state.guesses.filter(
            g =>
              !g.correct
          ).length;


        if (
          wrongCount >=
          eligible.length
        ) {

          await this.finishRound(
            state,
            false
          );

          this.broadcast(
            state,
            "wrong"
          );

        } else {

          await this.save(
            state
          );

          this.broadcast(
            state,
            "guess"
          );
        }


        return send({
          ok: true,
          correct: false,
          state:
            publicState(
              state,
              playerId
            )
        });
      }


      /* =========================================
         HINT
      ========================================= */

      if (
        url.pathname.endsWith(
          "/hint"
        ) &&
        request.method ===
          "POST"
      ) {

        if (
          state.phase !==
            "guessing" ||
          state.artistId ===
            playerId ||
          !this.guessers(
            state
          ).some(
            p =>
              p.id ===
              playerId
          )
        ) {
          return send(
            {
              error:
                "Hint unavailable."
            },
            403
          );
        }


        return send({
          ok: true,

          hint:
            String(
              state.word || ""
            ).slice(
              0,
              1
            ) +
            " • • •"
        });
      }


      /* =========================================
         CHAT
      ========================================= */

      if (
        url.pathname.endsWith(
          "/chat"
        ) &&
        request.method ===
          "POST"
      ) {

        const p =
          this.player(
            state,
            playerId
          );


        if (!p) {
          return send(
            {
              error:
                "Join the room first."
            },
            403
          );
        }


        const body =
          await request
            .json()
            .catch(
              () => ({})
            );


        const text =
          String(
            body.text ||
              ""
          )
            .trim()
            .slice(
              0,
              180
            );


        if (!text) {
          return send(
            {
              error:
                "Empty message."
            },
            400
          );
        }


        state.chat.push({
          id:
            playerId,

          name:
            p.name,

          text,

          at:
            Date.now()
        });


        if (
          state.chat.length >
          100
        ) {
          state.chat.shift();
        }


        await this.save(
          state
        );

        this.broadcast(
          state,
          "chat"
        );


        return send({
          ok: true
        });
      }


      /* =========================================
         NEXT ROUND
      ========================================= */

      if (
        url.pathname.endsWith(
          "/next"
        ) &&
        request.method ===
          "POST"
      ) {

        if (
          state.leaderId !==
          playerId
        ) {
          return send(
            {
              error:
                "Only the host can continue."
            },
            403
          );
        }


        if (
          state.phase !==
          "result"
        ) {
          return send(
            {
              error:
                "The current round is not finished."
            },
            409
          );
        }


        if (
          state.round >=
          state.rounds
        ) {

          state.phase =
            "finished";

          state.deadline =
            0;

          await this.save(
            state
          );

          this.broadcast(
            state,
            "finished"
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


        state.round++;


        state.artistIndex =
          (
            state.artistIndex +
            1
          ) %
          state.players.length;


        state.artistId =
          state.players[
            state.artistIndex
          ].id;


        state.word =
          this.chooseWord(
            state
          );


        state.prompt =
          state.word;


        state.strokes = [];

        state.guesses = [];

        state.lastSubmission =
          null;

        state.lastCorrect =
          false;

        state.lastWord =
          "";

        state.phase =
          "drawing";


        state.deadline =
          state.timeLimit
            ? Date.now() +
              state.timeLimit *
                1000
            : 0;


        await this.save(
          state
        );

        this.schedule(
          state
        );

        this.broadcast(
          state,
          "next"
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


      /* =========================================
         DELETE ROOM
      ========================================= */

      if (
        url.pathname.endsWith(
          "/delete"
        ) &&
        request.method ===
          "POST"
      ) {

        if (
          state.leaderId !==
          playerId
        ) {
          return send(
            {
              error:
                "Only the host can delete the room."
            },
            403
          );
        }


        for (
          const ws of
          this.sockets.values()
        ) {
          try {
            ws.close(
              1000,
              "Room deleted"
            );
          } catch {}
        }


        this.sockets.clear();


        await this.ctx.storage
          .deleteAll();


        return send({
          ok: true
        });
      }


      /* =========================================
         LEAVE
      ========================================= */

      if (
        url.pathname.endsWith(
          "/leave"
        ) &&
        request.method ===
          "POST"
      ) {

        state.players =
          state.players.filter(
            p =>
              p.id !==
              playerId
          );


        state.scores =
          state.scores.filter(
            p =>
              p.id !==
              playerId
          );


        if (
          state.leaderId ===
          playerId
        ) {
          state.leaderId =
            state.players[0]
              ?.id ||
            null;
        }


        if (
          !state.players.length
        ) {

          for (
            const ws of
            this.sockets.values()
          ) {
            try {
              ws.close(
                1000,
                "Room closed"
              );
            } catch {}
          }


          this.sockets.clear();


          await this.ctx.storage
            .deleteAll();


          return send({
            ok: true
          });
        }


        await this.save(
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


      /* =========================================
         WEBSOCKET
      ========================================= */

      if (
        request.headers.get(
          "Upgrade"
        )?.toLowerCase() ===
        "websocket"
      ) {

        const pair =
          new WebSocketPair();

        const server =
          pair[1];

        server.accept();


        /*
         IMPORTANT:
         playerId comes from:
         /draw/CODE?playerId=PLAYER_ID

         This makes each browser's
         socket belong to the correct
         player.
        */

        const socketId =
          playerId ||
          `socket-${crypto.randomUUID()}`;


        this.sockets.set(
          socketId,
          server
        );


        server.addEventListener(
          "close",
          () =>
            this.sockets.delete(
              socketId
            )
        );


        server.addEventListener(
          "error",
          () =>
            this.sockets.delete(
              socketId
            )
        );


        server.send(
          JSON.stringify({
            type: "state",

            state:
              publicState(
                state,
                socketId
              )
          })
        );


        return new Response(
          null,
          {
            status: 101,
            webSocket:
              pair[0]
          }
        );
      }


      return send({
        ok: true,
        service:
          "drawing-room"
      });

    } catch (e) {

      console.error(e);

      return send(
        {
          error:
            e?.message ||
            "Drawing room server error"
        },
        500
      );
    }
  }


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


    if (
      state.phase ===
      "drawing"
    ) {

      await this.finishDrawing(
        state,
        true
      );

      this.broadcast(
        state,
        "timeout"
      );

    } else if (
      state.phase ===
      "guessing"
    ) {

      await this.finishRound(
        state,
        false
      );

      this.broadcast(
        state,
        "timeout"
      );
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


    /* =========================================
       DRAWING ROOM
      ========================================= */

    if (
      url.pathname.startsWith(
        "/draw/"
      )
    ) {

      const code =
        url.pathname
          .slice(
            6
          )
          .split(
            "/"
          )[0]
          .trim();


      if (!code) {
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
          code
        );


      const room =
        env.DRAWING_ROOMS.get(
          id
        );


      return room.fetch(
        request
      );
    }


    /* =========================================
       HEALTH
      ========================================= */

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


    /* =========================================
       CODENAMES MATCHMAKING
      ========================================= */

    const stub =
      env.MATCHMAKER.get(
        env.MATCHMAKER.idFromName(
          "global-queue"
        )
      );


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
            id:
              playerId,
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

        const id =
          String(
            url.searchParams.get(
              "playerId"
            ) || ""
          ).trim();


        if (!id) {
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
            id
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

        const id =
          String(
            body?.playerId ||
              ""
          ).trim();


        if (!id) {
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
            id
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

    } catch (e) {

      console.error(e);

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
