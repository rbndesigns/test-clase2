# HA Basket — Resultados

Repositorio independiente para recopilar y consultar exclusivamente los resultados de los equipos de HA Basket publicados por la Federación de Baloncesto de Madrid.

## Ejecutar el scraper

Requiere Node.js 18 o posterior.

```bash
npm install
npm run scrape
```

El scraper escribe los encuentros con marcador final en `public/resultados.json`. El archivo contiene los equipos, el marcador, la fecha, la competición, la jornada, el campo y el balance de HA Basket.

## Ver la página

Sirve esta carpeta con cualquier servidor estático. La página principal (`index.html`) carga `public/resultados.json` y permite filtrar los resultados por equipo.

## Actualización automática en GitHub

La acción de `.github/workflows/actualizar-resultados.yml` se ejecuta a diario a las 03:00 UTC y también puede iniciarse manualmente desde **Actions**. Al terminar, actualiza `public/resultados.json` en el repositorio.

Si FBM cambia la estructura de su página o no devuelve resultados de HA Basket, el scraper falla y no reemplaza el JSON que ya existe.
