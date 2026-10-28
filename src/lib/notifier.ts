import { env } from '../config/env';

export type Channel = 'EMAIL' | 'PHONE';
export type OtpPurpose = 'SIGNUP' | 'PASSWORD_RESET';
export type Notice = 'ACCOUNT_EXISTS' | 'PASSWORD_CHANGED';

interface Delivery {
  sendOtp(channel: Channel, destination: string, code: string, purpose: OtpPurpose): Promise<void>;
  sendNotice(channel: Channel, destination: string, notice: Notice): Promise<void>;
}

export function maskDestination(channel: Channel, destination: string): string {
  if (channel === 'PHONE') return `${destination.slice(0, -4).replace(/\d/g, '*')}${destination.slice(-4)}`;
  const [local = '', domain = ''] = destination.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

// Development only (refused in production by config/env.ts). Codes appear in the server log.
const consoleDelivery: Delivery = {
  sendOtp(channel, destination, code, purpose) {
    console.log(`[otp] ${purpose} ${channel} ${maskDestination(channel, destination)} code=${code}`);
    return Promise.resolve();
  },
  sendNotice(channel, destination, notice) {
    console.log(`[notice] ${notice} ${channel} ${maskDestination(channel, destination)}`);
    return Promise.resolve();
  },
};

// Add the SMS (MSG91 / Twilio) and email (SES / SendGrid) providers here once GIG picks them.
const delivery: Delivery = { console: consoleDelivery }[env.OTP_DELIVERY];

// Fire-and-forget: the response must not wait on (or reveal) delivery, so real and decoy
// requests take the same time. Failures are logged; the user can ask for a resend.
export function sendOtp(channel: Channel, destination: string, code: string, purpose: OtpPurpose): void {
  delivery.sendOtp(channel, destination, code, purpose).catch((err: unknown) => {
    console.error(`[otp] delivery failed (${channel})`, err);
  });
}

export function sendNotice(channel: Channel, destination: string, notice: Notice): void {
  delivery.sendNotice(channel, destination, notice).catch((err: unknown) => {
    console.error(`[notice] delivery failed (${channel})`, err);
  });
}
