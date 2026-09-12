// ============================================================
// submit-run
// The only way a score reaches the leaderboard.
//
// Verifies the caller, validates the run, stores it idempotently
// (the client's run UUID is the primary key), updates the player's
// best, and returns their real position.
//
// Deploy:  supabase functions deploy submit-run
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Bounds mirror the client's rules. They are sanity limits, not a replay.
const BOARD = 8;
const PIECE_COUNT = 40;        // PIECE_DEFS.length in src/01-core.js
const MAX_MOVES = 4000;        // ~5x the longest run seen in simulation
const MAX_POINTS_PER_MOVE = 16_209;   // 9 cells + best possible clear x max combo
const MIN_MS_PER_MOVE = 40;    // faster than any human hand
const MAX_RUN_MS = 12 * 60 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const fail = (status: number, error: string) => json({ error }, status);

function validate(b: Record<string, any>): string | null {
  if (!b || typeof b !== 'object') return 'malformed body';

  if (typeof b.run_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.run_id))
    return 'invalid run_id';

  if (!Number.isInteger(b.score) || b.score < 0) return 'invalid score';
  if (!Number.isFinite(b.seed) || !Number.isInteger(b.seed) || b.seed < 0) return 'invalid seed';

  if (!Array.isArray(b.moves)) return 'invalid moves';
  if (b.moves.length > MAX_MOVES) return 'too many moves';

  for (const m of b.moves) {
    if (!Array.isArray(m) || m.length !== 3) return 'malformed move';
    const [piece, row, col] = m;
    if (!Number.isInteger(piece) || piece < 0 || piece >= PIECE_COUNT) return 'invalid piece index';
    if (!Number.isInteger(row) || row < 0 || row >= BOARD) return 'invalid row';
    if (!Number.isInteger(col) || col < 0 || col >= BOARD) return 'invalid column';
  }

  const started = Date.parse(b.started_at);
  const ended = Date.parse(b.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 'invalid timestamps';

  const duration = ended - started;
  if (duration < 0) return 'run ends before it starts';
  if (duration > MAX_RUN_MS) return 'implausible duration';
  if (duration < b.moves.length * MIN_MS_PER_MOVE) return 'implausibly fast';
  if (ended > Date.now() + 5 * 60 * 1000) return 'run ends in the future';

  // A score needs moves behind it, and each move can only be worth so much.
  if (b.score > b.moves.length * MAX_POINTS_PER_MOVE) return 'score exceeds what these moves allow';
  if (b.score > 0 && b.moves.length === 0) return 'score without moves';

  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'method not allowed');

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(401, 'missing authorization');

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // 1. who is calling
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth?.user) return fail(401, 'not authenticated');
  const uid = auth.user.id;

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail(400, 'invalid JSON'); }

  // 2. the run must belong to the caller
  if (body.player_id && body.player_id !== uid) return fail(403, 'player_id does not match caller');

  // 3. does it look like a real game
  const problem = validate(body);
  if (problem) return fail(422, problem);

  // the profile should already exist; create a placeholder rather than lose a run
  await admin.from('profiles')
    .insert({ id: uid, username: 'Player' })
    .select('id')
    .maybeSingle()
    .then(() => {}, () => {});

  // rank before this run, so the client can animate the climb
  const { data: before } = await admin.rpc('player_rank', { p: uid });
  const previousRank = before?.[0]?.rank ?? null;

  // 4 + 5. store it — the run UUID makes a retry a no-op
  const { error: insErr } = await admin.from('runs').insert({
    id: body.run_id,
    player_id: uid,
    score: body.score,
    seed: body.seed,
    moves: body.moves,
    move_count: body.moves.length,
    started_at: new Date(Date.parse(body.started_at)).toISOString(),
    ended_at: new Date(Date.parse(body.ended_at)).toISOString(),
  });

  const duplicate = insErr?.code === '23505';
  if (insErr && !duplicate) {
    console.error('run insert failed', insErr);
    return fail(500, 'could not store run');
  }

  // 6. only a genuinely new run moves the player's totals
  if (!duplicate) {
    const { error: statErr } = await admin.rpc('apply_run', {
      p: uid,
      s: body.score,
      ended: new Date(Date.parse(body.ended_at)).toISOString(),
    });
    if (statErr) {
      console.error('apply_run failed', statErr);
      return fail(500, 'could not update stats');
    }
  }

  // 7. real position, real population
  const { data: after } = await admin.rpc('player_rank', { p: uid });
  const rank = after?.[0]?.rank ?? null;
  const total = after?.[0]?.total ?? 0;

  const { data: stats } = await admin
    .from('player_stats')
    .select('best_score, games_played')
    .eq('player_id', uid)
    .maybeSingle();

  return json({
    run_id: body.run_id,
    duplicate,
    score: body.score,
    best: stats?.best_score ?? body.score,
    games_played: stats?.games_played ?? 1,
    rank,
    previous_rank: previousRank,
    total_players: total,
    percentile: rank && total ? Math.max(1, Math.ceil((Number(rank) / Number(total)) * 100)) : null,
  });
});
