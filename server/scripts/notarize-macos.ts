#!/usr/bin/env bun
// Submits the signed macOS binaries to Apple's notary service. Run after
// build-binaries.ts has signed them with a real Developer ID (i.e. with
// APPLE_SIGNING_IDENTITY set) — notarizing an ad-hoc signed binary is
// rejected, so this refuses to try.
//
// The notary service only accepts .zip/.pkg/.dmg, so each binary is zipped
// (with ditto, which is what Apple's own docs use) purely as a transport for
// the submission. The tickets are issued against the binaries themselves, so
// the .tar.gz archives built earlier stay valid and don't need rebuilding —
// notarization doesn't modify what it inspects.
//
// What this deliberately does NOT do is staple. `xcrun stapler` can only
// attach a ticket to a bundle, disk image or installer package, never to a
// bare Mach-O executable like ours. Gatekeeper therefore looks the ticket up
// online the first time a quarantined copy runs, which covers browser
// downloads (the case that needs it) but not an offline machine. Stapling
// would mean shipping macOS as a .dmg or .pkg instead of a tarball.
//
// Credentials come from an App Store Connect API key, via the environment:
//   APPLE_API_KEY_PATH   path to the .p8 private key file
//   APPLE_API_KEY_ID     the key's ID
//   APPLE_API_ISSUER_ID  the issuer UUID
//
// Usage: bun run server/scripts/notarize-macos.ts
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "../..");
const BINARIES = ["local-slack-darwin-arm64", "local-slack-darwin-x64"].map((suffix) =>
  join(root, "npm", suffix, "bin", "local-slack"),
);

const keyPath = process.env.APPLE_API_KEY_PATH;
const keyId = process.env.APPLE_API_KEY_ID;
const issuerId = process.env.APPLE_API_ISSUER_ID;
if (!keyPath || !keyId || !issuerId) {
  console.error(
    "Missing notarization credentials. Set APPLE_API_KEY_PATH, APPLE_API_KEY_ID and\n" +
      "APPLE_API_ISSUER_ID (an App Store Connect API key with the Developer role).",
  );
  process.exit(1);
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} ${cmd[1]} failed`);
}

async function output(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stdout + stderr; // codesign reports on stderr
}

/** Refuses anything the notary service would reject anyway: unsigned, ad-hoc
 *  signed, or signed without the hardened runtime. */
async function assertReadyToNotarize(binary: string): Promise<void> {
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`${binary} not found — run \`bun run build:binaries\` first.`);
  }
  const details = await output(["codesign", "--display", "--verbose=2", binary]);
  if (/Signature=adhoc/.test(details) || !/TeamIdentifier=[A-Z0-9]/.test(details)) {
    throw new Error(
      `${binary} is not Developer ID signed (ad-hoc or unsigned).\n` +
        "Set APPLE_SIGNING_IDENTITY and rebuild before notarizing.",
    );
  }
  if (!/flags=.*runtime/.test(details)) {
    throw new Error(`${binary} was signed without the hardened runtime, which notarization requires.`);
  }
}

const stageDir = await mkdtemp(join(tmpdir(), "local-slack-notarize-"));
try {
  for (const binary of BINARIES) {
    const label = binary.split("/").at(-3);
    console.log(`\n→ notarizing ${label}`);
    await assertReadyToNotarize(binary);

    const zipPath = join(stageDir, `${label}.zip`);
    await run(["ditto", "-c", "-k", "--keepParent", binary, zipPath]);

    // The status is checked rather than trusted to the exit code: `notarytool
    // submit --wait` can exit 0 having finished as "Invalid", which would
    // otherwise publish an unnotarized binary as if all was well.
    const credentials = ["--key", keyPath, "--key-id", keyId, "--issuer", issuerId];
    const raw = await output([
      "xcrun",
      "notarytool",
      "submit",
      zipPath,
      ...credentials,
      "--wait",
      "--output-format",
      "json",
    ]);
    let submission: { id?: string; status?: string; message?: string };
    try {
      submission = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    } catch {
      throw new Error(`Could not read notarytool's response for ${label}:\n${raw}`);
    }
    if (submission.status !== "Accepted") {
      // The log says which check failed — an unhelpful thing to have to go
      // dig out of App Store Connect afterwards.
      if (submission.id) await run(["xcrun", "notarytool", "log", submission.id, ...credentials]);
      throw new Error(`Notarization of ${label} finished as "${submission.status}" (id ${submission.id}).`);
    }
    console.log(`  accepted: ${label} (submission ${submission.id})`);
  }
} finally {
  await rm(stageDir, { recursive: true, force: true });
}

console.log(
  "\nNotarized. The tickets are served online rather than stapled (a bare executable\n" +
    "can't be stapled), so a quarantined copy is verified on first run while online.",
);
