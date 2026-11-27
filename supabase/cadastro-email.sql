-- Big Bar e Prosa: cadastro só depois de confirmar o e-mail com código (2026-11-27)
-- Rodar no SQL Editor DEPOIS de ligar o SMTP próprio (senão o código não chega e ninguém consegue se cadastrar).
-- O app manda um código de 6 números (signInWithOtp) e a pessoa digita (verifyOtp). A sessão que sai daí traz
-- amr = otp no token; sem isso o banco recusa o cadastro, mesmo que alguém abra o link de convite repassado.

create or replace function public.completar_cadastro(nome text, nascimento date, celular text) returns void
language plpgsql security definer set search_path = public as $$
declare cel text := regexp_replace(coalesce(celular, ''), '\D', '', 'g');
begin
  if not exists (select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]'::jsonb)) a where a->>'method' = 'otp') then
    raise exception 'Confirme seu e-mail com o código antes de terminar o cadastro.' using errcode = '42501';
  end if;
  nome := btrim(coalesce(nome, ''));
  if char_length(nome) < 2 or char_length(nome) > 60 then raise exception 'Nome precisa ter de 2 a 60 letras.' using errcode = '22023'; end if;
  if nascimento is null or nascimento > current_date - interval '14 years' or nascimento < date '1900-01-01' then
    raise exception 'Data de nascimento inválida.' using errcode = '22023'; end if;
  if char_length(cel) < 10 or char_length(cel) > 13 then raise exception 'Celular inválido. Use DDD + número.' using errcode = '22023'; end if;
  -- só uma vez: depois do cadastro, nome e dados só mudam pelo dono (o nome assina vendas e cancelamentos)
  update public.equipe_acesso e set nome = completar_cadastro.nome, nascimento = completar_cadastro.nascimento, celular = cel, cadastro_ok = true
   where e.user_id = auth.uid() and e.ativo and not e.cadastro_ok;
  if not found then raise exception 'Cadastro já feito ou convite inválido.' using errcode = '42501'; end if;
end $$;
revoke all on function public.completar_cadastro(text, date, text) from public;
grant execute on function public.completar_cadastro(text, date, text) to authenticated;

select 'cadastro com código pronto' as pronto;
