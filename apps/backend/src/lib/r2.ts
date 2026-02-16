import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import https from 'https';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const BUCKET = process.env.R2_BUCKET_NAME!;
const ENDPOINT = process.env.R2_ENDPOINT!;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    if (!BUCKET || !ENDPOINT) {
      throw new Error('R2_BUCKET_NAME and R2_ENDPOINT must be set');
    }
    const httpsAgent = new https.Agent({
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      keepAlive: false,
    });
    client = new S3Client({
      region: 'auto',
      endpoint: ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({ httpsAgent }),
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
  const ct = contentType ?? 'video/mp4';
  const s3 = getClient();
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: ct,
  });
  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const tmpPath = path.join(os.tmpdir(), `r2-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(tmpPath, buffer);
  try {
    await new Promise<void>((resolve, reject) => {
      const curl = spawn('curl', [
        '-s', '-S', '-X', 'PUT', '-T', tmpPath,
        '-H', `Content-Type: ${ct}`,
        '--retry', '2',
        presignedUrl,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      curl.stderr?.on('data', (d) => { stderr += d.toString(); });
      curl.on('close', (code) => {
        if (code === 0) resolve();
        else {
          console.error(`[R2] Curl failed: ${stderr}`);
          reject(new Error(`curl upload failed: ${code} - ${stderr}`));
        }
      });
      curl.on('error', (err) => {
        console.error(`[R2] Spawn error: ${err}`);
        reject(err);
      });
    });
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
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
