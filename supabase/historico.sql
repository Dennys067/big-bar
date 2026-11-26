-- Big Bar e Prosa: histórico de quem fez o quê (2026-11-26)
-- Rodar uma vez no SQL Editor do Supabase, depois do permissoes.sql. Pode rodar de novo sem estragar nada.
-- O próprio banco escreve o histórico (gatilhos): ninguém grava, muda ou apaga linha por fora. Só o dono lê.
-- Guarda 90 dias.

create table if not exists public.historico (
  id bigserial primary key,
  em timestamptz not null default now(),
  user_id uuid,
  quem text not null default '',
  modulo text not null,
  acao text not null,
  resumo text not null default ''
);
create index if not exists historico_em on public.historico (em desc);
alter table public.historico enable row level security;
revoke all on public.historico from anon, authenticated;
grant select on public.historico to authenticated;
drop policy if exists hist_dono on public.historico;
create policy hist_dono on public.historico for select to authenticated using (public.meu_papel() = 'dono');

-- ---------- ajudantes ----------
create or replace function public.h_brl(c numeric) returns text language sql immutable as $$
  select case when c is null then '' else
    (case when c < 0 then '-' else '' end) || 'R$ ' || floor(trunc(abs(c)) / 100)::bigint::text || ',' || lpad((trunc(abs(c))::bigint % 100)::text, 2, '0') end
$$;
create or replace function public.h_num(j jsonb) returns numeric language sql immutable as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric
              when jsonb_typeof(j) = 'string' and (j #>> '{}') ~ '^-?\d+(\.\d+)?$' then (j #>> '{}')::numeric else null end
$$;
create or replace function public.h_txt(j jsonb) returns text language sql immutable as $$
  select left(coalesce(j #>> '{}', ''), 80)
$$;
create or replace function public.h_mesa(id text, d jsonb) returns text language sql immutable as $$
  select case when id = 'balcao' then 'Balcão'
              when id like 'a-%' then coalesce(nullif(public.h_txt(d->'nome'), ''), 'Comanda avulsa')
              else 'Mesa ' || id end
$$;
create or replace function public.h_forma(f text) returns text language sql immutable as $$
  select case f when 'pix' then 'Pix' when 'dinheiro' then 'Dinheiro' when 'debito' then 'Débito' when 'credito' then 'Crédito' else coalesce(f, '?') end
$$;
create or replace function public.h_arr(j jsonb) returns jsonb language sql immutable as $$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end
$$;
create or replace function public.h_log(modulo text, acao text, resumo text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.historico (user_id, quem, modulo, acao, resumo)
  values (auth.uid(), coalesce((select nome from public.equipe_acesso where user_id = auth.uid()), 'Sistema'), modulo, acao, left(coalesce(resumo, ''), 500));
end $$;
revoke all on function public.h_log(text, text, text) from public;

-- ---------- mesas: itens enviados, pediu a conta, pagamentos, mesa liberada ----------
create or replace function public.h_mesas() returns trigger language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; nm text; partes text[] := '{}'; r record; p jsonb; i int;
begin
  begin
    o := case when tg_op <> 'INSERT' then old.dados else '{}'::jsonb end;
    n := case when tg_op <> 'DELETE' then new.dados else '{}'::jsonb end;
    nm := public.h_mesa(case when tg_op = 'DELETE' then old.id else new.id end, case when tg_op = 'DELETE' then o else n end);
    if tg_op = 'DELETE' then
      if jsonb_array_length(public.h_arr(o->'itens')) > 0 then perform public.h_log('mesas', 'Mesa liberada', nm); end if;
      return null;
    end if;
    for r in
      with a as (select x->>'id' id, max(x->>'nome') nome, sum(coalesce(public.h_num(x->'qtd'), 0)) q from jsonb_array_elements(public.h_arr(o->'itens')) x where (x->>'env')::boolean group by 1),
           b as (select x->>'id' id, max(x->>'nome') nome, sum(coalesce(public.h_num(x->'qtd'), 0)) q from jsonb_array_elements(public.h_arr(n->'itens')) x where (x->>'env')::boolean group by 1)
      select coalesce(b.nome, a.nome) nome, coalesce(b.q, 0) - coalesce(a.q, 0) d
      from a full join b on a.id = b.id where coalesce(b.q, 0) <> coalesce(a.q, 0)
    loop
      partes := partes || ((case when r.d > 0 then '+' else '−' end) || abs(r.d)::text || ' ' || left(coalesce(r.nome, '?'), 50));
    end loop;
    if array_length(partes, 1) > 0 then perform public.h_log('mesas', 'Pedido', nm || ': ' || array_to_string(partes, ', ')); end if;
    if coalesce((n->>'conta')::boolean, false) and not coalesce((o->>'conta')::boolean, false) then perform public.h_log('mesas', 'Pediu a conta', nm); end if;
    i := jsonb_array_length(public.h_arr(o->'pags'));
    for p in select x from jsonb_array_elements(public.h_arr(n->'pags')) with ordinality t(x, k) where k > i loop
      perform public.h_log('caixa', 'Pagamento', nm || ': ' || public.h_brl(public.h_num(p->'valor')) || ' no ' || public.h_forma(p->>'f'));
    end loop;
  exception when others then null; -- o histórico nunca impede uma gravação
  end;
  return null;
end $$;

-- ---------- caixa: vendas, sangria/suprimento, abrir caixa ----------
create or replace function public.h_caixa() returns trigger language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; v jsonb; m jsonb;
begin
  begin
    o := case when tg_op = 'UPDATE' then old.dados else '{}'::jsonb end; n := new.dados;
    for v in select x from jsonb_array_elements(public.h_arr(n->'vendas')) x
             where not exists (select 1 from jsonb_array_elements(public.h_arr(o->'vendas')) y where y->>'id' = x->>'id') loop
      perform public.h_log('caixa', 'Venda', coalesce(public.h_txt(v->'mesa'), '') || ': ' || public.h_brl(public.h_num(v->'total')) ||
        coalesce(' (' || (select string_agg(distinct public.h_forma(p->>'f'), ' + ') from jsonb_array_elements(public.h_arr(v->'pags')) p) || ')', '') ||
        coalesce(' · garçom ' || nullif(public.h_txt(v->'garcom'), ''), ''));
    end loop;
    for m in select x from jsonb_array_elements(public.h_arr(n->'movs')) x
             where not exists (select 1 from jsonb_array_elements(public.h_arr(o->'movs')) y where y = x) loop
      perform public.h_log('caixa', initcap(coalesce(m->>'tipo', 'movimento')), public.h_brl(public.h_num(m->'valor')) || coalesce(' · ' || nullif(public.h_txt(m->'motivo'), ''), ''));
    end loop;
    if coalesce((n->>'aberto')::boolean, false) and not coalesce((o->>'aberto')::boolean, false) then
      perform public.h_log('caixa', 'Abriu o caixa', 'Troco ' || public.h_brl(coalesce(public.h_num(n->'troco'), 0)));
    end if;
  exception when others then null;
  end;
  return null;
end $$;

-- ---------- fechamento do dia e cancelamentos ----------
create or replace function public.h_dia() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.h_log('caixa', 'Fechou o dia', to_char(new.data, 'DD/MM') || ': ' ||
      public.h_brl((select sum(coalesce(public.h_num(v->'total'), 0)) from jsonb_array_elements(public.h_arr(new.dados->'caixa'->'vendas')) v)) || ', ' ||
      jsonb_array_length(public.h_arr(new.dados->'caixa'->'vendas')) || ' vendas');
  exception when others then null;
  end;
  return null;
end $$;
create or replace function public.h_canc() returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.h_log('mesas', 'Cancelou item', coalesce(public.h_txt(new.dados->'qtd'), '1') || '× ' || public.h_txt(new.dados->'nome') ||
      coalesce(' · ' || nullif(public.h_txt(new.dados->'mesa'), ''), '') || coalesce(' · pedido por ' || nullif(public.h_txt(new.dados->'pedidoPor'), ''), ''));
  exception when others then null;
  end;
  return null;
end $$;

-- ---------- site: placa, cardápio (preço, esgotado, custo), horários, shows, infos ----------
create or replace function public.h_site() returns trigger language plpgsql security definer set search_path = public as $$
declare o jsonb := old.dados; n jsonb := new.dados; r record; muitos text[] := '{}'; k text; d int;
  dias text[] := array['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo']; a jsonb; b jsonb; lst text[];
begin
  begin
    if (n->'aberto') is distinct from (o->'aberto') then
      perform public.h_log('infos', 'Placa', case when coalesce((n->>'aberto')::boolean, false) then 'Mudou para ABERTO' else 'Mudou para FECHADO' end);
    end if;
    -- cardápio, item por item
    if (n->'cardapio') is distinct from (o->'cardapio') then
      for r in
        with a as (select i->>'id' id, i from jsonb_array_elements(public.h_arr(o->'cardapio')) c, jsonb_array_elements(public.h_arr(c->'grupos')) g, jsonb_array_elements(public.h_arr(g->'itens')) i),
             b as (select i->>'id' id, i from jsonb_array_elements(public.h_arr(n->'cardapio')) c, jsonb_array_elements(public.h_arr(c->'grupos')) g, jsonb_array_elements(public.h_arr(g->'itens')) i)
        select a.i ai, b.i bi from a full join b on a.id = b.id where a.i is distinct from b.i
      loop
        if r.ai is null then muitos := muitos || array['cardapio|Item novo|' || public.h_txt(r.bi->'nome') || coalesce(' (R$ ' || nullif(public.h_txt(r.bi->'preco'), '') || ')', '')];
        elsif r.bi is null then muitos := muitos || array['cardapio|Tirou item|' || public.h_txt(r.ai->'nome')];
        else
          if (r.ai->'preco') is distinct from (r.bi->'preco') then muitos := muitos || array['cardapio|Preço|' || public.h_txt(r.bi->'nome') || ': R$ ' || public.h_txt(r.ai->'preco') || ' → R$ ' || public.h_txt(r.bi->'preco')]; end if;
          if (r.ai->'nome') is distinct from (r.bi->'nome') then muitos := muitos || array['cardapio|Nome|' || public.h_txt(r.ai->'nome') || ' → ' || public.h_txt(r.bi->'nome')]; end if;
          if coalesce((r.ai->>'esgotado')::boolean, false) <> coalesce((r.bi->>'esgotado')::boolean, false) then
            muitos := muitos || array['cardapio|' || case when (r.bi->>'esgotado')::boolean then 'Esgotado' else 'Voltou' end || '|' || public.h_txt(r.bi->'nome')]; end if;
          if (r.ai->'desc') is distinct from (r.bi->'desc') then muitos := muitos || array['cardapio|Descrição|' || public.h_txt(r.bi->'nome')]; end if;
          if (r.ai->'custo') is distinct from (r.bi->'custo') then muitos := muitos || array['financeiro|Custo|' || public.h_txt(r.bi->'nome') || ': ' || coalesce(nullif(public.h_txt(r.ai->'custo'), ''), '—') || ' → ' || coalesce(nullif(public.h_txt(r.bi->'custo'), ''), '—')]; end if;
        end if;
      end loop;
      if array_length(muitos, 1) > 15 then
        perform public.h_log('cardapio', 'Cardápio', array_length(muitos, 1) || ' mudanças: ' || array_to_string((select array_agg(split_part(x, '|', 3)) from unnest(muitos[1:6]) x), ', ') || '…');
      else
        foreach k in array muitos loop perform public.h_log(split_part(k, '|', 1), split_part(k, '|', 2), split_part(k, '|', 3)); end loop;
      end if;
    end if;
    -- horários, dia por dia
    if (n->'horarios') is distinct from (o->'horarios') then
      for d in 0..6 loop
        a := o->'horarios'->d; b := n->'horarios'->d;
        if a is distinct from b and b is not null then
          perform public.h_log('horarios', 'Horário', dias[d + 1] || ': ' ||
            case when coalesce((b->>'fechado')::boolean, false) then 'fechado' else coalesce(b->>'abre', '') || ' às ' || coalesce(b->>'fecha', '') end ||
            case when a is null then '' when coalesce((a->>'fechado')::boolean, false) then ' (antes: fechado)' else ' (antes: ' || coalesce(a->>'abre', '') || ' às ' || coalesce(a->>'fecha', '') || ')' end);
        end if;
      end loop;
    end if;
    -- shows
    if (n->'shows') is distinct from (o->'shows') then
      for r in
        with a as (select s->>'id' id, s from jsonb_array_elements(public.h_arr(o->'shows')) s), b as (select s->>'id' id, s from jsonb_array_elements(public.h_arr(n->'shows')) s)
        select a.s sa, b.s sb from a full join b on a.id = b.id where a.s is distinct from b.s
      loop
        perform public.h_log('shows', case when r.sa is null then 'Show novo' when r.sb is null then 'Tirou show' else 'Show alterado' end,
          coalesce(nullif(public.h_txt(coalesce(r.sb, r.sa)->'artista'), ''), 'sem nome') || ' · ' ||
          coalesce(to_char(nullif(coalesce(r.sb, r.sa)->>'data', '')::date, 'DD/MM'), '') || ' ' || coalesce(coalesce(r.sb, r.sa)->>'hora', ''));
      end loop;
    end if;
    -- infos
    if (n->'info') is distinct from (o->'info') then
      if (n->'info'->'avisoLigado') is distinct from (o->'info'->'avisoLigado') then
        perform public.h_log('infos', 'Aviso no site', case when coalesce((n->'info'->>'avisoLigado')::boolean, false) then 'Ligou: ' || public.h_txt(n->'info'->'aviso') else 'Desligou' end);
      end if;
      select array_agg(x) into lst from (select jsonb_object_keys(coalesce(n->'info', '{}')) x union select jsonb_object_keys(coalesce(o->'info', '{}'))) t
        where x <> 'avisoLigado' and (n->'info'->x) is distinct from (o->'info'->x);
      if array_length(lst, 1) > 0 then perform public.h_log('infos', 'Infos', 'Mudou: ' || array_to_string(lst, ', ')); end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;

-- ---------- financeiro: contas a pagar, entrada de estoque, configurações ----------
create or replace function public.h_fin() returns trigger language plpgsql security definer set search_path = public as $$
declare o jsonb := old.dados; n jsonb := new.dados; r record;
begin
  begin
    if (n->'pagar') is distinct from (o->'pagar') then
      for r in
        with a as (select x->>'id' id, x from jsonb_array_elements(public.h_arr(o->'pagar')) x), b as (select x->>'id' id, x from jsonb_array_elements(public.h_arr(n->'pagar')) x)
        select a.x xa, b.x xb from a full join b on a.id = b.id where a.x is distinct from b.x
      loop
        if r.xa is null then
          if not coalesce((r.xb->>'rec')::boolean, false) or r.xb->>'serie' is null or not exists (select 1 from jsonb_array_elements(public.h_arr(o->'pagar')) y where y->>'serie' = r.xb->>'serie') then
            perform public.h_log('financeiro', 'Conta nova', public.h_txt(r.xb->'desc') || ' · ' || public.h_brl(public.h_num(r.xb->'valor')) || ' · vence ' || coalesce(to_char(nullif(r.xb->>'venc', '')::date, 'DD/MM'), ''));
          end if;
        elsif r.xb is null then perform public.h_log('financeiro', 'Apagou conta', public.h_txt(r.xa->'desc') || ' · ' || public.h_brl(public.h_num(r.xa->'valor')));
        elsif coalesce((r.xb->>'paga')::boolean, false) and not coalesce((r.xa->>'paga')::boolean, false) then
          perform public.h_log('financeiro', 'Pagou conta', public.h_txt(r.xb->'desc') || ' · ' || public.h_brl(public.h_num(r.xb->'valor')) || coalesce(' · ' || nullif(r.xb->>'conta', ''), ''));
        elsif not coalesce((r.xb->>'paga')::boolean, false) and coalesce((r.xa->>'paga')::boolean, false) then
          perform public.h_log('financeiro', 'Desfez pagamento', public.h_txt(r.xb->'desc'));
        elsif (r.xa->'valor') is distinct from (r.xb->'valor') or (r.xa->'venc') is distinct from (r.xb->'venc') then
          perform public.h_log('financeiro', 'Conta alterada', public.h_txt(r.xb->'desc') || ' · ' || public.h_brl(public.h_num(r.xb->'valor')));
        end if;
      end loop;
    end if;
    -- estoque: só entradas, itens novos e apagados (a baixa das vendas é automática)
    if (n->'estoque') is distinct from (o->'estoque') then
      for r in
        with a as (select x->>'id' id, x from jsonb_array_elements(public.h_arr(o->'estoque')) x), b as (select x->>'id' id, x from jsonb_array_elements(public.h_arr(n->'estoque')) x)
        select a.x xa, b.x xb from a full join b on a.id = b.id where a.x is distinct from b.x
      loop
        if r.xa is null then perform public.h_log('financeiro', 'Estoque: item novo', public.h_txt(r.xb->'nome') || ' (' || coalesce(public.h_txt(r.xb->'qtd'), '0') || ')');
        elsif r.xb is null then perform public.h_log('financeiro', 'Estoque: tirou item', public.h_txt(r.xa->'nome'));
        elsif coalesce(public.h_num(r.xb->'qtd'), 0) > coalesce(public.h_num(r.xa->'qtd'), 0) then
          perform public.h_log('financeiro', 'Estoque: entrada', public.h_txt(r.xb->'nome') || ': ' || public.h_txt(r.xa->'qtd') || ' → ' || public.h_txt(r.xb->'qtd'));
        end if;
      end loop;
    end if;
    if (n->'taxas') is distinct from (o->'taxas') or (n->'ini') is distinct from (o->'ini') or (n->'diarias') is distinct from (o->'diarias') then
      perform public.h_log('financeiro', 'Configurações', 'Mudou taxas, saldo inicial ou diárias');
    end if;
  exception when others then null;
  end;
  return null;
end $$;

-- ---------- nomes da equipe no PDV ----------
create or replace function public.h_geral() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  begin
    if (new.dados->'equipe') is distinct from (old.dados->'equipe') then
      for r in
        with a as (select x->>'id' id, x from jsonb_array_elements(public.h_arr(old.dados->'equipe')) x), b as (select x->>'id' id, x from jsonb_array_elements(public.h_arr(new.dados->'equipe')) x)
        select a.x xa, b.x xb from a full join b on a.id = b.id where a.x is distinct from b.x
      loop
        perform public.h_log('equipe', case when r.xa is null then 'Nome novo' when r.xb is null then 'Tirou nome' else 'Nome alterado' end,
          public.h_txt(coalesce(r.xb, r.xa)->'nome') || ' · ' || case coalesce(r.xb, r.xa)->>'fn' when 'caixa' then 'caixa' else 'garçom' end);
      end loop;
    end if;
  exception when others then null;
  end;
  return null;
end $$;

-- ---------- acessos: convites, permissões, bloqueios, cadastro ----------
create or replace function public.h_acesso() returns trigger language plpgsql security definer set search_path = public as $$
declare txt text;
begin
  begin
    if tg_op = 'INSERT' then perform public.h_log('acessos', 'Convite', new.email); return null; end if;
    if new.papel is distinct from old.papel or new.perms is distinct from old.perms then
      if new.papel = 'dono' then txt := 'agora é dono (tudo)';
      else select coalesce(string_agg(m || case when (new.perms->>m)::int = 1 then ' (ver)' else '' end, ', ' order by m), 'nada') into txt
           from jsonb_object_keys(coalesce(new.perms, '{}')) m where coalesce((new.perms->>m)::int, 0) > 0;
      end if;
      perform public.h_log('acessos', 'Permissões', new.nome || ': ' || txt);
    end if;
    if new.ativo is distinct from old.ativo then perform public.h_log('acessos', case when new.ativo then 'Desbloqueou' else 'Bloqueou' end, new.nome); end if;
    if new.cadastro_ok and not old.cadastro_ok then perform public.h_log('acessos', 'Cadastro feito', new.nome || ' · ' || new.email); end if;
  exception when others then null;
  end;
  return null;
end $$;

-- ---------- ligar os gatilhos ----------
drop trigger if exists hist on public.pdv_mesas;
create trigger hist after insert or update or delete on public.pdv_mesas for each row execute function public.h_mesas();
drop trigger if exists hist on public.pdv_caixa;
create trigger hist after insert or update on public.pdv_caixa for each row execute function public.h_caixa();
drop trigger if exists hist on public.dias_fechados;
create trigger hist after insert on public.dias_fechados for each row execute function public.h_dia();
drop trigger if exists hist on public.cancelamentos;
create trigger hist after insert on public.cancelamentos for each row execute function public.h_canc();
drop trigger if exists hist on public.site_painel;
create trigger hist after update on public.site_painel for each row execute function public.h_site();
drop trigger if exists hist on public.fin;
create trigger hist after update on public.fin for each row execute function public.h_fin();
drop trigger if exists hist on public.pdv_geral;
create trigger hist after update on public.pdv_geral for each row execute function public.h_geral();
drop trigger if exists hist on public.equipe_acesso;
create trigger hist after insert or update on public.equipe_acesso for each row execute function public.h_acesso();

-- ---------- entrada no painel (o app chama ao abrir) e limpeza de 90 dias ----------
create or replace function public.registra_entrada(aparelho text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.meu_papel() is null then return; end if;
  delete from public.historico where em < now() - interval '90 days';
  if exists (select 1 from public.historico where user_id = auth.uid() and modulo = 'login' and em > now() - interval '30 minutes') then return; end if;
  perform public.h_log('login', 'Entrou no painel', left(regexp_replace(coalesce(aparelho, ''), '[^[:alnum:] .,()/-]', '', 'g'), 60));
end $$;
revoke all on function public.registra_entrada(text) from public;
grant execute on function public.registra_entrada(text) to authenticated;

select 'histórico pronto' as pronto;
