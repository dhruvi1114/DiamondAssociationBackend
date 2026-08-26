import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { environment } from '@config/config';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { AppError } from '@utils/appError';

/** Ambiguous glyphs excluded: 0/O and 1/l/I cost more support mail than they add entropy. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const LENGTH = 6;
const TTL_MS = 10 * 60 * 1000;

const secret = (): string => {
  const value = environment.jwtSecret;

  if (!value) {
    throw new Error('captcha: no signing secret configured');
  }

  return value;
};

const sign = (answer: string, expiresAt: number): string =>
  createHmac('sha256', secret()).update(`${answer}.${expiresAt}`).digest('base64url');

const randomCode = (): string =>
  Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

const renderSvg = (code: string): string => {
  const glyphs = [...code]
    .map((char, index) => {
      const x = 16 + index * 26;
      const y = 34 + randomInt(-4, 5);
      const rotate = randomInt(-24, 25);

      return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-family="Georgia,serif" font-size="30" font-weight="700" fill="#1e2a5a">${char}</text>`;
    })
    .join('');

  const strokes = Array.from({ length: 4 }, () => {
    const y1 = randomInt(6, 46);
    const y2 = randomInt(6, 46);

    return `<path d="M0 ${y1} Q 90 ${randomInt(0, 50)} 180 ${y2}" stroke="#1e2a5a" stroke-width="1.4" fill="none" opacity="0.7"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="52" viewBox="0 0 180 52" role="img" aria-label="Captcha image"><rect width="180" height="52" fill="#ffffff"/>${strokes}${glyphs}</svg>`;
};

export interface IssuedCaptcha {
  token: string;
  svg: string;
}

export const issueCaptcha = (): IssuedCaptcha => {
  const answer = randomCode();
  const expiresAt = Date.now() + TTL_MS;
  const token = `${sign(answer, expiresAt)}.${expiresAt}.${answer}`;

  return { token, svg: renderSvg(answer) };
};

export const assertCaptcha = (token: string, answer: string): void => {
  const parts = token.split('.');

  if (parts.length < 3) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.captchaInvalid',
    });
  }

  const expiresAt = Number(parts[parts.length - 2]);
  const expectedAnswer = parts[parts.length - 1] ?? '';
  const signature = parts.slice(0, -2).join('.');

  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.captchaInvalid',
    });
  }

  const expectedSignature = sign(expectedAnswer, expiresAt);
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.captchaInvalid',
    });
  }

  const supplied = answer.trim().toLowerCase();
  const expected = expectedAnswer.trim().toLowerCase();

  if (supplied.length !== expected.length) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.captchaInvalid',
    });
  }

  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.captchaInvalid',
    });
  }
};
