const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.S3_BUCKET || 'zlp-media';
const PUBLIC_URL = (process.env.S3_PUBLIC_URL || '').replace(/\/$/, '');

async function uploadFile(key, buffer, contentType = 'image/jpeg') {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
}

function publicUrl(key) {
  return `${PUBLIC_URL}/${BUCKET}/${key}`;
}

module.exports = { uploadFile, publicUrl, BUCKET };
