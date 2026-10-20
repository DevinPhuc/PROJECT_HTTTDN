(function () {
  const SUPABASE_URL = "https://fpympioazglsrsshiqij.supabase.co";
  const SUPABASE_KEY = "sb_publishable_fR04JKkJwDx8WFZ0eQo6SQ_rbOzi9mt";
 
  if (window.sb) return;
 
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.error("supabase-js not loaded. Check script order.");
    return;
  }
 
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  // A reset/closed connection never reaches the function, so retrying is safe:
  // only FunctionsFetchError (no HTTP response) is retried, never a real HTTP error.
  // Network failures are returned as { error } (never thrown) for the callers.
  window.sbInvoke = async function (name, options) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await window.sb.functions.invoke(name, options);
        if (result?.error?.name !== "FunctionsFetchError") return result;
        lastError = result.error;
      } catch (err) {
        if (err?.name !== "FunctionsFetchError") throw err;
        lastError = err;
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
    return { data: null, error: lastError };
  };
})();