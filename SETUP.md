# Connecting Prism to Supabase

Four steps. You have already done step 0.

---

## Step 0 — Enable anonymous sign-ins ✅

Authentication → Sign In / Providers → **Anonymous sign-ins** → on.

You said this is done. If the game later reports
*"Anonymous sign-ins are disabled for this project"*, come back and check it.

---

## Step 1 — Create the database

Supabase dashboard → **SQL Editor** → **New query**.

Open `supabase/schema.sql` from this folder, copy **all** of it, paste it into
the editor, and press **Run**.

You should see "Success. No rows returned." That is correct — it creates things
rather than returning data.

**How to check it worked:** go to **Table Editor**. You should see three new
tables: `profiles`, `runs`, `player_stats`. They will all be empty.

If you see an error mentioning something already exists, the script is safe to
run more than once; that error is harmless.

---

## Step 2 — Deploy the scoring function

This is the only piece that does not live in the database. It is the guarded
door that scores come through, so the browser can never write a score directly.

Dashboard → **Edge Functions** → **Deploy a new function** → choose creating it
in the editor.

- Name it **exactly** `submit-run` (hyphen, not underscore). The game calls this
  name; a typo here is the most common reason scores never appear.
- Delete the placeholder code in the editor.
- Open `supabase/submit-run.ts` from this folder, copy all of it, paste it in.
- Deploy.

There are **no secrets to configure**. Supabase injects the credentials this
function needs automatically. If you are ever asked to paste a `service_role`
key somewhere, stop — that key must never leave the dashboard.

**If your dashboard has no in-browser editor**, you need the CLI instead:

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy submit-run
```

Your project ref is the random-looking part of your project URL
(`https://`**`abcdefghijklm`**`.supabase.co`). For the CLI, the file must sit at
`supabase/functions/submit-run/index.ts`.

---

## Step 3 — Give the game your keys

Dashboard → **Project Settings** → **API**. You need two values:

| Dashboard label | Looks like |
|---|---|
| Project URL | `https://abcdefghijklm.supabase.co` |
| `anon` `public` key | `eyJhbGciOiJIUzI1NiIsInR5cCI6...` (very long) |

Open **`config.js`** in this folder and paste them in:

```js
window.PRISM_CONFIG = {
  url:     'https://abcdefghijklm.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6...'
};
```

Keep the quotes. No trailing slash on the URL (one is stripped automatically if
you leave it).

Copy the **anon public** key, not `service_role`. The anon key is designed to be
public and is safe in a public GitHub repo — the database rules are what protect
your data, and they give the browser no ability to write scores at all.

---

## Step 4 — Upload and test

Upload the contents of this folder to your repo, replacing what is there.
At minimum you must upload **`index.html`**, **`config.js`** and **`sw.js`**.

Wait a minute for GitHub Pages to rebuild, then open the site on your phone.

**Important:** the app caches itself for offline play, so your phone may serve
the old version once. To force the new one: delete the home-screen icon, close
the tab, and reopen the URL.

### What success looks like

1. Play a game through to the end.
2. The result screen appears immediately with your score.
3. Where the rank goes it says **"Checking rank…"** for a moment.
4. It becomes a real position — **#1** if you are the only player.
5. Tap **Leaderboard**. You should see yourself, and nobody else.

Then check the dashboard: **Table Editor → runs** should have one row, and
**profiles** should show your name.

---

## If something goes wrong

Open the site on a **desktop** browser, press F12 for the console, and play a
game. The errors name the failing step directly.

| What you see | What it means |
|---|---|
| "Leaderboard not set up" | `config.js` is still empty, or the old cached version is being served |
| "Anonymous sign-ins are disabled" | Step 0 is not actually on |
| Stuck on "Checking rank…", console shows 404 | The function name is not exactly `submit-run` |
| Console shows 401 | The anon key is wrong or truncated |
| Console mentions `relation ... does not exist` | Step 1 did not run |
| Rank says "Rank syncs when you are back online" | No connection. The run is saved and sends itself later |

Nothing is ever lost: a run that cannot be submitted is queued on the device and
retried automatically on the next launch, when the connection returns, and after
any later successful submission.
