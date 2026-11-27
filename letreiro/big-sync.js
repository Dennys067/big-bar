/* ===== Big Bar e Prosa — liga o painel ao banco (Supabase) =====
   O painel continua lendo e gravando no localStorage (cópia no aparelho, funciona sem internet).
   Esta camada:
   1) só abre o painel depois do login, com o papel da pessoa (dono, caixa ou garçom) vindo do banco;
   2) põe numa fila tudo que foi salvo no aparelho e manda pro banco; sem internet, a fila espera e sobe depois;
   3) traz na hora o que os outros aparelhos mudaram (tempo real) e confere tudo de novo quando a conexão volta.
   Mesas ficam uma por linha, pra dois garçons não apagarem o pedido um do outro. */
(function(){
'use strict';
var SB_URL='https://uwyoosmjnghokpdrmumk.supabase.co',SB_CHAVE='sb_publishable_uGEzmDjXXCcXyUz89nVPcA_GFhCKAj-';
var K={filaDe:'painelBig.fila.uid',filaOutro:'painelBig.fila.outro',site:'painelBig.v1',pdv:'painelBig.pdv.v1',fin:'painelBig.fin.v1',entrou:'painelBig.entrou',perfil:'painelBig.perfil',fila:'painelBig.fila.v1',acesso:'painelBig.acesso'};
window.BIG_REAL=true;

/* link do convite ou de "esqueci a senha": guarda o tipo antes do Supabase limpar o endereço */
var H=location.hash||'';
var linkTipo=(H.match(/[#&]type=(invite|recovery)/)||[])[1]||'';
var linkErro=/[#&]error=/.test(H)?decodeURIComponent(((H.match(/error_description=([^&]+)/)||[])[1]||'').replace(/\+/g,' ')):'';
var sb=window.BIG_SB_FAKE||supabase.createClient(SB_URL,SB_CHAVE,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'implicit'}});

var LS={get:function(k){try{return localStorage.getItem(k);}catch(e){return null;}},
        set:function(k,v){try{localStorage.setItem(k,v);}catch(e){}},
        del:function(k){try{localStorage.removeItem(k);}catch(e){}}};
function ler(k){try{return JSON.parse(LS.get(k));}catch(e){return null;}}
/* JSON com chaves em ordem: o banco devolve as chaves em outra ordem, isso evita achar mudança onde não tem */
function canon(v){if(v===null||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(canon).join(',')+']';
  return '{'+Object.keys(v).sort().filter(function(k){return v[k]!==undefined;}).map(function(k){return JSON.stringify(k)+':'+canon(v[k]);}).join(',')+'}';}

/* site: confere campos que vão parar dentro de atributos no painel */
var FOTO_OK=/^(data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+|https:\/\/[^"'<>\s`()]+)$/,ID_OK=/^[\w-]{1,60}$/,HORA_OK=/^\d{2}:\d{2}$/;
var nLimpo=0;function nid(){return 'x'+Date.now().toString(36)+(++nLimpo);}
/* tudo que vem do banco passa aqui: id só com letras, números, - e _; foto só imagem de verdade; horas no formato 00:00 */
function limpa(v,chave){
  if(Array.isArray(v))return v.map(function(x){return limpa(x);});
  if(v&&typeof v==='object'){Object.keys(v).forEach(function(k){
      if(/^(id|iid|pid)$/.test(k)&&v[k]!==''&&v[k]!=null&&!ID_OK.test(String(v[k])))v[k]=nid();
      else if(k==='foto'&&v[k]&&!FOTO_OK.test(String(v[k])))v[k]='';
      else if(/^(abre|fecha|hora|abertaEm|contaEm|abertoEm)$/.test(k)&&typeof v[k]==='string'&&v[k]&&!/^\d{1,2}:\d{2}$/.test(v[k]))v[k]='';
      else v[k]=limpa(v[k],k);});return v;}
  return v;}
function limpaSite(d){if(!d||typeof d!=='object')return d;limpa(d);
  (d.cardapio||[]).forEach(function(c){if(!ID_OK.test(String(c.id)))c.id=nid();(c.grupos||[]).forEach(function(g){if(g.id!=null&&!ID_OK.test(String(g.id)))g.id=nid();
    (g.itens||[]).forEach(function(i){if(i.id!=null&&!ID_OK.test(String(i.id)))i.id=nid();});});});
  (d.horarios||[]).forEach(function(h){if(!HORA_OK.test(h.abre))h.abre='17:00';if(!HORA_OK.test(h.fecha))h.fecha='00:00';});
  (d.shows||[]).forEach(function(x){if(!ID_OK.test(String(x.id)))x.id=nid();if(x.foto&&!FOTO_OK.test(x.foto))x.foto='';});
  return d;}
/* versão pública do site: sem o custo dos itens */
function publico(d){var c=JSON.parse(JSON.stringify(d));(c.cardapio||[]).forEach(function(k){(k.grupos||[]).forEach(function(g){(g.itens||[]).forEach(function(i){delete i.custo;});});});return c;}
var usuario=null,acesso=null,iniciou=false,ouvindo=false;
var ultimo={site:null,fin:null,geral:null,caixa:null,mesas:{}}; /* versão mais nova que este aparelho conhece (banco + fila) */
/* permissões por módulo: 0 = nenhum, 1 = só ver, 2 = ver e alterar. O dono vale 2 em tudo.
   O banco confere tudo de novo (RLS e salvar_site); aqui é só pra tela não oferecer o que não pode. */
var MODS=['mesas','caixa','cardapio','horarios','shows','infos','equipe','financeiro'];
var MOD_NOME={mesas:'Mesas',caixa:'Caixa e fechamento',cardapio:'Cardápio',horarios:'Horários',shows:'Shows',infos:'Infos do site',equipe:'Equipe',financeiro:'Financeiro'};
var MOD_DICA={mesas:'Abrir mesa e lançar pedidos',caixa:'Receber, sangria e fechar o dia',cardapio:'Itens, preços e esgotados',horarios:'Dias e horas que abre',shows:'Agenda de shows',infos:'Endereço, aviso e placa aberto/fechado',equipe:'Nomes de garçons e caixas',financeiro:'Contas, estoque, relatórios e custos'};
var PRESETS={nada:{},garcom:{mesas:2,cardapio:1},caixa:{mesas:2,caixa:2,cardapio:1},tudo:{mesas:2,caixa:2,cardapio:2,horarios:2,shows:2,infos:2,equipe:2,financeiro:2}};
function nivelDe(ac,m){if(!ac)return 0;if(ac.papel==='dono')return 2;var v=Math.round(+((ac.perms||{})[m])||0);return v<0?0:v>2?2:v;}
function nivel(m){return nivelDe(acesso,m);}
function temAlgum(ac){return !!ac&&(ac.papel==='dono'||MODS.some(function(m){return nivelDe(ac,m)>0;}));}
function ehDono(){return !!acesso&&acesso.papel==='dono';}
function leFin(){return nivel('financeiro')>=1;}
function pode(t){
  if(t==='site')return ['cardapio','horarios','shows','infos'].some(function(m){return nivel(m)===2;});
  if(t==='fin')return nivel('financeiro')===2;
  if(t==='caixa'||t==='dias')return nivel('caixa')===2;
  if(t==='geral')return nivel('caixa')===2||nivel('equipe')===2;
  if(t==='mesas')return nivel('mesas')===2||nivel('caixa')===2;
  return false;}

/* ---------- avisos ---------- */
var faixa=document.createElement('div');faixa.id='big-net';faixa.setAttribute('role','status');
faixa.style.cssText='position:fixed;left:0;right:0;top:0;z-index:200;text-align:center;font:600 14px/1.3 system-ui,sans-serif;padding:6px 10px;display:none';
var aviso={txt:'',cor:''};
function net(txt,cor){aviso={txt:txt||'',cor:cor||''};mostraFaixa();}
function mostraFaixa(){var t=aviso.txt,c=aviso.cor,n=Object.keys(fila).length;
  if(!t&&n&&!navigator.onLine){t='Sem internet. '+n+(n===1?' alteração guardada':' alterações guardadas')+' neste aparelho, sobe quando voltar.';}
  else if(!t&&!navigator.onLine)t='Sem internet. O que você lançar fica guardado e sobe quando voltar.';
  else if(!t&&n&&tentativas>1)t='Guardando no banco… ('+n+' pendente'+(n>1?'s':'')+')';
  if(!t){faixa.style.display='none';return;}
  faixa.textContent=t;faixa.style.background=c||'#F5A51B';faixa.style.color=c?'#fff':'#0B0B0B';faixa.style.display='block';}
function prende(){if(!faixa.parentNode&&document.body)document.body.appendChild(faixa);}
document.addEventListener('DOMContentLoaded',prende);prende();

/* ---------- fila de envio (sobrevive a recarregar a página) ---------- */
var fila=ler(K.fila)||{},enviando=false,tentativas=0,timer=null,seq=0;
function salvaFila(){LS.set(K.fila,JSON.stringify(fila));mostraFaixa();}
function enfileira(chave,op){op.n=Date.now()+'-'+(++seq);fila[chave]=op;if(usuario)LS.set(K.filaDe,usuario.id);salvaFila();envia();}
/* a fila é de quem lançou: se outra pessoa entrar neste aparelho, a fila fica guardada à parte e só sobe quando o dono dela entrar */
function filaDoLogin(uid){var de=LS.get(K.filaDe),outro=ler(K.filaOutro);
  if(Object.keys(fila).length&&de&&de!==uid){LS.set(K.filaOutro,JSON.stringify({uid:de,fila:fila}));fila={};salvaFila();}
  else if(outro&&outro.uid===uid&&!Object.keys(fila).length){fila=outro.fila||{};LS.del(K.filaOutro);salvaFila();}
  LS.set(K.filaDe,uid);
  if(ler(K.filaOutro))net('Tem lançamentos de outro login guardados neste aparelho. Eles sobem quando essa pessoa entrar aqui de novo.');}
function envia(){
  if(enviando||!usuario)return;var ks=Object.keys(fila);if(!ks.length){tentativas=0;mostraFaixa();return;}
  enviando=true;var k=ks[0],op=fila[k];
  executa(op).then(function(res){
    enviando=false;var e=res&&res.error;
    if(e&&e.code==='23505'&&(op.t==='dias_fechados'||op.t==='cancelamentos'))e=null; /* já guardado antes */
    if(e&&permanente(e)){if(fila[k]&&fila[k].n===op.n)delete fila[k];salvaFila();
      if(window.console)console.error('[big-sync]',e);net('Seu acesso não pode salvar isso no banco ('+(e.code||e.message)+'). Ficou só neste aparelho.','#B3261E');envia();return;}
    if(e)throw e;
    if(fila[k]&&fila[k].n===op.n){delete fila[k];
      if(op.juntou){var ck=op.t==='pdv_caixa'?'caixa':'geral';ultimo[ck]=canon(op.juntou);aplicaPDV();}}
    tentativas=0;salvaFila();if(aviso.cor!=='#B3261E')net('');envia();
  }).catch(function(err){
    enviando=false;tentativas++;mostraFaixa();if(window.console)console.warn('[big-sync] vai tentar de novo',err);
    if(err&&/JWT|token/i.test(err.message||err.code||''))sb.auth.refreshSession().catch(function(){});
    clearTimeout(timer);timer=setTimeout(envia,Math.min(60000,1500*Math.pow(2,Math.min(tentativas,6))));
  });
}
function juntaCaixa(meu,banco){
  if(!banco||!meu||banco.data!==meu.data)return meu;
  var j=JSON.parse(JSON.stringify(meu)),ids={};(j.vendas||[]).forEach(function(v){ids[v.id]=1;});
  (banco.vendas||[]).forEach(function(v){if(!ids[v.id])j.vendas.push(v);});
  var ms={};(j.movs||[]).forEach(function(m){ms[canon(m)]=1;});(banco.movs||[]).forEach(function(m){if(!ms[canon(m)])j.movs.push(m);});
  return j;}
function juntaGeral(meu,banco){
  if(!banco||!meu)return meu;var j=JSON.parse(JSON.stringify(meu)),cs={};
  (j.cancelados||[]).forEach(function(c){cs[canon(c)]=1;});(banco.cancelados||[]).forEach(function(c){if(!cs[canon(c)])j.cancelados.push(c);});
  var bv=banco.vendidos||{},jv=j.vendidos=j.vendidos||{},lim=new Date(Date.now()-40*864e5).toISOString().slice(0,10);Object.keys(bv).forEach(function(d){if(d<lim)return;var o=jv[d]=jv[d]||{};Object.keys(bv[d]||{}).forEach(function(k){o[k]=Math.max(o[k]||0,bv[d][k]||0);});});
  return j;}
function executa(op){
  if(op.t==='rpc_site')return sb.rpc('salvar_site',{dados:op.dados});
  if(op.t==='pdv_caixa'||op.t==='pdv_geral')return sb.from(op.t).select('dados').eq('id',1).maybeSingle().then(function(r){
    if(r.error)return r;var b=r.data&&r.data.dados,d=op.t==='pdv_caixa'?juntaCaixa(op.dados,b):juntaGeral(op.dados,b);
    if(canon(d)!==canon(op.dados)){op.juntou=d;}
    return sb.from(op.t).upsert({id:1,dados:d});});
  if(op.apagar)return sb.from(op.t).delete().eq('id',op.id);
  if(op.t==='dias_fechados')return sb.from(op.t).insert({id:op.id,data:op.data,dados:op.dados});
  if(op.t==='cancelamentos')return sb.from(op.t).insert({id:op.id,data:op.data,dados:op.dados});
  return sb.from(op.t).upsert({id:op.id,dados:op.dados});
}
function permanente(e){var c=String(e.code||'');return c==='42501'||/^2[23]/.test(c)||c==='PGRST204'||c==='PGRST205';}
window.addEventListener('offline',function(){mostraFaixa();});
window.addEventListener('online',function(){tentativas=0;clearTimeout(timer);envia();atualizaTudo();mostraFaixa();});
document.addEventListener('visibilitychange',function(){if(!document.hidden&&iniciou&&usuario){envia();atualizaTudo();}});

/* ---------- gravar ---------- */
function partesPDV(P){
  return {geral:{v:P.v||1,equipe:P.equipe||[],historico:P.historico||[],cancelados:P.cancelados||[],vendidos:P.vendidos||{},qtdMesas:P.qtdMesas||20},caixa:P.caixa||{},mesas:P.mesas||{}};}
function mudou(tipo){
  if(!usuario||!iniciou)return;
  if(tipo==='site'||tipo==='fin'){if(!pode(tipo))return;var d=ler(K[tipo]);if(!d)return;if(tipo==='site')d=limpaSite(d);var c=canon(d);
    if(c!==ultimo[tipo]){ultimo[tipo]=c;
      if(tipo==='site'&&ehDono()){enfileira('sitep',{t:'site_painel',id:1,dados:d});enfileira('site',{t:'site',id:1,dados:publico(d)});}
      else if(tipo==='site')enfileira('site',{t:'rpc_site',id:1,dados:d}); /* o banco confere módulo por módulo e guarda o custo */
      else enfileira(tipo,{t:tipo,id:1,dados:d});}return;}
  if(tipo!=='pdv')return;
  var P=ler(K.pdv);if(!P)return;var p=partesPDV(P),c2;
  c2=canon(p.geral);if(c2!==ultimo.geral&&pode('geral')){ultimo.geral=c2;enfileira('geral',{t:'pdv_geral',id:1,dados:p.geral});}
  c2=canon(p.caixa);if(c2!==ultimo.caixa&&pode('caixa')){ultimo.caixa=c2;enfileira('caixa',{t:'pdv_caixa',id:1,dados:p.caixa});}
  if(!pode('mesas'))return;
  Object.keys(p.mesas).forEach(function(k){var cm=canon(p.mesas[k]);if(cm!==ultimo.mesas[k]){ultimo.mesas[k]=cm;enfileira('mesa:'+k,{t:'pdv_mesas',id:k,dados:p.mesas[k]});}});
  Object.keys(ultimo.mesas).forEach(function(k){if(!(k in p.mesas)){delete ultimo.mesas[k];enfileira('mesa:'+k,{t:'pdv_mesas',id:k,apagar:true});}});
}
/* guarda o dia fechado com todas as vendas, movimentos e cancelamentos */
function arquivarDia(dia){if(!usuario||!pode('dias'))return;
  var data=(dia.caixa&&dia.caixa.data)||new Date().toISOString().slice(0,10),id='dia-'+data+'-'+Date.now().toString(36);
  enfileira('dia:'+id,{t:'dias_fechados',id:id,data:data,dados:dia,por:dia.fechadoPor||''});return id;}
/* dono: traz pro financeiro os dias que o caixa fechou (o caixa não lê nem grava o financeiro) */
var importando=false;
function importaDias(){if(!usuario||!pode('fin')||importando||!window.__bigImportarDias)return;importando=true;
  sb.from('dias_fechados').select('id,dados').then(function(r){importando=false;if(r.error||!r.data)return;
    window.__bigImportarDias(r.data.map(function(l){return {id:l.id,dados:limpa(l.dados)};}));},function(){importando=false;});}

function cancelou(c){if(!usuario||!pode('mesas'))return;var id='c-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
  enfileira('canc:'+id,{t:'cancelamentos',id:id,data:c.data,dados:c});}
/* ---------- receber ---------- */
var CHAVE_T={site:'site',site_painel:'site',fin:'fin',pdv_geral:'geral',pdv_caixa:'caixa'};
function tabSite(){return leFin()?'site_painel':'site';}
function chaveFila(t){return t==='site'&&ehDono()?'sitep':t;}
function pendente(chave){return !!fila[chave];}
function caixaVazio(){var d=new Date(),p=function(n){return (n<10?'0':'')+n;};return {data:d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()),aberto:false,abertoEm:'',abertoPor:'',troco:0,vendas:[],movs:[]};}
function montaPDV(){if(ultimo.caixa==null&&ultimo.geral==null&&!Object.keys(ultimo.mesas).length)return null;
  var g={};try{g=JSON.parse(ultimo.geral||'{}');}catch(e){}
  var P={v:g.v||1,equipe:g.equipe||[],mesas:{},caixa:null,historico:g.historico||[],cancelados:g.cancelados||[],vendidos:g.vendidos||{},qtdMesas:Math.min(99,Math.max(1,Math.round(+g.qtdMesas)||20))};
  try{P.caixa=ultimo.caixa?JSON.parse(ultimo.caixa):caixaVazio();}catch(e){P.caixa=caixaVazio();}
  Object.keys(ultimo.mesas).sort().forEach(function(k){try{P.mesas[k]=JSON.parse(ultimo.mesas[k]);}catch(e){}});
  return P.caixa?P:null;}
function aplicar(tipo,obj){if(!obj)return;var atual=ler(K[tipo]);if(atual&&canon(atual)===canon(obj))return;
  LS.set(K[tipo],JSON.stringify(obj));if(iniciou&&window.__bigAplicar)window.__bigAplicar(tipo,obj);}
function aplicaPDV(){var P=montaPDV();if(P)aplicar('pdv',P);}
/* uma linha que chegou do banco: entra no "ultimo", a não ser que este aparelho tenha versão mais nova esperando na fila */
function recebe(tabela,linha,apagou){
  if(!apagou&&linha.dados===undefined){setTimeout(atualizaTudo,300);return false;}
  if(tabela==='pdv_mesas'){var k=String(linha.id);if(!ID_OK.test(k)||pendente('mesa:'+k))return false;if(!apagou)limpa(linha.dados);
    if(apagou){if(!(k in ultimo.mesas))return false;delete ultimo.mesas[k];return true;}
    var c=canon(linha.dados);if(ultimo.mesas[k]===c)return false;ultimo.mesas[k]=c;return true;}
  if((tabela==='site'||tabela==='site_painel')&&tabela!==tabSite())return false;
  var t=CHAVE_T[tabela];if(!t||apagou||pendente(chaveFila(t)))return false;
  var dd=t==='site'?limpaSite(linha.dados):limpa(linha.dados);var c2=canon(dd);if(ultimo[t]===c2)return false;ultimo[t]=c2;return true;}
function buscaTudo(){
  var q=[sb.from(tabSite()).select('id,dados'),leFin()?sb.from('fin').select('id,dados'):Promise.resolve({data:[]}),
         sb.from('pdv_geral').select('id,dados'),sb.from('pdv_caixa').select('id,dados'),sb.from('pdv_mesas').select('id,dados')];
  return Promise.all(q).then(function(r){
    r.forEach(function(x){if(x.error)throw x.error;});
    var faltando=[];
    var nomes=[tabSite(),'fin','pdv_geral','pdv_caixa'];
    nomes.forEach(function(nm,i){var l=r[i].data[0];if(l)recebe(nm,l,false);
      else if(!pendente(chaveFila(CHAVE_T[nm])))faltando.push(CHAVE_T[nm]);});
    /* mesas: o que sumiu do banco foi fechado em outro aparelho */
    var noBanco={};r[4].data.forEach(function(l){noBanco[l.id]=1;recebe('pdv_mesas',l,false);});
    Object.keys(ultimo.mesas).forEach(function(k){if(!noBanco[k])recebe('pdv_mesas',{id:k},true);});
    return faltando;
  });
}
var atualizando=null;
function atualizaTudo(){if(!iniciou||!usuario||atualizando)return;
  atualizando=buscaTudo().then(function(){
    if(ultimo.site)aplicar('site',JSON.parse(ultimo.site));
    if(ultimo.fin&&leFin())aplicar('fin',JSON.parse(ultimo.fin));
    aplicaPDV();importaDias();}).catch(function(e){if(window.console)console.warn('[big-sync]',e);}).then(function(){atualizando=null;});}
var canal=null;
function ouvir(){if(ouvindo)return;ouvindo=true;var primeira=true;
  canal=sb.channel('painel');
  [tabSite(),'fin','pdv_geral','pdv_caixa','pdv_mesas'].forEach(function(t){
    canal.on('postgres_changes',{event:'*',schema:'public',table:t},function(ev){
      var apagou=ev.eventType==='DELETE',linha=apagou?ev.old:ev.new;if(!linha)return;
      if(!recebe(t,linha,apagou))return;
      if(t==='site'||t==='site_painel')aplicar('site',JSON.parse(ultimo.site));
      else if(t==='fin')aplicar('fin',JSON.parse(ultimo.fin));
      else aplicaPDV();});});
  canal.subscribe(function(st){
    if(st==='SUBSCRIBED'){if(!primeira)atualizaTudo();primeira=false;}});
}

/* ---------- abrir o painel ---------- */
function preparaLocal(){
  /* começa do que o aparelho já tinha + o que ainda está na fila */
  var s=ler(K.site),f=ler(K.fin),P=ler(K.pdv);
  if(s)ultimo.site=canon(limpaSite(s));if(f)ultimo.fin=canon(f);
  if(P){var p=partesPDV(P);ultimo.geral=canon(p.geral);ultimo.caixa=canon(p.caixa);Object.keys(p.mesas).forEach(function(k){ultimo.mesas[k]=canon(p.mesas[k]);});}
  Object.keys(fila).forEach(function(k){var op=fila[k];
    if(k.indexOf('mesa:')===0){if(op.apagar)delete ultimo.mesas[op.id];else ultimo.mesas[op.id]=canon(op.dados);}
    else if(k==='sitep'||(k==='site'&&op.t==='rpc_site')||k==='fin'||k==='geral'||k==='caixa')ultimo[k==='sitep'||k==='site'?'site':k]=canon(op.dados);});
}
function abrir(faltando){
  if(iniciou)return;iniciou=true;tiraCortina();
  window.__bigApp();
  if(ehDono())(faltando||[]).forEach(function(t){ultimo[t]=null;if(window.__bigSalvar)window.__bigSalvar(t==='geral'||t==='caixa'?'pdv':t);});
  if(usuario){ouvir();chIniciar();envia();importaDias();if(window.__bigEquipe&&!ehDono()&&nivel('caixa')===2)window.__bigEquipe({nome:acesso.nome,papel:'caixa'});}
}
function comecar(u,offline){
  filaDoLogin(u.id);usuario=u;LS.set(K.entrou,'1');
  LS.set(K.perfil,JSON.stringify({tipo:ehDono()?'dono':'eq',nome:acesso.nome}));
  document.documentElement.classList.add('perfil-fixo');
  preparaLocal();
  if(offline){abrir([]);return;}
  buscaTudo().then(function(faltando){
    if(ultimo.site)LS.set(K.site,ultimo.site);else LS.del(K.site);
    if(leFin()){if(ultimo.fin)LS.set(K.fin,ultimo.fin);else LS.del(K.fin);}else LS.del(K.fin);
    var P=montaPDV();if(P)LS.set(K.pdv,JSON.stringify(P));else LS.del(K.pdv);
    abrir(faltando);
    try{sb.rpc('registra_entrada',{aparelho:aparelho()}).then(function(){},function(){});}catch(e){}
  }).catch(function(err){if(window.console)console.warn('[big-sync]',err);mostraFaixa();abrir([]);});
}
function semAcesso(msg){tiraCortina();cortina.textContent='';
  var c=caixaCentral('Acesso não liberado',msg);var b=document.createElement('button');b.textContent='Sair';b.style.cssText=BTN;
  b.onclick=function(){limpaLocal();sb.auth.signOut().then(function(){location.hash='#entrar';location.reload();});};c.appendChild(b);}
function iniciar(u){
  sb.from('equipe_acesso').select('papel,nome,ativo,perms,cadastro_ok').eq('user_id',u.id).maybeSingle().then(function(r){
    if(r.error)throw r.error;
    if(!r.data||!r.data.ativo){LS.del(K.acesso);semAcesso('Este e-mail ainda não tem acesso ao painel. Fale com o dono do Big.');return;}
    if(r.data.cadastro_ok===false){LS.del(K.acesso);telaCadastro(u,false,r.data.nome);return;}
    acesso={papel:r.data.papel,nome:r.data.nome,perms:r.data.perms||{}};
    if(!temAlgum(acesso)){LS.del(K.acesso);telaAguardando(u);return;}
    LS.set(K.acesso,JSON.stringify({uid:u.id,papel:acesso.papel,nome:acesso.nome,perms:acesso.perms}));
    comecar(u,false);
  }).catch(function(err){
    /* sem internet: usa o último acesso conhecido deste aparelho */
    var a=ler(K.acesso);if(a&&a.uid===u.id){acesso={papel:a.papel,nome:a.nome,perms:a.perms||{}};comecar(u,true);mostraFaixa();return;}
    tiraCortina();caixaCentral('Sem conexão','Não deu pra conferir seu acesso agora. Confira a internet e abra de novo.');
  });
}

/* ---------- telas desta camada (carregando, criar senha) ---------- */
var BTN='appearance:none;border:0;background:#F5A51B;color:#0B0B0B;font:700 17px system-ui,sans-serif;padding:14px 18px;min-height:48px;border-radius:4px;cursor:pointer;width:100%;margin-top:10px';
var cortina=document.createElement('div');
cortina.style.cssText='position:fixed;inset:0;z-index:300;background:#EADFC1;display:flex;align-items:center;justify-content:center;font:600 18px system-ui,sans-serif;color:#1B1713;padding:20px';
cortina.textContent='Carregando o painel…';
function tiraCortina(){if(cortina.parentNode&&cortina.textContent==='Carregando o painel…')cortina.parentNode.removeChild(cortina);}
function poeCortina(){if(document.body&&!cortina.parentNode)document.body.appendChild(cortina);}
document.addEventListener('DOMContentLoaded',poeCortina);poeCortina();
function caixaCentral(titulo,texto){
  var fundo=document.createElement('div');fundo.style.cssText='position:fixed;inset:0;z-index:310;background:#EADFC1;display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto';
  var c=document.createElement('div');c.setAttribute('role','dialog');c.setAttribute('aria-labelledby','big-cx-h');
  c.style.cssText='background:#1B1713;color:#F1E8CF;max-width:380px;width:100%;padding:24px;border-radius:6px;font:400 16px/1.4 system-ui,sans-serif;box-shadow:6px 7px 0 #A8711A';
  c.innerHTML='<h2 id="big-cx-h" style="margin:0 0 8px;font:800 24px/1.1 system-ui,sans-serif;color:#F5A51B"></h2><p style="margin:0 0 6px"></p>';
  c.querySelector('h2').textContent=titulo;c.querySelector('p').textContent=texto;
  fundo.appendChild(c);var por=function(){document.body.appendChild(fundo);};if(document.body)por();else document.addEventListener('DOMContentLoaded',por);
  return c;}
/* olhinho: mostra ou esconde a senha */
var OLHO='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
var OLHO_F='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
function olhinho(inp){if(!inp||inp.dataset.olho)return;inp.dataset.olho='1';
  var w=document.createElement('span');w.style.cssText='position:relative;display:block';inp.parentNode.insertBefore(w,inp);w.appendChild(inp);
  inp.style.paddingRight='52px';inp.style.width='100%';inp.style.boxSizing='border-box';
  var b=document.createElement('button');b.type='button';b.setAttribute('aria-label','Mostrar senha');b.setAttribute('aria-pressed','false');b.innerHTML=OLHO;
  b.style.cssText='position:absolute;right:2px;top:50%;transform:translateY(-50%);width:48px;height:44px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;color:#A8711A;cursor:pointer;padding:0;margin:0;box-shadow:none;min-height:0';
  b.addEventListener('click',function(){var ver=inp.type==='password';inp.type=ver?'text':'password';b.innerHTML=ver?OLHO_F:OLHO;
    b.setAttribute('aria-label',ver?'Esconder senha':'Mostrar senha');b.setAttribute('aria-pressed',String(ver));inp.focus();});
  w.appendChild(b);}
document.addEventListener('DOMContentLoaded',function(){olhinho(document.getElementById('senha'));});
var REGRAS=[['8 caracteres ou mais',function(s){return s.length>=8;}],['Uma letra maiúscula',function(s){return /[A-Z]/.test(s);}],
  ['Uma letra minúscula',function(s){return /[a-z]/.test(s);}],['Um número',function(s){return /\d/.test(s);}]];
function senhaBoa(s){return REGRAS.every(function(r){return r[1](s);});}
var CAMPO='display:block;width:100%;box-sizing:border-box;font:400 18px system-ui,sans-serif;padding:12px;margin:4px 0 10px;border:2px solid #A8711A;border-radius:4px;background:#F1E8CF;color:#1B1713';
var ROT='display:block;font-weight:700;margin-top:6px';
function camposSenha(){return '<label style="'+ROT+'">Senha<input id="big-s1" type="password" autocomplete="new-password" aria-describedby="big-regras" style="'+CAMPO+'"></label>'+
  '<ul id="big-regras" aria-live="polite" style="list-style:none;margin:-4px 0 10px;padding:0;font-size:15px">'+REGRAS.map(function(r,i){return '<li data-r="'+i+'" style="margin:2px 0">○ '+r[0]+'</li>';}).join('')+'</ul>'+
  '<label style="'+ROT+'">Repita a senha<input id="big-s2" type="password" autocomplete="new-password" style="'+CAMPO+'"></label>';}
function ligaRegras(f){var s1=f.querySelector('#big-s1');if(!s1)return;
  var at=function(){var v=s1.value;f.querySelectorAll('#big-regras li').forEach(function(li){var ok=REGRAS[+li.dataset.r][1](v);li.textContent=(ok?'✓ ':'○ ')+REGRAS[+li.dataset.r][0];li.style.color=ok?'#9BE29B':'#F1E8CF';});};
  s1.addEventListener('input',at);at();olhinho(s1);olhinho(f.querySelector('#big-s2'));}
function confereSenha(f){var s1=f.querySelector('#big-s1').value,s2=f.querySelector('#big-s2').value;
  if(!senhaBoa(s1))return 'A senha precisa de 8 caracteres, com letra maiúscula, letra minúscula e número.';
  if(s1!==s2)return 'As duas senhas não são iguais.';return '';}
/* convite: a pessoa completa o cadastro (nome, nascimento, celular) e cria a senha. Entra sem acesso até o dono liberar. */
function telaCadastro(u,comSenha,nomeAtual){
  tiraCortina();
  var c=caixaCentral('Complete seu cadastro',(comSenha?'Bem-vindo ao painel do Big! ':'')+'Preencha seus dados'+(comSenha?' e crie sua senha':'')+(u.email?' ('+u.email+')':'')+'. Depois o dono libera o que você pode ver.');
  var f=document.createElement('form');f.noValidate=true;
  var hoje=new Date(),max=(hoje.getFullYear()-14)+'-'+('0'+(hoje.getMonth()+1)).slice(-2)+'-'+('0'+hoje.getDate()).slice(-2);
  f.innerHTML='<input type="email" autocomplete="username" hidden>'+
    '<label style="'+ROT+'">Nome completo<input id="big-nome" type="text" autocomplete="name" maxlength="60" style="'+CAMPO+'"></label>'+
    '<label style="'+ROT+'">Data de nascimento<input id="big-nasc" type="date" min="1900-01-01" max="'+max+'" autocomplete="bday" style="'+CAMPO+'"></label>'+
    '<label style="'+ROT+'">Celular com DDD<input id="big-cel" type="tel" inputmode="tel" autocomplete="tel" placeholder="(67) 99999-9999" maxlength="20" style="'+CAMPO+'"></label>'+
    (comSenha?camposSenha():'')+
    '<p id="big-s-erro" role="alert" style="color:#FFB4A9;margin:0;min-height:1.4em"></p>'+
    '<button type="submit" style="'+BTN+'">'+(comSenha?'Salvar e criar senha':'Salvar cadastro')+'</button>';
  f.querySelector('input[type=email]').value=u.email||'';
  if(nomeAtual&&nomeAtual.indexOf('@')<0&&nomeAtual.length>1)f.querySelector('#big-nome').value=nomeAtual;
  else if(!nomeAtual)sb.from('equipe_acesso').select('nome').eq('user_id',u.id).maybeSingle().then(function(r){var n=r&&r.data&&r.data.nome,i=f.querySelector('#big-nome');if(n&&i&&!i.value&&n.length>1&&!/@|\./.test(n))i.value=n;},function(){});
  c.appendChild(f);ligaRegras(f);
  var cel=f.querySelector('#big-cel');
  cel.addEventListener('input',function(){var d=cel.value.replace(/\D/g,'').slice(0,11);cel.value=d.length>6?'('+d.slice(0,2)+') '+d.slice(2,d.length-4)+'-'+d.slice(-4):d.length>2?'('+d.slice(0,2)+') '+d.slice(2):d;});
  f.addEventListener('submit',function(e){e.preventDefault();
    var nome=f.querySelector('#big-nome').value.trim(),nasc=f.querySelector('#big-nasc').value,cl=cel.value.replace(/\D/g,''),er=f.querySelector('#big-s-erro'),bt=f.querySelector('button[type=submit]');
    if(nome.length<2){er.textContent='Escreva seu nome.';f.querySelector('#big-nome').focus();return;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(nasc)||nasc>max||nasc<'1900-01-01'){er.textContent='Confira a data de nascimento.';f.querySelector('#big-nasc').focus();return;}
    if(cl.length<10||cl.length>11){er.textContent='Celular com DDD, só números. Ex.: (67) 99999-9999.';cel.focus();return;}
    if(comSenha){var ms=confereSenha(f);if(ms){er.textContent=ms;f.querySelector('#big-s1').focus();return;}}
    bt.disabled=true;bt.textContent='Salvando…';er.textContent='';
    (comSenha?sb.auth.updateUser({password:f.querySelector('#big-s1').value}).then(function(r){if(r.error)throw r.error;}):Promise.resolve())
      .then(function(){comSenha=false;var s=f.querySelector('#big-regras');if(s){['big-s1','big-s2'].forEach(function(id){var x=f.querySelector('#'+id);if(x)x.closest('label').remove();});s.remove();}
        return sb.rpc('completar_cadastro',{nome:nome,nascimento:nasc,celular:cl});})
      .then(function(r){if(r&&r.error)throw r.error;location.hash='';location.reload();})
      .catch(function(err){bt.disabled=false;bt.textContent=comSenha?'Salvar e criar senha':'Salvar cadastro';er.textContent=erro(err);});
  });
  setTimeout(function(){var i=f.querySelector('#big-nome');if(i)(i.value?f.querySelector('#big-nasc'):i).focus();},50);
}
/* cadastro feito, mas o dono ainda não liberou nada */
function telaAguardando(u){
  tiraCortina();
  var c=caixaCentral('Aguardando liberação','Seu cadastro está pronto. Agora o dono do Big escolhe o que você pode ver no painel. Assim que ele liberar, esta tela abre o painel sozinha.');
  var b1=document.createElement('button');b1.type='button';b1.textContent='Ver de novo';b1.style.cssText=BTN;b1.onclick=function(){location.reload();};
  var b2=document.createElement('button');b2.type='button';b2.textContent='Sair';b2.style.cssText=BTN+';background:transparent;color:#F1E8CF;border:2px solid #F1E8CF';
  b2.onclick=function(){limpaLocal();sb.auth.signOut().then(function(){location.hash='#entrar';location.reload();});};
  c.appendChild(b1);c.appendChild(b2);
  setInterval(function(){if(document.hidden)return;sb.from('equipe_acesso').select('papel,perms,ativo').eq('user_id',u.id).maybeSingle().then(function(r){
    if(r&&r.data&&r.data.ativo&&temAlgum(r.data))location.reload();},function(){});},30e3);
}
function telaSenha(u){
  tiraCortina();
  var c=caixaCentral('Crie uma senha nova','Crie sua senha pra entrar no painel'+(u.email?' com '+u.email:'')+'.');
  var f=document.createElement('form');f.noValidate=true;
  f.innerHTML='<input type="email" autocomplete="username" hidden>'+camposSenha()+
    '<p id="big-s-erro" role="alert" style="color:#FFB4A9;margin:0;min-height:1.4em"></p>'+
    '<button type="submit" style="'+BTN+'">Salvar senha e entrar</button>';
  f.querySelector('input[type=email]').value=u.email||'';
  c.appendChild(f);
  f.addEventListener('submit',function(e){e.preventDefault();
    var s1=f.querySelector('#big-s1').value,er=f.querySelector('#big-s-erro'),bt=f.querySelector('button[type=submit]'),ms=confereSenha(f);
    if(ms){er.textContent=ms;return;}
    bt.disabled=true;bt.textContent='Salvando…';
    sb.auth.updateUser({password:s1}).then(function(r){
      if(r.error)throw r.error;
      location.hash='';location.reload();
    }).catch(function(err){bt.disabled=false;bt.textContent='Salvar senha e entrar';er.textContent=erro(err);});
  });
  ligaRegras(f);
  setTimeout(function(){var i=f.querySelector('#big-s1');if(i)i.focus();},50);
}


/* ---------- acessos ao painel (só o dono): gera link, manda no WhatsApp, tira e devolve acesso ---------- */
function chamaEquipe(corpo){
  return sb.functions.invoke('equipe',{body:corpo}).then(function(r){
    if(r.error){var c=r.error.context;if(c&&c.json)return c.json().then(function(j){throw new Error(j.erro||r.error.message);},function(){throw r.error;});throw r.error;}
    if(r.data&&r.data.erro)throw new Error(r.data.erro);return r.data;});}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function acessos(el){
  if(!el)return;if(!ehDono()){el.hidden=true;return;}el.hidden=false;
  if(el.dataset.pronto)return el.__lista&&el.__lista();el.dataset.pronto='1';
  var lista=[],aberto=null;
  el.innerHTML='<h3>Acessos ao painel</h3>'+
    '<p class="acs-txt">Convide pelo e-mail. A pessoa abre o link, preenche nome, nascimento, celular e cria a senha. Ela entra <b>sem acesso a nada</b> até você liberar aqui embaixo o que ela pode ver ou alterar.</p>'+
    '<ul class="eq-lista" id="acs-lista"><li class="vazio-txt">Carregando…</li></ul>'+
    '<form id="acs-novo" novalidate><h3 style="margin-top:1.2rem">Convidar alguém</h3>'+
      '<label class="campo"><span>E-mail da pessoa</span><input type="email" id="acs-email" inputmode="email" autocomplete="off" placeholder="email@da.pessoa"></label>'+
      '<label class="campo"><span>Apelido (opcional)</span><input type="text" id="acs-nome" autocomplete="off" maxlength="40" placeholder="Ex.: Toninho"><small>A pessoa coloca o nome completo no cadastro.</small></label>'+
      '<button class="btn ambar" type="submit">Gerar link de convite</button>'+
    '</form><div id="acs-link" hidden></div>'+
    '<div class="acs-todos" style="margin-top:1.4rem"><h3>Segurança do seu login</h3><p class="acs-txt">Perdeu o celular ou alguém viu sua senha? Isto tira o seu login de todos os aparelhos, inclusive deste. Depois é só entrar de novo.</p>'+
      '<button class="btn" type="button" id="acs-sair-todos">Sair de todos os aparelhos</button><p class="acs-erro" id="acs-todos-erro" role="alert"></p></div>';
  el.querySelector('#acs-sair-todos').addEventListener('click',function(){var b=this,er=el.querySelector('#acs-todos-erro');
    if(b.dataset.ok!=='1'){b.dataset.ok='1';b.textContent='Toque de novo pra confirmar';er.textContent='';setTimeout(function(){if(document.body.contains(b)){b.dataset.ok='';b.textContent='Sair de todos os aparelhos';}},6000);return;}
    b.disabled=true;b.textContent='Saindo…';
    sairTodos().catch(function(err){b.disabled=false;b.dataset.ok='';b.textContent='Sair de todos os aparelhos';
      er.textContent=err&&err.message==='pendente'?'Tem lançamento esperando internet pra subir. Conecte e tente de novo.':erro(err);});});
  var f=el.querySelector('#acs-novo');
  f.addEventListener('submit',function(e){e.preventDefault();
    var email=el.querySelector('#acs-email').value.trim().toLowerCase(),apelido=el.querySelector('#acs-nome').value.trim(),bt=f.querySelector('[type=submit]');
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){mostraLink(null,'Confira o e-mail.');el.querySelector('#acs-email').focus();return;}
    /* quem já está na lista mantém o papel (o convite de novo não pode rebaixar um dono) */
    var ja=lista.filter(function(p){return (p.email||'').toLowerCase()===email;})[0];
    var nome=ja?ja.nome:(apelido||email.split('@')[0]);
    bt.disabled=true;bt.textContent='Gerando…';
    chamaEquipe({acao:'link',nome:nome,email:email,papel:ja?ja.papel:'garcom'}).then(function(r){
      mostraLink({nome:apelido||(ja&&ja.nome)||'',link:r.link,senha:!!(ja&&ja.cadastro_ok!==false)});el.querySelector('#acs-nome').value='';el.querySelector('#acs-email').value='';carregaLista();
    }).catch(function(err){mostraLink(null,err.message||String(err));}).then(function(){bt.disabled=false;bt.textContent='Gerar link de convite';});});
  el.addEventListener('click',function(e){var b=e.target.closest('[data-acs]');if(!b)return;var li=b.closest('[data-uid]'),a=b.dataset.acs;
    if(a==='copiar'){var t=el.querySelector('#acs-url');t.select();try{navigator.clipboard.writeText(t.value);}catch(x){document.execCommand('copy');}b.textContent='Copiado!';return;}
    if(!li)return;var p=porId(li.dataset.uid);if(!p)return;
    if(a==='novo-link'){b.disabled=true;chamaEquipe({acao:'link',nome:p.nome,email:p.email,papel:p.papel}).then(function(r){mostraLink({nome:p.nome,link:r.link,senha:p.cadastro_ok!==false});})
      .catch(function(err){mostraLink(null,err.message);}).then(function(){b.disabled=false;});}
    if(a==='tirar'||a==='devolver'){b.disabled=true;chamaEquipe({acao:'ativo',user_id:p.user_id,ativo:a==='devolver'}).then(carregaLista).catch(function(err){mostraLink(null,err.message);b.disabled=false;});}
    if(a==='perms'){aberto=aberto===p.user_id?null:p.user_id;desenha();var ed=el.querySelector('.acs-perms');if(ed)ed.querySelector('h4').focus();}
    if(a==='preset'){var ed2=b.closest('.acs-perms');var pr=PRESETS[b.dataset.p]||{};ed2.querySelectorAll('[data-mod]').forEach(function(g){marca(g,pr[g.dataset.mod]||0);});}
    if(a==='nv'){marca(b.closest('[data-mod]'),+b.dataset.n);}
    if(a==='salvar-perms'){salvaPerms(p,b.closest('.acs-perms'),b);}
    if(a==='fechar-perms'){aberto=null;desenha();}
  });
  el.addEventListener('change',function(e){if(e.target.id==='acs-dono'){var ed=e.target.closest('.acs-perms');ed.querySelector('.acs-mods').hidden=e.target.checked;}});
  function porId(id){return lista.filter(function(p){return p.user_id===id;})[0];}
  function marca(g,n){g.dataset.n=String(n);g.querySelectorAll('[data-acs="nv"]').forEach(function(x){x.setAttribute('aria-pressed',String(+x.dataset.n===n));});}
  function resumo(p){if(p.papel==='dono')return 'Dono: tudo';if(p.cadastro_ok===false)return 'Cadastro pendente';
    var v=MODS.filter(function(m){return nivelDe(p,m)>0;});if(!v.length)return 'Aguardando liberação';
    return v.map(function(m){return MOD_NOME[m]+(nivelDe(p,m)===1?' (ver)':'');}).join(', ');}
  function dataBR(d){return d&&/^\d{4}-\d{2}-\d{2}/.test(d)?d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4):'';}
  function celBR(c){c=String(c||'');return c.length>=10?'('+c.slice(0,2)+') '+c.slice(2,c.length-4)+'-'+c.slice(-4):c;}
  function editor(p){var eu=p.user_id===usuario.id;
    return '<div class="acs-perms parede" style="margin:.6rem 0 1rem;padding:1rem">'+
      '<h4 tabindex="-1" style="margin:0 0 .4rem">O que '+esc(p.nome)+' pode fazer</h4>'+
      '<p class="acs-txt" style="margin:0 0 .6rem">Prontos: <span class="acs-bts" style="display:inline-flex">'+[['nada','Nada'],['garcom','Garçom'],['caixa','Caixa'],['tudo','Tudo']].map(function(x){return '<button type="button" class="mini" data-acs="preset" data-p="'+x[0]+'">'+x[1]+'</button>';}).join(' ')+'</span></p>'+
      '<div class="acs-mods"'+(p.papel==='dono'?' hidden':'')+'>'+MODS.map(function(m){var n=nivelDe(p,m);
        return '<div class="acs-mod" data-mod="'+m+'" data-n="'+n+'" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.4rem;padding:.45rem 0;border-bottom:1px solid rgba(241,232,207,.2)">'+
          '<span><b>'+MOD_NOME[m]+'</b><small style="display:block;opacity:.75;font-size:.85rem">'+MOD_DICA[m]+'</small></span>'+
          '<span class="seg" role="group" aria-label="'+MOD_NOME[m]+'">'+[[0,'Nenhum'],[1,'Só ver'],[2,'Alterar']].map(function(x){return '<button type="button" data-acs="nv" data-n="'+x[0]+'" aria-pressed="'+(n===x[0])+'">'+x[1]+'</button>';}).join('')+'</span></div>';}).join('')+'</div>'+
      '<label class="chave" style="margin-top:.8rem"><input type="checkbox" role="switch" id="acs-dono"'+(p.papel==='dono'?' checked':'')+(eu?' disabled':'')+'><span class="trilho" aria-hidden="true"></span><span>É dono: vê e altera tudo e libera acessos'+(eu?' (você)':'')+'</span></label>'+
      '<div class="acs-bts"><button type="button" class="btn ambar" data-acs="salvar-perms">Salvar permissões</button><button type="button" class="btn" data-acs="fechar-perms">Fechar</button></div>'+
      '<p class="acs-erro" role="alert"></p></div>';}
  function salvaPerms(p,ed,b){var perms={},dono=ed.querySelector('#acs-dono').checked,er=ed.querySelector('.acs-erro');
    ed.querySelectorAll('[data-mod]').forEach(function(g){var n=+g.dataset.n||0;if(n)perms[g.dataset.mod]=n;});
    var papel=dono?'dono':(p.papel==='dono'?'garcom':p.papel);
    if(p.user_id===usuario.id&&!dono){er.textContent='Você não pode tirar o seu próprio acesso de dono.';return;}
    b.disabled=true;b.textContent='Salvando…';
    sb.from('equipe_acesso').update({perms:perms,papel:papel}).eq('user_id',p.user_id).select('user_id').then(function(r){
      if(r.error)throw r.error;if(!r.data||!r.data.length)throw new Error('42501');
      aberto=null;carregaLista();
    }).catch(function(err){b.disabled=false;b.textContent='Salvar permissões';er.textContent=erro(err);});}
  function desenha(){var ul=el.querySelector('#acs-lista');
    ul.innerHTML=lista.map(function(p){var eu=p.user_id===usuario.id,pend=p.cadastro_ok===false,aguard=!pend&&!temAlgum(p);
      var dados=[p.email,p.celular?celBR(p.celular):'',p.nascimento?'nasc. '+dataBR(p.nascimento):''].filter(Boolean).join(' · ');
      return '<li class="eq-it'+(p.ativo?'':' acs-off')+'" data-uid="'+esc(p.user_id)+'" style="flex-wrap:wrap"><span class="n">'+esc(p.nome)+(eu?' (você)':'')+'<small>'+esc(dados)+'</small><small>'+esc(p.ativo?resumo(p):'Sem acesso (bloqueado)')+'</small></span>'+
        (aguard&&p.ativo?'<span class="fn cx">Liberar</span>':'')+
        (p.ativo?'<button class="acao" type="button" data-acs="perms" aria-expanded="'+(aberto===p.user_id)+'">Permissões</button>':'')+
        (eu?'':(p.ativo?'<button class="acao" type="button" data-acs="novo-link">'+(pend?'Novo convite':'Link de senha')+'</button><button class="acao apagar" type="button" data-acs="tirar">Bloquear</button>'
                      :'<button class="acao" type="button" data-acs="devolver">Desbloquear</button>'))+
        (aberto===p.user_id?'<div style="flex-basis:100%">'+editor(p)+'</div>':'')+'</li>';}).join('')||'<li class="vazio-txt">Ninguém ainda.</li>';}
  function mostraLink(r,erroTxt){var box=el.querySelector('#acs-link');box.hidden=false;
    if(!r){box.innerHTML='<p class="acs-erro" role="alert">'+esc(erroTxt)+'</p>';return;}
    var oi='Oi'+(r.nome?', '+r.nome:'')+'! ';
    var msg=r.senha?oi+'Link pra criar uma senha nova no painel do Big Bar e Prosa: '+r.link:oi+'Seu convite pro painel do Big Bar e Prosa. Abra este link no celular, complete seu cadastro e crie sua senha: '+r.link+' (é só seu, não repasse).';
    box.innerHTML='<p><b>Link pronto.</b> Só funciona uma vez e vence se ninguém abrir. Quem abrir entra sem acesso até você liberar.</p>'+
      '<textarea id="acs-url" readonly rows="3" style="width:100%;font:400 .9rem monospace">'+esc(r.link)+'</textarea>'+
      '<div class="acs-bts"><a class="btn ambar" target="_blank" rel="noopener" href="https://wa.me/?text='+encodeURIComponent(msg)+'">Mandar no WhatsApp</a>'+
      '<button class="btn claro" type="button" data-acs="copiar">Copiar link</button></div>';
    box.scrollIntoView({block:'nearest'});}
  function carregaLista(){var ul=el.querySelector('#acs-lista');
    return sb.from('equipe_acesso').select('user_id,email,nome,papel,ativo,perms,cadastro_ok,nascimento,celular,criado_em').order('criado_em').then(function(r){
      if(r.error)throw r.error;lista=r.data||[];desenha();
    }).catch(function(err){ul.innerHTML='<li class="vazio-txt">Não deu pra carregar ('+esc(erro(err))+').</li>';});}
  el.__lista=function(){historicoUI(el);return carregaLista();};carregaLista();historicoUI(el);
}
/* ---------- histórico (só o dono): quem fez o quê, gravado pelo próprio banco ---------- */
var HIST_MOD=[['','Todas as partes'],['mesas','Mesas'],['caixa','Caixa'],['cardapio','Cardápio'],['horarios','Horários'],['shows','Shows'],['infos','Infos do site'],['financeiro','Financeiro'],['equipe','Equipe'],['acessos','Acessos'],['login','Entradas no painel']];
var HIST_NOME={};HIST_MOD.forEach(function(x){HIST_NOME[x[0]]=x[1];});
function aparelho(){var u=navigator.userAgent||'',s=/iPhone/.test(u)?'iPhone':/iPad/.test(u)?'iPad':/Android/.test(u)?'Android':/Windows/.test(u)?'Windows':/Mac OS/.test(u)?'Mac':/Linux/.test(u)?'Linux':'Aparelho';
  var b=/Edg\//.test(u)?'Edge':/Chrome\//.test(u)?'Chrome':/Firefox\//.test(u)?'Firefox':/Safari\//.test(u)?'Safari':'';return s+(b?' · '+b:'');}
function historicoUI(el){
  if(!el||!ehDono())return;var box=document.getElementById('hist');
  if(!box){box=document.createElement('div');box.id='hist';box.className='parede';box.style.marginTop='1.4rem';(el.closest('.tela')||el.parentNode).appendChild(box); /* por último na aba Equipe */
    if(!document.getElementById('hist-css')){var st=document.createElement('style');st.id='hist-css';
      st.textContent='#hist .hist-filtros{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;gap:.8rem;align-items:end;margin:.6rem 0 0}'+
        '#hist .hf{display:flex;flex-direction:column;gap:.35rem;min-width:0;margin:0}'+
        '#hist .hf span{font:700 .8rem/1 var(--f-placa,system-ui);letter-spacing:.14em;text-transform:uppercase;color:var(--ambar,#F5A51B)}'+
        '#hist .hf input,#hist .hf select{display:block;width:100%;box-sizing:border-box;height:52px;min-height:52px;margin:0;padding:0 .75rem;-webkit-appearance:none;appearance:none;background:#221D18;color:var(--creme,#F1E8CF);border:2px solid rgba(241,232,207,.55);border-radius:0;font:500 1.05rem/1 var(--f-texto,system-ui);text-align:left}'+
        '#hist .hf select{padding-right:2rem;background-image:linear-gradient(45deg,transparent 50%,#F5A51B 50%),linear-gradient(135deg,#F5A51B 50%,transparent 50%);background-position:calc(100% - 18px) 50%,calc(100% - 12px) 50%;background-size:6px 6px;background-repeat:no-repeat}'+
        '#hist .hf input::-webkit-date-and-time-value{text-align:left}'+
        '#hist .hist-filtros .btn{height:52px;min-height:52px;margin:0;box-sizing:border-box;white-space:nowrap}'+
        '@media (max-width:760px){#hist .hist-filtros{grid-template-columns:1fr 1fr}#hist .hist-filtros .hf:first-child{grid-column:1/-1}#hist .hist-filtros .btn{grid-column:1/-1;width:100%}}';
      document.head.appendChild(st);}}
  if(box.dataset.pronto){carrega();return;}box.dataset.pronto='1';
  var d=new Date(),hoje=d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);
  box.innerHTML='<h3>Histórico</h3><p class="acs-txt">Quem fez o quê no painel. O próprio banco anota, ninguém apaga. Fica guardado 90 dias.</p>'+
    '<div class="hist-filtros">'+
      '<label class="hf"><span>Dia</span><input type="date" id="hist-dia" value="'+hoje+'" max="'+hoje+'"></label>'+
      '<label class="hf"><span>Pessoa</span><select id="hist-quem"><option value="">Todas</option></select></label>'+
      '<label class="hf"><span>Parte</span><select id="hist-mod">'+HIST_MOD.map(function(x){return '<option value="'+x[0]+'">'+x[1]+'</option>';}).join('')+'</select></label>'+
      '<button class="btn" type="button" id="hist-atualiza">Atualizar</button></div>'+
    '<p class="acs-txt" id="hist-total" role="status" style="margin:.8rem 0 .4rem"></p><ol id="hist-lista" style="list-style:none;margin:0;padding:0"></ol>';
  ['hist-dia','hist-quem','hist-mod'].forEach(function(id){box.querySelector('#'+id).addEventListener('change',carrega);});
  box.querySelector('#hist-atualiza').addEventListener('click',carrega);
  sb.from('equipe_acesso').select('nome').order('nome').then(function(r){var s=box.querySelector('#hist-quem');
    (r.data||[]).map(function(x){return x.nome;}).concat(['Sistema']).filter(function(v,i,a){return v&&a.indexOf(v)===i;}).forEach(function(n){var o=document.createElement('option');o.value=n;o.textContent=n;s.appendChild(o);});},function(){});
  carrega();
  function carrega(){
    var dia=box.querySelector('#hist-dia').value||hoje,quem=box.querySelector('#hist-quem').value,mod=box.querySelector('#hist-mod').value,ul=box.querySelector('#hist-lista'),tot=box.querySelector('#hist-total');
    var p=dia.split('-'),ini=new Date(+p[0],+p[1]-1,+p[2]),fim=new Date(+p[0],+p[1]-1,+p[2]+1);
    tot.textContent='Carregando…';
    var q=sb.from('historico').select('em,quem,modulo,acao,resumo').gte('em',ini.toISOString()).lt('em',fim.toISOString());
    if(quem)q=q.eq('quem',quem);if(mod)q=q.eq('modulo',mod);
    q.order('em',{ascending:false}).limit(300).then(function(r){
      if(r.error)throw r.error;var L=r.data||[];
      tot.textContent=L.length?(L.length===300?'Mostrando os 300 mais recentes do dia.':L.length+(L.length===1?' registro.':' registros.')):'Nada registrado nesse dia'+(quem||mod?' com esse filtro':'')+'.';
      ul.innerHTML=L.map(function(h){var t=new Date(h.em),hr=('0'+t.getHours()).slice(-2)+':'+('0'+t.getMinutes()).slice(-2);
        return '<li style="display:grid;grid-template-columns:3.2rem 1fr;gap:.5rem;padding:.5rem 0;border-bottom:1px solid rgba(241,232,207,.18)">'+
          '<span style="font-weight:700;color:#F5A51B">'+hr+'</span><span><b>'+esc(h.quem)+'</b> · '+esc(HIST_NOME[h.modulo]||h.modulo)+' · '+esc(h.acao)+
          (h.resumo?'<small style="display:block;opacity:.85;font-size:.95rem">'+esc(h.resumo)+'</small>':'')+'</span></li>';}).join('');
    }).catch(function(err){tot.textContent=/historico|42P01|PGRST205/.test(String(err&&(err.code||'')+(err.message||'')))?'O histórico ainda não foi ligado no banco.':'Não deu pra carregar ('+erro(err)+').';ul.innerHTML='';});}
}
/* ---------- painel de quem não é dono: abas pelas permissões e telas "só ver" ---------- */
var TELA_MOD={inicio:'infos',mesas:'mesas',mesa:'mesas',caixa:'caixa',conta:'caixa',fechamento:'caixa',cardapio:'cardapio',horarios:'horarios',shows:'shows',infos:'infos',equipe:'equipe',financeiro:'financeiro'};
function nivelTela(t){var m=TELA_MOD[t];if(!m)return 2;var n=nivel(m);if(m==='mesas')n=Math.max(n,nivel('caixa'));return n;}
function perfilEq(){var ab=[];
  /* o Início (placa aberto/fechado e resumo) vem primeiro só pra quem cuida do site e do financeiro; os outros começam pelas mesas */
  var gerente=nivel('infos')>=1&&nivel('financeiro')>=1;
  if(gerente)ab.push('inicio');
  if(nivel('mesas')>=1||nivel('caixa')>=1)ab.push('mesas');
  ['caixa','cardapio','horarios','shows','infos'].forEach(function(m){if(nivel(m)>=1)ab.push(m);});
  if(!gerente&&nivel('infos')>=1)ab.push('inicio');
  ['equipe','financeiro'].forEach(function(m){if(nivel(m)>=1)ab.push(m);});
  var ex=[];if(ab.indexOf('mesas')>=0)ex.push('mesa');if(nivel('caixa')>=1)ex.push('conta','fechamento');
  return {rot:'Equipe',abas:ab,extra:ex};}
/* telas só de ver: campos e botões de mudar ficam desligados (o banco também recusa) */
var LIVRES=/^(ac-p|cp-f|rc-f|rl-p|rl-copiar|fn-mes|m-filtro|m-cat|sair|trocar-perfil)$/;
function livre(el){if(el.closest('.filtros,.fin-nav,.pulos,nav,summary,#perfil-barra,.so-ver-faixa'))return true;var ac=el.dataset&&el.dataset.acao;return !!ac&&LIVRES.test(ac);}
function telaAtual(){var t=document.querySelector('#conteudo > .tela:not([hidden])');return t;}
var soVerAgendado=false;
function aplicaSoVer(){soVerAgendado=false;if(!usuario||ehDono())return;var t=telaAtual();
  document.querySelectorAll('.tela[data-so-ver]').forEach(function(x){if(x!==t){x.removeAttribute('data-so-ver');x.querySelectorAll('[data-big-off]').forEach(function(el){el.disabled=false;el.removeAttribute('data-big-off');});var fx=x.querySelector(':scope > .so-ver-faixa');if(fx)fx.remove();}});
  if(!t)return;var nome=t.id.replace(/^t-/,'');
  if(nivelTela(nome)>=2)return;
  t.setAttribute('data-so-ver','1');
  if(!t.querySelector(':scope > .so-ver-faixa')){var fx=document.createElement('p');fx.className='so-ver-faixa';fx.setAttribute('role','note');
    fx.style.cssText='margin:0 0 1rem;padding:.6rem .9rem;background:#1B1713;color:#F5A51B;border-left:6px solid #F5A51B;font:700 1rem/1.3 system-ui,sans-serif';
    fx.textContent='Só leitura: você pode ver esta parte, mas não alterar.';var h=t.querySelector('h2');if(h&&h.parentNode===t)h.insertAdjacentElement('afterend',fx);else t.insertBefore(fx,t.firstChild);}
  t.querySelectorAll('input,select,textarea,button').forEach(function(el){if(el.disabled||livre(el))return;el.disabled=true;el.setAttribute('data-big-off','1');});}
function agendaSoVer(){if(soVerAgendado)return;soVerAgendado=true;(window.requestAnimationFrame||setTimeout)(aplicaSoVer);}
document.addEventListener('DOMContentLoaded',function(){var c=document.getElementById('conteudo');if(c&&window.MutationObserver)new MutationObserver(agendaSoVer).observe(c,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});});
window.addEventListener('hashchange',function(){setTimeout(agendaSoVer,0);});
['click','submit','change','input'].forEach(function(ev){document.addEventListener(ev,function(e){
  var t=e.target&&e.target.closest&&e.target.closest('.tela[data-so-ver]');if(!t)return;
  if(ev==='click'){var b=e.target.closest('button,input,select,textarea,label,[data-acao]');if(!b||livre(b)||b.tagName==='LABEL'&&!b.querySelector('input'))return;}
  e.preventDefault();e.stopImmediatePropagation();},true);});

/* ---------- melhorias do login ---------- */
/* saída automática: 12 horas sem ninguém mexer no painel, o aparelho sai do login (bom pro celular do balcão).
   Só sai se não tiver lançamento esperando internet, pra nada ficar preso no aparelho. */
var K_USO='painelBig.uso',K_EMAIL='painelBig.email',K_SAIU='painelBig.saiu',PARADO_MAX=12*3600e3,ultimoUso=0;
function marcaUso(){var t=Date.now();if(t-ultimoUso<60e3)return;ultimoUso=t;LS.set(K_USO,String(t));}
function parado(){var u=+LS.get(K_USO)||0;return u&&Date.now()-u>PARADO_MAX&&!Object.keys(fila).length;}
function sairPorParado(){LS.set(K_SAIU,'parado');LS.del(K_USO);if(canal)sb.removeChannel(canal);usuario=null;limpaLocal();
  return sb.auth.signOut({scope:'local'}).catch(function(){}).then(function(){location.hash='#entrar';location.reload();});}
['pointerdown','keydown','touchstart'].forEach(function(ev){document.addEventListener(ev,marcaUso,{passive:true,capture:true});});
document.addEventListener('visibilitychange',function(){if(!document.hidden&&usuario&&parado())sairPorParado();});
setInterval(function(){if(usuario&&parado())sairPorParado();},5*60e3);
/* tela de entrar: lembra o último e-mail e avisa por que saiu (o olhinho da senha fica em olhinho()) */
function melhoraEntrar(){
  var f=document.getElementById('form-entrar'),em=document.getElementById('email'),se=document.getElementById('senha');if(!f||!em||!se||f.dataset.melhor)return;f.dataset.melhor='1';
  var guardado=LS.get(K_EMAIL);if(guardado&&!em.value){em.value=guardado;}
  var porque=LS.get(K_SAIU);if(porque==='parado'||porque==='todos'){LS.del(K_SAIU);var d=f.querySelector('.dica');
    if(d){var p=document.createElement('p');p.className='dica';p.setAttribute('role','status');p.style.cssText='color:#F1E8CF;font-weight:700';
      p.textContent=porque==='parado'?'Você saiu sozinho porque o painel ficou 12 horas sem uso. É só entrar de novo.':'Você saiu deste login em todos os aparelhos. Entre de novo aqui.';d.insertAdjacentElement('afterend',p);}}
  if(guardado)setTimeout(function(){se.focus();},0);
}
/* sair deste login em todos os aparelhos (celular perdido, senha que alguém viu) */
function sairTodos(){
  if(Object.keys(fila).length){envia();return Promise.reject(new Error('pendente'));}
  return sb.auth.signOut({scope:'global'}).then(function(r){if(r&&r.error)throw r.error;
    LS.set(K_SAIU,'todos');LS.del(K_USO);if(canal)sb.removeChannel(canal);usuario=null;limpaLocal();location.hash='#entrar';location.reload();});
}
/* ---------- começo ---------- */
/* sem login: tira do HTML tudo que não é a tela de entrar (o painel só monta depois de entrar) */
function esvazia(){document.querySelectorAll('.tela:not(#t-entrar)').forEach(function(t){t.innerHTML='';t.hidden=true;});var n=document.querySelector('nav.abas');if(n)n.innerHTML='';}
function limpaLocal(){[K.pdv,K.fin,K.entrou,K.perfil,K.fila,K.filaDe,K.acesso].forEach(LS.del);}
function inicio(){sb.auth.getSession().then(function(r){
  var s=r&&r.data&&r.data.session;
  if(!s&&r&&r.error){var a=ler(K.acesso);if(a&&a.uid){acesso={papel:a.papel,nome:a.nome,perms:a.perms||{}};comecar({id:a.uid},true);mostraFaixa();return;}} /* sem internet pra renovar o login */
  if(!s){[K.pdv,K.fin,K.entrou,K.perfil,K.acesso].forEach(LS.del);LS.del(K_USO);abrir([]);esvazia();melhoraEntrar(); /* a fila fica: sobe no próximo login */
    if(linkErro)setTimeout(function(){caixaCentral('Link vencido','Esse link de acesso já foi usado ou venceu. Peça um novo ao dono do Big, ou toque em "Esqueci a senha" na tela de entrar.');},0);
    return;}
  if(linkTipo==='invite'){telaCadastro(s.user,true);return;}
  if(linkTipo==='recovery'){telaSenha(s.user);return;}
  if(parado()){sairPorParado();return;}
  if(!LS.get(K_USO))LS.set(K_USO,String(Date.now()));
  iniciar(s.user);
}).catch(function(e){if(window.console)console.error('[big-sync]',e);abrir([]);esvazia();melhoraEntrar();});}
/* espera a página inteira (o app vem depois deste arquivo) */
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',inicio);else setTimeout(inicio,0);
sb.auth.onAuthStateChange(function(ev){if(ev==='SIGNED_OUT'&&iniciou&&usuario){location.hash='#entrar';location.reload();}});

function erro(err){var c=String(err&&(err.code||'')),m=String(err&&(err.message||err)||'');
  if(/invalid_credentials|Invalid login/i.test(c+m))return 'E-mail ou senha errados.';
  if(/email_not_confirmed/i.test(c+m))return 'Abra o e-mail de convite primeiro e crie sua senha.';
  if(/rate|too many|429/i.test(c+m))return 'Muitas tentativas. Espere um pouco e tente de novo.';
  if(/fetch|network|Failed/i.test(m))return 'Sem internet agora.';
  if(/same_password|should be different/i.test(c+m))return 'Escolha uma senha diferente da anterior.';
  if(/weak_password|at least|should contain/i.test(c+m))return 'Senha fraca. Use 8 caracteres ou mais, com letra maiúscula, minúscula e número.';
  if(/42501|permiss/i.test(c+m))return 'Você não tem permissão pra isso.';
  if(/user_banned/i.test(c+m))return 'Este acesso foi desativado.';
  return 'Erro: '+(m||c);}


/* ---------- chamados das mesas (QR Code): cliente chama o garçom ou pede a conta ----------
   Canal separado do "painel": se a tabela ainda não existir no banco, o resto continua funcionando. */
var chs={},chCanal=null,chOk=false,chTimer=null;
function podeCh(){return nivel('mesas')>=1||nivel('caixa')>=1;}
function chLista(){var lim=Date.now()-3*3600e3;
  return Object.keys(chs).map(function(k){return chs[k];}).filter(function(c){return !c.atendido_em&&Date.parse(c.em)>lim;})
    .sort(function(a,b){return Date.parse(a.em)-Date.parse(b.em);});}
function chAvisa(novos){if(window.__bigChamados)try{window.__bigChamados(chLista(),novos||[]);}catch(e){if(window.console)console.warn('[chamados]',e);}}
function chLimpa(c){if(!c||c.id==null||!/^[\w-]{1,20}$/.test(String(c.mesa||''))||(c.tipo!=='garcom'&&c.tipo!=='conta'))return null;
  return {id:String(c.id),mesa:String(c.mesa),tipo:c.tipo,em:String(c.em||''),atendido_em:c.atendido_em||null,atendido_por:c.atendido_por||''};}
function chBusca(primeira){
  return sb.rpc('chamados_pendentes').then(function(r){if(r.error)throw r.error;
    var vistos={},novos=[];
    (r.data||[]).forEach(function(x){var c=chLimpa(x);if(!c)return;vistos[c.id]=1;
      if(!chs[c.id]&&!primeira)novos.push(c);chs[c.id]=c;});
    Object.keys(chs).forEach(function(k){if(!vistos[k])delete chs[k];});
    chOk=true;chAvisa(novos);
  }).catch(function(e){if(window.console)console.warn('[chamados]',e&&e.message||e);});}
function chIniciar(){if(chCanal||!usuario||!podeCh())return;
  chBusca(true);
  chCanal=sb.channel('chamados');
  chCanal.on('postgres_changes',{event:'*',schema:'public',table:'chamados'},function(ev){
    var c=chLimpa(ev.eventType==='DELETE'?ev.old:ev.new);if(!c)return;
    var novo=ev.eventType==='INSERT'&&!chs[c.id];
    if(ev.eventType==='DELETE')delete chs[c.id];else chs[c.id]=c;
    chAvisa(novo&&!c.atendido_em?[c]:[]);});
  var primeira=true;
  chCanal.subscribe(function(st){if(st==='SUBSCRIBED'){if(!primeira)chBusca(false);primeira=false;}});
  /* reserva: o celular pode derrubar a conexão em segundo plano; confere a cada 20 s e quando a tela volta */
  chTimer=setInterval(function(){if(!document.hidden)chBusca(false);},20000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)chBusca(false);});
}
function chAtender(id){var c=chs[id];if(c){c.atendido_em=new Date().toISOString();chAvisa([]);}
  return sb.rpc('atender_chamado',{cid:+id}).then(function(r){if(r.error)throw r.error;},function(e){throw e;})
    .catch(function(e){if(c){c.atendido_em=null;chAvisa([]);}throw e;});}

window.BIG_SYNC={
  mudou:mudou,arquivarDia:arquivarDia,cancelou:cancelou,erro:erro,
  usuario:function(){return usuario;},
  podeFin:function(){return pode('fin');},
  /* o perfil vem do login: sem tela de "Quem é você?" (dono entra como dono, o resto pelas permissões) */
  perfilFixo:function(){return acesso?{tipo:ehDono()?'dono':'eq',nome:acesso.nome}:null;},
  perfilEq:perfilEq,nivel:nivel,
  /* dono: códigos dos QR Codes das mesas */
  qr:{lista:function(){return sb.rpc('qr_lista').then(function(r){if(r.error)throw r.error;return (r.data||[]).filter(function(x){return /^[\w-]{1,20}$/.test(String(x.mesa))&&/^[\w-]{4,60}$/.test(String(x.token));});});},
      garantir:function(n){return sb.rpc('qr_garantir',{n:n}).then(function(r){if(r.error)throw r.error;if(r.data!=='ok')throw new Error(r.data);});},
      trocar:function(m){return sb.rpc('qr_trocar',{m:m}).then(function(r){if(r.error)throw r.error;if(r.data!=='ok')throw new Error(r.data);});}},
  chamados:{lista:chLista,atender:chAtender,ativo:function(){return chOk;},busca:function(){return chBusca(false);}},
  pendentes:function(){return Object.keys(fila).length;},
  acessos:acessos,
  entrar:function(email,senha){return sb.auth.signInWithPassword({email:email,password:senha}).then(function(r){if(r.error)throw r.error;LS.set(K_EMAIL,email);LS.set(K_USO,String(Date.now()));return r.data;});},
  sairTodos:sairTodos,
  esqueci:function(email){return sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname}).then(function(r){if(r.error)throw r.error;});},
  sair:function(){
    if(Object.keys(fila).length){envia();return Promise.reject(new Error('pendente'));}
    if(canal)sb.removeChannel(canal);if(chCanal)sb.removeChannel(chCanal);clearInterval(chTimer);usuario=null;limpaLocal();return sb.auth.signOut();}
};
})();
