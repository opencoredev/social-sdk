import { spawn } from "node:child_process";

if (process.env["SOCIAL_SDK_RELEASE_AUTHORIZED"] !== "true") {
  console.error(
    "Release blocked: set SOCIAL_SDK_RELEASE_AUTHORIZED=true only for an owner-authorized publication.",
  );
  process.exit(1);
}

const child = spawn("changeset", ["publish"], {
  stdio: "inherit",
  env: process.env,
});

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Release terminated by ${signal}.`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
