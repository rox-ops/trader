import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '8123';
const { app, db, state } = await import('../server.js');
const server = app.listen(8123);

const get = (path) => fetch(`http://127.0.0.1:8123${path}`);

test('status starts in paper mode', async () => {
  const response = await get('/api/status');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, 'paper');
});

test('bot control toggles state', async () => {
  const response = await fetch('http://127.0.0.1:8123/api/bot/start', { method: 'POST' });
  assert.equal((await response.json()).running, true);
  state.running = false;
});

test.after(() => { server.close(); db.close(); });
