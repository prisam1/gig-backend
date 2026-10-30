import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbTransport } from '../src/lib/db';
import { app } from './helpers';

const EMAIL_TAKEN = 'This email is already registered with another account.';
const PHONE_TAKEN = 'This phone number is already registered with another account.';

const register = {
  name: 'Asha Mehta',
  email: 'asha.mehta@example.com',
  countryCode: '+91',
  phone: '9876543210',
  password: 'Investor@2026',
  ageConfirmed: true,
  profile: { experienceYears: 5, jobProfile: 'BUSINESS_OWNER', location: 'Mumbai' },
  preferences: { focus: ['REAL_ASSETS'], risk: ['LOW_LEVEL'], style: ['ARBITRAGE'], sector: ['FINTECH'] },
  tier: 'OBSERVER',
};

describe('duplicate email or phone at sign-up', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('POST /auth/register/check (step 1)', () => {
    const check = (emailTaken: boolean, phoneTaken: boolean) => {
      vi.spyOn(dbTransport, 'rpc').mockResolvedValue({ emailTaken, phoneTaken });
      return request(app)
        .post('/api/v1/auth/register/check')
        .send({ email: register.email, countryCode: '+91', phone: register.phone });
    };

    it('says when both are free', async () => {
      const res = await check(false, false);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { available: true } });
    });

    it.each([
      [true, false, { email: EMAIL_TAKEN }, EMAIL_TAKEN],
      [false, true, { phone: PHONE_TAKEN }, PHONE_TAKEN],
      [true, true, { email: EMAIL_TAKEN, phone: PHONE_TAKEN }, EMAIL_TAKEN],
    ])('email taken %s, phone taken %s: 409 with a separate message under each taken field', async (email, phone, fields, message) => {
      const res = await check(email, phone);
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: 'ACCOUNT_EXISTS', message, fields });
    });

    it.each([
      [{ email: 'asha.mehta@example.com' }, { p_email_hash: expect.any(String), p_phone_hash: null }, 'email'],
      [{ phone: '9876543210' }, { p_email_hash: null, p_phone_hash: expect.any(String) }, 'phone'],
    ])('checks one field on its own (%o)', async (body, args, field) => {
      const rpc = vi.spyOn(dbTransport, 'rpc').mockResolvedValue({ emailTaken: field === 'email', phoneTaken: field === 'phone' });
      const res = await request(app).post('/api/v1/auth/register/check').send(body);
      expect(rpc).toHaveBeenCalledWith('app_contact_taken', args);
      expect(res.status).toBe(409);
      expect(Object.keys(res.body.error.fields)).toEqual([field]);
    });

    it('needs an email or a phone', async () => {
      const res = await request(app).post('/api/v1/auth/register/check').send({});
      expect(res.status).toBe(400);
    });

    it.each([
      [{ email: 'asha@', phone: '9876543210' }, 'email'],
      [{ email: 'asha@example.com', phone: '12345' }, 'phone'],
    ])('checks the format before the database (%o)', async (body, field) => {
      const rpc = vi.spyOn(dbTransport, 'rpc');
      const res = await request(app).post('/api/v1/auth/register/check').send(body);
      expect(res.status).toBe(400);
      expect(Object.keys(res.body.error.fields)).toEqual([field]);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/register (when the account is requested)', () => {
    it('refuses an address taken in the meantime, and sends no code', async () => {
      vi.spyOn(dbTransport, 'rpc').mockResolvedValue({ taken: { email: false, phone: true } });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      const res = await request(app).post('/api/v1/auth/register').send(register);

      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: 'ACCOUNT_EXISTS', message: PHONE_TAKEN, fields: { phone: PHONE_TAKEN } });
      expect(log).not.toHaveBeenCalled();
    });
  });
});
