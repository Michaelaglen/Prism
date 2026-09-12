/* ============================================================
   Prism — Supabase connection

   Paste your two values between the quotes, save, done.
   Find them in the Supabase dashboard:
     Project Settings -> API
       url     = "Project URL"        (https://xxxxxxxx.supabase.co)
       anonKey = "anon" "public" key  (a long string starting with eyJ)

   The anon key is meant to be public — it is safe in a public repo.
   NEVER put the "service_role" key here.

   Leave both empty to run the game with no leaderboard.
   ============================================================ */
window.PRISM_CONFIG = {
  url:     '',
  anonKey: ''
};
