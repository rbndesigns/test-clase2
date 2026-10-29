const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL_RESULTADOS = 'https://www.fbm.es/resultados-club-20677/highstep-academy';
const OUTPUT_FILE = path.join(__dirname, 'public', 'resultados.json');

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

    resultados.sort((a, b) => {
      const [da, ma, ya] = a.fecha.split('/').map(Number);
      const [db, mb, yb] = b.fecha.split('/').map(Number);
      return new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da);
    });

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      actualizado: new Date().toISOString(),
      fuente: URL_RESULTADOS,
      total: resultados.length,
      resultados
    }, null, 2) + '\n');

    console.log(`✅ ${resultados.length} resultados guardados en public/resultados.json`);
  } catch (error) {
    console.error('❌ No se pudieron actualizar los resultados:', error.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
