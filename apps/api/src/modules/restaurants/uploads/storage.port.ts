/**
 * The boundary between UploadService and whatever object store actually
 * holds the bytes. S3StorageAdapter (real, S3/MinIO-compatible) is the
 * only production implementation; tests use an in-memory fake
 * (test/support/fake-storage.ts) — this interface is what makes that
 * substitution possible without UploadService knowing which one it has.
 */
export const STORAGE_PORT = Symbol('STORAGE_PORT');

export interface StoragePort {
  /** A time-limited URL the client PUTs the file bytes to directly — the API never sees the bytes at upload time. */
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
}
