import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod/v4";
import { AGENT_DIR, env } from "./lib.ts";

const sandbox = (env.EBAY_ENV || "sandbox") !== "production";
const API = sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const AUTH = sandbox ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
const TOKEN_FILE = join(AGENT_DIR, ".ebay-token.json");
const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true, parseTagValue: false });
const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.coerce.number(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.coerce.number().optional(),
}).loose();
const SavedToken = z.object({ refresh_token: z.string(), refresh_expires_at: z.union([z.string(), z.number()]) });

type CachedToken = { value: string; expires: number };
let cachedApp: CachedToken | null = null;
let cachedUser: CachedToken | null = null;

function credential(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`auth: ${name} missing in agent/.env`);
  return value;
}

function basicAuth(): string {
  return Buffer.from(`${credential("EBAY_APP_ID")}:${credential("EBAY_CERT_ID")}`).toString("base64");
}

async function tokenRequest(body: URLSearchParams) {
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basicAuth()}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth: HTTP ${res.status} ${(text || res.statusText).slice(0, 400)}`);
  try { return TokenResponse.parse(JSON.parse(text)); } catch { throw new Error("auth: eBay returned an invalid token response"); }
}

export async function appToken(): Promise<string> {
  if (cachedApp && cachedApp.expires > Date.now()) return cachedApp.value;
  const token = await tokenRequest(new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES[0] }));
  cachedApp = { value: token.access_token, expires: Date.now() + Math.max(0, token.expires_in - 60) * 1000 };
  return cachedApp.value;
}

function expiry(value: string | number): number {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  return Date.parse(value);
}

export async function userToken(): Promise<string> {
  if (cachedUser && cachedUser.expires > Date.now()) return cachedUser.value;
  if (!existsSync(TOKEN_FILE)) throw new Error("auth: agent/.ebay-token.json is missing; run worker.ts login");
  let saved: z.infer<typeof SavedToken>;
  try { saved = SavedToken.parse(JSON.parse(readFileSync(TOKEN_FILE, "utf8"))); } catch { throw new Error("auth: agent/.ebay-token.json is invalid"); }
  if (expiry(saved.refresh_expires_at) <= Date.now()) throw new Error("auth: eBay refresh token expired; run worker.ts login");
  const token = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: saved.refresh_token,
    scope: SCOPES.join(" "),
  }));
  cachedUser = { value: token.access_token, expires: Date.now() + Math.max(0, token.expires_in - 60) * 1000 };
  return cachedUser.value;
}

export function consentUrl(): string {
  const url = new URL("/oauth2/authorize", AUTH);
  url.search = new URLSearchParams({
    client_id: credential("EBAY_APP_ID"),
    redirect_uri: credential("EBAY_RUNAME"),
    response_type: "code",
    scope: SCOPES.join(" "),
  }).toString();
  return url.toString();
}

export async function exchangeCode(code: string): Promise<void> {
  const token = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: credential("EBAY_RUNAME"),
  }));
  if (!token.refresh_token || !token.refresh_token_expires_in) throw new Error("auth: eBay did not return a refresh token");
  const saved = {
    refresh_token: token.refresh_token,
    refresh_expires_at: new Date(Date.now() + token.refresh_token_expires_in * 1000).toISOString(),
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  cachedUser = { value: token.access_token, expires: Date.now() + Math.max(0, token.expires_in - 60) * 1000 };
}

export async function rest(
  method: string,
  path: string,
  options: { token?: "app" | "user"; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<unknown> {
  const url = new URL(path, API);
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const token = options.token === "app" ? await appToken() : await userToken();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-language": "en-GB",
      "accept-language": "en-GB",
      "x-ebay-c-marketplace-id": "EBAY_GB",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!res.ok) throw new Error(`ebay: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { throw new Error("ebay: invalid JSON response"); }
}

export function xmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function tradingResult(callName: string, xml: string): Record<string, unknown> {
  const parsed: unknown = parser.parse(xml);
  const root = record(parsed);
  const result = record(root[`${callName}Response`] ?? root);
  if (result.Ack === "Failure") {
    const errors = Array.isArray(result.Errors) ? result.Errors : [result.Errors];
    const detail = errors.map(record).map((error) => error.LongMessage ?? error.ShortMessage).filter(Boolean).join("; ");
    throw new Error(`ebay: ${detail || "Trading API failure"}`);
  }
  return result;
}

function tradingHeaders(callName: string, token: string): Record<string, string> {
  return {
    "x-ebay-api-call-name": callName,
    "x-ebay-api-siteid": "3",
    "x-ebay-api-compatibility-level": "1349",
    "x-ebay-api-iaf-token": token,
    "content-language": "en-GB",
  };
}

export async function trading(callName: string, innerXml: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(callName)) throw new Error("ebay: invalid Trading API call name");
  const token = await userToken();
  const xml = `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">${innerXml}</${callName}Request>`;
  const res = await fetch(`${API}/ws/api.dll`, {
    method: "POST",
    headers: { ...tradingHeaders(callName, token), "content-type": "text/xml" },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ebay: HTTP ${res.status} ${text.slice(0, 400)}`);
  return tradingResult(callName, text);
}

export async function uploadPicture(path: string): Promise<string> {
  const callName = "UploadSiteHostedPictures";
  const token = await userToken();
  const xml = `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents"><PictureName>${xmlEscape(basename(path))}</PictureName><PictureSet>Supersize</PictureSet></${callName}Request>`;
  const form = new FormData();
  form.append("XML Payload", new Blob([xml], { type: "text/xml" }), "request.xml");
  const type = extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  form.append("image", new Blob([readFileSync(path)], { type }), basename(path));
  const res = await fetch(`${API}/ws/api.dll`, { method: "POST", headers: tradingHeaders(callName, token), body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`ebay: HTTP ${res.status} ${text.slice(0, 400)}`);
  const result = tradingResult(callName, text);
  const url = record(result.SiteHostedPictureDetails).FullURL;
  if (typeof url !== "string") throw new Error("ebay: UploadSiteHostedPictures returned no URL");
  return url;
}

export const ebayEnvironment = sandbox ? "sandbox" : "production";
