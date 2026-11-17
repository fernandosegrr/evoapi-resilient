const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { Client } = require('minio');

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return server.address().port;
}
test('AWS SQS client serializes and parses a local signed SendMessage without real credentials', async (t) => {
  let request;
  const port = await endpoint(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.0' });
    res.end(
      JSON.stringify({
        MessageId: 'synthetic-id',
        MD5OfMessageBody: createHash('md5').update(request.MessageBody).digest('hex'),
      }),
    );
  });
  const client = new SQSClient({
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${port}`,
    maxAttempts: 1,
    credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'SYNTHETIC-NOT-A-CREDENTIAL' },
  });
  try {
    const result = await client.send(
      new SendMessageCommand({ QueueUrl: `http://127.0.0.1:${port}/queue`, MessageBody: 'fixture' }),
    );
    assert.equal(result.MessageId, 'synthetic-id');
    assert.equal(request.MessageBody, 'fixture');
  } finally {
    client.destroy();
  }
});
test('MinIO client parses bucket XML from an isolated local S3 fixture', async (t) => {
  const port = await endpoint(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(
      '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>synthetic</ID><DisplayName>Fixture</DisplayName></Owner><Buckets><Bucket><Name>synthetic-bucket</Name><CreationDate>2026-11-16T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>',
    );
  });
  const client = new Client({
    endPoint: '127.0.0.1',
    port,
    useSSL: false,
    accessKey: 'SYNTHETIC',
    secretKey: 'SYNTHETIC-NOT-A-CREDENTIAL',
  });
  const buckets = await client.listBuckets();
  assert.equal(buckets[0].name, 'synthetic-bucket');
});
