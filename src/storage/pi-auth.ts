import fs from "node:fs";
import path from "node:path";
import {
  getOAuthApiKey,
  type OAuthCredentials,
  type OAuthProviderId,
} from "@mariozechner/pi-ai";
import { logger } from "../logger.js";

type AuthEntry =
  | ({ type: "oauth" } & OAuthCredentials)
  | { type: "api_key"; key: string }
  | Record<string, unknown>;

type AuthFile = Record<string, AuthEntry>;

function readAuthFile(authPath: string): AuthFile {
  if (!fs.existsSync(authPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFile;
  } catch {
    return {};
  }
}

function writeAuthFile(authPath: string, auth: AuthFile): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf8");
  fs.chmodSync(authPath, 0o600);
}

export async function getApiKeyFromPiAuthFile(options: {
  provider: string;
  authPath: string;
}): Promise<string | undefined> {
  if (
    process.env.MERCURY_ANTHROPIC_API_KEY ||
    process.env.MERCURY_ANTHROPIC_OAUTH_TOKEN
  ) {
    return undefined;
  }

  if (options.provider !== "anthropic") {
    return undefined;
  }

  const authPath = options.authPath;
  const auth = readAuthFile(authPath);

  const entry = auth.anthropic;
  if (!entry || typeof entry !== "object" || entry.type !== "oauth") {
    return undefined;
  }

  const access = typeof entry.access === "string" ? entry.access : undefined;
  const refresh = typeof entry.refresh === "string" ? entry.refresh : undefined;
  const expires = typeof entry.expires === "number" ? entry.expires : undefined;
  if (!access || !refresh || typeof expires !== "number") return undefined;

  try {
    const result = await getOAuthApiKey("anthropic" satisfies OAuthProviderId, {
      anthropic: {
        access,
        refresh,
        expires,
      },
    });

    if (!result) return undefined;

    const nextAuth = {
      ...auth,
      anthropic: {
        type: "oauth" as const,
        ...result.newCredentials,
      },
    };

    writeAuthFile(authPath, nextAuth);
    logger.debug("Loaded anthropic oauth token from pi auth.json", {
      authPath,
    });
    return result.apiKey;
  } catch (error) {
    logger.warn(
      "Failed to load anthropic oauth token from pi auth.json",
      error instanceof Error ? error : undefined,
    );
    return undefined;
  }
}
