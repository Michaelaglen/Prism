# Prism

An 8×8 block puzzle built for one thumb. Drag a piece onto the board, complete a
row or column, watch it go. The game ends when none of your three pieces fit.

Anonymous accounts, a real leaderboard, offline-first everywhere.

---

## Running it

`index.html` is self-contained — no bundler, no dependencies, no CDN. Service
workers and the manifest need a real origin, so serve the folder rather than
opening the file:

```bash
python3 -m http.server 8000
```

The game is fully playable before you set up Supabase. Without credentials it
runs local-only: scores save, the leaderboard says it isn't set up, and nothing
is faked.

**Installing on a phone** — iOS Safari: Share → Add to Home Screen. Android
Chrome: the install prompt appears on its own.

---

## Files

```
index.html                          the whole game — markup, styles, engine
manifest.webmanifest, sw.js         PWA shell and offline cache
icons/                              app icons
src/                                readable source, split into modules
  01-core.js        utilities, storage, audio, haptics, pieces, bitboard
  02-generator.js   adaptive piece generation
  03-supabase.js    auth, profile, leaderboard, run queue
  04-game.js        state, scoring, effects, run lifecycle
  05-render.js      layout and canvas renderer
  06-input.js       dragging
  07-ui.js          HUD, screens, boot
supabase/migrations/0001_prism_init.sql    schema, RLS, ranking
supabase/functions/submit-run/index.ts     the only path to the leaderboard
build.py                            concatenates src/ back into index.html
test/                               simulation, browser, and integration tests
```

Edit `src/`, then run `python3 build.py`.

---

## Supabase setup

Four steps, all in the dashboard.

**1. Enable anonymous sign-ins.**
Authentication → Sign In / Providers → Anonymous sign-ins → on.
Nothing works without this; the client will report
"Anonymous sign-ins are disabled for this project".

**2. Run the migration.**
SQL Editor → paste `supabase/migrations/0001_prism_init.sql` → Run.
Creates `profiles`, `runs`, `player_stats`, the `leaderboard` view, the
`player_rank` and `apply_run` functions, and all RLS policies.

**3. Deploy the Edge Function.**

```bash
supabase link --project-ref <your-ref>
supabase functions deploy submit-run
```

No secrets to set: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected
into Edge Functions automatically. Do not add them anywhere else.

**4. Put your keys in the client.**
Top of `src/03-supabase.js`, then `python3 build.py`:

```js
const SUPABASE_URL      = 'https://<your-ref>.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';   // Project Settings → API → anon public
```

The **anon** key only. The service-role key must never reach the browser.

---

## How it fits together

**Identity.** On first Play the client calls anonymous sign-in, takes the
returned auth UUID as the permanent player id, and inserts a `profiles` row with
the typed name. Returning players reuse the stored session; the server's
username wins, so a rename on one device follows them. Display names are not
unique — the UUID is the identity.

**Runs.** Every game generates `run_id = crypto.randomUUID()` at start and
records its seed and full move list. On game over the run is written to the local
queue *first*, then submitted. Because `run_id` is the primary key of `runs`,
resubmitting is a no-op, which is what makes retrying safe.

**Submission.** The browser cannot write to `runs` or `player_stats` at all —
there is no RLS policy permitting it. Scores enter only through `submit-run`,
which verifies the JWT, checks `player_id` matches the caller, validates the
payload, inserts idempotently, updates the best atomically via `apply_run`, and
returns the real rank, population and percentile.

**The result screen never waits.** It opens with score, best and games from local
state and shows "Checking rank…" where the rank goes. The submission runs
alongside it. When the answer arrives the rank animates in; if it never arrives,
the line reads pending or offline. It is never filled with a guess.

**Deterministic runs.** `G.gameRng` is seeded and drives piece generation only.
Colours, particles, screen shake and the "Nice"/"Clean" rolls use `Math.random`.
So seed + moves reproduces a run exactly, which is what lets the Edge Function
grow into a full replay validator later.

---

## Database

| Table | Purpose | Client access |
|---|---|---|
| `profiles` | id (= auth user), username, timestamps | read all; insert/update own row only |
| `runs` | one row per game: score, seed, moves, timestamps | read own only; **no** write |
| `player_stats` | best_score, best_at, games_played | read all; **no** write |
| `leaderboard` (view) | ranked, one row per player, `best_score > 0` | read all |

Indexes: `runs(player_id, ended_at desc)`, `runs(score desc, ended_at asc)`, and
a partial `player_stats(best_score desc, best_at asc, player_id asc) where
best_score > 0` matching the exact ranking order.

Ties break by highest score, then earliest time that score was reached, then
player id — stable and deterministic.

---

## Testing

```bash
node test/sim.js            # 180 headless games: pacing, difficulty, generator speed
node test/determinism.js    # seed + moves reproduce a run exactly
python3 test/viewports.py   # layout across six phone sizes
python3 test/shots.py       # drives a real browser, screenshots every screen

python3 test/mock_supabase.py &   # mock backend on :8912
python3 test/supabase_e2e.py      # 32 integration checks against it
```

`test/mock_supabase.py` implements the same auth, REST and Edge Function
endpoints as the real project, including a `/__control` hook for injecting
network latency. `supabase_e2e.py` builds its own `index.test.html`, so the
shipped `index.html` never carries test credentials.

---

## Hosting on GitHub Pages

Every path in the app is relative, so it works from a project sub-path
(`https://<user>.github.io/<repo>/`) with no changes. Verified: the service
worker registers with the correct scope, and the manifest and icons resolve.

1. Create a **public** repo (free Pages requires public) and push the contents of
   this folder to `main` — `index.html` at the repo root, not nested.
2. Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)` → Save.
3. Wait ~60 seconds, then open `https://<user>.github.io/<repo>/`.

The `.nojekyll` file in this folder matters: without it GitHub runs the files
through Jekyll, which skips anything beginning with an underscore and slows the
build for no benefit.

If you name the repo `<user>.github.io`, it is served from the domain root
instead of a sub-path. Both work.

**Your anon key will be public in the repo — that is fine.** The anon key is
designed to be shipped to browsers; RLS is what protects the data, and this
schema gives the client no write access to scores at all. The service-role key
must never appear in any file you commit.

**Updating the deployed game.** The service worker serves the cached shell first
and refreshes in the background, so returning players see the previous version
once and the new one on their next open. To push a change out immediately, bump
`CACHE` in `sw.js` (`prism-v2` → `prism-v3`) — the old cache is deleted on
activate.

Supabase needs no extra configuration for this: anonymous auth involves no
redirect, and the Edge Function already sends permissive CORS headers.

---

## Known limitations

- **Ranking recomputes a window function per query.** Fine into the tens of
  thousands of players; past that, materialise `leaderboard` and refresh it on a
  schedule.
- **Validation is structural, not a replay.** The function checks bounds,
  plausibility and duration but does not yet re-simulate the run. The data needed
  to do so is stored from day one.
- **Accounts are anonymous only.** Clearing site data on a device with no linked
  identity loses that player. Linking to Google/Apple/email is a later phase; the
  Settings screen already has the row for it.
- **Haptics are Android-only in practice.** iOS Safari exposes no Vibration API.
- **Storage falls back to memory** where `localStorage` is blocked, so sandboxed
  previews forget between sessions.
- **Portrait only.**
