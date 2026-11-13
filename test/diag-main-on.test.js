/** `NEXO_DIAG=1`: el mismo cuerpo de pruebas, con instrumentación encendida. */
process.env.NEXO_DIAG = '1';
await import('./diag-main.test.js');
