export const SMALL_UPLOAD_MAX = 10 * 1024 * 1024;
export class UploadCancelled extends Error {}
export async function uploadBlob() {
  throw new Error('no uploads in these tests');
}
export function abandonUpload() {}
