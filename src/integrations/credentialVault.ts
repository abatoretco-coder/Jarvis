import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;

export type EncryptedCredential = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

export class CredentialVault {
  private readonly key: Buffer;

  constructor(encodedKey: string, readonly keyVersion = 1) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== KEY_BYTES) throw new Error('integration_vault_key_invalid');
  }

  encrypt(secret: string, credentialId: string): EncryptedCredential {
    if (!secret.trim()) throw new Error('integration_credential_empty');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(credentialId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(value: EncryptedCredential, credentialId: string): string {
    if (value.keyVersion !== this.keyVersion) throw new Error('integration_vault_key_version_unknown');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
      decipher.setAAD(Buffer.from(credentialId, 'utf8'));
      decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('integration_credential_decryption_failed');
    }
  }
}

