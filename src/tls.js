// Self-signed TLS material, generated at boot. Nothing is committed to the
// repository and nothing is baked into the image (spec section 5).
//
// The certificate is written to a directory that KyPost Server mounts read-only
// and points SSL_CERT_DIR at, so its Go TLS clients trust this sandbox host and
// nothing else. The private key never leaves this container's filesystem.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export function ensureCert({ keyDir, publishDir, hostnames, ips, log }) {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  mkdirSync(publishDir, { recursive: true, mode: 0o755 });
  const keyPath = join(keyDir, 'server.key');
  const certPath = join(keyDir, 'server.crt');

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const san = [...hostnames.map((h) => `DNS:${h}`), ...ips.map((i) => `IP:${i}`)].join(',');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', `/CN=${hostnames[0]}`,
      '-addext', `subjectAltName=${san}`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
      '-addext', 'extendedKeyUsage=serverAuth',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chmodSync(keyPath, 0o600);
    log('generated self-signed certificate', { san });
  }

  const cert = readFileSync(certPath);
  // Published for KyPost Server to trust. Certificate only — never the key.
  writeFileSync(join(publishDir, 'kypost-demo-mail.crt'), cert, { mode: 0o644 });

  return { key: readFileSync(keyPath), cert };
}
