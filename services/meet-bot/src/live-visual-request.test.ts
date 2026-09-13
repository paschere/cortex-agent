import assert from 'node:assert/strict';
import { wantsCurrentMeetingView } from './live-visual-request';
for (const text of [
  'Cortex, mira lo que estoy mostrando',
  'Revisa lo que estoy mirando',
  '¿Ves mi pantalla?',
  'Analiza esto',
])
  assert.equal(wantsCurrentMeetingView(text), true, text);
for (const text of [
  'Busca la factura en el cerebro',
  'No mires mi pantalla',
  'No captures la pantalla',
  'El proveedor vende pantallas',
])
  assert.equal(wantsCurrentMeetingView(text), false, text);
console.log('Explicit visual requests and refusals passed');
