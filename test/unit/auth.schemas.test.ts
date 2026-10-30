import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { preferencesSchema, tierChoiceSchema } from '../../src/modules/users/onboarding.schemas';
import { updateMeSchema } from '../../src/modules/users/users.schemas';
import { identifierSchema, loginSchema, otpSendSchema, otpVerifySchema, registerSchema } from '../../src/modules/auth/auth.schemas';

const validRegister = {
  name: 'Aqsa Khan',
  email: '  Aqsa.Khan@Example.com ',
  phone: '9857485965',
  password: 'Str0ng!Pass',
  ageConfirmed: true,
  profile: { experienceYears: 5, jobProfile: 'BUSINESS_OWNER', location: 'Mumbai' },
  preferences: { focus: ['FINANCIAL_ASSETS'], risk: ['MEDIUM_LEVEL'], style: ['ACTIVE_INVESTING'], sector: ['TECHNOLOGY'] },
  tier: 'OBSERVER',
};

function fields(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  assert.equal(result.success, false);
  return result.error!.issues.map((i) => i.path.join('.'));
}

describe('register', () => {
  it('normalises email and phone and defaults to India', () => {
    const r = registerSchema.parse(validRegister);
    assert.equal(r.email, 'aqsa.khan@example.com');
    assert.equal(r.phone, '+919857485965');
    assert.equal(r.countryCode, '+91');
  });

  it('accepts UAE numbers with or without the leading 0', () => {
    assert.equal(registerSchema.parse({ ...validRegister, countryCode: '+971', phone: '501234567' }).phone, '+971501234567');
    assert.equal(registerSchema.parse({ ...validRegister, countryCode: '+971', phone: '0501234567' }).phone, '+971501234567');
  });

  it('rejects bad phone numbers', () => {
    for (const phone of ['985748596', '98574859651', '1857485965', '98574 85965', '+919857485965', '']) {
      assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, phone })), ['phone'], phone);
    }
    assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, countryCode: '+1' })), ['countryCode']);
  });

  it('enforces the password policy', () => {
    for (const password of ['Sh0rt!x', 'alllowercase1!', 'ALLUPPER1!', 'NoDigits!!', 'NoSpecial11', 'a'.repeat(129) + 'A1!']) {
      assert.ok(fields(registerSchema.safeParse({ ...validRegister, password })).includes('password'), password);
    }
    assert.ok(registerSchema.safeParse({ ...validRegister, password: 'short1!A' }).success);
  });

  it('rejects passwords containing the phone or email name', () => {
    assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, password: 'Xx!9857485965' })), ['password']);
    assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, password: 'Aqsa.Khan#2026' })), ['password']);
  });

  it('requires the 18+ confirmation to be exactly true', () => {
    for (const ageConfirmed of [false, 'true', 1, undefined]) {
      assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, ageConfirmed })), ['ageConfirmed']);
    }
  });

  it('validates names', () => {
    for (const name of ['Abc', '    Abc   ', 'Robert<script>', '1234 Name', 'a'.repeat(101)]) {
      assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, name })), ['name'], name);
    }
    assert.ok(registerSchema.safeParse({ ...validRegister, name: "Anne-Marie O'Neil" }).success);
    assert.ok(registerSchema.safeParse({ ...validRegister, name: 'अक्सा ख़ान' }).success);
  });

  it('rejects unknown fields such as a self-assigned role, and tiers that do not exist', () => {
    assert.equal(registerSchema.safeParse({ ...validRegister, role: 'ADMIN' }).success, false);
    assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, tier: 'ADMIN' })), ['tier']);
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, [], 'x', 42]) assert.equal(registerSchema.safeParse(body).success, false);
  });

  it('accepts steps 2-3 and the tier with step 1 (the app sends them before its OTP screen)', () => {
    const r = registerSchema.parse({
      ...validRegister,
      profile: { experienceYears: '5', jobProfile: 'BUSINESS_OWNER', location: 'Mumbai' },
      preferences: { focus: ['FINANCIAL_ASSETS'], risk: ['MEDIUM_LEVEL'], style: ['ACTIVE_INVESTING'], sector: ['TECHNOLOGY'] },
      tier: 'PRIVE',
    });
    assert.equal(r.profile.experienceYears, 5);
    assert.equal(r.tier, 'PRIVE');
  });

  it('requires the professional details, investment details and tier (no screen sets them later)', () => {
    for (const key of ['profile', 'preferences', 'tier'] as const) {
      const { [key]: _omitted, ...body } = validRegister;
      assert.deepEqual(fields(registerSchema.safeParse(body)), [key], key);
    }
  });

  it('applies the onboarding rules to steps 2-3 sent with registration', () => {
    const preferences = { focus: ['A', 'B'], risk: ['LOW_LEVEL'], style: ['X'], sector: ['Y'] };
    assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, preferences })), ['preferences.focus']);
    const profile = { experienceYears: '5+', jobProfile: 'BUSINESS_OWNER', location: 'Mumbai' };
    assert.deepEqual(fields(registerSchema.safeParse({ ...validRegister, profile })), ['profile.experienceYears']);
  });
});

describe('identifier', () => {
  it('parses emails and E.164 phones', () => {
    assert.deepEqual(identifierSchema.parse(' A@B.co '), { channel: 'EMAIL', value: 'a@b.co' });
    assert.deepEqual(identifierSchema.parse('+919857485965'), { channel: 'PHONE', value: '+919857485965', countryCode: '+91' });
    assert.deepEqual(identifierSchema.parse('+971501234567'), { channel: 'PHONE', value: '+971501234567', countryCode: '+971' });
  });

  it('rejects anything else', () => {
    for (const v of ['9857485965', '+19857485965', 'a@', '@b.com', '', '   ', "' or 1=1 --"]) {
      assert.equal(identifierSchema.safeParse(v).success, false, v);
    }
  });
});

describe('login and OTP', () => {
  it('requires a 4-digit code and a UUID challenge', () => {
    const challengeId = '7f1c2a4e-1b2c-4d3e-8f90-123456789abc';
    assert.ok(otpVerifySchema.safeParse({ challengeId, code: '0123' }).success);
    for (const code of ['123', '123a', '12345', '123456', 1234]) {
      assert.equal(otpVerifySchema.safeParse({ challengeId, code }).success, false, String(code));
    }
    assert.equal(otpVerifySchema.safeParse({ challengeId: 'not-a-uuid', code: '1234' }).success, false);
  });

  it('defaults the device platform and rejects unknown ones', () => {
    const r = loginSchema.parse({ identifier: 'a@b.co', password: 'x' });
    assert.deepEqual(r.device, { platform: 'OTHER' });
    assert.equal(loginSchema.safeParse({ identifier: 'a@b.co', password: 'x', device: { platform: 'TV' } }).success, false);
  });

  it('only resends existing challenges through /otp/send', () => {
    assert.ok(otpSendSchema.safeParse({ challengeId: '7f1c2a4e-1b2c-4d3e-8f90-123456789abc' }).success);
    for (const purpose of ['SIGNUP', 'LOGIN', 'PASSWORD_RESET']) {
      assert.equal(otpSendSchema.safeParse({ purpose, identifier: 'a@b.co' }).success, false, purpose);
    }
  });
});

describe('onboarding', () => {
  it('accepts experience as a number or numeric string', () => {
    assert.equal(updateMeSchema.parse({ experienceYears: '5' }).experienceYears, 5);
    assert.equal(updateMeSchema.parse({ experienceYears: 12 }).experienceYears, 12);
    for (const experienceYears of ['5+', -1, 81, 2.5, '']) {
      assert.equal(updateMeSchema.safeParse({ experienceYears }).success, false, String(experienceYears));
    }
  });

  it('rejects an empty update', () => {
    assert.equal(updateMeSchema.safeParse({}).success, false);
  });

  it('enforces preference counts', () => {
    const base = { focus: ['REAL_ASSETS'], risk: ['LOW_LEVEL'], style: ['ARBITRAGE'], sector: ['FINTECH'] };
    assert.ok(preferencesSchema.safeParse(base).success);
    assert.deepEqual(fields(preferencesSchema.safeParse({ ...base, focus: ['A', 'B'] })), ['focus']);
    assert.deepEqual(fields(preferencesSchema.safeParse({ ...base, risk: [] })), ['risk']);
    assert.deepEqual(fields(preferencesSchema.safeParse({ ...base, style: ['A', 'B', 'C', 'D'] })), ['style']);
    assert.deepEqual(fields(preferencesSchema.safeParse({ ...base, sector: ['A', 'A'] })), ['sector']);
    assert.deepEqual(fields(preferencesSchema.safeParse({ ...base, sector: ['lower'] })), ['sector.0']);
  });

  it('only accepts known tiers', () => {
    assert.ok(tierChoiceSchema.safeParse('PRIVE').success);
    assert.equal(tierChoiceSchema.safeParse('ADMIN').success, false);
  });
});
