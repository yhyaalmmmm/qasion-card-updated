-- QASION CARD admin/support security tables
create extension if not exists pgcrypto;

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  role text not null check (role in ('main','support')),
  device_id text not null,
  jti text not null unique,
  user_agent_hash text,
  ip_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked boolean not null default false
);
create index if not exists admin_sessions_active_idx on public.admin_sessions(username, revoked, expires_at);

create table if not exists public.admin_allowed_devices (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  device_id text not null,
  label text,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique(username, device_id)
);

create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.admin_sessions enable row level security;
alter table public.admin_allowed_devices enable row level security;
alter table public.site_settings enable row level security;

-- No browser user can directly read/write these tables. Server functions use service_role.
drop policy if exists admin_sessions_no_client on public.admin_sessions;
drop policy if exists admin_devices_no_client on public.admin_allowed_devices;
drop policy if exists site_settings_no_client on public.site_settings;
create policy admin_sessions_no_client on public.admin_sessions for all to anon, authenticated using (false) with check (false);
create policy admin_devices_no_client on public.admin_allowed_devices for all to anon, authenticated using (false) with check (false);
create policy site_settings_no_client on public.site_settings for all to anon, authenticated using (false) with check (false);
