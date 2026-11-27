-- Big Bar e Prosa: QR Code da mesa (2026-11-27)
-- O cliente lê o QR Code da mesa, vê a comanda e chama o garçom (ou pede a conta).
-- O painel aberto no celular da equipe recebe o chamado na hora (vibra e toca um som).
-- Rodar uma vez no SQL Editor do Supabase, depois do schema.sql e do permissoes.sql. Pode rodar de novo.
--
-- Segurança: o cliente NÃO entra no banco. Ele só usa duas funções (comanda_mesa e chamar_garcom),
-- e cada uma confere o código secreto que vai impresso no QR Code daquela mesa (tabela mesa_qr).
-- Sem o código certo não dá para ver a comanda nem chamar o garçom de outra mesa.
-- Os códigos de cada mesa NÃO ficam neste arquivo público: vão no arquivo do dono junto com os QR Codes.

-- ---------- códigos dos QR Codes ----------
create table if not exists public.mesa_qr (
  mesa text primary key,
  token text not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
alter table public.mesa_qr enable row level security;
revoke all on public.mesa_qr from anon, authenticated;
grant select on public.mesa_qr to authenticated;
drop policy if exists mesaqr_dono on public.mesa_qr;
create policy mesaqr_dono on public.mesa_qr for select to authenticated using (public.meu_papel() = 'dono');

-- ---------- chamados ----------
create table if not exists public.chamados (
  id bigint generated always as identity primary key,
  mesa text not null,
  tipo text not null check (tipo in ('garcom','conta')),
  em timestamptz not null default now(),
  atendido_em timestamptz,
  atendido_por text
);
create index if not exists chamados_abertos on public.chamados (em) where atendido_em is null;
alter table public.chamados enable row level security;
revoke all on public.chamados from anon, authenticated;
grant select on public.chamados to authenticated;
drop policy if exists chamados_ler on public.chamados;
create policy chamados_ler on public.chamados for select to authenticated
  using (public.nivel('mesas') >= 1 or public.nivel('caixa') >= 1);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chamados') then
    alter publication supabase_realtime add table public.chamados;
  end if;
end $$;

create or replace function public.mesa_ok(m text, t text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.mesa_qr where mesa = m and token = t and ativo)
$$;
revoke all on function public.mesa_ok(text, text) from public, anon, authenticated;

-- ---------- o que o cliente vê: só os itens já lançados, sem pagamentos nem nada da equipe ----------
create or replace function public.comanda_mesa(m text, t text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d jsonb;
begin
  if not public.mesa_ok(m, t) then return jsonb_build_object('erro', 'qr'); end if;
  select dados into d from public.pdv_mesas where id = m;
  if d is null then return jsonb_build_object('mesa', m, 'livre', true, 'itens', '[]'::jsonb); end if;
  return jsonb_build_object(
    'mesa', m,
    'livre', false,
    'aberta', d->>'abertaEm',
    'garcom', d->>'garcom',
    'conta', coalesce((d->>'conta')::boolean, false),
    'servico', coalesce((d->>'servico')::boolean, false),
    'desc', coalesce(d->'desc', '{}'::jsonb),
    'pessoas', coalesce(d->'pessoas', '1'::jsonb),
    'itens', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nome', i->>'nome', 'qtd', i->'qtd', 'preco', i->'preco',
        'adic', coalesce((select jsonb_agg(jsonb_build_object('nome', a->>'nome', 'preco', a->'preco'))
                          from jsonb_array_elements(case when jsonb_typeof(i->'adic') = 'array' then i->'adic' else '[]'::jsonb end) a), '[]'::jsonb),
        'hora', i->>'hora'))
      from jsonb_array_elements(case when jsonb_typeof(d->'itens') = 'array' then d->'itens' else '[]'::jsonb end) i
      where i->>'env' = 'true'), '[]'::jsonb),
    'chamado', (select jsonb_agg(jsonb_build_object('tipo', c.tipo, 'em', c.em))
                from public.chamados c where c.mesa = m and c.atendido_em is null and c.em > now() - interval '30 minutes'));
end $$;
revoke all on function public.comanda_mesa(text, text) from public;
grant execute on function public.comanda_mesa(text, text) to anon, authenticated;

-- ---------- o cliente chama: com trava contra apertar mil vezes ----------
create or replace function public.chamar_garcom(m text, t text, tipo text default 'garcom') returns text
language plpgsql volatile security definer set search_path = public as $$
begin
  if tipo not in ('garcom','conta') then return 'tipo'; end if;
  if not public.mesa_ok(m, t) then return 'qr'; end if;
  -- já tem um chamado igual esperando há menos de 2 minutos: não repete
  if exists (select 1 from public.chamados c where c.mesa = m and c.tipo = chamar_garcom.tipo
             and c.atendido_em is null and c.em > now() - interval '2 minutes') then return 'ja'; end if;
  -- no máximo 6 chamados por mesa em 10 minutos, e 80 no bar todo
  if (select count(*) from public.chamados c where c.mesa = m and c.em > now() - interval '10 minutes') >= 6 then return 'espera'; end if;
  if (select count(*) from public.chamados c where c.em > now() - interval '10 minutes') >= 80 then return 'espera'; end if;
  -- chamado antigo do mesmo tipo que ninguém marcou: dá baixa e abre um novo (toca de novo)
  update public.chamados c set atendido_em = now(), atendido_por = '(chamou de novo)'
   where c.mesa = m and c.tipo = chamar_garcom.tipo and c.atendido_em is null;
  insert into public.chamados (mesa, tipo) values (m, tipo);
  return 'ok';
end $$;
revoke all on function public.chamar_garcom(text, text, text) from public;
grant execute on function public.chamar_garcom(text, text, text) to anon, authenticated;

-- ---------- a equipe: lista do que está esperando e "já vou" ----------
create or replace function public.chamados_pendentes() returns setof public.chamados
language sql stable security definer set search_path = public as $$
  select * from public.chamados
   where atendido_em is null and em > now() - interval '3 hours'
     and (public.nivel('mesas') >= 1 or public.nivel('caixa') >= 1)
   order by em
$$;
revoke all on function public.chamados_pendentes() from public;
grant execute on function public.chamados_pendentes() to authenticated;

create or replace function public.atender_chamado(cid bigint) returns text
language plpgsql volatile security definer set search_path = public as $$
declare quem text;
begin
  if not (public.nivel('mesas') >= 1 or public.nivel('caixa') >= 1) then return 'negado'; end if;
  select nome into quem from public.equipe_acesso where user_id = auth.uid();
  update public.chamados set atendido_em = now(), atendido_por = coalesce(quem, '')
   where id = cid and atendido_em is null;
  return 'ok';
end $$;
revoke all on function public.atender_chamado(bigint) from public;
grant execute on function public.atender_chamado(bigint) to authenticated;

-- limpeza: chamados com mais de 30 dias saem (roda junto quando alguém chama)
create or replace function public.chamados_limpa() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.chamados where em < now() - interval '30 days';
  return null;
end $$;
drop trigger if exists limpa on public.chamados;
create trigger limpa after insert on public.chamados for each statement execute function public.chamados_limpa();

-- ---------- dono: ver, criar e trocar os códigos pelo painel (QR Codes das mesas) ----------
create or replace function public.qr_lista() returns table (mesa text, token text, ativo boolean)
language sql stable security definer set search_path = public as $$
  select q.mesa, q.token, q.ativo from public.mesa_qr q
   where public.meu_papel() = 'dono'
   order by (case when q.mesa ~ '^\d+$' then q.mesa::int else 9999 end), q.mesa
$$;
revoke all on function public.qr_lista() from public;
grant execute on function public.qr_lista() to authenticated;

-- deixa as mesas 1..n com código (cria o que falta) e desliga as acima de n
create or replace function public.qr_garantir(n int) returns text
language plpgsql volatile security definer set search_path = public as $$
begin
  if public.meu_papel() is distinct from 'dono' then return 'negado'; end if;
  if n < 1 or n > 99 then return 'n'; end if;
  insert into public.mesa_qr (mesa, token)
    select g::text, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) from generate_series(1, n) g
  on conflict (mesa) do update set ativo = true;
  update public.mesa_qr set ativo = false where mesa ~ '^\d+$' and mesa::int > n;
  return 'ok';
end $$;
revoke all on function public.qr_garantir(int) from public;
grant execute on function public.qr_garantir(int) to authenticated;

-- código novo para uma mesa (o QR antigo dela para de funcionar)
create or replace function public.qr_trocar(m text) returns text
language plpgsql volatile security definer set search_path = public as $$
begin
  if public.meu_papel() is distinct from 'dono' then return 'negado'; end if;
  if m !~ '^[\w-]{1,20}$' then return 'mesa'; end if;
  insert into public.mesa_qr (mesa, token) values (m, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  on conflict (mesa) do update set token = excluded.token, ativo = true, criado_em = now();
  return 'ok';
end $$;
revoke all on function public.qr_trocar(text) from public;
grant execute on function public.qr_trocar(text) to authenticated;

select 'ok' as pronto;
