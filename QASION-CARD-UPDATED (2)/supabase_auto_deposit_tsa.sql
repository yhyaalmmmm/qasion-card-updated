-- QASION CARD / TSA automatic deposit ledger
-- Run once in Supabase SQL Editor.
-- This migration keeps idempotency outside the browser and lets the server credit wallets only after TSA verifies an incoming transaction.

create table if not exists public.qc_auto_deposit_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('shamcash','syriatel')),
  transaction_ref text not null,
  amount numeric(24,8) not null check (amount > 0),
  currency text not null,
  created_at timestamptz not null default now(),
  unique(provider, transaction_ref)
);

alter table public.qc_auto_deposit_claims enable row level security;

drop policy if exists "qc_auto_deposit_claims_admin" on public.qc_auto_deposit_claims;
create policy "qc_auto_deposit_claims_admin"
on public.qc_auto_deposit_claims for all
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "qc_auto_deposit_claims_own_select" on public.qc_auto_deposit_claims;
create policy "qc_auto_deposit_claims_own_select"
on public.qc_auto_deposit_claims for select
using (auth.uid() = user_id);

create table if not exists public.qc_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid,
  direction text not null check (direction in ('credit','debit')),
  amount numeric(24,8) not null,
  currency text not null,
  reference text not null,
  provider text not null,
  balance_after numeric(24,8),
  created_at timestamptz not null default now()
);

alter table public.qc_wallet_ledger enable row level security;
drop policy if exists "qc_wallet_ledger_admin" on public.qc_wallet_ledger;
create policy "qc_wallet_ledger_admin" on public.qc_wallet_ledger for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "qc_wallet_ledger_own_select" on public.qc_wallet_ledger;
create policy "qc_wallet_ledger_own_select" on public.qc_wallet_ledger for select using (auth.uid() = user_id);

create or replace function public.qc_credit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_currency text,
  p_reference text,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_id uuid;
  wallet_id uuid;
  new_balance numeric;
  cur text := upper(trim(p_currency));
  balance_col text;
  user_col text;
  currency_col text;
  id_col text;
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 or cur = '' then
    raise exception 'invalid wallet credit';
  end if;

  insert into public.qc_auto_deposit_claims(user_id,provider,transaction_ref,amount,currency)
  values(p_user_id,lower(trim(p_provider)),trim(p_reference),p_amount,cur)
  on conflict(provider,transaction_ref) do nothing
  returning id into claim_id;

  if claim_id is null then
    return jsonb_build_object('ok',true,'duplicate',true,'message','هذه الحوالة سبق اعتمادها');
  end if;

  select column_name into id_col from information_schema.columns
    where table_schema='public' and table_name='wallets' and column_name='id' limit 1;
  select column_name into user_col from information_schema.columns
    where table_schema='public' and table_name='wallets' and column_name in ('user_id','owner_id')
    order by case column_name when 'user_id' then 1 else 2 end limit 1;
  select column_name into currency_col from information_schema.columns
    where table_schema='public' and table_name='wallets' and column_name in ('currency','asset','wallet_currency')
    order by case column_name when 'currency' then 1 else 2 end limit 1;
  select column_name into balance_col from information_schema.columns
    where table_schema='public' and table_name='wallets' and column_name in ('balance','amount','available_balance')
    order by case column_name when 'balance' then 1 else 2 end limit 1;

  if id_col is null or user_col is null or currency_col is null or balance_col is null then
    raise exception 'wallets schema not supported by qc_credit_wallet';
  end if;

  execute format('select %I from public.wallets where %I=$1 and upper(%I)=$2 limit 1', id_col,user_col,currency_col)
    into wallet_id using p_user_id,cur;

  if wallet_id is null then
    execute format('insert into public.wallets(%I,%I,%I) values($1,$2,$3) returning %I', user_col,currency_col,balance_col,id_col)
      into wallet_id using p_user_id,cur,p_amount;
    new_balance := p_amount;
  else
    execute format('update public.wallets set %I=coalesce(%I,0)+$1 where %I=$2 returning %I', balance_col,balance_col,id_col,id_col)
      using p_amount,wallet_id;
    execute format('select %I from public.wallets where %I=$1', balance_col,id_col)
      into new_balance using wallet_id;
  end if;

  insert into public.qc_wallet_ledger(user_id,wallet_id,direction,amount,currency,reference,provider,balance_after)
  values(p_user_id,wallet_id,'credit',p_amount,cur,p_reference,lower(trim(p_provider)),new_balance);

  return jsonb_build_object('ok',true,'duplicate',false,'claim_id',claim_id,'wallet_id',wallet_id,'amount',p_amount,'currency',cur,'balance',new_balance);
end;
$$;

revoke all on function public.qc_credit_wallet(uuid,numeric,text,text,text) from public, anon, authenticated;
grant execute on function public.qc_credit_wallet(uuid,numeric,text,text,text) to service_role;
