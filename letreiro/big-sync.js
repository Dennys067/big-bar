/* ===== Big Bar e Prosa — liga o painel ao banco (Firebase) =====
   O painel continua lendo e gravando no localStorage (cópia no aparelho, funciona sem internet).
   Esta camada:
   1) só deixa o painel abrir depois que o login termina e os dados do banco chegam;
   2) manda pro banco cada coisa salva no aparelho (site, mesas, caixa, financeiro);
   3) traz na hora o que os outros aparelhos mudaram.
   Mesas ficam uma por documento, pra dois garçons não apagarem o pedido um do outro. */
(function(){
'use strict';
var CFG={apiKey:"AIzaSyCmraCM6Gqe2tGynNxCAAXdub6gc9R-ra0",authDomain:"big-bar-e-prosa.firebaseapp.com",projectId:"big-bar-e-prosa",storageBucket:"big-bar-e-prosa.firebasestorage.app",messagingSenderId:"499611988284",appId:"1:499611988284:web:567c1430b2fe48ecd5ee39"};
var K={site:'painelBig.v1',pdv:'painelBig.pdv.v1',fin:'painelBig.fin.v1',entrou:'painelBig.entrou',perfil:'painelBig.perfil'};
window.BIG_REAL=true;
firebase.initializeApp(CFG);
var auth=firebase.auth(),db=firebase.firestore();
if(/[?&]emu=1/.test(location.search)){auth.useEmulator('http://127.0.0.1:9099');db.useEmulator('127.0.0.1',8080);} /* só para teste local */
try{db.enablePersistence({synchronizeTabs:true}).catch(function(){});}catch(e){}

var LS={get:function(k){try{return localStorage.getItem(k);}catch(e){return null;}},
        set:function(k,v){try{localStorage.setItem(k,v);}catch(e){}},
        del:function(k){try{localStorage.removeItem(k);}catch(e){}}};
var docSite=db.doc('publico/site'),docFin=db.doc('fin/geral'),docGeral=db.doc('pdv/geral'),docCaixa=db.doc('pdv/caixa'),colMesas=db.collection('pdv_mesas');
var ultimo={site:null,fin:null,geral:null,caixa:null,mesas:{}}; /* o que o banco tem (JSON), pra saber o que mudou */
var iniciou=false,usuario=null;

/* ---------- aviso de conexão ---------- */
var faixa=document.createElement('div');faixa.id='big-net';faixa.setAttribute('role','status');
faixa.style.cssText='position:fixed;left:0;right:0;top:0;z-index:200;text-align:center;font:600 14px/1.3 system-ui,sans-serif;padding:6px 10px;display:none';
function net(txt,cor){if(!txt){faixa.style.display='none';return;}faixa.textContent=txt;faixa.style.background=cor||'#F5A51B';faixa.style.color=cor?'#fff':'#0B0B0B';faixa.style.display='block';}
function prende(){if(!faixa.parentNode&&document.body)document.body.appendChild(faixa);}
document.addEventListener('DOMContentLoaded',prende);prende();
window.addEventListener('offline',function(){net('Sem internet. O que você lançar fica guardado e sobe quando voltar.');});
window.addEventListener('online',function(){net('');});

/* ---------- gravar no banco ---------- */
function partesPDV(P){var g={v:P.v||1,equipe:P.equipe||[],historico:P.historico||[],cancelados:P.cancelados||[]};
  return {geral:JSON.stringify(g),caixa:JSON.stringify(P.caixa||{}),mesas:Object.keys(P.mesas||{}).reduce(function(o,k){o[k]=JSON.stringify(P.mesas[k]);return o;},{})};}
function meta(json){return {json:json,em:firebase.firestore.FieldValue.serverTimestamp(),por:usuario?usuario.email:''};}
function falhou(err){if(window.console)console.error('[big-sync]',err);net('Não consegui salvar no banco ('+(err&&err.code||'erro')+'). Ficou guardado neste aparelho.','#B3261E');}
function mudou(tipo){
  if(!usuario||!iniciou)return;
  if(tipo==='site'){var s=LS.get(K.site);if(s&&s!==ultimo.site){ultimo.site=s;docSite.set(meta(s)).catch(falhou);}}
  else if(tipo==='fin'){var f=LS.get(K.fin);if(f&&f!==ultimo.fin){ultimo.fin=f;docFin.set(meta(f)).catch(falhou);}}
  else if(tipo==='pdv'){var raw=LS.get(K.pdv);if(!raw)return;var P;try{P=JSON.parse(raw);}catch(e){return;}
    var p=partesPDV(P),b=db.batch(),n=0;
    if(p.geral!==ultimo.geral){ultimo.geral=p.geral;b.set(docGeral,meta(p.geral));n++;}
    if(p.caixa!==ultimo.caixa){ultimo.caixa=p.caixa;b.set(docCaixa,meta(p.caixa));n++;}
    Object.keys(p.mesas).forEach(function(k){if(p.mesas[k]!==ultimo.mesas[k]){ultimo.mesas[k]=p.mesas[k];b.set(colMesas.doc(k),meta(p.mesas[k]));n++;}});
    Object.keys(ultimo.mesas).forEach(function(k){if(!(k in p.mesas)){delete ultimo.mesas[k];b.delete(colMesas.doc(k));n++;}});
    if(n)b.commit().catch(falhou);}
}
/* guarda o dia fechado com todas as vendas, movimentos e cancelamentos */
function arquivarDia(dia){if(!usuario)return;var id='dia-'+(dia.caixa&&dia.caixa.data||new Date().toISOString().slice(0,10))+'-'+Date.now().toString(36);
  db.doc('pdv/'+id).set(meta(JSON.stringify(dia))).catch(falhou);}

/* ---------- receber do banco ---------- */
function aplicar(tipo,json){var atual=LS.get(K[tipo]);if(json===atual)return;LS.set(K[tipo],json);
  var d;try{d=JSON.parse(json);}catch(e){return;}if(window.__bigAplicar)window.__bigAplicar(tipo,d);}
function montaPDV(){if(ultimo.geral==null&&ultimo.caixa==null&&!Object.keys(ultimo.mesas).length)return null;
  var g={};try{g=JSON.parse(ultimo.geral||'{}');}catch(e){}
  var P={v:g.v||1,equipe:g.equipe||[],mesas:{},caixa:null,historico:g.historico||[],cancelados:g.cancelados||[]};
  try{P.caixa=JSON.parse(ultimo.caixa||'null');}catch(e){}
  Object.keys(ultimo.mesas).forEach(function(k){try{P.mesas[k]=JSON.parse(ultimo.mesas[k]);}catch(e){}});
  if(!P.caixa)return null;return JSON.stringify(P);}
function ouvir(){
  docSite.onSnapshot(function(s){if(!s.exists)return;ultimo.site=s.data().json;aplicar('site',ultimo.site);},falhou);
  docFin.onSnapshot(function(s){if(!s.exists)return;ultimo.fin=s.data().json;aplicar('fin',ultimo.fin);},falhou);
  /* aplica na hora (sem espera): assim o aparelho nunca grava uma lista de mesas mais velha que a do banco */
  function pdv(){var j=montaPDV();if(j)aplicar('pdv',j);}
  docGeral.onSnapshot(function(s){if(!s.exists)return;ultimo.geral=s.data().json;pdv();},falhou);
  docCaixa.onSnapshot(function(s){if(!s.exists)return;ultimo.caixa=s.data().json;pdv();},falhou);
  colMesas.onSnapshot(function(q){q.docChanges().forEach(function(c){if(c.type==='removed')delete ultimo.mesas[c.doc.id];else ultimo.mesas[c.doc.id]=c.doc.data().json;});pdv();},falhou);
}

/* ---------- carregar tudo antes de abrir o painel ---------- */
function carregar(){
  var faltando=[];
  return Promise.all([docSite.get(),docFin.get(),docGeral.get(),docCaixa.get(),colMesas.get()]).then(function(r){
    if(r[0].exists){ultimo.site=r[0].data().json;LS.set(K.site,ultimo.site);}else{LS.del(K.site);faltando.push('site');}
    if(r[1].exists){ultimo.fin=r[1].data().json;LS.set(K.fin,ultimo.fin);}else{LS.del(K.fin);faltando.push('fin');}
    if(r[2].exists)ultimo.geral=r[2].data().json;
    if(r[3].exists)ultimo.caixa=r[3].data().json;
    r[4].forEach(function(d){ultimo.mesas[d.id]=d.data().json;});
    var j=montaPDV();if(j)LS.set(K.pdv,j);else{LS.del(K.pdv);faltando.push('pdv');}
    return faltando;
  });
}
function abrir(faltando){
  if(iniciou)return;iniciou=true;
  window.__bigApp();
  (faltando||[]).forEach(function(t){if(window.__bigSalvar)window.__bigSalvar(t);});
  if(usuario)ouvir();
}
var cortina=document.createElement('div');
cortina.style.cssText='position:fixed;inset:0;z-index:300;background:#EADFC1;display:flex;align-items:center;justify-content:center;font:600 18px system-ui,sans-serif;color:#1B1713';
cortina.textContent='Carregando o painel…';
function tiraCortina(){if(cortina.parentNode)cortina.parentNode.removeChild(cortina);}
document.addEventListener('DOMContentLoaded',function(){document.body.appendChild(cortina);});

auth.onAuthStateChanged(function(u){
  if(iniciou)return;
  usuario=u;
  if(!u){LS.del(K.entrou);LS.del(K.pdv);LS.del(K.fin);tiraCortina();abrir([]);return;}
  LS.set(K.entrou,'1');
  carregar().then(function(f){tiraCortina();abrir(f);}).catch(function(err){
    falhou(err);tiraCortina();abrir([]);});
});

window.BIG_SYNC={
  mudou:mudou,arquivarDia:arquivarDia,
  usuario:function(){return usuario;},
  entrar:function(email,senha){return auth.signInWithEmailAndPassword(email,senha);},
  sair:function(){LS.del(K.pdv);LS.del(K.fin);LS.del(K.entrou);LS.del(K.perfil);return auth.signOut();},
  erro:function(err){var c=err&&err.code||'';
    if(/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(c))return 'E-mail ou senha errados.';
    if(/too-many-requests/.test(c))return 'Muitas tentativas. Espere um pouco e tente de novo.';
    if(/network/.test(c))return 'Sem internet agora.';
    if(/user-disabled/.test(c))return 'Este acesso foi desativado.';
    return 'Erro: '+(c||err);}
};
})();
