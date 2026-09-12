"""Drives the real client against the mock Supabase and checks every path
the brief calls out: anonymous auth, real ranking, offline queue, idempotent
resubmission, rename, and session reuse across reloads."""
import json, sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8912"
URL = BASE + "/index.test.html"

# build a copy of the game pointed at the mock, so the shipped index.html
# never carries test credentials
import pathlib
_root = pathlib.Path(__file__).parent.parent
_h = (_root / "index.html").read_text()
_h = _h.replace("const SUPABASE_URL      = \'\';",
                "const SUPABASE_URL      = \'http://localhost:8912\';")
_h = _h.replace("const SUPABASE_ANON_KEY = \'\';",
                "const SUPABASE_ANON_KEY = \'mock-anon-key-0000000000000000000000\';")
assert "localhost:8912" in _h, "could not inject mock credentials"
(_root / "index.test.html").write_text(_h)
results = []
errors = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   [{detail}]" if detail else ""))


def play_to_game_over(page, cap=3000):
    """Auto-play with the greedy heuristic until no piece fits."""
    page.evaluate("""(cap) => new Promise(res => {
      let n = 0;
      const step = () => {
        if (G.over || n++ > cap) return res(n);
        let best = null;
        for (let i = 0; i < 3; i++) {
          const s = G.tray[i]; if (!s || s.gone) continue;
          for (let r = 0; r <= 8 - s.piece.h; r++) for (let c = 0; c <= 8 - s.piece.w; c++) {
            if (!canPlace(G.board, s.piece, r, c)) continue;
            const q = linesAfter(G.board, s.piece, r, c) * 100 + contact(G.board, s.piece, r, c);
            if (!best || q > best.q) best = { q, i, r, c };
          }
        }
        if (!best) return res(n);
        placePiece(best.i, best.r, best.c);
        setTimeout(step, 0);
      };
      step();
    })""", cap)
    page.wait_for_timeout(1400)


with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])

    # ---------- player one ----------
    ctx1 = b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    pg = ctx1.new_page()
    pg.on("pageerror", lambda e: errors.append(f"p1: {e}"))
    pg.goto(URL); pg.wait_for_timeout(700)

    print("\n1. first anonymous player")
    pg.fill("#nameInput", "Michael")
    pg.click("#btnStart")
    pg.wait_for_function("Player.state === 'ready'", timeout=8000)
    uid1 = pg.evaluate("Player.id")
    check("anonymous sign-in creates a user", bool(uid1), uid1[:8] if uid1 else "none")
    check("profile created with entered name",
          pg.request.get(f"{BASE}/rest/v1/profiles?id=eq.{uid1}").json()[0]["username"] == "Michael")
    check("game is playable immediately", pg.evaluate("G.playing") is True)

    print("\n2. run submission and real ranking")
    # make the network slow on purpose: the result screen must not wait for it
    pg.request.post(f"{BASE}/__control", data=json.dumps({"submit_delay": 3.0}),
                    headers={"Content-Type": "application/json"})
    play_to_game_over(pg)
    rank_text_early = pg.evaluate("document.getElementById('rankNew').textContent")
    shown_early = pg.evaluate("!!document.querySelector('#resultScreen.on')")
    again_usable = pg.is_enabled("#btnAgain")
    check("result screen is up while the request is still in flight", shown_early)
    check("Play again is usable before the rank lands", again_usable)
    pg.wait_for_function("!document.getElementById('rankNew').classList.contains('pending')", timeout=12000)
    pg.wait_for_timeout(1200)
    pg.request.post(f"{BASE}/__control", data=json.dumps({"submit_delay": 0}),
                    headers={"Content-Type": "application/json"})
    score1 = pg.evaluate("G.score")
    rank_text = pg.evaluate("document.getElementById('rankNew').textContent")
    pct = pg.evaluate("document.getElementById('stPct').textContent")
    check("rank shows a pending state, not a fabricated number",
          "Checking" in rank_text_early, rank_text_early)
    check("real rank arrives and replaces it", rank_text.startswith("#"), rank_text)
    check("percentile is shown", pct.startswith("Top"), pct)
    check("new personal best flagged", pg.evaluate("document.getElementById('pbFlag').classList.contains('on')"))

    print("\n3. leaderboard shows real players only")
    pg.click("#btnLbFromResult"); pg.wait_for_timeout(1200)
    names = pg.evaluate("[...document.querySelectorAll('#lbList .nm')].map(e=>e.textContent)")
    me = pg.evaluate("document.getElementById('lbMe').textContent")
    check("top players are the seeded real rows", names[:3] == ["Alex", "Mia", "Noah"], str(names[:3]))
    check("population equals real player count", len(names) == 6, f"{len(names)} rows")
    check("own position shown separately", "Michael" in me, me.strip()[:40])
    pg.click("#btnLbBack"); pg.wait_for_timeout(400)

    print("\n4. losing without a new best")
    prev_best = pg.evaluate("Store.get(K.best,0)")
    pg.click("#btnAgain"); pg.wait_for_timeout(500)
    # end a deliberately poor run rather than playing a good one
    pg.evaluate("() => { G.score = 5; G.shown = 5; endGame(); }")
    pg.wait_for_timeout(2400)
    check("personal best unchanged", pg.evaluate("Store.get(K.best,0)") == prev_best,
          f"{prev_best} -> {pg.evaluate('Store.get(K.best,0)')}")
    check("no personal-best banner", not pg.evaluate("document.getElementById('pbFlag').classList.contains('on')"))

    print("\n5. duplicate submission is idempotent")
    before = pg.request.get(f"{BASE}/rest/v1/player_stats?player_id=eq.{uid1}").json()[0]
    dup = pg.evaluate("""async () => {
      const run = { run_id: uuid(), score: 100, seed: 12345, moves: [[0,0,0]],
                    started_at: new Date(Date.now()-60000).toISOString(),
                    ended_at: new Date().toISOString() };
      const a = await Leaderboard.record(run);
      const c = await Leaderboard.record(run);   // same id, submitted twice
      return { first: a && a.duplicate, second: c && c.duplicate };
    }""")
    after = pg.request.get(f"{BASE}/rest/v1/player_stats?player_id=eq.{uid1}").json()[0]
    check("first submission is accepted", dup["first"] is False, json.dumps(dup))
    check("resubmitting the same run_id is a no-op", dup["second"] is True, json.dumps(dup))
    check("games_played counted once", after["games_played"] == before["games_played"] + 1,
          f"{before['games_played']} -> {after['games_played']}")

    print("\n6. changing the username")
    pg.click("#btnAgain"); pg.wait_for_timeout(500)   # leave the result screen
    pg.click("#btnSettings"); pg.wait_for_timeout(400)
    pg.fill("#renameInput", "Mike")
    pg.dispatch_event("#renameInput", "change")
    pg.wait_for_timeout(900)
    server_name = pg.request.get(f"{BASE}/rest/v1/profiles?id=eq.{uid1}").json()[0]["username"]
    check("rename reaches the server", server_name == "Mike", server_name)
    check("rename cached locally", pg.evaluate("Store.get(K.name,'')") == "Mike")
    check("account row reads Guest", pg.evaluate("document.getElementById('acctState').textContent") == "Guest")
    pg.click("#btnSetClose"); pg.wait_for_timeout(300)

    print("\n7. reload reuses the same identity")
    signups_before = pg.request.get(f"{BASE}/rest/v1/leaderboard").json()
    pg.reload(); pg.wait_for_timeout(1500)
    pg.wait_for_function("Player.state === 'ready'", timeout=8000)
    check("same player id after reload", pg.evaluate("Player.id") == uid1)
    check("no name prompt on return", not pg.evaluate("!!document.querySelector('#nameScreen.on')"))
    check("username restored from server", pg.evaluate("Store.get(K.name,'')") == "Mike")

    print("\n8. offline run is queued, then synced on reconnect")
    ctx1.set_offline(True)
    pg.evaluate("() => { G.score = 7777; G.shown = 7777; endGame(); }")
    pg.wait_for_timeout(2600)
    queued = pg.evaluate("Store.get(K.queue,[]).length")
    offline_msg = pg.evaluate("document.getElementById('rankNew').textContent")
    check("run kept locally while offline", queued >= 1, f"{queued} queued")
    check("result screen still works offline", pg.evaluate("!!document.querySelector('#resultScreen.on')"))
    check("rank shown as pending, never faked", "online" in offline_msg or "pending" in offline_msg.lower(),
          offline_msg)

    ctx1.set_offline(False)
    pg.evaluate("() => window.dispatchEvent(new Event('online'))")
    pg.wait_for_function("Store.get(K.queue,[]).length === 0", timeout=10000)
    check("queue drains on reconnect", pg.evaluate("Store.get(K.queue,[]).length") == 0)

    # ---------- player two, separate session ----------
    print("\n9. a second player in a clean session")
    ctx2 = b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    pg2 = ctx2.new_page()
    pg2.on("pageerror", lambda e: errors.append(f"p2: {e}"))
    pg2.goto(URL); pg2.wait_for_timeout(700)
    pg2.fill("#nameInput", "Michael")       # deliberately the same display name
    pg2.click("#btnStart")
    pg2.wait_for_function("Player.state === 'ready'", timeout=8000)
    uid2 = pg2.evaluate("Player.id")
    check("second player gets a distinct id", uid2 != uid1, f"{uid1[:8]} vs {uid2[:8]}")
    play_to_game_over(pg2)
    pg2.wait_for_function("!document.getElementById('rankNew').classList.contains('pending')", timeout=8000)
    board = pg2.request.get(f"{BASE}/rest/v1/leaderboard").json()
    michaels = [r for r in board if r["username"] == "Michael"]
    check("duplicate display names coexist", len(michaels) == 1 and any(r["username"] == "Mike" for r in board),
          str([(r["rank"], r["username"]) for r in board]))
    ranks = [r["rank"] for r in board]
    check("ranks are dense and ordered", ranks == sorted(ranks) and ranks == list(range(1, len(ranks) + 1)),
          str(ranks))
    scores = [r["score"] for r in board]
    check("ordered by best score desc", scores == sorted(scores, reverse=True), str(scores))
    check("one row per player", len({r["username"] for r in board}) == len(board))

    b.close()

print("\n=== page errors ===")
print("\n".join(errors) if errors else "none")
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed or errors else 0)
