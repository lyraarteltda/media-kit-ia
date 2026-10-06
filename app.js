/**
 * Mídia Kit IA — lógica do estúdio.
 *
 * Fluxo: o membro preenche a pauta (identidade, plataformas+números, público,
 * sobre, entregáveis, portfólio, pacotes, depoimentos, contato) → a IA (BYOK
 * OpenRouter) escreve/refina APENAS os textos (nunca inventa métricas) e devolve
 * um JSON → renderizamos o mídia kit como uma "revista" (capa + spreads) na cor
 * da marca → exporta em PDF (impressão), HTML autocontido, PNG da capa e texto.
 *
 * Globais: window.ApiKeyManager, window.MembershipGate, window.RateLimiter,
 * window.APP_CONFIG. Sem Supabase no navegador. Chave só no localStorage (BYOK).
 */
const App = (function () {
  'use strict';

  var DRAFT_KEY = 'media-kit-ia_draft';
  var ENTREGAVEIS = ['Reels', 'Stories', 'Post no feed', 'Carrossel', 'Vídeo no YouTube',
    'UGC', 'Review / unboxing', 'Live', 'Presença em evento', 'Foto de produto'];
  var REDES = ['Instagram', 'TikTok', 'YouTube', 'LinkedIn', 'Kwai', 'X (Twitter)', 'Facebook', 'Twitch', 'Pinterest', 'Podcast', 'Outra'];

  var state = { copy: null, logo: '' };  // logo = data-URI
  var _wired = false;

  /* ---------- utilidades ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // COR-015: normaliza strings "null-like" devolvidas por alguns modelos em modo JSON.
  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (/^(null|undefined|n\/a|na|-|—)$/i.test(s)) return '';
    return s;
  }

  function fmtNum(n) {
    n = parseInt(String(n).replace(/\D/g, ''), 10);
    if (isNaN(n) || n <= 0) return '';
    if (n >= 1000000) { var mi = (n / 1000000); return (mi >= 10 ? Math.round(mi) : mi.toFixed(1).replace('.', ',')) + ' mi'; }
    if (n >= 1000) { return Math.round(n / 1000) + ' mil'; }
    return String(n);
  }

  function toast(msg, kind) {
    var s = $('gen-status'); if (!s) return;
    s.className = 'gen-status' + (kind ? ' ' + kind : '');
    s.textContent = msg || '';
  }

  /* ---------- rascunho (localStorage) ---------- */
  var saveTimer = null;
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(collectBrief(true))); } catch (e) {}
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 400); }

  function restoreDraft() {
    var raw; try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
    if (!raw) return;
    var d; try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d) return;
    ['f-nome', 'f-handle', 'f-nicho', 'f-local', 'f-tagline', 'f-pub-idade', 'f-pub-genero', 'f-pub-local',
      'f-bio', 'f-entregaveis-extra', 'f-marcas', 'f-resultados', 'f-email', 'f-whats', 'f-site'].forEach(function (id) {
      if (d[id] != null && $(id)) $(id).value = d[id];
    });
    if (d.cor && $('f-cor')) { $('f-cor').value = d.cor; applyBrand(d.cor); }
    if (d.logo) { state.logo = d.logo; showLogo(d.logo); }
    if (Array.isArray(d.entregaveis)) selectedDeliverables = d.entregaveis.slice();
    renderChips();
    buildRep('plats-list', d.plats && d.plats.length ? d.plats : [{}], platFields);
    buildRep('pkgs-list', d.pkgs && d.pkgs.length ? d.pkgs : [{}, {}], pkgFields);
    buildRep('deps-list', d.deps && d.deps.length ? d.deps : [], depFields);
  }

  /* ---------- cor da marca ---------- */
  function applyBrand(hex) {
    document.documentElement.style.setProperty('--brand', hex);
    var h = $('f-cor-hex'); if (h) h.textContent = (hex || '').toUpperCase();
  }

  /* ---------- logo ---------- */
  function showLogo(dataURI) {
    var box = $('logo-preview'), img = $('logo-img');
    if (dataURI) { img.src = dataURI; box.hidden = false; } else { box.hidden = true; img.removeAttribute('src'); }
  }
  function handleLogo(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var reader = new FileReader();
    reader.onload = function () {
      var im = new Image();
      im.onload = function () {
        // downscale para no máx 480px (evita data-URI gigante)
        var max = 480, w = im.width, h = im.height, sc = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement('canvas'); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        try { state.logo = cv.toDataURL('image/jpeg', 0.85); } catch (e) { state.logo = reader.result; }
        showLogo(state.logo); scheduleSave();
      };
      im.onerror = function () { state.logo = reader.result; showLogo(state.logo); scheduleSave(); };
      im.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  /* ---------- chips de entregáveis ---------- */
  var selectedDeliverables = ['Reels', 'Stories', 'Post no feed'];
  function renderChips() {
    var box = $('entregaveis'); if (!box) return; box.innerHTML = '';
    ENTREGAVEIS.forEach(function (name) {
      var c = el('button', 'chip' + (selectedDeliverables.indexOf(name) >= 0 ? ' on' : ''), name);
      c.type = 'button'; c.setAttribute('aria-pressed', selectedDeliverables.indexOf(name) >= 0 ? 'true' : 'false');
      c.addEventListener('click', function () {
        var i = selectedDeliverables.indexOf(name);
        if (i >= 0) selectedDeliverables.splice(i, 1); else selectedDeliverables.push(name);
        c.classList.toggle('on'); c.setAttribute('aria-pressed', c.classList.contains('on') ? 'true' : 'false');
        scheduleSave();
      });
      box.appendChild(c);
    });
  }

  /* ---------- listas repetíveis ---------- */
  function platFields(row, data) {
    data = data || {};
    var g1 = el('div', 'form-group');
    var lab = el('label', null, 'Rede'); lab.setAttribute('for', '');
    var sel = el('select', 'select'); REDES.forEach(function (r) { var o = el('option', null, r); o.value = r; if (data.rede === r) o.selected = true; sel.appendChild(o); });
    sel.setAttribute('data-k', 'rede'); g1.appendChild(lab); g1.appendChild(sel);

    var g2 = el('div', 'form-group'); var l2 = el('label', null, '@ / canal'); var i2 = el('input'); i2.type = 'text'; i2.placeholder = '@seuperfil'; i2.value = data.handle || ''; i2.setAttribute('data-k', 'handle'); g2.appendChild(l2); g2.appendChild(i2);

    var grid = el('div', 'grid2');
    var g3 = el('div', 'form-group'); var l3 = el('label', null, 'Seguidores'); var i3 = el('input'); i3.type = 'text'; i3.inputMode = 'numeric'; i3.placeholder = '128000'; i3.value = data.seguidores || ''; i3.setAttribute('data-k', 'seguidores'); g3.appendChild(l3); g3.appendChild(i3);
    var g4 = el('div', 'form-group'); var l4 = el('label', null, 'Engajamento'); var i4 = el('input'); i4.type = 'text'; i4.placeholder = '5,2%'; i4.value = data.engajamento || ''; i4.setAttribute('data-k', 'engajamento'); g4.appendChild(l4); g4.appendChild(i4);
    grid.appendChild(g3); grid.appendChild(g4);

    var g5 = el('div', 'form-group'); var l5 = el('label', null, 'Alcance médio (opcional)'); var i5 = el('input'); i5.type = 'text'; i5.placeholder = '90 mil / post'; i5.value = data.alcance || ''; i5.setAttribute('data-k', 'alcance'); g5.appendChild(l5); g5.appendChild(i5);

    row.appendChild(g1); row.appendChild(g2); row.appendChild(grid); row.appendChild(g5);
  }
  function pkgFields(row, data) {
    data = data || {};
    var g1 = el('div', 'form-group'); var l1 = el('label', null, 'Nome do pacote'); var i1 = el('input'); i1.type = 'text'; i1.placeholder = 'Ex.: Combo Reels + Stories'; i1.value = data.nome || ''; i1.setAttribute('data-k', 'nome'); g1.appendChild(l1); g1.appendChild(i1);
    var g2 = el('div', 'form-group'); var l2 = el('label', null, 'Inclui'); var i2 = el('input'); i2.type = 'text'; i2.placeholder = '1 Reels + 3 Stories'; i2.value = data.inclui || ''; i2.setAttribute('data-k', 'inclui'); g2.appendChild(l2); g2.appendChild(i2);
    var g3 = el('div', 'form-group'); var l3 = el('label', null, 'Valor (R$)'); var i3 = el('input'); i3.type = 'text'; i3.inputMode = 'numeric'; i3.placeholder = '1500'; i3.value = data.preco || ''; i3.setAttribute('data-k', 'preco'); g3.appendChild(l3); g3.appendChild(i3);
    row.appendChild(g1); row.appendChild(g2); row.appendChild(g3);
  }
  function depFields(row, data) {
    data = data || {};
    var g1 = el('div', 'form-group'); var l1 = el('label', null, 'Depoimento'); var t = el('textarea'); t.rows = 2; t.placeholder = 'Trabalho impecável e entrega no prazo…'; t.value = data.texto || ''; t.setAttribute('data-k', 'texto'); g1.appendChild(l1); g1.appendChild(t);
    var g2 = el('div', 'form-group'); var l2 = el('label', null, 'Quem disse'); var i2 = el('input'); i2.type = 'text'; i2.placeholder = 'Marca X · Gerente de marketing'; i2.value = data.autor || ''; i2.setAttribute('data-k', 'autor'); g2.appendChild(l2); g2.appendChild(i2);
    row.appendChild(g1); row.appendChild(g2);
  }

  function buildRep(listId, items, filler) {
    var list = $(listId); if (!list) return; list.innerHTML = '';
    (items || []).forEach(function (data) { addRepRow(listId, filler, data); });
  }
  function addRepRow(listId, filler, data) {
    var list = $(listId); if (!list) return;
    var row = el('div', 'rep-row');
    var del = el('button', 'rep-del', 'remover'); del.type = 'button';
    del.addEventListener('click', function () { row.remove(); scheduleSave(); });
    row.appendChild(del);
    filler(row, data);
    row.addEventListener('input', scheduleSave);
    row.addEventListener('change', scheduleSave);
    list.appendChild(row);
  }
  function readRep(listId) {
    var list = $(listId); if (!list) return [];
    return Array.prototype.map.call(list.querySelectorAll('.rep-row'), function (row) {
      var obj = {};
      Array.prototype.forEach.call(row.querySelectorAll('[data-k]'), function (f) { obj[f.getAttribute('data-k')] = f.value.trim(); });
      return obj;
    });
  }

  /* ---------- coleta da pauta ---------- */
  function collectBrief(forDraft) {
    var b = {
      'f-nome': ($('f-nome') || {}).value || '', 'f-handle': ($('f-handle') || {}).value || '',
      'f-nicho': ($('f-nicho') || {}).value || '', 'f-local': ($('f-local') || {}).value || '',
      'f-tagline': ($('f-tagline') || {}).value || '', 'f-pub-idade': ($('f-pub-idade') || {}).value || '',
      'f-pub-genero': ($('f-pub-genero') || {}).value || '', 'f-pub-local': ($('f-pub-local') || {}).value || '',
      'f-bio': ($('f-bio') || {}).value || '', 'f-entregaveis-extra': ($('f-entregaveis-extra') || {}).value || '',
      'f-marcas': ($('f-marcas') || {}).value || '', 'f-resultados': ($('f-resultados') || {}).value || '',
      'f-email': ($('f-email') || {}).value || '', 'f-whats': ($('f-whats') || {}).value || '', 'f-site': ($('f-site') || {}).value || '',
      cor: ($('f-cor') || {}).value || '#d81b60',
      entregaveis: selectedDeliverables.slice(),
      plats: readRep('plats-list'), pkgs: readRep('pkgs-list'), deps: readRep('deps-list')
    };
    if (forDraft) b.logo = state.logo;
    return b;
  }

  // normaliza a pauta para render + prompt
  function normalize(b) {
    var extras = (b['f-entregaveis-extra'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return {
      nome: b['f-nome'].trim(), handle: b['f-handle'].trim(), nicho: b['f-nicho'].trim(),
      local: b['f-local'].trim(), tagline: b['f-tagline'].trim(),
      publico: { idade: b['f-pub-idade'].trim(), genero: b['f-pub-genero'].trim(), local: b['f-pub-local'].trim() },
      bio: b['f-bio'].trim(),
      entregaveis: b.entregaveis.concat(extras),
      marcas: (b['f-marcas'] || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
      resultados: (b['f-resultados'] || '').trim(),
      plats: (b.plats || []).filter(function (p) { return p.rede || p.handle || p.seguidores; }),
      pkgs: (b.pkgs || []).filter(function (p) { return p.nome || p.preco || p.inclui; }),
      deps: (b.deps || []).filter(function (p) { return p.texto; }),
      contato: { email: b['f-email'].trim(), whats: b['f-whats'].trim(), site: b['f-site'].trim() },
      cor: b.cor
    };
  }

  /* ========================= IA (OpenRouter BYOK) ========================= */
  function buildMessages(d, stricter) {
    var sys = 'Você é um redator especialista em MÍDIA KITS de criadores de conteúdo para marcas, no mercado brasileiro. ' +
      'Escreva SEMPRE 100% em português do Brasil, com acentuação correta, tom profissional, confiante e caloroso, SEM nenhuma palavra ou expressão em inglês desnecessária (o kit é enviado a marcas) — exceto termos já consagrados no marketing BR (Reels, Stories, feed, UGC, engajamento, publi). ' +
      'NUNCA invente números, métricas, seguidores, valores, marcas ou resultados — use apenas o que o criador informou; se um dado não existir, simplesmente não o cite. ' +
      'Responda EXCLUSIVAMENTE com UM objeto JSON válido (aspas duplas, sem markdown, sem comentários, sem texto fora do objeto).';
    var schema = {
      frase_capa: 'string curta (até ~90 caracteres), uma chamada de capa marcante para o criador; se o criador já deu uma tagline, melhore-a mantendo o sentido',
      bio_profissional: 'string de 2 a 4 frases apresentando o criador e o que ele entrega para marcas, a partir do que foi informado',
      publico_descricao: 'string de 1 a 2 frases descrevendo a audiência do criador de forma atraente para marcas, baseada apenas nos dados de público informados',
      motivos: 'array de 3 a 5 strings curtas (motivos para uma marca fechar com este criador), sem inventar números',
      pacotes_desc: 'array de strings — UMA descrição curta (1 frase) por pacote, NA MESMA ORDEM dos pacotes informados; se não houver pacotes, array vazio',
      fecho: 'string de 1 frase, um convite final para a marca entrar em contato'
    };
    var payload = {
      criador: { nome: d.nome, '@': d.handle, nicho: d.nicho, cidade: d.local, tagline_informada: d.tagline },
      plataformas: d.plats.map(function (p) { return { rede: p.rede, '@': p.handle, seguidores: p.seguidores, engajamento: p.engajamento, alcance: p.alcance }; }),
      publico: d.publico, sobre_informado: d.bio, entregaveis: d.entregaveis,
      marcas_anteriores: d.marcas, resultados: d.resultados,
      pacotes: d.pkgs.map(function (p) { return { nome: p.nome, inclui: p.inclui, valor: p.preco }; }),
      contato: d.contato
    };
    var user = 'Monte os textos do mídia kit a partir desta pauta do criador (JSON):\n\n' + JSON.stringify(payload, null, 2) +
      '\n\nDevolva um objeto JSON com EXATAMENTE estas chaves: ' + JSON.stringify(schema) + '.';
    if (stricter) user += '\n\nATENÇÃO: sua resposta anterior NÃO era um JSON válido. Responda de novo APENAS com o objeto JSON, aspas duplas tipográficas simples (") e nada mais.';
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  // repair ladder + parse
  function parseJSON(raw) {
    if (!raw) throw new Error('vazio');
    var s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
    var a = s.indexOf('{'), z = s.lastIndexOf('}');
    if (a >= 0 && z > a) s = s.slice(a, z + 1);
    var attempts = [
      s,
      s.replace(/,\s*([}\]])/g, '$1'),              // vírgula sobrando
      s.replace(/[\x00-\x1f]+/g, ' ')               // bytes de controle (COR-041: texto de escape, nunca o byte cru)
    ];
    for (var i = 0; i < attempts.length; i++) { try { return JSON.parse(attempts[i]); } catch (e) {} }
    // state machine: escapa aspas internas simples
    throw new Error('json inválido');
  }

  function orFetch(messages, key, model, noReasoning) {
    var body = { model: model, messages: messages, temperature: noReasoning ? 0.4 : 0.6, max_tokens: 16000 };
    var isDeepSeek = model.indexOf('deepseek/') === 0;   // COR-035
    if (!isDeepSeek && !noReasoning) body.reasoning = { effort: 'low' };  // COR-034
    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mediakit.maestrosdaia.com', 'X-Title': 'Midia Kit IA'
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var msg = (j && j.error && (j.error.message || j.error)) || ('HTTP ' + r.status);
          var e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); e.http = r.status; throw e;
        }
        var choice = (j.choices && j.choices[0]) || {};
        var content = choice.message && choice.message.content;
        if (!content || !String(content).trim()) { var ee = new Error('empty'); ee.emptyContent = true; throw ee; }
        return String(content);
      });
    });
  }

  // net: tenta; em conteúdo vazio, re-tenta 1x sem reasoning (COR-035)
  function fetchContent(messages, key, model) {
    return orFetch(messages, key, model, false).catch(function (e) {
      if (e && e.emptyContent) return orFetch(messages, key, model, true);
      throw e;
    });
  }

  // gera + parseia, com reroll 1x em falha de parse (COR-032)
  function generateCopy(d, key, model) {
    return fetchContent(buildMessages(d, false), key, model).then(function (raw) {
      try { return parseJSON(raw); }
      catch (e) {
        return fetchContent(buildMessages(d, true), key, model).then(function (raw2) { return parseJSON(raw2); });
      }
    });
  }

  /* ========================= RENDER DO MÍDIA KIT ========================= */
  function initialOf(name, handle) {
    var s = (name || handle || '?').replace(/^@/, '').trim();
    return (s.charAt(0) || '?').toUpperCase();
  }

  function coverLines(d) {
    // 3 teasers a partir dos números reais do criador (nunca inventados)
    var lines = [];
    var plats = d.plats.slice().sort(function (a, b) {
      return (parseInt(String(b.seguidores).replace(/\D/g, '')) || 0) - (parseInt(String(a.seguidores).replace(/\D/g, '')) || 0);
    });
    plats.forEach(function (p) {
      var f = fmtNum(p.seguidores);
      if (f && lines.length < 3) lines.push({ num: f, label: 'seguidores no ' + (p.rede || 'perfil'), tag: p.rede || '' });
    });
    // completa com engajamento / alcance / entregáveis se faltar
    if (lines.length < 3) {
      var withEng = plats.filter(function (p) { return p.engajamento; })[0];
      if (withEng) lines.push({ num: clean(withEng.engajamento), label: 'de engajamento no ' + (withEng.rede || 'perfil'), tag: 'engajamento' });
    }
    if (lines.length < 3 && d.entregaveis.length) lines.push({ num: String(d.entregaveis.length), label: 'formatos de conteúdo para marcas', tag: 'entregáveis' });
    if (lines.length < 3 && d.marcas.length) lines.push({ num: String(d.marcas.length) + '+', label: 'marcas atendidas', tag: 'portfólio' });
    while (lines.length < 3) lines.push({ num: '—', label: 'preencha seus números na pauta', tag: '' });
    return lines.slice(0, 3);
  }

  function renderKit(d, copy) {
    var kit = $('kit'); kit.innerHTML = '';
    var doc = el('div', 'kit-doc');
    var issue = 'MÍDIA KIT · 2026';

    /* ---- CAPA ---- */
    var cover = el('div', 'cover');
    var block = el('div', 'cover-block');
    var top = el('div', 'cover-top');
    top.appendChild(el('span', null, (d.handle ? d.handle.replace(/^@?/, '@') : 'MÍDIA KIT') ));
    top.appendChild(el('span', null, issue));
    block.appendChild(top);
    var handle = el('div', 'cover-handle', (d.handle || d.nome || 'Seu nome').replace(/^@?/, d.handle ? '@' : ''));
    block.appendChild(handle);
    if (d.nome && d.handle) block.appendChild(el('div', 'cover-name', d.nome));
    var tag = clean(copy.frase_capa) || d.tagline;
    if (tag) block.appendChild(el('div', 'cover-tagline', tag));
    cover.appendChild(block);

    var hero = el('div', 'cover-hero');
    var mono = el('div', 'cover-monogram');
    if (state.logo) { var im = el('img'); im.src = state.logo; im.alt = ''; mono.appendChild(im); }
    else mono.textContent = initialOf(d.nome, d.handle);
    hero.appendChild(mono);
    var nline = el('div', 'cover-nicholine');
    nline.innerHTML = (d.nicho ? '<strong>' + esc(d.nicho) + '</strong>' : '') + (d.local ? (d.nicho ? ' · ' : '') + esc(d.local) : '');
    hero.appendChild(nline);
    cover.appendChild(hero);

    var cl = el('div', 'cover-lines');
    coverLines(d).forEach(function (line) {
      var c = el('div', 'cl');
      if (line.tag) c.appendChild(el('span', 'cl-tag', line.tag));
      c.appendChild(el('div', 'cl-num', line.num));
      c.appendChild(el('div', 'cl-label', line.label));
      cl.appendChild(c);
    });
    cover.appendChild(cl);
    doc.appendChild(cover);

    /* ---- SOBRE + PÚBLICO ---- */
    if (clean(copy.bio_profissional) || d.publico.idade || d.publico.genero || d.publico.local || clean(copy.publico_descricao)) {
      var p1 = page('Sobre', '01');
      if (clean(copy.bio_profissional)) { var lead = el('p', 'lead', copy.bio_profissional); p1.appendChild(lead); }
      var pubItems = [];
      if (d.publico.idade) pubItems.push(d.publico.idade);
      if (d.publico.genero) pubItems.push(d.publico.genero);
      if (d.publico.local) pubItems.push(d.publico.local);
      if (pubItems.length || clean(copy.publico_descricao)) {
        p1.appendChild(subhead('Quem acompanha'));
        if (clean(copy.publico_descricao)) p1.appendChild(el('p', null, copy.publico_descricao));
        if (pubItems.length) {
          var tg = el('div', 'tags'); tg.style.marginTop = '10px';
          pubItems.forEach(function (t) { tg.appendChild(el('span', 'tag', t)); });
          p1.appendChild(tg);
        }
      }
      doc.appendChild(p1);
    }

    /* ---- NÚMEROS ---- */
    if (d.plats.length) {
      var p2 = page('Os números', '02');
      var grid = el('div', 'stat-grid');
      d.plats.forEach(function (p) {
        var card = el('div', 'stat-card');
        card.appendChild(el('div', 'stat-net', p.rede || 'Rede'));
        if (p.handle) card.appendChild(el('div', 'stat-handle', p.handle.replace(/^@?/, '@')));
        var big = fmtNum(p.seguidores);
        card.appendChild(el('div', 'stat-big', big || '—'));
        card.appendChild(el('div', 'stat-sub', 'seguidores'));
        var mini = el('div', 'stat-mini');
        if (clean(p.engajamento)) { var s1 = el('span'); s1.innerHTML = 'Engaj. <b>' + esc(p.engajamento) + '</b>'; mini.appendChild(s1); }
        if (clean(p.alcance)) { var s2 = el('span'); s2.innerHTML = 'Alcance <b>' + esc(p.alcance) + '</b>'; mini.appendChild(s2); }
        if (mini.childNodes.length) card.appendChild(mini);
        grid.appendChild(card);
      });
      p2.appendChild(grid);

      // barras de comparação de seguidores (números reais)
      var withF = d.plats.filter(function (p) { return (parseInt(String(p.seguidores).replace(/\D/g, '')) || 0) > 0; });
      if (withF.length >= 2) {
        p2.appendChild(subhead('Alcance por rede'));
        var maxF = Math.max.apply(null, withF.map(function (p) { return parseInt(String(p.seguidores).replace(/\D/g, '')) || 0; }));
        var bars = el('div', 'bars');
        withF.forEach(function (p) {
          var n = parseInt(String(p.seguidores).replace(/\D/g, '')) || 0;
          var r = el('div', 'bar-row');
          var top2 = el('div', 'bar-top'); top2.appendChild(el('span', null, p.rede || 'Rede'));
          var v = el('span', 'bval', fmtNum(p.seguidores)); top2.appendChild(v);
          var track = el('div', 'bar-track'); var fill = el('div', 'bar-fill'); fill.style.width = Math.max(6, Math.round(n / maxF * 100)) + '%'; track.appendChild(fill);
          r.appendChild(top2); r.appendChild(track); bars.appendChild(r);
        });
        p2.appendChild(bars);
      }
      doc.appendChild(p2);
    }

    /* ---- ENTREGÁVEIS + PORTFÓLIO ---- */
    var motivos = (copy.motivos || []).map(clean).filter(Boolean);
    if (d.entregaveis.length || d.marcas.length || d.resultados || motivos.length) {
      var p3 = page('Entregáveis & portfólio', '03');
      if (d.entregaveis.length) {
        p3.appendChild(subhead('O que eu produzo'));
        var tg2 = el('div', 'tags'); d.entregaveis.forEach(function (t) { tg2.appendChild(el('span', 'tag brandy', t)); });
        p3.appendChild(tg2);
      }
      if (d.marcas.length) {
        p3.appendChild(subhead('Marcas com quem já trabalhei'));
        var tg3 = el('div', 'tags'); d.marcas.forEach(function (t) { tg3.appendChild(el('span', 'tag', t)); });
        p3.appendChild(tg3);
      }
      if (clean(d.resultados)) { p3.appendChild(subhead('Destaques')); p3.appendChild(el('p', null, d.resultados)); }
      if (motivos.length) {
        p3.appendChild(subhead('Por que trabalhar comigo'));
        var ul = el('ul', 'motives'); motivos.forEach(function (m) { ul.appendChild(el('li', null, m)); }); p3.appendChild(ul);
      }
      doc.appendChild(p3);
    }

    /* ---- PACOTES ---- */
    if (d.pkgs.length) {
      var p4 = page('Pacotes & valores', '04');
      var rc = el('div', 'rate-card');
      var mid = d.pkgs.length >= 3 ? 1 : -1;
      d.pkgs.forEach(function (pk, i) {
        var row = el('div', 'rate-row' + (i === mid ? ' featured' : ''));
        var left = el('div');
        var nm = el('div', 'rate-name'); nm.textContent = pk.nome || 'Pacote';
        if (i === mid) { var rb = el('span', 'rate-ribbon', 'Recomendado'); nm.appendChild(rb); }
        left.appendChild(nm);
        var desc = clean((copy.pacotes_desc || [])[i]) || clean(pk.inclui);
        if (desc) left.appendChild(el('div', 'rate-inc', desc));
        else if (clean(pk.inclui)) left.appendChild(el('div', 'rate-inc', pk.inclui));
        row.appendChild(left);
        var price = clean(pk.preco);
        row.appendChild(el('div', 'rate-price', price ? ('R$ ' + price.replace(/^R\$\s*/i, '')) : 'sob consulta'));
        rc.appendChild(row);
      });
      p4.appendChild(rc);
      doc.appendChild(p4);
    }

    /* ---- DEPOIMENTOS + CONTATO ---- */
    var p5 = page('Vamos trabalhar juntos', '05');
    if (d.deps.length) {
      p5.appendChild(subhead('O que dizem'));
      d.deps.forEach(function (q) {
        var blk = el('div', 'quote'); blk.appendChild(el('p', null, '“' + q.texto + '”'));
        if (clean(q.autor)) blk.appendChild(el('cite', null, '— ' + q.autor));
        p5.appendChild(blk);
      });
    }
    var hasContact = d.contato.email || d.contato.whats || d.contato.site;
    if (hasContact) {
      p5.appendChild(subhead('Contato'));
      var cg = el('div', 'contact-grid');
      [['E-mail', d.contato.email], ['WhatsApp', d.contato.whats], ['Site / link', d.contato.site]].forEach(function (c) {
        if (!clean(c[1])) return;
        var it = el('div', 'contact-item'); it.appendChild(el('div', 'ci-label', c[0])); it.appendChild(el('div', 'ci-val', c[1])); cg.appendChild(it);
      });
      p5.appendChild(cg);
    }
    var plate = el('div', 'cta-plate');
    plate.appendChild(el('div', 'cta-title', 'Bora criar?'));
    plate.appendChild(el('p', null, clean(copy.fecho) || 'Entre em contato e vamos montar a campanha perfeita para a sua marca.'));
    p5.appendChild(plate);
    doc.appendChild(p5);

    doc.appendChild(el('div', 'kit-foot', 'MÍDIA KIT · 2026 · ' + (d.handle ? d.handle.replace(/^@?/, '@') + ' · ' : '') + 'feito com Mídia Kit IA · Maestros da IA'));

    kit.appendChild(doc);
  }
  function page(title, num) {
    var p = el('div', 'page');
    var h = el('div', 'page-head'); h.appendChild(el('h3', null, title)); h.appendChild(el('span', 'pg-num', num)); p.appendChild(h);
    return p;
  }
  function subhead(txt) { var s = el('p'); s.style.cssText = 'font-weight:800;color:var(--text);margin:18px 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;'; s.textContent = txt; return s; }

  /* ========================= EXPORTS ========================= */
  function currentData() { return normalize(collectBrief(true)); }

  function exportHTML() {
    var kit = $('kit .kit-doc') || document.querySelector('#kit .kit-doc');
    if (!kit) return;
    var brand = ($('f-cor') || {}).value || '#d81b60';
    var css = kitExportCSS(brand);
    var handle = (currentData().handle || 'midia-kit').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'midia-kit';
    var html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<title>Mídia Kit — ' + esc(currentData().nome || currentData().handle || '') + '</title><style>' + css + '</style></head>' +
      '<body><div class="wrap">' + kit.outerHTML + '</div></body></html>';
    download(new Blob([html], { type: 'text/html;charset=utf-8' }), 'midia-kit-' + handle + '.html');
  }

  function kitExportCSS(brand) {
    // CSS autocontido para o HTML exportado — fontes de SISTEMA (export-safe, COR-045)
    return [
      ':root{--brand:' + brand + '}',
      '*{box-sizing:border-box;margin:0;padding:0}',
      'body{background:#ece7dc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#16140f;line-height:1.55;padding:24px}',
      '.wrap{max-width:820px;margin:0 auto}',
      '.kit-doc{display:flex;flex-direction:column;gap:22px}',
      '.cover,.page{background:#fff;border:1px solid #e3dccd;border-radius:4px;box-shadow:0 20px 50px -30px rgba(22,20,15,.4);overflow:hidden}',
      '.page{padding:34px 38px}',
      '.cover-block{background:var(--brand);color:#fff;padding:26px 34px 22px}',
      '.cover-top{display:flex;justify-content:space-between;font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.14em;color:rgba(255,255,255,.85)}',
      '.cover-handle{font-family:"Arial Narrow",Arial,sans-serif;font-weight:700;text-transform:uppercase;font-size:56px;line-height:.92;margin:10px 0 6px;word-break:break-word}',
      '.cover-name{font-size:18px;font-weight:700}.cover-tagline{margin-top:6px;font-size:15px;color:rgba(255,255,255,.92)}',
      '.cover-hero{display:flex;align-items:center;gap:18px;padding:22px 34px;border-bottom:1px solid #e3dccd}',
      '.cover-monogram{flex:none;width:92px;height:92px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-family:"Arial Narrow",Arial;font-weight:700;font-size:44px;overflow:hidden}',
      '.cover-monogram img{width:100%;height:100%;object-fit:cover}',
      '.cover-nicholine{font-size:14px;color:#5c564a}.cover-nicholine strong{color:#16140f}',
      '.cover-lines{display:grid;grid-template-columns:repeat(3,1fr)}',
      '.cl{padding:20px;border-right:1px solid #e3dccd}.cl:last-child{border-right:none}',
      '.cl-tag{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--brand);margin-bottom:4px}',
      '.cl-num{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:34px;letter-spacing:-.02em}.cl-label{font-size:12px;color:#5c564a;margin-top:4px}',
      '.page-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #16140f;padding-bottom:10px;margin-bottom:18px}',
      '.page-head h3{font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.pg-num{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#8a8372}',
      '.page p{color:#5c564a;line-height:1.6}.page p.lead{color:#16140f;font-size:17px}',
      '.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}',
      '.stat-card{border:1px solid #e3dccd;border-top:3px solid var(--brand);border-radius:4px;padding:16px}',
      '.stat-net{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.stat-handle{font-size:12px;color:#8a8372;font-family:ui-monospace,Menlo,monospace;margin-bottom:8px}',
      '.stat-big{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:30px;line-height:1}.stat-sub{font-size:12px;color:#5c564a;margin-top:6px}',
      '.stat-mini{display:flex;gap:14px;margin-top:8px}.stat-mini span{font-size:11px;color:#5c564a}.stat-mini b{font-family:ui-monospace,Menlo,monospace;color:#16140f}',
      '.bars{display:flex;flex-direction:column;gap:12px}.bar-top{display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px}.bar-top .bval{font-family:ui-monospace,Menlo,monospace;font-weight:700}',
      '.bar-track{height:10px;background:#f4f1ea;border:1px solid #e3dccd;border-radius:100px;overflow:hidden}.bar-fill{height:100%;background:var(--brand)}',
      '.tags{display:flex;flex-wrap:wrap;gap:8px}.tag{padding:6px 12px;font-size:13px;font-weight:600;background:#f4f1ea;border:1px solid #e3dccd;border-radius:100px}.tag.brandy{border-color:var(--brand)}',
      '.motives{list-style:none;display:flex;flex-direction:column;gap:10px;margin-top:6px}.motives li{display:flex;gap:10px;font-size:15px;color:#16140f}.motives li:before{content:"▸";color:var(--brand);font-weight:800}',
      '.rate-card{display:flex;flex-direction:column}.rate-row{display:grid;grid-template-columns:1fr auto;align-items:end;gap:10px;padding:14px 0;border-bottom:1px solid #e3dccd}.rate-row:last-child{border-bottom:none}',
      '.rate-row.featured{background:#f4f1ea;padding:14px;border-radius:4px}.rate-name{font-size:16px;font-weight:800}.rate-inc{font-size:13px;color:#5c564a;margin-top:3px}.rate-price{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:20px;white-space:nowrap}',
      '.rate-ribbon{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:#a9864f;padding:2px 8px;border-radius:3px;margin-left:8px}',
      '.quote{border-left:3px solid var(--brand);padding:4px 0 4px 16px;margin-bottom:16px}.quote p{font-size:15px;font-style:italic}.quote cite{display:block;margin-top:6px;font-size:13px;color:#5c564a;font-style:normal;font-weight:700}',
      '.contact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}.ci-label{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8a8372}.ci-val{font-size:16px;font-weight:700;word-break:break-word}',
      '.cta-plate{margin-top:20px;background:var(--brand);color:#fff;border-radius:4px;padding:22px;text-align:center}.cta-title{font-family:"Arial Narrow",Arial;font-weight:700;text-transform:uppercase;font-size:26px}.cta-plate p{color:rgba(255,255,255,.92);margin-top:4px}',
      '.kit-foot{text-align:center;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#8a8372;letter-spacing:.08em;padding:4px}',
      '.subh{font-weight:800;margin:18px 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase}',
      '@media(max-width:600px){.cover-lines{grid-template-columns:1fr}.cl{border-right:none;border-bottom:1px solid #e3dccd}}'
    ].join('');
  }

  function exportPNG() {
    var d = currentData();
    var brand = d.cor || '#d81b60';
    var W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    // bloco de capa na cor da marca
    var blockH = 560; ctx.fillStyle = brand; ctx.fillRect(0, 0, W, blockH);
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = '600 26px ui-monospace, Menlo, monospace';
    ctx.fillText('MÍDIA KIT · 2026', 70, 90);
    ctx.textAlign = 'right'; ctx.fillText((d.handle ? d.handle.replace(/^@?/, '@') : ''), W - 70, 90); ctx.textAlign = 'left';
    // handle grande
    ctx.fillStyle = '#ffffff'; ctx.font = '700 120px "Arial Narrow", Impact, Arial, sans-serif';
    var big = (d.handle || d.nome || 'MÍDIA KIT').replace(/^@?/, d.handle ? '@' : '').toUpperCase();
    wrapText(ctx, big, 70, 240, W - 140, 112);
    if (d.nome && d.handle) { ctx.font = '700 40px Arial, sans-serif'; ctx.fillText(d.nome, 70, blockH - 110); }
    ctx.font = '400 30px Arial, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.92)';
    var tagline = (state.copy && state.copy.frase_capa) || d.tagline || '';
    if (tagline) wrapText(ctx, tagline, 70, blockH - 60, W - 140, 38);
    // monograma / logo
    var cx = W - 170, cy = blockH + 10, rr = 100;
    function drawInitial() {
      ctx.fillStyle = brand; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '700 96px "Arial Narrow", Impact, Arial'; ctx.fillText(initialOf(d.nome, d.handle), cx, cy + 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    // nicho line
    ctx.fillStyle = '#16140f'; ctx.font = '700 40px Arial, sans-serif';
    if (d.nicho) ctx.fillText(d.nicho, 70, blockH + 60);
    ctx.fillStyle = '#5c564a'; ctx.font = '400 30px Arial, sans-serif';
    if (d.local) ctx.fillText(d.local, 70, blockH + 104);
    // cover lines (stats)
    var lines = coverLines(d), y0 = blockH + 190;
    lines.forEach(function (ln, i) {
      var y = y0 + i * 150;
      ctx.fillStyle = brand; ctx.font = '800 22px Arial'; ctx.fillText((ln.tag || '').toUpperCase(), 70, y - 44);
      ctx.fillStyle = '#16140f'; ctx.font = '700 86px ui-monospace, Menlo, monospace'; ctx.fillText(ln.num, 70, y + 36);
      ctx.fillStyle = '#5c564a'; ctx.font = '400 30px Arial'; ctx.fillText(ln.label, 70, y + 78);
      ctx.strokeStyle = '#e3dccd'; ctx.beginPath(); ctx.moveTo(70, y + 100); ctx.lineTo(W - 70, y + 100); ctx.stroke();
    });
    // rodapé
    ctx.fillStyle = '#8a8372'; ctx.font = '600 24px ui-monospace, Menlo, monospace';
    ctx.fillText('feito com Mídia Kit IA · Maestros da IA', 70, H - 50);

    var handle = (d.handle || 'midia-kit').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'midia-kit';
    function finish() { cv.toBlob(function (b) { if (b) download(b, 'capa-midia-kit-' + handle + '.png'); }, 'image/png'); }
    if (state.logo) {
      var im = new Image();
      im.onload = function () { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(im, cx - rr, cy - rr, rr * 2, rr * 2); ctx.restore(); ctx.strokeStyle = brand; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke(); finish(); };
      im.onerror = function () { drawInitial(); finish(); };
      im.src = state.logo;
    } else { drawInitial(); finish(); }
  }
  function wrapText(ctx, text, x, y, maxW, lh) {
    var words = String(text).split(' '), line = '', yy = y;
    for (var i = 0; i < words.length; i++) {
      var test = line + words[i] + ' ';
      if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line.trim(), x, yy); line = words[i] + ' '; yy += lh; }
      else line = test;
    }
    ctx.fillText(line.trim(), x, yy);
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function copyText() {
    var d = currentData(), c = state.copy || {};
    var L = [];
    L.push('MÍDIA KIT — ' + (d.nome || d.handle || ''));
    if (d.handle) L.push(d.handle.replace(/^@?/, '@'));
    if (d.nicho) L.push(d.nicho + (d.local ? ' · ' + d.local : ''));
    if (clean(c.frase_capa) || d.tagline) L.push('\n' + (clean(c.frase_capa) || d.tagline));
    if (clean(c.bio_profissional)) L.push('\nSOBRE\n' + c.bio_profissional);
    if (d.plats.length) { L.push('\nNÚMEROS'); d.plats.forEach(function (p) { L.push('• ' + (p.rede || '') + (p.handle ? ' ' + p.handle : '') + ': ' + (fmtNum(p.seguidores) || '—') + ' seguidores' + (clean(p.engajamento) ? ', ' + p.engajamento + ' engaj.' : '')); }); }
    if (clean(c.publico_descricao)) L.push('\nPÚBLICO\n' + c.publico_descricao);
    if (d.entregaveis.length) L.push('\nENTREGÁVEIS\n' + d.entregaveis.join(', '));
    if (d.marcas.length) L.push('\nMARCAS\n' + d.marcas.join(', '));
    if ((c.motivos || []).length) { L.push('\nPOR QUE TRABALHAR COMIGO'); c.motivos.map(clean).filter(Boolean).forEach(function (m) { L.push('• ' + m); }); }
    if (d.pkgs.length) { L.push('\nPACOTES'); d.pkgs.forEach(function (p, i) { L.push('• ' + (p.nome || 'Pacote') + ': ' + (clean(p.preco) ? 'R$ ' + p.preco.replace(/^R\$\s*/i, '') : 'sob consulta') + (clean((c.pacotes_desc || [])[i]) ? ' — ' + c.pacotes_desc[i] : (clean(p.inclui) ? ' — ' + p.inclui : ''))); }); }
    if (d.contato.email || d.contato.whats || d.contato.site) { L.push('\nCONTATO'); if (d.contato.email) L.push('E-mail: ' + d.contato.email); if (d.contato.whats) L.push('WhatsApp: ' + d.contato.whats); if (d.contato.site) L.push('Link: ' + d.contato.site); }
    if (clean(c.fecho)) L.push('\n' + c.fecho);
    var txt = L.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { flash('btn-copy', 'Copiado!'); }).catch(function () { legacyCopy(txt); });
    } else legacyCopy(txt);
  }
  function legacyCopy(txt) {
    var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); flash('btn-copy', 'Copiado!'); } catch (e) {} ta.remove();
  }
  function flash(id, msg) { var b = $(id); if (!b) return; var old = b.textContent; b.textContent = msg; setTimeout(function () { b.textContent = old; }, 1400); }

  function enableExports(on) {
    ['btn-pdf', 'btn-html', 'btn-png', 'btn-copy'].forEach(function (id) { var b = $(id); if (b) b.disabled = !on; });
  }

  /* ========================= GERAR ========================= */
  function doGenerate() {
    var active = window.ApiKeyManager && ApiKeyManager.getActiveKey ? ApiKeyManager.getActiveKey() : null;
    if (!active || !active.key) { toast('Conecte sua chave da OpenRouter primeiro (ícone de chave no topo).', 'err'); return; }
    var d = normalize(collectBrief(true));
    if (!d.nome && !d.handle) { toast('Informe pelo menos seu nome ou @ na seção 01.', 'err'); return; }
    if (!d.plats.length && !d.bio) { toast('Adicione ao menos uma plataforma (02) ou um texto em "Sobre" (04).', 'err'); return; }

    var btn = $('btn-generate'); btn.classList.add('is-loading'); btn.disabled = true;
    toast('Escrevendo os textos do seu mídia kit…', 'work');
    var model = ApiKeyManager.getModel();

    function run() { return generateCopy(d, active.key, model); }
    var p = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('generate', run) : run();
    Promise.resolve(p).then(function (copy) {
      if (!copy) { throw new Error('limite'); }   // rate-limiter devolveu null
      state.copy = copy;
      renderKit(d, copy);
      enableExports(true);
      toast('Pronto! Seu mídia kit está à direita. Baixe em PDF, HTML, PNG ou copie o texto.', 'ok');
    }).catch(function (e) {
      var msg = (e && e.message) || 'erro';
      if (/limite/i.test(msg)) toast('Você atingiu o limite de requisições. Aguarde um instante e tente de novo.', 'err');
      else if (e && e.http === 401) toast('Chave da OpenRouter inválida. Verifique no ícone de chave.', 'err');
      else if (e && (e.http === 402 || /credit|insufficient|balance/i.test(msg))) toast('Sua conta OpenRouter está sem créditos. Adicione créditos e tente de novo.', 'err');
      else if (/json/i.test(msg)) toast('O modelo não devolveu um JSON válido desta vez. Tente gerar de novo ou troque o modelo.', 'err');
      else toast('Não consegui gerar agora: ' + msg + '. Tente de novo.', 'err');
    }).then(function () { btn.classList.remove('is-loading'); btn.disabled = false; });
  }

  /* ========================= WIRE ========================= */
  function wire() {
    if (_wired) return; _wired = true;

    // saudação
    var session = window.MembershipGate ? MembershipGate.getSession() : null;
    if (session) {
      var nm = (session.name || session.display_name || '').split(' ')[0];
      if (nm && $('f-nome') && !$('f-nome').value) $('f-nome').value = '';  // não preenche automaticamente (é o criador, não o membro)
    }

    // modelo (COR-041): estúdio
    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select');

    renderChips();
    buildRep('plats-list', [{}], platFields);
    buildRep('pkgs-list', [{}, {}], pkgFields);
    buildRep('deps-list', [], depFields);
    restoreDraft();

    // cor
    var cor = $('f-cor'); if (cor) { applyBrand(cor.value); cor.addEventListener('input', function () { applyBrand(cor.value); scheduleSave(); }); }
    // logo
    var logo = $('f-logo'); if (logo) logo.addEventListener('change', function () { if (logo.files && logo.files[0]) handleLogo(logo.files[0]); });
    var lrem = $('logo-remove'); if (lrem) lrem.addEventListener('click', function () { state.logo = ''; showLogo(''); if ($('f-logo')) $('f-logo').value = ''; scheduleSave(); });

    // adicionar linhas
    var ap = $('add-plat'); if (ap) ap.addEventListener('click', function () { addRepRow('plats-list', platFields, {}); scheduleSave(); });
    var ak = $('add-pkg'); if (ak) ak.addEventListener('click', function () { addRepRow('pkgs-list', pkgFields, {}); scheduleSave(); });
    var ad = $('add-dep'); if (ad) ad.addEventListener('click', function () { addRepRow('deps-list', depFields, {}); scheduleSave(); });

    // salvar rascunho em qualquer input
    var brief = document.querySelector('.brief'); if (brief) { brief.addEventListener('input', scheduleSave); }

    // gerar + exports
    var g = $('btn-generate'); if (g) g.addEventListener('click', doGenerate);
    var bp = $('btn-pdf'); if (bp) bp.addEventListener('click', function () { window.print(); });
    var bh = $('btn-html'); if (bh) bh.addEventListener('click', exportHTML);
    var bn = $('btn-png'); if (bn) bn.addEventListener('click', exportPNG);
    var bc = $('btn-copy'); if (bc) bc.addEventListener('click', copyText);

    // logout limpa o formulário do gate (COR-062)
    var lo = $('logout-btn'); if (lo) lo.addEventListener('click', function () {
      ['gate-email', 'gate-phone'].forEach(function (id) { if ($(id)) $(id).value = ''; });
      var ge = $('gate-error'); if (ge) { ge.textContent = ''; ge.classList.remove('show'); }
    });
  }

  return { wire: wire };
})();

/* init: 3 gatilhos idempotentes (COR-044) — evento do gate, DOMContentLoaded já-ativo,
   e um MutationObserver em #app-screen.class (o gate unificado nem sempre dispara o evento
   no caminho chave→"abrir estúdio"). wire() é idempotente. */
(function () {
  function tryWire() {
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) App.wire();
  }
  document.addEventListener('maestria:app-ready', function () { App.wire(); });
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(tryWire, 150);
    var app = document.getElementById('app-screen');
    if (app) {
      var obs = new MutationObserver(function () { if (app.classList.contains('active')) App.wire(); });
      obs.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();
