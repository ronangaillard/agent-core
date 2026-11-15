import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Where the browser is sent back: nothing listens there, the sign-in reads the code from the address it fails on. */
export const REDIRECT_URL = "http://localhost:8976/callback";

type Saved = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; pending?: string };

/**
 * An MCP server's OAuth sign-in, kept in a file (<dir>/<name>.json, mode 600): the client registered with the server,
 * the tokens (refreshed by the MCP client when they expire), and during a sign-in the PKCE verifier and the
 * authorization URL to open. The agent never opens it: a sign-in is done once by hand (mcp-login.ts).
 */
export class FileAuth implements OAuthClientProvider {
  constructor(
    private readonly dir: string,
    private readonly name: string,
  ) {}

  private get path() {
    return join(this.dir, `${this.name}.json`);
  }

  load(): Saved {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Saved) : {};
  }

  private save(change: Partial<Saved>) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...this.load(), ...change }, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  get redirectUrl() {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "agent-core", redirect_uris: [REDIRECT_URL], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  clientInformation() {
    return this.load().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.save({ client });
  }

  tokens() {
    return this.load().tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.save({ tokens, pending: undefined, verifier: undefined });
  }

  redirectToAuthorization(url: URL) {
    this.save({ pending: url.toString() });
  }

  saveCodeVerifier(verifier: string) {
    this.save({ verifier });
  }

  codeVerifier() {
    const verifier = this.load().verifier;
    if (!verifier) throw new Error(`mcp ${this.name}: no sign-in in progress`);
    return verifier;
  }
}
