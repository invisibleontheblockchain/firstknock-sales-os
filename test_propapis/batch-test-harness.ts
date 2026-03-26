/**
 * batch-test-harness.ts
 * CLI tool for the 499-Route ground truth test
 */
import { PropAPISClient } from "./propapis-client.ts";
import { parsePropAPIResponse, PropertyStatus } from "./response-parser.ts";

// Will fail initializing if PROPAPIS_API_KEY is missing.
let client: PropAPISClient;
try {
  client = new PropAPISClient();
} catch (err) {
  console.log("No PROPAPIS_API_KEY present in Deno.env. The harness is loaded but idle.");
}

async function runTest(filePath: string) {
  if (!client) return;

  const fileContent = await Deno.readTextFile(filePath);
  
  // Extract addresses from our ground truth file line by line
  let addresses: string[] = [];
  try {
     const json = JSON.parse(fileContent);
     if (Array.isArray(json)) addresses = json;
  } catch (e) {
     // If it's a raw text file like '1 - 505 Blair St', split and clean
     addresses = fileContent.split('\\n')
       .map(line => line.trim())
       .filter(Boolean)
       .map(line => {
           // Remove prefix "1 - "
           const match = line.match(/^\\d+\\s*-\\s*(.+)$/);
           return match ? match[1] : line;
       });
  }

  console.log(`Starting 499-Route test with ${addresses.length} addresses...`);
  
  const rawData = await client.getBatchPropertyDetail(addresses);
  const normalized = parsePropAPIResponse(rawData);

  // The Known "Soup" Assertions from the prompt
  const soupAssertions = [
    { addr: "505", expected: PropertyStatus.SOLD },
    { addr: "507", expected: PropertyStatus.SOLD },
    { addr: "117 Phillips", expected: PropertyStatus.SOLD },
    { addr: "115 Simmons", expected: PropertyStatus.OFF_MARKET }
  ];

  const results = normalized.map(res => {
    const assertion = soupAssertions.find(a => res.address.includes(a.addr));
    let verdict = "PASS";
    
    if (assertion && res.status !== assertion.expected) {
      verdict = `FAIL (Expected ${assertion.expected}, got ${res.status})`;
    }

    return { ...res, verdict };
  });

  await Deno.writeTextFile("./results.json", JSON.stringify(results, null, 2));
  console.log("Test complete. Results written to results.json");
}

if (import.meta.main) {
  const path = Deno.args[0] || "../.gemini/antigravity/brain/0bbe67c5-d4cf-482a-9ffe-a5948bcfea94/propapis_ground_truth_route.txt";
  await runTest(path).catch(console.error);
}
