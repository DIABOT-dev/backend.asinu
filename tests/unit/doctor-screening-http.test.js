'use strict';

const express = require('express');
const request = require('supertest');
const { screenDoctorConsultation } = require('../../src/controllers/doctor-task.controller');
let pool;
const app = express();
app.use(express.json());
app.post('/screening', (req, res, next) => {
  req.user = { id: 42 };
  return screenDoctorConsultation(pool, req, res).catch(next);
});
app.use((error, _req, res, _next) =>
  res.status(error.statusCode || 500).json({ code: error.code || 'ERROR' })
);
beforeEach(() => {
  pool = {
    query: jest
      .fn()
      .mockResolvedValue({ rows: [{ id: 42, birth_year: 1992, medical_conditions: [] }] }),
  };
});

test('screening reads only the authenticated patient context and starts with danger signs', async () => {
  const response = await request(app)
    .post('/screening')
    .send({ summary: 'Đau đầu', answers: [], locale: 'vi' })
    .expect(200);
  expect(pool.query.mock.calls[0][1]).toEqual([42]);
  expect(response.body.data.question.step).toBe('red_flags');
  expect(response.body.data).not.toHaveProperty('medical_conditions');
  expect(response.body.data).not.toHaveProperty('birth_year');
});

test('malformed requests are rejected before reading the patient', async () => {
  await request(app).post('/screening').send({ summary: '' }).expect(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('missing patients cannot obtain a screening response', async () => {
  pool.query.mockResolvedValue({ rows: [] });
  await request(app).post('/screening').send({ summary: 'Đau đầu' }).expect(404);
});

test('out-of-order answers return 400 instead of a successful assessment', async () => {
  await request(app)
    .post('/screening')
    .send({ summary: 'Đau đầu', answers: [{ step: 'impact', values: ['mild'], text: '' }] })
    .expect(400);
});

test('the HTTP response reports uncertain danger as incomplete and never ready', async () => {
  const response = await request(app)
    .post('/screening')
    .send({
      summary: 'Đau đầu',
      answers: [{ step: 'red_flags', values: ['unsure'], text: '' }],
      locale: 'en',
    })
    .expect(200);
  expect(response.body.data).toMatchObject({
    status: 'incomplete',
    suitable_for_remote_care: false,
  });
});
