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
    // La FBM añade la hora, saltos de línea y a veces espacios no separables
    // al texto de la fecha. Detectamos la fecha dentro de la celda, sin anclarla.
    const datePattern = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/;
    const scorePattern = /^\d+$/;
    const headingSelector = 'h1,h2,h3,h4,h5,h6';
    const resultados = [];
    const tablas = [...root.querySelectorAll('table')];

    for (const table of tablas) {
      const competicionNode = table.closest('[id^="capa_competicion_calendario_"]') || root;
      const categoria = clean(competicionNode.querySelector(headingSelector)?.innerText);
      const precedingHeadings = [...competicionNode.querySelectorAll(headingSelector)]
        .filter((heading) => heading.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING);
      const jornadaHeading = precedingHeadings.reverse().find((heading) => isTeamHeading(clean(heading.innerText)));
      const jornada = clean(jornadaHeading?.innerText);

      for (const row of [...table.querySelectorAll('tr')]) {
        const cells = [...row.querySelectorAll('th,td')].map((cell) => clean(cell.innerText));
        const dateIndex = cells.findIndex((cell) => datePattern.test(cell));
        if (dateIndex < 1) continue;

        // Tomamos los dos nombres de equipo y los dos marcadores anteriores
        // a la fecha. Esto tolera celdas vacías y cambios menores en la tabla.
        const cellsBeforeDate = cells.slice(0, dateIndex).filter(Boolean);
        const equipos = cellsBeforeDate.filter((cell) => !scorePattern.test(cell));
        const puntos = cellsBeforeDate.filter((cell) => scorePattern.test(cell));
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

    return { totalTablas: root.querySelectorAll('table').length, resultados };
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
    const { totalTablas, resultados } = await obtenerResultados(page);

    if (!totalTablas) throw new Error('FBM no devolvió tablas de calendario.');
    if (!resultados.length) {
      throw new Error('No se encontraron resultados de HA Basket. Se conserva el JSON anterior.');
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
