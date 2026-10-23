import fs from "node:fs";
import { generateIdentity, restoreIdentity, type IdentityData } from "./tslib/identity.js";

/**
 * The identity must survive restarts: its UID is what server groups and
 * permissions get granted to. Generate once, then reuse.
 */
export function loadOrCreateIdentity(file: string, securityLevel = 8): IdentityData {
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return restoreIdentity(raw);
  }
  const id = generateIdentity(securityLevel);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        privateKeyBigInt: id.privateKeyBigInt.toString(),
        keyOffset: id.keyOffset.toString(),
        publicKeyString: id.publicKeyString,
        uid: id.uid,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  return id;
}
