import { supportApi } from '@/lib/api-client';

/** Presigns, PUTs the raw bytes to storage, and returns the descriptor `replyMine`/`replyRestaurant`/`adminApi.support.reply` attach to a new message — the same three-step flow `SupportAttachmentService` (apps/api) expects. */
export async function uploadSupportAttachment(
  caseId: string,
  file: File,
  scope: 'mine' | 'restaurant',
): Promise<{ key: string; filename: string; contentType: string; sizeBytes: number }> {
  const presign =
    scope === 'mine'
      ? await supportApi.presignMine(caseId, file.type, file.size)
      : await supportApi.presignRestaurant(caseId, file.type, file.size);
  await fetch(presign.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
  return { key: presign.key, filename: file.name, contentType: file.type, sizeBytes: file.size };
}
