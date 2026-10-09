import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const password = randomBytes(24).toString("base64url");
const example = await readFile(new URL(".env.example", root), "utf8");
const content = example.replaceAll("<local-password>", password)
  .replace("<base64-encoded-32-byte-key>", randomBytes(32).toString("base64"));
try {
  await writeFile(new URL(".env", root), content, { flag: "wx", mode: 0o600 });
  console.error("Created a private local mock configuration. No secrets were printed. Next: docker compose up -d db; npm run db:migrate.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    console.error(".env already exists and was left unchanged.");
  } else {
    console.error("Local configuration could not be created. Check directory permissions.");
    process.exitCode = 1;
  }
}
