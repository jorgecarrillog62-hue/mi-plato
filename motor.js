'use strict';
// Motor de alimentos: entiende lo que dictas, busca primero en tus alimentos, luego en la base, y calcula macros sin redondear.
// Orden: (1) tus alimentos (mis_alimentos.json + lo que guardas en el teléfono), (2) base genérica (foods.json), (3) lo que no encuentra se manda a la IA.
(function (root) {
  const NUM = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, medio: 0.5, media: 0.5 };
  const UNIT = { g: 'g', gr: 'g', grs: 'g', gm: 'g', grm: 'g', grms: 'g', gram: 'g', gramo: 'g', kg: 'kg', kilo: 'kg', kilogramo: 'kg', ml: 'ml', mililitro: 'ml', l: 'l', lt: 'l', litro: 'l', porcion: 'porcion', orden: 'porcion', racion: 'porcion', scoop: 'scoop', medida: 'scoop', pieza: 'pieza', pza: 'pieza', pz: 'pieza', taza: 'taza', cucharada: 'cda', cda: 'cda', cucharadita: 'cdita', cdita: 'cdita', rebanada: 'rebanada', lata: 'lata', vaso: 'vaso' };
  const STOP = new Set(('de del la el los las lo al a en mi mis me se su le les para por que hoy ayer unos unas como aprox aproximadamente ' +
    'comi desayune cene almorce merende tome bebi puse eche agregue anadi servi use prepare cocine').split(' '));
  // Palabras que no cambian qué alimento es: "pechuga asada" sigue siendo pechuga. Cualquier otra palabra extra manda el alimento a la IA.
  const DESC = new Set(['cocid', 'hervid', 'asad', 'planch', 'horn', 'natural', 'median', 'sin', 'piel', 'fresc', 'picad', 'rebanad', 'deshebrad', 'vapor', 'enter']); // ya en forma canon()

  const norm = s => String(s ?? '').replace(/½/g, ' 1/2 ').replace(/¼/g, ' 1/4 ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.,/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Singular y sin género: "papas"→"pap", "nopales"→"nopal", "nueces"→"nuez", "cocida"/"cocido"→"cocid".
  function canon(w) {
    if (/ces$/.test(w)) w = w.slice(0, -3) + 'z';
    else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
    if (w.length > 3 && /[aeo]$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  const unitOf = t => { t = t.replace(/\.+$/, ''); return UNIT[t] || (t.length > 3 && UNIT[t.replace(/e?s$/, '')]) || null; };
  function toNum(t) {
    if (/^\d+(?:[.,]\d+)?$/.test(t)) return parseFloat(t.replace(',', '.'));
    const f = t.match(/^(\d+)\/(\d+)$/); if (f && +f[2]) return f[1] / f[2];
    return t in NUM ? NUM[t] : null;
  }
  const palabras = s => [...new Set(norm(s).split(' ').filter(w => w && !STOP.has(w) && !/^\d/.test(w)).map(canon))];

  function segmentos(text) {
    let t = norm(text).replace(/\b(g|gr|grs|gm|grm|grms|kg|ml|lt|l|cda|cdita|pza|pz)\.(?!\d)/g, '$1'); // "10 gr." no parte la frase
    // "una porción y media" → "1.5 porcion"; "una y media porciones" → "1.5 porciones"
    t = t.replace(/\b(\S+) (\S+) y medi[oa]\b/g, (m, a, b) => toNum(a) != null && unitOf(b) ? `${toNum(a) + 0.5} ${b}` : m);
    t = t.replace(/\b(\S+) y medi[oa]\b/g, (m, a) => toNum(a) != null ? `${toNum(a) + 0.5}` : m);
    return t.split(/\s*(?:,(?!\d)|;|\+|\.(?!\d)|\b(?:y|e|con|mas|ademas|tambien)\b)\s*/).filter(Boolean);
  }

  function parse(seg) {
    let qty = null, unit = null, unitTok = null;
    const words = [];
    for (const t of seg.split(' ')) {
      const m = t.match(/^(\d+(?:[.,]\d+)?)(g|gr|grs|gm|grm|grms|kg|ml|l)$/);
      if (m) { qty = parseFloat(m[1].replace(',', '.')); unit = UNIT[m[2]]; continue; }
      if (t === 'cuarto' || t === 'cuartos') { qty = (qty ?? 1) / 4; continue; }
      const n = toNum(t);
      if (n != null) {
        if (qty == null) qty = n;
        else if (/^\d+\/\d+$/.test(t) || (n >= 1 && qty >= 1 && n < qty)) qty += n; // "1 1/2", "ciento cincuenta"
        else qty *= n;                                                             // "una media porción"
        continue;
      }
      const u = !words.length && unitOf(t); // la unidad va antes del alimento: "una lata de atún", no "atún en lata"
      if (u) { unit = u; unitTok = t; continue; }
      if (!STOP.has(t)) words.push(canon(t));
    }
    if (unit === 'kg') { qty = (qty ?? 1) * 1000; unit = 'g'; }
    if (unit === 'l') { qty = (qty ?? 1) * 1000; unit = 'ml'; }
    if (!words.length && unitTok) words.push(canon(unitTok)); // "un scoop" a secas
    return { qty, unit, words: [...new Set(words)] };
  }

  // Junta las tres fuentes. Lo del teléfono reemplaza a mis_alimentos y a la base si tiene el mismo id.
  function indice(base, mios, telefono) {
    const byId = new Map();
    for (const [lista, mia] of [[base, false], [mios, true], [telefono || [], true]])
      for (const f of lista || []) byId.set(f.id, Object.assign({}, f, { mia }));
    const foods = [...byId.values()];
    for (const f of foods) f.keys = [f.nombre, ...(f.aliases || [])].map(palabras).filter(k => k.length);
    return { foods, byId };
  }

  // Devuelve {food} si hay un ganador claro, {opciones} si hay que preguntar, o null si no hay coincidencia.
  function buscar(words, foods) {
    const W = new Set(words), cands = [];
    for (const f of foods) {
      let best = null;
      for (const k of f.keys) {
        const inText = k.every(w => W.has(w)), inKey = words.every(w => k.includes(w));
        let lvl = inText && inKey ? 3 : inText ? 2 : inKey ? 1 : 0;
        if (lvl === 2 && !words.every(w => k.includes(w) || DESC.has(w))) lvl = 0;
        if (lvl === 1 && f.combo) lvl = 0; // "papa" no debe ofrecer "Comida del plan (pollo con papa)"
        if (lvl && (!best || lvl > best.lvl || (lvl === best.lvl && k.length > best.len))) best = { lvl, len: k.length };
      }
      if (best) cands.push({ f, ...best });
    }
    if (!cands.length) return null;
    let c = cands.filter(x => x.lvl >= 2);
    if (c.length) {
      if (c.some(x => x.f.mia)) c = c.filter(x => x.f.mia); // tus alimentos siempre ganan
      const L = Math.max(...c.map(x => x.lvl)); c = c.filter(x => x.lvl === L);
      const len = Math.max(...c.map(x => x.len)); c = c.filter(x => x.len === len);
    } else c = cands.sort((a, b) => b.f.mia - a.f.mia).slice(0, 6); // dijiste algo general ("papa", "queso"): pregunta
    return c.length === 1 ? { food: c[0].f } : { opciones: c.map(x => x.f) };
  }

  const fx = n => String(+n.toFixed(2));
  // Macros de una cantidad de un alimento. Nada se redondea aquí.
  function racion(f, qty, unit, ix) {
    if (f.combo) return f.combo.flatMap(c => {
      const sub = ix.byId.get(c.id);
      if (!sub) throw new Error(`"${f.nombre}" usa "${c.id}", que no existe`);
      return racion(sub, c.n * (qty ?? 1), c.unidad || null, ix);
    });
    const pb = f.porcion_base, bg = pb.g || pb.ml, base = pb.g ? 'g' : 'ml', eq = f.equivalencias || {}, n = qty ?? 1;
    let factor, cant;
    if (unit === 'g' || unit === 'ml') { factor = n / bg; cant = `${fx(n)} ${unit}`; }
    else if ((unit && eq[unit]) || (!unit && eq.pieza)) { const u = unit || 'pieza'; factor = n * eq[u] / bg; cant = `${fx(n)} ${u} (≈${fx(n * eq[u])} ${base})`; }
    else {
      factor = n; cant = `${fx(n)} × ${pb.texto}`;
      if (unit && unit !== 'porcion' && !norm(pb.texto).includes(unit)) cant += ` (tomé 1 ${unit} = 1 porción)`;
    }
    if (qty == null) cant += ' (supuesto)';
    return [{
      nombre: f.nombre, cantidad: cant, fuente: f.mia ? 'mia' : 'base', ref: f.fuente || '', verificar: !!f.verificar, food_id: f.id,
      kcal: f.calorias * factor, prot: f.proteina_g * factor, carb: f.carbs_g * factor, grasa: f.grasa_g * factor,
    }];
  }

  // Texto dictado → {items, pendientes}. "pendientes" son los pedazos que no están en ninguna base y van a la IA.
  function resolver(text, ix) {
    const items = [], pendientes = [];
    for (const seg of segmentos(text)) {
      const p = parse(seg);
      if (!p.words.length) continue;
      const r = buscar(p.words, ix.foods);
      if (!r) pendientes.push(seg);
      else if (r.food) items.push(...racion(r.food, p.qty, p.unit, ix));
      else items.push({ nombre: seg, cantidad: '', ask: true, opciones: r.opciones.map(f => ({ id: f.id, nombre: f.nombre })), qty: p.qty, unit: p.unit, kcal: 0, prot: 0, carb: 0, grasa: 0 });
    }
    return { items, pendientes };
  }

  // Respuesta de la IA → items. Si la IA reconoció un alimento de la base, los números salen de la base, no de la IA.
  function desdeIA(raw, ix) {
    return raw.flatMap(it => {
      const f = it.food_id && ix.byId.get(it.food_id);
      if (f) return racion(f, it.n > 0 ? it.n : null, unitOf(norm(it.unidad)) || null, ix);
      return [{ nombre: it.nombre, cantidad: it.cantidad, fuente: 'estimado', ref: '', verificar: false, food_id: '', kcal: it.kcal, prot: it.proteina, carb: it.carbohidratos, grasa: it.grasa }];
    });
  }

  const UNIDADES = ['g', 'ml', 'porcion', 'pieza', 'taza', 'scoop', 'cda', 'cdita', 'rebanada', 'lata', 'vaso']; // las únicas que la IA puede contestar
  const Motor = { UNIDADES, norm, canon, palabras, segmentos, parse, indice, buscar, racion, resolver, desdeIA };
  if (typeof module === 'object' && module.exports) module.exports = Motor; else root.Motor = Motor;
})(this);
