-- Big Bar e Prosa: cadastro completo e permissões por módulo (2026-11-26)
-- Rodar uma vez no SQL Editor do Supabase, depois do schema.sql. Pode rodar de novo sem estragar nada.
--
-- Módulos: mesas, caixa (inclui conta e fechamento do dia), cardapio, horarios, shows, infos (infos do site,
-- aviso e placa aberto/fechado), equipe, financeiro.
-- Nível por módulo: 0 = nenhum, 1 = só ver, 2 = ver e alterar.
-- papel = 'dono' continua valendo tudo (2 em todos) e é o único que mexe nos acessos.
-- Qualquer outro papel ('garcom', 'caixa') vale só pelo que estiver em perms.

-- ---------- dados do cadastro ----------
alter table public.equipe_acesso add column if not exists nascimento date;
alter table public.equipe_acesso add column if not exists celular text;
alter table public.equipe_acesso add column if not exists perms jsonb not null default '{}'::jsonb;
alter table public.equipe_acesso add column if not exists cadastro_ok boolean not null default false;

-- quem já existia: cadastro aceito e permissões iguais às do papel antigo
do $$ begin
  if not exists (select 1 from pg_catalog.pg_description d join pg_catalog.pg_class c on c.oid = d.objoid
                 where c.relname = 'equipe_acesso' and d.objsubid = 0 and d.description like '%perms-migrado%') then
    update public.equipe_acesso set cadastro_ok = true;
    update public.equipe_acesso set perms = '{"mesas":2,"cardapio":1}' where papel = 'garcom' and perms = '{}'::jsonb;
    update public.equipe_acesso set perms = '{"mesas":2,"caixa":2,"cardapio":1}' where papel = 'caixa' and perms = '{}'::jsonb;
    comment on table public.equipe_acesso is 'Acessos ao painel (perms-migrado 2026-11-26)';
  end if;
end $$;

-- ---------- nível de quem está logado ----------
create or replace function public.nivel(modulo text) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when papel = 'dono' then 2
                else least(greatest(coalesce((perms->>modulo)::int, 0), 0), 2) end
    from public.equipe_acesso where user_id = auth.uid() and ativo
  ), 0)
$$;
revoke all on function public.nivel(text) from public;
grant execute on function public.nivel(text) to authenticated;

-- ---------- políticas por módulo ----------
-- mesas: quem vê mesas ou caixa lê; quem altera mesas ou caixa grava (o caixa fecha a mesa ao receber)
drop policy if exists mesas_eq on public.pdv_mesas;
drop policy if exists mesas_ler on public.pdv_mesas;
drop policy if exists mesas_mudar on public.pdv_mesas;
create policy mesas_ler on public.pdv_mesas for select to authenticated using (public.nivel('mesas') >= 1 or public.nivel('caixa') >= 1);
create policy mesas_mudar on public.pdv_mesas for all to authenticated using (public.nivel('mesas') = 2 or public.nivel('caixa') = 2) with check (public.nivel('mesas') = 2 or public.nivel('caixa') = 2);

-- caixa: quem vê mesas ou caixa lê (o garçom vê se o caixa está aberto); só quem altera o caixa grava
drop policy if exists caixa_ler on public.pdv_caixa;
drop policy if exists caixa_mudar on public.pdv_caixa;
create policy caixa_ler on public.pdv_caixa for select to authenticated using (public.nivel('mesas') >= 1 or public.nivel('caixa') >= 1);
create policy caixa_mudar on public.pdv_caixa for all to authenticated using (public.nivel('caixa') = 2) with check (public.nivel('caixa') = 2);

-- geral do PDV (nomes da equipe, histórico, cancelados): quem vê mesas, caixa ou equipe lê; caixa ou equipe gravam
drop policy if exists geral_eq on public.pdv_geral;
drop policy if exists geral_ler on public.pdv_geral;
drop policy if exists geral_mudar on public.pdv_geral;
create policy geral_ler on public.pdv_geral for select to authenticated using (public.nivel('mesas') >= 1 or public.nivel('caixa') >= 1 or public.nivel('equipe') >= 1);
create policy geral_mudar on public.pdv_geral for all to authenticated using (public.nivel('caixa') = 2 or public.nivel('equipe') = 2) with check (public.nivel('caixa') = 2 or public.nivel('equipe') = 2);

-- financeiro
drop policy if exists fin_eq on public.fin;
drop policy if exists fin_dono on public.fin;
drop policy if exists fin_ler on public.fin;
drop policy if exists fin_mudar on public.fin;
create policy fin_ler on public.fin for select to authenticated using (public.nivel('financeiro') >= 1);
create policy fin_mudar on public.fin for all to authenticated using (public.nivel('financeiro') = 2) with check (public.nivel('financeiro') = 2);

-- dias fechados: quem altera o caixa guarda; quem vê o financeiro consulta
drop policy if exists dias_gravar on public.dias_fechados;
drop policy if exists dias_ler on public.dias_fechados;
create policy dias_gravar on public.dias_fechados for insert to authenticated with check (public.nivel('caixa') = 2);
create policy dias_ler on public.dias_fechados for select to authenticated using (public.nivel('financeiro') >= 1);

-- cancelamentos: quem altera mesas ou caixa registra; quem vê o financeiro consulta
drop policy if exists canc_gravar on public.cancelamentos;
drop policy if exists canc_ler on public.cancelamentos;
create policy canc_gravar on public.cancelamentos for insert to authenticated with check (public.nivel('mesas') = 2 or public.nivel('caixa') = 2);
create policy canc_ler on public.cancelamentos for select to authenticated using (public.nivel('financeiro') >= 1);

-- cardápio com custo: quem vê o financeiro lê; gravação direta só do dono (os outros gravam por salvar_site)
drop policy if exists sitep_dono on public.site_painel;
drop policy if exists sitep_ler on public.site_painel;
drop policy if exists sitep_mudar on public.site_painel;
create policy sitep_ler on public.site_painel for select to authenticated using (public.nivel('financeiro') >= 1);
create policy sitep_mudar on public.site_painel for all to authenticated using (public.meu_papel() = 'dono') with check (public.meu_papel() = 'dono');
-- site público: todos leem; gravação direta só do dono (já era assim, política site_dono)

-- ---------- gravar o site por módulo (quem não é dono) ----------
-- tira o custo dos itens do cardápio
create or replace function public.sem_custo(c jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(c) <> 'array' or c is null then c else (
    select coalesce(jsonb_agg(
      case when jsonb_typeof(k->'grupos') = 'array' then jsonb_set(k, '{grupos}', (
        select coalesce(jsonb_agg(
          case when jsonb_typeof(g->'itens') = 'array' then jsonb_set(g, '{itens}', (
            select coalesce(jsonb_agg(case when jsonb_typeof(i) = 'object' then i - 'custo' else i end order by o3), '[]'::jsonb)
            from jsonb_array_elements(g->'itens') with ordinality x3(i, o3))) else g end order by o2), '[]'::jsonb)
        from jsonb_array_elements(k->'grupos') with ordinality x2(g, o2))) else k end order by o1), '[]'::jsonb)
    from jsonb_array_elements(c) with ordinality x1(k, o1)) end
$$;
-- põe de volta o custo que já estava gravado (por id do item)
create or replace function public.com_custo(novo jsonb, velho jsonb) returns jsonb language sql immutable as $$
  with custos as (
    select coalesce(jsonb_object_agg(i->>'id', i->'custo'), '{}'::jsonb) as m
    from jsonb_array_elements(case when jsonb_typeof(velho) = 'array' then velho else '[]'::jsonb end) k,
         jsonb_array_elements(case when jsonb_typeof(k->'grupos') = 'array' then k->'grupos' else '[]'::jsonb end) g,
         jsonb_array_elements(case when jsonb_typeof(g->'itens') = 'array' then g->'itens' else '[]'::jsonb end) i
    where jsonb_typeof(i) = 'object' and i ? 'custo' and i ? 'id'
  )
  select case when jsonb_typeof(novo) <> 'array' or novo is null then novo else (
    select coalesce(jsonb_agg(
      case when jsonb_typeof(k->'grupos') = 'array' then jsonb_set(k, '{grupos}', (
        select coalesce(jsonb_agg(
          case when jsonb_typeof(g->'itens') = 'array' then jsonb_set(g, '{itens}', (
            select coalesce(jsonb_agg(
              case when jsonb_typeof(i) = 'object' and (select m from custos) ? (i->>'id')
                   then (i - 'custo') || jsonb_build_object('custo', (select m from custos)->(i->>'id'))
                   when jsonb_typeof(i) = 'object' then i - 'custo' else i end order by o3), '[]'::jsonb)
            from jsonb_array_elements(g->'itens') with ordinality x3(i, o3))) else g end order by o2), '[]'::jsonb)
        from jsonb_array_elements(k->'grupos') with ordinality x2(g, o2))) else k end order by o1), '[]'::jsonb)
    from jsonb_array_elements(novo) with ordinality x1(k, o1)) end
$$;

create or replace function public.salvar_site(dados jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  velho jsonb;
  novo jsonb := dados;
  k text;
  m text;
begin
  if jsonb_typeof(novo) <> 'object' then raise exception 'dados inválidos' using errcode = '22023'; end if;
  if public.meu_papel() is null then raise exception 'sem acesso ao painel' using errcode = '42501'; end if;
  select s.dados into velho from public.site_painel s where s.id = 1;
  velho := coalesce(velho, '{}'::jsonb);
  -- custo dos itens: só quem altera o financeiro muda
  if public.nivel('financeiro') < 2 and novo ? 'cardapio' then
    novo := jsonb_set(novo, '{cardapio}', public.com_custo(novo->'cardapio', velho->'cardapio'));
  end if;
  for k in select jsonb_object_keys(novo) union select jsonb_object_keys(velho) loop
    if (novo->k) is distinct from (velho->k) then
      m := case k when 'cardapio' then 'cardapio' when 'horarios' then 'horarios' when 'shows' then 'shows' else 'infos' end;
      if k = 'cardapio' and public.sem_custo(novo->k) is not distinct from public.sem_custo(velho->k) then m := 'financeiro'; end if;
      if public.nivel(m) < 2 then
        raise exception 'sem permissão para alterar: %', m using errcode = '42501';
      end if;
    end if;
  end loop;
  insert into public.site_painel (id, dados) values (1, novo) on conflict (id) do update set dados = excluded.dados;
  insert into public.site (id, dados) values (1, case when novo ? 'cardapio' then jsonb_set(novo, '{cardapio}', public.sem_custo(novo->'cardapio')) else novo end)
    on conflict (id) do update set dados = excluded.dados;
end $$;
revoke all on function public.salvar_site(jsonb) from public;
grant execute on function public.salvar_site(jsonb) to authenticated;

-- ---------- a própria pessoa completa o cadastro ----------
create or replace function public.completar_cadastro(nome text, nascimento date, celular text) returns void
language plpgsql security definer set search_path = public as $$
declare cel text := regexp_replace(coalesce(celular, ''), '\D', '', 'g');
begin
  nome := btrim(coalesce(nome, ''));
  if char_length(nome) < 2 or char_length(nome) > 60 then raise exception 'Nome precisa ter de 2 a 60 letras.' using errcode = '22023'; end if;
  if nascimento is null or nascimento > current_date - interval '14 years' or nascimento < date '1900-01-01' then
    raise exception 'Data de nascimento inválida.' using errcode = '22023'; end if;
  if char_length(cel) < 10 or char_length(cel) > 13 then raise exception 'Celular inválido. Use DDD + número.' using errcode = '22023'; end if;
  update public.equipe_acesso e set nome = completar_cadastro.nome, nascimento = completar_cadastro.nascimento, celular = cel, cadastro_ok = true
   where e.user_id = auth.uid();
  if not found then raise exception 'Este e-mail não foi convidado para o painel.' using errcode = '42501'; end if;
end $$;
revoke all on function public.completar_cadastro(text, date, text) from public;
grant execute on function public.completar_cadastro(text, date, text) to authenticated;

-- ---------- o dono não tira o próprio acesso de dono ----------
create or replace function public.protege_dono() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.user_id = auth.uid() and old.papel = 'dono' and (new.papel <> 'dono' or not new.ativo) then
    raise exception 'Você não pode tirar o seu próprio acesso de dono.' using errcode = '42501';
  end if;
  if jsonb_typeof(new.perms) <> 'object' then new.perms := '{}'::jsonb; end if;
  return new;
end $$;
drop trigger if exists protege_dono on public.equipe_acesso;
create trigger protege_dono before update on public.equipe_acesso for each row execute function public.protege_dono();

select 'permissões por módulo prontas' as pronto;
