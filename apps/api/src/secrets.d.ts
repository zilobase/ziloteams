export {};

declare global {
  interface Env {
    OTP_HMAC_KEY: string;
    INVITE_HMAC_KEY: string;
    FILE_SIGNING_KEY: string;
  }

  namespace Cloudflare {
    interface Env {
      OTP_HMAC_KEY: string;
      INVITE_HMAC_KEY: string;
      FILE_SIGNING_KEY: string;
    }
  }
}
