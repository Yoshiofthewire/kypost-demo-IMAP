// Container healthcheck against the HTTPS listener over loopback.
//
// The certificate is self-signed, but it is also published to disk by this same
// process, so the check pins it as the CA rather than disabling verification —
// a healthcheck that accepts any certificate is a healthcheck that would pass
// against something that is not us.
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ca = readFileSync(join(process.env.TLS_PUBLISH_DIR || '/srv/tls-public', 'kypost-demo-mail.crt'));

const req = request(
  {
    host: '127.0.0.1',
    port: Number(process.env.HTTPS_PORT || 443),
    path: '/healthz',
    timeout: 3000,
    ca,
    servername: 'localhost',
  },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1)
);
req.on('error', () => process.exit(1));
req.on('timeout', () => process.exit(1));
req.end();
