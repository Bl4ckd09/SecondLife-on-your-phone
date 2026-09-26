import { env } from "./lib.ts";

export async function tavilySearch(input: unknown): Promise<unknown> {
  if (!env.TAVILY_API_KEY) return { error: "auth" };

  try {
    const call = input !== null && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const query = String(call.query ?? "").trim();
    if (!query) return { error: "search", detail: "query is required" };
    const maxResults = Math.min(10, Math.max(1, Number(call.max_results ?? 5) || 5));
    const includeDomains = Array.isArray(call.include_domains)
      ? call.include_domains.filter((domain): domain is string => typeof domain === "string")
      : undefined;
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
        include_domains: includeDomains,
        search_depth: "basic",
      }),
    });
    if (!response.ok) {
      return { error: "search", detail: (await response.text()).slice(0, 600) || `${response.status} ${response.statusText}` };
    }
    const body = await response.json() as { results?: unknown[] };
    return (body.results ?? []).map((result) => {
      const item = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
      return {
        title: String(item.title ?? ""),
        url: String(item.url ?? ""),
        content: String(item.content ?? "").trim().slice(0, 600),
      };
    });
  } catch (error) {
    return { error: "search", detail: error instanceof Error ? error.message : String(error) };
  }
}
