import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const managedConfigHeader = [
  "# Managed by Slab Runner.",
  "# MCP servers are supplied per run by the Slab control plane.",
];

export interface IsolatedCodexHomeOptions {
  codexHome: string;
  authSourceFile: string;
}

export function prepareIsolatedCodexHome({
  codexHome,
  authSourceFile,
}: IsolatedCodexHomeOptions): void {
  const targetHome = resolve(codexHome);
  const sourceAuth = resolve(authSourceFile);
  const sourceHome = dirname(sourceAuth);
  if (targetHome === sourceHome) {
    throw new Error(
      "RUNNER_CODEX_HOME must not reuse the user's primary Codex home.",
    );
  }

  const targetConfig = resolve(targetHome, "config.toml");
  if (existsSync(targetHome)) {
    const entries = readdirSync(targetHome);
    const managedConfig = existsSync(targetConfig)
      ? readFileSync(targetConfig, "utf8").startsWith(managedConfigHeader[0]!)
      : false;
    if (entries.length > 0 && !managedConfig) {
      throw new Error(
        "RUNNER_CODEX_HOME must be empty or already managed by Slab Runner.",
      );
    }
  }

  mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  chmodSync(targetHome, 0o700);

  const targetAuth = resolve(targetHome, "auth.json");
  if (!existsSync(targetAuth) && existsSync(sourceAuth)) {
    copyFileSync(sourceAuth, targetAuth);
  }
  if (existsSync(targetAuth)) chmodSync(targetAuth, 0o600);

  const config = [
    ...managedConfigHeader,
    ...(existsSync(targetAuth)
      ? ['', 'cli_auth_credentials_store = "file"']
      : []),
    "",
  ].join("\n");
  writeFileSync(targetConfig, config, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(targetConfig, 0o600);
}
