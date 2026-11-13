/** `NEXO_DIAG` apagado: el mismo cuerpo de pruebas, sin instrumentación. */
process.env.NEXO_DIAG = '0';
await import('./diag-main.test.js');
