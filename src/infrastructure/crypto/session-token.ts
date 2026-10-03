import type { SessionTokenCodec } from '../../application/ports/session-repository';
const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const sessionTokenCodec: SessionTokenCodec = {
  generate: () => `ps1_${hex(crypto.getRandomValues(new Uint8Array(32)))}`,
  accepts: token => /^ps1_[a-f0-9]{64}$/.test(token),
  async hash(token) {
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
  },
};
