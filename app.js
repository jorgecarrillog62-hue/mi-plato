'use strict';
// Mi Plato: registro de comidas con IA, resumen del día y peso. Todo se guarda en este teléfono (localStorage).
const K = 'plato-v1', VERSION = '1.0.0', MODEL = 'claude-haiku-5-5';
const GOAL = { kcal: 1900, prot: 160 }; // día base del plan (sección 5)

// Alimentos del plan con sus números tal cual vienen en el plan: [descripción de la porción, kcal, proteína g]
const PLAN = {
  desayuno_base: ['Desayuno base: 250 g yogur griego natural sin azúcar + 30 g granola baja en azúcar + 1 plátano mediano (o 1 taza de fresas)', 410, 22],
  comida_pollo: ['Comida base: 200 g pollo cocido (pechuga y muslo sin piel) + 300 g papa cocida + 200 g verduras + 1 cdita aceite', 700, 66],
  comida_atun: ['Comida con atún: 1 lata atún en agua + 2 huevos duros + 300 g papa + 200 g verduras + 1 cdita aceite', 600, 47],
  comida_sin_papa: ['Comida de día flex: 200 g pollo + 200 g verduras + 1 cdita aceite, sin papa ni tortillas', 470, 60],
  snack_leche_whey: ['Snack: 300 ml leche light + 1 scoop (30 g) proteína whey', 230, 33],
  cena_base: ['Cena base: 3 tortillas de maíz + 2 huevos + 4 claras revueltos + ½ taza frijoles de olla + 40 g aguacate + salsa', 570, 39],
  cena_ligera: ['Cena ligera: 2 huevos + 4 claras + verduras', 250, 28],
  huevo: ['Huevo entero, 2 piezas', 145, 13],
  claras: ['Claras de huevo, 4 claras (~130 g)', 70, 14],
  frijoles: ['Frijoles de olla, ½ taza (~90 g)', 100, 6.5],
  tortillas: ['Tortilla de maíz, 3 piezas (~90 g)', 195, 5],
  avena: ['Avena, 40 g en crudo', 150, 5],
  cottage: ['Queso cottage, 200 g', 180, 22],
  panela: ['Queso panela, 60 g', 150, 11],
  arroz: ['Arroz blanco cocido, 150 g', 195, 4],
  leche_light: ['Leche light (deslactosada light), 250 ml', 91, 7.8],
  yogur_oikos: ['Yogur griego Oikos natural sin azúcar, 100 g', 69, 7],
  atun_dolores_premium: ['Atún Dolores Premium en agua, 100 g', 116, 26.7],
  atun_tuny: ['Atún Tuny en agua, 100 g', 93, 21],
};

const SYSTEM = `Eres un registro de comidas para un hombre mexicano en Monterrey. Recibes lo que comió en español informal (puede venir de dictado por voz, con errores). Devuelve cada alimento por separado.

Reglas:
- Si un alimento o comida coincide con uno de la lista del plan (mismo alimento y preparación), pon su plan_id y en "porciones" cuántas veces la porción del plan comió (ej. "3 huevos" con huevo = 2 piezas → 1.5). Si dice que comió una comida completa del plan ("mi desayuno de siempre", "la comida de pollo con papa"), usa la comida completa.
- Si no coincide, plan_id = "" y estima kcal y proteína con porciones típicas de México.
- Siempre estima carbohidratos y grasa en gramos.
- Si no dice cantidad, asume una porción típica y escríbelo en "cantidad", por ejemplo "1 pieza mediana (supuesto)".
- "cantidad" en texto corto y claro. "nombre" corto, en español.
- En "nota" pon una frase breve solo si algo es ambiguo; si no, cadena vacía.

Alimentos del plan (plan_id: porción → kcal, proteína):
${Object.entries(PLAN).map(([id, p]) => `${id}: ${p[0]} → ${p[1]} kcal, ${p[2]} g`).join('\n')}

Referencias del plan (no tienen plan_id, úsalas para estimar): verduras congeladas 200 g ≈ 70–100 kcal y 3–4 g de proteína; fruta 1 pieza ≈ 60–105 kcal y 1 g; salida a restaurante ≈ 900–1,100 kcal.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items', 'nota'],
  properties: {
    nota: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['nombre', 'cantidad', 'plan_id', 'porciones', 'kcal', 'proteina', 'carbohidratos', 'grasa'],
        properties: {
          nombre: { type: 'string' }, cantidad: { type: 'string' },
          plan_id: { type: 'string', enum: ['', ...Object.keys(PLAN)] },
          porciones: { type: 'number' }, kcal: { type: 'number' }, proteina: { type: 'number' },
          carbohidratos: { type: 'number' }, grasa: { type: 'number' },
        },
      },
    },
  },
};

// ---------- utilidades ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dstr = d => d.toLocaleDateString('en-CA'); // AAAA-MM-DD en hora local
const today = () => dstr(new Date());
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
const fmt = n => Math.round(n).toLocaleString('es-MX');
const num = s => parseFloat(String(s).replace(',', '.'));

function load() { let d; try { d = JSON.parse(localStorage.getItem(K)); } catch { } return Object.assign({ meals: [], weights: [], apiKey: '' }, d || {}); }
function save() {
  try { localStorage.setItem(K, JSON.stringify(S)); }
  catch (e) { alert('No se pudo guardar en el teléfono (' + e.message + '). Exporta tus datos desde Ajustes.'); }
}
let S = load();

// ---------- lógica pura (probada en runTests) ----------
function toItems(raw) {
  return raw.map(it => {
    const p = PLAN[it.plan_id], n = it.porciones > 0 ? it.porciones : 1;
    return {
      nombre: it.nombre, cantidad: it.cantidad, fuente: p ? 'plan' : 'estimado',
      kcal: Math.round(p ? p[1] * n : it.kcal), prot: r1(p ? p[2] * n : it.proteina),
      carb: r1(it.carbohidratos), grasa: r1(it.grasa),
    };
  });
}
function totals(meals, date) {
  const t = { kcal: 0, prot: 0, carb: 0, grasa: 0 };
  for (const m of meals) if (m.status === 'ok' && m.date === date) for (const i of m.items) for (const k in t) t[k] += i[k] || 0;
  return t;
}
function weekStart(s) { const d = parseD(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return dstr(d); } // lunes
function weekStats(weights, ref) {
  const ws = weekStart(ref), p = parseD(ws); p.setDate(p.getDate() - 7);
  const avg = a => a.length ? a.reduce((s, w) => s + w.kg, 0) / a.length : null;
  const cur = weights.filter(w => weekStart(w.date) === ws), prev = weights.filter(w => weekStart(w.date) === dstr(p));
  return { cur: avg(cur), curN: cur.length, prev: avg(prev), prevN: prev.length };
}
function rolling(weights) { // promedio de los pesajes de los 7 días que terminan en cada fecha
  return weights.map(w => {
    const end = parseD(w.date), start = new Date(end); start.setDate(start.getDate() - 6);
    const win = weights.filter(x => { const d = parseD(x.date); return d >= start && d <= end; });
    return { date: w.date, kg: win.reduce((s, x) => s + x.kg, 0) / win.length };
  });
}

// ---------- IA ----------
function fail(msg, retry) { return Object.assign(new Error(msg), { retry }); }
async function interpret(text) {
  if (!S.apiKey) throw fail('Falta tu API key. Ponla en Ajustes.', false);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': S.apiKey, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // llamada directa desde el teléfono, sin servidor
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, system: SYSTEM,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: text }],
      }),
    });
  } catch { throw fail('Sin conexión. Se procesa cuando vuelva el internet.', true); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw fail('La API key no es válida. Revísala en Ajustes.', false);
    throw fail(`Error ${res.status}: ${body.error?.message || res.statusText}`, res.status === 429 || res.status >= 500);
  }
  if (body.stop_reason !== 'end_turn') throw fail('La IA no pudo responder (' + body.stop_reason + '). Prueba a escribirlo distinto.', false);
  const t = (body.content || []).find(b => b.type === 'text');
  try { return JSON.parse(t.text); } catch { throw fail('Respuesta de la IA ilegible. Reintenta.', false); }
}

const busy = new Set();
async function processPending() {
  for (const m of S.meals.filter(m => m.status === 'pending' && !busy.has(m.id))) {
    if (!navigator.onLine) { m.error = 'Sin conexión. Se procesa cuando vuelva el internet.'; save(); renderHoy(); return; }
    busy.add(m.id); renderHoy();
    try {
      const out = await interpret(m.text);
      m.items = toItems(out.items); m.nota = out.nota || ''; m.status = 'draft'; m.error = '';
    } catch (e) { m.error = e.message; if (!e.retry) m.status = 'error'; }
    busy.delete(m.id); save(); renderHoy();
  }
}

// ---------- pantalla Hoy ----------
function bar(val, goal, cls) { return `<div class="bar ${cls}"><i style="width:${Math.min(100, val / goal * 100)}%"></i></div>`; }
function left(val, goal, unit) {
  const d = goal - val;
  return d >= 0 ? `Te faltan <b>${fmt(d)} ${unit}</b>` : `Llevas ${fmt(-d)} ${unit} arriba de la meta`;
}
function buildHoy() {
  $('#v-hoy').innerHTML = `
    <h1 id="fecha"></h1>
    <div class="card" id="sum"></div>
    <div id="drafts" style="display:grid;gap:14px"></div>
    <div class="card">
      <h2>¿Qué comiste?</h2>
      <textarea id="txt" placeholder="Ej. dos muslos de pollo y una papa" enterkeyhint="send"></textarea>
      <p class="small muted" style="margin:6px 0 10px">Toca el micrófono 🎤 de tu teclado para dictarlo.</p>
      <button class="primary full" data-act="add">Registrar</button>
    </div>
    <div class="card" id="list"></div>`;
}
function renderHoy() {
  const d = today(), t = totals(S.meals, d);
  $('#fecha').textContent = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#sum').innerHTML = `
    <div class="row between"><span>Calorías</span><span class="big">${fmt(t.kcal)} <span class="small muted">/ ${fmt(GOAL.kcal)}</span></span></div>
    ${bar(t.kcal, GOAL.kcal, '')}<div class="small muted">${left(t.kcal, GOAL.kcal, 'kcal')}</div>
    <div class="row between" style="margin-top:12px"><span>Proteína</span><span class="big">${fmt(t.prot)} g <span class="small muted">/ ${GOAL.prot} g</span></span></div>
    ${bar(t.prot, GOAL.prot, 'prot')}<div class="small muted">${left(t.prot, GOAL.prot, 'g de proteína')}</div>
    <div class="small muted" style="margin-top:10px">Carbohidratos ≈ ${fmt(t.carb)} g · Grasa ≈ ${fmt(t.grasa)} g</div>`;

  $('#drafts').innerHTML = S.meals.filter(m => m.status !== 'ok').map(m => {
    if (m.status === 'draft') return `<div class="card">
      <h2>Confirma</h2><div class="small muted">“${esc(m.text)}”</div>
      <div class="item small muted" style="border:0"><span></span><span style="text-align:right">kcal</span><span style="text-align:right">prot g</span><span></span></div>
      ${m.items.map((i, n) => `<div class="item">
        <div><div>${esc(i.nombre)}</div><div class="small muted">${esc(i.cantidad)} <span class="badge ${i.fuente === 'plan' ? '' : 'est'}">${i.fuente === 'plan' ? 'del plan' : 'estimado'}</span></div></div>
        <input inputmode="decimal" value="${i.kcal}" data-edit="${m.id}" data-i="${n}" data-f="kcal" aria-label="kcal de ${esc(i.nombre)}">
        <input inputmode="decimal" value="${i.prot}" data-edit="${m.id}" data-i="${n}" data-f="prot" aria-label="proteína de ${esc(i.nombre)}">
        <button data-act="rmitem" data-id="${m.id}" data-i="${n}" aria-label="Quitar ${esc(i.nombre)}">✕</button></div>`).join('')}
      ${m.nota ? `<p class="small muted">${esc(m.nota)}</p>` : ''}
      <div class="row" style="margin-top:10px"><button class="primary" style="flex:1" data-act="ok" data-id="${m.id}">✓ Confirmar</button>
      <button data-act="redo" data-id="${m.id}">Corregir texto</button></div></div>`;
    const working = busy.has(m.id);
    return `<div class="card"><div>“${esc(m.text)}”</div>
      <p class="small ${m.status === 'error' ? 'err' : 'muted'}">${working ? 'Interpretando…' : esc(m.error || 'Pendiente')}</p>
      <div class="row"><button data-act="retry" data-id="${m.id}" ${working ? 'disabled' : ''}>Reintentar</button>
      <button data-act="redo" data-id="${m.id}" ${working ? 'disabled' : ''}>Corregir texto</button>
      <button class="link" data-act="del" data-id="${m.id}" ${working ? 'disabled' : ''}>Borrar</button></div></div>`;
  }).join('');

  const done = S.meals.filter(m => m.status === 'ok' && m.date === d);
  $('#list').innerHTML = `<h2>Registrado hoy</h2>` + (done.length ? done.map(m => {
    const tt = totals([m], d);
    return `<div class="meal row between"><div><div>${esc(m.items.map(i => i.nombre).join(', '))}</div>
      <div class="small muted">${new Date(m.ts).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' })} · ${fmt(tt.kcal)} kcal · ${fmt(tt.prot)} g prot${m.items.some(i => i.fuente !== 'plan') ? ' · incluye estimación' : ''}</div></div>
      <button class="link" data-act="del" data-id="${m.id}" aria-label="Borrar">✕</button></div>`;
  }).join('') : '<p class="muted small">Todavía nada.</p>');
}

// ---------- pantalla Peso ----------
function chart(weights) {
  const from = new Date(); from.setDate(from.getDate() - 55);
  const pts = weights.filter(w => parseD(w.date) >= from);
  if (pts.length < 2) return '<p class="small muted">La gráfica aparece con 2 pesajes o más.</p>';
  const avg = rolling(weights).filter(w => parseD(w.date) >= from); // el promedio usa también pesajes previos a la ventana
  const kgs = pts.map(p => p.kg), lo = Math.min(...kgs) - 0.5, hi = Math.max(...kgs) + 0.5;
  const x0 = parseD(pts[0].date), span = Math.max(1, (parseD(today()) - x0) / 864e5);
  const W = 320, H = 150, x = s => 8 + (parseD(s) - x0) / 864e5 / span * (W - 16), y = k => 8 + (hi - k) / (hi - lo) * (H - 24);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tendencia de peso, últimas 8 semanas">
    <text x="4" y="${H - 2}" font-size="10" fill="var(--muted)">${lo.toFixed(1)}–${hi.toFixed(1)} kg · últimos ${Math.round(span) + 1} días</text>
    ${pts.map(p => `<circle cx="${x(p.date)}" cy="${y(p.kg)}" r="3" fill="var(--muted)" opacity=".55"/>`).join('')}
    <polyline fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" points="${avg.map(p => `${x(p.date)},${y(p.kg)}`).join(' ')}"/>
  </svg><p class="small muted">Puntos: cada pesaje. Línea: promedio de 7 días.</p>`;
}
function renderPeso() {
  const ws = S.weights, last = ws[ws.length - 1], st = weekStats(ws, today()), hoy = ws.find(w => w.date === today());
  const diff = st.cur != null && st.prev != null ? st.cur - st.prev : null;
  $('#v-peso').innerHTML = `
    <h1>Peso</h1>
    <div class="card">
      <h2>${hoy ? 'Hoy ya registraste ' + hoy.kg + ' kg' : 'Pesaje de hoy'}</h2>
      <div class="row"><input id="kg" inputmode="decimal" value="${last ? last.kg : ''}" aria-label="Peso en kg" style="font-size:24px;text-align:center">
      <button class="primary" data-act="kg" style="min-width:120px">Guardar</button></div>
      <p class="small muted" style="margin:8px 0 0">En la mañana, después del baño y antes de comer.</p>
    </div>
    <div class="card">
      <h2>Promedio semanal (lunes a domingo)</h2>
      <div class="row between"><span>Esta semana</span><span class="big">${st.cur != null ? st.cur.toFixed(1) + ' kg' : '—'}</span></div>
      <div class="small muted">${st.curN} pesaje(s)</div>
      <div class="row between" style="margin-top:8px"><span>Semana pasada</span><span>${st.prev != null ? st.prev.toFixed(1) + ' kg' : '—'}</span></div>
      ${diff != null ? `<p style="margin:8px 0 0">Cambio: <b>${diff > 0 ? '+' : ''}${diff.toFixed(1)} kg</b></p>` : ''}
    </div>
    <div class="card"><h2>Tendencia</h2>${chart(ws)}</div>
    <div class="card"><h2>Últimos pesajes</h2>${ws.slice(-10).reverse().map(w => `<div class="meal row between"><span>${parseD(w.date).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })}</span><span>${w.kg} kg <button class="link" data-act="delkg" data-d="${w.date}" aria-label="Borrar">✕</button></span></div>`).join('') || '<p class="small muted">Sin pesajes.</p>'}</div>`;
}

// ---------- pantalla Ajustes ----------
function renderAjustes() {
  $('#v-ajustes').innerHTML = `
    <h1>Ajustes</h1>
    <div class="card">
      <h2>API key de Claude</h2>
      <input id="key" type="password" autocomplete="off" placeholder="sk-ant-..." value="${esc(S.apiKey)}">
      <div class="row" style="margin-top:10px"><button class="primary" style="flex:1" data-act="savekey">Guardar</button><button data-act="testkey">Probar</button></div>
      <p class="small muted" id="keymsg">Se guarda solo en este teléfono.</p>
    </div>
    <div class="card"><h2>Metas (día base del plan)</h2><p style="margin:0">${fmt(GOAL.kcal)} kcal · ${GOAL.prot} g de proteína</p></div>
    <div class="card"><h2>Tus datos</h2>
      <button class="full" data-act="export">Exportar a archivo (CSV)</button>
      <p class="small muted" id="persist">${S.meals.length} comidas · ${S.weights.length} pesajes</p></div>
    <p class="small muted">Mi Plato v${VERSION}</p>`;
  navigator.storage?.persisted?.().then(p => { $('#persist').textContent += p ? ' · almacenamiento protegido' : ' · almacenamiento no protegido: exporta seguido'; });
}

function exportCSV() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['tipo', 'fecha', 'hora', 'texto', 'alimento', 'cantidad', 'fuente', 'kcal', 'proteina_g', 'carbohidratos_g', 'grasa_g', 'peso_kg']];
  for (const m of S.meals.filter(m => m.status === 'ok'))
    for (const i of m.items) rows.push(['comida', m.date, new Date(m.ts).toTimeString().slice(0, 5), m.text, i.nombre, i.cantidad, i.fuente, i.kcal, i.prot, i.carb, i.grasa, '']);
  for (const w of S.weights) rows.push(['peso', w.date, '', '', '', '', '', '', '', '', '', w.kg]);
  const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `mi-plato-${today()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- eventos ----------
let tab = 'hoy';
function show(t) {
  tab = t;
  for (const b of document.querySelectorAll('nav button')) b.dataset.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current');
  for (const v of ['hoy', 'peso', 'ajustes']) $('#v-' + v).hidden = v !== t;
  ({ hoy: renderHoy, peso: renderPeso, ajustes: renderAjustes })[t]();
  scrollTo(0, 0);
}
const meal = id => S.meals.find(m => m.id === id);

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) return show(b.dataset.tab);
  const id = b.dataset.id, m = id && meal(id);
  switch (b.dataset.act) {
    case 'add': {
      const text = $('#txt').value.trim(); if (!text) return $('#txt').focus();
      S.meals.push({ id: Date.now().toString(36), ts: Date.now(), date: today(), text, status: 'pending', items: [] });
      $('#txt').value = ''; $('#txt').blur(); save(); renderHoy(); scrollTo(0, 0); processPending(); break;
    }
    case 'ok': m.status = 'ok'; save(); renderHoy(); break;
    case 'rmitem': m.items.splice(+b.dataset.i, 1); if (!m.items.length) S.meals.splice(S.meals.indexOf(m), 1); save(); renderHoy(); break;
    case 'redo': $('#txt').value = m.text; S.meals.splice(S.meals.indexOf(m), 1); save(); renderHoy(); $('#txt').focus(); break;
    case 'retry': m.status = 'pending'; m.error = ''; save(); processPending(); break;
    case 'del': if (confirm('¿Borrar este registro?')) { S.meals.splice(S.meals.indexOf(m), 1); save(); renderHoy(); } break;
    case 'kg': {
      const kg = r1(num($('#kg').value));
      if (!(kg >= 30 && kg <= 300)) return alert('Escribe tu peso en kg, por ejemplo 83.4');
      S.weights = S.weights.filter(w => w.date !== today()).concat({ date: today(), kg }).sort((a, b) => a.date.localeCompare(b.date));
      save(); renderPeso(); break;
    }
    case 'delkg': if (confirm('¿Borrar este pesaje?')) { S.weights = S.weights.filter(w => w.date !== b.dataset.d); save(); renderPeso(); } break;
    case 'savekey': S.apiKey = $('#key').value.trim(); save(); $('#keymsg').textContent = 'Guardada en este teléfono.'; processPending(); break;
    case 'testkey': {
      S.apiKey = $('#key').value.trim(); save(); $('#keymsg').textContent = 'Probando…';
      try { const o = await interpret('un plátano'); const i = toItems(o.items)[0]; $('#keymsg').textContent = `✓ Funciona: ${i.nombre}, ${i.kcal} kcal.`; }
      catch (err) { $('#keymsg').textContent = '✗ ' + err.message; }
      break;
    }
    case 'export': exportCSV(); break;
  }
});
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset.edit) return;
  const m = meal(el.dataset.edit), v = num(el.value);
  if (m && v >= 0) { m.items[+el.dataset.i][el.dataset.f] = el.dataset.f === 'kcal' ? Math.round(v) : r1(v); save(); }
});
document.addEventListener('keydown', e => { if (e.target.id === 'txt' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('[data-act="add"]').click(); } });
addEventListener('online', processPending);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (tab === 'hoy') renderHoy(); processPending(); } });

// ---------- autopruebas: abrir con ?test ----------
function runTests() {
  const ok = (c, msg) => { if (!c) throw new Error('Falla: ' + msg); };
  const it = toItems([
    { nombre: 'Huevo', cantidad: '3', plan_id: 'huevo', porciones: 1.5, kcal: 999, proteina: 999, carbohidratos: 1, grasa: 15 },
    { nombre: 'Muslo', cantidad: '2', plan_id: '', porciones: 1, kcal: 420, proteina: 52.34, carbohidratos: 0, grasa: 22 },
  ]);
  ok(it[0].kcal === 218 && it[0].prot === 19.5 && it[0].fuente === 'plan', 'plan × porciones manda sobre la IA');
  ok(it[1].kcal === 420 && it[1].prot === 52.3 && it[1].fuente === 'estimado', 'estimado conserva valores de la IA');
  const t = totals([{ status: 'ok', date: '2026-11-12', items: it }, { status: 'draft', date: '2026-11-12', items: it }], '2026-11-12');
  ok(t.kcal === 638, 'totales solo cuentan confirmados');
  ok(weekStart('2026-11-15') === '2026-11-09' && weekStart('2026-11-09') === '2026-11-09', 'semana empieza lunes');
  const w = [{ date: '2026-11-03', kg: 84 }, { date: '2026-11-05', kg: 83.6 }, { date: '2026-11-10', kg: 83.2 }, { date: '2026-11-12', kg: 83 }];
  const s = weekStats(w, '2026-11-12');
  ok(Math.abs(s.cur - 83.1) < 1e-9 && Math.abs(s.prev - 83.8) < 1e-9 && s.curN === 2, 'promedio semanal');
  ok(Math.abs(rolling(w)[2].kg - 83.4) < 1e-9, 'promedio móvil de 7 días');
  return 'OK: 7 pruebas';
}

// ---------- inicio ----------
buildHoy(); show('hoy'); processPending();
if (location.search.includes('test')) { try { alert(runTests()); } catch (e) { alert(e.message); } }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
navigator.storage?.persist?.();
