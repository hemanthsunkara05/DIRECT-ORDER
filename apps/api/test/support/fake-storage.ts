import type { StoragePort } from '../../src/modules/restaurants/uploads/storage.port.js';

/**
 * In-memory stand-in for the S3-compatible storage adapter — same
 * rationale as the other fakes in this directory (no live MinIO in
 * this sandbox). `presignPut` doesn't return a real signed URL; tests
 * that need to simulate "the client uploaded the file" call `seed()`
 * directly instead of actually PUTting to the returned URL, since
 * nothing here is listening on it.
 */
export class FakeStoragePort implements StoragePort {
  private readonly objects = new Map<string, Uint8Array>();

  presignPut(key: string, contentType: string): Promise<string> {
    return Promise.resolve(`https://fake-storage.test/${key}?contentType=${contentType}`);
  }

  getObject(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  /** Simulates the client's direct-to-storage PUT that a real presigned URL would receive. */
  seed(key: string, bytes: Uint8Array): void {
    this.objects.set(key, bytes);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
