/**
 * response-parser.ts
 * Normalizes disparate status strings from multiple MLS sources
 */

export enum PropertyStatus {
  SOLD = "SOLD",
  ACTIVE = "ACTIVE",
  PENDING = "PENDING",
  OFF_MARKET = "OFF_MARKET",
  UNKNOWN = "UNKNOWN"
}

export interface NormalizedResult {
  address: string;
  status: PropertyStatus;
  isSold: boolean;
  salePrice?: number;
  saleDate?: string;
  source: string;
}

export function parsePropAPIResponse(raw: any): NormalizedResult[] {
  if (!raw.data || !Array.isArray(raw.data)) return [];

  return raw.data.map((item: any) => {
    const statusStr = (item.mlsInfo?.listing_status || item.propertyInfo?.status || "").toUpperCase();
    
    let status = PropertyStatus.UNKNOWN;
    if (["SOLD", "CLOSED", "SETTLED"].includes(statusStr)) status = PropertyStatus.SOLD;
    else if (["ACTIVE", "FOR SALE", "NEW"].includes(statusStr)) status = PropertyStatus.ACTIVE;
    else if (["PENDING", "CONTINGENT", "UNDER CONTRACT"].includes(statusStr)) status = PropertyStatus.PENDING;
    else if (["OFF MARKET", "WITHDRAWN", "EXPIRED", "CANCELED"].includes(statusStr)) status = PropertyStatus.OFF_MARKET;

    return {
      address: item.address,
      status: status,
      isSold: status === PropertyStatus.SOLD,
      salePrice: item.lastSale?.salePrice,
      saleDate: item.lastSale?.saleDate,
      source: item.source_name || "Unknown"
    };
  });
}
