import type { CredentialStore } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";
import { isJsonValue } from "../transport/json.js";
import { isJsonObject, isString } from "../transport/validation.js";
import { parseStoredCredential, type StoredCredential } from "./credentials.js";

/** Version 1 envelope: AES-256-GCM with a 96-bit nonce and a 128-bit tag. */
export interface EncryptedCredentialEnvelope {
  readonly version: 1;
  readonly algorithm: "A256GCM";
  readonly keyId: string;
  /** Base64url, 12 bytes. */
  readonly nonce: string;
  /** Base64url ciphertext followed by the authentication tag. */
  readonly ciphertext: string;
}

/** A WebCrypto AES-GCM 256-bit key, or 32 raw key bytes. */
export type CredentialEncryptionKey = CryptoKey | Uint8Array;

/** Converts a credential to and from plaintext. `decode` must throw on invalid input. */
export interface CredentialCodec<TCredential> {
  encode(value: TCredential): string;
  decode(plaintext: string): TCredential;
}

export interface EncryptedCredentialStoreOptions {
  /** Stores envelopes. Revisions and deletes pass through unchanged. */
  readonly store: CredentialStore<EncryptedCredentialEnvelope>;
  /** Bound into the authenticated data so records cannot move between stores. */
  readonly namespace: string;
  /** Key used for every write. Reads use the key named in each envelope. */
  readonly currentKeyId: string;
  /** Returns the key for an ID, or `undefined` when it is not available. */
  readonly resolveKey: (keyId: string) => Promise<CredentialEncryptionKey | undefined>;
  /** Defaults to `globalThis.crypto`. */
  readonly crypto?: Crypto;
}

export type EncryptedCredentialFailure =
  | "unsupported-version"
  | "malformed-envelope"
  | "key-unavailable"
  | "invalid-key"
  | "decryption-failed"
  | "invalid-plaintext";

const envelopeVersion = 1;

const algorithm = "A256GCM";

const nonceBytes = 12;

const tagBytes = 16;

const keyIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

const base64UrlPattern = /^[A-Za-z0-9_-]*$/;

const envelopeFields = new Set(["version", "algorithm", "keyId", "nonce", "ciphertext"]);

/** Strict JSON codec for `StoredCredential`. Unknown fields are rejected. */
export const storedCredentialCodec: CredentialCodec<StoredCredential> = {
  encode(value) {
    return JSON.stringify(parseStoredCredential(value, "credentials.encrypt"));
  },
  decode(plaintext) {
    const parsed: unknown = JSON.parse(plaintext);

    if (!isJsonValue(parsed)) throw new SyntaxError("Expected a JSON value");

    return parseStoredCredential(parsed, "credentials.decrypt");
  },
};

function failure(
  operation: string,
  reason: EncryptedCredentialFailure,
  message: string,
  keyId?: string,
): SocialError {
  return new SocialError({
    code: "invalid_config",
    operation,
    message,
    details: keyId === undefined ? { reason } : { reason, keyId },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!base64UrlPattern.test(text) || text.length % 4 === 1) return undefined;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return base64Url(bytes) === text ? bytes : undefined;
}

/**
 * Strictly decodes a stored envelope. Unknown versions are rejected before any
 * other check so a newer writer's records are never misread.
 */
export function parseEncryptedCredentialEnvelope<Input>(value: Input): EncryptedCredentialEnvelope {
  const operation = "credentials.decrypt";

  if (!isJsonValue(value) || !isJsonObject(value))
    throw failure(operation, "malformed-envelope", "Stored credential is invalid");

  if (value["version"] !== envelopeVersion)
    throw failure(
      operation,
      "unsupported-version",
      "Stored credential uses an unsupported envelope version",
    );

  const keyId = value["keyId"];
  const nonce = value["nonce"];
  const ciphertext = value["ciphertext"];

  if (
    Object.keys(value).some((field) => !envelopeFields.has(field)) ||
    value["algorithm"] !== algorithm ||
    !isString(keyId) ||
    !keyIdPattern.test(keyId) ||
    !isString(nonce) ||
    fromBase64Url(nonce)?.length !== nonceBytes ||
    !isString(ciphertext) ||
    (fromBase64Url(ciphertext)?.length ?? 0) < tagBytes
  )
    throw failure(operation, "malformed-envelope", "Stored credential is invalid");

  return { version: envelopeVersion, algorithm, keyId, nonce, ciphertext };
}

function additionalData(input: {
  readonly namespace: string;
  readonly storeKey: string;
  readonly keyId: string;
}): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      "social-sdk.credential",
      envelopeVersion,
      algorithm,
      input.namespace,
      input.storeKey,
      input.keyId,
    ]),
  );
}

/**
 * Wraps an envelope store with AES-256-GCM encryption. Each write uses
 * `currentKeyId` and a fresh random nonce. Authenticated data binds the
 * namespace, store key, envelope version, and key ID, so a record copied to
 * another key or namespace fails to decrypt. Missing keys, unknown versions,
 * and tampered records throw; they are never reported as absent.
 */
export function createEncryptedCredentialStore(
  options: EncryptedCredentialStoreOptions & { readonly codec?: undefined },
): CredentialStore<StoredCredential>;
export function createEncryptedCredentialStore<TCredential>(
  options: EncryptedCredentialStoreOptions & { readonly codec: CredentialCodec<TCredential> },
): CredentialStore<TCredential>;
export function createEncryptedCredentialStore<TCredential>(
  options: EncryptedCredentialStoreOptions & {
    readonly codec?: CredentialCodec<TCredential> | undefined;
  },
): CredentialStore<TCredential> | CredentialStore<StoredCredential> {
  return options.codec === undefined
    ? encryptedStore(options, storedCredentialCodec)
    : encryptedStore(options, options.codec);
}

function encryptedStore<TCredential>(
  options: EncryptedCredentialStoreOptions,
  codec: CredentialCodec<TCredential>,
): CredentialStore<TCredential> {
  const configure = "credentials.configure";

  if (options.namespace.length === 0)
    throw new SocialError({
      code: "invalid_config",
      operation: configure,
      message: "namespace must not be empty",
    });

  if (!keyIdPattern.test(options.currentKeyId))
    throw new SocialError({
      code: "invalid_config",
      operation: configure,
      message: "currentKeyId must be 1 to 128 letters, digits, or . _ : -",
    });

  const webCrypto = options.crypto ?? globalThis.crypto;

  if (webCrypto?.subtle === undefined)
    throw new SocialError({
      code: "runtime_unsupported",
      operation: configure,
      message: "WebCrypto is required for credential encryption",
    });

  async function cryptoKey(
    keyId: string,
    usage: "encrypt" | "decrypt",
    operation: string,
  ): Promise<CryptoKey> {
    let material: CredentialEncryptionKey | undefined;

    try {
      material = await options.resolveKey(keyId);
    } catch {
      material = undefined;
    }

    if (material === undefined)
      throw failure(
        operation,
        "key-unavailable",
        "Credential encryption key is unavailable",
        keyId,
      );

    if (material instanceof Uint8Array) {
      if (material.length !== 32)
        throw failure(operation, "invalid-key", "Credential encryption keys must be 32 bytes");

      return webCrypto.subtle.importKey("raw", new Uint8Array(material), "AES-GCM", false, [usage]);
    }

    const keyAlgorithm = material.algorithm;

    if (
      keyAlgorithm.name !== "AES-GCM" ||
      !("length" in keyAlgorithm) ||
      keyAlgorithm.length !== 256 ||
      !material.usages.includes(usage)
    )
      throw failure(operation, "invalid-key", "Credential encryption key must be AES-GCM 256");

    return material;
  }

  const encrypted: CredentialStore<TCredential> = {
    async get(storeKey) {
      const operation = "credentials.decrypt";
      const found = await options.store.get(storeKey);

      if (found === undefined) return undefined;
      const envelope = parseEncryptedCredentialEnvelope(found.value);
      const key = await cryptoKey(envelope.keyId, "decrypt", operation);
      const nonce = fromBase64Url(envelope.nonce);
      const ciphertext = fromBase64Url(envelope.ciphertext);

      if (nonce === undefined || ciphertext === undefined)
        throw failure(operation, "malformed-envelope", "Stored credential is invalid");

      let plaintext: string;

      try {
        const decrypted = await webCrypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: additionalData({
              namespace: options.namespace,
              storeKey,
              keyId: envelope.keyId,
            }),
            tagLength: tagBytes * 8,
          },
          key,
          ciphertext,
        );

        plaintext = new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
      } catch {
        throw failure(operation, "decryption-failed", "Stored credential could not be decrypted");
      }

      let value: TCredential;

      try {
        value = codec.decode(plaintext);
      } catch {
        // The codec error may quote plaintext, so it is never attached.
        throw failure(operation, "invalid-plaintext", "Stored credential is invalid");
      }

      return { value, revision: found.revision };
    },

    async compareAndSet(input) {
      const operation = "credentials.encrypt";
      const plaintext = codec.encode(input.value);
      const keyId = options.currentKeyId;
      const key = await cryptoKey(keyId, "encrypt", operation);
      const nonce = webCrypto.getRandomValues(new Uint8Array(nonceBytes));

      const ciphertext = await webCrypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: additionalData({
            namespace: options.namespace,
            storeKey: input.key,
            keyId,
          }),
          tagLength: tagBytes * 8,
        },
        key,
        new TextEncoder().encode(plaintext),
      );

      return options.store.compareAndSet({
        key: input.key,
        expectedRevision: input.expectedRevision,
        value: {
          version: envelopeVersion,
          algorithm,
          keyId,
          nonce: base64Url(nonce),
          ciphertext: base64Url(new Uint8Array(ciphertext)),
        },
      });
    },

    delete(storeKey) {
      return options.store.delete(storeKey);
    },
  };

  if (options.store.deleteIfRevision === undefined) return encrypted;

  // Revisions pass through unchanged, so the inner conditional delete applies as is.
  return {
    ...encrypted,
    deleteIfRevision: options.store.deleteIfRevision.bind(options.store),
  };
}
