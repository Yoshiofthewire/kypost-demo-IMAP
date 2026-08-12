// Seed payloads for the three demo personas. Everything here is fake: the PGP
// blocks are hardcoded text, not real ciphertext (spec section 2, "Zero Real
// Cryptography Overhead").

const crlf = (s) => s.replace(/\r?\n/g, '\r\n').replace(/^\r\n/, '');

// Mock ASCII-armored key, shared shape for every seeded contact.
const mockKey = (owner) =>
  [
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    'Comment: KyPost demo key for ' + owner,
    '',
    'mDMEZKyPost0BCADemoKeyMaterialNotRealJustPaddingForClientParsingTests',
    'AAAAB3NzaC1yc2EAAAADAQABAAABgQDemoDemoDemoDemoDemoDemoDemoDemoDemo',
    'RGVtbyBrZXkgYm9keSBmb3IgJyArIG93bmVyICsgJyAtIG5vdCBhIHJlYWwga2V5Lg==',
    '=DEMO',
    '-----END PGP PUBLIC KEY BLOCK-----',
  ].join('\n');

const PGP_MESSAGE = [
  '-----BEGIN PGP MESSAGE-----',
  'Version: KyPost Demo 1.0',
  '',
  'hQEMA1234567890abDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDe',
  'moDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoDemoD',
  'VGhpcyBpcyBub3QgcmVhbCBjaXBoZXJ0ZXh0LiBLeVBvc3QgZGVtbyBwYXlsb2FkLg==',
  '=dEMo',
  '-----END PGP MESSAGE-----',
].join('\n');

const PGP_SIGNATURE = [
  '-----BEGIN PGP SIGNATURE-----',
  '',
  'iQEzBAEBCgAdFiEEDemoDemoDemoDemoDemoDemoDemoFAmSsj3AACgkQDemoDemoD',
  'VGhpcyBzaWduYXR1cmUgaXMgYSBkZW1vIHBsYWNlaG9sZGVyIG9ubHku',
  '=SiGn',
  '-----END PGP SIGNATURE-----',
].join('\n');

// A small but non-trivial attachment: 4 KiB of base64 so charlie's persona
// exercises the client's attachment path without bloating the image.
const bigAttachment = () => {
  const line = 'S3lQb3N0IGRlbW8gYXR0YWNobWVudCBwYXlsb2FkIGxpbmUgLS0gbm90IHJlYWwu';
  return Array(64).fill(line).join('\n');
};

const D = (iso) => new Date(iso);

// Each entry: {folder, flags, date, raw}. Raw bodies are authored with \n and
// normalised to CRLF on load.
export const SEED = {
  alice: {
    address: 'alice@kypost-demo.local',
    displayName: 'Alice Demo',
    messages: [
      {
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-10T09:15:00Z'),
        raw: `From: Dana Ops <dana@kypost-demo.local>
To: Alice Demo <alice@kypost-demo.local>
Subject: Welcome to the KyPost sandbox
Date: Mon, 10 Aug 2026 09:15:00 +0000
Message-ID: <alice-001@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Hi Alice,

This mailbox is served by the KyPost demo mail server. Nothing here ever
leaves the sandbox network.

-- Dana
`,
      },
      {
        folder: 'INBOX',
        flags: ['\\Seen'],
        date: D('2026-08-10T11:02:00Z'),
        raw: `From: KyPost Newsletter <news@kypost-demo.local>
To: Alice Demo <alice@kypost-demo.local>
Subject: =?utf-8?q?Your_weekly_digest_=E2=9C=89?=
Date: Mon, 10 Aug 2026 11:02:00 +0000
Message-ID: <alice-002@kypost-demo.local>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="alt-002"

--alt-002
Content-Type: text/plain; charset=utf-8

Weekly digest: three new items are waiting for you.

--alt-002
Content-Type: text/html; charset=utf-8

<html><body><h1>Weekly digest</h1><p>Three <b>new items</b> are waiting
for you.</p></body></html>

--alt-002--
`,
      },
      {
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-11T08:00:00Z'),
        raw: `From: Alice Demo <alice@kypost-demo.local>
To: Bob Demo <bob@kypost-demo.local>, Charlie Demo <charlie@kypost-demo.local>
Cc: Dana Ops <dana@kypost-demo.local>
Subject: Re: Sandbox rollout plan
Date: Tue, 11 Aug 2026 08:00:00 +0000
Message-ID: <alice-003@kypost-demo.local>
In-Reply-To: <thread-root@kypost-demo.local>
References: <thread-root@kypost-demo.local> <thread-002@kypost-demo.local> <thread-003@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Agreed on all three points. Deep thread headers included on purpose so the
client's threading code has something to chew on.
`,
      },
      {
        // Edge case: no body at all.
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-11T08:30:00Z'),
        raw: `From: Silent Sender <silent@kypost-demo.local>
To: Alice Demo <alice@kypost-demo.local>
Subject: (no body)
Date: Tue, 11 Aug 2026 08:30:00 +0000
Message-ID: <alice-004@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

`,
      },
      {
        folder: 'Drafts',
        flags: ['\\Draft'],
        date: D('2026-08-11T09:00:00Z'),
        raw: `From: Alice Demo <alice@kypost-demo.local>
To: Bob Demo <bob@kypost-demo.local>
Subject: Draft: lunch?
Date: Tue, 11 Aug 2026 09:00:00 +0000
Message-ID: <alice-005@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Still writing this one.
`,
      },
      {
        folder: 'Archive',
        flags: ['\\Seen'],
        date: D('2026-07-01T12:00:00Z'),
        raw: `From: Dana Ops <dana@kypost-demo.local>
To: Alice Demo <alice@kypost-demo.local>
Subject: Archived: Q2 wrap-up
Date: Tue, 01 Jul 2026 12:00:00 +0000
Message-ID: <alice-006@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Filed away for reference.
`,
      },
    ],
    contacts: [
      { uid: 'alice-c1', name: 'Bob Demo', email: 'bob@kypost-demo.local', key: mockKey('bob@kypost-demo.local') },
      { uid: 'alice-c2', name: 'Charlie Demo', email: 'charlie@kypost-demo.local', key: mockKey('charlie@kypost-demo.local') },
      { uid: 'alice-c3', name: 'Dana Ops', email: 'dana@kypost-demo.local', key: null },
      { uid: 'alice-c4', name: 'Multi Recipient List', email: 'team@kypost-demo.local', key: null },
    ],
  },

  bob: {
    address: 'bob@kypost-demo.local',
    displayName: 'Bob Demo',
    messages: [
      {
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-10T10:00:00Z'),
        raw: `From: Alice Demo <alice@kypost-demo.local>
To: Bob Demo <bob@kypost-demo.local>
Subject: Encrypted: budget numbers
Date: Mon, 10 Aug 2026 10:00:00 +0000
Message-ID: <bob-001@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

${PGP_MESSAGE}
`,
      },
      {
        // PGP/MIME (RFC 3156) envelope.
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-10T10:30:00Z'),
        raw: `From: Charlie Demo <charlie@kypost-demo.local>
To: Bob Demo <bob@kypost-demo.local>
Subject: PGP/MIME encrypted report
Date: Mon, 10 Aug 2026 10:30:00 +0000
Message-ID: <bob-002@kypost-demo.local>
MIME-Version: 1.0
Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="pgp-002"

--pgp-002
Content-Type: application/pgp-encrypted
Content-Description: PGP/MIME version identification

Version: 1

--pgp-002
Content-Type: application/octet-stream; name="encrypted.asc"
Content-Description: OpenPGP encrypted message
Content-Disposition: inline; filename="encrypted.asc"

${PGP_MESSAGE}

--pgp-002--
`,
      },
      {
        // Clear-signed message.
        folder: 'INBOX',
        flags: ['\\Seen'],
        date: D('2026-08-11T07:45:00Z'),
        raw: `From: Dana Ops <dana@kypost-demo.local>
To: Bob Demo <bob@kypost-demo.local>
Subject: Signed announcement
Date: Tue, 11 Aug 2026 07:45:00 +0000
Message-ID: <bob-003@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

Maintenance window moved to Thursday.

${PGP_SIGNATURE}
`,
      },
      {
        // Edge case: MIME boundary declared but never closed.
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-11T09:20:00Z'),
        raw: `From: Broken Mailer <broken@kypost-demo.local>
To: Bob Demo <bob@kypost-demo.local>
Subject: Malformed MIME boundary
Date: Tue, 11 Aug 2026 09:20:00 +0000
Message-ID: <bob-004@kypost-demo.local>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="never-closed"

--never-closed
Content-Type: text/plain; charset=utf-8

The closing boundary for this message is missing on purpose.
`,
      },
      {
        folder: 'Sent Items',
        flags: ['\\Seen'],
        date: D('2026-08-09T16:00:00Z'),
        raw: `From: Bob Demo <bob@kypost-demo.local>
To: Alice Demo <alice@kypost-demo.local>
Subject: Encrypted reply
Date: Sun, 09 Aug 2026 16:00:00 +0000
Message-ID: <bob-005@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

${PGP_MESSAGE}
`,
      },
    ],
    contacts: [
      { uid: 'bob-c1', name: 'Alice Demo', email: 'alice@kypost-demo.local', key: mockKey('alice@kypost-demo.local') },
      { uid: 'bob-c2', name: 'Charlie Demo', email: 'charlie@kypost-demo.local', key: mockKey('charlie@kypost-demo.local') },
      // Key rotation case: same address, second (newer) key entry.
      { uid: 'bob-c3', name: 'Charlie Demo (rotated key)', email: 'charlie@kypost-demo.local', key: mockKey('charlie@kypost-demo.local rotated') },
      // Missing-key case.
      { uid: 'bob-c4', name: 'Nokey Nelson', email: 'nokey@kypost-demo.local', key: null },
      // Malformed-key case.
      { uid: 'bob-c5', name: 'Broken Key Bianchi', email: 'brokenkey@kypost-demo.local', key: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nthis armor never terminates' },
    ],
  },

  charlie: {
    address: 'charlie@kypost-demo.local',
    displayName: 'Charlie Demo',
    messages: [
      {
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-10T13:00:00Z'),
        raw: `From: Alice Demo <alice@kypost-demo.local>
To: Charlie Demo <charlie@kypost-demo.local>
Subject: Quarterly deck attached
Date: Mon, 10 Aug 2026 13:00:00 +0000
Message-ID: <charlie-001@kypost-demo.local>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mix-001"

--mix-001
Content-Type: text/plain; charset=utf-8

Deck attached. Let me know if the numbers on slide 4 look off.

--mix-001
Content-Type: application/pdf; name="quarterly.pdf"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="quarterly.pdf"

${bigAttachment()}

--mix-001--
`,
      },
      {
        folder: 'INBOX',
        flags: [],
        date: D('2026-08-10T14:20:00Z'),
        raw: `From: Photo Bot <photos@kypost-demo.local>
To: Charlie Demo <charlie@kypost-demo.local>
Subject: Mixed MIME with inline image
Date: Mon, 10 Aug 2026 14:20:00 +0000
Message-ID: <charlie-002@kypost-demo.local>
MIME-Version: 1.0
Content-Type: multipart/related; boundary="rel-002"

--rel-002
Content-Type: text/html; charset=utf-8

<html><body><p>Inline image below:</p><img src="cid:demo-image"></body></html>

--rel-002
Content-Type: image/png; name="pixel.png"
Content-Transfer-Encoding: base64
Content-ID: <demo-image>
Content-Disposition: inline; filename="pixel.png"

iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhQGAhKmM
IQAAAABJRU5ErkJggg==

--rel-002--
`,
      },
      {
        // Edge case: 8-bit body with a charset the client has to fall back on.
        folder: 'INBOX',
        flags: ['\\Seen'],
        date: D('2026-08-11T06:10:00Z'),
        raw: `From: Legacy System <legacy@kypost-demo.local>
To: Charlie Demo <charlie@kypost-demo.local>, Alice Demo <alice@kypost-demo.local>
Cc: Bob Demo <bob@kypost-demo.local>
Bcc: audit@kypost-demo.local
Subject: Legacy charset and many recipients
Date: Tue, 11 Aug 2026 06:10:00 +0000
Message-ID: <charlie-003@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Caf=E9 report attached separately. Accented bytes on purpose.
`,
      },
      {
        folder: 'Trash',
        flags: ['\\Seen'],
        date: D('2026-08-08T18:00:00Z'),
        raw: `From: Spam Cannon <spam@kypost-demo.local>
To: Charlie Demo <charlie@kypost-demo.local>
Subject: Deleted already
Date: Fri, 08 Aug 2026 18:00:00 +0000
Message-ID: <charlie-004@kypost-demo.local>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Sitting in Trash so the client has something to empty.
`,
      },
    ],
    contacts: [
      { uid: 'charlie-c1', name: 'Alice Demo', email: 'alice@kypost-demo.local', key: mockKey('alice@kypost-demo.local') },
      { uid: 'charlie-c2', name: 'Bob Demo', email: 'bob@kypost-demo.local', key: mockKey('bob@kypost-demo.local') },
      // Duplicate address, different contact card.
      { uid: 'charlie-c3', name: 'Bob (personal)', email: 'bob@kypost-demo.local', key: mockKey('bob@kypost-demo.local personal') },
    ],
  },
};

export const FOLDERS = ['INBOX', 'Drafts', 'Sent Items', 'Trash', 'Archive'];

export function vcardFor(c) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    `UID:${c.uid}`,
    `FN:${c.name}`,
    `N:${c.name.split(' ').slice(1).join(' ')};${c.name.split(' ')[0]};;;`,
    `EMAIL;TYPE=work:${c.email}`,
  ];
  if (c.key) lines.push(`KEY:data:application/pgp-keys;base64,${Buffer.from(c.key).toString('base64')}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

export function seedMessages(persona) {
  return SEED[persona].messages.map((m) => ({ ...m, raw: crlf(m.raw) }));
}
