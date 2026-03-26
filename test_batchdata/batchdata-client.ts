/**
 * batchdata-client.ts
 * BatchData Property Search client using the confirmed payload shape:
 * POST https://api.batchdata.com/api/v1/property/property-search
 * Body: { "searchCriteria": { "query": "<full address string>" } }
 */

export interface BatchDataResult {
  address: string;
  status: string | null;
  listingStatus: string | null;
  isSold: boolean;
  lastSaleDate: string | null;
  lastSalePrice: number | null;
  rawStatus: string | null;
}

export class BatchDataClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.batchdata.com/api/v1";

  constructor(useSandbox = false) {
    const key = useSandbox
      ? Deno.env.get("BATCH_DATA_SANDBOX_KEY")
      : Deno.env.get("BATCH_DATA_API_KEY");

    if (!key) {
      throw new Error(
        useSandbox
          ? "BATCH_DATA_SANDBOX_KEY not set in environment."
          : "BATCH_DATA_API_KEY not set in environment."
      );
    }
    this.apiKey = key;
    console.log(`[BatchDataClient] Initialized. Sandbox=${useSandbox}`);
  }

  /**
   * Look up a single property by full address string.
   * Uses the confirmed searchCriteria.query payload.
   */
  async lookupProperty(address: string): Promise<BatchDataResult> {
    const body = {
      searchCriteria: {
        query: address,
      },
    };

    const res = await fetch(`${this.baseUrl}/property/property-search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      throw new Error("RATE_LIMITED_429");
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "no body");
      throw new Error(`BatchData API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = await res.json();

    // Navigate the nested response — field names may vary
    const property =
      json?.results?.[0] ||
      json?.data?.[0] ||
      json?.property ||
      json?.[0] ||
      null;

    if (!property) {
      return {
        address,
        status: null,
        listingStatus: null,
        isSold: false,
        lastSaleDate: null,
        lastSalePrice: null,
        rawStatus: null,
      };
    }

    const rawStatus =
      property?.listingInfo?.status ||
      property?.mlsInfo?.listing_status ||
      property?.propertyInfo?.status ||
      property?.status ||
      null;

    const normalizedStatus = (rawStatus || "").toUpperCase();
    const isSold = ["SOLD", "CLOSED", "SETTLED"].includes(normalizedStatus);

    return {
      address,
      status: normalizedStatus || null,
      listingStatus: rawStatus,
      isSold,
      lastSaleDate:
        property?.lastSale?.saleDate ||
        property?.saleDate ||
        property?.lastSaleDate ||
        null,
      lastSalePrice:
        property?.lastSale?.salePrice ||
        property?.salePrice ||
        property?.lastSalePrice ||
        null,
      rawStatus,
    };
  }
}
