import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = process.env.R2_BUCKET_NAME!;
const ENDPOINT = process.env.R2_ENDPOINT!;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    if (!BUCKET || !ENDPOINT) {
      throw new Error('R2_BUCKET_NAME and R2_ENDPOINT must be set');
    }
    client = new S3Client({
      region: 'auto',
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
    });
  }
  return client;
}

export function isR2Configured(): boolean {
  return !!(
    process.env.R2_BUCKET_NAME &&
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  );
}

export async function uploadToR2(
  key: string,
  buffer: Buffer,
  contentType?: string
): Promise<void> {
  const s3 = getClient();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType ?? 'video/mp4',
    })
  );
}

export async function deleteFromR2(key: string): Promise<void> {
  const s3 = getClient();
  await s3.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
}

export async function getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
  const s3 = getClient();
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  return getSignedUrl(s3, command, { expiresIn });
}
