const express = require('express');
const request = require('supertest');
const {
  imageUpload, handleUpload, verifyImageMagicBytes,
} = require('../../src/middleware/upload.middleware');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0, 0, 0, 0, 0]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=', 'base64');
const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('image upload multipart contract', () => {
  let app, uploaded;
  beforeEach(() => {
    uploaded = jest.fn((req, res) => res.json({
      ok: true, type: req.file.mimetype, bytes: req.file.size,
    }));
    app = express();
    app.post('/scan', handleUpload(imageUpload.single('image')), verifyImageMagicBytes, uploaded);
  });

  test.each([
    ['jpg', 'image/jpeg', jpeg], ['png', 'image/png', png], ['webp', 'image/webp', webp],
  ])('accepts supported %s bytes and matching MIME', async (ext, type, buffer) => {
    const response = await request(app).post('/scan').attach('image', buffer, {
      filename: `medicine.${ext}`, contentType: type,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, type, bytes: buffer.length });
    expect(uploaded).toHaveBeenCalledTimes(1);
  });

  test('rejects original HEIC bytes even if the client names them medicine.jpg', async () => {
    const response = await request(app).post('/scan').attach('image', Buffer.from('....ftypheic....'), {
      filename: 'medicine.jpg', contentType: 'image/heic',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('IMAGE_TYPE_UNSUPPORTED');
    expect(uploaded).not.toHaveBeenCalled();
  });

  test('accepts the converted JPEG export of a HEIC selection', async () => {
    const response = await request(app).post('/scan').attach('image', jpeg, {
      filename: 'medicine.jpg', contentType: 'image/jpeg',
    });
    expect(response.status).toBe(200);
    expect(uploaded).toHaveBeenCalledTimes(1);
  });

  test('rejects MIME-spoofed non-image content before the scan handler', async () => {
    const response = await request(app).post('/scan').attach('image', Buffer.from('plain text disguised as a jpeg'), {
      filename: 'medicine.jpg', contentType: 'image/jpeg',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('IMAGE_INVALID');
    expect(uploaded).not.toHaveBeenCalled();
  });

  test('reports a missing image with a stable code', async () => {
    const response = await request(app).post('/scan');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('IMAGE_REQUIRED');
    expect(uploaded).not.toHaveBeenCalled();
  });

  test('reports oversized images without running recognition', async () => {
    const limit = Number.parseInt(process.env.UPLOAD_MAX_SIZE || '10485760', 10);
    const image = Buffer.alloc(limit + 1);
    jpeg.copy(image);
    const response = await request(app).post('/scan').attach('image', image, {
      filename: 'medicine.jpg', contentType: 'image/jpeg',
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('UPLOAD_FILE_TOO_LARGE');
    expect(uploaded).not.toHaveBeenCalled();
  });
});
