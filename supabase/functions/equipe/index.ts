// Função "equipe" (Supabase Edge Function): o dono gera links de acesso pra equipe pelo painel.
// O link vai por WhatsApp; a pessoa abre, cria a própria senha e entra já com o papel certo.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const PAPEIS = ['dono', 'caixa', 'garcom'];
const PAINEL = 'https://dennys067.github.io/big-bar/letreiro/admin.html';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default), { auth: { persistSession: false } });
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: quem, error: qe } = await admin.auth.getUser(jwt);
    if (qe || !quem?.user) return json({ erro: 'Entre de novo no painel.' }, 401);
    const { data: eu } = await admin.from('equipe_acesso').select('papel,ativo').eq('user_id', quem.user.id).maybeSingle();
    if (!eu || !eu.ativo || eu.papel !== 'dono') return json({ erro: 'Só o dono pode mexer nos acessos.' }, 403);

    const b = await req.json().catch(() => ({}));
    const voltar = PAINEL; // links sempre voltam para o painel publicado

    if (b.acao === 'listar') {
      const { data, error } = await admin.from('equipe_acesso').select('user_id,email,nome,papel,ativo').order('criado_em');
      if (error) return json({ erro: error.message }, 400);
      return json({ equipe: data, eu: quem.user.id });
    }

    if (b.acao === 'link') {
      const email = String(b.email || '').trim().toLowerCase();
      const nome = String(b.nome || '').trim().slice(0, 40);
      const papel = String(b.papel || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ erro: 'E-mail inválido.' }, 400);
      if (!nome) return json({ erro: 'Falta o nome.' }, 400);
      if (!PAPEIS.includes(papel)) return json({ erro: 'Papel inválido.' }, 400);
      // pessoa nova: link de convite; quem já tem login: link pra criar senha nova
      let r = await admin.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo: voltar } });
      if (r.error && /already|registered|exists/i.test(r.error.message)) {
        r = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: voltar } });
      }
      if (r.error || !r.data?.user) return json({ erro: r.error?.message || 'Não deu pra gerar o link.' }, 400);
      const uid = r.data.user.id;
      if (uid === quem.user.id && papel !== 'dono') return json({ erro: 'Você não pode tirar o seu próprio acesso de dono.' }, 400);
      const { error: ie } = await admin.from('equipe_acesso').upsert({ user_id: uid, email, nome, papel, ativo: true });
      if (ie) return json({ erro: ie.message }, 400);
      await admin.auth.admin.updateUserById(uid, { ban_duration: 'none' });
      return json({ link: r.data.properties.action_link });
    }

    if (b.acao === 'ativo') {
      const uid = String(b.user_id || '');
      if (!uid) return json({ erro: 'Falta a pessoa.' }, 400);
      if (uid === quem.user.id) return json({ erro: 'Você não pode tirar o seu próprio acesso.' }, 400);
      const ativo = !!b.ativo;
      const { error } = await admin.from('equipe_acesso').update({ ativo }).eq('user_id', uid);
      if (error) return json({ erro: error.message }, 400);
      // sem acesso: derruba o login também (vale em todos os aparelhos assim que o token vencer)
      await admin.auth.admin.updateUserById(uid, { ban_duration: ativo ? 'none' : '876000h' });
      return json({ ok: true });
    }
    return json({ erro: 'Ação desconhecida.' }, 400);
  } catch (e) {
    return json({ erro: String(e) }, 500);
  }
});
