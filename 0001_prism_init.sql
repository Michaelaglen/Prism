-- ============================================================
-- Prism — schema, policies and ranking
-- Run once in the Supabase SQL editor, or via `supabase db push`.
-- ============================================================

-- ---------- profiles ----------
-- One row per player. id is the anonymous auth user; usernames are display
-- names only and are deliberately NOT unique — the UUID is the identity.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null check (char_length(trim(username)) between 1 and 14),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- runs ----------
-- id is the client-generated run UUID. It is the primary key, which is what
-- makes resubmitting a queued run a no-op instead of a duplicate score.
create table if not exists public.runs (
  id         uuid primary key,
  player_id  uuid not null references public.profiles(id) on delete cascade,
  score      integer not null check (score >= 0),
  seed       bigint  not null,
  moves      jsonb   not null,
  move_count integer not null check (move_count >= 0),
  started_at timestamptz not null,
  ended_at   timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists runs_player_idx on public.runs (player_id, ended_at desc);
create index if not exists runs_score_idx  on public.runs (score desc, ended_at asc);

-- ---------- player_stats ----------
-- Denormalised best/games so ranking never has to scan every run.
create table if not exists public.player_stats (
  player_id    uuid primary key references public.profiles(id) on delete cascade,
  best_score   integer not null default 0,
  best_at      timestamptz,
  games_played integer not null default 0,
  updated_at   timestamptz not null default now()
);

-- the exact ordering used for ranking, so the index can serve it
create index if not exists player_stats_rank_idx
  on public.player_stats (best_score desc, best_at asc, player_id asc)
  where best_score > 0;

-- ============================================================
-- ranking
-- ============================================================

-- One row per player, ranked. Only players with a real score appear.
create or replace view public.leaderboard
with (security_invoker = true) as
  select
    row_number() over (
      order by s.best_score desc, s.best_at asc nulls last, s.player_id asc
    ) as rank,
    s.player_id,
    p.username,
    s.best_score as score,
    s.best_at,
    s.games_played
  from public.player_stats s
  join public.profiles p on p.id = s.player_id
  where s.best_score > 0;

-- A player's exact position and the true population, in one round trip.
create or replace function public.player_rank(p uuid)
returns table (rank bigint, total bigint)
language sql stable security definer set search_path = public as $$
  with ranked as (
    select player_id,
           row_number() over (
             order by best_score desc, best_at asc nulls last, player_id asc
           ) as rn,
           count(*) over () as total
    from public.player_stats
    where best_score > 0
  )
  select rn, total from ranked where player_id = p;
$$;

-- Atomic best/games update. Called only by the Edge Function.
create or replace function public.apply_run(p uuid, s integer, ended timestamptz)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.player_stats (player_id, best_score, best_at, games_played)
  values (p, s, case when s > 0 then ended end, 1)
  on conflict (player_id) do update set
    games_played = public.player_stats.games_played + 1,
    best_score   = greatest(public.player_stats.best_score, excluded.best_score),
    best_at      = case
                     when excluded.best_score > public.player_stats.best_score
                     then excluded.best_at
                     else public.player_stats.best_at
                   end,
    updated_at   = now();
end; $$;

-- ============================================================
-- row level security
-- ============================================================
alter table public.profiles     enable row level security;
alter table public.runs         enable row level security;
alter table public.player_stats enable row level security;

-- Usernames and best scores are the leaderboard; they are public by design.
drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable"
  on public.profiles for select using (true);

drop policy if exists "players create their own profile" on public.profiles;
create policy "players create their own profile"
  on public.profiles for insert to authenticated with check (auth.uid() = id);

drop policy if exists "players rename themselves" on public.profiles;
create policy "players rename themselves"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "stats are publicly readable" on public.player_stats;
create policy "stats are publicly readable"
  on public.player_stats for select using (true);
-- no insert/update/delete policy: only the service role may write stats

drop policy if exists "players read their own runs" on public.runs;
create policy "players read their own runs"
  on public.runs for select to authenticated using (auth.uid() = player_id);
-- no insert/update/delete policy: runs enter only through submit-run

grant select on public.leaderboard to anon, authenticated;
grant execute on function public.player_rank(uuid) to anon, authenticated;
revoke execute on function public.apply_run(uuid, integer, timestamptz) from anon, authenticated;
