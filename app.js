'use strict';
// Mi Plato: registro de comidas con IA, resumen del día y peso. Todo se guarda en este teléfono (localStorage).
const K = 'plato-v1', VERSION = '1.1.0', MODEL = 'claude-haiku-5-5';
const GOAL = { kcal: 1900, prot: 160 }; // día base del plan (sección 5)

// La IA solo ve lo que la base local no reconoció (motor.js decide eso).
const SYSTEM = `Eres un registro de comidas para un hombre mexicano en Monterrey. Recibes, uno por línea, alimentos que la app no encontró en su base. Pueden venir de dictado por voz, con errores. Devuelve cada alimento por separado.

Reglas:
- Si el alimento es uno del catálogo (aunque esté mal escrito o dicho distinto), pon su id en food_id, la cantidad en "n" y la unidad en "unidad" ("g", "ml", "porcion", "pieza", "taza", "scoop", "cda", "cdita", "rebanada", "lata" o "vaso"). Si no dice cantidad, n = 1 y unidad = "porcion".
- Si no está en el catálogo, food_id = "" y estima kcal, proteína, carbohidratos y grasa en gramos para lo que dijo. Si no dice cantidad, asume una porción típica de México y escríbelo en "cantidad", por ejemplo "1 pieza mediana (supuesto)".
- Llena siempre kcal, proteina, carbohidratos y grasa (si hay food_id, la app usa los de su base).
- "cantidad" en texto corto y claro. "nombre" corto, en español.
- En "nota" pon una frase breve solo si algo es ambiguo; si no, cadena vacía.
- Referencia: salida a restaurante ≈ 900–1,100 kcal.

Catálogo (id: nombre, porción):
`;
const schema = ids => ({
  type: 'object', additionalProperties: false, required: ['items', 'nota'],
  properties: {
    nota: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['nombre', 'cantidad', 'food_id', 'n', 'unidad', 'kcal', 'proteina', 'carbohidratos', 'grasa'],
        properties: {
          nombre: { type: 'string' }, cantidad: { type: 'string' },
          food_id: { type: 'string', enum: ['', ...ids] }, n: { type: 'number' }, unidad: { type: 'string' },
          kcal: { type: 'number' }, proteina: { type: 'number' }, carbohidratos: { type: 'number' }, grasa: { type: 'number' },
        },
      },
    },
  },
});

// Base de alimentos: foods.json (genéricos), mis_alimentos.json (tus etiquetas) y S.foods (lo que corriges en el teléfono, manda sobre todo).
let BASE = null;
const DBP = Promise.all(['foods.json', 'mis_alimentos.json'].map(f => fetch(f).then(r => { if (!r.ok) throw new Error(f); return r.json(); })))
  .then(([foods, mios]) => { BASE = { foods, mios }; }).catch(() => { });
const idx = () => Motor.indice(BASE?.foods, BASE?.mios, S.foods);
const fuenteTxt = i => i.fuente === 'mia' ? (i.ref === 'etiqueta mía' ? 'mi etiqueta' : 'mis alimentos · ' + i.ref)
  : i.fuente === 'base' ? 'base ' + i.ref : i.fuente === 'plan' ? 'del plan' : 'estimado';
const badge = i => `<span class="badge ${i.fuente === 'estimado' ? 'est' : ''}">${esc(fuenteTxt(i))}${i.verificar ? ' · verificar' : ''}</span>`;

// ---------- utilidades ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dstr = d => d.toLocaleDateString('en-CA'); // AAAA-MM-DD en hora local
const today = () => dstr(new Date());
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
const fmt = n => Math.round(n).toLocaleString('es-MX');
const num = s => parseFloat(String(s).replace(',', '.'));

function load() { let d; try { d = JSON.parse(localStorage.getItem(K)); } catch { } return Object.assign({ meals: [], weights: [], apiKey: '', foods: [] }, d || {}); }
function save() {
  try { localStorage.setItem(K, JSON.stringify(S)); }
  catch (e) { alert('No se pudo guardar en el teléfono (' + e.message + '). Exporta tus datos desde Ajustes.'); }
}
let S = load();

// ---------- lógica pura (probada en runTests; la de alimentos en tests/motor.test.js) ----------
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
async function interpret(text, ix) {
  if (!S.apiKey) throw fail('Falta tu API key. Ponla en Ajustes.', false);
  const catalogo = ix.foods.map(f => `${f.id}: ${f.nombre} (${f.combo ? 'comida completa' : f.porcion_base.texto})`).join('\n');
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': S.apiKey, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // llamada directa desde el teléfono, sin servidor
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2000, system: SYSTEM + catalogo,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: schema(ix.foods.map(f => f.id)) } },
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
  await DBP;
  for (const m of S.meals.filter(m => m.status === 'pending' && !busy.has(m.id))) {
    busy.add(m.id); renderHoy();
    try {
      if (!BASE) throw fail('No se pudo cargar la base de alimentos. Reintenta con internet.', true);
      const ix = idx(), r = Motor.resolver(m.text, ix);
      m.nota = '';
      if (r.pendientes.length) { // solo lo que no está en la base va a la IA
        const out = await interpret(r.pendientes.join('\n'), ix);
        r.items.push(...Motor.desdeIA(out.items, ix)); m.nota = out.nota || '';
      }
      if (!r.items.length) throw fail('No encontré alimentos en el texto. Corrígelo.', false);
      m.items = r.items; m.status = 'draft'; m.error = '';
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
    <div class="small muted" style="margin-top:10px">Carbohidratos ${fmt(t.carb)} g · Grasa ${fmt(t.grasa)} g</div>`;

  $('#drafts').innerHTML = S.meals.filter(m => m.status !== 'ok').map(m => {
    if (m.status === 'draft') return `<div class="card">
      <h2>Confirma</h2><div class="small muted">“${esc(m.text)}”</div>
      <div class="item small muted" style="border:0"><span></span><span style="text-align:right">kcal</span><span style="text-align:right">prot g</span><span></span></div>
      ${m.items.map((i, n) => i.ask ? `<div class="item"><div style="grid-column:1/4">
          <div>“${esc(i.nombre)}”: ¿cuál?</div>
          <div class="row" style="flex-wrap:wrap;margin-top:6px">${i.opciones.map(o => `<button class="small" style="padding:8px 12px" data-act="pick" data-id="${m.id}" data-i="${n}" data-f="${esc(o.id)}">${esc(o.nombre)}</button>`).join('')}</div></div>
        <button data-act="rmitem" data-id="${m.id}" data-i="${n}" aria-label="Quitar ${esc(i.nombre)}">✕</button></div>`
      : `<div class="item">
        <div><div>${esc(i.nombre)}</div><div class="small muted">${esc(i.cantidad)} ${badge(i)}</div>
          <div class="small muted">Carbs ${r1(i.carb)} g · Grasa ${r1(i.grasa)} g</div></div>
        <input inputmode="decimal" value="${Math.round(i.kcal)}" data-edit="${m.id}" data-i="${n}" data-f="kcal" aria-label="kcal de ${esc(i.nombre)}">
        <input inputmode="decimal" value="${r1(i.prot)}" data-edit="${m.id}" data-i="${n}" data-f="prot" aria-label="proteína de ${esc(i.nombre)}">
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
    return `<div class="meal row between"><div><div>${m.items.map(i => `${esc(i.nombre)} ${badge(i)}`).join(', ')}</div>
      <div class="small muted">${new Date(m.ts).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' })} · ${fmt(tt.kcal)} kcal · ${fmt(tt.prot)} g prot · ${fmt(tt.carb)} g carbs · ${fmt(tt.grasa)} g grasa</div></div>
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
    <div class="card"><h2>Alimentos</h2>
      <input id="fq" type="search" autocomplete="off" placeholder="Buscar: papa, whey, tortilla…" aria-label="Buscar alimento">
      <div id="flist"></div>
      <div id="fform"></div>
      <div class="row" style="margin-top:10px"><button style="flex:1" data-act="fnew">+ Agregar alimento</button><button data-act="fexport">Exportar</button></div>
      <p class="small muted" style="margin:8px 0 0">Lo que guardas aquí manda sobre todo lo demás y vive en este teléfono. “Exportar” baja un archivo para pasarlo a mis_alimentos.json.</p>
    </div>
    <div class="card"><h2>Metas (día base del plan)</h2><p style="margin:0">${fmt(GOAL.kcal)} kcal · ${GOAL.prot} g de proteína</p></div>
    <div class="card"><h2>Tus datos</h2>
      <button class="full" data-act="export">Exportar a archivo (CSV)</button>
      <p class="small muted" id="persist">${S.meals.length} comidas · ${S.weights.length} pesajes</p></div>
    <p class="small muted">Mi Plato v${VERSION}</p>`;
  navigator.storage?.persisted?.().then(p => { $('#persist').textContent += p ? ' · almacenamiento protegido' : ' · almacenamiento no protegido: exporta seguido'; });
  DBP.then(renderFoods);
}

function renderFoods() {
  if (!BASE) return void ($('#flist').innerHTML = '<p class="small err">No se pudo cargar la base de alimentos.</p>');
  const q = Motor.norm($('#fq').value), ix = idx();
  const list = ix.foods.filter(f => q ? Motor.norm([f.nombre, ...(f.aliases || [])].join(' ')).includes(q) : f.mia).slice(0, 15);
  $('#flist').innerHTML = list.map(f => `<div class="meal row between"><div>
      <div>${esc(f.nombre)} ${f.combo ? '<span class="badge">comida del plan</span>' : badge({ fuente: f.mia ? 'mia' : 'base', ref: f.fuente, verificar: f.verificar })}</div>
      <div class="small muted">${f.combo ? 'Incluye: ' + esc(f.combo.map(c => ix.byId.get(c.id)?.nombre || c.id).join(', '))
        : `${esc(f.porcion_base.texto)} · ${f.calorias} kcal · P ${f.proteina_g} · C ${f.carbs_g} · G ${f.grasa_g}`}</div>
      <div class="small muted">Dices: ${esc((f.aliases || []).join(', ') || '—')}</div></div>
    ${f.combo ? '' : `<button class="link" data-act="fedit" data-f="${esc(f.id)}">Editar</button>`}</div>`).join('')
    || `<p class="small muted">${q ? 'No hay coincidencias.' : 'Busca un alimento para verlo o corregirlo.'}</p>`;
}
function foodForm(f) {
  const v = x => esc(x ?? '');
  const field = (id, label, val, num) => `<label class="small" style="flex:1">${label}<input id="ff-${id}" value="${v(val)}" ${num ? 'inputmode="decimal"' : ''}></label>`;
  $('#fform').innerHTML = `<div style="display:grid;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
    <h2>${f ? 'Corregir alimento' : 'Nuevo alimento'}</h2>
    ${field('nombre', 'Nombre', f?.nombre)}
    ${field('alias', 'Cómo lo dices (separa con comas)', (f?.aliases || []).join(', '))}
    ${field('ptxt', 'Porción (texto)', f?.porcion_base.texto)}
    <div class="row">${field('g', 'Gramos', f?.porcion_base.g, 1)}${field('ml', 'o ml', f?.porcion_base.ml, 1)}</div>
    <div class="row">${field('kcal', 'kcal', f?.calorias, 1)}${field('p', 'Proteína g', f?.proteina_g, 1)}</div>
    <div class="row">${field('c', 'Carbs g', f?.carbs_g, 1)}${field('gr', 'Grasa g', f?.grasa_g, 1)}</div>
    <div class="row"><button class="primary" style="flex:1" data-act="fsave" data-f="${v(f?.id)}">Guardar</button><button data-act="fcancel">Cancelar</button></div>
    ${f && S.foods.some(x => x.id === f.id) ? `<button class="link" data-act="fdel" data-f="${v(f.id)}">Quitar mi versión (vuelve al valor original)</button>` : ''}</div>`;
  $('#ff-nombre').focus();
}
function saveFood(id) {
  const n = k => num($('#ff-' + k).value), nombre = $('#ff-nombre').value.trim(), g = n('g'), ml = n('ml');
  const [kcal, p, c, gr] = ['kcal', 'p', 'c', 'gr'].map(n);
  if (!nombre || !(g > 0 || ml > 0) || ![kcal, p, c, gr].every(x => x >= 0))
    return alert('Llena el nombre, los gramos o ml de la porción y los 4 valores (pueden ser 0).');
  const old = id && idx().byId.get(id);
  const f = {
    id: old ? old.id : 'u-' + Date.now().toString(36), nombre,
    aliases: $('#ff-alias').value.split(',').map(s => s.trim()).filter(Boolean),
    porcion_base: Object.assign({ texto: $('#ff-ptxt').value.trim() || (g > 0 ? `${g} g` : `${ml} ml`) }, g > 0 ? { g } : { ml }),
    calorias: kcal, proteina_g: p, carbs_g: c, grasa_g: gr, fuente: 'etiqueta mía', verificar: false,
  };
  if (old?.equivalencias) f.equivalencias = old.equivalencias;
  S.foods = S.foods.filter(x => x.id !== f.id).concat(f); save();
  $('#fform').innerHTML = ''; $('#fq').value = nombre; renderFoods();
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportCSV() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['tipo', 'fecha', 'hora', 'texto', 'alimento', 'cantidad', 'fuente', 'kcal', 'proteina_g', 'carbohidratos_g', 'grasa_g', 'peso_kg']];
  for (const m of S.meals.filter(m => m.status === 'ok'))
    for (const i of m.items) rows.push(['comida', m.date, new Date(m.ts).toTimeString().slice(0, 5), m.text, i.nombre, i.cantidad, fuenteTxt(i), r1(i.kcal), r1(i.prot), r1(i.carb), r1(i.grasa), '']);
  for (const w of S.weights) rows.push(['peso', w.date, '', '', '', '', '', '', '', '', '', w.kg]);
  download(`mi-plato-${today()}.csv`, '﻿' + rows.map(r => r.map(q).join(',')).join('\n'), 'text/csv');
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
    case 'ok': {
      const q = m.items.filter(i => i.ask);
      if (q.length) return alert('Primero elige cuál fue: ' + q.map(i => '“' + i.nombre + '”').join(', '));
      m.status = 'ok'; save(); renderHoy(); break;
    }
    case 'pick': {
      const i = +b.dataset.i, it = m.items[i], ix = idx(), f = ix.byId.get(b.dataset.f);
      if (!f) return alert('Ese alimento ya no existe en la base.');
      m.items.splice(i, 1, ...Motor.racion(f, it.qty, it.unit, ix)); save(); renderHoy(); break;
    }
    case 'fnew': foodForm(null); break;
    case 'fedit': foodForm(idx().byId.get(b.dataset.f)); break;
    case 'fcancel': $('#fform').innerHTML = ''; break;
    case 'fsave': saveFood(b.dataset.f); break;
    case 'fdel': if (confirm('¿Quitar tu versión de este alimento?')) { S.foods = S.foods.filter(x => x.id !== b.dataset.f); save(); $('#fform').innerHTML = ''; renderFoods(); } break;
    case 'fexport': download('mis_alimentos_telefono.json', JSON.stringify(S.foods, null, 2), 'application/json'); break;
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
      try {
        await DBP; if (!BASE) throw new Error('No se pudo cargar la base de alimentos.');
        const ix = idx(), o = await interpret('un tamal', ix), i = Motor.desdeIA(o.items, ix)[0];
        $('#keymsg').textContent = `✓ Funciona: ${i.nombre}, ${Math.round(i.kcal)} kcal.`;
      }
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
document.addEventListener('input', e => { if (e.target.id === 'fq') renderFoods(); });
document.addEventListener('keydown', e => { if (e.target.id === 'txt' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('[data-act="add"]').click(); } });
addEventListener('online', processPending);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (tab === 'hoy') renderHoy(); processPending(); } });

// ---------- autopruebas: abrir con ?test ----------
function runTests() {
  const ok = (c, msg) => { if (!c) throw new Error('Falla: ' + msg); };
  const it = [{ kcal: 217.5, prot: 19.53, carb: 1, grasa: 15 }, { kcal: 420.4, prot: 52.34, carb: 0, grasa: 22 }];
  const t = totals([{ status: 'ok', date: '2026-11-12', items: it }, { status: 'draft', date: '2026-11-12', items: it }], '2026-11-12');
  ok(Math.abs(t.kcal - 637.9) < 1e-9 && Math.abs(t.prot - 71.87) < 1e-9, 'totales sin redondear y solo confirmados');
  ok(weekStart('2026-11-15') === '2026-11-09' && weekStart('2026-11-09') === '2026-11-09', 'semana empieza lunes');
  const w = [{ date: '2026-11-03', kg: 84 }, { date: '2026-11-05', kg: 83.6 }, { date: '2026-11-10', kg: 83.2 }, { date: '2026-11-12', kg: 83 }];
  const s = weekStats(w, '2026-11-12');
  ok(Math.abs(s.cur - 83.1) < 1e-9 && Math.abs(s.prev - 83.8) < 1e-9 && s.curN === 2, 'promedio semanal');
  ok(Math.abs(rolling(w)[2].kg - 83.4) < 1e-9, 'promedio móvil de 7 días');
  return 'OK: 4 pruebas';
}

// ---------- inicio ----------
buildHoy(); show('hoy'); processPending();
if (location.search.includes('test')) { try { alert(runTests()); } catch (e) { alert(e.message); } }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
navigator.storage?.persist?.();
