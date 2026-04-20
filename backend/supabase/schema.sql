create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'inactive',
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tone_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  sentence_length_tendency text not null,
  formality text not null,
  structure_preference text not null,
  citation_tendency text not null,
  composition_preference text not null,
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists assignment_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  canvas_course_id text,
  canvas_assignment_id text,
  page_kind text not null,
  source_url text not null,
  context_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists scan_page_inputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  title text not null,
  source_url text not null,
  readable_text text not null,
  headings jsonb not null default '[]'::jsonb,
  source_type text not null,
  scanned_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists generated_outputs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references assignment_sessions(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  task_type text not null,
  summary text not null,
  checklist jsonb not null default '[]'::jsonb,
  proposed_structure jsonb not null default '[]'::jsonb,
  draft text not null,
  explanation text not null,
  review_areas jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  task_type text not null,
  status text not null,
  path text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists rate_limit_counters (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  task_type text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_subscriptions_user_id on subscriptions(user_id);
create index if not exists idx_tone_profiles_user_id on tone_profiles(user_id);
create index if not exists idx_assignment_sessions_user_id on assignment_sessions(user_id);
create index if not exists idx_generated_outputs_session_id on generated_outputs(session_id);
create index if not exists idx_usage_events_user_id on usage_events(user_id);
create index if not exists idx_rate_limit_user_window on rate_limit_counters(user_id, task_type, window_started_at);
