// Acceptance tests for the KyPost Demo Mail Server, driven by the exact client
// KyPost Server uses (github.com/BrianLeishman/go-imap) plus net/smtp and
// net/http. They cover the list in PROMPT.md section 4E.
//
// The IMAP client is deliberately NOT told to skip certificate verification:
// the test sets SSL_CERT_DIR to the directory the server publishes its
// certificate into, which is the same mechanism docker-compose.yml wires up.
package acceptance

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	goimap "github.com/BrianLeishman/go-imap"
)

const (
	host       = "127.0.0.1"
	imapPort   = 19930
	smtpPort   = 15870
	httpsPort  = 14430
	resetToken = "acceptance-token-0123456789"
)

var certPool *x509.CertPool

// Go's system cert pool is cached process-wide behind a sync.Once
// (crypto/x509/root.go): the first TLS dial in the binary locks it in, and no
// later os.Setenv("SSL_CERT_DIR", ...) can add to it. A second server instance
// therefore cannot be trusted by handing goimap a different cert directory —
// it must present the exact same certificate TestMain's already did. Reusing
// TestMain's key directory makes ensureCert (src/tls.js) skip regeneration and
// reuse that identical key+cert, which is what mainKeyDir is for.
var mainKeyDir string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "kypost-demo-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	keyDir := filepath.Join(dir, "key")
	pubDir := filepath.Join(dir, "pub")
	mainKeyDir = keyDir

	root, err := filepath.Abs("../..")
	if err != nil {
		panic(err)
	}
	cmd := exec.Command("node", filepath.Join(root, "src", "index.js"))
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("IMAP_PORT=%d", imapPort),
		fmt.Sprintf("SMTP_PORT=%d", smtpPort),
		fmt.Sprintf("HTTPS_PORT=%d", httpsPort),
		"BIND_ADDRESS=127.0.0.1",
		"TLS_KEY_DIR="+keyDir,
		"TLS_PUBLISH_DIR="+pubDir,
		"RESET_ENABLED=true",
		"RESET_TOKEN="+resetToken,
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		panic(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	if err := waitForPort(fmt.Sprintf("%s:%d", host, imapPort), 15*time.Second); err != nil {
		panic(err)
	}

	// Trust the sandbox certificate the same way the compose file does.
	if err := os.Setenv("SSL_CERT_DIR", "/etc/ssl/certs:"+pubDir); err != nil {
		panic(err)
	}
	pem, err := os.ReadFile(filepath.Join(pubDir, "kypost-demo-mail.crt"))
	if err != nil {
		panic(err)
	}
	certPool = x509.NewCertPool()
	if !certPool.AppendCertsFromPEM(pem) {
		panic("published certificate is not valid PEM")
	}

	code := m.Run()
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	os.Exit(code)
}

func waitForPort(addr string, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			_ = c.Close()
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timed out waiting for %s", addr)
}

func dial(t *testing.T, user string) *goimap.Dialer {
	t.Helper()
	goimap.RetryCount = 0
	d, err := goimap.New(user, "any-password", host, imapPort)
	if err != nil {
		t.Fatalf("connect as %s: %v", user, err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// The certificate must verify against a normal root pool — no InsecureSkipVerify
// anywhere, because KyPost Server has none either.
func TestTLSTrustedByDefaultVerification(t *testing.T) {
	if goimap.TLSSkipVerify {
		t.Fatal("test would be meaningless with TLSSkipVerify set")
	}
	d := dial(t, "alice@kypost-demo.local")
	if !d.Connected {
		t.Fatal("dialer reports not connected")
	}
}

// The allowlist has to bite before the TLS handshake, so an unlisted peer never
// even sees which certificate this host presents. The server is bound to
// 127.0.0.1 with only loopback allowed, so this drives it the other way round:
// a permitted peer must get a greeting, and the rejection path is exercised by
// pointing the allowlist somewhere else.
func TestPermittedPeerGetsAGreeting(t *testing.T) {
	conn, err := tls.Dial("tcp", fmt.Sprintf("%s:%d", host, imapPort),
		&tls.Config{RootCAs: certPool, ServerName: "localhost", MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 128)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("read greeting: %v", err)
	}
	if !strings.HasPrefix(string(buf[:n]), "* OK") {
		t.Errorf("greeting = %q, want a * OK line", buf[:n])
	}
}

func TestUnlistedPeerIsDroppedBeforeHandshake(t *testing.T) {
	// A second server instance whose allowlist deliberately excludes loopback.
	dir := t.TempDir()
	cmd := exec.Command("node", "../../src/index.js")
	cmd.Env = append(os.Environ(),
		"IMAP_PORT=19931", "SMTP_PORT=15871", "HTTPS_PORT=14431",
		"BIND_ADDRESS=127.0.0.1",
		"TLS_KEY_DIR="+filepath.Join(dir, "key"),
		"TLS_PUBLISH_DIR="+filepath.Join(dir, "pub"),
		"ALLOWED_CLIENT_IPS=172.30.0.10",
		"RESET_ENABLED=false", "RESET_TOKEN=",
	)
	cmd.Stdout = io.Discard
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()
	if err := waitForPort("127.0.0.1:19931", 15*time.Second); err != nil {
		t.Fatal(err)
	}

	conn, err := tls.Dial("tcp", "127.0.0.1:19931",
		&tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}) // #nosec G402 -- asserting the handshake never completes
	if err == nil {
		_ = conn.Close()
		t.Fatal("handshake succeeded for an unlisted peer; the guard runs too late")
	}
}

func TestFoldersExposed(t *testing.T) {
	d := dial(t, "alice@kypost-demo.local")
	folders, err := d.GetFolders()
	if err != nil {
		t.Fatalf("GetFolders: %v", err)
	}
	for _, want := range []string{"INBOX", "Drafts", "Sent Items", "Trash", "Archive"} {
		if !contains(folders, want) {
			t.Errorf("folder %q missing from %v", want, folders)
		}
	}
}

func TestReadSeededMailForEveryPersona(t *testing.T) {
	for user, wantFrom := range map[string]string{
		"alice@kypost-demo.local":   "dana@kypost-demo.local",
		"bob@kypost-demo.local":     "alice@kypost-demo.local",
		"charlie@kypost-demo.local": "alice@kypost-demo.local",
	} {
		d := dial(t, user)
		if err := d.SelectFolder("INBOX"); err != nil {
			t.Fatalf("%s SELECT INBOX: %v", user, err)
		}
		uids, err := d.GetUIDs("ALL")
		if err != nil {
			t.Fatalf("%s UID SEARCH ALL: %v", user, err)
		}
		if len(uids) == 0 {
			t.Fatalf("%s has an empty seeded INBOX", user)
		}
		emails, err := d.GetEmails(uids...)
		if err != nil {
			t.Fatalf("%s GetEmails: %v", user, err)
		}
		if len(emails) != len(uids) {
			t.Errorf("%s: fetched %d of %d messages", user, len(emails), len(uids))
		}
		first, ok := emails[uids[0]]
		if !ok {
			t.Fatalf("%s: first UID %d missing from fetch", user, uids[0])
		}
		if first.Subject == "" {
			t.Errorf("%s: first message has no subject", user)
		}
		if _, ok := first.From[wantFrom]; !ok {
			t.Errorf("%s: first message From is %v, want %s", user, first.From, wantFrom)
		}
		if first.Size == 0 {
			t.Errorf("%s: RFC822.SIZE was zero", user)
		}
		if first.Received.IsZero() {
			t.Errorf("%s: INTERNALDATE did not parse", user)
		}
	}
}

func TestPGPPayloadsSurviveIntact(t *testing.T) {
	d := dial(t, "bob@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	emails, err := d.GetEmails(uids...)
	if err != nil {
		t.Fatal(err)
	}
	var pgp int
	for _, e := range emails {
		if strings.Contains(e.Text, "BEGIN PGP MESSAGE") || strings.Contains(e.Text, "BEGIN PGP SIGNED MESSAGE") {
			pgp++
		}
		for _, a := range e.Attachments {
			if strings.Contains(string(a.Content), "BEGIN PGP MESSAGE") {
				pgp++
			}
		}
	}
	if pgp < 2 {
		t.Errorf("expected bob's inbox to carry at least 2 PGP payloads, found %d", pgp)
	}
}

func TestMaxUIDUsesESEARCH(t *testing.T) {
	d := dial(t, "alice@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	max, err := d.GetMaxUID()
	if err != nil {
		t.Fatalf("GetMaxUID: %v", err)
	}
	if max != uids[len(uids)-1] {
		t.Errorf("GetMaxUID = %d, want %d", max, uids[len(uids)-1])
	}
}

func TestSearchCriteriaUsedByKyPostServer(t *testing.T) {
	d := dial(t, "alice@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	unseen, err := d.SearchUIDs(goimap.Search().Unseen())
	if err != nil {
		t.Fatalf("UNSEEN search: %v", err)
	}
	if len(unseen) == 0 {
		t.Error("expected some unseen seeded mail")
	}
	// The oversize probe KyPost Server runs on every poll.
	oversize, err := d.SearchUIDs(goimap.Search().Unseen().Larger(25 * 1024 * 1024))
	if err != nil {
		t.Fatalf("UNSEEN LARGER search: %v", err)
	}
	if len(oversize) != 0 {
		t.Errorf("no seeded message is over 25 MiB, got %v", oversize)
	}
	hits, err := d.SearchUIDs(goimap.Search().Subject("sandbox"))
	if err != nil {
		t.Fatalf("SUBJECT search: %v", err)
	}
	if len(hits) == 0 {
		t.Error("SUBJECT search found nothing")
	}
}

func TestHeaderFieldsFetch(t *testing.T) {
	d := dial(t, "alice@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	// Byte-for-byte the command shape kypost-server's fetchHeaderFieldsLocked builds.
	cmd := fmt.Sprintf("UID FETCH %d BODY.PEEK[HEADER.FIELDS (Message-Id Subject)]", uids[0])
	raw, err := d.Exec(cmd, true, 0, nil)
	if err != nil {
		t.Fatalf("%s: %v", cmd, err)
	}
	records, err := d.ParseFetchResponse(raw)
	if err != nil {
		t.Fatalf("parse header fields response: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}
	if !strings.Contains(raw, "Message-ID:") && !strings.Contains(raw, "Message-Id:") {
		t.Errorf("header fields fetch did not return Message-ID: %q", raw)
	}
}

func TestFlagsAndKeywordLabels(t *testing.T) {
	d := dial(t, "alice@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	uid := uids[0]

	if err := d.SetFlags(uid, goimap.Flags{Keywords: map[string]bool{"KyPostLabel": true}}); err != nil {
		t.Fatalf("add label: %v", err)
	}
	if err := d.MarkSeen(uid); err != nil {
		t.Fatalf("MarkSeen: %v", err)
	}
	got := flagsOf(t, d, uid)
	if !contains(got, "KyPostLabel") {
		t.Errorf("label not persisted, flags = %v", got)
	}
	if !contains(got, `\Seen`) {
		t.Errorf("\\Seen not persisted, flags = %v", got)
	}

	if err := d.SetFlags(uid, goimap.Flags{Keywords: map[string]bool{"KyPostLabel": false}}); err != nil {
		t.Fatalf("remove label: %v", err)
	}
	if got := flagsOf(t, d, uid); contains(got, "KyPostLabel") {
		t.Errorf("label not removed, flags = %v", got)
	}
}

func TestAppendCopyMoveDelete(t *testing.T) {
	d := dial(t, "charlie@kypost-demo.local")

	raw := []byte("From: Charlie Demo <charlie@kypost-demo.local>\r\n" +
		"To: Alice Demo <alice@kypost-demo.local>\r\n" +
		"Subject: Appended draft\r\n" +
		"Message-ID: <appended-1@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 12:00:00 +0000\r\n\r\nBody text.\r\n")
	if err := d.Append("Drafts", []string{`\Draft`}, time.Now(), raw); err != nil {
		t.Fatalf("APPEND: %v", err)
	}

	if err := d.SelectFolder("Drafts"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(uids) == 0 {
		t.Fatal("appended message not visible in Drafts")
	}
	uid := uids[len(uids)-1]

	if err := d.CopyEmail(uid, "Archive"); err != nil {
		t.Fatalf("UID COPY: %v", err)
	}
	if err := d.SelectFolder("Archive"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, "Appended draft"); n != 1 {
		t.Errorf("copy: Archive holds %d copies, want 1", n)
	}

	// MoveEmail leaves the dialer pointing at the destination folder.
	if err := d.SelectFolder("Drafts"); err != nil {
		t.Fatal(err)
	}
	if err := d.MoveEmail(uid, "Trash"); err != nil {
		t.Fatalf("UID MOVE: %v", err)
	}
	if err := d.SelectFolder("Drafts"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, "Appended draft"); n != 0 {
		t.Errorf("move: %d copies still in Drafts, want 0", n)
	}
	if err := d.SelectFolder("Trash"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, "Appended draft"); n != 1 {
		t.Fatalf("move: Trash holds %d copies, want 1", n)
	}

	trashUIDs, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	before := len(trashUIDs)
	if err := d.DeleteEmail(trashUIDs[len(trashUIDs)-1]); err != nil {
		t.Fatalf("mark deleted: %v", err)
	}
	if err := d.Expunge(); err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	after, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != before-1 {
		t.Errorf("expunge removed %d messages, want 1", before-len(after))
	}
}

func TestSMTPBlackHoleFilesIntoSentItems(t *testing.T) {
	subject := "Sent through the black hole"
	msg := []byte("From: Alice Demo <alice@kypost-demo.local>\r\n" +
		"To: Bob Demo <bob@kypost-demo.local>\r\n" +
		"Subject: " + subject + "\r\n" +
		"Message-ID: <smtp-1@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 13:00:00 +0000\r\n\r\nHello from SMTP.\r\n")

	if err := submit("alice@kypost-demo.local", []string{"bob@kypost-demo.local"}, msg); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}

	d := dial(t, "alice@kypost-demo.local")
	if err := d.SelectFolder("Sent Items"); err != nil {
		t.Fatalf("SELECT Sent Items: %v", err)
	}
	if n := countMatching(t, d, subject); n != 1 {
		t.Errorf("Sent Items holds %d copies of the sent message, want 1", n)
	}
}

// KyPost Server APPENDs its own Sent copy after submitting. The tray must not
// end up with the same message twice.
func TestSentCopyIsNotDuplicated(t *testing.T) {
	subject := "Duplicate guard"
	raw := []byte("From: Bob Demo <bob@kypost-demo.local>\r\n" +
		"To: Alice Demo <alice@kypost-demo.local>\r\n" +
		"Subject: " + subject + "\r\n" +
		"Message-ID: <dupe-1@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 14:00:00 +0000\r\n\r\nOnce only.\r\n")

	if err := submit("bob@kypost-demo.local", []string{"alice@kypost-demo.local"}, raw); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}
	d := dial(t, "bob@kypost-demo.local")
	// "Sent" is what KyPost Server's SaveSent tries first; it must alias.
	if err := d.Append("Sent", nil, time.Now(), raw); err != nil {
		t.Fatalf("APPEND to Sent: %v", err)
	}
	if err := d.SelectFolder("Sent Items"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, subject); n != 1 {
		t.Errorf("Sent Items holds %d copies, want 1", n)
	}
}

func TestCardDAVReadWrite(t *testing.T) {
	client := httpsClient()
	base := fmt.Sprintf("https://%s:%d/carddav/bob/", host, httpsPort)

	body := doDAV(t, client, "PROPFIND", base, "1", `<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:resourcetype/></D:prop></D:propfind>`, http.StatusMultiStatus)
	if !strings.Contains(body, "addressbook") {
		t.Errorf("PROPFIND did not report an addressbook collection: %s", body)
	}
	if !strings.Contains(body, "bob-c1.vcf") {
		t.Errorf("PROPFIND Depth:1 did not list seeded contacts: %s", body)
	}

	report := doDAV(t, client, "REPORT", base, "1", `<?xml version="1.0"?><C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop></C:addressbook-query>`, http.StatusMultiStatus)
	if !strings.Contains(report, "BEGIN:VCARD") {
		t.Errorf("REPORT returned no vCard data: %s", report)
	}
	if !strings.Contains(report, "application/pgp-keys") {
		t.Errorf("seeded contacts carry no PGP key: %s", report)
	}

	card := "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:test-new\r\nFN:Test New\r\nEMAIL:new@kypost-demo.local\r\nEND:VCARD\r\n"
	doDAV(t, client, "PUT", base+"test-new.vcf", "", card, http.StatusCreated)

	got := doDAV(t, client, "GET", base+"test-new.vcf", "", "", http.StatusOK)
	if !strings.Contains(got, "FN:Test New") {
		t.Errorf("created contact did not read back: %s", got)
	}

	doDAV(t, client, "DELETE", base+"test-new.vcf", "", "", http.StatusNoContent)
	doDAV(t, client, "GET", base+"test-new.vcf", "", "", http.StatusNotFound)
}

func TestResetRestoresSeedState(t *testing.T) {
	client := httpsClient()
	base := fmt.Sprintf("https://%s:%d", host, httpsPort)

	// Change something, then prove reset undoes it.
	card := "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:reset-probe\r\nFN:Reset Probe\r\nEND:VCARD\r\n"
	doDAV(t, client, "PUT", base+"/carddav/alice/reset-probe.vcf", "", card, http.StatusCreated)

	req, _ := http.NewRequest("POST", base+"/admin/reset", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("reset with a wrong token returned %d, want 401", resp.StatusCode)
	}

	req, _ = http.NewRequest("POST", base+"/admin/reset", nil)
	req.Header.Set("Authorization", "Bearer "+resetToken)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reset returned %d: %s", resp.StatusCode, out)
	}

	doDAV(t, client, "GET", base+"/carddav/alice/reset-probe.vcf", "", "", http.StatusNotFound)

	// Reset is idempotent.
	req, _ = http.NewRequest("POST", base+"/admin/reset", nil)
	req.Header.Set("Authorization", "Bearer "+resetToken)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("second reset returned %d, want 200", resp.StatusCode)
	}
}

// The App Store testing configuration: RESET_ENABLED unset. The endpoint must
// be inert, and it must stay inert whatever token is presented.
func TestResetDisabledIsTheDefault(t *testing.T) {
	dir := t.TempDir()
	pubDir := filepath.Join(dir, "pub")
	cmd := exec.Command("node", "../../src/index.js")
	cmd.Env = append(os.Environ(),
		"IMAP_PORT=19932", "SMTP_PORT=15872", "HTTPS_PORT=14432",
		"BIND_ADDRESS=127.0.0.1",
		"TLS_KEY_DIR="+filepath.Join(dir, "key"),
		"TLS_PUBLISH_DIR="+pubDir,
		"RESET_ENABLED=false", "RESET_TOKEN=",
	)
	cmd.Stdout = io.Discard
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()
	if err := waitForPort("127.0.0.1:14432", 15*time.Second); err != nil {
		t.Fatal(err)
	}

	pem, err := os.ReadFile(filepath.Join(pubDir, "kypost-demo-mail.crt"))
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(pem)
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "localhost", MinVersion: tls.VersionTLS12},
		},
	}

	for _, token := range []string{"", resetToken, "anything"} {
		req, _ := http.NewRequest("POST", "https://127.0.0.1:14432/admin/reset", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("reset with token %q returned %d, want 403", token, resp.StatusCode)
		}
	}
}

// Reset enabled without a usable token would be an unauthenticated wipe
// endpoint, so the process must refuse to start rather than come up open.
func TestRefusesToStartWithWeakResetToken(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("node", "../../src/index.js")
	cmd.Env = append(os.Environ(),
		"IMAP_PORT=19933", "SMTP_PORT=15873", "HTTPS_PORT=14433",
		"BIND_ADDRESS=127.0.0.1",
		"TLS_KEY_DIR="+filepath.Join(dir, "key"),
		"TLS_PUBLISH_DIR="+filepath.Join(dir, "pub"),
		"RESET_ENABLED=true", "RESET_TOKEN=short",
	)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err == nil {
		t.Fatal("server started with reset enabled and a 5-character token")
	}
}

// ------------------------------------------------- hardening regression tests

// A throwing HTTP request listener takes the whole process with it, and this
// process also serves IMAP and SMTP. `GET /%` was enough: decodeURIComponent
// raises URIError on a malformed escape, and a restart wipes every mailbox.
func TestMalformedPercentEscapeDoesNotKillTheProcess(t *testing.T) {
	client := httpsClient()
	base := fmt.Sprintf("https://%s:%d", host, httpsPort)

	for _, bad := range []string{"/%", "/%zz", "/carddav/alice/%zz.vcf", "/carddav/%/"} {
		req, err := http.NewRequest("GET", base+bad, nil)
		if err != nil {
			continue // net/http rejects it before the wire; nothing to test
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("GET %s: connection failed (server may have died): %v", bad, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode >= 500 {
			t.Errorf("GET %s returned %d, want a 4xx", bad, resp.StatusCode)
		}
	}

	// Still serving, and IMAP is still up too.
	doDAV(t, client, "GET", base+"/healthz", "", "", http.StatusOK)
	d := dial(t, "alice@kypost-demo.local")
	if _, err := d.GetFolders(); err != nil {
		t.Fatalf("IMAP broken after malformed CardDAV requests: %v", err)
	}
}

// LITERAL+ lets a client chain "{1+}" lines so a command never terminates.
// Bounding each literal is not enough; the accumulated command must be bounded.
func TestUnterminatedLiteralChainIsRefused(t *testing.T) {
	conn, err := tls.Dial("tcp", fmt.Sprintf("%s:%d", host, imapPort),
		&tls.Config{RootCAs: certPool, ServerName: "localhost", MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(60 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 256)
	if _, err := conn.Read(buf); err != nil { // greeting
		t.Fatal(err)
	}

	if _, err := conn.Write([]byte("A1 LOGIN {1+}\r\n")); err != nil {
		t.Fatal(err)
	}
	// Roughly 40 MiB of chained literals: past MAX_COMMAND, and enough that an
	// unbounded implementation is well into gigabytes of heap.
	chunk := []byte("X{1+}\r\n")
	var wrote int
	for wrote < 40*1024*1024 {
		n, err := conn.Write(chunk)
		wrote += n
		if err != nil {
			// The server closed on us, which is the point.
			return
		}
	}
	if _, err := conn.Read(buf); err == nil && !strings.Contains(string(buf), "BYE") {
		t.Errorf("server kept buffering a %d byte unterminated command", wrote)
	}
}

// The buffer check in onChunk drains line by line into the message, so a client
// that never sends the terminating dot used to grow it without limit.
func TestOversizeDataIsRefused(t *testing.T) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, smtpPort), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(60 * time.Second)); err != nil {
		t.Fatal(err)
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.StartTLS(&tls.Config{ServerName: host, RootCAs: certPool, MinVersion: tls.VersionTLS12}); err != nil {
		t.Fatal(err)
	}
	if err := c.Mail("alice@kypost-demo.local"); err != nil {
		t.Fatal(err)
	}
	if err := c.Rcpt("bob@kypost-demo.local"); err != nil {
		t.Fatal(err)
	}
	w, err := c.Data()
	if err != nil {
		t.Fatal(err)
	}
	line := append([]byte(strings.Repeat("A", 900)), '\r', '\n')
	for i := 0; i < 40*1024; i++ { // ~36 MiB, past the advertised 26 MiB
		if _, err := w.Write(line); err != nil {
			return // refused mid-stream, which is the point
		}
	}
	if err := w.Close(); err == nil {
		t.Error("server accepted a message larger than the advertised SIZE limit")
	}
}

// KyPost Server holds one IMAP connection open indefinitely. A reset that only
// swapped in fresh objects left that session on an orphaned mailbox, so the
// operation reported success while changing nothing for the real client.
func TestResetIsVisibleToAnOpenSession(t *testing.T) {
	d := dial(t, "charlie@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	before, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}

	raw := []byte("From: Charlie Demo <charlie@kypost-demo.local>\r\n" +
		"To: Alice Demo <alice@kypost-demo.local>\r\n" +
		"Subject: Survives reset?\r\n" +
		"Message-ID: <reset-visibility@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 15:00:00 +0000\r\n\r\nShould vanish.\r\n")
	if err := d.Append("INBOX", nil, time.Now(), raw); err != nil {
		t.Fatal(err)
	}
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, "Survives reset?"); n != 1 {
		t.Fatalf("appended message not visible before reset (%d copies)", n)
	}

	req, _ := http.NewRequest("POST", fmt.Sprintf("https://%s:%d/admin/reset", host, httpsPort), nil)
	req.Header.Set("Authorization", "Bearer "+resetToken)
	resp, err := httpsClient().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reset returned %d", resp.StatusCode)
	}

	// Same connection, no reconnect.
	if n := countMatching(t, d, "Survives reset?"); n != 0 {
		t.Errorf("the open session still sees %d copies after reset", n)
	}
	after, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Errorf("INBOX holds %d messages after reset, want the seeded %d", len(after), len(before))
	}
}

// A flag value carrying a CRLF is stored and replayed in every later FETCH, so
// one poisoned STORE would keep forging untagged responses at the real client.
func TestCRLFInjectionIsRefused(t *testing.T) {
	conn, err := tls.Dial("tcp", fmt.Sprintf("%s:%d", host, imapPort),
		&tls.Config{RootCAs: certPool, ServerName: "localhost", MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(conn)
	if _, err := r.ReadString('\n'); err != nil { // greeting
		t.Fatal(err)
	}

	send := func(s string) string {
		t.Helper()
		if _, err := conn.Write([]byte(s)); err != nil {
			t.Fatal(err)
		}
		var out strings.Builder
		for i := 0; i < 40; i++ {
			line, err := r.ReadString('\n')
			if err != nil {
				break
			}
			out.WriteString(line)
			if strings.HasPrefix(line, "A") || strings.HasPrefix(line, "* BAD") || strings.HasPrefix(line, "* BYE") {
				break
			}
		}
		return out.String()
	}

	// A literal-encoded tag containing a CRLF must not be echoed back.
	if got := send("{5+}\r\nA\r\nB LOGIN alice pass\r\n"); strings.Contains(got, "\r\nB ") {
		t.Errorf("literal tag with CRLF was echoed: %q", got)
	}

	_ = send("A1 LOGIN alice@kypost-demo.local pass\r\n")
	_ = send("A2 SELECT INBOX\r\n")
	// An unterminated quoted flag swallows the CRLF; the flag would persist.
	got := send("A3 STORE 1 +FLAGS (\"\r\n* 9999 EXISTS\r\n")
	if strings.Contains(got, "9999 EXISTS") {
		t.Errorf("forged untagged response echoed back: %q", got)
	}
	if got := send("A4 FETCH 1 (FLAGS)\r\n"); strings.Contains(got, "9999 EXISTS") {
		t.Errorf("poisoned flag persisted into a later FETCH: %q", got)
	}
}

// A HEADER or HEADER.FIELDS section ends with the blank line that terminates
// it; without it a Go client's MIME header reader hits EOF and drops a field.
func TestHeaderSectionsAreTerminated(t *testing.T) {
	d := dial(t, "alice@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := d.Exec(fmt.Sprintf("UID FETCH %d BODY.PEEK[HEADER.FIELDS (Subject)]", uids[0]), true, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	records, err := d.ParseFetchResponse(raw)
	if err != nil {
		t.Fatal(err)
	}
	var section string
	for _, tk := range records[0] {
		if tk.Type == goimap.TAtom {
			section = tk.Str
		}
	}
	if !strings.HasSuffix(section, "\r\n\r\n") {
		t.Errorf("header section %q does not end with a blank line", section)
	}
	if _, err := textproto.NewReader(bufio.NewReader(strings.NewReader(section))).ReadMIMEHeader(); err != nil {
		t.Errorf("header section is not parseable as MIME headers: %v", err)
	}
}

// IMAP and SMTP must agree on which persona a username means. IMAP used to
// match by substring and SMTP by exact local part, so "bob@alice-corp.test"
// read alice's mail while its Sent copies were filed under bob — the domain
// containing "alice" was enough, because alice is checked first.
func TestIMAPAndSMTPAgreeOnPersona(t *testing.T) {
	const user = "bob@alice-corp.test"
	subject := "Persona agreement probe"
	raw := []byte("From: Bob <" + user + ">\r\n" +
		"To: Alice Demo <alice@kypost-demo.local>\r\n" +
		"Subject: " + subject + "\r\n" +
		"Message-ID: <persona-agreement@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 16:00:00 +0000\r\n\r\nWhose Sent tray?\r\n")

	if err := submit(user, []string{"alice@kypost-demo.local"}, raw); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}

	// The local part is "bob", so both sides must land on bob.
	d := dial(t, user)
	if err := d.SelectFolder("Sent Items"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, subject); n != 1 {
		t.Errorf("the IMAP session for %q sees %d copies of its own sent mail, want 1", user, n)
	}
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	emails, err := d.GetOverviews(uids...)
	if err != nil {
		t.Fatal(err)
	}
	var sawBobsMail bool
	for _, e := range emails {
		if strings.Contains(e.Subject, "Encrypted: budget numbers") {
			sawBobsMail = true
		}
	}
	if !sawBobsMail {
		t.Error("IMAP resolved the local part 'bob' to a different persona than SMTP did")
	}
}

// Sending to a deliver-* address drops a corpus message into the sender's own
// INBOX. Matching ignores case and domain so a reviewer typing on a phone
// keyboard cannot miss.
func TestTriggerAddressDeliversToSenderInbox(t *testing.T) {
	d := dial(t, "trigger-user@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatalf("SELECT INBOX: %v", err)
	}
	before, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatalf("UID SEARCH ALL: %v", err)
	}

	msg := []byte("From: Trigger User <trigger-user@kypost-demo.local>\r\n" +
		"To: <DELIVER-Mail@Whatever.Example>\r\n" +
		"Subject: fire one\r\n" +
		"Message-ID: <trigger-1@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 15:00:00 +0000\r\n\r\nplease deliver\r\n")

	if err := submit("trigger-user@kypost-demo.local",
		[]string{"DELIVER-Mail@Whatever.Example"}, msg); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}

	after := waitForNewUID(t, "trigger-user@kypost-demo.local", "INBOX", len(before))
	if after <= len(before) {
		t.Fatalf("INBOX has %d messages, want more than %d", after, len(before))
	}
}

// The black hole stays unconditional: a trigger message is still filed into the
// sender's Sent Items exactly like any other submission.
func TestTriggerStillFilesIntoSentItems(t *testing.T) {
	subject := "trigger keeps the sent copy"
	msg := []byte("From: Sent Guard <sent-guard@kypost-demo.local>\r\n" +
		"To: <deliver-mail@kypost-demo.local>\r\n" +
		"Subject: " + subject + "\r\n" +
		"Message-ID: <trigger-2@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 15:10:00 +0000\r\n\r\nsent copy please\r\n")

	// The persona must exist before SMTP files against it: only LOGIN creates one.
	_ = dial(t, "sent-guard@kypost-demo.local")

	if err := submit("sent-guard@kypost-demo.local",
		[]string{"deliver-mail@kypost-demo.local"}, msg); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}

	d := dial(t, "sent-guard@kypost-demo.local")
	if err := d.SelectFolder("Sent Items"); err != nil {
		t.Fatal(err)
	}
	if n := countMatching(t, d, subject); n != 1 {
		t.Errorf("Sent Items holds %d copies of the trigger message, want 1", n)
	}
}

// Firing the same trigger twice must yield two messages. The corpus fixtures
// ship with fixed Message-IDs and addMessageDeduped drops duplicates, so this
// fails unless the ID is regenerated per delivery.
func TestRepeatedTriggerIsNotDeduplicated(t *testing.T) {
	user := "repeat-user@kypost-demo.local"
	d := dial(t, user)
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	before, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		msg := []byte("From: Repeat User <" + user + ">\r\n" +
			"To: <deliver-crypto-bad@kypost-demo.local>\r\n" +
			fmt.Sprintf("Subject: repeat %d\r\n", i) +
			fmt.Sprintf("Message-ID: <repeat-%d@kypost-demo.local>\r\n", i) +
			"Date: Tue, 11 Aug 2026 15:20:00 +0000\r\n\r\nagain\r\n")
		if err := submit(user, []string{"deliver-crypto-bad@kypost-demo.local"}, msg); err != nil {
			t.Fatalf("SMTP submit %d: %v", i, err)
		}
	}

	after := waitForNewUID(t, user, "INBOX", len(before)+1)
	if after < len(before)+2 {
		t.Errorf("INBOX gained %d messages, want 2", after-len(before))
	}
}

// go-imap hard-errors on an INTERNALDATE it cannot parse, so every injected
// message must carry one it accepts.
func TestInjectedMailHasParsableInternalDate(t *testing.T) {
	user := "internaldate-user@kypost-demo.local"
	d := dial(t, user)
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	before, _ := d.GetUIDs("ALL")

	msg := []byte("From: ID User <" + user + ">\r\n" +
		"To: <deliver-batch@kypost-demo.local>\r\n" +
		"Subject: everything\r\n" +
		"Message-ID: <internaldate-1@kypost-demo.local>\r\n" +
		"Date: Tue, 11 Aug 2026 15:30:00 +0000\r\n\r\nall of it\r\n")
	if err := submit(user, []string{"deliver-batch@kypost-demo.local"}, msg); err != nil {
		t.Fatalf("SMTP submit: %v", err)
	}
	waitForNewUID(t, user, "INBOX", len(before))

	fresh := dial(t, user)
	if err := fresh.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := fresh.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	// GetOverviews parses INTERNALDATE and returns an error if it cannot.
	if _, err := fresh.GetOverviews(uids...); err != nil {
		t.Fatalf("GetOverviews failed on injected mail: %v", err)
	}
}

// ------------------------------------------------------------------ helpers

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func flagsOf(t *testing.T, d *goimap.Dialer, uid int) []string {
	t.Helper()
	overviews, err := d.GetOverviews(uid)
	if err != nil {
		t.Fatalf("GetOverviews: %v", err)
	}
	e, ok := overviews[uid]
	if !ok {
		t.Fatalf("uid %d not returned by GetOverviews", uid)
	}
	return e.Flags
}

// Delivery is synchronous with the SMTP 250, but the acceptance client opens a
// fresh connection to observe it. Poll briefly rather than assume ordering.
func waitForNewUID(t *testing.T, user, folder string, atLeast int) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	last := 0
	for time.Now().Before(deadline) {
		d, err := goimap.New(user, "any-password", host, imapPort)
		if err == nil {
			if err := d.SelectFolder(folder); err == nil {
				if uids, err := d.GetUIDs("ALL"); err == nil {
					last = len(uids)
				}
			}
			_ = d.Close()
		}
		if last > atLeast {
			return last
		}
		time.Sleep(200 * time.Millisecond)
	}
	return last
}

func countMatching(t *testing.T, d *goimap.Dialer, subject string) int {
	t.Helper()
	uids, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatalf("UID SEARCH ALL: %v", err)
	}
	if len(uids) == 0 {
		return 0
	}
	overviews, err := d.GetOverviews(uids...)
	if err != nil {
		t.Fatalf("GetOverviews: %v", err)
	}
	n := 0
	for _, e := range overviews {
		if e.Subject == subject {
			n++
		}
	}
	return n
}

// submit mirrors kypost-server's SMTPSendWithTimeout: mandatory STARTTLS, then
// PLAIN auth, then MAIL/RCPT/DATA.
func submit(from string, to []string, msg []byte) error {
	addr := fmt.Sprintf("%s:%d", host, smtpPort)
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(20 * time.Second)); err != nil {
		return err
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		return err
	}
	defer c.Close()

	ok, _ := c.Extension("STARTTLS")
	if !ok {
		return fmt.Errorf("server did not advertise STARTTLS")
	}
	if err := c.StartTLS(&tls.Config{ServerName: host, RootCAs: certPool, MinVersion: tls.VersionTLS12}); err != nil {
		return err
	}
	if ok, _ := c.Extension("AUTH"); ok {
		if err := c.Auth(smtp.PlainAuth("", from, "any-password", host)); err != nil {
			return err
		}
	}
	if err := c.Mail(from); err != nil {
		return err
	}
	for _, r := range to {
		if err := c.Rcpt(r); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

func httpsClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: certPool, ServerName: "localhost", MinVersion: tls.VersionTLS12},
		},
	}
}

func doDAV(t *testing.T, c *http.Client, method, url, depth, body string, wantStatus int) string {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth("anyone", "anything")
	if depth != "" {
		req.Header.Set("Depth", depth)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/xml")
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		t.Fatalf("%s %s returned %d, want %d: %s", method, url, resp.StatusCode, wantStatus, out)
	}
	return string(out)
}

// A reviewer who does nothing must still see mail arrive. This test runs its
// own server so a two-second drip cannot add messages underneath every other
// test in the suite.
func TestDripDeliversToALoggedInPersona(t *testing.T) {
	const (
		dripIMAP  = 19934
		dripSMTP  = 15874
		dripHTTPS = 14434
	)
	dir := t.TempDir()
	pubDir := filepath.Join(dir, "pub")
	cmd := exec.Command("node", "../../src/index.js")
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("IMAP_PORT=%d", dripIMAP),
		fmt.Sprintf("SMTP_PORT=%d", dripSMTP),
		fmt.Sprintf("HTTPS_PORT=%d", dripHTTPS),
		"BIND_ADDRESS=127.0.0.1",
		// Reuses TestMain's key directory rather than SSL_CERT_DIR: see the
		// mainKeyDir comment above TestMain for why a fresh directory cannot
		// be trusted once the process's system cert pool is cached.
		"TLS_KEY_DIR="+mainKeyDir,
		"TLS_PUBLISH_DIR="+pubDir,
		"DRIP_SECONDS=2",
	)
	cmd.Stdout = io.Discard
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()
	if err := waitForPort(fmt.Sprintf("127.0.0.1:%d", dripIMAP), 15*time.Second); err != nil {
		t.Fatal(err)
	}

	user := "drip-user@kypost-demo.local"
	d, err := goimap.New(user, "any-password", "127.0.0.1", dripIMAP)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer d.Close()
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	before, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}

	// Poll this instance directly; waitForNewUID targets the shared server.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		fresh, err := goimap.New(user, "any-password", "127.0.0.1", dripIMAP)
		if err != nil {
			continue
		}
		if err := fresh.SelectFolder("INBOX"); err == nil {
			if uids, err := fresh.GetUIDs("ALL"); err == nil && len(uids) > len(before) {
				_ = fresh.Close()
				return
			}
		}
		_ = fresh.Close()
	}
	t.Errorf("drip delivered nothing within 20s: INBOX still holds %d messages", len(before))
}

// Thirty testers must not share one mailbox. This is the defect that made
// concurrent testing impossible: every unknown login resolved to PERSONAS[0].
func TestConcurrentUsersGetSeparateMailboxes(t *testing.T) {
	one := dial(t, "sep-one@kypost-demo.local")
	two := dial(t, "sep-two@kypost-demo.local")

	for _, d := range []*goimap.Dialer{one, two} {
		if err := d.SelectFolder("INBOX"); err != nil {
			t.Fatal(err)
		}
	}

	oneUIDs, err := one.GetUIDs("ALL")
	if err != nil || len(oneUIDs) == 0 {
		t.Fatalf("sep-one has no seeded mail: %v", err)
	}
	twoBefore, err := two.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}

	// Empty one mailbox. go-imap v0.1.28 moves one UID at a time — there is no
	// bulk MoveMessages; the method is MoveEmail(uid int, folder string).
	for _, uid := range oneUIDs {
		if err := one.MoveEmail(uid, "Trash"); err != nil {
			t.Fatalf("move uid %d to Trash: %v", uid, err)
		}
	}

	twoAfter, err := two.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(twoAfter) != len(twoBefore) {
		t.Errorf("emptying sep-one changed sep-two: %d -> %d", len(twoBefore), len(twoAfter))
	}
}

// A cloned mailbox showing mail addressed to Alice would confuse every tester
// and break recipient matching in KyPost Server.
func TestClonedMailIsAddressedToItsOwner(t *testing.T) {
	d := dial(t, "clone-check@kypost-demo.local")
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil || len(uids) == 0 {
		t.Fatalf("no seeded mail: %v", err)
	}
	overviews, err := d.GetOverviews(uids...)
	if err != nil {
		t.Fatal(err)
	}
	// goimap.EmailAddresses is map[address]displayName, so range over the keys.
	found := false
	for _, e := range overviews {
		for addr := range e.To {
			lower := strings.ToLower(addr)
			if strings.Contains(lower, "clone-check@") {
				found = true
			}
			if strings.Contains(lower, "alice@") {
				t.Errorf("cloned mail is still addressed to alice: %s", addr)
			}
		}
	}
	if !found {
		t.Error("no cloned message is addressed to clone-check")
	}
}

// reset rebuilds dynamic personas in place. Deleting them would leave an open
// session writing to an orphaned mailbox — the bug src/store.js:128 records.
func TestResetReseedsADynamicPersona(t *testing.T) {
	user := "reset-dynamic@kypost-demo.local"
	d := dial(t, user)
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatal(err)
	}
	uids, err := d.GetUIDs("ALL")
	if err != nil || len(uids) == 0 {
		t.Fatalf("no seeded mail: %v", err)
	}
	for _, uid := range uids {
		if err := d.MoveEmail(uid, "Trash"); err != nil {
			t.Fatalf("empty INBOX: %v", err)
		}
	}

	client := httpsClient()
	req, err := http.NewRequest("POST",
		fmt.Sprintf("https://%s:%d/admin/reset", host, httpsPort), nil)
	if err != nil {
		t.Fatal(err)
	}
	// src/carddav.js reads Authorization: Bearer, not a custom header.
	req.Header.Set("Authorization", "Bearer "+resetToken)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reset returned %d", resp.StatusCode)
	}

	// The SAME session must see the reseeded mailbox, not an orphan.
	if err := d.SelectFolder("INBOX"); err != nil {
		t.Fatalf("re-SELECT after reset: %v", err)
	}
	after, err := d.GetUIDs("ALL")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) == 0 {
		t.Error("dynamic persona was not reseeded, or its session was orphaned")
	}
}
