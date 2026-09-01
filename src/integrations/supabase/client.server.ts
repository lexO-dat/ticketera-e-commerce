import '@tanstack/react-start/server-only'

import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

const supabaseUrl = process.env['SUPABASE_URL']
const supabaseKey = process.env['SUPABASE_PUBLISHABLE_KEY']

if (!supabaseUrl) {
  throw new Error('Missing SUPABASE_URL')
}

if (!supabaseKey) {
  throw new Error('Missing SUPABASE_PUBLISHABLE_KEY')
}

export const supabaseServer = createClient<Database>(
  supabaseUrl,
  supabaseKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
)