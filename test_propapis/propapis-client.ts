/**
 * propapis-client.ts
 * Core client for PropAPIS interaction using Deno.fetch
 */

export class PropAPISClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.propapis.com/v1";

  constructor() {
    const key = Deno.env.get("PROPAPIS_API_KEY");
    if (!key) throw new Error("PROPAPIS_API_KEY environment variable is not set.");
    this.apiKey = key;
  }

  /**
   * Submits a batch of addresses for property search
   * @param addresses Array of address strings
   */
  async getBatchPropertyDetail(addresses: string[]) {
    const response = await fetch(`${this.baseUrl}/property/batch`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        addresses: addresses,
        include_mls: true,
        include_tax: true
      }),
    });

    if (!response.ok) {
      throw new Error(`PropAPIS Request Failed: ${response.statusText}`);
    }

    return await response.json();
  }
}
