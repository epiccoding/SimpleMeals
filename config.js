// SimpleMeals — connection settings.
//
// Both values below are safe to publish. The publishable key is designed to
// ship in client-side code; Row Level Security in the database is what
// actually protects the data.
//
// Never put a key labelled "secret" or "service_role" in this file — those
// bypass RLS entirely.

export const SUPABASE_URL = "https://jfjmzdipzscbdqsvlldz.supabase.co";
export const SUPABASE_KEY = "sb_publishable_74PGRBx5Kesf5tLcEKdQ_w_zwQ9MTkY";

// Google Analytics 4. Not loaded until the person accepts the cookie
// notice — see the consent banner in app.js. Safe to publish; it's a
// public identifier, not a secret.
export const GA_MEASUREMENT_ID = "G-2TL4YDBZ3D";