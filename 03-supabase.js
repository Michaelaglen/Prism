/* ============================================================
   03 · supabase backend
   ------------------------------------------------------------
   Anonymous identity, real leaderboard, idempotent run submission.

   Deliberately dependency-free: this talks to Supabase's REST and
   auth endpoints with fetch, so index.html stays self-contained and
   the game still boots with the radio off. Swapping in supabase-js
   would mean a module script and a CDN round trip on first load,
   which is the one thing the offline-first design can't afford.

   Nothing here ever invents a score, a rank or a player.
   ============================================================ */

/* ---- fill these in; see README ---- */
const SUPABASE_URL      = '';
const SUPABASE_ANON_KEY = '';

const CONFIGURED = SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 20;

const uuid = ()=> (crypto.randomUUID
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
      const r = Math.random()*16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

/* a failure we should stop retrying: the server looked at it and said no */
function netError(status, message){
  const e = new Error(message || ('HTTP ' + status));
  e.status = status;
  e.permanent = status === 400 || status === 403 || status === 404 || status === 422;
  return e;
}

/* ============================================================
   session — anonymous auth, persisted and refreshed
   ============================================================ */
const Session = (()=>{
  let current = Store.get(K.session, null);
  let pending = null;

  const store = s=>{ current = s; Store.set(K.session, s); return s; };
  const fresh = ()=> current && current.access_token &&
                     (current.expires_at || 0) * 1000 > Date.now() + 60000;

  function shape(json){
    if(!json || !json.access_token) return null;
    return {
      access_token:  json.access_token,
      refresh_token: json.refresh_token,
      expires_at:    json.expires_at || Math.floor(Date.now()/1000) + (json.expires_in || 3600),
      user:          { id: json.user && json.user.id }
    };
  }

  async function authPost(path, body){
    const res = await fetch(SUPABASE_URL + '/auth/v1' + path, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if(!res.ok){
      let detail = '';
      try { const j = await res.json(); detail = j.msg || j.error_description || j.message || j.error || ''; }
      catch(e){}
      throw netError(res.status, detail);
    }
    return res.json();
  }

  async function signInAnonymously(){
    const json = await authPost('/signup', { data: {}, gotrue_meta_security: {} });
    const s = shape(json);
    if(!s || !s.user.id) throw netError(422, 'Anonymous sign-ins are disabled for this project');
    return store(s);
  }

  async function refresh(){
    const json = await authPost('/token?grant_type=refresh_token',
                                { refresh_token: current.refresh_token });
    const s = shape(json);
    if(!s) throw netError(401, 'refresh returned no session');
    return store(s);
  }

  async function ensure(){
    if(fresh()) return current;
    if(pending) return pending;

    pending = (async ()=>{
      if(current && current.refresh_token){
        try { return await refresh(); }
        catch(e){
          /* A rejected token means this identity is gone and a new anonymous
             user is correct. A network failure means the identity is fine and
             minting a second one would silently orphan their scores. */
          if(!e.permanent && e.status !== 401) throw e;
          Store.set(K.session, null); current = null;
        }
      }
      return signInAnonymously();
    })();

    try { return await pending; }
    finally { pending = null; }
  }

  return {
    ensure,
    get id(){ return current && current.user ? current.user.id : null; },
    get token(){ return current ? current.access_token : null; },
    clear(){ Store.set(K.session, null); current = null; }
  };
})();

/* ============================================================
   rest helper
   ============================================================ */
async function rest(path, opts = {}){
  const s = await Session.ensure();
  const headers = Object.assign({
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + s.access_token,
    'Content-Type': 'application/json'
  }, opts.headers || {});

  let res = await fetch(SUPABASE_URL + path, Object.assign({}, opts, { headers }));

  if(res.status === 401){                      // token died mid-flight; one retry
    Session.clear();
    const s2 = await Session.ensure();
    headers['Authorization'] = 'Bearer ' + s2.access_token;
    res = await fetch(SUPABASE_URL + path, Object.assign({}, opts, { headers }));
  }
  return res;
}

/* ============================================================
   player — identity and profile
   ============================================================ */
const Player = {
  id:    Store.get(K.pid, null),
  name:  Store.get(K.name, null),
  state: CONFIGURED ? 'idle' : 'unconfigured',   // idle | connecting | ready | error
  error: null
};

async function ensureProfile(){
  const got = await rest(`/rest/v1/profiles?id=eq.${Player.id}&select=username`);
  if(got.ok){
    const rows = await got.json();
    if(rows.length){                            // returning player — server wins
      Player.name = rows[0].username;
      Store.set(K.name, Player.name);
      return;
    }
  }
  const name = (Store.get(K.name, '') || 'Player').slice(0, 14);
  const made = await rest('/rest/v1/profiles', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ id: Player.id, username: name })
  });
  if(!made.ok && made.status !== 409) throw netError(made.status, 'could not create profile');
  Player.name = name;
}

/* server is authoritative for the official best, but an unsynced offline run
   may legitimately be ahead of it */
async function pullStats(){
  const res = await rest(`/rest/v1/player_stats?player_id=eq.${Player.id}&select=best_score,games_played`);
  if(!res.ok) return;
  const rows = await res.json();
  if(!rows.length) return;
  Store.set(K.best,  Math.max(Store.get(K.best, 0),  rows[0].best_score   || 0));
  Store.set(K.games, Math.max(Store.get(K.games, 0), rows[0].games_played || 0));
}

async function connect(force){
  if(!CONFIGURED){ Player.state = 'unconfigured'; return null; }
  if(Player.state === 'ready' && !force) return Player.id;
  if(Player.state === 'connecting') return null;

  Player.state = 'connecting';
  Player.error = null;
  try {
    const s = await Session.ensure();
    Player.id = s.user.id;
    Store.set(K.pid, Player.id);
    await ensureProfile();
    await pullStats();
    Player.state = 'ready';
    if(typeof syncHUD === 'function') syncHUD();
    Leaderboard.flush();
    return Player.id;
  } catch(e){
    Player.state = 'error';
    Player.error = (e && e.message) || 'connection failed';
    return null;
  }
}

async function setUsername(name){
  const v = String(name || '').trim().slice(0, 14);
  if(!v) return;
  Store.set(K.name, v);
  Player.name = v;
  if(!CONFIGURED) return;
  try {
    if(Player.state !== 'ready') await connect();
    if(Player.state !== 'ready') return;
    await rest(`/rest/v1/profiles?id=eq.${Player.id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ username: v, updated_at: new Date().toISOString() })
    });
  } catch(e){ /* name is cached locally; next connect will carry it */ }
}

/* ============================================================
   leaderboard
   ============================================================ */
const Leaderboard = (()=>{
  let flushing = false;

  function totalFrom(res){
    const range = res.headers.get('content-range');       // "0-39/121"
    if(!range) return null;
    const n = parseInt(range.split('/')[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  async function submitRun(run){
    const s = await Session.ensure();
    const res = await fetch(SUPABASE_URL + '/functions/v1/submit-run', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + s.access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(Object.assign({ player_id: Player.id }, run))
    });
    if(!res.ok){
      let msg = '';
      try { msg = (await res.json()).error || ''; } catch(e){}
      throw netError(res.status, msg);
    }
    return res.json();
  }

  return {
    /* top N, plus the real number of ranked players */
    async top(limit = 40){
      if(!CONFIGURED) throw netError(503, 'backend not configured');
      const res = await rest(
        `/rest/v1/leaderboard?select=rank,player_id,username,score&order=rank.asc&limit=${limit}`,
        { headers: { 'Prefer': 'count=exact' } }
      );
      if(!res.ok) throw netError(res.status, 'leaderboard unavailable');
      return { rows: await res.json(), total: totalFrom(res) };
    },

    /* this player's real position, or null if they have no ranked run yet */
    async standing(){
      if(!CONFIGURED) throw netError(503, 'backend not configured');
      if(!Player.id) await connect();
      if(!Player.id) throw netError(503, 'no player');
      const res = await rest(
        `/rest/v1/leaderboard?player_id=eq.${Player.id}&select=rank,username,score`);
      if(!res.ok) throw netError(res.status, 'standing unavailable');
      const rows = await res.json();
      return rows.length ? rows[0] : null;
    },

    /* queue first, then try — so a run is never lost to a dropped connection */
    async record(run){
      const q = Store.get(K.queue, []);
      q.push(run);
      Store.set(K.queue, q.slice(-60));
      return this.flush(run.run_id);
    },

    async flush(wantId){
      if(!CONFIGURED || flushing) return null;
      const queued = Store.get(K.queue, []);
      if(!queued.length) return null;
      if(Player.state !== 'ready'){
        await connect();
        if(Player.state !== 'ready') return null;
      }

      flushing = true;
      let answer = null;
      const keep = [];
      try {
        for(const run of queued){
          try {
            const res = await submitRun(run);
            if(run.run_id === wantId) answer = res;
          } catch(e){
            if(e.permanent) console.warn('run rejected, dropping:', run.run_id, e.message);
            else keep.push(run);                 // transient — try again later
          }
        }
      } finally {
        Store.set(K.queue, keep);
        flushing = false;
      }
      return answer;
    },

    get pendingCount(){ return Store.get(K.queue, []).length; }
  };
})();
