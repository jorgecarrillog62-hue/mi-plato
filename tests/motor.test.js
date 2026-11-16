// Pruebas del motor de alimentos. Correr con:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const Motor = require('../motor.js');
const base = require('../foods.json');
const mios = require('../mis_alimentos.json');

const ix = Motor.indice(base, mios, []);
const suma = (items, k) => items.reduce((s, i) => s + i[k], 0);
const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);
function uno(texto) { // un solo alimento resuelto, sin preguntas ni IA
  const r = Motor.resolver(texto, ix);
  assert.deepEqual(r.pendientes, [], `"${texto}" no debería ir a la IA`);
  assert.ok(r.items.length && !r.items.some(i => i.ask), `"${texto}" no debería preguntar`);
  return r.items;
}

test('proteína: una porción = 24 g, 2 porciones = 48 g, media = 12 g', () => {
  cerca(suma(uno('una porción de proteína'), 'prot'), 24, '1 porción');
  cerca(suma(uno('2 porciones de proteína'), 'prot'), 48, '2 porciones');
  cerca(suma(uno('media porción de proteína'), 'prot'), 12, 'media porción');
  cerca(suma(uno('una y media porciones de proteína'), 'prot'), 36, '1.5 porciones');
  cerca(suma(uno('un scoop de whey'), 'prot'), 24, 'scoop de whey');
  cerca(suma(uno('Gold Standard'), 'kcal'), 120, 'por marca');
  assert.equal(uno('una porción de proteína')[0].fuente, 'mia');
});

test('papa: pregunta si no dice cuál, y respeta gramos', () => {
  const r = Motor.resolver('183 gramos de papa', ix);
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.ok(it.ask, 'debe preguntar');
  const ids = it.opciones.map(o => o.id);
  assert.deepEqual(ids.slice().sort(), ['papa-cambray', 'papa-cocida', 'papas-fritas', 'pure-papa'], 'solo papas, sin comidas del plan');
  assert.equal(ids[0], 'papa-cambray', 'tus alimentos van primero');
  const elegido = Motor.racion(ix.byId.get('papa-cambray'), it.qty, it.unit, ix)[0];
  cerca(elegido.kcal, 87 * 1.83, 'kcal de 183 g de cambray');
  cerca(uno('183 gramos de papa cambray')[0].carb, 20.1 * 1.83, 'carbs de 183 g de cambray');
  cerca(uno('5 papas cambray')[0].kcal, 87 * 1.25, '5 piezas de cambray = 125 g');
  assert.equal(uno('papas fritas')[0].food_id, 'papas-fritas');
  assert.equal(uno('una papa cocida')[0].food_id, 'papa-cocida');
  cerca(uno('300 g de papa cocida')[0].kcal, 129 * 2, 'gramos sobre porción de 150 g');
});

test('tortilla: pregunta maíz/harina/nopal; de maíz se multiplica bien', () => {
  const r = Motor.resolver('dos tortillas', ix);
  assert.ok(r.items[0].ask);
  assert.deepEqual(r.items[0].opciones.map(o => o.id).sort(), ['tortilla-harina', 'tortilla-maiz', 'tortilla-nopal']);
  const t = uno('dos tortillas de maíz');
  cerca(suma(t, 'kcal'), 140, 'kcal');
  cerca(suma(t, 'carb'), 30, 'carbs');
  cerca(suma(uno('3 tortillas de harina'), 'kcal'), 345, 'harina');
});

test('huevo y claras', () => {
  cerca(suma(uno('tres huevos'), 'prot'), 18.9, '3 huevos');
  cerca(suma(uno('4 claras'), 'prot'), 14.4, '4 claras');
  const r = uno('dos huevos y 4 claras');
  assert.equal(r.length, 2);
  cerca(suma(r, 'kcal'), 2 * 72 + 4 * 17, 'kcal juntos');
});

test('arroz: gramos y tazas', () => {
  cerca(uno('150 gramos de arroz')[0].kcal, 195, '150 g');
  cerca(uno('una taza de arroz')[0].kcal, 130 * 1.58, '1 taza = 158 g');
  cerca(uno('150g de arroz integral')[0].kcal, 123 * 1.5, 'integral, "150g" pegado');
});

test('bratwurst: el tuyo gana sobre el genérico', () => {
  const b = uno('un bratwurst');
  assert.equal(b[0].food_id, 'bratwurst-mio');
  cerca(b[0].kcal, 290, 'kcal');
  cerca(suma(uno('dos bratwurst'), 'prot'), 34, '2 piezas');
});

test('yogurt: "yogurt griego" es el de Costco', () => {
  const y = uno('200 g de yogurt griego');
  assert.equal(y[0].food_id, 'yogurt-griego-costco');
  cerca(y[0].prot, 18, 'proteína');
});

test('frases completas', () => {
  const r = uno('comí dos huevos, una tortilla de maíz con 40 g de aguacate y una taza de fresas');
  assert.deepEqual(r.map(i => i.food_id), ['huevo', 'tortilla-maiz', 'aguacate', 'fresas']);
  cerca(r[2].kcal, 64, '40 g de aguacate');
  cerca(suma(uno('medio aguacate'), 'kcal'), 160 * 0.68, 'medio aguacate = 68 g');
  cerca(suma(uno('1 kilo de pollo deshebrado'), 'prot'), 310, 'kilo');
  cerca(suma(uno('una lata de atún'), 'prot'), 25.5, 'lata');
});

test('comidas del plan se expanden en sus alimentos', () => {
  const d = uno('mi desayuno de siempre');
  assert.deepEqual(d.map(i => i.food_id), ['yogurt-griego-costco', 'granola', 'platano']);
  cerca(suma(d, 'prot'), 22.5 + 4.1 + 1.3, 'proteína desayuno');
  const s = uno('snack de siempre');
  cerca(suma(s, 'prot'), 7.8 * 300 / 250 + 24, 'snack');
  for (const f of mios.filter(f => f.combo)) assert.ok(Motor.racion(ix.byId.get(f.id), null, null, ix).length, f.id);
});

test('ambigüedad y cosas que no están', () => {
  assert.ok(Motor.resolver('pollo', ix).items[0].ask, 'pollo: pechuga o muslo');
  assert.ok(Motor.resolver('pollo asado', ix).items[0].ask, 'pollo asado también pregunta');
  assert.deepEqual(Motor.resolver('una barra de proteína', ix).pendientes, ['una barra de proteina'], 'no es tu whey');
  assert.deepEqual(Motor.resolver('pan dulce', ix).pendientes, ['pan dulce']);
});

test('miel: 10 gramos son 10 g, no 10 cucharadas', () => {
  const miel = 64 * 10 / 21; // 64 kcal por cucharada de 21 g
  for (const t of ['10 gramos de miel de abeja', 'puse 10 gramos de miel de abeja', 'le eché 10 gr. de miel',
    '10 g. de miel', '10g de miel', 'diez gramos de miel', '10 grs de miel', '10 gm de miel', 'agregué 10 grms de miel'])
    cerca(suma(uno(t), 'kcal'), miel, t);
  cerca(suma(uno('una cucharada de miel'), 'kcal'), 64, '1 cucharada');
  cerca(suma(uno('2 cucharaditas de miel'), 'kcal'), 64 * 14 / 21, '2 cucharaditas = 14 g');
});

test('respuesta de la IA en gramos se respeta aunque escriba la unidad distinto', () => {
  for (const u of ['g', 'gramos', 'grams', 'gr.', 'gm', 'G'])
    cerca(Motor.desdeIA([{ food_id: 'miel', n: 10, unidad: u, nombre: '', cantidad: '', kcal: 0, proteina: 0, carbohidratos: 0, grasa: 0 }], ix)[0].kcal, 64 * 10 / 21, u);
});

test('sin redondeo antes de sumar', () => {
  const r = uno('media porción de proteína y 33 g de arroz');
  cerca(suma(r, 'carb'), 1.5 + 28.2 * 0.33, 'carbs exactos');
  cerca(suma(r, 'kcal'), 60 + 130 * 0.33, 'kcal exactas');
});

test('respuesta de la IA: si trae food_id, los números salen de la base', () => {
  const out = Motor.desdeIA([
    { nombre: 'Proteína', cantidad: '2 scoops', food_id: 'gold-standard-whey', n: 2, unidad: 'scoop', kcal: 999, proteina: 16, carbohidratos: 0, grasa: 0 },
    { nombre: 'Tamal', cantidad: '1 pieza', food_id: '', n: 1, unidad: 'pieza', kcal: 280, proteina: 7, carbohidratos: 30, grasa: 14 },
  ], ix);
  cerca(out[0].prot, 48, 'whey desde la base');
  assert.equal(out[0].fuente, 'mia');
  assert.equal(out[1].fuente, 'estimado');
  cerca(out[1].kcal, 280, 'estimado se conserva');
});

test('datos de la base: campos completos, ids únicos y calorías coherentes con los macros', () => {
  const ids = new Set();
  for (const f of [...base, ...mios]) {
    assert.ok(!ids.has(f.id), 'id repetido: ' + f.id); ids.add(f.id);
    if (f.combo) continue;
    for (const k of ['calorias', 'proteina_g', 'carbs_g', 'grasa_g']) assert.ok(typeof f[k] === 'number' && f[k] >= 0, `${f.id}.${k}`);
    assert.ok(f.porcion_base.g > 0 || f.porcion_base.ml > 0, f.id + ' sin gramos ni ml');
    assert.ok(['etiqueta mía', 'etiqueta', 'SMAE', 'USDA', 'aprox'].includes(f.fuente), f.id + ' fuente');
    assert.equal(typeof f.verificar, 'boolean', f.id + ' verificar');
    if (f.id.startsWith('cerveza')) continue; // el alcohol aporta 7 kcal/g y no está en los macros
    const atwater = 4 * f.proteina_g + 4 * f.carbs_g + 9 * f.grasa_g;
    assert.ok(Math.abs(atwater - f.calorias) <= Math.max(15, 0.2 * f.calorias), `${f.id}: ${f.calorias} kcal vs ${atwater.toFixed(0)} por macros`);
  }
  assert.ok(base.length >= 80, 'al menos 80 alimentos genéricos: ' + base.length);
});
