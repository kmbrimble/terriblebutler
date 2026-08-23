import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import './setup.js';
import pkg from '../server.js';
import { api, TEST_TOKEN } from './setup.js';

const { app, db } = pkg;

async function issueDeviceToken(label = 'Kitchen tablet') {
  const res = await api(app).post('/api/auth/device-token').send({ device_label: label });
  return res;
}

describe('POST /api/auth/device-token', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/auth/device-token')
      .send({ device_label: 'Kitchen tablet' });
    expect(res.status).toBe(401);
  });

  it('rejects a missing device_label', async () => {
    const res = await api(app).post('/api/auth/device-token').send({});
    expect(res.status).toBe(400);
  });

  it('issues an opaque token distinct from the stored hash, given a valid session', async () => {
    const res = await issueDeviceToken('Kitchen tablet');
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThanOrEqual(32);

    const expectedHash = crypto.createHash('sha256').update(res.body.token).digest('hex');
    const row = db.prepare('SELECT * FROM device_tokens WHERE device_label = ?').get('Kitchen tablet');
    expect(row.token_hash).toBe(expectedHash);
    expect(row.token_hash).not.toBe(res.body.token);
    expect(row.revoked).toBe(0);
  });
});

describe('device token as bearer auth', () => {
  it('authenticates a protected route using the raw device token', async () => {
    const issued = await issueDeviceToken('Phone');
    const res = await request(app)
      .get('/api/items')
      .set('Authorization', `Bearer ${issued.body.token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a revoked device token', async () => {
    const issued = await issueDeviceToken('Old tablet');
    const row = db.prepare('SELECT id FROM device_tokens WHERE device_label = ?').get('Old tablet');
    await api(app).post(`/api/auth/devices/${row.id}/revoke`).send();

    const res = await request(app)
      .get('/api/items')
      .set('Authorization', `Bearer ${issued.body.token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a device token idle for more than a year', async () => {
    const issued = await issueDeviceToken('Dormant tablet');
    const staleDate = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE device_label = ?')
      .run(staleDate, 'Dormant tablet');

    const res = await request(app)
      .get('/api/items')
      .set('Authorization', `Bearer ${issued.body.token}`);
    expect(res.status).toBe(401);
  });

  it('bumps last_used_at on each successful use (sliding expiry)', async () => {
    const issued = await issueDeviceToken('Sliding tablet');

    const staleButValid = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE device_label = ?')
      .run(staleButValid, 'Sliding tablet');

    const res = await request(app)
      .get('/api/items')
      .set('Authorization', `Bearer ${issued.body.token}`);
    expect(res.status).toBe(200);

    const after = db.prepare('SELECT last_used_at FROM device_tokens WHERE device_label = ?')
      .get('Sliding tablet').last_used_at;
    expect(after).not.toBe(staleButValid);
  });

  it('rejects a garbage bearer value that matches neither a JWT nor a device token', async () => {
    const res = await request(app)
      .get('/api/items')
      .set('Authorization', 'Bearer not-a-real-token-or-device-token');
    expect(res.status).toBe(401);
  });
});

describe('device management endpoints', () => {
  it('lists issued devices without exposing the token hash', async () => {
    await issueDeviceToken('Listed tablet');
    const res = await api(app).get('/api/auth/devices');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const device = res.body.find((d) => d.device_label === 'Listed tablet');
    expect(device).toBeTruthy();
    expect(device.token_hash).toBeUndefined();
    expect(device).toHaveProperty('created_at');
    expect(device).toHaveProperty('last_used_at');
    expect(device).toHaveProperty('revoked');
  });

  it('rejects listing devices without auth', async () => {
    const res = await request(app).get('/api/auth/devices');
    expect(res.status).toBe(401);
  });

  it('404s when revoking a nonexistent device id', async () => {
    const res = await api(app).post('/api/auth/devices/999999/revoke').send();
    expect(res.status).toBe(404);
  });

  it('marks a device revoked and reflects it in the device list', async () => {
    const issued = await issueDeviceToken('Revoke-me tablet');
    const row = db.prepare('SELECT id FROM device_tokens WHERE device_label = ?').get('Revoke-me tablet');

    const revokeRes = await api(app).post(`/api/auth/devices/${row.id}/revoke`).send();
    expect(revokeRes.status).toBe(200);

    const listRes = await api(app).get('/api/auth/devices');
    const device = listRes.body.find((d) => d.id === row.id);
    expect(device.revoked).toBe(1);
    expect(issued.body.token).toBeTruthy();
  });
});
