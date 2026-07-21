const request = require('supertest');

test('GET /health returns 200 and healthy status', async () => {
  const res = await request('http://127.0.0.1:3000').get('/health');
  expect(res.statusCode).toBe(200);
  expect(res.body.status).toBe('healthy');
});
