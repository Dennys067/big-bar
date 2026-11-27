-- Big Bar e Prosa: reforço de segurança do banco (2026-11-27)
-- Rodar uma vez no SQL Editor do Supabase, depois dos outros arquivos. Pode rodar de novo sem estragar nada.
--
-- Por quê: no Supabase toda função e tabela nova do esquema "public" já nasce liberada para "anon"
-- (qualquer pessoa na internet com a chave pública do site). As regras (RLS) seguravam as tabelas, mas
-- algumas funções internas ficavam abertas. Ex.: h_log deixava qualquer pessoa escrever linhas falsas no
-- Histórico. Aqui fechamos tudo e abrimos só o que o site e o painel usam.
-- Nada muda para quem usa o painel, o site ou o QR Code da mesa.

-- ---------- 1. visitante sem login (anon): só ler o site e usar o QR Code da mesa ----------
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
do $$ begin
  if to_regprocedure('public.comanda_mesa(text,text)') is not null then
    grant execute on function public.comanda_mesa(text, text) to anon, authenticated; end if;
  if to_regprocedure('public.chamar_garcom(text,text,text)') is not null then
    grant execute on function public.chamar_garcom(text, text, text) to anon, authenticated; end if;
end $$;

-- tabelas: o visitante só lê a tabela "site" (o site público). Nada de gravar em lugar nenhum.
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r','v','m','p') loop
    execute format('revoke all on public.%I from anon', t.relname);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t.relname);
  end loop;
end $$;
grant select on public.site to anon;
-- relatório é só leitura
do $$ begin
  if to_regclass('public.relatorio_dias') is not null then
    revoke insert, update, delete on public.relatorio_dias from authenticated; end if;
end $$;

-- funções e tabelas criadas daqui pra frente não nascem abertas para o visitante
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;

-- ---------- 2. equipe logada: tira as funções internas (só o próprio banco usa) ----------
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
             and (p.prorettype = 'trigger'::regtype
                  or p.proname in ('h_log','h_brl','h_num','h_txt','h_mesa','h_forma','h_arr','sem_custo','com_custo','mesa_ok')) loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end $$;

-- funções auxiliares com caminho fixo (aviso "search_path mutable" do Security Advisor)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
             and p.proname in ('h_brl','h_num','h_txt','h_mesa','h_forma','h_arr','sem_custo','com_custo')
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') loop
    execute format('alter function %s set search_path = public', f.sig);
  end loop;
end $$;

-- ---------- 3. conferência: deve mostrar só comanda_mesa e chamar_garcom ----------
select 'o visitante (sem login) pode usar: ' || coalesce(string_agg(p.proname, ', ' order by p.proname), 'nada') as conferencia
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
