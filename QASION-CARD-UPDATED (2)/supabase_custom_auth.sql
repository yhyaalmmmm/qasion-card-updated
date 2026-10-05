create extension if not exists pgcrypto;

create table if not exists public.qc_email_otps (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null check (purpose in ('signup','login','recovery','email_change','sensitive')),
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists qc_email_otps_lookup_idx
  on public.qc_email_otps(email, purpose, expires_at desc);

alter table public.qc_email_otps enable row level security;
revoke all on public.qc_email_otps from anon, authenticated;

create table if not exists public.qc_recovery_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists qc_recovery_tokens_lookup_idx
  on public.qc_recovery_tokens(token_hash, expires_at);

alter table public.qc_recovery_tokens enable row level security;
revoke all on public.qc_recovery_tokens from anon, authenticated;

-- ============================================================
-- دالة بحث سريعة عن المستخدم بالبريد (للخادم فقط، service_role)
-- بدونها يضطر الخادم لمسح قائمة المستخدمين صفحة صفحة (بطيء ويتوقف عند 1000 مستخدم)
-- ============================================================
create or replace function public.qc_get_user_by_email(p_email text)
returns table(id uuid, email text, email_confirmed_at timestamptz)
language sql
security definer
set search_path = auth, public
as $$
  select u.id, u.email::text, u.email_confirmed_at
  from auth.users u
  where lower(u.email) = lower(p_email)
  limit 1;
$$;
revoke all on function public.qc_get_user_by_email(text) from public, anon, authenticated;
grant execute on function public.qc_get_user_by_email(text) to service_role;

-- تنظيف الرموز القديمة (اختياري: شغّله دورياً أو من pg_cron)
-- delete from public.qc_email_otps where created_at < now() - interval '1 day';
-- delete from public.qc_recovery_tokens where created_at < now() - interval '1 day';
