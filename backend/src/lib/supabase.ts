import { createClient } from '@supabase/supabase-js';
import { env, flags } from '../config/env.js';

export const supabaseAdmin = flags.supabaseConfigured
  ? createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

export const supabaseAuthClient = flags.supabaseAuthConfigured
  ? createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    })
  : null;
