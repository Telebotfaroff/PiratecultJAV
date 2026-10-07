/**
 * PiratecultJAV Application Entry Point
 * Guide Section 20: node src/app.js
 */
import('../server.ts').catch(err => {
  console.error('Failed to launch application:', err);
  process.exit(1);
});
