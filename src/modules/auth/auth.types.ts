import { z } from 'zod';
import { OTP, PASSWORD_POLICY } from '@constant/auth.constant';

/**
 * Request schemas and response DTOs for the auth module.
 *
 * Every message here is an i18n **key**, resolved by `validateRequest` against
 * the caller's `lan` header — a literal sentence in a schema is a review failure
 * (RULES.md). `{{min}}` is substituted by the i18n layer, so one key serves both
 * the 8-character member rule and the 12-character staff rule.
 */

const email = z
  .string({ required_error: 'validation.invalidEmail' })
  .trim()
  .min(1, 'validation.invalidEmail')
  .max(150, 'validation.invalidEmail')
  .email('validation.invalidEmail')
  // Lower-cased here rather than in the service so every downstream read,
  // including the rate limiter's key, sees the same string. `citext` makes the
  // database agree, but the OtpCodes identifier is a plain varchar and would not.
  .transform((value) => value.toLowerCase());

/**
 * Password rule as a factory: the two audiences share the shape and differ only
 * in the minimum, and `validation.passwordTooWeak` carries `{{min}}` so the
 * message states the rule that actually applied.
 */
const password = (min: number) =>
  z
    .string({ required_error: 'validation.passwordTooWeak' })
    .min(min, 'validation.passwordTooWeak')
    // No upper bound below bcrypt's own 72-byte truncation point would be a
    // silent security bug (a 100-char password compares equal to its first 72
    // bytes); rejecting outright is honest and costs nothing.
    .max(72, 'validation.passwordTooWeak')
    .regex(PASSWORD_POLICY.PATTERN, 'validation.passwordTooWeak');

export const memberPassword = password(PASSWORD_POLICY.MEMBER_MIN_LENGTH);
export const adminPassword = password(PASSWORD_POLICY.ADMIN_MIN_LENGTH);

const fullName = z
  .string({ required_error: 'validation.requiredFields' })
  .trim()
  .min(2, 'validation.requiredFields')
  .max(150, 'validation.requiredFields');

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9\s-]{6,19}$/, 'validation.invalidPhone')
  .optional();

export const signupSchema = z.object({
  email,
  password: memberPassword,
  full_name: fullName,
  phone,
});

export const verifyOtpSchema = z.object({
  email,
  code: z
    .string({ required_error: 'validation.requiredFields' })
    .trim()
    .regex(new RegExp(`^\\d{${OTP.LENGTH}}$`), 'auth.otpInvalid'),
});

export const resendOtpSchema = z.object({ email });

export const loginSchema = z.object({
  email,
  // Deliberately NOT the strong-password schema: rejecting a short password at
  // the login endpoint tells an attacker the policy and turns a 401 into a 422
  // that distinguishes "wrong password" from "malformed password".
  password: z
    .string({ required_error: 'auth.invalidCredentials' })
    .min(1, 'auth.invalidCredentials'),
});

export const refreshSchema = z.object({
  refresh_token: z
    .string({ required_error: 'auth.invalidToken' })
    .trim()
    .min(1, 'auth.invalidToken'),
});

export const logoutSchema = z.object({
  refresh_token: z.string().trim().min(1).optional(),
  /** `true` revokes every live session for this subject, not just this one. */
  all: z.boolean().optional(),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z
    .string({ required_error: 'auth.resetTokenInvalid' })
    .trim()
    .min(1, 'auth.resetTokenInvalid'),
  password: memberPassword,
});

export const changePasswordSchema = z.object({
  current_password: z
    .string({ required_error: 'auth.currentPasswordIncorrect' })
    .min(1, 'auth.currentPasswordIncorrect'),
  new_password: memberPassword,
});

export const adminLoginSchema = z.object({
  email,
  password: z
    .string({ required_error: 'auth.invalidCredentials' })
    .min(1, 'auth.invalidCredentials'),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

// ---------------------------------------------------------------------------
// Response DTOs — the frozen half of the contract (M1 module file)
// ---------------------------------------------------------------------------

/** What a client stores after a successful sign-in or refresh. */
export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  /** Access-token lifetime in seconds, so a client can pre-empt the 401. */
  expires_in: number;
}

export interface MemberSessionProfile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: string;
  email_verified_at: string | null;
  last_login_at: string | null;
}

/**
 * `GET /auth/me`. `member` and the M3 capability flags are present and null/false
 * from M1 so the customer app binds one shape for the whole MVP.
 */
export interface MemberMeResponse {
  user: MemberSessionProfile;
  /** The organisation record. Created when an application starts (ADR-016, M3). */
  member: null;
  capabilities: {
    /** The signup OTP was accepted. False blocks everything except resend-otp. */
    email_verified: boolean;
    /** Status is ACTIVE — i.e. not suspended or administratively blocked. */
    account_active: boolean;
    /** A `Members` row exists. Always false until M3 creates one. */
    has_member_record: boolean;
    /** The password can be changed in-session (always true for a live session). */
    can_change_password: boolean;
  };
}

export interface AdminSessionProfile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: string;
  is_super_admin: boolean;
  last_login_at: string | null;
}

/** `GET /auth/admin/me`. `permissions` is the live set, re-read from the database. */
export interface AdminMeResponse {
  admin: AdminSessionProfile;
  roles: { code: string; name: string }[];
  permissions: string[];
}

export interface MemberLoginResponse extends SessionTokens {
  user: MemberSessionProfile;
}

export interface AdminLoginResponse extends SessionTokens {
  admin: AdminSessionProfile;
  roles: { code: string; name: string }[];
  permissions: string[];
}
