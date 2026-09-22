import { SocialError } from "../core/errors.js";
import type {
  AdapterOperationContext,
  ConnectedAccountRef,
  JsonObject,
  MediaAttachment,
  MediaRef,
} from "../core/types.js";
import { accountMatches, uploadManagedMedia, type ManagedOptions } from "./common.js";

/** Keep this record server-side. A provider storage URL may grant access to the asset. */
export interface ManagedMediaRecord {
  readonly ref: MediaRef;
  readonly publicUrl: string;
  readonly expiresAt?: string;
  readonly kind: "image" | "video";
  readonly mimeType: string;
}

export interface ManagedMediaStore {
  put(record: ManagedMediaRecord): Promise<void>;
  get(mediaId: string): Promise<ManagedMediaRecord | undefined>;
}

export class MemoryManagedMediaStore implements ManagedMediaStore {
  private readonly records = new Map<string, ManagedMediaRecord>();
  async put(record: ManagedMediaRecord) {
    this.records.set(record.ref.mediaId, structuredClone(record));
  }
  async get(mediaId: string) {
    const record = this.records.get(mediaId);

    return record ? structuredClone(record) : undefined;
  }
}

export function managedMedia(
  provider: "zernio" | "post-for-me",
  options: ManagedOptions,
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- provider payload is validated at this adapter boundary.
  presign: (body: JsonObject, context: AdapterOperationContext) => Promise<unknown>,
) {
  const store = options.mediaStore ?? new MemoryManagedMediaStore();

  async function resolve(
    item: MediaAttachment,
    account: ConnectedAccountRef,
    context: AdapterOperationContext,
  ): Promise<string> {
    accountMatches(account, context);

    if (item.source.kind !== "media-ref")
      return uploadManagedMedia(item, (body) => presign(body, context), {
        options,
        context,
        provider,
      });
    const ref = item.source.ref;

    if (
      ref.backend !== account.backend ||
      ref.accountId !== account.accountId ||
      ref.platform !== account.platform
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "media.resolve",
        message: "Media reference belongs to another account or backend.",
      });
    const record = await store.get(ref.mediaId);

    if (
      !record ||
      record.ref.backend !== ref.backend ||
      record.ref.accountId !== ref.accountId ||
      record.ref.platform !== ref.platform
    )
      throw new SocialError({
        code: "media_error",
        operation: "media.resolve",
        message: "Media reference is unknown to this server-side store.",
      });

    if (
      record.expiresAt &&
      Date.parse(record.expiresAt) <= (options.clock?.() ?? new Date()).getTime()
    )
      throw new SocialError({
        code: "media_error",
        operation: "media.resolve",
        message: "Stored media has expired. Upload a new asset explicitly.",
      });

    if (
      record.kind !== item.kind ||
      (item.mimeType !== undefined && item.mimeType !== record.mimeType)
    )
      throw new SocialError({
        code: "media_error",
        operation: "media.resolve",
        message: "Media kind or MIME type differs from the stored asset.",
      });

    return record.publicUrl;
  }

  return {
    resolve,
    async upload(
      item: MediaAttachment,
      account: ConnectedAccountRef,
      context: AdapterOperationContext,
    ): Promise<MediaRef> {
      accountMatches(account, context);

      if (item.source.kind === "media-ref") {
        await resolve(item, account, context);

        return item.source.ref;
      }

      if (!item.mimeType)
        throw new SocialError({
          code: "invalid_input",
          operation: "media.upload",
          message: "Provide the asset MIME type.",
        });
      const publicUrl = await resolve(item, account, context);

      const ref: MediaRef = {
        kind: "media",
        version: 1,
        backend: account.backend,
        platform: account.platform,
        accountId: account.accountId,
        mediaId: crypto.randomUUID(),
      };

      const uploaded = item.source.kind !== "https-url";

      const record: ManagedMediaRecord = {
        ref,
        publicUrl,
        kind: item.kind,
        mimeType: item.mimeType,
      };

      if (provider === "zernio" && uploaded) {
        const expiresAt = new Date(
          (options.clock?.() ?? new Date()).getTime() + 7 * 86400_000,
        ).toISOString();

        await store.put({ ...record, expiresAt });
      } else {
        await store.put(record);
      }

      return ref;
    },
  };
}
