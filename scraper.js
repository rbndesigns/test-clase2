const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL_RESULTADOS = 'https://www.fbm.es/resultados-club-20677/highstep-academy';
const URL_HORARIOS = 'https://www.fbm.es/es/horarios-y-resultados';
const OUTPUT_FILE = path.join(__dirname, 'public', 'resultados.json');
const SELECTORES_FBM = {
  categoria: '#ctl00_ctl00_contenedor_informacion_contenedor_informacion_con_lateral_formulario_DDLCategorias',
  fase: '#ctl00_ctl00_contenedor_informacion_contenedor_informacion_con_lateral_formulario_DDLFases',
  grupo: '#ctl00_ctl00_contenedor_informacion_contenedor_informacion_con_lateral_formulario_DDLGrupos'
};

const COMPETICIONES = [
  { nombre: '2ª Div Aut Masc BRONCE', fase: 'PRIMERA FASE', grupo: 'GRUPO 1' },
  { nombre: 'Junior Masc. Pref.', fase: 'PRIMERA 4ª DIVISION', grupo: 'GRUPO 3' },
  { nombre: 'Cadete Masc. Pref.', fase: 'PRIMERA 3ª DIVISION', grupo: 'GRUPO 3' },
  { nombre: 'Infantil Masc. Pref.', fase: 'PRIMERA 2ª DIVISION', grupo: 'GRUPO 1' }
];

const normalizar = (value) => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '');

async function seleccionarOpcion(page, selector, etiqueta) {
  const value = await page.$eval(selector, (select, text) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim().toUpperCase();
    return [...select.options].find(option => clean(option.text) === clean(text))?.value;
  }, etiqueta);
  if (!value) throw new Error(`No se encontró la opción FBM «${etiqueta}».`);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
    page.select(selector, value)
  ]);
}

async function obtenerEscudos(page, resultados) {
  await page.goto(URL_HORARIOS, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector(SELECTORES_FBM.categoria, { timeout: 30000 });

  const perfilesPorCompeticion = new Map();
  for (const competicion of COMPETICIONES) {
    await seleccionarOpcion(page, SELECTORES_FBM.categoria, competicion.nombre);
    await seleccionarOpcion(page, SELECTORES_FBM.fase, competicion.fase);
    await seleccionarOpcion(page, SELECTORES_FBM.grupo, competicion.grupo);
    const perfiles = await page.$$eval('a[href*="/equipo-"]', links => links.map(link => ({
      nombre: (link.innerText || '').replace(/\s+/g, ' ').trim(),
      url: link.href
    })).filter(perfil => perfil.nombre));
    perfilesPorCompeticion.set(competicion.nombre, new Map(perfiles.map(perfil => [normalizar(perfil.nombre), perfil.url])));
  }

  const perfilPorEquipo = new Map();
  for (const resultado of resultados) {
    const competicion = COMPETICIONES.find(item => resultado.categoria.startsWith(item.nombre));
    const perfiles = competicion && perfilesPorCompeticion.get(competicion.nombre);
    for (const nombre of [resultado.equipoLocal, resultado.equipoVisitante]) {
      const url = perfiles?.get(normalizar(nombre));
      if (url) perfilPorEquipo.set(nombre, url);
    }
  }

  const escudosPorPerfil = new Map();
  for (const url of new Set(perfilPorEquipo.values())) {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    const escudo = await page.$eval('img[src*="/imagenes/clubes/"]', image => image.currentSrc || image.src).catch(() => '');
    escudosPorPerfil.set(url, escudo);
  }

  const logos = new Map();
  for (const [nombre, url] of perfilPorEquipo) logos.set(nombre, escudosPorPerfil.get(url) || '');
  return resultados.map(resultado => ({
    ...resultado,
    escudoLocal: logos.get(resultado.equipoLocal) || '',
    escudoVisitante: logos.get(resultado.equipoVisitante) || ''
  }));
}

async function obtenerResultados(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#calendarios');
    if (!root) throw new Error('No se encontró la sección de calendarios de FBM.');

    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const isTeamHeading = (value) => /^Jornada\s+\d+/i.test(value);
    // En Actions, FBM puede unir la hora al año (25/10/202612:45).
    // Buscamos la fecha sin exigir separador después del año.
    const datePattern = /\d{1,2}\/\d{1,2}\/\d{4}/;
    const scorePattern = /^\d+$/;
    const resultados = [];
    const nodosOrdenados = [...root.querySelectorAll('.pestana-subdesplegable, h1,h2,h3,h4,h5,h6, table')];
    let categoriaActual = '';
    let jornadaActual = '';
    const tablas = [];
    const diagnostico = {
      filas: 0,
      filasConFecha: 0,
      filasHA: 0,
      filasHAConFecha: 0,
      filasCandidatasConMarcador: 0,
      ejemplosHA: []
    };

    for (const node of nodosOrdenados) {
      const text = clean(node.innerText);
      if (node.matches('.pestana-subdesplegable')) {
        categoriaActual = text;
      } else if (node.matches('h1,h2,h3,h4,h5,h6') && isTeamHeading(text)) {
        jornadaActual = text;
      } else if (node.matches('table')) {
        tablas.push({ table: node, categoria: categoriaActual, jornada: jornadaActual });
      }
    }

    for (const { table, categoria, jornada } of tablas) {

      for (const row of [...table.querySelectorAll('tr')]) {
        diagnostico.filas++;
        const cells = [...row.querySelectorAll('th,td')].map((cell) => clean(cell.innerText));
        const dateIndex = cells.findIndex((cell) => datePattern.test(cell));
        const tieneHA = cells.some((cell) => /HA\s*BASKET|HIGHSTEP\s*ACADEMY/i.test(cell));
        if (dateIndex >= 1) diagnostico.filasConFecha++;
        if (tieneHA) {
          diagnostico.filasHA++;
          if (dateIndex >= 1) diagnostico.filasHAConFecha++;
          if (diagnostico.ejemplosHA.length < 8) diagnostico.ejemplosHA.push(cells);
        }
        if (dateIndex < 1) continue;

        // Tomamos los dos nombres de equipo y los dos marcadores anteriores
        // a la fecha. Esto tolera celdas vacías y cambios menores en la tabla.
        const cellsBeforeDate = cells.slice(0, dateIndex).filter(Boolean);
        const equipos = cellsBeforeDate.filter((cell) => !scorePattern.test(cell));
        const puntos = cellsBeforeDate.filter((cell) => scorePattern.test(cell));
        if (tieneHA && equipos.length === 2 && puntos.length === 2) diagnostico.filasCandidatasConMarcador++;
        if (equipos.length !== 2 || puntos.length !== 2) continue;

        const [equipoLocal, equipoVisitante] = equipos;
        const [puntosLocal, puntosVisitante] = puntos;
        const esEquipoHA = (equipo) => /HA\s*BASKET|HIGHSTEP\s*ACADEMY/i.test(equipo);

        if (!esEquipoHA(equipoLocal) && !esEquipoHA(equipoVisitante)) continue;
        if (!scorePattern.test(puntosLocal) || !scorePattern.test(puntosVisitante)) continue;

        const campo = cells[dateIndex + 1] || '';
        const marcadorLocal = Number(puntosLocal);
        const marcadorVisitante = Number(puntosVisitante);
        const equipoHAEsLocal = esEquipoHA(equipoLocal);

        resultados.push({
            categoria,
            jornada,
            fecha: cells[dateIndex].match(/\d{1,2}\/\d{1,2}\/\d{4}/)[0],
            equipoLocal,
            puntosLocal: marcadorLocal,
            equipoVisitante,
            puntosVisitante: marcadorVisitante,
            campo,
            equipoHA: equipoHAEsLocal ? equipoLocal : equipoVisitante,
            rival: equipoHAEsLocal ? equipoVisitante : equipoLocal,
            condicion: equipoHAEsLocal ? 'local' : 'visitante',
            resultadoHA: equipoHAEsLocal ? marcadorLocal : marcadorVisitante,
            resultadoRival: equipoHAEsLocal ? marcadorVisitante : marcadorLocal,
            balance: equipoHAEsLocal
              ? marcadorLocal > marcadorVisitante ? 'victoria' : marcadorLocal < marcadorVisitante ? 'derrota' : 'empate'
              : marcadorVisitante > marcadorLocal ? 'victoria' : marcadorVisitante < marcadorLocal ? 'derrota' : 'empate'
        });
      }
    }

    return { totalTablas: tablas.length, resultados, diagnostico };
  });
}

(async () => {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(URL_RESULTADOS, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.waitForSelector('#calendarios table', { timeout: 30000 });
    // Algunas páginas FBM pintan primero las jornadas y rellenan los marcadores
    // después. Esperamos un resultado un tiempo acotado antes de darlo por vacío.
    await page.waitForFunction(() => {
      const root = document.querySelector('#calendarios');
      if (!root) return false;
      return [...root.querySelectorAll('tr')].some((row) => {
        const cells = [...row.querySelectorAll('th,td')].map((cell) => (cell.innerText || '').replace(/\s+/g, ' ').trim());
        const dateIndex = cells.findIndex((cell) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(cell));
        const beforeDate = cells.slice(0, dateIndex).filter(Boolean);
        return dateIndex >= 1 && beforeDate.some((cell) => /HA\s*BASKET|HIGHSTEP\s*ACADEMY/i.test(cell))
          && beforeDate.filter((cell) => /^\d+$/.test(cell)).length >= 2;
      });
    }, { timeout: 15000 }).catch(() => {});

    const { totalTablas, resultados, diagnostico } = await obtenerResultados(page);

    if (!totalTablas) throw new Error('FBM no devolvió tablas de calendario.');
    if (!resultados.length) {
      console.error('🔎 Diagnóstico FBM:', JSON.stringify(diagnostico));
      throw new Error(`No se encontraron resultados de HA Basket (${totalTablas} tablas, ${diagnostico.filasHA} filas HA, ${diagnostico.filasHAConFecha} con fecha). Se conserva el JSON anterior.`);
    }

    const resultadosConEscudos = await obtenerEscudos(page, resultados);
    resultadosConEscudos.sort((a, b) => {
      const [da, ma, ya] = a.fecha.split('/').map(Number);
      const [db, mb, yb] = b.fecha.split('/').map(Number);
      return new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da);
    });

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      actualizado: new Date().toISOString(),
      fuente: URL_RESULTADOS,
      total: resultadosConEscudos.length,
      resultados: resultadosConEscudos
    }, null, 2) + '\n');

    console.log(`✅ ${resultadosConEscudos.length} resultados con escudos FBM guardados en public/resultados.json`);
  } catch (error) {
    console.error('❌ No se pudieron actualizar los resultados:', error.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
