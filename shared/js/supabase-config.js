const SUPABASE_URL = "https://fpympioazglsrsshiqij.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_fR04JKkJwDx8WFZ0eQo6SQ_rbOzi9mt";

if (!window.supabase?.createClient) {
  throw new Error("Supabase JS chưa được tải.");
}

window.jewelsSupabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    persistSession: true
  }
});
