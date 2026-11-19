-- Big Bar e Prosa: banco do painel (Supabase / Postgres)
-- Papéis: dono (tudo), caixa (caixa + mesas + fecha o dia), garcom (só mesas)

create table if not exists public.equipe_acesso (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nome text not null,
  papel text not null check (papel in ('dono','caixa','garcom')),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create or replace function public.meu_papel() returns text
language sql stable security definer set search_path = public as $$
  select papel from public.equipe_acesso where user_id = auth.uid() and ativo
$$;
revoke all on function public.meu_papel() from public;
grant execute on function public.meu_papel() to anon, authenticated;

-- um registro por "documento"; dados = o JSON que o painel usa
create table if not exists public.site      (id int primary key default 1 check (id = 1), dados jsonb not null, em timestamptz not null default now(), por text);
create table if not exists public.fin       (id int primary key default 1 check (id = 1), dados jsonb not null, em timestamptz not null default now(), por text);
create table if not exists public.pdv_geral (id int primary key default 1 check (id = 1), dados jsonb not null, em timestamptz not null default now(), por text);
create table if not exists public.pdv_caixa (id int primary key default 1 check (id = 1), dados jsonb not null, em timestamptz not null default now(), por text);
create table if not exists public.pdv_mesas (id text primary key, dados jsonb not null, em timestamptz not null default now(), por text);
create table if not exists public.dias_fechados (id text primary key, data date not null, dados jsonb not null, fechado_por text, em timestamptz not null default now());

-- hora e autor sempre do servidor
create or replace function public.carimbo() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.em := now();
  new.por := coalesce((select nome from public.equipe_acesso where user_id = auth.uid()), '');
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['site','fin','pdv_geral','pdv_caixa','pdv_mesas'] loop
    execute format('drop trigger if exists carimbo on public.%I', t);
    execute format('create trigger carimbo before insert or update on public.%I for each row execute function public.carimbo()', t);
  end loop;
end $$;

alter table public.equipe_acesso enable row level security;
alter table public.site enable row level security;
alter table public.fin enable row level security;
alter table public.pdv_geral enable row level security;
alter table public.pdv_caixa enable row level security;
alter table public.pdv_mesas enable row level security;
alter table public.dias_fechados enable row level security;

-- acesso da API (o RLS abaixo decide linha a linha)
grant usage on schema public to anon, authenticated;
grant select on public.site to anon;
grant select, insert, update, delete on public.site, public.fin, public.pdv_geral, public.pdv_caixa, public.pdv_mesas to authenticated;
grant select, insert on public.dias_fechados to authenticated;
grant select on public.equipe_acesso to authenticated;

-- equipe: cada um vê o próprio acesso; o dono vê todos. Mudanças só pelo painel do Supabase.
drop policy if exists eq_ler on public.equipe_acesso;
create policy eq_ler on public.equipe_acesso for select to authenticated using (user_id = auth.uid() or public.meu_papel() = 'dono');

-- site: qualquer um lê (é o site público); só o dono muda
drop policy if exists site_ler on public.site;
create policy site_ler on public.site for select to anon, authenticated using (true);
drop policy if exists site_dono on public.site;
create policy site_dono on public.site for all to authenticated using (public.meu_papel() = 'dono') with check (public.meu_papel() = 'dono');

-- financeiro: dono; o caixa também grava porque fechar o dia lança no financeiro
drop policy if exists fin_eq on public.fin;
create policy fin_eq on public.fin for all to authenticated using (public.meu_papel() in ('dono','caixa')) with check (public.meu_papel() in ('dono','caixa'));

-- mesas e dados gerais do PDV (equipe, cancelados): toda a equipe
drop policy if exists geral_eq on public.pdv_geral;
create policy geral_eq on public.pdv_geral for all to authenticated using (public.meu_papel() is not null) with check (public.meu_papel() is not null);
drop policy if exists mesas_eq on public.pdv_mesas;
create policy mesas_eq on public.pdv_mesas for all to authenticated using (public.meu_papel() is not null) with check (public.meu_papel() is not null);

-- caixa: todos leem (o garçom vê se o caixa está aberto); só dono e caixa mudam
drop policy if exists caixa_ler on public.pdv_caixa;
create policy caixa_ler on public.pdv_caixa for select to authenticated using (public.meu_papel() is not null);
drop policy if exists caixa_mudar on public.pdv_caixa;
create policy caixa_mudar on public.pdv_caixa for all to authenticated using (public.meu_papel() in ('dono','caixa')) with check (public.meu_papel() in ('dono','caixa'));

-- dias fechados: dono e caixa guardam; só o dono consulta. Ninguém apaga nem altera.
drop policy if exists dias_gravar on public.dias_fechados;
create policy dias_gravar on public.dias_fechados for insert to authenticated with check (public.meu_papel() in ('dono','caixa'));
drop policy if exists dias_ler on public.dias_fechados;
create policy dias_ler on public.dias_fechados for select to authenticated using (public.meu_papel() = 'dono');

-- tempo real
do $$ declare t text; begin
  foreach t in array array['site','fin','pdv_geral','pdv_caixa','pdv_mesas'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
alter table public.pdv_mesas replica identity full;

-- relatórios prontos para o dono (Table Editor / SQL)
create or replace view public.relatorio_dias with (security_invoker = true) as
select data, fechado_por, em,
  (select coalesce(sum((v->>'total')::numeric),0)/100 from jsonb_array_elements(dados->'caixa'->'vendas') v) as vendido_reais,
  jsonb_array_length(coalesce(dados->'caixa'->'vendas','[]')) as vendas,
  jsonb_array_length(coalesce(dados->'cancelados','[]')) as itens_cancelados
from public.dias_fechados order by em desc;
grant select on public.relatorio_dias to authenticated;

-- cardápio completo do painel (com custo dos itens): só o dono. O público lê a tabela "site", sem custo.
create table if not exists public.site_painel (id int primary key default 1 check (id = 1), dados jsonb not null, em timestamptz not null default now(), por text);
drop trigger if exists carimbo on public.site_painel;
create trigger carimbo before insert or update on public.site_painel for each row execute function public.carimbo();
alter table public.site_painel enable row level security;
grant select, insert, update, delete on public.site_painel to authenticated;
drop policy if exists sitep_dono on public.site_painel;
create policy sitep_dono on public.site_painel for all to authenticated using (public.meu_papel() = 'dono') with check (public.meu_papel() = 'dono');
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='site_painel') then
    alter publication supabase_realtime add table public.site_painel;
  end if;
end $$;
-- itens cancelados: registro que só cresce (ninguém altera nem apaga); autor e hora gravados pelo servidor
create table if not exists public.cancelamentos (id text primary key, data date not null, dados jsonb not null, por text, user_id uuid default auth.uid(), em timestamptz not null default now());
create or replace function public.carimbo_registro() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.em := now();
  if tg_table_name = 'dias_fechados' then
    new.fechado_por := coalesce((select nome from public.equipe_acesso where user_id = auth.uid()), '');
  else
    new.por := coalesce((select nome from public.equipe_acesso where user_id = auth.uid()), '');
    new.user_id := auth.uid();
  end if;
  return new;
end $$;
drop trigger if exists carimbo on public.cancelamentos;
create trigger carimbo before insert on public.cancelamentos for each row execute function public.carimbo_registro();
drop trigger if exists carimbo on public.dias_fechados;
create trigger carimbo before insert on public.dias_fechados for each row execute function public.carimbo_registro();
alter table public.cancelamentos enable row level security;
grant select, insert on public.cancelamentos to authenticated;
drop policy if exists canc_gravar on public.cancelamentos;
create policy canc_gravar on public.cancelamentos for insert to authenticated with check (public.meu_papel() is not null);
drop policy if exists canc_ler on public.cancelamentos;
create policy canc_ler on public.cancelamentos for select to authenticated using (public.meu_papel() = 'dono');
select 'ok' as pronto;

-- geral (equipe, histórico, cancelados do painel): todos leem, só dono e caixa gravam
drop policy if exists geral_eq on public.pdv_geral;
drop policy if exists geral_ler on public.pdv_geral;
create policy geral_ler on public.pdv_geral for select to authenticated using (public.meu_papel() is not null);
drop policy if exists geral_mudar on public.pdv_geral;
create policy geral_mudar on public.pdv_geral for all to authenticated using (public.meu_papel() in ('dono','caixa')) with check (public.meu_papel() in ('dono','caixa'));
