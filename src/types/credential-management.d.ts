/**
 * The `PasswordCredential` half of the Credential Management API.
 *
 * Chromium-only and not in TypeScript's DOM lib, so it is declared here rather
 * than reached for through `any`. See `credentialManager.ts`, which is the only
 * thing that uses it.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/PasswordCredential
 */

interface PasswordCredentialInit {
  id: string;
  password: string;
  name?: string;
  iconURL?: string;
}

declare class PasswordCredential extends Credential {
  constructor(init: PasswordCredentialInit);
  readonly password: string;
  readonly name: string;
  readonly iconURL: string;
}

interface CredentialRequestOptions {
  password?: boolean;
}
